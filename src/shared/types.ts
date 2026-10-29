/**
 * Wire types for the config / download surface, shared by both halves.
 *
 * TYPES ONLY — erased at build time, so the Client half may `import type` this
 * without creating a relative runtime import (a client bundle is one
 * self-contained module node and cannot require a sibling).
 */

/** Lifecycle of one download job. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

/** A video-only stream is paired with the best audio stream automatically. */
export type StreamKind = 'muxed' | 'video-only'

/**
 * Where one option came from, which sets how it is downloaded.
 *
 * `guest` is an option discovered INSIDE the browser extension's page (by the
 * injected harvester): the app never fetched it and usually cannot — it exists
 * only for the client that already passed the site's checks. The two older
 * values, `ytdlp` and `html`, went with the in-app probe and the yt-dlp
 * carrier: the page is now the only producer of options.
 */
export type ProbeSource = 'ytdlp' | 'html' | 'guest'

/** One selectable video/quality option discovered on a page. */
export interface VideoOption {
  /** Stable id within one harvest: minted by the harvest that found the option. */
  readonly id: string
  /** Site-reported title (or the media URL's own file name). */
  readonly title: string
  /** Container extension, e.g. `mp4`, `webm`. */
  readonly ext: string
  /**
   * The media file's own absolute URL, when the page captured one.
   *
   * This is what the carriers fetch — the app over HTTP, or the page that found
   * it. A manifest (`.m3u8`) is a list of segments rather than a file, and is
   * refused by both carriers instead of being saved under a media extension.
   */
  readonly directUrl?: string
  /**
   * The audio track's URL, when this quality is served as two separate files.
   *
   * Sites that keep their high qualities behind a login often serve one video
   * track and one audio track instead of a single muxed file. The option then
   * carries the video URL in `directUrl` and the audio URL here, and the Host
   * downloads both and merges them into one mp4 with ffmpeg. An option without
   * this field is a single file, downloaded exactly as it always was.
   */
  readonly audioUrl?: string
  /** Vertical resolution in pixels, when the source reported one. */
  readonly height?: number
  /** Frames per second, when reported. */
  readonly fps?: number
  /** Video codec name, when reported. */
  readonly vcodec?: string
  /** Audio codec name, when reported. */
  readonly acodec?: string
  /** Byte size when exactly known. */
  readonly bytes?: number
  /** Byte size when only estimated. */
  readonly approxBytes?: number
  /** Bitrate in kbit/s, when reported. */
  readonly tbr?: number
  /** Duration in seconds, when reported. */
  readonly durationSeconds?: number
  /** Whether this option already carries audio. */
  readonly kind: StreamKind
  /** Which engine produced this option. */
  readonly source: ProbeSource
}

/** One entry of a playlist or multi-video page. */
export interface VideoEntry {
  /** Stable id within one probe. */
  readonly id: string
  /** Entry title. */
  readonly title: string
  /** Entry page URL. */
  readonly url: string
  /** Selectable qualities for this entry. */
  readonly options: readonly VideoOption[]
  /** Duration in seconds, when reported. */
  readonly durationSeconds?: number
  /** Set when this entry could not be enumerated. */
  readonly error?: string
}

/**
 * One media URL the browser extension's page found, as the client reports it.
 *
 * The app never fetched this URL and usually cannot: it was discovered inside a
 * page that already passed the site's own checks. `ext` is the client's best
 * guess (from the URL, the `<source type>`, or the tag that carried it) and is
 * only used to name the file — what the bytes actually are is decided when the
 * page fetches them, and a mismatch is reported rather than papered over.
 */
export interface GuestCandidate {
  /** The absolute media URL the page found. */
  readonly url: string
  /** Container extension guess, without a dot (`mp4`, `webm`, `m3u8`, `ts`). */
  readonly ext?: string
  /** Vertical resolution, when the element that carried the URL knew it. */
  readonly height?: number
  /** Byte size, when the page could read `content-length`. */
  readonly bytes?: number
  /**
   * Byte size when the page could only estimate it.
   *
   * A separated pair has no length yet — it does not exist until the merge — so
   * the adapter reports `(video bitrate + audio bitrate) / 8 * duration` instead
   * of a number it never saw. Shown as an approximation, never used as a total.
   */
  readonly approxBytes?: number
  /**
   * The audio track's URL, when this candidate is a video track that needs one.
   *
   * Set only by a site adapter, and only for a separated pair. A candidate with
   * an `audioUrl` cannot be downloaded by the page carrier: the page would save
   * the video track alone, which is a silent film rather than the video the user
   * asked for.
   */
  readonly audioUrl?: string
  /**
   * The name this file should be saved as, when the page knows better than the URL.
   *
   * Only the site adapters set one. bilibili serves `…/42352905122-1-192.mp4`, whose
   * stem is a content id, and a two-part video would otherwise give both parts one
   * name — that is, one file and one conflict question for two different downloads.
   */
  readonly title?: string
  /** Where it was found, shown as the row's title (`<video>`, og:video, …). */
  readonly label?: string
}

/** The persisted configuration document. */
export interface DownloaderConfig {
  /** Schema revision; migrated on read. */
  readonly schema: number
  /** Absolute download directory. */
  readonly downloadDir: string
  /**
   * Output name template, expanded by the app (see `download.ts`).
   *
   * `%(title)s` (the entry's title — for a page harvest, the media URL's own file
   * name) and `%(ext)s` (the container) are the two placeholders this app can
   * expand. A template naming anything else cannot be resolved to a path, so the
   * conflict question is skipped and the name falls back to `title.ext`.
   */
  readonly filenameTemplate: string
  /** Maximum simultaneous downloads. */
  readonly maxConcurrent: number
  /**
   * App-side proxy for the program's own HTTP requests.
   *
   * Empty means "decide automatically" (environment, then the Windows system
   * proxy); `off` forces a direct connection; anything else is an
   * `http://host:port` proxy. This exists because Node's `fetch` ignores the
   * system proxy that the app's own browser uses, which made a reachable page
   * look unreachable.
   */
  readonly proxy: string
  /**
   * Offer only formats that end up as a playable mp4, one row per resolution.
   *
   * On by default because "what did I just download" should have one answer the
   * user can open: an `.ogg`, an audio-less `video-only` stream, or a manifest that
   * is not a file at all are all real outcomes of the picker otherwise. Turning it
   * off restores the full format list.
   */
  readonly mp4Only: boolean
  /**
   * Which client fetches the bytes.
   *
   * `auto` sends options found inside the browser's page (source `guest`) to the
   * extension, and leaves every other option on the carrier it always used.
   * `page` prefers the extension whenever the panel can see a page on the same
   * site, and `host` never uses it. Only the client can see the browser page, so
   * the choice is made there — this field is the user's standing preference.
   */
  readonly downloadPath: 'auto' | 'page' | 'host'
  /**
   * Loopback port the local HTTP/WebSocket server tries first.
   *
   * 1–65_535; the server walks up to {@link PORT_RANGE} ports from here when it
   * is busy, and the extension probes the same range.
   */
  readonly port: number
}

/**
 * A file that is already sitting where a download would land.
 *
 * This is a QUESTION, not an error: the app refuses to start the job and hands
 * the panel enough to describe both sides, and the user answers with
 * `onConflict`. Nothing is written, renamed or deleted before that answer.
 */
export interface DownloadConflict {
  /** Absolute path the incoming download would write. */
  readonly path: string
  /** Bytes of the file that is already there. */
  readonly existingBytes: number
  /** Last-modified time of that file, epoch ms. */
  readonly existingModifiedAt?: number
  /** Title of the job that produced it, when this app still remembers that job. */
  readonly existingTitle?: string
  /** URL that produced it — different from the incoming one means a name clash between two videos. */
  readonly existingUrl?: string
  /** The incoming option's height, when the probe reported one. */
  readonly incomingHeight?: number
  /** The existing file's height, when this app can still tell (in-memory history only). */
  readonly existingHeight?: number
}

/** One download job, as the UI sees it. */
export interface JobView {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly formatId: string
  readonly source: ProbeSource
  /**
   * Which side carried this job's bytes: the app itself (`direct`) or the browser
   * extension (`guest`). A retry runs on the other one.
   */
  readonly carrier: 'guest' | 'direct'
  readonly status: JobStatus
  /** Bytes written so far. */
  readonly receivedBytes: number
  /** Total bytes when known. */
  readonly totalBytes?: number
  /** Bytes per second, sampled by the app. */
  readonly speedBytesPerSecond?: number
  /** Absolute path of the finished file. */
  readonly outputPath?: string
  /** Failure reason when `status === 'failed'`. */
  readonly error?: string
  /** Wall-clock start of the running phase, epoch ms. */
  readonly startedAt?: number
  /** Wall-clock end of the terminal phase, epoch ms. */
  readonly finishedAt?: number
}
