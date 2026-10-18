/**
 * An HTTP client that can go out through the user's proxy.
 *
 * The Host half cannot use Node's `fetch` when a proxy is in play: undici ignores
 * the Windows system proxy, `NODE_USE_ENV_PROXY` is read at startup, and undici
 * itself is not importable from a plugin. So this module speaks the wire protocol
 * directly for that one case:
 *
 *   - HTTPS through a proxy: `CONNECT host:443`, then TLS on the same socket;
 *   - HTTP through a proxy: the absolute-form request every proxy understands;
 *   - no proxy: the request is handed straight to the platform `fetch`, so the
 *     verified default path is untouched.
 *
 * It returns a real `Response`, which is the whole trick: `probeFromHtml`, the
 * direct download carrier and their tests keep seeing `.ok`, `.status`,
 * `.headers.get()`, `.text()` and `.body` exactly as before.
 *
 * Deliberate simplifications, each one a decision rather than an oversight:
 *   - no `Accept-Encoding`, so no compressed body ever has to be decoded;
 *   - `Connection: close` plus full framing support (`content-length`, `chunked`,
 *     close-delimited), which keeps a long download honest;
 *   - GET and HEAD only — the plugin never posts anything to a site;
 *   - no HTTP/2, no cookies jar (a caller may pass a `cookie` header itself).
 */
import net from 'node:net'
import tls from 'node:tls'
import { shouldBypass, type ProxySetting } from './proxy.js'

/** Redirects followed before giving up. */
const MAX_REDIRECTS = 5

/** Milliseconds allowed for the TCP (and CONNECT) handshake. */
const CONNECT_TIMEOUT_MS = 15_000

/** Milliseconds allowed to wait for the response head. */
const HEAD_TIMEOUT_MS = 30_000

/** Milliseconds of silence tolerated mid-body; a stalled download must not hang. */
const IDLE_TIMEOUT_MS = 60_000

/** The user agent sent on the proxied path; undici's own is refused by many sites. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** A parsed response head. */
export interface ResponseHead {
  /** HTTP status code. */
  readonly status: number
  /** Reason phrase, possibly empty. */
  readonly statusText: string
  /** Response headers, case-insensitive by construction. */
  readonly headers: Headers
}

/**
 * Parse a response head (everything up to the blank line).
 *
 * Folded (`obs-fold`) continuation lines are joined onto the previous value: a
 * proxy is allowed to fold, and a dropped `location` header would turn a redirect
 * into an empty page.
 * @param head - the raw head, without the terminating blank line.
 * @returns the parsed status and headers.
 */
export function parseResponseHead(head: string): ResponseHead {
  const lines = head.split(/\r?\n/)
  const statusLine = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(lines[0] ?? '')
  if (statusLine === null) throw new Error(`不是 HTTP 响应：${(lines[0] ?? '').slice(0, 60)}`)
  const headers = new Headers()
  for (const line of lines.slice(1)) {
    if (/^[ \t]/.test(line)) {
      // Continuation of the previous header; append to it.
      const last = [...headers.entries()].at(-1)
      if (last !== undefined) {
        headers.delete(last[0])
        headers.set(last[0], `${last[1]} ${line.trim()}`)
      }
      continue
    }
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (name === '' || value === '') continue
    // `set-cookie` legitimately repeats; the rest are treated as last-wins, which
    // is what every client does with a duplicated header.
    if (name.toLowerCase() === 'set-cookie') headers.append(name, value)
    else headers.set(name, value)
  }
  return { status: Number(statusLine[1]), statusText: (statusLine[2] ?? '').trim(), headers }
}

/** How a response body is delimited on the wire. */
export type BodyFraming = 'chunked' | 'eof' | { readonly length: number }

/**
 * Decide how to read a body from its headers.
 * @param headers - the parsed response headers.
 * @param status - the status code (204/304 carry no body).
 * @returns the framing to use.
 */
export function bodyFraming(headers: Headers, status: number): BodyFraming {
  if (status === 204 || status === 304 || status === 205) return { length: 0 }
  const encoding = (headers.get('transfer-encoding') ?? '').toLowerCase()
  if (encoding.includes('chunked')) return 'chunked'
  const length = headers.get('content-length')
  if (length !== null && /^\d+$/.test(length.trim())) return { length: Number(length.trim()) }
  return 'eof'
}

/** A body decoder: bytes in, complete frames out. */
export interface BodyDecoder {
  /**
   * Feed raw bytes.
   * @param chunk - raw socket bytes.
   * @returns the decoded bytes ready to hand to the consumer.
   */
  push(chunk: Buffer): Buffer[]
  /** Whether the body is complete and no more bytes should be awaited. */
  readonly complete: boolean
}

/**
 * Build the decoder for one framing.
 *
 * Chunked decoding is done by hand because the alternative — buffering the whole
 * body to strip the framing — would defeat streaming a multi-gigabyte download.
 * @param framing - the framing decided from the response headers.
 * @returns the decoder.
 */
export function createBodyDecoder(framing: BodyFraming): BodyDecoder {
  if (framing !== 'chunked' && framing !== 'eof' && framing.length === 0) {
    return { complete: true, push: () => [] }
  }
  if (framing === 'eof') {
    return { complete: false, push: chunk => (chunk.length === 0 ? [] : [chunk]) }
  }
  if (framing !== 'chunked') {
    let remaining = framing.length
    let complete = remaining === 0
    return {
      get complete() { return complete },
      push(chunk) {
        if (complete) return []
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
        remaining -= slice.length
        if (remaining === 0) complete = true
        return slice.length === 0 ? [] : [slice]
      },
    }
  }

  let buffer: Buffer = Buffer.alloc(0)
  let remaining = -1
  let complete = false
  return {
    get complete() { return complete },
    push(chunk) {
      const out: Buffer[] = []
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (complete) break
        if (remaining >= 0) {
          if (buffer.length === 0) break
          const take = Math.min(remaining, buffer.length)
          out.push(buffer.subarray(0, take))
          buffer = buffer.subarray(take)
          remaining -= take
          if (remaining === 0) {
            // Consume the CRLF that closes the chunk.
            if (buffer.length < 2) break
            buffer = buffer.subarray(2)
            remaining = -1
          } else break
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd === -1) break
        const sizeLine = (buffer.subarray(0, lineEnd).toString('latin1').split(';')[0] ?? '').trim()
        if (!/^[0-9a-fA-F]+$/.test(sizeLine)) throw new Error(`无法解析分块长度：${sizeLine.slice(0, 20)}`)
        const size = Number.parseInt(sizeLine, 16)
        buffer = buffer.subarray(lineEnd + 2)
        if (size === 0) {
          complete = true
          buffer = Buffer.alloc(0)
          break
        }
        remaining = size
      }
      return out
    },
  }
}

/** What one hop needs. */
interface HopRequest {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly signal: AbortSignal | undefined
  readonly proxyUrl: string
}

/**
 * Read from a socket until the response head is complete.
 * @param source - the socket to read.
 * @param timeoutMs - how long the head may take.
 * @returns the raw head text and the bytes already read past it.
 */
function readHead(source: net.Socket, timeoutMs: number): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`等待响应头超时（${timeoutMs / 1000}s）`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      cleanup()
      resolve({ head: buffer.subarray(0, end).toString('latin1'), rest: buffer.subarray(end + 4) })
    }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onClose = (): void => { cleanup(); reject(new Error('连接在响应头之前被关闭')) }
    function cleanup(): void {
      clearTimeout(timer)
      source.off('data', onData)
      source.off('error', onError)
      source.off('close', onClose)
    }
    source.on('data', onData)
    source.on('error', onError)
    source.on('close', onClose)
  })
}

/**
 * The part of a TLS socket this module waits on.
 *
 * Structural on purpose: the tests drive this with a plain fake, because the
 * behaviour worth pinning is about TIMERS, not about TLS.
 */
export interface TlsHandshakeSocket {
  /** Register a one-shot listener. */
  once(event: 'secureConnect' | 'error', listener: (error?: Error) => void): unknown
  /** Tear the socket down. */
  destroy(): unknown
}

/**
 * Wait for a TLS handshake, failing after `timeoutMs`.
 *
 * The timer is CLEARED on both settle paths, and that is not a detail — it is the
 * whole reason this is a function. Measured on a real 243 MB download through the
 * user's proxy: the transfer ran at full speed for exactly 15.0 s and then the
 * socket was destroyed at 96% of the file, which the body reader could only report
 * as "the connection was closed before the end of the response body". A timer left
 * armed after a SUCCESSFUL handshake destroys a healthy download, so it must not
 * outlive the promise.
 * @param secured - the TLS socket being negotiated.
 * @param timeoutMs - how long the handshake may take.
 * @returns nothing, once the handshake is up.
 * @throws the socket's own error, or a timeout sentence.
 */
export async function awaitTlsHandshake(secured: TlsHandshakeSocket, timeoutMs: number): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      secured.destroy()
      reject(new Error('TLS 握手超时'))
    }, timeoutMs)
    secured.once('secureConnect', () => { clearTimeout(timer); resolve() })
    secured.once('error', (error?: Error) => {
      clearTimeout(timer)
      reject(error ?? new Error('TLS 握手失败'))
    })
  })
}

/**
 * Open a socket to the target: through a CONNECT tunnel for HTTPS, straight to the
 * proxy for HTTP (which every proxy accepts as an absolute-form request).
 * @param request - the hop's coordinates.
 * @returns the socket to speak HTTP on.
 */
async function openTransport(request: HopRequest): Promise<net.Socket | tls.TLSSocket> {
  const proxy = new URL(request.proxyUrl)
  const proxyPort = proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port)
  const proxyAuth = proxy.username === ''
    ? undefined
    : `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`

  const socket = net.connect(proxyPort, proxy.hostname)
  socket.setNoDelay(true)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`连接代理超时（${CONNECT_TIMEOUT_MS / 1000}s）：${proxy.host}`)) }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })

  if (request.url.protocol !== 'https:') return socket

  const targetPort = request.url.port === '' ? 443 : Number(request.url.port)
  socket.write([
    `CONNECT ${request.url.hostname}:${targetPort} HTTP/1.1`,
    `Host: ${request.url.hostname}:${targetPort}`,
    ...(proxyAuth === undefined ? [] : [`Proxy-Authorization: ${proxyAuth}`]),
    '',
    '',
  ].join('\r\n'))
  const { head } = await readHead(socket, CONNECT_TIMEOUT_MS)
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)
  if (status === null || Number(status[1]) < 200 || Number(status[1]) > 299) {
    socket.destroy()
    throw new Error(`代理拒绝了 CONNECT：${head.split('\r\n')[0] ?? '『无响应』'}`)
  }

  const secured = tls.connect({ socket, servername: request.url.hostname })
  await awaitTlsHandshake(secured, CONNECT_TIMEOUT_MS)
  return secured
}

/**
 * Perform one request/response exchange through the proxy.
 * @param request - the hop's coordinates.
 * @returns the response, with a streaming body.
 */
async function oneHop(request: HopRequest): Promise<Response> {
  const transport = await openTransport(request)
  const headers = new Headers(request.headers)
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT)
  if (!headers.has('accept')) headers.set('accept', '*/*')
  // No `accept-encoding` on purpose: the body then never needs decompressing.
  headers.delete('accept-encoding')
  headers.set('connection', 'close')
  // An absolute-form target is what a proxied plain-HTTP request must use.
  const target = request.url.protocol === 'https:'
    ? `${request.url.pathname}${request.url.search}`
    : request.url.toString()
  const head = [
    `${request.method} ${target} HTTP/1.1`,
    `Host: ${request.url.host}`,
    ...[...headers.entries()].map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n')
  transport.write(head)

  const { head: rawHead, rest } = await readHead(transport, HEAD_TIMEOUT_MS)
  const parsed = parseResponseHead(rawHead)
  const framing = bodyFraming(parsed.headers, parsed.status)

  if (request.method === 'HEAD' || parsed.status === 204 || parsed.status === 304 || parsed.status === 205) {
    transport.destroy()
    return new Response(null, { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers })
  }

  const decoder = createBodyDecoder(framing)
  const signal = request.signal
  let closed = false
  // Counted for one reason: a body that dies mid-flight must report how much of
  // it arrived, or a truncated download is indistinguishable from an empty one.
  let received = 0
  const expected = typeof framing === 'object' ? framing.length : undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (): void => {
        if (closed) return
        closed = true
        transport.destroy()
        try { controller.close() } catch { /* already closed by cancel */ }
      }
      const fail = (error: unknown): void => {
        if (closed) return
        closed = true
        transport.destroy()
        try { controller.error(error) } catch { /* already errored */ }
      }
      const onAbort = (): void => fail(new Error('请求已取消'))
      if (signal !== undefined) {
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      transport.setTimeout(IDLE_TIMEOUT_MS, () => fail(new Error(`传输停滞超过 ${IDLE_TIMEOUT_MS / 1000}s`)))
      const onData = (chunk: Buffer): void => {
        let frames: Buffer[]
        try {
          frames = decoder.push(chunk)
        } catch (error) {
          fail(error)
          return
        }
        for (const frame of frames) {
          if (frame.length === 0) continue
          received += frame.length
          controller.enqueue(new Uint8Array(frame))
          // Backpressure: pause the socket instead of buffering a whole movie.
          if ((controller.desiredSize ?? 1) <= 0) transport.pause()
        }
        if (decoder.complete) finish()
      }
      transport.on('data', onData)
      transport.once('error', fail)
      transport.once('close', () => {
        if (closed) return
        // `eof` framing is only complete once the server closes; for a framing
        // that promised a specific length, a close before it is a real failure.
        if (framing === 'eof' || decoder.complete) finish()
        else fail(new Error(`连接在响应体结束之前被关闭（已收到 ${received} 字节${expected === undefined ? '' : ` / 预期 ${expected} 字节`}）`))
      })
      if (rest.length > 0) onData(rest)
    },
    pull() {
      transport.resume()
    },
    cancel() {
      closed = true
      transport.destroy()
    },
  })

  return new Response(body, { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers })
}

/** Redirect statuses that a GET should follow. */
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * Build a `fetch` that honours the resolved proxy.
 *
 * Requests to a bypassed host, and every request when no proxy is configured, go
 * through the platform `fetch` unchanged — including anything that is not a plain
 * GET/HEAD, which this client deliberately does not implement.
 * @param deps - the resolver and an optional direct transport.
 * @returns a `fetch` with the platform signature.
 */
export function createHttpFetch(deps: {
  readonly proxy: () => Promise<ProxySetting>
  readonly direct?: typeof globalThis.fetch
}): typeof globalThis.fetch {
  const direct = deps.direct ?? globalThis.fetch
  const httpFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const setting = await deps.proxy()
    const proxyUrl = setting.url
    if (proxyUrl === undefined) return await direct(input, init)

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return await direct(input, init)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return await direct(input, init)
    if (method !== 'GET' && method !== 'HEAD') return await direct(input, init)
    if (shouldBypass(url.hostname, setting.bypass)) return await direct(input, init)

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined
    const manual = init?.redirect === 'manual'
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await oneHop({ url: current, method, headers, signal, proxyUrl })
      const location = response.headers.get('location')
      if (manual || !REDIRECTS.has(response.status) || location === null) return response
      try { await response.body?.cancel() } catch { /* a body that refuses to cancel is not fatal */ }
      current = new URL(location, current)
      if (setting.bypass.length > 0 && shouldBypass(current.hostname, setting.bypass)) {
        // The redirect left the proxied set: finish it through the platform fetch.
        return await direct(current.toString(), { method, headers, ...(signal === undefined ? {} : { signal }) })
      }
    }
    throw new Error(`重定向次数过多（>${MAX_REDIRECTS}）：${url.toString()}`)
  }
  return httpFetch as typeof globalThis.fetch
}
