/**
 * One-time settings inheritance from the DSH plugin.
 *
 * The standalone app keeps its state in `%APPDATA%\video-downloader`, which on a
 * fresh install means "everything default" — including the download folder, which
 * the user had already chosen in the plugin. This module reads that plugin's
 * config document ONCE, takes only the fields that still mean the same thing, and
 * reports what it took. Nothing is ever written back to the plugin's directory,
 * and a missing or broken document is silently ignored.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DownloaderConfig } from '../shared/types.js'

/** The fields the standalone app shares with the plugin's document. */
export type LegacyConfig = Pick<DownloaderConfig, 'downloadDir' | 'filenameTemplate' | 'maxConcurrent' | 'proxy' | 'mp4Only' | 'downloadPath'>

/** A writable view of the fields being assembled field by field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** What the migration found. */
export interface LegacyResult {
  /** The fields worth adopting. */
  readonly config: Partial<LegacyConfig>
  /** One sentence per adopted field, for the panel's notices. */
  readonly notices: readonly string[]
}

/**
 * Read the plugin's settings, if they are there.
 *
 * Only the six fields above travel: `port` is new, and anything unknown in the
 * old document is ignored rather than carried over.
 * @returns the adopted fields, or undefined when there is nothing to adopt.
 */
export function legacyConfig(): LegacyResult | undefined {
  const home = process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'].trim() !== ''
    ? process.env['DSH_HOME'].trim()
    : join(homedir(), '.dsh')
  const path = join(home, 'video-downloader', 'config.json')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const config: Partial<Mutable<LegacyConfig>> = {}
  const notices: string[] = []
  const dir = record['downloadDir']
  if (typeof dir === 'string' && dir.trim() !== '') {
    config.downloadDir = dir.trim()
    notices.push(`已沿用原插件的下载目录：${dir.trim()}（在「设置」里可以改）`)
  }
  const template = record['filenameTemplate']
  if (typeof template === 'string' && template.trim() !== '') config.filenameTemplate = template.trim()
  const concurrent = record['maxConcurrent']
  if (typeof concurrent === 'number' && Number.isFinite(concurrent)) {
    config.maxConcurrent = Math.min(4, Math.max(1, Math.round(concurrent)))
  }
  const proxy = record['proxy']
  if (typeof proxy === 'string') config.proxy = proxy.trim()
  const mp4Only = record['mp4Only']
  if (typeof mp4Only === 'boolean') config.mp4Only = mp4Only
  const downloadPath = record['downloadPath']
  if (downloadPath === 'auto' || downloadPath === 'page' || downloadPath === 'host') config.downloadPath = downloadPath
  notices.push('以上设置继承自原 DSH 插件（只读复制，原文件未改动）')
  return { config, notices }
}
