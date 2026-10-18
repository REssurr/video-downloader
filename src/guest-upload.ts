/**
 * The ONE route that is not JSON: the browser extension's page pushes media bytes here.
 *
 * `POST /video-downloader/upload?token=…&offset=…[&done=1][&total=…]` with the
 * raw chunk as the body, or `…&fail=1&code=…&msg=…` with no body to report that
 * the page itself could not fetch the file.
 *
 * Four constraints shaped it, and each one is a decision rather than an accident:
 *
 *   1. **Metadata rides the query string, never headers.** The page is on another
 *      origin, so anything outside a CORS-simple request would be preflighted —
 *      and a preflight cannot be answered, because answering it would mean letting
 *      every website the user has open read this app's API.
 *   2. **Loopback only.** The request is unauthenticated by design (a cross-origin
 *      page cannot send a header token without a preflight), so "it came from this
 *      machine" plus the job's random token is what stands between a page and a
 *      file this app is writing. A request we cannot attribute is refused, not
 *      trusted.
 *   3. **One writer, in order.** The chunk carries its own offset, and it must
 *      equal what has already been written. An out-of-order or duplicated chunk is
 *      refused with 409 rather than guessed at: interleaving bytes would produce a
 *      file that looks complete and is not.
 *   4. **Bounded.** The body is capped before it is read into memory, so a hostile
 *      or broken page cannot make the Host allocate without limit.
 *
 * The module is a pure request → `{ status, body }` function with injected
 * behaviour, so the whole guard surface is testable without a web server.
 */
import type { GuestPushResult } from './download.js'

/** The request surface this route needs: method, URL, peer address, and a body. */
export interface GuestUploadRequest {
  readonly method?: string
  readonly url?: string
  readonly socket?: { readonly remoteAddress?: string }
  on(event: 'data', listener: (chunk?: unknown) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
}

/** One chunk the page pushed. */
export interface GuestUploadPush {
  readonly token: string
  readonly offset: number
  readonly body: Buffer
  readonly done: boolean
  readonly total?: number
}

/** A failure the page reported about its own fetch. */
export interface GuestUploadReport {
  readonly token: string
  readonly code: string
  readonly message: string
}

/** What the route needs from the Host half. */
export interface GuestUploadTarget {
  /** Largest body accepted for one request. */
  readonly maxBytes: number
  /** Whether the peer address is this machine. */
  readonly isLocal: (remoteAddress: string | undefined) => boolean
  /** Hand one chunk to the job that owns the token. */
  readonly push: (input: GuestUploadPush) => Promise<GuestPushResult>
  /** Fail the job with the page's own reason. No throw: there may be no job left. */
  readonly report: (input: GuestUploadReport) => void
}

/** The status and body to write back. */
export interface GuestUploadOutcome {
  readonly status: number
  readonly body: unknown
}

/** Loopback addresses, in the forms a Node socket reports them. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

/**
 * Whether a peer address is this machine.
 *
 * A request we cannot attribute is REFUSED rather than trusted: the upload is the
 * one route that hands bytes to a file this Host is writing.
 * @param address - `req.socket.remoteAddress`, as Node reports it.
 * @returns whether the request came from this machine.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  return LOOPBACK.has(address.trim().toLowerCase())
}

/** Build one failure envelope. */
function failure(status: number, code: string, message: string): GuestUploadOutcome {
  return { status, body: { ok: false, error: { code, message } } }
}

/** The error a body over the cap raises. */
class BodyTooLarge extends Error {}

/**
 * Read the whole body, refusing one that is too large before it can grow.
 * @param req - the request to read.
 * @param maxBytes - the cap.
 * @returns the body.
 * @throws {BodyTooLarge} when the cap is exceeded.
 */
async function readBody(req: GuestUploadRequest, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      bytes += buffer.length
      if (bytes > maxBytes) {
        reject(new BodyTooLarge(`单次上传不能超过 ${maxBytes} 字节`))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => { resolve() })
    req.on('error', (error) => { reject(error instanceof Error ? error : new Error(String(error))) })
  })
  return Buffer.concat(chunks)
}

/** A page-reported code, kept to a bounded token so it can only ever be a label. */
function safeCode(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  return /^[a-z0-9-]{1,32}$/.test(trimmed) ? trimmed : 'guest-error'
}

/**
 * Handle one upload request.
 * @param req - the raw request.
 * @param target - the Host half's behaviour.
 * @returns the status and body to write.
 */
export async function readGuestUpload(req: GuestUploadRequest, target: GuestUploadTarget): Promise<GuestUploadOutcome> {
  if (req.method !== 'POST') return failure(405, 'method-error', '这个地址只接受 POST')
  if (!target.isLocal(req.socket?.remoteAddress)) {
    // Named explicitly: "the browser blocked it" and "the Host refused it" are the
    // two ways this feature dies, and they must not look the same in a log.
    return failure(403, 'forbidden', '页面回传只接受来自本机的请求')
  }
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://dsh.internal')
  } catch {
    return failure(400, 'bad-request', '请求地址无法解析')
  }
  const token = (url.searchParams.get('token') ?? '').trim()
  if (token === '' || token.length > 128) return failure(400, 'bad-request', '缺少上传令牌')

  if (url.searchParams.get('fail') === '1') {
    target.report({
      token,
      code: safeCode(url.searchParams.get('code') ?? ''),
      message: (url.searchParams.get('msg') ?? '').trim().slice(0, 300),
    })
    return { status: 200, body: { ok: true, value: { reported: true } } }
  }

  const offset = Number(url.searchParams.get('offset') ?? '')
  if (!Number.isInteger(offset) || offset < 0) return failure(400, 'bad-request', 'offset 必须是非负整数')
  const done = url.searchParams.get('done') === '1'
  const declared = Number(url.searchParams.get('total') ?? '')
  const total = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : undefined

  let body: Buffer
  try {
    body = await readBody(req, target.maxBytes)
  } catch (error) {
    if (error instanceof BodyTooLarge) return failure(413, 'too-large', error.message)
    return failure(400, 'bad-request', error instanceof Error ? error.message : String(error))
  }

  const result = await target.push({ token, offset, body, done, ...(total === undefined ? {} : { total }) })
  if (result.ok) {
    return { status: 200, body: { ok: true, value: { received: result.received, done: result.done } } }
  }
  const status = result.code === 'unknown-token' ? 404 : result.code === 'too-large' ? 413 : 409
  return failure(status, result.code, result.message)
}
