/**
 * The media policy: which discovered formats the app is willing to OFFER.
 *
 * This is deliberately a SEPARATE stage from probing. `probe()` answers "what does
 * this page offer", and `test/probe-index.test.mjs` pins that contract — a `.webm`
 * direct link is still detected as a video there. Whether the user is willing to
 * *receive* a webm is a policy, not a fact about the page, so it is applied once,
 * between the probe and everything that consumes it (the rule engine, the picker,
 * `download.start`).
 *
 * The setting is `mp4Only` and it means one thing to the user: "只提供可播放的
 * mp4". Two consequences follow from that sentence, and both live here:
 *
 *   1. A row is offered only if the download ENDS UP as a playable mp4. The
 *      container name alone is not enough — a `video-only` mp4 has no audio, and
 *      remuxing a manifest needs a muxer this program does not ship, so those rows
 *      are hidden rather than promised. A separated PAIR (`audioUrl`) is the one case
 *      that changed: when the app found ffmpeg it downloads both tracks and joins
 *      them, so the row is offered, and when it did not the row is hidden here — even
 *      with `mp4Only` off — because a row nobody can assemble is worse than no row at
 *      all.
 *   2. One row per RESOLUTION. A master playlist can declare 1080p nine times over
 *      with identical codecs and a different bitrate each (measured on Apple's
 *      public HLS example: 24 variants, 1080p ×9). Offering nine rows that differ
 *      only in a number the label does not even show is noise, not choice; the
 *      user asked for "different resolutions", so that is what survives.
 *
 * Pure: no clock, no IO, no config object. The caller supplies the one fact it
 * needs (the switch).
 */
import type { VideoEntry, VideoOption } from '../shared/types.js'
import type { ProbeOutcome } from './types.js'

/** The container every offered row must end up in. */
const MP4 = 'mp4'

/** The extension of a manifest rather than of a file. */
const PLAYLIST = 'm3u8'

/** The switch, plus the facts needed to judge one option. */
export interface MediaPolicy {
  /** Offer only formats that land as a playable mp4; `false` offers everything. */
  readonly mp4Only: boolean
  /**
   * Whether this machine found a muxer, so a 视频轨 + 音轨 pair can be joined.
   *
   * REQUIRED rather than optional on purpose: a caller that forgot it would silently hide
   * every merged row on a machine that had ffmpeg all along, and nothing would fail. The
   * app resolves it once (`resolveMuxer()`) and states the answer here.
   */
  readonly canMerge: boolean
}

/** What applying the policy did, for the record and the panel's one-line notice. */
export interface MediaPolicyEffect {
  /** The outcome to hand on; the input object itself when the policy is off. */
  readonly outcome: ProbeOutcome
  /** Rows that were not offered (non-mp4, or unplayable without a muxer). */
  readonly hidden: number
  /** Same-resolution rows folded into the one that was kept. */
  readonly merged: number
  /** Entries that had options and lost every one of them. */
  readonly emptied: number
}

/**
 * Whether one option can end up as a playable mp4.
 *
 * `video-only` and a manifest both need a merge this stage refuses — an audio track joined
 * on, or segments remuxed into a container — so both are refused. The `mp4`+`muxed` case
 * needs nothing: it is already what was asked for. A separated pair (`audioUrl`) is NOT
 * judged here, because whether it can be assembled is a fact about the machine rather than
 * about the option: {@link applyMediaPolicy} decides that one, and it does so even when
 * `mp4Only` is off.
 * @param option - the discovered option.
 * @returns whether the option may be offered.
 */
export function isPlayableMp4(option: VideoOption): boolean {
  const ext = option.ext.trim().toLowerCase()
  if (ext === PLAYLIST) return false
  if (ext !== MP4) return false
  return option.kind !== 'video-only'
}

/** Byte size when known, else the estimate, else nothing. */
function sizeOf(option: VideoOption): number {
  return option.bytes ?? option.approxBytes ?? -1
}

/**
 * The winner of two rows that claim the same resolution.
 *
 * Bitrate first, because that is the actual difference between them; a missing
 * bitrate sorts last rather than being read as zero. Then `muxed`, because a row
 * that needs no merge is the safer promise. Then a whole file over a separated pair:
 * at the same picture, one download beats two downloads and an ffmpeg run. Size, then
 * id, only to make the choice deterministic for the loser.
 * @param left - one candidate.
 * @param right - the other candidate.
 * @returns the row to keep.
 */
function preferred(left: VideoOption, right: VideoOption): VideoOption {
  const bitrate = (left.tbr ?? -1) - (right.tbr ?? -1)
  if (bitrate !== 0) return bitrate > 0 ? left : right
  if (left.kind !== right.kind) return left.kind === 'muxed' ? left : right
  if ((left.audioUrl === undefined) !== (right.audioUrl === undefined)) {
    return left.audioUrl === undefined ? left : right
  }
  const size = sizeOf(left) - sizeOf(right)
  if (size !== 0) return size > 0 ? left : right
  return left.id.localeCompare(right.id) <= 0 ? left : right
}

/**
 * Fold rows that differ only by bitrate into one per resolution.
 *
 * A row whose resolution is UNKNOWN is never folded: "no height reported" is not
 * evidence that two rows are the same stream — for the generic extractor it is
 * the normal state of two genuinely different files — so those rows all survive.
 * The kept row holds the position of the first row of its resolution, which keeps
 * the harvest's best-first order intact.
 * @param options - the already-filtered options of one entry.
 * @returns the surviving rows and how many were folded away.
 */
export function foldSameResolution(options: readonly VideoOption[]): { options: VideoOption[]; merged: number } {
  const kept: VideoOption[] = []
  const indexOfHeight = new Map<number, number>()
  let merged = 0

  for (const option of options) {
    if (option.height === undefined) {
      kept.push(option)
      continue
    }
    const index = indexOfHeight.get(option.height)
    if (index === undefined) {
      indexOfHeight.set(option.height, kept.length)
      kept.push(option)
      continue
    }
    const current = kept[index]
    if (current === undefined) {
      kept[index] = option
      continue
    }
    kept[index] = preferred(current, option)
    merged += 1
  }

  return { options: kept, merged }
}

/**
 * The sentence one emptied entry carries, which depends on why nothing survived.
 *
 * Two facts decide what may be claimed. `mp4Only` says whether the user asked for mp4
 * only, so its name may be quoted only when it is ON: with the switch OFF the entry can
 * only have been emptied by the machine-level pair filter, and blaming a setting the
 * user turned off is exactly the kind of lie this sentence exists to avoid. `canMerge`
 * then picks the reason — whether a muxer exists decides whether a separated pair is
 * even in play.
 *
 * `mp4Only: false, canMerge: true` is UNREACHABLE today: with both allowed, no option is
 * withheld, so an entry with options keeps at least one. It still gets a sentence rather
 * than `undefined`, so a future caller can never render an empty reason.
 * @param mp4Only - whether the user asked for mp4 only.
 * @param canMerge - whether this machine found a muxer.
 * @returns the reason the entry has no rows.
 */
function emptiedMessage(mp4Only: boolean, canMerge: boolean): string {
  if (mp4Only) {
    return canMerge
      ? '这个视频只有非 mp4 或纯视频轨的格式（纯视频轨没有配对的音轨，合并不出有声音的 mp4），已按「只提供 mp4」跳过'
      : '这个视频只有非 mp4、纯视频轨或音视频分离轨的格式（纯视频轨没有配对的音轨，分离轨要用本机没找到的 ffmpeg 合并），已按「只提供 mp4」跳过'
  }
  if (!canMerge) {
    return '这个视频只有分离的视频轨和音频轨：合并成一个 mp4 要用本机没找到的 ffmpeg，所以现在没有可以直接下载的文件'
  }
  return '这个视频没有可以直接下载的格式'
}

/**
 * Apply the media policy to a harvest outcome.
 * @param outcome - what the page reported.
 * @param policy - the switch, plus whether this machine can merge a pair.
 * @returns the outcome to hand on, plus what was done to it.
 */
export function applyMediaPolicy(outcome: ProbeOutcome, policy: MediaPolicy): MediaPolicyEffect {
  const notes: string[] = []
  const prefix = policy.mp4Only ? '只提供 mp4：' : ''
  let hiddenNotMp4 = 0
  let hiddenUnmergeable = 0
  let hiddenPairs = 0
  let merged = 0
  let emptied = 0

  const entries: VideoEntry[] = outcome.entries.map((entry) => {
    const offered: VideoOption[] = []
    for (const option of entry.options) {
      // A separated pair is playable only where a muxer exists — a fact about this machine
      // rather than about the option — so this check runs whatever the mp4 setting says.
      // Later is too late: the row would be offered, chosen, and then fail at the end of a
      // two-file download.
      if (option.audioUrl !== undefined && !policy.canMerge) {
        hiddenPairs += 1
        continue
      }
      if (policy.mp4Only && !isPlayableMp4(option)) {
        if (option.ext.trim().toLowerCase() === MP4 || option.ext.trim().toLowerCase() === PLAYLIST) {
          hiddenUnmergeable += 1
        } else {
          hiddenNotMp4 += 1
        }
        continue
      }
      offered.push(option)
    }

    // Folding is part of "one row per resolution", so it belongs to the mp4 setting alone.
    const folded = policy.mp4Only ? foldSameResolution(offered) : { options: offered, merged: 0 }
    merged += folded.merged

    if (folded.options.length === 0 && entry.options.length > 0) {
      emptied += 1
      // The card is KEPT with no rows and a reason: a harvest that found a video
      // and offered nothing would otherwise look like a harvest that found nothing.
      return { ...entry, options: [], error: entry.error ?? emptiedMessage(policy.mp4Only, policy.canMerge) }
    }
    if (folded.options.length === entry.options.length) return entry
    return { ...entry, options: folded.options }
  })

  if (hiddenNotMp4 > 0) notes.push(`${prefix}已隐藏 ${hiddenNotMp4} 个非 mp4 格式`)
  if (hiddenUnmergeable > 0) {
    notes.push(`${prefix}已隐藏 ${hiddenUnmergeable} 个无法直接播放的清晰度（纯视频轨或流式清单）`)
  }
  if (hiddenPairs > 0) {
    notes.push(policy.canMerge
      ? `${prefix}已隐藏 ${hiddenPairs} 个需要合并音视频轨的清晰度`
      : `${prefix}已隐藏 ${hiddenPairs} 个需要合并音视频轨的清晰度（本机没有找到 ffmpeg.exe，合并不了）`)
  }
  if (merged > 0) notes.push(`${prefix}同一清晰度的多个码率已合并，保留了码率最高的一个（共 ${merged} 个）`)
  if (emptied > 0) notes.push(`${prefix}有 ${emptied} 个视频没有可播放的 mp4，已留空并说明原因`)

  if (notes.length === 0) return { outcome, hidden: 0, merged: 0, emptied: 0 }

  const hidden = hiddenNotMp4 + hiddenUnmergeable + hiddenPairs
  return {
    outcome: {
      ...outcome,
      entries,
      notes: [...outcome.notes, ...notes],
      // Carried on the outcome so the record and the panel cannot disagree about
      // whether a shorter list was the site's doing or the setting's. Only present
      // when something WAS withheld or folded: a notice on every page is noise.
      policy: { mp4Only: policy.mp4Only, hidden, merged },
    },
    hidden,
    merged,
    emptied,
  }
}
