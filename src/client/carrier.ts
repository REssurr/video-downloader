/**
 * Which client fetches the bytes — the one decision the CLIENT has to make.
 *
 * The Host cannot see the sidebar browser, so only this half knows whether there is a
 * page to hand a download to. It also has to be the same rule that LABELS each row in
 * the picker and the rule that starts the job: a label that promised 页面下载 while the
 * click ran something else would be worse than no label.
 *
 * There are two carriers, and only two, because the panel only ever offers a **single
 * file** (the harvest refuses manifests and fragments — see `guest-harvester.ts`).
 * A third one used to exist for `.m3u8`; with manifests off the list it had nothing
 * left to fetch, and a carrier nothing can select should not exist.
 *
 *   - `auto` (default) — the Host's own fetch, then the page automatically if the site
 *     refuses it (`shouldFallBackToPage` in `store.ts`).
 *   - `page` — the page first, for anything the page can plausibly be given.
 *   - `host` — never the page.
 *
 * Pure, so the decision is testable without a DOM, a browser, or a Host.
 */

/** Which client runs the transfer. */
export type DownloadCarrier = 'guest' | 'host'

/** The user's standing preference for who downloads. */
export type DownloadPath = 'auto' | 'page' | 'host'

/** Everything the decision depends on. */
export interface CarrierInput {
  /** Where the option came from: the page. */
  readonly source: 'guest'
  /** The user's setting. */
  readonly downloadPath: DownloadPath
  /** Whether a page that can run scripts is currently open in the sidebar. */
  readonly guestUsable: boolean
  /** Whether the media URL belongs to the same site as that page. */
  readonly sameSite: boolean
  /**
   * Whether this option is a separated pair that has to be merged after it arrives.
   *
   * A pair is TWO files, and the page carrier can only push one URL: handing it over would
   * save the video track alone — a silent film under the name of the video the user asked
   * for. So this overrides every other rule, including `downloadPath: 'page'`: the merge
   * only exists on the Host.
   */
  readonly needsMux?: boolean
}

/**
 * Choose the carrier for one option — the FIRST attempt at it.
 * @param input - the option, the setting, and what the panel can see.
 * @returns the carrier to use.
 */
export function chooseCarrier(input: CarrierInput): DownloadCarrier {
  // Before the preference, because no preference can make this work over there.
  if (input.needsMux === true) return 'host'
  if (input.downloadPath === 'host' || !input.guestUsable) return 'host'
  if (input.downloadPath === 'page' && (input.source === 'guest' || input.sameSite)) return 'guest'
  return 'host'
}

/** What is known about a job that already ended, for the fallback decision. */
export interface FallbackInput {
  /** The job's terminal status. */
  readonly status: string
  /** Bytes the Host recorded for it. */
  readonly receivedBytes: number
  /** Whether the user stopped it. */
  readonly stopped: boolean
  /** The carrier that just failed. */
  readonly carrier: DownloadCarrier
  /** Whether a page that can run scripts is open right now. */
  readonly pageUsable: boolean
  /** Whether this option has already been handed to the page once. */
  readonly alreadyTried: boolean
  /** Whether this option is a pair that must be merged, so the page cannot carry it. */
  readonly needsMux?: boolean
}

/**
 * Whether a finished job should be handed to the page.
 *
 * The rules are all "no" for a reason: a `cancelled` job is the user's own decision,
 * bytes already on disk belong to the carrier that wrote them (a second transport
 * writing the same name gives two files and one lie), a page job that failed has nowhere
 * left to go, and a retry that already happened must not happen again. A pair adds one
 * more: the page can push one URL, and this job is two.
 * @param input - the finished job and what the panel can see.
 * @returns whether to start the same option with the page carrier.
 */
export function shouldFallBackToPage(input: FallbackInput): boolean {
  if (input.status !== 'failed') return false
  if (input.receivedBytes > 0) return false
  if (input.stopped) return false
  if (input.carrier !== 'host') return false
  if (input.needsMux === true) return false
  if (!input.pageUsable) return false
  return !input.alreadyTried
}

/** The short label a row carries, naming the client that will run. */
export function carrierLabel(carrier: DownloadCarrier, needsMux = false): string {
  if (carrier === 'guest') return '扩展下载'
  return needsMux ? '本机合并' : '本机直连'
}

/**
 * The one-sentence explanation for a row's carrier.
 *
 * Shown as the hover title, and it says what the carrier COSTS rather than what it is:
 * the whole reason this choice exists is that the Host is a different HTTP client from
 * the browser, so a user looking at a row has to be able to tell which one inherits the
 * page's clearance. A pair is the one row with no choice left to explain, only a cost:
 * two downloads and a merge with the ffmpeg on this machine.
 * @param carrier - the chosen carrier.
 * @param input - the facts the choice was made from.
 * @returns the explanation.
 */
export function carrierHint(carrier: DownloadCarrier, input: CarrierInput): string {
  if (carrier === 'guest') {
    return '字节由浏览器扩展取回：它用的是浏览器的身份（Cookie / TLS / IP），站点对浏览器的校验对它有效'
  }
  if (input.needsMux === true) {
    return '这一档只有分离的视频轨与音频轨：由本程序分别下载两条，再用本机的 ffmpeg 合成一个 mp4（扩展一次只能取一个地址，交给它只能拿到没声音的画面）'
  }
  const auto = input.downloadPath === 'auto' ? '；如果站点拒绝，会自动改用扩展下载重试一次' : ''
  return `由本程序直接下载${input.downloadPath === 'host' ? '（设置要求始终用本程序）' : ''}${auto}`
}
