/**
 * The picker's decision logic, kept out of the component.
 *
 * Two reasons this is a module and not three functions inside `VideoPicker`:
 *
 *   1. The preselection rule has to be assertable without a DOM. It used to be
 *      driven by the Host's rule decisions; with the rules gone it is simply "the
 *      best option the Host ranked first", but that is still a decision the panel
 *      makes once, per entry, and it is worth a test.
 *   2. Batch targets and the conflict question are pure functions over plain
 *      objects, so a recorded probe response is enough to test them.
 */
import type { DownloadConflict, VideoEntry } from './api-types.js'
import { formatBytes } from './format.js'

/**
 * Choose the initially selected option for one entry.
 *
 * The first option, which is the highest resolution: the Host ranks options
 * best-first when it builds the record (`guest-harvester.ts` sorts by height), so
 * "first" and "best" are the same thing and there is no second opinion to keep in
 * sync.
 * @param entry - the entry.
 * @returns the option id to preselect, or `undefined` when the entry has none.
 */
export function initialSelection(entry: VideoEntry): string | undefined {
  return entry.options[0]?.id
}

/**
 * Preselect one option per entry.
 * @param entries - the probed entries.
 * @returns a selection map keyed by entry id, which is exactly what the radio
 *   group state is.
 */
export function initialSelections(entries: readonly VideoEntry[]): Record<string, string | undefined> {
  const initial: Record<string, string | undefined> = {}
  for (const entry of entries) initial[entry.id] = initialSelection(entry)
  return initial
}

/** One entry's download: which video, and which of its formats. */
export interface DownloadTarget {
  readonly entryId: string
  readonly formatId: string
}

/**
 * Every download this page offers, one target per entry.
 *
 * This is what "download ALL the videos on this page" means: an entry contributes
 * exactly one target, at the option the user chose in the picker when that choice
 * is still present, and at the first (best) option otherwise — a payload the rules
 * have since changed under is exactly the case this fallback exists for, and it
 * outlived the rules.
 * @param entries - the probed entries.
 * @param selection - the picker's current per-entry option ids, when it has any.
 * @returns the targets, in entry order.
 */
export function batchTargets(
  entries: readonly VideoEntry[],
  selection: Readonly<Record<string, string | undefined>> = {},
): readonly DownloadTarget[] {
  const targets: DownloadTarget[] = []
  for (const entry of entries) {
    const preferred = selection[entry.id]
    const chosen = preferred !== undefined && entry.options.some(option => option.id === preferred)
      ? preferred
      : initialSelection(entry)
    if (chosen === undefined) continue
    targets.push({ entryId: entry.id, formatId: chosen })
  }
  return targets
}

/** One download the Host refused to start because a file is already there. */
export interface PendingConflict {
  readonly entryId: string
  readonly formatId: string
  readonly title: string
  readonly conflict: DownloadConflict
}

/** The last path segment, from either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** A compact `MM-DD HH:mm` stamp for a conflict line. */
function formatMoment(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The question to put on screen for a set of conflicts.
 *
 * Kept here rather than inline in the component because it encodes two rules the
 * user decided: ONE question covers a whole batch, and the answer is only ever
 * 覆盖 or 保留 — so the text has to carry everything needed to choose, including
 * the case that makes overwriting dangerous (a same-named file from a DIFFERENT
 * link) and the case where two entries of one batch would fight over one file.
 * @param pending - the refused downloads.
 * @param url - the URL being probed, to spot a clash between two videos.
 * @returns a heading and one line per conflicted download.
 */
export function conflictQuestion(
  pending: readonly PendingConflict[],
  url: string,
): { heading: string; lines: readonly string[]; warning?: string } {
  const lines = pending.map(item => {
    const { conflict } = item
    const facts = [formatBytes(conflict.existingBytes)]
    if (conflict.existingModifiedAt !== undefined) facts.push(formatMoment(conflict.existingModifiedAt))
    const parts = [`${item.title} → ${baseName(conflict.path)}（${facts.join('，')}）`]
    if (conflict.existingHeight !== undefined || conflict.incomingHeight !== undefined) {
      const existing = conflict.existingHeight === undefined ? '现有清晰度未知' : `现有 ${conflict.existingHeight}p`
      const incoming = conflict.incomingHeight === undefined ? '本次清晰度未知' : `本次 ${conflict.incomingHeight}p`
      parts.push(`${existing}，${incoming}`)
    }
    if (conflict.existingUrl !== undefined && conflict.existingUrl !== url) parts.push('同名文件来自另一个链接')
    return parts.join(' · ')
  })
  const paths = new Set(pending.map(item => item.conflict.path.toLowerCase()))
  const warning = paths.size < pending.length
    ? `注意：这批里有 ${pending.length - paths.size + 1} 个会写到同一个文件，覆盖后只会留下一份`
    : undefined
  return {
    heading: `${pending.length} 个文件已存在，要覆盖吗？`,
    lines,
    ...(warning === undefined ? {} : { warning }),
  }
}
