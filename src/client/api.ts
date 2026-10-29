/**
 * Typed `fetch` wrapper over the Host's `/video-downloader/api/*` routes.
 *
 * The prefix is MIRRORED as a literal rather than imported: the renderer is one
 * self-contained browser bundle and the shared constants it would import are
 * host-owned. `test/wire.test.mjs` keeps the literal in sync with
 * `src/shared/wire.ts`.
 *
 * Every call posts a JSON body and unwraps the `{ ok, value }` / `{ ok, error }`
 * envelope; a transport failure, a non-JSON body, or a `{ ok: false }` envelope
 * all surface as {@link DownloaderApiError} carrying the wire code.
 */
import type {
  ApiEnvelope,
  ConfigResult,
  DownloaderState,
  ExtensionState,
  GuestCandidate,
  JobView,
  PickDirectoryResult,
  ProbeResult,
  StartDownloadResult,
} from './api-types.js'

/** URL prefix of every JSON route the Host registers. Mirrors `shared/wire.ts`. */
export const API_PREFIX = '/video-downloader'

/** URL path of the live event channel. Mirrors `shared/wire.ts`. */
export const EVENTS_PATH = `${API_PREFIX}/ws/events`

/** URL path of the raw byte route. Mirrors `shared/wire.ts`. */
export const UPLOAD_PATH = `${API_PREFIX}/upload`

/** One wire failure carrying the Host's stable code. */
export class DownloaderApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DownloaderApiError'
  }
}

/**
 * Call one Host route.
 * @param method - wire method name, e.g. `state`.
 * @param payload - JSON body; omitted serializes to `{}`.
 * @param signal - optional cancellation.
 * @returns the unwrapped value.
 * @throws {DownloaderApiError} on any transport or envelope failure.
 */
export async function call<T>(
  method: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw new DownloaderApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed = await response.json().catch(() => null) as ApiEnvelope<T> | null
  if (parsed === null || parsed.ok !== true) {
    const failure = parsed === null ? undefined : parsed.error
    throw new DownloaderApiError(failure?.code ?? 'http', failure?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value
}

/** The typed route table. */
export const api = {
  /** Read the whole panel state. */
  state: (signal?: AbortSignal) => call<DownloaderState>('state', {}, signal),

  /** Persist configuration changes. */
  setConfig: (patch: {
    downloadDir?: string
    filenameTemplate?: string
    maxConcurrent?: number
    proxy?: string
    mp4Only?: boolean
    downloadPath?: 'auto' | 'page' | 'host'
    port?: number
  }) => call<ConfigResult>('config.set', { ...patch }),

  /** Open the Host's directory picker and adopt the result. */
  pickDirectory: () => call<PickDirectoryResult>('config.pickDirectory'),

  /**
   * Register media URLs found INSIDE the browser's page.
   *
   * The Host turns them into rows under the media policy, and answers with the
   * whole record. This is the only way a download is set up: the page the user
   * has open is the one client that inherits the clearance it passed.
   */
  registerGuest: (input: { url: string; title?: string; candidates: readonly GuestCandidate[] }) =>
    call<ProbeResult>('probe.registerGuest', {
      url: input.url,
      ...(input.title === undefined ? {} : { title: input.title }),
      candidates: [...input.candidates],
    }),

  /** Start downloading one probed option. */
  startDownload: (input: {
    url: string
    formatId: string
    entryId?: string
    onConflict?: 'overwrite' | 'keep'
    carrier?: 'guest'
  }) =>
    call<StartDownloadResult>('download.start', {
      url: input.url,
      formatId: input.formatId,
      ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
      ...(input.onConflict === undefined ? {} : { onConflict: input.onConflict }),
      ...(input.carrier === undefined ? {} : { carrier: input.carrier }),
    }),

  /** Cancel one job. */
  cancelDownload: (jobId: string) => call<{ cancelled: true }>('download.cancel', { jobId }),

  /**
   * Retry one FAILED download.
   *
   * The Host runs the new attempt on the other carrier than the one that failed,
   * and answers with a new job id: the failed row stays in the list as evidence
   * of what went wrong, and the new row is the attempt the user can watch.
   */
  retryDownload: (jobId: string) => call<StartDownloadResult>('download.retry', { jobId }),

  /** Ask the desktop to show one job's file (or the download directory). */
  revealDownload: (jobId: string) => call<{ path: string }>('download.reveal', { jobId }),

  /** List recent jobs. */
  jobs: (signal?: AbortSignal) => call<{ jobs: readonly JobView[] }>('jobs.list', {}, signal),

  /** The browser extension's connection state. */
  extStatus: () => call<ExtensionState>('ext.status'),

  /**
   * Ask the extension to harvest the tab it is watching.
   *
   * The answer is the extension's raw harvest (the same shape the plugin's
   * in-page script produced); the renderer decides what it means.
   */
  extHarvest: (input: { tabId?: number; canMerge: boolean }) =>
    call<unknown>('ext.harvest', {
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      canMerge: input.canMerge,
    }),

  /** Ask the browser to open a page and keep watching it. */
  extOpen: (url: string) => call<{ tabId: number }>('ext.open', { url }),

  /** Ask the extension whether it can read one media URL (diagnostics only). */
  extProbeMedia: (url: string) =>
    call<{ readable: boolean; status?: number; reason?: string }>('ext.probeMedia', { url }),
}
