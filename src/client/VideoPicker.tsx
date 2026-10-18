/**
 * `VideoPicker` — the list of whole files the current page is playing.
 *
 * One row per file: the name it will be saved as, its quality and size, who will fetch
 * it, and one button. There is no per-row quality choice any more because a row IS one
 * file — the page's own list is the choice, which is why the rows are sorted highest
 * quality first.
 *
 * Two requirements live here:
 *
 *   1. **Nothing downloads on its own.** These buttons are the only callers of
 *      `store.startDownload`, so a page can never write a file before the user says yes.
 *   2. **It asks before it replaces anything.** A refused download becomes one 覆盖/保留
 *      question — one answer for a whole batch, never one dialog per file.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { VideoEntry, VideoOption } from './api-types.js'
import { formatBytes, formatDuration } from './format.js'
import { batchTargets, conflictQuestion, initialSelections } from './picker-model.js'
import type { PendingConflict } from './picker-model.js'
import type { ActiveProbe, DownloaderStore } from './store.js'

/** Muted text, from the theme's own tokens. */
const MUTED = 'var(--dsw-alias-label-tertiary, #7d838f)'
/** A hairline between rows. */
const HAIRLINE = '1px solid var(--dsw-alias-border-l2, #3a3a44)'

/** A quiet button, for the per-row action. */
const QUIET_BUTTON: Record<string, string | number> = {
  flex: 'none',
  padding: '3px 10px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #3a3a44)',
  background: 'var(--dsw-alias-bg-layer-1, #0c0c10)',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12px',
}

/** Props for the picker. */
export interface VideoPickerProps {
  readonly store: DownloaderStore
  readonly probe: ActiveProbe
  readonly pageTitle?: string | undefined
}

/** The quality, size and container of one option, for the right-hand side of its row. */
export function optionDetail(option: VideoOption): string {
  const parts: string[] = []
  if (option.height !== undefined) parts.push(`${option.height}p`)
  parts.push(option.ext)
  const size = option.bytes ?? option.approxBytes
  if (size !== undefined) parts.push(formatBytes(size))
  return parts.join(' · ')
}

/** Render the picker: one row per downloadable file. */
export function VideoPicker({ store, probe, pageTitle }: VideoPickerProps): ReactNode {
  const entries = probe.record.entries
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [batchBusy, setBatchBusy] = useState(false)
  // Downloads the Host refused to start because a file is already there. A batch asks
  // ONCE for all of them: the button promised "全部下载", not "answer four dialogs".
  const [pending, setPending] = useState<readonly PendingConflict[]>([])
  const [answering, setAnswering] = useState(false)

  if (entries.length === 0) {
    return <div style={{ fontSize: '12px', color: MUTED }}>没有找到可整份下载的文件。</div>
  }

  const selection = initialSelections(entries)
  const batch = batchTargets(entries, selection)
  const question = pending.length === 0 ? undefined : conflictQuestion(pending, probe.record.url)

  const downloadAll = (): void => {
    if (batch.length === 0) return
    setBatchBusy(true)
    void (async () => {
      const refused: PendingConflict[] = []
      for (const target of batch) {
        const title = entries.find(entry => entry.id === target.entryId)?.title ?? probe.record.url
        const answer = await store.startDownload({ url: probe.record.url, entryId: target.entryId, formatId: target.formatId })
        if (answer?.conflict !== undefined) refused.push({ entryId: target.entryId, formatId: target.formatId, title, conflict: answer.conflict })
      }
      if (refused.length > 0) setPending(refused)
    })().finally(() => { setBatchBusy(false) })
  }

  /** Answer the question for every refused download at once. */
  const answerConflicts = (onConflict: 'overwrite' | 'keep'): void => {
    if (pending.length === 0) return
    setAnswering(true)
    void (async () => {
      const refusedAgain: PendingConflict[] = []
      for (const item of pending) {
        const answer = await store.startDownload({
          url: probe.record.url,
          entryId: item.entryId,
          formatId: item.formatId,
          onConflict,
        })
        // A file that appeared between the question and the answer comes back as a NEW
        // question rather than being answered by proxy.
        if (answer?.conflict !== undefined) refusedAgain.push({ ...item, conflict: answer.conflict })
      }
      setPending(refusedAgain)
    })().finally(() => { setAnswering(false) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }} data-dsh-video-downloader-picker="">
      {question !== undefined && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            marginBottom: '8px',
            padding: '8px 10px',
            borderRadius: '8px',
            background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d8a657) 12%, transparent)',
          }}
        >
          <div style={{ fontSize: '12px' }}>{question.heading}</div>
          {question.lines.map((line, index) => (
            <div key={index} style={{ fontSize: '11px', color: MUTED, wordBreak: 'break-all' }}>{line}</div>
          ))}
          {question.warning !== undefined && (
            <div style={{ fontSize: '11px', color: 'var(--dsw-alias-state-warning-primary, #d8a657)' }}>{question.warning}</div>
          )}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button type="button" disabled={answering} onClick={() => { answerConflicts('overwrite') }} style={QUIET_BUTTON}>覆盖</button>
            <button type="button" disabled={answering} onClick={() => { answerConflicts('keep') }} style={QUIET_BUTTON}>保留</button>
          </div>
          <div style={{ fontSize: '11px', color: MUTED }}>选「保留」不会动已有文件，本次不下载（会在任务里留下一行说明）。</div>
        </div>
      )}

      {entries.map((entry: VideoEntry, index) => {
        // One row per file, one file per row: the entry's options are already ranked
        // best-first by the Host, so the row offers the best of them and nothing else.
        const option = entry.options[0]
        const advice = option === undefined ? undefined : store.carrierAdvice(option)
        return (
          <div
            key={entry.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '7px 2px',
              borderTop: index === 0 ? 'none' : HAIRLINE,
            }}
          >
            <span
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }}
              title={entry.title}
            >
              {entry.title}
            </span>
            <span style={{ flex: 'none', fontSize: '11px', color: MUTED }}>
              {option === undefined
                ? (entry.durationSeconds === undefined ? '' : formatDuration(entry.durationSeconds))
                : optionDetail(option)}
            </span>
            {advice !== undefined && (
              <span
                style={{
                  flex: 'none',
                  fontSize: '11px',
                  color: advice.carrier === 'guest' ? 'var(--dsw-alias-state-success-primary, #7dd3a0)' : MUTED,
                }}
                title={advice.hint}
              >
                {advice.label}
              </span>
            )}
            {option === undefined ? (
              /*
                A row with nothing to fetch says WHY instead of offering a button. These
                rows exist on purpose — the Host lists a file it refused (a segmented
                stream, a page-only handle) so the user can see the page did contain one —
                and a dead button next to a blank detail is how "the plugin found nothing"
                becomes the wrong conclusion.
              */
              <span
                style={{ flex: 'none', maxWidth: '46%', fontSize: '11px', color: MUTED, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={entry.error ?? '这个地址没能解析出可整份下载的格式'}
              >
                {entry.error ?? '无法整份下载'}
              </span>
            ) : (
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => {
                  setBusy(entry.id)
                  void store.startDownload({ url: probe.record.url, formatId: option.id, entryId: entry.id }).then(answer => {
                    // A conflict means nothing was started: put the question on screen
                    // instead of pretending a download is under way.
                    if (answer?.conflict !== undefined) {
                      setPending([{ entryId: entry.id, formatId: option.id, title: entry.title, conflict: answer.conflict }])
                    }
                  }).finally(() => { setBusy(undefined) })
                }}
                style={QUIET_BUTTON}
              >
                {busy === entry.id ? '已开始' : '下载这个'}
              </button>
            )}
          </div>
        )
      })}

      {batch.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '8px', borderTop: HAIRLINE }}>
          <span style={{ flex: 1, fontSize: '11px', color: MUTED }}>
            {pageTitle === undefined ? '' : pageTitle}
          </span>
          <button type="button" disabled={batchBusy} onClick={downloadAll} style={QUIET_BUTTON}>
            {batchBusy ? '已提交…' : `全部下载（${batch.length}）`}
          </button>
        </div>
      )}
    </div>
  )
}
