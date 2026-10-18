/**
 * Merging a separated video track and audio track into one mp4 — when this machine can.
 *
 * Why this module exists: a site's higher qualities are often served as TWO files (one
 * video track, one audio track) instead of one muxed mp4, and the user's request was
 * literally 「可否将更高清的分离流合并为mp4」. This program cannot remux by itself, but
 * ffmpeg can, and ffmpeg is already on plenty of machines (this app's own data directory,
 * PATH, the usual Windows installers). So the app USES one when it is there, and says so
 * plainly when it is not:
 *
 *   - it never downloads a binary (an app that fetches an executable behind the user's
 *     back is a different kind of program),
 *   - it never pretends a video track with no sound is the video the user asked for.
 *
 * The two halves are deliberately separate, because they answer different questions at
 * different times:
 *
 *   - {@link resolveMuxer} — "is there one, and where" — is asked ONCE per app lifetime,
 *     before the first harvest, so the page adapter can be told whether offering a pair is
 *     honest. The answer is cached by the caller.
 *   - {@link createMuxRunner} turns that answer into the single call the download engine
 *     makes, and it never throws for an ffmpeg failure: a mux is a step of a download, and
 *     the download reports its own failures.
 *
 * Everything outside is injected, so both halves are tested without spawning anything.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** What one merge needs: the two tracks, and where the joined file goes. */
export interface MuxRequest {
  /** Absolute path of the downloaded video track. */
  readonly videoPath: string
  /** Absolute path of the downloaded audio track. */
  readonly audioPath: string
  /**
   * Absolute path to write.
   *
   * This is a `.part` file while ffmpeg runs, which is why {@link muxArgs} states the
   * container explicitly: ffmpeg picks its output format from the extension, and `.part`
   * says nothing.
   */
  readonly outputPath: string
}

/** How a merge ended. A failure is a value, not an exception. */
export interface MuxResult {
  readonly ok: boolean
  /** ffmpeg's own last word, for the job's error line. */
  readonly message?: string
}

/** What one process call answered. */
export interface MuxSpawnResult {
  readonly ok: boolean
  /** What the program wrote to stderr, verbatim. */
  readonly stderr: string
  /** The process error's own message, used when stderr says nothing. */
  readonly message: string
}

/**
 * The one process call this module makes.
 *
 * Injected so a test can assert the program and the argv WITHOUT spawning anything: a test
 * suite that runs ffmpeg is a suite that fails on the machines this feature exists for.
 */
export type MuxSpawn = (program: string, args: readonly string[], signal?: AbortSignal) => Promise<MuxSpawnResult>

/** The one call the engine makes into ffmpeg. */
export interface MuxRunner {
  /** Absolute path of the program, for diagnostics. */
  readonly path: string
  /**
   * Join the two tracks into `request.outputPath`.
   * @param request - the two inputs and the output.
   * @param signal - aborts the merge with the job.
   * @returns whether it worked, and why not when it did not.
   */
  run(request: MuxRequest, signal?: AbortSignal): Promise<MuxResult>
}

/** What one machine answered about ffmpeg. */
export interface MuxerStatus {
  /** Whether a usable ffmpeg was found. */
  readonly available: boolean
  /** Its absolute path, when one was found. */
  readonly path?: string
  /** The first line of `ffmpeg -version`, when it answered. */
  readonly version?: string
  /** Why there is none, in the app's own words. */
  readonly reason?: string
}

/** A merge never legitimately takes this long; a hung ffmpeg must not hold a slot forever. */
export const MUX_TIMEOUT_MS = 10 * 60 * 1000

/** `ffmpeg -version` either answers at once or the binary is not usable. */
export const MUX_PROBE_TIMEOUT_MS = 5_000

/**
 * The argv for one merge.
 *
 * An ARRAY, never a command line: the paths come from a title the site chose, and quoting
 * them by hand is how a file named `a" & del` becomes a shell problem. `-c copy` because
 * this is a remux, not a re-encode — the bytes the site served are already what the user
 * wants, and re-encoding them would cost minutes of CPU and some of the picture.
 * @param request - the two inputs and the output.
 * @returns the arguments, program excluded.
 */
export function muxArgs(request: MuxRequest): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', request.videoPath,
    '-i', request.audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    // The output is a `.part` file, and ffmpeg will not guess a container from that.
    '-f', 'mp4',
    request.outputPath,
  ]
}

/**
 * ffmpeg's failure in one line.
 *
 * `-loglevel error` means stderr holds the reason and nothing else, and its LAST line is
 * the one that names the cause ("Invalid data found when processing input"). The program's
 * exit status is already known from the error itself, so a bare "exited with code 1" is the
 * least useful thing that could be shown.
 * @param stderr - what ffmpeg wrote to stderr.
 * @param fallback - the process error's own message.
 * @returns a bounded, single-line reason.
 */
export function muxFailureText(stderr: string, fallback: string): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const last = lines.length === 0 ? '' : lines[lines.length - 1] ?? ''
  const text = last === '' ? fallback.trim() : last
  return text === '' ? 'ffmpeg 没有说明原因' : text.slice(0, 300)
}

/** Where to look for ffmpeg, in the order a person would expect. */
export interface MuxerSearch {
  /** The app's data directory (`%APPDATA%\video-downloader`), whose `tools\bin` comes first. */
  readonly home?: string
  /** The `PATH` value, split by the platform's separator. */
  readonly pathValue?: string
  /** `process.platform`, as a parameter so every case is testable. */
  readonly platform?: string
  /** `%LOCALAPPDATA%`, where winget puts its shims. */
  readonly localAppData?: string
}

/**
 * Every place worth looking for ffmpeg, best first.
 *
 * `home` first, because that is where this app's own tools live and where the
 * panel tells the user to put one; PATH second, because that is how ffmpeg is normally
 * installed; the fixed Windows locations last, because a manual install often lands there
 * without PATH being updated. Duplicates are dropped: PATH is long and repetitive.
 * @param search - the environment to build the list from.
 * @returns absolute candidate paths, in the order to try them.
 */
export function muxerCandidates(search: MuxerSearch): string[] {
  const platform = search.platform ?? process.platform
  const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  // The platform's OWN joiner, not this process's: a caller may be asking what another
  // platform's answer would look like, and `path.join` is bound to the running one.
  const join = platform === 'win32' ? win32.join : posix.join
  const candidates: string[] = []
  const add = (path: string | undefined): void => {
    const value = (path ?? '').trim()
    if (value === '' || candidates.includes(value)) return
    candidates.push(value)
  }

  if ((search.home ?? '').trim() !== '') add(join((search.home ?? '').trim(), 'tools', 'bin', binary))
  const separator = platform === 'win32' ? ';' : ':'
  for (const dir of (search.pathValue ?? '').split(separator)) add(dir === '' ? undefined : join(dir, binary))
  if (platform === 'win32') {
    add('C:\\ffmpeg\\bin\\ffmpeg.exe')
    add('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe')
    if ((search.localAppData ?? '').trim() !== '') {
      add(join((search.localAppData ?? '').trim(), 'Microsoft', 'WinGet', 'Links', binary))
    }
  }
  return candidates
}

/** What {@link resolveMuxer} needs from the outside world. */
export interface MuxerProbe {
  /** Absolute candidates, in the order to try them. */
  readonly candidates: readonly string[]
  /** Whether a path is an existing regular file. */
  readonly exists: (path: string) => Promise<boolean>
  /** Run `<program> -version`; its first output line, or undefined when it failed. */
  readonly version: (program: string) => Promise<string | undefined>
}

/**
 * Find a usable ffmpeg: the first candidate that exists AND answers `-version`.
 *
 * Existing is not enough. A half-installed or wrong-architecture `ffmpeg.exe` is a real
 * thing to find on PATH, and taking its presence as the answer would promise the user a
 * merge that then fails at the end of a two-file download — the worst possible moment. The
 * version check costs a few milliseconds, once.
 * @param probe - the injected filesystem and process surface.
 * @returns the answer to cache.
 */
export async function resolveMuxer(probe: MuxerProbe): Promise<MuxerStatus> {
  const present: string[] = []
  for (const candidate of probe.candidates) {
    let exists = false
    try {
      exists = await probe.exists(candidate)
    } catch {
      exists = false
    }
    if (!exists) continue
    present.push(candidate)
    let version: string | undefined
    try {
      version = await probe.version(candidate)
    } catch {
      version = undefined
    }
    if (version !== undefined && version.trim() !== '') {
      return { available: true, path: candidate, version: version.trim().slice(0, 200) }
    }
  }
  return {
    available: false,
    reason: present.length === 0
      ? '没有找到 ffmpeg.exe（找过本程序 data 目录下的 tools/bin、PATH 和几个常见安装位置）'
      : `${present.length} 个位置里有 ffmpeg.exe，但运行 -version 失败了`,
  }
}

/**
 * The runner for a resolved status, or undefined when there is no muxer.
 * @param status - what {@link resolveMuxer} answered.
 * @param options - the timeout, and a seam for the process call itself.
 * @returns the runner, or undefined when this machine has none.
 */
export function createMuxRunner(
  status: MuxerStatus,
  options: { readonly timeoutMs?: number; readonly spawn?: MuxSpawn } = {},
): MuxRunner | undefined {
  const program = status.path
  if (!status.available || program === undefined) return undefined
  const timeout = options.timeoutMs ?? MUX_TIMEOUT_MS
  const spawn: MuxSpawn = options.spawn ?? (async (file, args, signal) => await new Promise<MuxSpawnResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        windowsHide: true,
        timeout,
        // ffmpeg's own output is one line per problem; a program that floods stderr would
        // otherwise be buffered into this process.
        maxBuffer: 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stderr: '', message: '' })
          return
        }
        resolve({ ok: false, stderr: String(stderr ?? ''), message: error.message })
      },
    )
  }))
  return {
    path: program,
    async run(request, signal) {
      const result = await spawn(program, muxArgs(request), signal)
      if (result.ok) return { ok: true }
      return { ok: false, message: muxFailureText(result.stderr, result.message) }
    },
  }
}

/** A {@link MuxerProbe} over the real filesystem and the real process table. */
export function nodeMuxerProbe(search: MuxerSearch = {}): MuxerProbe {
  return {
    candidates: muxerCandidates({
      ...search,
      pathValue: search.pathValue ?? process.env['PATH'] ?? '',
      platform: search.platform ?? process.platform,
      localAppData: search.localAppData ?? process.env['LOCALAPPDATA'] ?? '',
    }),
    async exists(path) {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    },
    async version(program) {
      return await new Promise<string | undefined>((resolve) => {
        execFile(program, ['-version'], { windowsHide: true, timeout: MUX_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
          resolve(error === null ? String(stdout ?? '').split(/\r?\n/)[0] : undefined)
        })
      })
    },
  }
}

/** How long a "no muxer here" answer is trusted before the search runs again. */
export const MUXER_RESCAN_MS = 5_000

/** The current answer, and the runner built from it. */
export interface MuxerKeeper {
  /**
   * The current answer, re-validated before it is returned.
   * @returns whether a muxer is usable right now.
   */
  status(): Promise<MuxerStatus>
  /** The runner for the current answer, or undefined when there is none. */
  runner(): MuxRunner | undefined
}

/**
 * The muxer question, asked once and kept honest afterwards.
 *
 * {@link resolveMuxer} is expensive-ish (it runs a program) and its answer is not permanent:
 * the user can rename, move or delete `ffmpeg.exe` while the app is running — and will,
 * because "does it notice" is the difference between a feature and a claim. So the answer is
 * cached and then re-validated:
 *
 *   - a FOUND program is re-checked with one `stat` on every read, and the search runs again
 *     the moment it is gone;
 *   - a MISSING one is re-searched at most once per {@link MUXER_RESCAN_MS}, so dropping
 *     `ffmpeg.exe` into `%APPDATA%\video-downloader\tools\bin` starts working by itself
 *     instead of requiring a restart the panel's own sentence did not mention.
 *
 * Everything it touches is injected, so both directions are tested without a real ffmpeg.
 * @param input - how to search, how to check, and what to say when the answer changes.
 * @returns the keeper the Host reads.
 */
export function createMuxerKeeper(input: {
  /** Build a fresh probe. Called once per search, never per read. */
  readonly probe: () => MuxerProbe
  /** Whether the path the last search found still exists. */
  readonly exists: (path: string) => boolean
  /** Called only when the ANSWER changes, with the new one. */
  readonly onChange?: (status: MuxerStatus) => void
  /** Builds the runner for an answer; injected so a test does not need a real program. */
  readonly runnerFor?: (status: MuxerStatus) => MuxRunner | undefined
  /** Clock, injected so the rescan window is testable. */
  readonly now?: () => number
  /** Override for {@link MUXER_RESCAN_MS}. */
  readonly rescanMs?: number
}): MuxerKeeper {
  const now = input.now ?? (() => Date.now())
  const rescanMs = Math.max(0, input.rescanMs ?? MUXER_RESCAN_MS)
  const runnerFor = input.runnerFor ?? ((status: MuxerStatus) => createMuxRunner(status))
  let announced = false
  let status: MuxerStatus = { available: false, reason: '还没有开始查找 ffmpeg.exe' }
  let runner: MuxRunner | undefined
  let lastSearchAt = 0

  const search = async (): Promise<MuxerStatus> => {
    lastSearchAt = now()
    let found: MuxerStatus
    try {
      found = await resolveMuxer(input.probe())
    } catch (error) {
      found = { available: false, reason: `查找 ffmpeg 失败：${error instanceof Error ? error.message : String(error)}` }
    }
    // Only a CHANGE is worth a sentence: a poll that keeps repeating itself is noise.
    if (!announced || found.available !== status.available || found.path !== status.path) {
      announced = true
      input.onChange?.(found)
    }
    status = found
    // A runner for an answer that says "no muxer" is nonsense, so an unavailable status
    // clears it whatever the factory would have returned.
    runner = found.available ? runnerFor(found) : undefined
    return found
  }

  let current: Promise<MuxerStatus> = search()

  return {
    async status() {
      const answer = await current
      if (answer.available && answer.path !== undefined) {
        if (input.exists(answer.path)) return answer
      } else if (now() - lastSearchAt < rescanMs) {
        return answer
      }
      runner = undefined
      current = search()
      return await current
    },
    runner() {
      return runner
    },
  }
}
