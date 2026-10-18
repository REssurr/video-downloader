/**
 * Configuration persistence: defaults, validation, migration, atomic writes.
 *
 * Every failure mode is a RESULT, never a throw: a corrupt document falls back
 * to defaults and reports why, and an invalid field is repaired while the
 * original value is named in `issues`. A settings file the user edited by hand
 * must never be able to stop the app from loading.
 *
 * The filesystem is injected (`ConfigIo`) so the whole module is testable
 * without touching a real disk, and so the Electron main process can point it at
 * `app.getPath('userData')` with its own error handling.
 */
import type { DownloaderConfig } from './shared/types.js'
import { parseProxyValue } from './net/proxy.js'
import { DEFAULT_PORT } from './shared/wire.js'

/** The current on-disk schema revision. */
export const CONFIG_SCHEMA = 1

/** File name of the configuration document. */
export const CONFIG_FILE_NAME = 'config.json'

/** Injected filesystem surface (kept tiny and synchronous on purpose). */
export interface ConfigIo {
  /** Read a UTF-8 file, or `undefined` when it does not exist. */
  readFile(path: string): string | undefined
  /**
   * Write a UTF-8 file atomically (temp sibling + rename).
   * @throws when the write cannot be completed.
   */
  writeFileAtomic(path: string, contents: string): void
  /** Create a directory and its parents when missing. */
  ensureDir(path: string): void
  /** Join path segments with the platform separator. */
  join(...segments: string[]): string
}

/** A load outcome: always a usable config, plus what had to be repaired. */
export interface LoadedConfig {
  /** The validated, migrated configuration. */
  readonly config: DownloaderConfig
  /** Human-readable repairs, in the order they were applied. */
  readonly issues: readonly string[]
  /** Whether the file existed and parsed (used to seed on first run). */
  readonly existed: boolean
}

/** Default output template: the title, plus the container extension. */
export const DEFAULT_FILENAME_TEMPLATE = '%(title)s.%(ext)s'

/** Whether a value is a plain object we can read fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce to a finite number inside a range, or fall back. */
function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Coerce to a non-empty trimmed string, or fall back. */
function coerceString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Build the default configuration for a given download directory. */
export function defaultConfig(downloadDir: string): DownloaderConfig {
  return {
    schema: CONFIG_SCHEMA,
    downloadDir,
    filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    maxConcurrent: 1,
    // Empty proxy means "auto": the environment first, then the Windows system
    // proxy — the setting the app's own browser already uses.
    proxy: '',
    // "What did I just download" should have one answer the user can open. See
    // `probe/policy.ts` for what this actually withholds.
    mp4Only: true,
    // Options found inside the browser extension's page go back to that page; every
    // other option is fetched by this app (the client decides, because the app
    // cannot see the extension's tab).
    downloadPath: 'auto',
    // The extension cannot read a file to discover where this app listens, so the
    // port is a stable, user-visible number instead of a random one.
    port: DEFAULT_PORT,
  }
}

/**
 * Validate the proxy field.
 *
 * Accepts the keywords this app defines (`''`/`auto`/`system`, `off`) and any
 * `http(s)://host:port`, with a bare `host:port` read as HTTP — which is how
 * Windows stores it and how people paste it. Anything else is repaired to `auto`
 * and reported, because a silently ignored proxy value is exactly the failure
 * this setting exists to end.
 * @param value - the raw value.
 * @param issues - the repair log to append to.
 * @returns the accepted value.
 */
function coerceProxy(value: unknown, issues: string[]): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    issues.push('proxy 不是字符串，已改为自动')
    return ''
  }
  const raw = value.trim()
  if (raw === '') return ''
  const parsed = parseProxyValue(raw)
  if (parsed.auto === true) return ''
  if (parsed.off === true) return 'off'
  if (parsed.url !== undefined) return parsed.url
  issues.push(`proxy 无效（${parsed.invalid ?? raw}），已改为自动`)
  return ''
}

/**
 * Coerce a boolean flag.
 *
 * A string is refused rather than interpreted: `"false"` is truthy in JavaScript,
 * and a settings file written by hand (or by a future client that sends the switch
 * as text) must not be able to turn a filter ON by saying "false".
 * @param value - the raw value.
 * @param fallback - the default for this field.
 * @param issues - the repair log to append to.
 * @param field - the field name, for the message.
 * @returns the accepted boolean.
 */
function coerceBoolean(value: unknown, fallback: boolean, issues: string[], field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  issues.push(`${field} 不是 true/false，已改为 ${fallback ? 'true' : 'false'}`)
  return fallback
}

/**
 * Validate a whole document.
 * @param raw - the parsed JSON value.
 * @param fallbackDir - directory to use when the document names none.
 * @param _now - the injected clock. It used to stamp repaired rules; nothing needs a
 *   timestamp now, and the parameter is kept because every caller (and the app's
 *   injection seam) passes one.
 * @returns the config plus the repairs applied.
 */
export function normalizeConfig(raw: unknown, fallbackDir: string, _now: number): { config: DownloaderConfig; issues: string[] } {
  const issues: string[] = []
  if (!isRecord(raw)) {
    issues.push('配置根节点不是对象，已使用默认配置')
    return { config: defaultConfig(fallbackDir), issues }
  }

  const schema = raw.schema
  if (schema !== CONFIG_SCHEMA) {
    issues.push(`配置 schema ${String(schema)} 已升级到 ${CONFIG_SCHEMA}`)
  }

  const rawDir = coerceString(raw.downloadDir, fallbackDir)
  const downloadDir = rawDir

  const filenameTemplate = coerceString(raw.filenameTemplate, DEFAULT_FILENAME_TEMPLATE)
  if (isRecord(raw) && raw.filenameTemplate !== undefined && filenameTemplate !== raw.filenameTemplate) {
    issues.push('filenameTemplate 无效，已回退默认模板')
  }

  const maxConcurrent = coerceNumber(raw.maxConcurrent, 1, 1, 4)
  if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== maxConcurrent) {
    issues.push(`maxConcurrent 已修正为 ${maxConcurrent}（允许 1–4）`)
  }

  const proxy = coerceProxy(raw.proxy, issues)
  const mp4Only = coerceBoolean(raw.mp4Only, true, issues, 'mp4Only')

  const rawPath = raw.downloadPath
  const downloadPath: DownloaderConfig['downloadPath'] =
    rawPath === 'page' || rawPath === 'host' || rawPath === 'auto' ? rawPath : 'auto'
  if (rawPath !== undefined && rawPath !== downloadPath) {
    issues.push(`downloadPath 不认识「${String(rawPath)}」，已改为 auto（可用：auto、page、host）`)
  }

  const port = coerceNumber(raw.port, DEFAULT_PORT, 1024, 65_535)
  if (raw.port !== undefined && raw.port !== port) {
    issues.push(`port 已修正为 ${port}（允许 1024–65535）`)
  }

  return {
    config: {
      schema: CONFIG_SCHEMA,
      downloadDir,
      filenameTemplate,
      maxConcurrent,
      proxy,
      mp4Only,
      downloadPath,
      port,
    },
    issues,
  }
}

/**
 * Read and normalize the configuration.
 * @param io - the injected filesystem.
 * @param dir - the configuration directory.
 * @param fallbackDir - download directory used when the file names none.
 * @param now - the injected clock, passed through to {@link normalizeConfig}.
 * @returns the loaded configuration and its repair log.
 */
export function loadConfig(io: ConfigIo, dir: string, fallbackDir: string, now: number): LoadedConfig {
  const path = io.join(dir, CONFIG_FILE_NAME)
  let text: string | undefined
  try {
    text = io.readFile(path)
  } catch (error) {
    return {
      config: defaultConfig(fallbackDir),
      issues: [`读取配置失败，已使用默认配置：${error instanceof Error ? error.message : String(error)}`],
      existed: false,
    }
  }
  if (text === undefined) {
    return { config: defaultConfig(fallbackDir), issues: [], existed: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // A hand-edited file with a typo must not lose the user's directory, but it
    // also must not be overwritten silently: report and fall back.
    return {
      config: defaultConfig(fallbackDir),
      issues: [`配置文件不是合法 JSON，已使用默认配置：${error instanceof Error ? error.message : String(error)}`],
      existed: true,
    }
  }
  const { config, issues } = normalizeConfig(parsed, fallbackDir, now)
  return { config, issues, existed: true }
}

/**
 * Persist the configuration atomically.
 * @param io - the injected filesystem.
 * @param dir - the configuration directory.
 * @param config - the validated configuration.
 * @throws when the directory or file cannot be written.
 */
export function saveConfig(io: ConfigIo, dir: string, config: DownloaderConfig): void {
  io.ensureDir(dir)
  io.writeFileAtomic(io.join(dir, CONFIG_FILE_NAME), `${JSON.stringify(config, null, 2)}\n`)
}
