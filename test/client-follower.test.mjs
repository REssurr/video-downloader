/**
 * The follower's decision function.
 *
 * `guest-follower.ts` is a timer plus three observations, and the interesting part is not
 * the timer: it is WHEN a read is due. That is `followerStep`, which is pure — a state, an
 * observation, and a settle window — so the rules that were wrong in the field can be
 * pinned here without a browser, a clock, or a timer:
 *
 *   1. a page that is still moving must not be read (the address the user just left would
 *      be read instead of the one they are on);
 *   2. a page that has been read must not be read again on every beat (half a second apart,
 *      forever);
 *   3. a page whose VIDEO changed without its address changing must be read again — the
 *      case the previous implementation could not see at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDRESS_POLL_MS,
  EMPTY_RETRY_MS,
  MAX_EMPTY_ATTEMPTS,
  MEDIA_PROBE_MS,
  SETTLE_MS,
  followerStep,
} from '../lib/test/client/guest-follower.js'

/** One observation at `now` of `address` (with an optional content fingerprint). */
const at = (now, address, media) => ({ now, ...(address === undefined ? {} : { address }), ...(media === undefined ? {} : { media }) })

/** The same, carrying what the read that just finished found. */
const readAt = (now, address, found) => ({ ...at(now, address), readFound: found })

/** Feed a list of observations through the step, returning the due ones. */
function run(observations, settleMs = SETTLE_MS) {
  let state = {}
  const due = []
  for (const observation of observations) {
    const step = followerStep(state, observation, { settleMs })
    state = step.state
    if (step.due) due.push(step.key)
  }
  return { state, due }
}

test('the poll is faster than the settle window, and both are sane', () => {
  // The numbers are a contract with the requirement ("reactive enough to feel immediate"):
  // a poll slower than the settle window would make the settle window the real latency,
  // and the in-page probe only runs while following, so it may be slower still.
  assert.equal(ADDRESS_POLL_MS, 500)
  assert.equal(SETTLE_MS, 300)
  assert.ok(ADDRESS_POLL_MS < MEDIA_PROBE_MS, 'the free probe must be the frequent one')
})

test('an unreadable page is never read, and leaves nothing remembered', () => {
  // A cross-origin iframe, or no sidebar page at all. Remembering the previous address
  // here would make the next readable page look "already read".
  const step = followerStep({ seen: 'https://a.test/1', pendingSince: 0, readKey: 'https://a.test/1' }, at(1_000, undefined), { settleMs: SETTLE_MS })
  assert.equal(step.due, false)
  assert.deepEqual(step.state, {})
  assert.equal(step.key, undefined)
})

test('a page that is still moving is not read yet', () => {
  // One navigation raises several events and a page can navigate again while it loads;
  // reading on the first observation reads the page the user just left (or a blank one).
  const first = followerStep({}, at(0, 'https://a.test/1'), { settleMs: SETTLE_MS })
  assert.equal(first.due, false)
  assert.equal(first.state.seen, 'https://a.test/1')
  assert.equal(first.state.pendingSince, 0)

  const early = followerStep(first.state, at(SETTLE_MS - 1, 'https://a.test/1'), { settleMs: SETTLE_MS })
  assert.equal(early.due, false)

  // A second move restarts the window: the settle rule is about the address standing
  // still, not about elapsed time since the first sighting.
  const moved = followerStep(early.state, at(100, 'https://a.test/2'), { settleMs: SETTLE_MS })
  assert.equal(moved.due, false)
  const stillEarly = followerStep(moved.state, at(399, 'https://a.test/2'), { settleMs: SETTLE_MS })
  assert.equal(stillEarly.due, false, 'the window restarted when the address changed')
  const settled = followerStep(stillEarly.state, at(400, 'https://a.test/2'), { settleMs: SETTLE_MS })
  assert.equal(settled.due, true)
  assert.equal(settled.key, 'https://a.test/2')
})

test('a settled page is read once, not on every beat', () => {
  // The poll runs twice a second for as long as the app is open. Without this rule a page
  // would be re-harvested (and its site adapter re-run) forever.
  const { due } = run([at(0, 'https://a.test/1'), at(400, 'https://a.test/1'), at(900, 'https://a.test/1'), at(1_400, 'https://a.test/1')])
  assert.deepEqual(due, ['https://a.test/1'])
})

test('the key is the ADDRESS, so a manual read is not repeated by the follower', () => {
  // The store records a manual 抓当前页 under the same key. Both readers therefore agree
  // that this address has been read, whichever of them read it.
  const step = followerStep({ seen: 'https://a.test/1', pendingSince: 0 }, at(1_000, 'https://a.test/1'), { settleMs: SETTLE_MS })
  assert.equal(step.due, true)
  assert.equal(step.key, 'https://a.test/1')
})

test('a player that swaps its video without moving is read again, under its own key', () => {
  // The case the address cannot see: an episode list that swaps the <video> source in
  // place. The fingerprint rides in the key, so the read is neither lost nor repeated.
  const first = followerStep({}, at(0, 'https://a.test/1', 'title\u0001a.mp4'), { settleMs: SETTLE_MS })
  const read = followerStep(first.state, at(400, 'https://a.test/1', 'title\u0001a.mp4'), { settleMs: SETTLE_MS })
  assert.equal(read.due, true)
  assert.equal(read.key, 'https://a.test/1', 'the address alone was the key of the first read')

  const same = followerStep(read.state, at(900, 'https://a.test/1', 'title\u0001a.mp4'), { settleMs: SETTLE_MS })
  assert.equal(same.due, false, 'the same content is not read twice')

  const swapped = followerStep(same.state, at(1_400, 'https://a.test/1', 'title\u0001b.mp4'), { settleMs: SETTLE_MS })
  assert.equal(swapped.due, true, 'the swapped video is a new read')
  assert.equal(swapped.key, 'https://a.test/1#title\u0001b.mp4')
  assert.equal(swapped.state.readMedia, 'title\u0001b.mp4', 'and it is remembered as the content that was read')

  // The same new content again: nothing to do.
  const again = followerStep(swapped.state, at(1_900, 'https://a.test/1', 'title\u0001b.mp4'), { settleMs: SETTLE_MS })
  assert.equal(again.due, false)
})

test('a probe that could not read the content does not trigger a re-read', () => {
  // The in-page probe is bounded and may simply not answer. That is not evidence that the
  // video changed, and treating it as such would re-read the page on every beat.
  const read = followerStep(
    followerStep({}, at(0, 'https://a.test/1', 'title\u0001a.mp4'), { settleMs: SETTLE_MS }).state,
    at(400, 'https://a.test/1', 'title\u0001a.mp4'),
    { settleMs: SETTLE_MS },
  )
  assert.equal(read.due, true)
  const noAnswer = followerStep(read.state, at(900, 'https://a.test/1'), { settleMs: SETTLE_MS })
  assert.equal(noAnswer.due, false)
})

test('an empty read is retried a few times, and then accepted', () => {
  // The user's complaint was 「当前页面的检测还是不太灵敏」, and this is the shape of it: a video
  // page whose player has not been created yet looks EXACTLY like a page with no video. The
  // read is therefore told to say which one it found, and an empty one is retried — without
  // the user pressing anything — before that conclusion is accepted.
  const options = { settleMs: SETTLE_MS }
  const url = 'https://a.test/1'
  let state = followerStep({}, at(0, url), options).state
  const keys = []
  let now = 400
  for (let beat = 0; beat < 7; beat += 1) {
    const step = followerStep(state, at(now, url), options)
    state = step.state
    if (step.due) keys.push(step.key)
    // ...and whatever it read came back with nothing.
    state = followerStep(state, readAt(now + 50, url, false), options).state
    now += EMPTY_RETRY_MS + 500
  }
  assert.deepEqual(keys, [url, `${url}#empty1`, `${url}#empty2`, `${url}#empty3`],
    `${MAX_EMPTY_ATTEMPTS} reads of an address that keeps finding nothing, then it stops`)
  assert.ok(EMPTY_RETRY_MS > ADDRESS_POLL_MS, 'the retry is spaced out, not every beat')

  // A read that DOES find something clears the count: the page is not "empty", it was late.
  const found = followerStep(state, readAt(now, url, true), options)
  assert.equal(found.state.emptyReads, 0)
  assert.equal(found.due, false, 'and a page that has been read is still not re-read on every beat')
})

test('a retry waits, and each retry is its own key', () => {
  // Two reasons this cannot be "read again immediately": the store remembers one read per
  // KEY, so a retry has to arrive under a different one; and a page that is merely slow must
  // not be hammered while it loads.
  const options = { settleMs: SETTLE_MS }
  const url = 'https://a.test/1'
  const first = followerStep({}, at(0, url), options).state
  const read = followerStep(first, at(400, url), options)
  assert.equal(read.due, true)
  assert.equal(read.key, url)

  const empty = followerStep(read.state, readAt(500, url, false), options)
  assert.equal(empty.state.emptyReads, 1)
  assert.equal(empty.due, false, 'not on the very next beat')

  const tooSoon = followerStep(empty.state, at(400 + EMPTY_RETRY_MS - 1, url), options)
  assert.equal(tooSoon.due, false, 'the pause is measured from the read, not from the failure')
  const retry = followerStep(tooSoon.state, at(400 + EMPTY_RETRY_MS, url), options)
  assert.equal(retry.due, true)
  assert.equal(retry.key, `${url}#empty1`, 'a key of its own, or the store would refuse it as a repeat')
})

test('a new address starts its own empty-read count', () => {
  // The previous page having nothing to say says nothing about the next one: an episode list
  // where one entry is a text page must still read the entry after it properly.
  const options = { settleMs: SETTLE_MS }
  const first = followerStep({}, at(0, 'https://a.test/1'), options).state
  const read = followerStep(first, at(400, 'https://a.test/1'), options).state
  const empty = followerStep(read, readAt(500, 'https://a.test/1', false), options).state
  assert.equal(empty.emptyReads, 1)

  const moved = followerStep(empty, at(600, 'https://a.test/2'), options)
  assert.equal(moved.state.emptyReads, undefined, 'the count belongs to the page that produced it')
  assert.equal(moved.due, false)
  const settled = followerStep(moved.state, at(1_000, 'https://a.test/2'), options)
  assert.equal(settled.due, true)
  assert.equal(settled.key, 'https://a.test/2', 'a first read of the new page, not a retry of the old one')
})

