/**
 * Client API types.
 *
 * MIRRORED from the Host's wire types rather than imported: a client bundle is a
 * single self-contained module node and cannot `require` a relative sibling, so
 * `import type` is the only safe form and every runtime value has to be repeated
 * here. `test/wire-source.mjs` keeps the two string constants in sync.
 */
import type { GuestCandidate, VideoEntry, VideoOption } from '../shared/types.js'
import type { ExtensionState, ExtensionTab } from '../shared/extension.js'

export type { GuestCandidate, VideoEntry, VideoOption, ExtensionState, ExtensionTab }

/**
 * Where one probe option came from, mirrored from `shared/types.ts`.
 *
 * `guest` is an option found INSIDE the browser extension's page: the app never
 * fetched it, so it is downloaded by that page instead.
 */
export type ProbeSource = 'ytdlp' | 'html' | 'guest'

/** One wire failure: a stable code plus a human message. */
export interface ApiError {
  readonly code: string
  readonly message: string
}

/** The envelope every route answers with. */
export type ApiEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError }

/** The persisted configuration. */
export interface DownloaderConfig {
  readonly schema: number
  readonly downloadDir: string
  /**
   * Output name template, expanded by the Host.
   *
   * `%(title)s` and `%(ext)s` are the two placeholders it can expand; a template
   * naming anything else cannot be resolved to a path, and the name falls back to
   * `title.ext`.
   */
  readonly filenameTemplate: string
  readonly maxConcurrent: number
  /** `''` decides automatically, `off` forces direct, else an `http://host:port`. */
  readonly proxy: string
  /** Offer only formats that end up as a playable mp4, one row per resolution. */
  readonly mp4Only: boolean
  /**
   * Which client fetches the bytes: `auto` sends page-sourced options to the
   * extension, `page` also offers the extension a same-site option, `host` never
   * does.
   */
  readonly downloadPath: 'auto' | 'page' | 'host'
  /** Loopback port the Host listens on; the extension was told the same number. */
  readonly port: number
}

/**
 * Where the Host's own HTTP requests actually go.
 *
 * Mirrored from the Host, and shown in the panel: when a page opens in the
 * browser but not here, this line is the difference between "the app is
 * broken" and "these requests are not using your proxy".
 */
export interface NetworkStatus {
  /** Whether a proxy is in force. */
  readonly proxied: boolean
  /** The proxy URL, when one is in force. */
  readonly proxy?: string
  /** `config`, `env`, `system`, or `none`. */
  readonly source: 'config' | 'env' | 'system' | 'none'
  /** Why this decision was made, or why no proxy is used. */
  readonly reason?: string
}

/** Lifecycle of one download job; `skipped` means the existing file was kept. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

/**
 * A file already sitting where a download would land, mirrored from
 * `shared/types.ts` (a client bundle cannot import a host module).
 *
 * The Host starts nothing while one of these is unanswered, so the panel owns
 * the question — and the two answers are `overwrite` and `keep`, nothing else.
 */
export interface DownloadConflict {
  readonly path: string
  readonly existingBytes: number
  readonly existingModifiedAt?: number
  readonly existingTitle?: string
  readonly existingUrl?: string
  readonly incomingHeight?: number
  readonly existingHeight?: number
}

/** The `download.start` response: a job, or the question that has to come first. */
export interface StartDownloadResult {
  readonly jobId?: string
  readonly conflict?: DownloadConflict
  /**
   * The token the page must push its bytes with, when the job runs on the page.
   *
   * Only present when the client asked for `carrier: 'guest'` — and only the
   * client can, because only the client can see the extension's tab.
   */
  readonly guestToken?: string
}

/** One download job. */
export interface JobView {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly formatId: string
  readonly source: ProbeSource
  /**
   * Which side carried this job's bytes: the app itself (`direct`) or the browser
   * extension (`guest`).
   *
   * The panel needs it to say WHICH channel failed, and the retry action needs it
   * to pick the other one — a failure that one carrier can see through (a reset
   * connection, a cookie-gated CDN) is often invisible to the other.
   */
  readonly carrier: 'guest' | 'direct'
  readonly status: JobStatus
  readonly receivedBytes: number
  readonly totalBytes?: number
  readonly speedBytesPerSecond?: number
  readonly outputPath?: string
  readonly error?: string
  readonly startedAt?: number
  readonly finishedAt?: number
}

/** A probed page. */
export interface ProbeRecord {
  readonly url: string
  readonly source: ProbeSource
  readonly pageTitle?: string
  readonly entries: readonly VideoEntry[]
  readonly notes: readonly string[]
  /**
   * What the media policy withheld or folded, when it did anything at all.
   *
   * Optional on purpose: absent means "this is exactly what the site offers", and
   * the picker then shows no policy line. Present means the list is shorter than
   * the site's own, which the panel has to say out loud.
   */
  readonly policy?: {
    readonly mp4Only: boolean
    readonly hidden: number
    readonly merged: number
  }
}

/** What this machine can merge separated tracks with, as the Host reports it. */
export interface MuxerStatus {
  /** Whether a usable ffmpeg was found. */
  readonly available: boolean
  /** Its absolute path, when one was found. */
  readonly path?: string
  /** The first line of `ffmpeg -version`. */
  readonly version?: string
  /** Why there is none, in the Host's own words. */
  readonly reason?: string
}

/** The whole panel state. */
export interface DownloaderState {
  readonly version: string
  readonly config: DownloaderConfig
  readonly configPath: string
  readonly network: NetworkStatus
  readonly jobs: readonly JobView[]
  readonly notices: readonly string[]
  /**
   * Whether a separated 视频轨 + 音轨 pair can be downloaded here at all.
   *
   * The panel does not decide this and must not guess it: the page adapter is told the same
   * fact before it offers a pair, so a row on screen and this answer always agree.
   */
  readonly merge: MuxerStatus
  /** The browser extension's connection, as the panel renders it. */
  readonly extension: ExtensionState
}

/** The probe response. */
export interface ProbeResult {
  readonly record: ProbeRecord
}

/** The `config.set` response. */
export interface ConfigResult {
  readonly config: DownloaderConfig
}

/** The `config.pickDirectory` response. */
export type PickDirectoryResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly config: DownloaderConfig }

/** One server-pushed event. */
export type ServerEvent =
  | { readonly type: 'hello'; readonly sessionId: string; readonly connectionId: string }
  | { readonly type: 'job'; readonly job: JobView }
  | { readonly type: 'ext'; readonly ext: ExtensionState }
