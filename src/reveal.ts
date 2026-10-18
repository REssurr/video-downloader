/**
 * Opening a download's folder for the user.
 *
 * The decision and the argv are pure — which directory a job resolves to, and how each
 * platform's file manager is asked to open one — so they are tested without a window
 * ever appearing. Only the launch itself is a side effect, and it is injected for the
 * same reason {@link readSystemProxy}'s command runner is (`src/net/proxy.ts`): a test
 * that opened Explorer on every run would be a test nobody keeps.
 *
 * It opens a DIRECTORY, never a selected file: the button is called 打开本地目录, and
 * it exists so the user can go straight to where the downloads land.
 */

/** The directory a job's file lives in. */
export interface RevealTarget {
  /** The absolute directory to open. */
  readonly path: string
}

/**
 * The directory part of a path, whichever separator the Host used.
 *
 * `node:path.dirname` is platform-bound, and this value crosses a wire: a job's
 * `outputPath` is joined by the Host's own fs adapter, which mixes `\` and `/` on
 * Windows. Splitting on both is the only correct reading of a path that may arrive
 * either way.
 * @param path - the path to cut.
 * @returns the directory part, or `''` when there is none.
 */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut <= 0) return ''
  return path.slice(0, cut)
}

/**
 * The directory one job should open.
 *
 * A job whose file landed in the configured directory opens exactly that — the path the
 * panel shows under 「下载到」. A file that landed deeper (a `filenameTemplate` with a
 * subdirectory in it) opens the subdirectory it is actually in, because that is the one
 * the user is looking for. A job with no file yet (running, cancelled, failed) opens the
 * configured directory, which is still the answer to "where is this going".
 * @param input - the job's output path, if it has one, and the configured directory.
 * @returns the directory to open.
 */
export function revealTargetFor(input: {
  readonly outputPath?: string | undefined
  readonly downloadDir: string
}): RevealTarget {
  const file = input.outputPath?.trim() ?? ''
  if (file === '') return { path: input.downloadDir }
  const parent = parentOf(file)
  return { path: parent === '' ? input.downloadDir : parent }
}

/** One file-manager argv pair, ready to spawn. */
export interface RevealCommand {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * How each platform's file manager is asked to open a directory.
 * @param platform - `process.platform` (taken as a parameter so all three are tested).
 * @param path - the directory to open.
 * @param env - the environment, for the Windows system directory.
 * @returns the command and its arguments.
 */
export function revealCommand(
  platform: string,
  path: string,
  env: Readonly<Record<string, string | undefined>> = {},
): RevealCommand {
  if (platform === 'win32') {
    // `explorer.exe` is not on every environment's PATH, and the system directory
    // always has it. No shell is involved, so a path with spaces travels intact.
    const root = env['WINDIR'] ?? env['SystemRoot'] ?? 'C:\\Windows'
    return { command: `${root}\\explorer.exe`, args: [path] }
  }
  if (platform === 'darwin') return { command: 'open', args: [path] }
  return { command: 'xdg-open', args: [path] }
}

/** How a reveal is launched; injected so tests never open a window. */
export type RevealExec = (command: string, args: readonly string[]) => Promise<void>

/**
 * Launch it and let go.
 *
 * Detached with ignored stdio: Explorer's launcher exits immediately after handing the
 * request to the running shell, and this process must not be kept alive (or killed
 * with) by a window the user may leave open for an hour.
 * @param command - the executable.
 * @param args - its arguments.
 */
export async function defaultRevealExec(command: string, args: readonly string[]): Promise<void> {
  const { spawn } = await import('node:child_process')
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
  // A failure here reaches the user as "nothing happened"; the panel's own message is
  // the honest report, and an unhandled `error` event would take the whole plugin down.
  child.on('error', () => { /* reported by the caller's own state, not thrown into the void */ })
  child.unref()
}

/**
 * Open one directory.
 * @param input - the directory, plus test seams for the platform, environment and launch.
 * @returns the command that was launched, so a caller can log or assert it.
 */
export async function revealPath(input: {
  readonly path: string
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly exec?: RevealExec
}): Promise<RevealCommand> {
  const command = revealCommand(
    input.platform ?? process.platform,
    input.path,
    input.env ?? process.env,
  )
  await (input.exec ?? defaultRevealExec)(command.command, command.args)
  return command
}
