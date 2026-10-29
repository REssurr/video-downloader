/**
 * The Host JSON API: `POST /video-downloader/api/<method>`.
 *
 * One dispatcher over injected services, so the whole wire surface is testable
 * without a web server or a real download. The HTTP route in `host/server.ts`
 * only parses the method name and writes back the envelope this returns.
 *
 * Every failure travels as `{ ok: false, error: { code, message } }` with a
 * stable code, because the client routes on the code and shows the message.
 */
import { API_PREFIX } from './shared/wire.js'
import type { MuxerStatus } from './mux.js'
import type { NetworkStatus } from './net/proxy.js'
import type { ApiEnvelope, PingValue } from './shared/api-types.js'
import type { ExtensionState } from './shared/extension.js'
import type { DownloadConflict, DownloaderConfig, JobView, ProbeSource, VideoEntry } from './shared/types.js'

/** A wire failure with a stable code. */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiFailure'
  }
}

/** A probed page as the client receives it. */
export interface ProbeRecord {
  /** The URL that was probed. */
  readonly url: string
  /** Which engine produced the entries. */
  readonly source: ProbeSource
  /** Page title, when known. */
  readonly pageTitle?: string
  /** Every video found on the page. */
  readonly entries: readonly VideoEntry[]
  /** Human notes: fallbacks taken, entries skipped, manifests unreadable. */
  readonly notes: readonly string[]
  /**
   * What the media policy did to this probe, so the panel can say it out loud.
   *
   * Reported rather than left to be inferred from `notes`: a list that is shorter
   * than the site's own format list must look deliberate.
   */
  readonly policy?: {
    readonly mp4Only: boolean
    /** Rows withheld: non-mp4, or unplayable without a merge. */
    readonly hidden: number
    /** Same-resolution rows folded into the one that was kept. */
    readonly merged: number
  }
}

/** The whole panel state in one object. */
export interface DownloaderState {
  /** App version. */
  readonly version: string
  /** The live configuration. */
  readonly config: DownloaderConfig
  /** Where the config file lives, for the settings page. */
  readonly configPath: string
  /** The proxy decision in force for this app's own HTTP requests. */
  readonly network: NetworkStatus
  /** Recent jobs, newest first. */
  readonly jobs: readonly JobView[]
  /** Configuration repairs and load problems worth showing. */
  readonly notices: readonly string[]
  /** Whether this machine can merge a separated 视频轨 + 音轨 pair. */
  readonly merge: MuxerStatus
  /** The browser extension's connection, as the panel renders it. */
  readonly extension: ExtensionState
  /** What the Host actually managed to wire up. */
  readonly health: DownloaderHealth
}

/** The wiring facts the diagnostics view shows. */
export interface DownloaderHealth {
  /** Whether the JSON API route is serving. */
  readonly api: boolean
  /** Whether the event socket registered. */
  readonly eventSocket: boolean
  /** Whether a live socket has ever been accepted. */
  readonly socketAccepted: boolean
  /** Why the event socket is unavailable, when it is. */
  readonly eventSocketReason?: string
  /** The carrier's own method surface, for a missing-method diagnosis. */
  readonly eventSocketDetail?: string
}

/** What the Host provides to the dispatcher. */
export interface DownloaderServices {
  /** The app version. */
  readonly version: string
  /** The current configuration (already validated). */
  readonly config: () => DownloaderConfig
  /** The configuration file path, for display. */
  readonly configPath: string
  /** Configuration repairs from the last load. */
  readonly notices: () => readonly string[]
  /** Replace and persist the configuration. */
  readonly setConfig: (next: DownloaderConfig) => Promise<void>
  /** Where this app's own requests go, and why. */
  readonly network: () => Promise<NetworkStatus>
  /** Forget the cached OS proxy read, after the setting changes. */
  readonly invalidateNetwork: () => void
  /** What this machine can merge separated tracks with. */
  readonly merge: () => Promise<MuxerStatus>
  /** Forget every cached probe. */
  readonly invalidateProbes: () => void
  /** The browser extension's connection state. */
  readonly extension: () => ExtensionState
  /**
   * Ask the extension to harvest the page it is watching.
   *
   * The extension does the DOM work and (for a site with an adapter) asks that
   * site's own API; the Host only decides what the answer means. `canMerge` is
   * sent along so an adapter that offers a video+audio pair only does so when
   * this machine can join it.
   */
  readonly harvest: (input: { readonly tabId?: number; readonly canMerge: boolean }) => Promise<unknown>
  /** Ask the extension to open a page in the browser and keep watching it. */
  readonly openInBrowser: (url: string) => Promise<{ readonly tabId: number }>
  /** Ask the extension whether it can read one media URL (diagnostics only). */
  readonly probeMedia: (url: string) => Promise<{ readonly readable: boolean; readonly status?: number; readonly reason?: string }>
  /** Open the shell's native directory picker; `null` when the user cancelled. */
  readonly pickDirectory: () => Promise<string | null>
  /** Register media URLs that were found INSIDE the browser's page. */
  readonly registerGuest: (input: {
    readonly url: string
    readonly title?: string
    readonly candidates: unknown
  }) => Promise<{ readonly record: ProbeRecord }>
  /** Start a download for one probed option. */
  readonly startDownload: (input: {
    readonly url: string
    readonly formatId: string
    readonly entryId?: string
    readonly onConflict?: 'overwrite' | 'keep'
    readonly carrier?: 'guest'
  }) => Promise<{ readonly jobId?: string; readonly conflict?: DownloadConflict; readonly guestToken?: string }>
  /**
   * Restart one FAILED download, on the carrier it did not use last time.
   *
   * A new job is created rather than the old record being revived, so the list
   * keeps the evidence of the first failure next to the second attempt. Only a
   * `failed` job is eligible: a cancel is the user's own decision and a finished
   * file does not need downloading twice.
   */
  readonly retryDownload: (jobId: string) => Promise<{ readonly jobId?: string; readonly conflict?: DownloadConflict; readonly guestToken?: string }>
  /** Cancel one job. */
  readonly cancelJob: (jobId: string) => void
  /** Show one job's file (or the download directory) in the file manager. */
  readonly revealDownload: (jobId: string) => Promise<{ readonly path: string }>
  /** Recent jobs, newest first. */
  readonly jobs: () => readonly JobView[]
  /** What the Host actually wired up. */
  readonly health: () => DownloaderHealth
}

/** The wire method table. */
export interface Dispatcher {
  /**
   * Resolve one wire method.
   * @param method - the path segment after `api/`.
   * @param payload - the parsed JSON body.
   * @returns the envelope to write.
   */
  dispatch(method: string, payload: Record<string, unknown>): Promise<ApiEnvelope<unknown>>
}

/** Read a required non-empty string field from an untrusted payload. */
export function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiFailure('bad-request', `缺少字段 ${field}`)
  }
  return value.trim()
}

/** Read an optional string field. */
function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Validate a URL the client asked to probe.
 *
 * Only `http(s)` is accepted: a `file:` or `javascript:` target is not a web
 * page, and passing one to the engine would make the Host fetch something the
 * user never meant.
 * @param raw - the raw URL.
 * @returns the normalized URL.
 * @throws {ApiFailure} when the URL is unusable.
 */
export function requireHttpUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new ApiFailure('bad-request', '请输入网址')
  if (trimmed.length > 16_384) throw new ApiFailure('bad-request', '网址过长')
  const withScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new ApiFailure('bad-request', '这不是一个合法网址')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ApiFailure('bad-request', '网址里不能包含用户名或密码')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiFailure('bad-request', '只支持 http/https 网址')
  }
  return parsed.href
}

/**
 * The hostname of a URL, or `''` when it cannot be parsed.
 * @param url - the URL.
 * @returns the lower-cased hostname.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Build the dispatcher over the Host services.
 * @param services - the Host's implementation.
 * @returns the dispatcher.
 */
export function createDispatcher(services: DownloaderServices): Dispatcher {
  /**
   * Read the config, apply a mutation, persist, and answer with the new config.
   * @param mutate - a pure transform returning the next config.
   */
  const mutateConfig = async (mutate: (current: DownloaderConfig) => DownloaderConfig): Promise<DownloaderConfig> => {
    const next = mutate(services.config())
    await services.setConfig(next)
    return next
  }

  return {
    async dispatch(method, payload) {
      try {
        switch (method) {
          case 'ping':
            return {
              ok: true,
              value: { pong: true, version: services.version, apiPrefix: API_PREFIX } satisfies PingValue,
            }

          case 'state':
            return {
              ok: true,
              value: {
                version: services.version,
                config: services.config(),
                configPath: services.configPath,
                network: await services.network(),
                jobs: services.jobs(),
                notices: services.notices(),
                merge: await services.merge(),
                extension: services.extension(),
                health: services.health(),
              } satisfies DownloaderState,
            }

          case 'config.set': {
            const downloadDir = optionalString(payload, 'downloadDir')
            const filenameTemplate = optionalString(payload, 'filenameTemplate')
            const proxy = optionalString(payload, 'proxy')
            const maxConcurrent = payload['maxConcurrent']
            const mp4Only = payload['mp4Only']
            const port = payload['port']
            const before = services.config().mp4Only
            const config = await mutateConfig(current => ({
              ...current,
              ...(downloadDir === undefined ? {} : { downloadDir }),
              ...(filenameTemplate === undefined ? {} : { filenameTemplate }),
              ...(proxy === undefined ? {} : { proxy: proxy.trim() }),
              ...(typeof maxConcurrent === 'number' && Number.isFinite(maxConcurrent)
                ? { maxConcurrent: Math.min(4, Math.max(1, Math.round(maxConcurrent))) }
                : {}),
              ...(typeof port === 'number' && Number.isFinite(port)
                ? { port: Math.min(65_535, Math.max(1024, Math.round(port))) }
                : {}),
              ...(typeof mp4Only === 'boolean' ? { mp4Only } : {}),
            }))
            services.invalidateNetwork()
            if (config.mp4Only !== before) services.invalidateProbes()
            return { ok: true, value: { config } }
          }

          case 'config.pickDirectory': {
            const picked = await services.pickDirectory()
            if (picked === null) return { ok: true, value: { cancelled: true } }
            const config = await mutateConfig(current => ({ ...current, downloadDir: picked }))
            return { ok: true, value: { cancelled: false, config } }
          }

          case 'probe.registerGuest': {
            const url = requireHttpUrl(requireString(payload, 'url'))
            const title = optionalString(payload, 'title')
            const registered = await services.registerGuest({
              url,
              ...(title === undefined ? {} : { title }),
              candidates: payload['candidates'],
            })
            return { ok: true, value: registered }
          }

          case 'ext.status':
            return { ok: true, value: services.extension() }

          case 'ext.harvest': {
            const tabId = payload['tabId']
            const canMerge = payload['canMerge']
            const value = await services.harvest({
              ...(typeof tabId === 'number' ? { tabId } : {}),
              canMerge: canMerge === true,
            })
            return { ok: true, value }
          }

          case 'ext.open': {
            const url = requireHttpUrl(requireString(payload, 'url'))
            return { ok: true, value: await services.openInBrowser(url) }
          }

          case 'ext.probeMedia': {
            const url = requireHttpUrl(requireString(payload, 'url'))
            return { ok: true, value: await services.probeMedia(url) }
          }

          case 'download.start': {
            const url = requireHttpUrl(requireString(payload, 'url'))
            const formatId = requireString(payload, 'formatId')
            const entryId = optionalString(payload, 'entryId')
            const onConflict = optionalString(payload, 'onConflict')
            const carrier = optionalString(payload, 'carrier')
            if (onConflict !== undefined && onConflict !== 'overwrite' && onConflict !== 'keep') {
              throw new ApiFailure('bad-request', `onConflict 只能是 overwrite 或 keep，收到 ${JSON.stringify(onConflict)}`)
            }
            if (carrier !== undefined && carrier !== 'guest') {
              throw new ApiFailure('bad-request', `carrier 只能是 guest，收到 ${JSON.stringify(carrier)}`)
            }
            const started = await services.startDownload({
              url,
              formatId,
              ...(entryId === undefined ? {} : { entryId }),
              ...(onConflict === undefined ? {} : { onConflict }),
              ...(carrier === undefined ? {} : { carrier: 'guest' }),
            })
            return { ok: true, value: started }
          }

          case 'download.retry':
            // Only the job id: the Host owns what a retry means (another carrier,
            // the same option) so the client cannot ask for a loop of the same
            // failing channel.
            return { ok: true, value: await services.retryDownload(requireString(payload, 'jobId')) }

          case 'download.cancel': {
            services.cancelJob(requireString(payload, 'jobId'))
            return { ok: true, value: { cancelled: true } }
          }

          case 'download.reveal': {
            // By JOB ID, never by path: the Host decides what may be opened, and it only
            // ever opens what one of its own jobs produced or the directory it was
            // configured with.
            const revealed = await services.revealDownload(requireString(payload, 'jobId'))
            return { ok: true, value: revealed }
          }

          case 'jobs.list':
            return { ok: true, value: { jobs: services.jobs() } }

          default:
            throw new ApiFailure('not-found', `未知的接口方法 "${method}"`)
        }
      } catch (error) {
        if (error instanceof ApiFailure) {
          return { ok: false, error: { code: error.code, message: error.message } }
        }
        return {
          ok: false,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        }
      }
    },
  }
}
