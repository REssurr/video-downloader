/**
 * The Host's side of the browser-extension connection.
 *
 * One WebSocket, one extension (a browser can only install the app's extension
 * once, and only one browser is normally being watched). The hub owns:
 *
 *   - the handshake: the extension speaks first (`hello`), because only it knows
 *     its protocol revision and version; the Host answers `welcome`;
 *   - commands: `harvest`, `open`, `fetchMedia`, `ping`, each with an id the
 *     extension echoes back, so an answer is matched to its request;
 *   - tab events: pushed by the extension whenever the page it is watching
 *     changes, and forwarded to the renderer so the panel can show them;
 *   - presence: `state()` is what the panel renders as 「扩展已连接/未连接」.
 *
 * The transport is a raw socket, so framing is done here with `ws-frame.ts`
 * (the extension's frames are masked; the app's are not).
 */
import { encodeFrame, handshakeResponse } from '../events.js'
import type { ExtensionState, ExtensionTab } from '../shared/extension.js'
import { EXT_PROTOCOL } from '../shared/wire.js'
import { createFrameDecoder, decodeFrames } from './ws-frame.js'

/** The socket surface an upgrade leaves behind. */
export interface ExtensionSocket {
  write(chunk: Buffer | string): boolean
  end(chunk?: Buffer | string): void
  destroy(error?: Error): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close' | 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** The request facts an upgrade reads. */
export interface ExtensionUpgradeRequest {
  readonly url?: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/** What the hub lets the rest of the Host do. */
export interface ExtensionHub {
  /**
   * Handshake one upgraded socket.
   * @param req - the upgrade request.
   * @param socket - the raw socket.
   * @param head - bytes read past the handshake.
   */
  accept(req: ExtensionUpgradeRequest, socket: ExtensionSocket, head: Buffer): void
  /** The extension connection, as the panel renders it. */
  state(): ExtensionState
  /** Whether a compatible extension is connected right now. */
  connected(): boolean
  /**
   * Send one command and await its answer.
   * @param name - command name.
   * @param args - JSON body.
   * @param timeoutMs - how long the extension has to answer.
   * @returns the extension's value.
   * @throws when the extension is absent, mismatched, or too slow.
   */
  command<T>(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  /** Send one command without asking for an answer (byte transfers, pings). */
  notify(name: string, args?: Record<string, unknown>): void
  /** Drop the connection (app shutdown). */
  closeAll(): void
}

/** How long an ordinary command may take. */
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000

/** Options, injected so the hub is testable without a clock or a socket. */
export interface ExtensionHubOptions {
  /** Clock, epoch ms. */
  readonly now?: () => number
  /** Push one frame to the renderer's event channel. */
  readonly publish?: (frame: Record<string, unknown>) => void
  /** Default command timeout. */
  readonly commandTimeoutMs?: number
}

/** One connected extension's runtime state. */
interface Connection {
  readonly send: (text: string) => boolean
  readonly close: () => void
  protocol: number
  version: string
  browser: string
  tab: ExtensionTab | undefined
}

/** The hub's own state, turned into an immutable snapshot on every change. */
interface HubSnapshot {
  connected: boolean
  protocol?: number
  version?: string
  browser?: string
  tab?: ExtensionTab
  note: string
  since: number
}

/**
 * Create the hub.
 * @param options - clock, renderer publisher, timeouts.
 * @returns the hub.
 */
export function createExtensionHub(options: ExtensionHubOptions = {}): ExtensionHub {
  const now = options.now ?? (() => Date.now())
  const timeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const publish = options.publish
  let connection: Connection | undefined
  let counter = 0
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let snapshot: HubSnapshot = {
    connected: false,
    note: '浏览器扩展未连接：在 Chrome/Edge 的扩展页里加载本项目 extension 文件夹，然后回到这里',
    since: now(),
  }

  /** Publish the current state to the renderer and any local subscriber. */
  const commit = (patch: Partial<HubSnapshot>): void => {
    snapshot = { ...snapshot, ...patch, since: now() }
    publish?.({ type: 'ext', ext: snapshot })
  }

  /** Settle every command still waiting, so a dropped socket cannot hang a click. */
  const failPending = (reason: string): void => {
    for (const [, wait] of pending) {
      clearTimeout(wait.timer)
      wait.reject(new Error(reason))
    }
    pending.clear()
  }

  const onFrame = (text: string): void => {
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      frame = parsed as Record<string, unknown>
    } catch {
      return
    }
    const type = frame['type']
    if (type === 'hello') {
      const protocol = typeof frame['protocol'] === 'number' ? frame['protocol'] : 0
      const version = typeof frame['version'] === 'string' ? frame['version'] : ''
      const browser = typeof frame['browser'] === 'string' ? frame['browser'] : '浏览器'
      const live = connection
      if (live === undefined) return
      live.protocol = protocol
      live.version = version
      live.browser = browser
      if (protocol !== EXT_PROTOCOL) {
        live.send(JSON.stringify({ type: 'welcome', protocol: EXT_PROTOCOL, ok: false, reason: '协议版本不一致' }))
        commit({
          connected: false,
          protocol,
          version,
          browser,
          note: `扩展协议版本 ${protocol} 与本程序（${EXT_PROTOCOL}）不一致：更新扩展或本程序后重试`,
        })
        live.close()
        return
      }
      live.send(JSON.stringify({ type: 'welcome', protocol: EXT_PROTOCOL, ok: true }))
      commit({ connected: true, protocol, version, browser, note: `${browser} 扩展已连接`, ...(live.tab === undefined ? {} : { tab: live.tab }) })
      return
    }
    if (type === 'tab') {
      const live = connection
      if (live === undefined) return
      const raw = frame['tab']
      const tab = readTab(raw)
      live.tab = tab
      commit({ connected: true, ...(tab === undefined ? {} : { tab }) })
      return
    }
    if (type === 'result') {
      const id = typeof frame['id'] === 'string' ? frame['id'] : ''
      const wait = pending.get(id)
      if (wait === undefined) return
      pending.delete(id)
      clearTimeout(wait.timer)
      if (frame['ok'] === true) wait.resolve(frame['value'])
      else {
        const error = frame['error']
        const message = typeof error === 'string' ? error : (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? String((error as { message: unknown }).message) : '扩展执行失败')
        wait.reject(new Error(message))
      }
    }
  }

  const accept = (req: ExtensionUpgradeRequest, socket: ExtensionSocket, head: Buffer): void => {
    const handshake = handshakeResponse(req.headers)
    if ('rejection' in handshake) {
      try {
        socket.write(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n${handshake.rejection}`)
      } catch {
        // The socket is already gone; the rejection cannot be delivered.
      }
      socket.destroy()
      return
    }
    // One extension at a time: a reloaded extension reconnects before the old
    // socket's close event arrives, and the newest connection is the live one.
    connection?.close()
    try {
      socket.write(handshake.response)
    } catch {
      socket.destroy()
      return
    }
    const decoder = createFrameDecoder()
    const live: Connection = {
      send: text => {
        try {
          socket.write(encodeFrame(Buffer.from(text, 'utf8')))
          return true
        } catch {
          return false
        }
      },
      close: () => {
        try {
          socket.end(encodeFrame(Buffer.alloc(0), 0x8))
        } catch {
          socket.destroy()
        }
      },
      protocol: 0,
      version: '',
      browser: '浏览器',
      tab: undefined,
    }
    connection = live
    const gone = (): void => {
      if (connection === live) {
        connection = undefined
        failPending('浏览器扩展已断开')
        commit({
          connected: false,
          note: '浏览器扩展已断开：确认浏览器还开着，并在扩展页里启用它',
        })
      }
    }
    socket.on('data', (chunk: Buffer) => {
      let frames
      try {
        frames = decodeFrames(decoder, chunk)
      } catch (error) {
        gone()
        return
      }
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          gone()
          return
        }
        if (frame.opcode === 0x9) {
          try {
            socket.write(encodeFrame(Buffer.alloc(0), 0xa))
          } catch {
            // A pong that cannot be written means the socket is already closing.
          }
          continue
        }
        if (frame.opcode === 0x1) onFrame(frame.text)
      }
    })
    socket.on('close', gone)
    socket.on('end', gone)
    socket.on('error', gone)
    if (head.length > 0) {
      try {
        for (const frame of decodeFrames(decoder, head)) {
          if (frame.opcode === 0x1) onFrame(frame.text)
        }
      } catch {
        gone()
      }
    }
  }

  const command = <T>(name: string, args: Record<string, unknown> = {}, timeoutMs = timeout): Promise<T> => {
    const live = connection
    if (live === undefined) return Promise.reject(new Error('浏览器扩展未连接'))
    if (live.protocol !== EXT_PROTOCOL) return Promise.reject(new Error('浏览器扩展协议版本不一致'))
    counter += 1
    const id = `c${counter.toString(36)}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`扩展 ${Math.round(timeoutMs / 1000)} 秒没有回应 ${name}`))
      }, timeoutMs)
      pending.set(id, { resolve: value => { resolve(value as T) }, reject, timer })
      if (!live.send(JSON.stringify({ type: 'command', id, name, args }))) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error('扩展连接已不可用'))
      }
    })
  }

  const notify = (name: string, args: Record<string, unknown> = {}): void => {
    const live = connection
    if (live === undefined || live.protocol !== EXT_PROTOCOL) return
    live.send(JSON.stringify({ type: 'command', name, args }))
  }

  return {
    accept,
    state: () => ({ ...snapshot, ...(snapshot.tab === undefined ? {} : { tab: snapshot.tab }) }),
    connected: () => connection !== undefined && connection.protocol === EXT_PROTOCOL,
    command,
    notify,
    closeAll() {
      const live = connection
      connection = undefined
      failPending('程序正在退出')
      live?.close()
    },
  }
}

/**
 * Read one tab object out of an untrusted frame.
 * @param raw - the frame's `tab` field.
 * @returns the tab, or undefined when it is not shaped like one.
 */
function readTab(raw: unknown): ExtensionTab | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = record['id']
  const url = record['url']
  if (typeof id !== 'number' || typeof url !== 'string' || url === '') return undefined
  const title = record['title']
  const media = record['media']
  return {
    id,
    url,
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
    ...(typeof media === 'string' ? { media } : {}),
  }
}
