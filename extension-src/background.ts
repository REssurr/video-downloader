/**
 * The extension's background worker: the app's hands and eyes in the browser.
 *
 * It does three things, and nothing else:
 *
 *   1. **Talks to the app.** One WebSocket to `127.0.0.1:<port>`; the app is the
 *      server, so this side probes `PORT_BASE … PORT_BASE+PORT_RANGE` until one
 *      answers and reconnects with a short backoff when it does not.
 *   2. **Watches the user's tab.** `tabs.onActivated` / `onUpdated` /
 *      `windows.onFocusChanged` feed one `tab` event, so the app's follower knows
 *      which page is on screen without polling the browser.
 *   3. **Answers commands.** `harvest` (DOM facts + a site adapter), `open`,
 *      `probeMedia`, and `fetchMedia` (the bytes, fetched with the browser's own
 *      cookies and streamed to the app's upload route).
 *
 * Why fetching here rather than in a page: this worker is a different HTTP client
 * from the app — it inherits the browser's cookies, TLS fingerprint and IP — and
 * the app's whole "扩展下载" path exists for exactly that difference.
 */
import { bilibiliSite } from './adapter/bilibili.js'
import {
  API_PREFIX,
  EXT_PROTOCOL,
  PORT_BASE,
  PORT_RANGE,
  UPLOAD_CHUNK_BYTES,
  type CommandFrame,
  type TabInfo,
} from './protocol.js'

/** The live socket, or undefined while reconnecting. */
let socket: WebSocket | undefined
/** The port the app answered on. */
let appPort: number | undefined
/** Whether the handshake completed. */
let ready = false
/** The tab the user is looking at, as last reported. */
let activeTab: TabInfo | undefined
/** A pending reconnect. */
let retryTimer: ReturnType<typeof setTimeout> | undefined
/** Whether a connection attempt is already running. */
let connecting = false

/** Log to the worker console; visible in the extension's own inspector. */
function log(...args: unknown[]): void {
  console.info('[video-downloader]', ...args)
}

/** This extension's own version. */
function version(): string {
  return chrome.runtime.getManifest().version
}

/** Which browser this is, in the user's words. */
function browserName(): string {
  const agent = navigator.userAgent
  if (agent.includes('Edg/')) return 'Edge'
  if (agent.includes('Chrome/')) return 'Chrome'
  return '浏览器'
}

/** Send one frame when the socket is up. */
function send(frame: Record<string, unknown>): boolean {
  if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

/** Answer one command (only when the app asked for an answer). */
function reply(id: string | undefined, ok: boolean, value: unknown): void {
  if (id === undefined) return
  send(ok ? { type: 'result', id, ok: true, value } : { type: 'result', id, ok: false, error: errorText(value) })
}

/** Turn anything thrown into a sentence. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Ask the content script in one tab something. */
async function askTab<T>(tabId: number, message: Record<string, unknown>, timeoutMs = 8_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('页面没有回应（刷新一下页面再试）')) }, timeoutMs)
    chrome.tabs.sendMessage(tabId, message, (response: unknown) => {
      clearTimeout(timer)
      const failure = chrome.runtime.lastError
      if (failure !== undefined && failure.message !== undefined) {
        reject(new Error(`页面脚本不可用：${failure.message}`))
        return
      }
      if (response === null || typeof response !== 'object') {
        reject(new Error('页面脚本没有返回内容'))
        return
      }
      const shaped = response as { ok?: unknown; value?: unknown; error?: unknown }
      if (shaped.ok !== true) {
        reject(new Error(typeof shaped.error === 'string' ? shaped.error : '页面脚本执行失败'))
        return
      }
      resolve(shaped.value as T)
    })
  })
}

/** The tab the user is looking at, including a content fingerprint. */
async function readActiveTab(): Promise<TabInfo | undefined> {
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  } catch {
    return undefined
  }
  const tab = tabs[0]
  if (tab === undefined || tab.id === undefined || typeof tab.url !== 'string') return undefined
  if (!/^https?:/i.test(tab.url)) return undefined
  let media: string | undefined
  try {
    media = await askTab<string>(tab.id, { type: 'fingerprint' }, 1_500)
  } catch {
    // A page that was open before the extension was installed has no content
    // script until it is reloaded; the address alone still works.
    media = undefined
  }
  return {
    id: tab.id,
    url: tab.url,
    ...(typeof tab.title === 'string' && tab.title !== '' ? { title: tab.title } : {}),
    ...(media === undefined || media === '' ? {} : { media }),
  }
}

/** Report the current tab to the app. */
async function reportTab(): Promise<void> {
  if (!ready) return
  const tab = await readActiveTab()
  if (tab === undefined) return
  activeTab = tab
  send({ type: 'tab', tab })
}

/** One harvest: DOM facts from the page, then the site adapter (if any). */
async function harvest(args: Record<string, unknown>): Promise<unknown> {
  const tabId = typeof args['tabId'] === 'number' ? args['tabId'] : activeTab?.id
  const canMerge = args['canMerge'] === true
  if (tabId === undefined) throw new Error('没有可以读取的标签页')
  const facts = await askTab<Record<string, unknown>>(tabId, { type: 'harvest' }, 20_000)
  const pageUrl = typeof facts['url'] === 'string' ? facts['url'] : (typeof args['url'] === 'string' ? args['url'] : '')
  const pageTitle = typeof facts['title'] === 'string' ? facts['title'] : ''
  try {
    facts['site'] = (await bilibiliSite({ pageUrl, pageTitle, canMerge })) ?? null
  } catch (error) {
    // An adapter that throws must not take the harvest down with it.
    facts['site'] = { name: 'bilibili', refused: [`站点适配器出错：${errorText(error)}`] }
  }
  return facts
}

/** Whether this browser can read a media URL (diagnostics only). */
async function probeMedia(args: Record<string, unknown>): Promise<unknown> {
  const url = String(args['url'] ?? '')
  try {
    const response = await fetch(url, { credentials: 'include' })
    if (response.body === null) return { readable: false, status: response.status, reason: `响应没有可读的正文（HTTP ${response.status}）` }
    const reader = response.body.getReader()
    const first = await reader.read()
    await reader.cancel()
    return { readable: true, status: response.status, bytes: first.value?.byteLength ?? 0 }
  } catch (error) {
    return { readable: false, reason: errorText(error) }
  }
}

/** POST one chunk of media to the app. */
async function uploadChunk(input: {
  readonly token: string
  readonly offset: number
  readonly bytes: Uint8Array
  readonly done: boolean
  readonly total?: number
}): Promise<void> {
  if (appPort === undefined) throw new Error('与本程序的连接已断开')
  const query = new URLSearchParams({ token: input.token, offset: String(input.offset) })
  if (input.done) query.set('done', '1')
  if (input.total !== undefined) query.set('total', String(input.total))
  // `text/plain` keeps this a CORS-SIMPLE request: an octet-stream body would be
  // preflighted, and a preflight cannot be answered without opening the app's API
  // to every page the user has open.
  const response = await fetch(`http://127.0.0.1:${appPort}${API_PREFIX}/upload?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    // The bytes travel as a plain body; the cast is only because TypeScript's
    // `BodyInit` union does not include a bare Uint8Array view.
    body: input.bytes as unknown as BodyInit,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`上传被拒绝（HTTP ${response.status}）${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
}

/** Tell the app a transfer failed, so the job ends with a sentence. */
function reportFailure(token: string, code: string, message: string): void {
  if (appPort === undefined) return
  const query = new URLSearchParams({ token, fail: '1', code, msg: message.slice(0, 300) })
  void fetch(`http://127.0.0.1:${appPort}${API_PREFIX}/upload?${query.toString()}`, { method: 'POST', body: '' })
    .catch(() => undefined)
}

/** Fetch one media URL with the browser's identity and stream it to the app. */
async function fetchMedia(args: Record<string, unknown>): Promise<void> {
  const token = String(args['token'] ?? '')
  const url = String(args['url'] ?? '')
  if (token === '' || url === '') return
  try {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok || response.body === null) {
      reportFailure(token, 'http-error', `站点拒绝了这个地址（HTTP ${response.status}）`)
      return
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    const total = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : undefined
    const reader = response.body.getReader()
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      for (let start = 0; start < value.byteLength; start += UPLOAD_CHUNK_BYTES) {
        await uploadChunk({
          token,
          offset: offset + start,
          bytes: value.subarray(start, Math.min(value.byteLength, start + UPLOAD_CHUNK_BYTES)),
          done: false,
          ...(total === undefined ? {} : { total }),
        })
      }
      offset += value.byteLength
    }
    await uploadChunk({ token, offset, bytes: new Uint8Array(0), done: true, ...(total === undefined ? { total: offset } : { total }) })
  } catch (error) {
    reportFailure(token, 'fetch-failed', errorText(error))
  }
}

/** Dispatch one command from the app. */
async function onCommand(frame: CommandFrame): Promise<void> {
  try {
    switch (frame.name) {
      case 'ping':
        reply(frame.id, true, { pong: true, version: version(), browser: browserName() })
        return
      case 'harvest':
        reply(frame.id, true, await harvest(frame.args ?? {}))
        return
      case 'open': {
        const url = String((frame.args ?? {})['url'] ?? '')
        const created = await chrome.tabs.create({ url, active: true })
        reply(frame.id, true, { tabId: created.id ?? -1 })
        return
      }
      case 'probeMedia':
        reply(frame.id, true, await probeMedia(frame.args ?? {}))
        return
      case 'fetchMedia':
        // Fire-and-forget: progress travels as bytes on the upload route, not as
        // answers on this channel.
        void fetchMedia(frame.args ?? {})
        reply(frame.id, true, { started: true })
        return
      default:
        reply(frame.id, false, `未知命令 ${frame.name}`)
    }
  } catch (error) {
    reply(frame.id, false, errorText(error))
  }
}

/** Wait for the socket to open, or reject. */
function opened(socket_: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('连接超时')) }, timeoutMs)
    socket_.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket_.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')) }, { once: true })
  })
}

/** Try one port. */
async function tryPort(port: number): Promise<WebSocket> {
  const live = new WebSocket(`ws://127.0.0.1:${port}${API_PREFIX}/ext/ws`)
  await opened(live, 1_200)
  return live
}

/** Connect to the first port that answers, then reconnect on failure. */
async function connect(): Promise<void> {
  if (connecting) return
  connecting = true
  try {
    for (let index = 0; index < PORT_RANGE; index += 1) {
      const port = PORT_BASE + index
      let live: WebSocket
      try {
        live = await tryPort(port)
      } catch {
        continue
      }
      socket = live
      appPort = port
      ready = false
      live.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : ''
        if (data === '') return
        let frame: unknown
        try {
          frame = JSON.parse(data)
        } catch {
          return
        }
        if (frame === null || typeof frame !== 'object') return
        const shaped = frame as { type?: unknown }
        if (shaped.type === 'welcome') {
          ready = (frame as { ok?: unknown }).ok === true
          log(`connected to app on ${port}`)
          void reportTab()
          return
        }
        if (shaped.type === 'command') void onCommand(frame as CommandFrame)
      })
      live.addEventListener('close', () => {
        if (socket === live) {
          socket = undefined
          appPort = undefined
          ready = false
        }
        scheduleReconnect()
      })
      live.send(JSON.stringify({ type: 'hello', protocol: EXT_PROTOCOL, version: version(), browser: browserName() }))
      return
    }
    log('no app answered on the port range')
    scheduleReconnect()
  } finally {
    connecting = false
  }
}

/** Reconnect a few seconds later; a closed app is not an error. */
function scheduleReconnect(): void {
  if (retryTimer !== undefined) return
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void connect()
  }, 3_000)
}

/** One out-of-band sign of life: the pinned tab changed. */
function watchTabs(): void {
  chrome.tabs.onActivated.addListener(() => { void reportTab() })
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url === undefined && changeInfo.status !== 'complete') return
    void reportTab()
  })
  chrome.windows.onFocusChanged.addListener(() => { void reportTab() })
  // A new page can start playing a while after it loads; the follower's own
  // polling is what catches that, but a title change is free information.
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.title !== undefined) void reportTab()
  })
}

chrome.runtime.onInstalled.addListener(() => { void connect() })
chrome.runtime.onStartup.addListener(() => { void connect() })
watchTabs()
void connect()
