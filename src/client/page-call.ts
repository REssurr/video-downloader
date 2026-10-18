/**
 * Calling into the page without waiting forever.
 *
 * `executeJavaScript` is the only channel to the sidebar page, and a script the page
 * never answers is indistinguishable from a slow one from this side. Both callers
 * have been bitten by the same thing — a page fetch that never came back left a
 * download job at 0 B until the engine's own 90-second watchdog, and would have left
 * the connectivity check spinning for just as long — so the bound lives here, used by
 * both, with the timer as a real one: it bounds real work, and the transfers' own
 * injected clock exists only to make the watchdog logic fast in tests.
 */

/** How long one ordinary page script may take before it counts as unanswered. */
export const PAGE_CALL_MS = 5_000

/**
 * Await one page call, but not forever.
 *
 * A call that *throws* keeps throwing — the reason a page call failed is worth more
 * than the timeout ("页面已经离开" is actionable, "no answer" is not). Only a call
 * that never settles becomes `undefined`.
 * @param work - the page call.
 * @param ms - how long it may take.
 * @returns its value, or undefined when it did not answer in time.
 */
export function answerWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => { resolve(undefined) }, ms)
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}
