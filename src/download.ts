/**
 * The download engine: bounded concurrency, two carriers, resumable, atomic.
 *
 * Independent code paths, chosen by the option and — for a page-sourced one — by
 * what the client asked for:
 *
 *   - `direct` — a byte fetch for the media URL the page's harvester reported.
 *     Written here rather than handed to an external tool, because a plain `.mp4`
 *     is a plain file: it resumes from a `.part` sibling via `Range`, and renames
 *     into place only when the bytes are complete — a file under its final name is
 *     therefore always a complete file.
 *   - `guest` — the bytes are pushed IN by the browser extension's page (see
 *     {@link createDownloadEngine}'s `pushGuest`). Nothing about the request
 *     originates here: a site that gates its media behind a browser challenge
 *     answers this app with `403`, and only the page the user is already looking
 *     at holds the clearance. The job therefore starts WAITING for bytes, and a
 *     watchdog fails it if the page goes quiet.
 *
 * Everything external is injected ({@link DownloadDeps}), so the engine is
 * testable against a real loopback HTTP server.
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { describeMediaFailure } from './net/diagnose.js'
import type { MuxRunner } from './mux.js'
import type { JobStatus, JobView, ProbeSource, VideoOption } from './shared/types.js'

/** The filesystem surface the engine needs. */
export interface DownloadFs {
  /** Create a directory tree when missing. */
  ensureDir(path: string): Promise<void>
  /** Join path segments with the platform separator. */
  join(...segments: string[]): string
}

/** Everything the engine needs from the Host. */
export interface DownloadDeps {
  readonly fs: DownloadFs
  /** `fetch` implementation; injected so tests can target a loopback server. */
  readonly fetch: typeof globalThis.fetch
  /** Wall-clock source, injected for deterministic tests. */
  readonly now: () => number
  /**
   * The muxer, when this machine has one (see `mux.ts`).
   *
   * Injected rather than resolved here, for two reasons: finding it means running a
   * program, which is a Host concern, and the engine's tests must never spawn anything.
   * Absent (or answering `undefined`) means "no muxer": an option that carries a separate
   * audio track then fails with a sentence rather than being saved as a silent film.
   *
   * A FUNCTION rather than a value because the search is asynchronous and happens once, at
   * startup: by the time a pair can even be offered the answer exists, and asking here is
   * how the engine reads the resolved one instead of a `Promise` it would have to await.
   */
  readonly mux?: () => MuxRunner | undefined
}

/** One unit of work handed to the engine. */
export interface DownloadRequest {
  /** The page (or entry page) URL, as the probe reported it. */
  readonly url: string
  /** The chosen option. */
  readonly option: VideoOption
  /** Display title used for progress updates and the direct carrier's filename. */
  readonly title: string
  /** Absolute download directory. */
  readonly downloadDir: string
  /** Output template; `%(title)s.%(ext)s` by default. */
  readonly filenameTemplate: string
  /**
   * `Referer` for the media request, when one is known.
   *
   * Hotlink protection is the most common reason a media URL that plays fine in
   * the browser answers 403 to us: the browser sends `Referer` automatically and
   * a bare fetch sends nothing at all. Only the direct carrier uses this.
   */
  readonly referer?: string
  /**
   * The client's explicit choice of carrier, when it made one.
   *
   * Only `guest` is expressible, and only a client can ask for it: the app
   * cannot see the extension's tab, so "download this through the page I am
   * looking at" is a fact only the panel has. Everything else is inferred from the
   * option, exactly as before.
   */
  readonly carrier?: 'guest'
  /**
   * The user's answer to "this file already exists", when there was one.
   *
   * Omitted means the caller never asked: the engine then does what it always
   * did — it picks a free name instead of touching the existing file.
   * `overwrite` is the only value that authorises touching the existing file;
   * `keep` never runs a carrier at all.
   */
  readonly onConflict?: 'overwrite' | 'keep'
  /** The occupied path the user chose to keep, so the skipped job can name it. */
  readonly existingPath?: string
}

/** Which carrier a request will actually run on. */
export type CarrierKind = 'guest' | 'direct'

/** One live guest session, as the upload route sees it. */
export interface GuestEndpoint {
  /**
   * Accept one sequential chunk from the page.
   * @param input - the byte offset it claims, the bytes, and whether that was all.
   * @returns whether it was written, or why it was refused.
   */
  push(input: { readonly offset: number; readonly body: Buffer; readonly done: boolean; readonly total?: number }): Promise<GuestPushResult>
  /** Fail the job with a reason the PAGE reported (an HTTP 403, a manifest, …). */
  fail(code: string, message: string): void
}

/** Why a pushed chunk was refused. */
export type GuestPushFailureCode = 'unknown-token' | 'not-running' | 'offset-mismatch' | 'too-large'

/** The outcome of accepting one pushed chunk. */
export type GuestPushResult =
  | { readonly ok: true; readonly received: number; readonly done: boolean }
  | { readonly ok: false; readonly code: GuestPushFailureCode; readonly message: string }

/**
 * The placeholder a guest job publishes while its carrier is still preparing.
 *
 * The token exists from the moment the job does, because the client hands it to
 * the page in the same breath; the carrier, however, has to create a directory and
 * pick a free filename first, and a page can easily push its first chunk before
 * that finishes. Refusing would lose bytes and blame the page for a race this Host
 * created, so a push waits for the real endpoint instead.
 */
interface GuestSlot {
  /** The endpoint the upload route reaches immediately. */
  readonly endpoint: GuestEndpoint
  /** Hand over the real endpoint once the carrier is ready. */
  attach(endpoint: GuestEndpoint): void
  /** Refuse everything from now on (the carrier failed to start). */
  close(message: string): void
}

/** Build one waiting slot. */
function createGuestSlot(): GuestSlot {
  let resolveReady: (endpoint: GuestEndpoint) => void = () => undefined
  const ready = new Promise<GuestEndpoint>((resolve) => { resolveReady = resolve })
  let real: GuestEndpoint | undefined
  let closed: string | undefined
  return {
    endpoint: {
      async push(input) {
        if (closed !== undefined) return { ok: false, code: 'not-running', message: closed }
        const target = real ?? await ready
        return await target.push(input)
      },
      fail(code, message) {
        if (real !== undefined) {
          real.fail(code, message)
          return
        }
        void ready.then(target => { target.fail(code, message) })
      },
    },
    attach(endpoint) {
      real = endpoint
      resolveReady(endpoint)
    },
    close(message) {
      closed = message
      // Nothing will ever attach now; a queued push has to learn that rather than
      // wait for a promise that cannot resolve.
      resolveReady({
        push: () => Promise.resolve({ ok: false, code: 'not-running', message }),
        fail: () => undefined,
      })
    },
  }
}

/** A file already sitting where a download would land. */
export interface ExistingTarget {
  /** Absolute path the download would write. */
  readonly path: string
  /** Its size in bytes. */
  readonly bytes: number
  /** Its last-modified time, epoch ms. */
  readonly modifiedAtMs?: number
}

/** A live download. */
export interface DownloadHandle {
  /** The job id, for cancellation and progress correlation. */
  readonly id: string
  /** The job's current view. */
  readonly view: JobView
  /**
   * The token the page must push its bytes with, when this job runs on the guest
   * carrier.
   *
   * Minted here rather than by the route because the client has to hand it to the
   * page as soon as the job exists — the page is the one that starts fetching.
   */
  readonly guest?: { readonly token: string }
  /** Stop the download; settles as `cancelled`. */
  cancel(): void
  /** Settles when the job reaches a terminal state, with the final view. */
  readonly done: Promise<JobView>
}

/** Options controlling one engine instance. */
export interface EngineOptions {
  /** Maximum simultaneously running jobs (clamped to at least 1). */
  readonly maxConcurrent: number
  /** Override for {@link GUEST_STALL_MS}; tests use a short one. */
  readonly guestStallMs?: number
  /** Called on every observable change: queued, running, progress, terminal. */
  readonly onUpdate?: (job: JobView) => void
}

/** The download engine. */
export interface DownloadEngine {
  /**
   * What is already sitting where this request would land, if anything.
   *
   * Asked BEFORE `start`, so a name the user has not agreed to replace is never
   * touched: the answer is a question to put on screen, not an error.
   * @param request - the job that is about to be started.
   * @returns the occupied path, or undefined when the coast is clear.
   */
  inspect(request: DownloadRequest): Promise<ExistingTarget | undefined>
  /** Start one job; it queues when the concurrency limit is reached. */
  start(request: DownloadRequest): DownloadHandle
  /** Every job this engine has seen, newest first. */
  list(): readonly JobView[]
  /** Cancel one job by id; a no-op for an unknown or terminal job. */
  cancel(id: string): void
  /**
   * Accept one chunk the browser extension's page pushed for a guest job.
   *
   * Single-writer and sequential by contract: the offset has to equal what has
   * already been written, because two concurrent writers would interleave bytes
   * into a file that then looks complete and is not.
   * @param token - the token minted for that job.
   * @param input - the claimed offset, the bytes, and whether that was all.
   * @returns the new byte count, or why the chunk was refused.
   */
  pushGuest(token: string, input: { readonly offset: number; readonly body: Buffer; readonly done: boolean; readonly total?: number }): Promise<GuestPushResult>
  /** Fail one guest job with a reason the page reported for itself. */
  failGuest(token: string, code: string, message: string): void
  /** Wait for every job to settle (used by app teardown). */
  drain(): Promise<void>
}

/** A failure the engine reports as a job error rather than an exception. */
export class DownloadRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DownloadRejection'
  }
}

/**
 * How long a guest job may go without a byte before it is failed.
 *
 * The page pushes over HTTP, so "no bytes" has several causes that look identical
 * from here (the browser blocked the page's request to this Host's loopback
 * address, the page was closed, the user cancelled the fetch). Waiting forever
 * would hold a concurrency slot for a download that is never coming, so the job
 * ends with a sentence that names the possibilities.
 */
export const GUEST_STALL_MS = 90_000

/** The largest single pushed chunk this engine accepts, for one request's memory. */
export const GUEST_MAX_CHUNK_BYTES = 16 * 1024 * 1024

/** How often the direct carrier samples a transfer rate. */
const SPEED_SAMPLE_MS = 250

/**
 * Substitute the title into an output template.
 *
 * `%%` (a literal percent) is masked while substituting so a template containing
 * it cannot be corrupted, then restored.
 * @param template - the configured template.
 * @param title - the display title.
 * @returns the template with `%(title)s` replaced.
 */
export function resolveOutputTemplate(template: string, title: string): string {
  return template.replace(/%%/g, '\u0000').replace(/%\(title\)s/g, title).replace(/\u0000/g, '%')
}

/** The container extension a job's file will carry. */
function extensionFor(option: VideoOption): string {
  const ext = option.ext.trim()
  // A manifest is a list of files, so if one were ever offered, the file a muxer
  // would produce is an mp4; both carriers refuse it long before this is reached.
  return ext.toLowerCase() === 'm3u8' ? 'mp4' : ext
}

/**
 * The configured template expanded for one job, or `undefined` when it names
 * something this Host cannot expand (`%(id)s`, `%(upload_date)s`, …).
 *
 * The name is decided HERE rather than by a downloader program, because both
 * carriers are byte writers: whatever a job will write has to be known before the
 * bytes arrive, which is exactly what makes "this file already exists" answerable.
 * A guessed name would ask about the wrong file, so an unexpandable template says
 * so instead of guessing.
 * @param request - the job request.
 * @param ext - the container extension the file will carry.
 * @returns the file name, or `undefined` when the template is not expandable.
 */
export function expandedName(request: DownloadRequest, ext: string): string | undefined {
  const stem = stripKnownExtension(safeFileStem(request.title), ext)
  // `%(ext)s` is knowable (the option carries the container); anything else is not.
  const expanded = resolveOutputTemplate(request.filenameTemplate, stem).replace(/%\(ext\)s/g, ext)
  if (expanded.trim() === '' || /%\([^)]*\)s/.test(expanded)) return undefined
  return expanded
}

/**
 * The name a job will write: the expanded template, or `title.ext` when the
 * template cannot be expanded.
 *
 * Both carriers and the conflict question go through this one function, so the
 * path the user is asked about and the path that is written cannot disagree.
 * @param request - the job request.
 * @returns the file name, without a directory.
 */
export function outputNameFor(request: DownloadRequest): string {
  const ext = extensionFor(request.option)
  return expandedName(request, ext) ?? `${stripKnownExtension(safeFileStem(request.title), ext)}.${ext}`
}

/**
 * The path one request will land on, or `undefined` when it cannot be known.
 *
 * `undefined` means "do not ask about a file here": either the option is not a
 * whole file (a manifest, or no URL at all), or the configured template names
 * something only an external downloader could expand. The caller then behaves
 * exactly as it did before the conflict check existed.
 * @param deps - the engine's injected dependencies.
 * @param request - the job request.
 * @returns an absolute path, or undefined when the name is not predictable.
 */
export function expectedOutputPath(deps: DownloadDeps, request: DownloadRequest): string | undefined {
  if (!isDirectlyDownloadable(request.option)) return undefined
  const name = expandedName(request, extensionFor(request.option))
  return name === undefined ? undefined : deps.fs.join(request.downloadDir, name)
}

/**
 * Whether an option is a whole file that can be fetched over HTTP.
 *
 * A manifest is not a file: `.m3u8` is a list of segments, and turning one into a file is
 * a different job from joining two tracks — this program merges a video track with an audio
 * track, and does not assemble a segment playlist — so a manifest is refused rather than
 * saved as something that cannot be played. Everything else with a URL is one file, and a
 * `guest` option is fetched the same way (by the page instead of by this app), which is
 * why both carriers share this predicate.
 * @param option - the chosen option.
 * @returns true when the bytes are one file fetched over HTTP.
 */
export function isDirectlyDownloadable(option: VideoOption): boolean {
  if (option.directUrl === undefined) return false
  return option.ext.trim().toLowerCase() !== 'm3u8'
}

/**
 * Which carrier a request will run on.
 *
 * `guest` is only ever the client's explicit request, because only the client can
 * see whether there is a page to hand the job to. Everything else is fetched by
 * this app; an option that turns out not to be a whole file is refused by the
 * carrier itself, in words that say which of the two reasons applies.
 * @param request - the job request.
 * @returns the carrier to run.
 */
export function resolveCarrier(request: DownloadRequest): CarrierKind {
  return request.carrier === 'guest' ? 'guest' : 'direct'
}

/**
 * Sanitize a title into a filename stem.
 * @param title - the display title.
 * @returns a filesystem-safe, length-bounded stem.
 */
export function safeFileStem(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot or space is invalid in a Windows filename.
    .replace(/[. ]+$/, '')
  return cleaned === '' ? 'video' : cleaned.slice(0, 120)
}

/**
 * Strip a trailing `.<ext>` from a filename stem.
 *
 * A title that IS a filename (`mov_bbb.mp4`, the natural title for a URL that
 * names a media file) would otherwise produce `mov_bbb.mp4.mp4`, because the
 * container extension is appended separately. The stem is returned unchanged
 * when removing the suffix would leave nothing to name the file with.
 * @param stem - an already sanitized filename stem.
 * @param ext - the container extension that will be appended.
 * @returns the stem without a redundant extension.
 */
export function stripKnownExtension(stem: string, ext: string): string {
  const suffix = `.${ext}`
  if (stem.length <= suffix.length) return stem
  return stem.toLowerCase().endsWith(suffix.toLowerCase()) ? stem.slice(0, -suffix.length) : stem
}

/**
 * Pick a free path in a directory for a desired file name.
 *
 * The name comes from {@link outputNameFor}, so the extension is whatever the
 * template and the option agreed on; a collision only ever inserts ` (n)` before
 * that extension.
 * @param absoluteDir - the download directory.
 * @param name - the desired file name, extension included.
 * @param exists - predicate answering whether a path is taken.
 * @param join - path joiner.
 * @returns an absolute path that does not exist yet.
 */
export async function freeOutputPath(
  absoluteDir: string,
  name: string,
  exists: (path: string) => Promise<boolean>,
  join: (...segments: string[]) => string,
): Promise<string> {
  const first = join(absoluteDir, name)
  if (!(await exists(first))) return first
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const suffix = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(absoluteDir, `${base} (${index})${suffix}`)
    if (!(await exists(candidate))) return candidate
  }
  // A thousand collisions means something is wrong with the directory, not the
  // name; failing loudly beats overwriting silently.
  throw new DownloadRejection('name-conflict', `无法为 ${name} 生成不冲突的文件名`)
}

/** Whether a local path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The validators an earlier attempt recorded next to a `.part` file.
 *
 * A `.part` is only usable as a resume point while the server still serves the same
 * entity; without these, a re-signed URL or a replaced upload would be spliced onto
 * the old bytes and the result would look complete. Written once per attempt, read
 * before a resume, and never trusted on its own — the `Content-Range` start has to
 * agree as well.
 */
interface PartValidators {
  readonly etag?: string
  readonly lastModified?: string
}

/** Read the validators recorded for a `.part`, when there are any. */
async function readPartValidators(path: string): Promise<PartValidators | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as PartValidators
  } catch {
    // Missing or hand-damaged: the safe answer is "no validators", which makes the
    // resume depend on `Content-Range` alone rather than failing the download.
    return undefined
  }
}

/** Record the validators of the response a `.part` is being written from. */
async function writePartValidators(path: string, headers: Headers): Promise<void> {
  const etag = headers.get('etag')
  const lastModified = headers.get('last-modified')
  const body: PartValidators = {
    ...(etag === null ? {} : { etag }),
    ...(lastModified === null ? {} : { lastModified }),
  }
  await writeFile(path, JSON.stringify(body), 'utf8').catch(() => undefined)
}

/**
 * Decide whether a `206` answer really continues the bytes on disk.
 * @param headers - the resumed response's headers.
 * @param offset - the number of bytes already on disk.
 * @param validators - what the earlier attempt recorded, when anything.
 * @returns a Chinese reason to start over, or undefined when the resume is sound.
 */
function resumeProblem(
  headers: Headers,
  offset: number,
  validators: PartValidators | undefined,
): string | undefined {
  const range = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(headers.get('content-range') ?? '')
  if (range === null) return '续传响应没有说明从第几个字节开始'
  const start = Number(range[1])
  if (start !== offset) return `服务器从第 ${start} 字节续传，而磁盘上已有 ${offset} 字节`
  const etag = headers.get('etag')
  if (validators?.etag !== undefined && etag !== null && etag !== validators.etag) {
    return `文件已经变了（ETag ${validators.etag} → ${etag}）`
  }
  const lastModified = headers.get('last-modified')
  if (validators?.lastModified !== undefined && lastModified !== null && lastModified !== validators.lastModified) {
    return '文件已经变了（Last-Modified 变了）'
  }
  return undefined
}

/** A mutable job record; the frozen {@link JobView} is projected from it. */
interface MutableJob {
  id: string
  url: string
  title: string
  formatId: string
  source: ProbeSource
  status: JobStatus
  receivedBytes: number
  totalBytes?: number
  speedBytesPerSecond?: number
  outputPath?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

/** Freeze the internal record into the wire view. */
function toView(job: MutableJob): JobView {
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    formatId: job.formatId,
    source: job.source,
    status: job.status,
    receivedBytes: job.receivedBytes,
    ...(job.totalBytes === undefined ? {} : { totalBytes: job.totalBytes }),
    ...(job.speedBytesPerSecond === undefined ? {} : { speedBytesPerSecond: job.speedBytesPerSecond }),
    ...(job.outputPath === undefined ? {} : { outputPath: job.outputPath }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  }
}

/** One queued job plus the machinery its handle needs. */
interface JobRecord {
  readonly job: MutableJob
  readonly request: DownloadRequest
  readonly controller: AbortController
  /** The guest token this job's bytes are addressed with, when it has one. */
  readonly guestToken?: string
  /** The waiting endpoint that token resolves to once the carrier is ready. */
  readonly guestSlot?: GuestSlot
  /** Resolves the handle's `done` exactly once. */
  readonly finish: (view: JobView) => void
  /** The handle's promise. */
  readonly finished: Promise<JobView>
  settled: boolean
}

/** Create an engine over the injected dependencies. */
export function createDownloadEngine(deps: DownloadDeps, options: EngineOptions): DownloadEngine {
  const records = new Map<string, JobRecord>()
  const order: string[] = []
  const queue: string[] = []
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent))
  const guestStallMs = Math.max(50, options.guestStallMs ?? GUEST_STALL_MS)
  /**
   * Live guest sessions, keyed by the token the page pushes with.
   *
   * The bytes arrive over HTTP from the page, so there is no stream to hand out:
   * the route that owns the request looks the token up here. An entry is removed
   * in `runGuest`'s `finally`, so a token can never outlive its job.
   */
  const guests = new Map<string, GuestEndpoint>()
  let running = 0
  let sequence = 0

  const publish = (job: MutableJob): void => {
    try {
      options.onUpdate?.(toView(job))
    } catch {
      // A listener that throws must never abort a transfer.
    }
  }

  /**
   * Retire the guest session a job owns, no matter which branch ended the job.
   *
   * The token is published the moment the job is created, so every path that can
   * settle a job WITHOUT running its carrier — a cancel while queued, or
   * `onConflict: 'keep'` — has to release it here. Left behind, the token stays in
   * {@link guests} forever and a page that posts it afterwards waits on a slot no
   * one will ever fill: its request hangs until the extension's timeout.
   */
  const releaseGuest = (record: JobRecord): void => {
    if (record.guestToken === undefined) return
    record.guestSlot?.close('这个下载已经结束了')
    guests.delete(record.guestToken)
  }

  /** Move a job to a terminal state exactly once and resolve its handle. */
  const settle = (record: JobRecord, status: JobStatus, patch: Partial<MutableJob>): void => {
    const { job } = record
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'skipped') return
    Object.assign(job, patch, { status, finishedAt: deps.now() })
    releaseGuest(record)
    publish(job)
    if (!record.settled) {
      record.settled = true
      record.finish(toView(job))
    }
  }

  /**
   * Sampled byte accounting for one job.
   *
   * A paired download writes two files, so progress is the SUM of both tracks while each
   * track's own resume offset counts once — the panel shows one download, because that is
   * what the user asked for. The first report seeds the rate sample, so a resumed file does
   * not look like an instant burst of its own offset.
   */
  const tracker = (record: JobRecord): {
    report(fileBytes: number, baseBytes: number): void
    addTotal(bytes: number): void
  } => {
    const { job } = record
    let lastSampleAt = deps.now()
    let lastSampleBytes = 0
    let seeded = false
    return {
      report(fileBytes, baseBytes) {
        job.receivedBytes = baseBytes + fileBytes
        if (!seeded) {
          seeded = true
          lastSampleAt = deps.now()
          lastSampleBytes = job.receivedBytes
          return
        }
        const now = deps.now()
        if (now - lastSampleAt >= SPEED_SAMPLE_MS) {
          job.speedBytesPerSecond = Math.round(((job.receivedBytes - lastSampleBytes) * 1000) / (now - lastSampleAt))
          lastSampleAt = now
          lastSampleBytes = job.receivedBytes
          publish(job)
        }
      },
      addTotal(bytes) {
        // A pair is two servers' declarations; the total is what both halves will add up to.
        job.totalBytes = (job.totalBytes ?? 0) + bytes
      },
    }
  }

  /**
   * Fetch ONE url into ONE file, resuming from that file's `.part` sibling.
   *
   * Extracted when the paired carrier arrived: a separated quality is two ordinary
   * downloads, and everything interesting about them — the `Range` resume, the Referer
   * retry, the completeness check — is the same code, twice.
   * @param record - the job.
   * @param signal - aborts the transfer.
   * @param input - which URL, which file, and how to report progress.
   * @returns the number of bytes in the finished file, resume offset included.
   */
  const fetchOne = async (
    record: JobRecord,
    signal: AbortSignal,
    input: {
      readonly source: string
      readonly partPath: string
      /** This file's own byte count (resume offset included) as it grows. */
      readonly onProgress: (fileBytes: number) => void
      /** The whole file's size, when the server declared one. */
      readonly onTotal: (fileBytes: number) => void
    },
  ): Promise<number> => {
    const { request } = record
    const metaPath = `${input.partPath}.meta`
    let offset = 0
    if (await pathExists(input.partPath)) {
      offset = (await stat(input.partPath)).size
    }
    // What the bytes on disk belonged to last time; a fresh attempt rewrites it.
    let validators = offset > 0 ? await readPartValidators(metaPath) : undefined

    /** The headers one attempt needs — a resume is only offered while it can be proven. */
    const headersFor = (from: number, withReferer: boolean): Record<string, string> => {
      const built: Record<string, string> = {}
      if (from > 0) {
        built.range = `bytes=${from}-`
        // `If-Range` makes the server answer 200 instead of 206 when the entity has
        // changed; that is the difference between continuing a file and splicing a
        // new one onto the old bytes.
        const ifRange = validators?.etag ?? validators?.lastModified
        if (ifRange !== undefined) built['if-range'] = ifRange
      }
      if (withReferer && request.referer !== undefined && request.referer !== '') built.referer = request.referer
      return built
    }

    let response = await deps.fetch(input.source, { headers: headersFor(offset, true), signal })
    let bare = false
    if (request.referer !== undefined && request.referer !== '' && !response.ok && response.status !== 206) {
      // Measured on a CDN77-hosted media host: a request carrying `Referer` **plus any
      // other header** is answered 403, while the very same URL is served to a bare
      // request — and to a request carrying a Referer and nothing else. The Referer is
      // a courtesy to sites that check hotlinking, not part of the URL's signature
      // (the signature is in the query), so one refusal is worth a retry without it
      // rather than a failed job. Without this, "download this" fails on a URL that
      // `curl` fetches at 15 MB/s.
      const retried = await deps.fetch(input.source, { headers: headersFor(offset, false), signal })
      bare = true
      if (retried.ok || retried.status === 206) response = retried
      else void retried.body?.cancel().catch(() => undefined)
    }
    if (offset > 0 && response.status === 416) {
      // `Range: bytes=N-` at or past the end of the file is answered 416. That is exactly
      // what a RETRY looks like when an earlier attempt already finished this half — the
      // first track of a pair is whole, and asking for the rest of it asks for nothing.
      // The RFC says a 416 SHOULD state the real length, which is just enough to tell a
      // COMPLETE part from a stale one; anything else starts over rather than guessing,
      // because one wasted round trip is cheaper than a file quietly made of the wrong
      // bytes.
      const stated = /bytes\s+\*\/(\d+)/i.exec(response.headers.get('content-range') ?? '')
      void response.body?.cancel().catch(() => undefined)
      if (stated !== null && Number(stated[1]) === offset) {
        input.onProgress(offset)
        await rm(metaPath, { force: true }).catch(() => undefined)
        return offset
      }
      offset = 0
      validators = undefined
      response = await deps.fetch(input.source, { headers: headersFor(0, true), signal })
    }
    if (offset > 0 && response.status === 206) {
      const problem = resumeProblem(response.headers, offset, validators)
      if (problem !== undefined) {
        // The bytes on disk are not a prefix of what this URL serves now: a new
        // upload, a re-signed file, or a part written by an older attempt. Splicing
        // would produce a file that looks complete and is not, so start over.
        void response.body?.cancel().catch(() => undefined)
        offset = 0
        validators = undefined
        response = await deps.fetch(input.source, { headers: headersFor(0, true), signal })
      }
    }
    if (!response.ok && response.status !== 206) {
      throw new DownloadRejection('http-error', `${describeMediaFailure(response.status)}${bare ? '（去掉 Referer 重试后仍然被拒）' : ''}`)
    }
    // A server that ignores Range restarts from zero, so the partial file must
    // be truncated rather than appended to.
    const resumed = response.status === 206 && offset > 0
    const writeOffset = resumed ? offset : 0
    if (writeOffset === 0 || validators === undefined) {
      await writePartValidators(metaPath, response.headers)
    }

    const declared = Number(response.headers.get('content-length') ?? '')
    const known = Number.isFinite(declared) && declared > 0
    if (known) input.onTotal(declared + writeOffset)
    if (response.body === null) throw new DownloadRejection('http-error', '响应没有正文')

    let received = writeOffset
    input.onProgress(received)
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      input.onProgress(received)
    })

    try {
      await pipeline(body, createWriteStream(input.partPath, { flags: resumed ? 'r+' : 'w', start: writeOffset }))
    } catch (error) {
      // The `.part` file is deliberately kept so a retry resumes from it.
      if (signal.aborted) throw new DownloadRejection('cancelled', '下载已取消')
      throw new DownloadRejection('http-error', `传输失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (signal.aborted) throw new DownloadRejection('cancelled', '下载已取消')
    if (known && received < declared + writeOffset) {
      throw new DownloadRejection('incomplete', `传输未完成（${received}/${declared + writeOffset} 字节），已保留断点`)
    }
    // Complete: the `.part` is about to be renamed into place, and its validators
    // have nothing left to describe.
    await rm(metaPath, { force: true }).catch(() => undefined)
    return received
  }

  /**
   * The paired carrier: two tracks fetched in turn, then joined by the muxer.
   *
   * Both halves are ordinary resumable fetches — a pair is two files, not a protocol — and
   * the only new step is the last one. The two `.part` files are kept until the merged file
   * is in place, so a failure in the second half (or in the muxer) can be retried without
   * downloading the first half again.
   * @param record - the job.
   * @param signal - aborts the transfer.
   * @param input - the two URLs, the final path, and the progress sink.
   * @returns the terminal patch for the job.
   */
  const runPair = async (
    record: JobRecord,
    signal: AbortSignal,
    input: { readonly source: string; readonly audio: string; readonly finalPath: string; readonly progress: ReturnType<typeof tracker> },
  ): Promise<Partial<MutableJob>> => {
    const mux = deps.mux?.()
    if (mux === undefined) {
      // The media policy withholds these rows on a machine without a muxer, so this is the
      // last line of defence rather than the normal path: it exists because "save the video
      // track and say nothing" must be impossible, not merely unlikely.
      throw new DownloadRejection('no-muxer', '这一档要把视频轨与音频轨合并，但本机没有找到 ffmpeg.exe')
    }
    const videoPart = `${input.finalPath}.part`
    const audioPart = `${input.finalPath}.audio.part`

    const videoBytes = await fetchOne(record, signal, {
      source: input.source,
      partPath: videoPart,
      onProgress: fileBytes => input.progress.report(fileBytes, 0),
      onTotal: bytes => input.progress.addTotal(bytes),
    })
    const audioBytes = await fetchOne(record, signal, {
      source: input.audio,
      partPath: audioPart,
      onProgress: fileBytes => input.progress.report(fileBytes, videoBytes),
      onTotal: bytes => input.progress.addTotal(bytes),
    })

    const muxPart = `${input.finalPath}.mux.part`
    const result = await mux.run({ videoPath: videoPart, audioPath: audioPart, outputPath: muxPart }, signal)
    if (!result.ok) {
      if (signal.aborted) throw new DownloadRejection('cancelled', '下载已取消')
      throw new DownloadRejection('mux-failed', `合并失败：${result.message ?? 'ffmpeg 没有说明原因'}`)
    }
    if (signal.aborted) throw new DownloadRejection('cancelled', '下载已取消')
    await rename(muxPart, input.finalPath)
    // The two tracks are one file now, so the parts are waste — and a stale one would make
    // the next download of this row resume from bytes that are already inside the mp4.
    await rm(videoPart, { force: true }).catch(() => undefined)
    await rm(audioPart, { force: true }).catch(() => undefined)
    return { outputPath: input.finalPath, receivedBytes: videoBytes + audioBytes }
  }

  /** The direct carrier: resume-aware byte fetch with an atomic rename. */
  const runDirect = async (record: JobRecord, signal: AbortSignal): Promise<Partial<MutableJob>> => {
    const { request } = record
    const source = request.option.directUrl
    if (source === undefined || !isDirectlyDownloadable(request.option)) {
      // The row offered no whole file: either nothing to fetch, or a manifest,
      // which is a list of segments rather than a file this engine could save.
      throw new DownloadRejection('no-direct-url', '这个条目不是一个可以直接下载的文件（流式清单一类需要合并，本程序不提供）')
    }
    await deps.fs.ensureDir(request.downloadDir)
    // An explicit `overwrite` takes the occupied path on purpose; without it the
    // original "never clobber a name that is taken" rule still holds, so a file
    // that appeared between the question and the transfer is not destroyed.
    const predicted = expectedOutputPath(deps, request)
    const finalPath = request.onConflict === 'overwrite' && predicted !== undefined
      ? predicted
      : await freeOutputPath(request.downloadDir, outputNameFor(request), pathExists, deps.fs.join)
    const progress = tracker(record)

    // A separated pair is the only case with a second file in it: the option carries the
    // audio track's URL, and nothing else about the job changes.
    const audio = request.option.audioUrl
    if (audio !== undefined && audio !== '') {
      return await runPair(record, signal, { source, audio, finalPath, progress })
    }

    const partPath = `${finalPath}.part`
    const received = await fetchOne(record, signal, {
      source,
      partPath,
      onProgress: fileBytes => progress.report(fileBytes, 0),
      onTotal: bytes => progress.addTotal(bytes),
    })
    await rename(partPath, finalPath)
    return { outputPath: finalPath, receivedBytes: received }
  }

  /**
   * The guest carrier: the bytes are pushed in by the page the user is looking at.
   *
   * Why this exists at all: this Host is a DIFFERENT HTTP client from the
   * browser, and a site that gates its media on a challenge binds the clearance to
   * the client that solved it — cookies, TLS fingerprint and IP. The page already
   * passed that check, so it is the only client that can fetch the file; this
   * carrier's whole job is to receive what it fetches.
   *
   * Nothing is created on disk until the first chunk arrives, and the job waits
   * under a watchdog: a page that never pushes (a blocked loopback request, a
   * closed tab) fails with a sentence instead of holding a slot forever.
   */
  const runGuest = async (record: JobRecord, signal: AbortSignal): Promise<Partial<MutableJob>> => {
    const token = record.guestToken
    const slot = record.guestSlot
    const source = record.request.option.directUrl
    if (token === undefined || slot === undefined || source === undefined) {
      throw new DownloadRejection('guest-unavailable', '该条目没有可交给页面下载的地址')
    }
    try {
      return await runGuestBody(record, signal, slot)
    } finally {
      // Every way out of this carrier ends the session here too. `settle` already
      // released it for the normal paths; both are idempotent, and this one covers
      // the carriers that threw before anything settled.
      releaseGuest(record)
    }
  }

  /** The guest carrier's body, wrapped so its session is always released. */
  const runGuestBody = async (
    record: JobRecord,
    signal: AbortSignal,
    slot: GuestSlot,
  ): Promise<Partial<MutableJob>> => {
    const { job, request } = record
    const source = request.option.directUrl
    if (source === undefined || !isDirectlyDownloadable(request.option)) {
      // A manifest is a list of files, and joining them needs a muxer the page does
      // not have either, so this carrier must not pretend it can carry one.
      throw new DownloadRejection('guest-manifest', '这个地址不是一个可以直接保存的文件（流式清单一类需要合并，本程序不提供）')
    }
    if (request.option.audioUrl !== undefined && request.option.audioUrl !== '') {
      // Half a pair is a silent film. The page can push one URL, and this option is two,
      // so the honest answer is "this one has to run on the Host" — the panel already
      // chooses the Host for these rows, and this is what happens if anything ever
      // disagrees.
      throw new DownloadRejection('guest-pair', '这一档是分离的视频轨与音频轨，页面直传只会得到没有声音的画面，请让它由本程序下载并合并')
    }
    await deps.fs.ensureDir(request.downloadDir)
    const predicted = expectedOutputPath(deps, request)
    const finalPath = request.onConflict === 'overwrite' && predicted !== undefined
      ? predicted
      : await freeOutputPath(request.downloadDir, outputNameFor(request), pathExists, deps.fs.join)
    const partPath = `${finalPath}.part`

    let stream: WriteStream | undefined
    let received = 0
    let declaredTotal: number | undefined
    let closed = false
    let failure: DownloadRejection | undefined
    let wake: () => void = () => undefined
    const completed = new Promise<void>((resolve) => { wake = resolve })
    let watchdog: NodeJS.Timeout | undefined

    /** Record the first reason this job ends, and wake the carrier. */
    const stop = (error: DownloadRejection): void => {
      if (failure === undefined) failure = error
      wake()
    }
    const armWatchdog = (): void => {
      if (watchdog !== undefined) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stop(new DownloadRejection(
          'guest-stalled',
          `页面在 ${Math.round(guestStallMs / 1000)} 秒内没有再传来数据（可能被浏览器拦在本机网络之外，或页面已关闭、被取消）`,
        ))
      }, guestStallMs)
      watchdog.unref?.()
    }
    const onAbort = (): void => { stop(new DownloadRejection('cancelled', '下载已取消')) }
    signal.addEventListener('abort', onAbort)
    // Cancelled while the directory was being created: the listener above would
    // never fire for a signal that was already aborted.
    if (signal.aborted) onAbort()

    const endpoint: GuestEndpoint = {
      async push(input) {
        if (closed) return { ok: false, code: 'not-running', message: '这个下载已经结束了' }
        if (input.body.length > GUEST_MAX_CHUNK_BYTES) {
          return { ok: false, code: 'too-large', message: `单次上传不能超过 ${GUEST_MAX_CHUNK_BYTES} 字节` }
        }
        if (input.offset !== received) {
          // Sequential single writer. An out-of-order chunk cannot be written
          // without either dropping bytes or duplicating them, and guessing would
          // produce a file that looks complete and is not.
          return { ok: false, code: 'offset-mismatch', message: `数据偏移对不上：期望 ${received}，收到 ${input.offset}` }
        }
        if (declaredTotal === undefined && input.total !== undefined && input.total > 0) {
          declaredTotal = input.total
          job.totalBytes = declaredTotal
        }
        if (input.body.length > 0) {
          if (stream === undefined) {
            stream = createWriteStream(partPath, { flags: 'w' })
            stream.on('error', (error: Error) => {
              stop(new DownloadRejection('write-failed', `写入文件失败：${error.message}`))
            })
          }
          const ready = stream.write(input.body)
          received += input.body.length
          job.receivedBytes = received
          publish(job)
          // Backpressure, honoured: the page waits for each response, so a slow
          // disk slows the page down instead of filling this process's memory.
          if (!ready) await once(stream, 'drain').catch(() => undefined)
        }
        armWatchdog()
        if (input.done) wake()
        return { ok: true, received, done: input.done }
      },
      fail(code, message) {
        stop(new DownloadRejection(code, message))
      },
    }
    // The token was published when the job was created; this is the real endpoint
    // behind it, so anything the page pushed while the path was being chosen is
    // applied now, in order.
    slot.attach(endpoint)
    armWatchdog()

    try {
      await completed
      if (failure !== undefined) throw failure
      if (stream === undefined || received === 0) {
        throw new DownloadRejection('guest-empty', '页面没有传来任何数据')
      }
      stream.end()
      await finished(stream)
      if (failure !== undefined) throw failure
      if (declaredTotal !== undefined && received < declaredTotal) {
        throw new DownloadRejection('incomplete', `页面报告 ${declaredTotal} 字节，实际只收到 ${received} 字节，已保留断点`)
      }
      await rename(partPath, finalPath)
      return { outputPath: finalPath, receivedBytes: received }
    } catch (error) {
      // The `.part` file is kept, like the direct carrier's: a file under its final
      // name is always complete, and what was received is still evidence. It is
      // ENDED rather than destroyed, so the bytes already handed to the stream are
      // flushed — a partial file that is short by one buffer tells nobody anything.
      if (stream !== undefined && !stream.destroyed) {
        stream.end()
        await finished(stream).catch(() => undefined)
      }
      throw error
    } finally {
      closed = true
      if (watchdog !== undefined) clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** The shared job body. */
  const execute = async (record: JobRecord): Promise<void> => {
    const { job, request, controller } = record
    job.status = 'running'
    job.startedAt = deps.now()
    publish(job)
    try {
      // What decides the carrier is whether the client asked for the page to carry
      // it; the option itself only decides whether there is a file to fetch, and a
      // carrier that cannot fetch it says so in its own words.
      const carrier = resolveCarrier(request)
      const patch = carrier === 'guest'
        ? await runGuest(record, controller.signal)
        : await runDirect(record, controller.signal)
      settle(record, 'done', patch)
    } catch (error) {
      if (error instanceof DownloadRejection) {
        settle(record, error.code === 'cancelled' ? 'cancelled' : 'failed', { error: error.message })
        return
      }
      settle(record, 'failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Start queued jobs while capacity remains. */
  const pump = (): void => {
    while (running < maxConcurrent && queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) return
      const record = records.get(id)
      if (record === undefined) continue
      // A job cancelled while queued must never start.
      if (record.settled) continue
      running += 1
      void execute(record).finally(() => {
        running -= 1
        pump()
      })
    }
  }

  return {
    async inspect(request) {
      const path = expectedOutputPath(deps, request)
      if (path === undefined) return undefined
      try {
        const info = await stat(path)
        if (!info.isFile()) return undefined
        return { path, bytes: info.size, modifiedAtMs: info.mtimeMs }
      } catch {
        // Not there (or not readable) is the same answer as far as the question
        // goes: there is nothing to ask about.
        return undefined
      }
    },
    start(request) {
      sequence += 1
      const job: MutableJob = {
        id: `job-${sequence.toString(36)}-${deps.now().toString(36)}`,
        url: request.url,
        title: request.title,
        formatId: request.option.id,
        source: request.option.source,
        status: 'queued',
        receivedBytes: 0,
      }
      // Minted before the job runs: the client has to hand this to the page, and
      // the page is the one that starts fetching. A v4 UUID rather than a counter,
      // because the token is the only thing standing between an arbitrary local
      // page and this job's file.
      const guestToken = request.carrier === 'guest' ? randomUUID().replace(/-/g, '') : undefined
      // Published immediately, so a chunk that arrives before the carrier has
      // finished choosing a path waits instead of being refused.
      const guestSlot = guestToken === undefined ? undefined : createGuestSlot()
      if (guestToken !== undefined && guestSlot !== undefined) guests.set(guestToken, guestSlot.endpoint)
      let resolveFinished: (view: JobView) => void = () => undefined
      const finished = new Promise<JobView>((resolve) => { resolveFinished = resolve })
      const record: JobRecord = {
        job,
        request,
        controller: new AbortController(),
        ...(guestToken === undefined ? {} : { guestToken }),
        ...(guestSlot === undefined ? {} : { guestSlot }),
        finish: resolveFinished,
        finished,
        settled: false,
      }
      records.set(job.id, record)
      order.push(job.id)
      publish(job)
      if (request.onConflict === 'keep') {
        // "Keep the file that is already there": nothing is transferred, so the
        // job exists only to say so in the list. It never enters the queue, and
        // `skipped` is terminal — a row that says what happened beats silence.
        settle(record, 'skipped', {
          ...(request.existingPath === undefined ? {} : { outputPath: request.existingPath }),
        })
      } else {
        queue.push(job.id)
        pump()
      }
      return {
        id: job.id,
        get view() { return toView(record.job) },
        ...(guestToken === undefined ? {} : { guest: { token: guestToken } }),
        cancel: () => {
          if (record.settled) return
          if (record.job.status === 'queued') {
            // Never started: settle without touching the carriers.
            settle(record, 'cancelled', {})
            return
          }
          record.controller.abort()
        },
        done: finished,
      }
    },
    list() {
      return order.map(id => records.get(id)).filter((record): record is JobRecord => record !== undefined).map(record => toView(record.job)).reverse()
    },
    cancel(id) {
      const record = records.get(id)
      if (record === undefined || record.settled) return
      if (record.job.status === 'queued') {
        settle(record, 'cancelled', {})
        return
      }
      record.controller.abort()
    },
    async pushGuest(token, input) {
      const endpoint = guests.get(token)
      if (endpoint === undefined) {
        return { ok: false, code: 'unknown-token', message: '这个上传令牌不存在或对应的下载已经结束' }
      }
      return await endpoint.push(input)
    },
    failGuest(token, code, message) {
      guests.get(token)?.fail(code, message)
    },
    async drain() {
      await Promise.all([...records.values()].map(record => record.finished))
    },
  }
}

/** Create the real filesystem dependency. */
export function nodeDownloadFs(): DownloadFs {
  return {
    ensureDir: async (path) => { await mkdir(path, { recursive: true }) },
    join: (...segments) => segments.join('/'),
  }
}

