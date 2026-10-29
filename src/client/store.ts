/**
 * The client store: one observable snapshot, plus every action the panel needs.
 *
 * Deliberately hand-rolled and framework-light (`subscribe`/`getSnapshot` for
 * React's `useSyncExternalStore`) rather than a reactive library: the state is a
 * flat record that the Host is the authority for, so the only real work is
 * merging a state read and folding job-update events into it.
 *
 * The Host remains the single source of truth: this store never invents a config
 * value, it only mirrors what `state` returned and applies `job` / `ext` events on
 * top. That keeps the panel honest when a second window changes the config.
 */
import { api, DownloaderApiError, EVENTS_PATH } from './api.js'
import {
  checkExtension,
  extensionCapabilities,
  extensionGuest,
  harvestInPage,
  openPage,
  sameSite,
  type ConnectivityReport,
  type ExtensionGuest,
  type GuestCapabilities,
} from './extension-bridge.js'
import { chooseCarrier, carrierHint, carrierLabel, shouldFallBackToPage, type CarrierInput, type DownloadCarrier } from './carrier.js'
import { startGuestFollower } from './guest-follower.js'
import { parseHarvest, pickMediaCandidates, describeHarvest, type HarvestReport, type MediaCandidate } from './guest-harvester.js'
import { answerWithin } from './page-call.js'
import { classifyAddress } from './url-entry.js'
import type { DownloaderConfig, DownloaderState, GuestCandidate, JobView, ProbeRecord, StartDownloadResult, VideoOption } from './api-types.js'

/** The probe the panel is showing: the Host's record, nothing else. */
export interface ActiveProbe {
  readonly record: ProbeRecord
}

/**
 * The page a download could be handed to.
 *
 * Published by the follower (see `guest-follower.ts`), which runs for the whole
 * of the app's lifetime rather than only while the panel is open — so the
 * extension download path and the per-row carrier labels are honest even when the
 * window is minimised.
 */
export type GuestSource = ExtensionGuest

/**
 * How long the extension may take to answer one harvest.
 *
 * Generous on purpose: the extension's site adapter makes the site's own API
 * calls, and a site can be slow. Still bounded — an unanswered harvest must not
 * leave the button saying 「读取中…」 forever.
 */
export const HARVEST_CALL_MS = 25_000

/** What the panel renders from. */
export interface StoreSnapshot {
  /** The mirrored Host state, or `undefined` before the first read. */
  readonly state?: DownloaderState
  /** Whether the panel is open (kept for the overlay-style close button). */
  readonly open: boolean
  /** The active page harvest, or `undefined` before 抓当前页 has run. */
  readonly probe?: ActiveProbe
  /** Whether a 抓当前页 harvest is running right now. */
  readonly harvesting?: boolean
  /** The last error surfaced to the user, if any. */
  readonly error?: { readonly code: string; readonly message: string }
  /** Whether the live event channel is connected. */
  readonly live: boolean
  /** Whether the settings section is expanded inside the panel. */
  readonly settingsOpen: boolean
  /** What the last page harvest saw, including what it refused. */
  readonly harvest?: HarvestReport
  /** Whether the panel re-reads the page when that page changes. */
  readonly following?: boolean
  /** The browser page, as the follower last saw it. */
  readonly guest?: GuestCapabilities
  /** An address the panel opened in the browser and is waiting to read. */
  readonly opening?: string
  /** What the 网址 box contains. */
  readonly address?: string
}

/**
 * A snapshot patch where every optional field may be explicitly CLEARED.
 *
 * `exactOptionalPropertyTypes` makes `{ error: undefined }` illegal against an
 * optional property, but the store needs exactly that: "this field is now absent".
 */
export type SnapshotPatch = {
  [K in keyof StoreSnapshot]?: StoreSnapshot[K] | undefined
}

/** The store's public face. */
export interface DownloaderStore {
  /** React `useSyncExternalStore` subscribe. */
  subscribe(listener: () => void): () => void
  /** React `useSyncExternalStore` snapshot. */
  getSnapshot(): StoreSnapshot
  /** Load (or reload) the Host state. */
  refresh(): Promise<void>
  /** Open or close the panel. */
  setOpen(open: boolean): void
  /** Expand or collapse the settings block. */
  setSettingsOpen(open: boolean): void
  /** Clear the surfaced error. */
  clearError(): void
  /** Replace what the 网址 box contains. */
  setAddress(text: string): void
  /** Take an address that was dropped onto the window. */
  dropAddress(raw: string): Promise<void>
  /** Read the browser page and list the whole media files it is playing. */
  harvestCurrentPage(input: { url: string; title?: string; key?: string }): Promise<boolean>
  /** Read what the URL box contains. */
  readAddress(raw: string): Promise<void>
  /** The browser page moved (or settled after a navigation). */
  pageSettled(input: { url: string; title?: string; key?: string }): Promise<boolean>
  /** Turn 「跟随页面」 on or off. */
  setFollowing(following: boolean): void
  /** Watch the browser page for the app's whole lifetime. */
  watchGuestPage(): () => void
  /** Start a download for one probed option. */
  startDownload(input: {
    url: string
    formatId: string
    entryId?: string
    onConflict?: 'overwrite' | 'keep'
  }): Promise<StartDownloadResult | undefined>
  /** Which client will carry one option, plus the words for its row label. */
  carrierAdvice(option: VideoOption): { readonly carrier: DownloadCarrier; readonly label: string; readonly hint: string } | undefined
  /** Tell the store which page the panel can see, or that it can see none. */
  setGuestSource(source: GuestSource | undefined): void
  /** Cancel a job. */
  cancel(jobId: string): void
  /**
   * Retry a failed job on the other carrier.
   *
   * The Host creates a new job for it; the failed row is left alone, so a second
   * failure still has the first one beside it to compare.
   */
  retry(jobId: string): Promise<void>
  /** Show a job's file (or the download directory) in the file manager. */
  reveal(jobId: string): Promise<void>
  /** Run the extension diagnostics for the panel's 诊断 drawer. */
  diagnostics(mediaUrl?: string): Promise<ConnectivityReport>
  /** Persist a config patch. */
  setConfig(patch: {
    downloadDir?: string
    filenameTemplate?: string
    maxConcurrent?: number
    proxy?: string
    mp4Only?: boolean
    downloadPath?: 'auto' | 'page' | 'host'
    port?: number
  }): Promise<void>
  /** Open the Host's directory picker and adopt the result. */
  pickDirectory(): Promise<void>
  /** Attach the live event channel; returns a disposer. */
  connect(): () => void
}

/** Turn any thrown value into the store's error shape. */
function toError(error: unknown): { code: string; message: string } {
  if (error instanceof DownloaderApiError) return { code: error.code, message: error.message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/** Merge one job update into the state's job list, newest first. */
export function mergeJob(jobs: readonly JobView[], job: JobView): readonly JobView[] {
  const rest = jobs.filter(candidate => candidate.id !== job.id)
  return [job, ...rest]
}

/**
 * Create the store.
 * @returns the store.
 */
export function createStore(): DownloaderStore {
  // Following is ON from the first moment: the page the user is watching should
  // already be read by the time the window is looked at.
  let snapshot: StoreSnapshot = { open: true, live: false, settingsOpen: false, following: true }
  const listeners = new Set<() => void>()

  /** The page the app can see, if any. Published by the follower. */
  let guestSource: GuestSource | undefined
  /** Jobs whose transfer the user has stopped. */
  const stoppedTransfers = new Set<string>()
  /** Options already handed to the extension after a refusal, so the retry cannot loop. */
  const extensionFallbacks = new Set<string>()
  /** The last page a harvest was run for, as a KEY rather than an address. */
  let lastHarvestKey: string | undefined
  /** The follower's own beat, so an extension event can trigger a read immediately. */
  let beat: (() => void) | undefined

  /** Publish a new snapshot; absent keys are cleared, not skipped. */
  const set = (patch: SnapshotPatch): void => {
    const next: Record<string, unknown> = { ...snapshot }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    snapshot = next as unknown as StoreSnapshot
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A listener that throws must not stop the others.
      }
    }
  }

  /** Run one action, converting a failure into the surfaced error. */
  const guarded = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      set({ error: toError(error) })
    }
  }

  /** The option a click refers to, looked up in the active probe. */
  const optionFor = (input: { readonly formatId: string; readonly entryId?: string | undefined }): VideoOption | undefined => {
    const entries = snapshot.probe?.record.entries ?? []
    const scoped = input.entryId === undefined ? entries : entries.filter(entry => entry.id === input.entryId)
    for (const entry of scoped.length === 0 ? entries : scoped) {
      const found = entry.options.find(option => option.id === input.formatId)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** The facts the carrier decision depends on, from the live config and the page. */
  const carrierInputFor = (option: VideoOption): CarrierInput => {
    const page = guestSource
    return {
      source: 'guest',
      downloadPath: snapshot.state?.config.downloadPath ?? 'auto',
      guestUsable: page !== undefined,
      sameSite: page === undefined || option.directUrl === undefined ? false : sameSite(option.directUrl, page.url),
      // A pair has to be joined by this app, so the extension cannot carry it
      // whatever the setting says: the label, its hover text and the click have
      // to agree.
      needsMux: option.audioUrl !== undefined,
    }
  }

  /** Whether this machine can merge a separated pair, as the Host reported it. */
  const canMerge = (): boolean => snapshot.state?.merge?.available === true

  /** The carrier for one option. */
  const carrierForOption = (option: VideoOption): DownloadCarrier => chooseCarrier(carrierInputFor(option))

  /**
   * Hand one option to the extension after the Host's own fetch was refused.
   *
   * The other half of the `auto` ordering in `carrier.ts`: the Host tries first
   * because it is faster and resumable, and the extension — the client that
   * inherits the browser's clearance — is what a refusal falls back to. Only ever
   * for a job that received NOTHING: a partial file belongs to the carrier that
   * wrote it, and a second transport writing the same name would produce two
   * files and one lie.
   */
  const fallbackToExtension = (job: JobView): void => {
    const page = guestSource
    const option = optionFor({ formatId: job.formatId })
    if (option === undefined) return
    const carrier = chooseCarrier(carrierInputFor(option))
    const key = `${job.url}|${job.formatId}`
    const wanted = shouldFallBackToPage({
      status: job.status,
      receivedBytes: job.receivedBytes,
      stopped: stoppedTransfers.has(job.id),
      carrier,
      pageUsable: page !== undefined,
      alreadyTried: extensionFallbacks.has(key),
      needsMux: option.audioUrl !== undefined,
    })
    if (!wanted || page === undefined) return
    extensionFallbacks.add(key)
    void (async () => {
      await guarded(async () => {
        const answer = await api.startDownload({ url: job.url, formatId: job.formatId, carrier: 'guest' })
        if (answer.conflict !== undefined) return
        const { jobs } = await api.jobs()
        const current = snapshot.state
        if (current !== undefined) set({ state: { ...current, jobs } })
      })
    })()
  }

  /** Scan jobs for one that needs the extension fallback; safe twice. */
  const watchJobs = (jobs: readonly JobView[]): void => {
    for (const job of jobs) fallbackToExtension(job)
  }

  /** Register what a page found, as entries the picker can show. */
  const harvest = async (input: {
    readonly url: string
    readonly title?: string | undefined
    readonly candidates: readonly MediaCandidate[]
    readonly report?: HarvestReport | undefined
  }): Promise<void> => {
    const candidates: GuestCandidate[] = input.candidates.map(candidate => ({
      url: candidate.url,
      ...(candidate.ext === undefined ? {} : { ext: candidate.ext }),
      ...(candidate.height === undefined ? {} : { height: candidate.height }),
      ...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
      ...(candidate.approxBytes === undefined ? {} : { approxBytes: candidate.approxBytes }),
      ...(candidate.audioUrl === undefined ? {} : { audioUrl: candidate.audioUrl }),
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
      label: candidate.label,
    }))
    if (input.report !== undefined) set({ harvest: input.report })
    await guarded(async () => {
      const result = await api.registerGuest({
        url: input.url,
        ...(input.title === undefined ? {} : { title: input.title }),
        candidates,
      })
      set({ probe: { record: result.record } })
    })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot() {
      return snapshot
    },

    async refresh() {
      await guarded(async () => {
        const state = await api.state()
        set({ state, guest: extensionCapabilities(state.extension), error: undefined })
        // The socket may have been down when the refusal happened; a refresh is
        // the other moment a failed job becomes visible, so it gets the same scan.
        watchJobs(state.jobs)
      })
    },

    setOpen(open) { set({ open }) },
    setSettingsOpen(settingsOpen) { set({ settingsOpen }) },
    clearError() { set({ error: undefined }) },
    setAddress(address) { set({ address }) },

    async dropAddress(raw) {
      const text = raw.trim()
      if (text === '') return
      // Replaced, not appended: the user dragged ONE address in, so the box has to
      // show exactly that address.
      set({ address: text, open: true, error: undefined })
      await this.readAddress(text)
    },

    setGuestSource(source) {
      // Identity compared rather than deep-equal: the follower polls every half
      // second, and re-publishing the same page would re-render for nothing.
      if (source === undefined) {
        if (guestSource === undefined) return
        guestSource = undefined
        set({})
        return
      }
      if (guestSource !== undefined && guestSource.tabId === source.tabId && guestSource.url === source.url) return
      guestSource = source
      // The rows on screen belong to an ADDRESS. The follower normally drops them
      // the moment the page moves, but a page change while nothing was looking
      // would otherwise come back as rows for a video nobody is watching.
      const shown = snapshot.probe?.record.url
      if (shown !== undefined && shown !== source.url) set({ probe: undefined, harvest: undefined })
      else set({})
    },

    async harvestCurrentPage(input) {
      const page = guestSource
      if (page === undefined) {
        set({ error: { code: 'guest-unavailable', message: '扩展还没有报告可读取的标签页：先在浏览器里打开视频页，再点「抓当前页」' } })
        return false
      }
      // Marked BEFORE the read, so the follower cannot start a second harvest of
      // the same page while this one is still in it.
      lastHarvestKey = input.key ?? input.url
      set({ harvesting: true, error: undefined, following: true })
      try {
        // What this app can do with a separated pair is decided by whether it has
        // a muxer, and the adapter is told BEFORE it decides to offer one.
        const merge = canMerge()
        // Bounded: the extension's site adapter talks to the site's own API, and an
        // answer that never comes must not leave the button saying 「读取中…」 forever.
        const raw = await answerWithin(harvestInPage(page, merge), HARVEST_CALL_MS)
        if (raw === undefined) {
          throw new Error(`扩展 ${Math.round(HARVEST_CALL_MS / 1000)} 秒没有回应抓取脚本（站点接口可能卡住了）`)
        }
        const parsed = parseHarvest(raw)
        const candidates = pickMediaCandidates(parsed)
        const report = describeHarvest(parsed, candidates, { canMerge: merge })
        // A site adapter read the video's real name; the page's own title is a
        // browser-tab string ("…_哔哩哔哩_bilibili") and it ends up in the file name.
        const title = parsed.site?.title ?? input.title
        if (candidates.length > 0) {
          await harvest({
            url: input.url,
            candidates,
            report,
            ...(title === undefined || title === '' ? {} : { title }),
          })
          return true
        }
        set({ probe: undefined, harvest: report })
        return false
      } catch (error) {
        set({
          probe: undefined,
          harvest: {
            candidates: 0,
            evidence: { videos: 0, sources: 0, og: 0, links: 0, perf: 0, jsonLd: 0 },
            mediaSourceVideos: 0,
            refused: [{ url: '—', why: `读取失败：${error instanceof Error ? error.message : String(error)}` }],
          },
        })
        return false
      } finally {
        set({ harvesting: undefined, opening: undefined })
      }
    },

    async readAddress(raw) {
      const verdict = classifyAddress(raw)
      if (verdict.kind === 'invalid') {
        set({ error: { code: 'bad-address', message: verdict.reason } })
        return
      }
      if (verdict.kind === 'media') {
        // A file URL needs no page: it is registered as a one-row record, and the
        // row's own button is still what starts the download.
        const candidate: GuestCandidate = {
          url: verdict.url,
          label: '手动地址',
          ...(verdict.ext === undefined ? {} : { ext: verdict.ext }),
          ...(verdict.height === undefined ? {} : { height: verdict.height }),
          ...(verdict.title === undefined ? {} : { title: verdict.title }),
        }
        set({ harvesting: true, error: undefined })
        try {
          await guarded(async () => {
            const result = await api.registerGuest({
              url: verdict.url,
              candidates: [candidate],
              ...(verdict.title === undefined ? {} : { title: verdict.title }),
            })
            set({ probe: { record: result.record }, harvest: undefined })
          })
        } finally {
          set({ harvesting: undefined })
        }
        return
      }
      // A page address: open it in the browser, and let the follower read it once
      // it settles. The page is where the site's own session lives, and a site
      // adapter inside the extension is what makes sites with no whole file on the
      // page (bilibili) downloadable at all.
      lastHarvestKey = undefined
      set({ following: true, opening: verdict.url, error: undefined, probe: undefined, harvest: undefined })
      try {
        await openPage(verdict.url)
      } catch (error) {
        set({ error: toError(error), opening: undefined })
      }
    },

    async pageSettled(input) {
      const currentUrl = snapshot.probe?.record.url
      if (currentUrl !== undefined && currentUrl !== input.url) {
        // Stale rows are worse than none: they name files the user is no longer
        // looking at, and downloading one would be a surprise.
        set({ probe: undefined, harvest: undefined })
      }
      if (snapshot.opening !== undefined) set({ opening: undefined })
      if (snapshot.following !== true) return true
      if (lastHarvestKey === (input.key ?? input.url)) return true
      return await this.harvestCurrentPage(input)
    },

    setFollowing(following) { set({ following }) },

    watchGuestPage() {
      const follower = startGuestFollower({
        following: () => snapshot.following === true,
        page: () => {
          const state = snapshot.state?.extension
          if (state === undefined || !state.connected || state.tab === undefined) return undefined
          const guest = extensionGuest(state)
          if (guest === undefined) return undefined
          const tab = state.tab
          return {
            guest,
            url: tab.url,
            ...(tab.title === undefined || tab.title === '' ? {} : { title: tab.title }),
            ...(tab.media === undefined ? {} : { media: tab.media }),
          }
        },
        publish: (source) => { this.setGuestSource(source) },
        settled: async (input) => await this.pageSettled(input),
      })
      beat = follower.beat
      return follower.stop
    },

    async startDownload(input) {
      let answer: StartDownloadResult | undefined
      await guarded(async () => {
        const option = optionFor(input)
        const carrier = option === undefined ? undefined : carrierForOption(option)
        answer = await api.startDownload({
          url: input.url,
          formatId: input.formatId,
          ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
          ...(input.onConflict === undefined ? {} : { onConflict: input.onConflict }),
          ...(carrier === 'guest' ? { carrier: 'guest' as const } : {}),
        })
        // The engine publishes the first job frame, but reading the list once makes
        // the row appear immediately even if the socket is degraded.
        if (answer?.conflict !== undefined) return
        const { jobs } = await api.jobs()
        const current = snapshot.state
        if (current !== undefined) set({ state: { ...current, jobs } })
      })
      return answer
    },

    async retry(jobId) {
      await guarded(async () => {
        const answer = await api.retryDownload(jobId)
        // A conflict is a question, not a start: nothing new exists to refresh
        // for, and the row keeps showing the failure until the file is answered.
        if (answer.conflict !== undefined) return
        const { jobs } = await api.jobs()
        const current = snapshot.state
        if (current !== undefined) set({ state: { ...current, jobs } })
      })
    },

    carrierAdvice(option) {
      if (snapshot.probe === undefined) return undefined
      const input = carrierInputFor(option)
      const carrier = chooseCarrier(input)
      return { carrier, label: carrierLabel(carrier, input.needsMux === true), hint: carrierHint(carrier, input) }
    },

    cancel(jobId) {
      stoppedTransfers.add(jobId)
      void guarded(async () => { await api.cancelDownload(jobId) })
    },

    async reveal(jobId) {
      await guarded(async () => {
        await api.revealDownload(jobId)
      })
    },

    async diagnostics(mediaUrl) {
      return await checkExtension({
        state: snapshot.state?.extension,
        ...(mediaUrl === undefined ? {} : { mediaUrl }),
        probeUpload: async () => {
          try {
            const response = await fetch('/video-downloader/upload?token=probe&offset=0', {
              method: 'POST',
              headers: { 'content-type': 'text/plain' },
              body: '',
            })
            const parsed = await response.json().catch(() => null) as { error?: { code?: string } } | null
            return parsed?.error?.code === 'unknown-token'
          } catch {
            return undefined
          }
        },
      })
    },

    async setConfig(patch) {
      await guarded(async () => {
        const { config } = await api.setConfig(patch)
        const current = snapshot.state
        if (current !== undefined) set({ state: { ...current, config } })
      })
    },

    async pickDirectory() {
      await guarded(async () => {
        const result = await api.pickDirectory()
        if (result.cancelled) return
        const current = snapshot.state
        if (current !== undefined) set({ state: { ...current, config: result.config } })
      })
    },

    connect() {
      let socket: WebSocket | undefined
      let retry: number | undefined
      let closed = false
      let attempts = 0

      const open = (): void => {
        if (closed) return
        const url = new URL(EVENTS_PATH, window.location.origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        let live: WebSocket
        try {
          live = new WebSocket(url.toString())
        } catch {
          return
        }
        socket = live
        live.onopen = () => {
          attempts = 0
          set({ live: true })
          // A reconnect means the extension may have changed tabs meanwhile.
          void this.refresh()
        }
        live.onmessage = (event) => {
          if (typeof event.data !== 'string') return
          let parsed: unknown
          try {
            parsed = JSON.parse(event.data)
          } catch {
            return
          }
          if (parsed === null || typeof parsed !== 'object') return
          const frame = parsed as { type?: unknown; job?: unknown; ext?: unknown }
          if (frame.type === 'job' && frame.job !== undefined) {
            const current = snapshot.state
            const job = frame.job as JobView
            if (current !== undefined) {
              set({ state: { ...current, jobs: mergeJob(current.jobs, job) } })
            }
            watchJobs([job])
            return
          }
          if (frame.type === 'ext' && frame.ext !== undefined) {
            const current = snapshot.state
            const ext = frame.ext as DownloaderState['extension']
            if (current !== undefined) set({ state: { ...current, extension: ext }, guest: extensionCapabilities(ext) })
            // Tell the follower to look now rather than waiting for its next beat:
            // a tab switch is the one event whose whole point is being noticed.
            beat?.()
          }
        }
        live.onclose = () => {
          if (socket === live) socket = undefined
          set({ live: false })
          if (closed) return
          attempts += 1
          const delay = Math.min(15_000, 1_000 * attempts)
          retry = window.setTimeout(open, delay)
        }
        live.onerror = () => { live.close() }
      }

      open()
      return () => {
        closed = true
        if (retry !== undefined) window.clearTimeout(retry)
        socket?.close()
        set({ live: false })
      }
    },
  }
}

/** Re-exported so callers can branch on the wire code without importing the api. */
export { DownloaderApiError }
export type { DownloaderConfig, JobView }
