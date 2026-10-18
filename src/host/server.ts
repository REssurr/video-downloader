/**
 * The Host: one loopback HTTP server, and everything that hangs off it.
 *
 * It serves four things, all from the same origin:
 *
 *   1. the renderer (`/`, `/app.js`) — so the panel can keep using RELATIVE API
 *      paths, and so `location.origin` is the server's own origin;
 *   2. the JSON API (`POST /video-downloader/api/<method>`);
 *   3. the raw byte route the browser carries media through
 *      (`POST /video-downloader/upload?token=…`);
 *   4. two WebSockets: the renderer's job-update channel and the browser
 *      extension's control channel.
 *
 * The old plugin build used a Host `webServer` service for all of this; the
 * standalone app OWNS the server, so the same routes are registered directly and
 * `startHostServer` resolves with the port it actually bound (the first free one
 * in the configured range).
 *
 * Everything expensive (the download engine, ffmpeg discovery, the proxy) is
 * created once here and injected into the dispatcher, exactly as before.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { mkdirSync, readFileSync as readFile, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, saveConfig, type ConfigIo } from '../config.js'
import { createDownloadEngine, GUEST_MAX_CHUNK_BYTES, nodeDownloadFs } from '../download.js'
import { acceptUpgrade, type EventSocket } from '../events.js'
import { guestEntries, readGuestCandidates } from '../guest-harvest.js'
import { isLoopbackAddress, readGuestUpload, type GuestUploadTarget } from '../guest-upload.js'
import { createMuxerKeeper, nodeMuxerProbe } from '../mux.js'
import { createHttpFetch } from '../net/http-fetch.js'
import { createProxyResolver, type NetworkStatus } from '../net/proxy.js'
import { revealPath, revealTargetFor } from '../reveal.js'
import { applyMediaPolicy } from '../probe/policy.js'
import { ApiFailure, createDispatcher, type DownloaderServices, type ProbeRecord } from '../routes.js'
import { createExtensionHub } from './extension-hub.js'
import { EXT_WS_PATH, EVENTS_PATH, API_PREFIX, PORT_RANGE, UPLOAD_PATH } from '../shared/wire.js'
import type { DownloaderConfig } from '../shared/types.js'
import type { ExtensionState, ExtensionTab } from '../shared/extension.js'
import { legacyConfig } from './legacy-migration.js'

/** A synchronous, atomic config document over `node:fs`. */
function configIo(): ConfigIo {
  return {
    readFile(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return undefined
        throw error
      }
    },
    writeFileAtomic(path, contents) {
      const temp = `${path}.${process.pid.toString(36)}.tmp`
      writeFileSync(temp, contents, 'utf8')
      renameSync(temp, path)
    },
    ensureDir(path) {
      mkdirSync(path, { recursive: true })
    },
    join,
  }
}

/** What the Host needs from its shell (the Electron main process). */
export interface HostOptions {
  /** State directory: config, and the `tools/bin` ffmpeg search root. */
  readonly stateDir: string
  /** Download directory used on the very first run. */
  readonly defaultDownloadDir: string
  /** Directory holding the built renderer (`index.html`, `app.js`). */
  readonly staticDir: string
  /** The app's version, reported to the panel. */
  readonly version: string
  /** First port to try, before the config document is read. */
  readonly basePort: number
  /** The native directory picker, supplied by the shell. */
  readonly pickDirectory: () => Promise<string | null>
  /** Optional clock, for tests. */
  readonly now?: () => number
}

/** What a started Host exposes. */
export interface Host {
  /** The port actually bound (127.0.0.1 only). */
  readonly port: number
  /** The URL the renderer is loaded from. */
  readonly url: string
  /** Close the server and every live socket. */
  close(): Promise<void>
  /** The current extension state, for tray/menu code. */
  extension(): ExtensionState
}

/**
 * Start the Host.
 * @param options - state directories, version, port and the shell's picker.
 * @returns the running Host.
 */
export async function startHostServer(options: HostOptions): Promise<Host> {
  const now = options.now ?? (() => Date.now())
  const io = configIo()
  const directory = options.stateDir
  mkdirSync(directory, { recursive: true })
  const loaded = loadConfig(io, directory, options.defaultDownloadDir, now())
  let config: DownloaderConfig = loaded.config
  const notices: string[] = [...loaded.issues]

  // A first run inherits the settings the old plugin had, so the download folder does
  // not silently move to a default the user never chose. Read-only: the old plugin's
  // own directory is never written to.
  if (!loaded.existed) {
    const legacy = legacyConfig()
    if (legacy !== undefined) {
      config = { ...config, ...legacy.config }
      saveConfig(io, directory, config)
      notices.push(...legacy.notices)
    }
  }

  /** Event subscribers on the renderer's channel. */
  const sockets = new Set<EventSocket>()
  /** Mint one connection identity per accepted renderer upgrade. */
  let socketCounter = 0

  /** What the Host actually wired up, reported by `state.health`. */
  const health = { api: false, eventSocket: false, socketAccepted: false } as {
    api: boolean
    eventSocket: boolean
    socketAccepted: boolean
    eventSocketReason?: string
    eventSocketDetail?: string
  }

  /** Push one frame to every attached renderer. */
  const broadcast = (event: Record<string, unknown>): void => {
    const text = JSON.stringify(event)
    for (const socket of [...sockets]) {
      if (!socket.send(text)) sockets.delete(socket)
    }
  }

  const proxyResolver = createProxyResolver(() => config.proxy)
  const httpFetch = createHttpFetch({ proxy: () => proxyResolver.current() })
  const networkStatus = async (): Promise<NetworkStatus> => {
    const setting = await proxyResolver.current()
    return {
      proxied: setting.url !== undefined,
      ...(setting.url === undefined ? {} : { proxy: setting.url }),
      source: setting.source,
      ...(setting.reason === undefined ? {} : { reason: setting.reason }),
    }
  }

  const muxerKeeper = createMuxerKeeper({
    probe: () => nodeMuxerProbe({ home: options.stateDir }),
    exists: path => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
    onChange: (status) => {
      notices.push(status.available
        ? `本机 ffmpeg 可用（${status.version ?? status.path ?? ''}）：分离的视频轨与音频轨可以合并成一个 mp4`
        : `本机没有可用的 ffmpeg.exe：分离的视频轨与音频轨无法合并，只提供整份文件（${status.reason ?? ''}）`)
    },
  })

  const engine = createDownloadEngine(
    {
      fs: nodeDownloadFs(),
      fetch: httpFetch,
      now: () => Date.now(),
      mux: () => muxerKeeper.runner(),
    },
    {
      maxConcurrent: config.maxConcurrent,
      onUpdate: job => { broadcast({ type: 'job', job }) },
    },
  )

  /** The last harvest of each URL, so `download.start` can resolve an option. */
  const probes = new Map<string, ProbeRecord>()

  /** The extension connection. */
  const hub = createExtensionHub({
    now,
    publish: frame => { broadcast(frame) },
  })

  /** Persist the configuration; a save failure is a notice AND a thrown error. */
  const persist = async (next: DownloaderConfig): Promise<void> => {
    config = next
    try {
      saveConfig(io, directory, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notices.push(`配置保存失败：${message}`)
      throw new Error(`配置保存失败：${message}`)
    }
  }

  /** The extension's current tab, when it has one. */
  const activeTab = (): ExtensionTab | undefined => hub.state().tab

  const services: DownloaderServices = {
    version: options.version,
    config: () => config,
    configPath: join(directory, 'config.json'),
    notices: () => notices,
    setConfig: persist,
    network: networkStatus,
    merge: () => muxerKeeper.status(),
    invalidateNetwork: () => { proxyResolver.invalidate() },
    invalidateProbes: () => { probes.clear() },
    extension: () => hub.state(),
    async harvest({ tabId, canMerge }) {
      if (!hub.connected()) throw new ApiFailure('bad-request', '浏览器扩展未连接：先在 Chrome/Edge 里启用本程序的扩展')
      const state = hub.state()
      const target = tabId === undefined
        ? state.tab
        : (state.tab !== undefined && state.tab.id === tabId ? state.tab : undefined)
      if (target === undefined) throw new ApiFailure('bad-request', '扩展还没有报告任何标签页：先切换一下浏览器标签，再点「抓当前页」')
      // The extension owns the page: it collects the DOM facts and, for a site
      // with an adapter, asks that site's own API. The Host only decides what the
      // answer means, which is why the merge capability travels WITH the request.
      return await hub.command('harvest', { tabId: target.id, url: target.url, canMerge }, 30_000)
    },
    async openInBrowser(url) {
      if (!hub.connected()) throw new ApiFailure('bad-request', '浏览器扩展未连接：先在 Chrome/Edge 里启用本程序的扩展')
      return await hub.command<{ tabId: number }>('open', { url }, 10_000)
    },
    async probeMedia(url) {
      if (!hub.connected()) throw new ApiFailure('bad-request', '浏览器扩展未连接')
      return await hub.command('probeMedia', { url }, 25_000)
    },
    async pickDirectory() {
      return await options.pickDirectory()
    },
    async registerGuest({ url, title, candidates }) {
      const read = readGuestCandidates(candidates)
      if (read.candidates.length === 0) throw new ApiFailure('bad-request', '页面里没有找到可下载的媒体地址')
      const built = guestEntries({
        pageUrl: url,
        ...(title === undefined ? {} : { pageTitle: title }),
        candidates: read.candidates,
      })
      const merge = await muxerKeeper.status()
      const effect = applyMediaPolicy(
        { source: 'guest', entries: built.entries, notes: built.notes },
        { mp4Only: config.mp4Only, canMerge: merge.available },
      )
      const notes = [...effect.outcome.notes]
      if (read.dropped > 0) notes.push(`页面还报了 ${read.dropped} 个地址，已丢弃（重复、不是 http(s)，或超出单次上限）`)
      if (effect.outcome.entries.length === 0) {
        notes.push('这些地址都不是可播放的 mp4，已按「只提供 mp4」全部跳过；在「设置」里可以关掉这个限制')
      }
      const record: ProbeRecord = {
        url,
        source: 'guest',
        entries: effect.outcome.entries,
        notes,
        ...(title === undefined ? {} : { pageTitle: title }),
      }
      probes.set(url, record)
      return { record }
    },
    async startDownload({ url, formatId, entryId, onConflict, carrier }) {
      const record = probes.get(url)
      if (record === undefined) throw new Error('请先探测该网址')
      const entry = entryId === undefined
        ? record.entries.find(candidate => candidate.options.some(option => option.id === formatId))
        : record.entries.find(candidate => candidate.id === entryId)
      const option = entry?.options.find(candidate => candidate.id === formatId)
      if (entry === undefined || option === undefined) throw new Error('找不到所选清晰度，请重新探测')
      const merge = await muxerKeeper.status()
      if (option.audioUrl !== undefined && option.audioUrl !== '' && !merge.available) {
        throw new ApiFailure('bad-request', `这一档要把视频轨与音频轨合并成一个 mp4，但本机没有找到 ffmpeg.exe（${merge.reason ?? '未找到'}）`)
      }
      const referer = entry.url === url ? originOf(url) : url
      const request = {
        url: entry.url,
        option,
        title: entry.title,
        downloadDir: config.downloadDir,
        filenameTemplate: config.filenameTemplate,
        ...(referer === undefined ? {} : { referer }),
        ...(carrier === 'guest' ? { carrier: 'guest' as const } : {}),
      }
      const existing = await engine.inspect(request)
      if (existing !== undefined && onConflict === undefined) {
        const normalize = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
        const previous = engine.list().find(job => job.outputPath !== undefined && normalize(job.outputPath) === normalize(existing.path))
        const previousOption = previous === undefined
          ? undefined
          : probes.get(previous.url)?.entries
            .flatMap(candidate => candidate.options)
            .find(candidate => candidate.id === previous.formatId)
        return {
          conflict: {
            path: existing.path,
            existingBytes: existing.bytes,
            ...(existing.modifiedAtMs === undefined ? {} : { existingModifiedAt: existing.modifiedAtMs }),
            ...(previous === undefined ? {} : { existingTitle: previous.title, existingUrl: previous.url }),
            ...(option.height === undefined ? {} : { incomingHeight: option.height }),
            ...(previousOption?.height === undefined ? {} : { existingHeight: previousOption.height }),
          },
        }
      }
      const handle = engine.start({
        ...request,
        ...(onConflict === undefined ? {} : { onConflict }),
        ...(existing === undefined ? {} : { existingPath: existing.path }),
      })
      // A page-carried job is fetched BY the extension, which already has the
      // browser's cookies and IP. The Host mints the token and hands the whole job
      // over; the bytes arrive on `/upload` like any page push.
      if (handle.guest !== undefined) {
        if (!hub.connected()) {
          engine.cancel(handle.id)
          throw new ApiFailure('bad-request', '浏览器扩展未连接，这次「扩展下载」无法开始；点「本机直连」或恢复扩展后重试')
        }
        hub.notify('fetchMedia', {
          token: handle.guest.token,
          url: entry.url,
          ...(referer === undefined ? {} : { referer }),
        })
      }
      return {
        jobId: handle.id,
        ...(handle.guest === undefined ? {} : { guestToken: handle.guest.token }),
      }
    },
    cancelJob(jobId) { engine.cancel(jobId) },
    async revealDownload(jobId) {
      const job = engine.list().find(candidate => candidate.id === jobId)
      if (job === undefined) throw new ApiFailure('not-found', '找不到这个任务（它可能已经不在最近列表里）')
      const target = revealTargetFor({ outputPath: job.outputPath, downloadDir: config.downloadDir })
      await revealPath({ path: target.path })
      return { path: target.path }
    },
    jobs: () => engine.list(),
    health: () => ({ ...health }),
  }

  const dispatcher = createDispatcher(services)

  /** The raw byte route's behaviour, wired to the live engine. */
  const guestUploadTarget: GuestUploadTarget = {
    maxBytes: GUEST_MAX_CHUNK_BYTES,
    isLocal: isLoopbackAddress,
    push: input => engine.pushGuest(input.token, input),
    report: (input) => { engine.failGuest(input.token, input.code, input.message) },
  }

  const server = createServer()
  const allowedOrigins = new Set<string>()

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Hardening the standalone app needs and the in-app panel never did: the panel
    // runs on this same origin, so a request whose Origin names somebody else's site
    // is a webpage poking at this loopback server, not us. `Origin: null` (a
    // sandboxed iframe, a `data:` page) is exactly such a webpage, so it is refused
    // rather than waved through.
    if (!isTrustedOrigin(headerOf(req, 'origin'), allowedOrigins)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝来自其他网站的请求' } })
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      serveStatic(res, options.staticDir, 'index.html', 'text/html; charset=utf-8')
      return
    }
    if (url.pathname === '/app.js' || url.pathname === '/app.js.map') {
      serveStatic(res, options.staticDir, url.pathname.slice(1), 'text/javascript; charset=utf-8')
      return
    }
    if (url.pathname === UPLOAD_PATH) {
      void (async () => {
        try {
          const outcome = await readGuestUpload(req as never, guestUploadTarget)
          writeJson(res, outcome.status, outcome.body)
        } catch (error) {
          // A rejected push must answer, not crash the main process: an unhandled
          // rejection here takes Electron down with the request still open.
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        }
      })()
      return
    }
    if (url.pathname.startsWith(`${API_PREFIX}/api`)) {
      void handleApi(req, res, url)
      return
    }
    if (url.pathname === EVENTS_PATH) {
      writeJson(res, 426, { ok: false, error: { code: 'upgrade-required', message: `${EVENTS_PATH} 需要 WebSocket 连接` } })
      return
    }
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这个地址' } })
  })

  /** One JSON API call. */
  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      return
    }
    const method = url.pathname.startsWith(`${API_PREFIX}/api/`)
      ? url.pathname.slice(`${API_PREFIX}/api/`.length)
      : ''
    if (method === '' || method.includes('/')) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown API method' } })
      return
    }
    let payload: Record<string, unknown>
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      // A malformed or oversized body is the caller's mistake, not ours.
      writeJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
      })
      return
    }
    try {
      const envelope = await dispatcher.dispatch(method, payload)
      writeJson(res, statusFor(envelope), envelope)
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // A WebSocket carries no CORS preflight, so this check IS the access control:
    // without it any page could open the extension channel, pretend to be the
    // extension, and be handed the media-fetch tokens the engine mints.
    if (!isTrustedOrigin(headerOf(req, 'origin'), allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const facts = { url: req.url, headers: req.headers }
    if (url.pathname === EXT_WS_PATH) {
      hub.accept(facts, socket as never, head)
      return
    }
    if (url.pathname === EVENTS_PATH) {
      const accepted = acceptUpgrade(facts, socket as never, head, () => {
        socketCounter += 1
        return `sock-${socketCounter.toString(36)}`
      })
      const live = accepted.socket
      if (live === undefined) return
      sockets.add(live)
      health.socketAccepted = true
      live.send(JSON.stringify({ type: 'hello', sessionId: live.sessionId, connectionId: live.id }))
      live.onClose(() => { sockets.delete(live) })
      return
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })

  health.api = true
  health.eventSocket = true

  // Bind the first free port in the configured range; the extension probes the
  // same range, so a busy port costs a retry rather than the whole feature.
  const basePort = Number.isInteger(config.port) && config.port >= 1024 ? config.port : options.basePort
  const port = await listenOnRange(server, basePort, PORT_RANGE)
  allowedOrigins.add(`http://127.0.0.1:${port}`)
  allowedOrigins.add(`http://localhost:${port}`)
  const url = `http://127.0.0.1:${port}/`
  console.info(`[video-downloader] host listening on ${url}`)

  return {
    port,
    url,
    extension: () => hub.state(),
    async close() {
      hub.closeAll()
      for (const socket of sockets) socket.close()
      sockets.clear()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** Resolve once the server is listening on one port in the range. */
function listenOnRange(server: Server, basePort: number, range: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let attempt = 0
    const tryPort = (port: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError)
        if (error.code === 'EADDRINUSE' && attempt < range - 1) {
          attempt += 1
          tryPort(port + 1)
          return
        }
        reject(error)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : port)
      })
    }
    tryPort(basePort)
  })
}

/** One header value as a string. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined
}

/**
 * Whether a request may talk to this server.
 *
 * A browser always names the requesting page in `Origin`, so the check is exact and
 * cheap: our own renderer names a loopback origin we bound, a browser extension
 * names its `chrome-extension://` origin, and any web page names its own site —
 * which is precisely the traffic this must stop. `Origin: null` is an opaque origin
 * (a sandboxed iframe, a `data:` page): the same threat, so the same answer.
 *
 * A request with NO `Origin` comes from a native client (curl, the test suite), and
 * the server only listens on 127.0.0.1 — those are already this machine's own
 * processes.
 */
function isTrustedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true
  if (allowed.has(origin)) return true
  return origin.startsWith('chrome-extension://')
}

/** Serve one file from the static directory. */
function serveStatic(res: ServerResponse, directory: string, name: string, contentType: string): void {
  try {
    const body = readFile(join(directory, name))
    res.statusCode = 200
    res.setHeader('content-type', contentType)
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(`没有找到 ${name}：先运行 pnpm build`)
  }
}

/** Write one JSON envelope. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** The envelope shape the status mapper reads. */
interface EnvelopeLike {
  readonly ok?: unknown
  readonly error?: { readonly code?: unknown } | undefined
}

/**
 * Map a dispatcher envelope onto an HTTP status.
 * @param envelope - the dispatcher's answer.
 * @returns the HTTP status to write.
 */
export function statusFor(envelope: unknown): number {
  const shaped = envelope as EnvelopeLike
  if (shaped?.ok !== false) return 200
  switch (shaped.error?.code) {
    case 'not-found':
      return 404
    case 'bad-request':
    case 'bad-rule':
      return 400
    case 'forbidden':
      return 403
    default:
      // `internal` and anything unclassified is a failure, not a success; answering
      // 200 would let a caller treat a broken request as an empty result.
      return 500
  }
}

/** The request surface the body reader needs. */
interface BodyRequest {
  on(event: 'data', listener: (chunk?: unknown) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: unknown) => void): void
}

/** Read and parse a JSON request body, capped so a huge body cannot exhaust memory. */
async function readJsonBody(req: unknown): Promise<Record<string, unknown>> {
  const stream = req as BodyRequest
  const chunks: Buffer[] = []
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
      bytes += buffer.length
      if (bytes > 1024 * 1024) {
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(buffer)
    })
    stream.on('end', () => resolve())
    stream.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
  })
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * The `Referer` a browser would have sent for a media request.
 * @param url - the page URL.
 * @returns `scheme://host/`, or undefined when the URL is unusable.
 */
function originOf(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/`
  } catch {
    return undefined
  }
}
