/**
 * Following the browser tab, in real time.
 *
 * The old hosted-page build observed a `<webview>` element in its own document; this
 * standalone program has no such element, so the observation becomes "what tab does the
 * extension say the user is looking at". Everything else is unchanged, and deliberately
 * so: the interesting rules (wait for the address to hold still, read each page once,
 * re-read when the page's CONTENT moved without navigating, retry a read that
 * found nothing) live in {@link followerStep}, which is pure and unit-tested.
 *
 * Two speeds, for the same reason as before:
 *
 *   - {@link look} is the cheap half — read the extension's current tab and
 *     publish it. It runs on every beat and awaits nothing.
 *   - the read is the expensive half — ask the extension for a harvest, one at a
 *     time; a navigation that arrives while one is running is remembered, not lost.
 */
import { EMPTY_GUEST, type GuestCapabilities } from './extension-bridge.js'
import type { ExtensionGuest } from './extension-bridge.js'

/**
 * How often the extension's current tab is read.
 *
 * Half a second is the compromise between "reacts as I click" and not asking the
 * app for the same answer four times a second. A tab change also arrives as a
 * pushed event, which calls {@link GuestFollower.beat} immediately.
 */
export const ADDRESS_POLL_MS = 500

/** How long an address has to hold still before it is read. */
export const SETTLE_MS = 300

/** How often the page's own content is fingerprinted while following it. */
export const MEDIA_PROBE_MS = 1_500

/**
 * How long to wait before reading an address that found NOTHING again.
 *
 * A page whose player has not been created yet looks exactly like a page with no
 * video at all, so an empty read is treated as "too early until proven
 * otherwise" and retried a few times without the user asking.
 */
export const EMPTY_RETRY_MS = 1_500

/** How many times one address may be read while it keeps finding nothing. */
export const MAX_EMPTY_ATTEMPTS = 4

/** What the follower remembers between observations. */
export interface FollowerState {
  /** The address seen on the previous observation. */
  readonly seen?: string | undefined
  /** When the current address was first observed, for the settle rule. */
  readonly pendingSince?: number | undefined
  /** The address the last read was run for. */
  readonly readKey?: string | undefined
  /** The media fingerprint that read saw. */
  readonly readMedia?: string | undefined
  /** When that read was started, so an empty one can be retried after a pause. */
  readonly readAt?: number | undefined
  /** Consecutive reads of this address that found nothing. */
  readonly emptyReads?: number | undefined
}

/** One observation of the browser tab. */
export interface FollowerInput {
  /** The address the page is on, or undefined when it cannot be read at all. */
  readonly address?: string | undefined
  /** The page's own content fingerprint, when the extension reported one. */
  readonly media?: string | undefined
  readonly now: number
  /** What a read that JUST finished found, when one did. */
  readonly readFound?: boolean | undefined
}

/** What one observation decided. */
export interface FollowerStep {
  readonly state: FollowerState
  /** Whether a read is due now. */
  readonly due: boolean
  /** The key the read should be recorded under. */
  readonly key?: string | undefined
}

/** The windows {@link followerStep} obeys. */
export interface FollowerOptions {
  /** How long an address must hold still before it is read. */
  readonly settleMs: number
  /** How long to wait before retrying a read that found nothing. */
  readonly emptyRetryMs?: number
  /** How many reads one address may have while finding nothing. */
  readonly maxEmptyAttempts?: number
}

/**
 * Decide whether the page should be read again.
 *
 * Pure on purpose: the interesting rules are the ones worth testing, and they are
 * testable here without a browser, a clock or a timer.
 * @param state - what the previous observation remembered.
 * @param input - this observation, including what the last read found.
 * @param options - the settle window and the empty-read retry rules.
 * @returns the next state, whether a read is due, and the key to record it under.
 */
export function followerStep(
  state: FollowerState,
  input: FollowerInput,
  options: FollowerOptions,
): FollowerStep {
  if (input.address === undefined) {
    // Unreadable (no tab, or the extension is gone): nothing to follow, and
    // nothing worth remembering — the next readable address is a fresh start.
    return { state: {}, due: false }
  }

  // The read's own verdict, folded in before anything is decided: it is about the
  // address that was read, which is the address we are still on.
  const prior: FollowerState = input.readFound === undefined
    ? state
    : { ...state, emptyReads: input.readFound ? 0 : (state.emptyReads ?? 0) + 1 }

  if (input.address !== prior.seen) {
    // Still moving: start the settle window over.
    return { state: { ...prior, seen: input.address, pendingSince: input.now, emptyReads: undefined }, due: false }
  }

  const settled = prior.pendingSince !== undefined && input.now - prior.pendingSince >= options.settleMs
  const readThisAddress = prior.readKey === input.address
  const mediaMoved = readThisAddress
    && prior.readMedia !== undefined
    && input.media !== undefined
    && prior.readMedia !== input.media

  if (readThisAddress && !mediaMoved) {
    // Already read, and the content did not say otherwise: the settle rule must
    // not turn into a read every {@link ADDRESS_POLL_MS}.
    //
    // Unless that read found NOTHING: then this may be a player that had not
    // started yet, and one more look — a few times, spaced out — is what turns
    // "no rows and nothing ever happens" into the rows the user was waiting for.
    const empty = prior.emptyReads ?? 0
    const maxAttempts = options.maxEmptyAttempts ?? MAX_EMPTY_ATTEMPTS
    const waited = prior.readAt !== undefined && input.now - prior.readAt >= (options.emptyRetryMs ?? EMPTY_RETRY_MS)
    if (empty > 0 && empty < maxAttempts && waited) {
      return {
        state: { ...prior, readAt: input.now, emptyReads: empty },
        due: true,
        key: `${input.address}#empty${empty}`,
      }
    }
    return { state: prior, due: false }
  }
  if (!settled && !mediaMoved) return { state: prior, due: false }

  return {
    state: {
      seen: input.address,
      pendingSince: input.now,
      readKey: input.address,
      readAt: input.now,
      ...(prior.emptyReads === undefined ? {} : { emptyReads: prior.emptyReads }),
      ...(input.media === undefined ? {} : { readMedia: input.media }),
    },
    due: true,
    key: mediaMoved ? `${input.address}#${input.media ?? ''}` : input.address,
  }
}

/** The page the follower can see right now. */
export interface FollowerPage {
  /** The tab a download could be handed to. */
  readonly guest: ExtensionGuest
  /** That tab's address. */
  readonly url: string
  /** Its title, when the extension read one. */
  readonly title?: string | undefined
  /** The page's own content fingerprint, when the extension reported one. */
  readonly media?: string | undefined
}

/** What the follower needs from the store. Kept small so the loop can be tested. */
export interface FollowerTarget {
  /** Whether the app should be reading this page as it changes. */
  readonly following: () => boolean
  /** What the extension says is on screen, or undefined when it says nothing. */
  readonly page: () => FollowerPage | undefined
  /** Publish the page the app can see, or that it can see none. */
  readonly publish: (source: ExtensionGuest | undefined) => void
  /**
   * The page settled on an address: read it (the store applies its own rules).
   * @returns whether the read found anything, which is what an empty-read retry
   *   is for.
   */
  readonly settled: (input: { readonly url: string; readonly title?: string; readonly key?: string }) => Promise<boolean>
}

/** What a running follower exposes. */
export interface GuestFollower {
  /** Look now (a pushed tab event), rather than waiting for the next beat. */
  beat(): void
  /** Stop the timer and detach. */
  stop(): void
}

/**
 * Watch the browser tab for as long as the app lives.
 *
 * Started from the app's own activation rather than from the panel: the rows must
 * already be current when the window is looked at, and a page that changes while
 * the window is minimised must not come back as rows for a video nobody is
 * watching.
 * @param target - the store's side of the loop.
 * @returns the running follower.
 */
export function startGuestFollower(target: FollowerTarget): GuestFollower {
  let state: FollowerState = {}
  let lastProbe = 0
  /** Whether a read is in flight; a second one would double-count the settle window. */
  let reading = false
  /** Set when a tab event arrived while a read was in flight. */
  let missed = false
  let stopped = false

  /** The page the app can see right now, or undefined. */
  const look = (): FollowerPage | undefined => {
    const page = target.page()
    if (page === undefined) {
      target.publish(undefined)
      state = followerStep(state, { now: Date.now() }, { settleMs: SETTLE_MS }).state
      return undefined
    }
    target.publish(page.guest)
    return page
  }

  /** Probe, decide, and hand the page to the store — one at a time. */
  const read = async (page: FollowerPage, force: boolean): Promise<void> => {
    if (reading) {
      // A navigation is a one-shot signal and would otherwise be lost; the
      // periodic beat fires again in half a second, so it is not remembered.
      if (force) missed = true
      return
    }
    reading = true
    try {
      const now = Date.now()
      let media = page.media
      if (!force && (now - lastProbe) < MEDIA_PROBE_MS) media = state.readMedia
      lastProbe = now
      const step = followerStep(
        state,
        { address: page.url, ...(media === undefined ? {} : { media }), now: Date.now() },
        { settleMs: SETTLE_MS },
      )
      state = step.state
      if (!step.due) return
      const found = await target.settled({
        url: page.url,
        ...(page.title === undefined || page.title === '' ? {} : { title: page.title }),
        ...(step.key === undefined ? {} : { key: step.key }),
      })
      // The read's own verdict goes back into the rules: an empty page may simply
      // be a page whose player has not started yet.
      state = followerStep(state, { address: page.url, now: Date.now(), readFound: found === true }, { settleMs: SETTLE_MS }).state
    } catch (error) {
      console.warn('[video-downloader] 读取浏览器页面失败：', error)
    } finally {
      reading = false
      if (missed) {
        missed = false
        beat(true)
      }
    }
  }

  /**
   * One beat: look at the page, then let a settled page be read.
   * @param force - a pushed tab event asks for an immediate read.
   */
  const beat = (force = false): void => {
    if (stopped) return
    try {
      const page = look()
      if (page === undefined) return
      void read(page, force)
    } catch (error) {
      console.warn('[video-downloader] 观察浏览器页面失败：', error)
    }
  }

  const timer = setInterval(() => { beat(false) }, ADDRESS_POLL_MS)
  beat(true)
  return {
    beat: () => { beat(true) },
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** What an extension-less app shows: kept here so every caller says the same. */
export const NO_EXTENSION: GuestCapabilities = EMPTY_GUEST
