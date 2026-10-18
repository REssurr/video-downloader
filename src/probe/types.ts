/**
 * The shape of one page harvest, as the media policy consumes it.
 *
 * Kept output-only (no DOM and no page-side detail leaks through) so the policy
 * stage and the stored record agree on one normalized model.
 */
import type { ProbeSource, VideoEntry } from '../shared/types.js'

/** A harvest outcome; a harvest that found nothing is a throw at the route, not a result here. */
export interface ProbeOutcome {
  /** Which engine produced the entries. */
  readonly source: ProbeSource
  /** One entry per video on the page (or one for a single video). */
  readonly entries: readonly VideoEntry[]
  /** Page title, when known. */
  readonly pageTitle?: string
  /** Human-readable notes: fallbacks taken, entries skipped, and so on. */
  readonly notes: readonly string[]
  /**
   * What the media policy withheld or folded, when it did anything at all.
   *
   * Absent means "this list is exactly what the site offers", which is the normal
   * case; present means the list is shorter than the site's own and the panel owes
   * the user a sentence about it. See `probe/policy.ts`.
   */
  readonly policy?: {
    readonly mp4Only: boolean
    readonly hidden: number
    readonly merged: number
  }
}
