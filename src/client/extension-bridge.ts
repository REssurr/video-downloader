/**
 * The renderer's view of the browser extension.
 *
 * Why this module exists at all: while the app hosted the page itself, the page was an
 * element in the SAME renderer and could simply be read. This program has no such
 * element, so the page lives behind the extension and every page question becomes a wire
 * call. This module keeps the shape the panel already renders
 * (`GuestCapabilities`, `ConnectivityReport`) so the UI did not have to be
 * rewritten around the new transport.
 *
 * The harvest itself is still interpreted here (see `guest-harvester.ts`): the
 * extension only reports facts about the page, and deciding which of them are
 * downloadable rows is this app's job.
 */
import { api, UPLOAD_PATH } from './api.js'
import type { ExtensionState, ExtensionTab } from './api-types.js'

/**
 * Whether two URLs belong to the same site.
 *
 * A Cloudflare clearance is scoped to a site AND a client, so fetching site B's
 * media from a page on site A inherits nothing useful. This is a deliberately
 * simple registrable-domain comparison (last two labels, exact host for IPs) —
 * no public-suffix list, and the panel only uses it to warn.
 * @param left - one URL.
 * @param right - the other URL.
 * @returns true when both resolve to the same site.
 */
export function sameSite(left: string, right: string): boolean {
  const hostOf = (value: string): string | undefined => {
    try {
      return new URL(value).hostname.toLowerCase()
    } catch {
      return undefined
    }
  }
  const a = hostOf(left)
  const b = hostOf(right)
  if (a === undefined || b === undefined) return false
  if (a === b) return true
  const isIp = (host: string): boolean => /^\d+(\.\d+){3}$/.test(host) || host.includes(':')
  if (isIp(a) || isIp(b)) return false
  const tail = (host: string): string => host.split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}

/** What the panel knows about the page it could read. */
export interface GuestCapabilities {
  /** Whether a page is available at all. */
  readonly found: boolean
  /**
   * Which transport produced the page.
   *
   * This program has no webview/iframe carrier, so every value produced here is
   * `'extension'` — the extension is the only thing that can read a page. The other two
   * members of the union are never assigned; they remain in the type because narrowing it
   * is an API change, not a wording one.
   */
  readonly kind?: 'webview' | 'iframe' | 'extension'
  /** The address of that page, when there is one. */
  readonly url?: string
  /** Its title, when the extension could read one. */
  readonly title?: string
  /** Whether the page can be read right now (connected extension + a tab). */
  readonly canExecute: boolean
  /** One sentence for the panel: what is usable and what is not. */
  readonly note: string
}

/** The page a download could be handed to. */
export interface ExtensionGuest {
  /** Chrome's tab id. */
  readonly tabId: number
  /** The tab's address, for the same-site test and the copy shown to the user. */
  readonly url: string
}

/** What the panel shows before the extension has ever reported anything. */
export const EMPTY_GUEST: GuestCapabilities = {
  found: false,
  canExecute: false,
  note: '浏览器扩展未连接：在 Chrome/Edge 的扩展页里加载本程序的 extension 文件夹',
}

/**
 * Turn the Host's extension state into what the panel renders.
 * @param state - the extension connection, as the Host reports it.
 * @returns the capabilities, with a sentence that says why something is missing.
 */
export function extensionCapabilities(state: ExtensionState | undefined): GuestCapabilities {
  if (state === undefined) return EMPTY_GUEST
  if (!state.connected) {
    return { found: false, canExecute: false, note: state.note }
  }
  const tab = state.tab
  if (tab === undefined) {
    return {
      found: true,
      kind: 'extension',
      canExecute: false,
      note: `${state.browser ?? '浏览器'}扩展已连接，但还没有看到任何标签页：切一下浏览器标签，或直接在浏览器里打开视频页`,
    }
  }
  return {
    found: true,
    kind: 'extension',
    url: tab.url,
    ...(tab.title === undefined || tab.title === '' ? {} : { title: tab.title }),
    canExecute: true,
    note: `可以读取${state.browser ?? '浏览器'}当前标签页（${tab.url}）`,
  }
}

/**
 * The page a download could be handed to, or undefined when there is none.
 * @param state - the extension connection, as the Host reports it.
 * @returns the tab handle.
 */
export function extensionGuest(state: ExtensionState | undefined): ExtensionGuest | undefined {
  const tab: ExtensionTab | undefined = state?.connected === true ? state.tab : undefined
  if (tab === undefined) return undefined
  return { tabId: tab.id, url: tab.url }
}

/**
 * Ask the extension to harvest one page.
 * @param guest - the tab to read.
 * @param canMerge - whether this machine can join separated tracks, so an
 *   adapter only offers a pair it can actually deliver.
 * @returns the raw harvest, in the shape `parseHarvest` expects.
 */
export async function harvestInPage(guest: ExtensionGuest, canMerge: boolean): Promise<unknown> {
  return await api.extHarvest({ tabId: guest.tabId, canMerge })
}

/**
 * Send the browser to an address, so it becomes the page being watched.
 * @param url - the absolute address to open.
 * @returns the tab the browser opened it in.
 */
export async function openPage(url: string): Promise<{ readonly tabId: number }> {
  return await api.extOpen(url)
}

/** One line of the diagnostics report. */
export interface CheckLine {
  readonly label: string
  /** `true`/`false` are verdicts; `undefined` means "not applicable, see detail". */
  readonly ok?: boolean
  readonly detail: string
}

/** What the diagnostics check found, ready to render. */
export interface ConnectivityReport {
  readonly lines: readonly CheckLine[]
  /** True when the extension path is usable end to end. */
  readonly usable: boolean
  /** One sentence the panel shows under the lines. */
  readonly summary: string
}

/**
 * Run the extension diagnostics.
 *
 * Nothing is downloaded and nothing is written: it answers the three questions a
 * "nothing happened" report cannot, which are whether the extension is there,
 * whether it can see a tab, and whether that tab is allowed to fetch the media.
 * @param options - the live extension state, the media URL to test, and a probe
 *   for the Host's own upload route.
 * @returns the report.
 */
export async function checkExtension(options: {
  readonly state: ExtensionState | undefined
  readonly mediaUrl?: string
  readonly probeUpload?: () => Promise<boolean | undefined>
}): Promise<ConnectivityReport> {
  const lines: CheckLine[] = []
  const state = options.state
  lines.push({
    label: '浏览器扩展已连接',
    ok: state?.connected === true,
    detail: state?.connected === true
      ? `${state.browser ?? '浏览器'} · 扩展版本 ${state.version ?? '?'} · 协议 ${state.protocol ?? '?'}`
      : (state?.note ?? '还没有收到扩展的握手'),
  })
  lines.push({
    label: '扩展能看到当前标签页',
    ok: state?.tab !== undefined,
    detail: state?.tab === undefined ? '扩展还没有报告任何标签页' : `${state.tab.url}`,
  })

  if (state?.tab !== undefined && state.connected) {
    if (options.mediaUrl === undefined) {
      lines.push({ label: '扩展能读取该媒体', detail: '还没有选中任何媒体，跳过' })
    } else {
      try {
        const answer = await api.extProbeMedia(options.mediaUrl)
        const readable = answer.readable === true
        lines.push({
          label: '扩展能读取该媒体',
          ok: readable,
          detail: readable
            ? `读到了（HTTP ${answer.status ?? '?'}）——可以用「扩展下载」`
            : `${answer.reason ?? '读不到'}——该站媒体不允许浏览器脚本读取，只能走本机直连`,
        })
      } catch (error) {
        lines.push({
          label: '扩展能读取该媒体',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } else {
    lines.push({ label: '扩展能读取该媒体', detail: '没有可读的标签页，跳过' })
  }

  if (options.probeUpload !== undefined) {
    let route: boolean | undefined
    try {
      route = await options.probeUpload()
    } catch {
      route = undefined
    }
    lines.push({
      label: '本程序的上传路由',
      ...(route === undefined ? {} : { ok: route }),
      detail: route === true
        ? `已就绪（${UPLOAD_PATH}）：扩展把字节直接送到这里`
        : route === false
          ? '没有响应：重启本程序后再试（重启前「扩展下载」用不了）'
          : '探测失败',
    })
  }

  const usable = state?.connected === true && state.tab !== undefined
  return {
    lines,
    usable,
    summary: usable
      ? '扩展通道可用：抓当前页 / 跟随页面 / 扩展下载都能用。'
      : '扩展通道暂不可用：先确认浏览器里启用了本程序的扩展，再切一下标签页。',
  }
}
