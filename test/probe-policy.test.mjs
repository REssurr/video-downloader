/**
 * Media-policy tests.
 *
 * The policy is the answer to "只提供可播放的 mp4", and its two halves fail in
 * opposite directions if they are wrong: hide too much and a perfectly good video
 * disappears with no explanation, hide too little and the user gets an `.ogg` (or
 * an mp4 with no audio) from a list that promised otherwise. So both directions
 * are pinned here, along with the escape hatch (`mp4Only: false` must be a no-op
 * that changes nothing at all).
 *
 * The duplicate-folding cases are taken from measured reality: Apple's public HLS
 * example really does declare 1080p nine times with identical codecs and a
 * different bitrate each.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMediaPolicy, foldSameResolution, isPlayableMp4 } from '../lib/test/probe/policy.js'

/** One option with sensible defaults. */
function option(overrides = {}) {
  return {
    id: 'x',
    title: 'T',
    ext: 'mp4',
    kind: 'muxed',
    source: 'guest',
    ...overrides,
  }
}

/** One entry wrapping the given options. */
function entry(options, overrides = {}) {
  return { id: 'e1', title: 'Video', url: 'https://page.test/watch', options, ...overrides }
}

/** One outcome wrapping the given entries. */
function outcome(entries) {
  return { source: 'guest', entries, notes: [] }
}

test('a muxed mp4 is offered', () => {
  assert.equal(isPlayableMp4(option()), true)
})

test('a video-only mp4 is refused: joining an audio track needs a muxer this app lacks', () => {
  const videoOnly = option({ id: '137', kind: 'video-only' })
  assert.equal(isPlayableMp4(videoOnly), false, 'without a muxer this cannot become a playable file')
})

test('a manifest is refused: it is a list of files, not a file', () => {
  assert.equal(isPlayableMp4(option({ ext: 'm3u8', kind: 'muxed' })), false)
  assert.equal(isPlayableMp4(option({ ext: 'm3u8', kind: 'video-only' })), false)
})

test('every non-mp4 container is refused, in any letter case', () => {
  for (const ext of ['webm', 'ogg', 'ogv', 'mkv', 'flv', 'mov', 'm4v', 'MP4 ']) {
    const expected = ext.trim().toLowerCase() === 'mp4'
    assert.equal(isPlayableMp4(option({ ext })), expected, `${ext} should be ${expected ? 'offered' : 'hidden'}`)
  }
})

test('the default policy hides the non-mp4 rows and says how many', () => {
  const effect = applyMediaPolicy(
    outcome([entry([
      option({ id: 'mp4-1', height: 720 }),
      option({ id: 'ogg-1', ext: 'ogv' }),
      option({ id: 'mp4-2', height: 1080 }),
    ])]),
    { mp4Only: true, canMerge: false },
  )

  assert.deepEqual(effect.outcome.entries[0].options.map(o => o.id), ['mp4-1', 'mp4-2'])
  assert.equal(effect.hidden, 1)
  assert.equal(effect.emptied, 0)
  assert.deepEqual(effect.outcome.policy, { mp4Only: true, hidden: 1, merged: 0 })
  assert.ok(effect.outcome.notes.some(note => note.includes('隐藏 1 个非 mp4')), JSON.stringify(effect.outcome.notes))
})

test('a video-only row goes too, and the note says why', () => {
  const effect = applyMediaPolicy(
    outcome([entry([
      option({ id: 'mp4-muxed', height: 360 }),
      option({ id: 'mp4-video-only', height: 1080, kind: 'video-only' }),
    ])]),
    { mp4Only: true, canMerge: false },
  )

  assert.deepEqual(effect.outcome.entries[0].options.map(o => o.id), ['mp4-muxed'])
  assert.equal(effect.hidden, 1)
  assert.ok(effect.outcome.notes.some(note => note.includes('无法直接播放')), JSON.stringify(effect.outcome.notes))
})

test('an entry that loses every row is KEPT, with the reason, instead of vanishing', () => {
  const effect = applyMediaPolicy(
    outcome([entry([option({ id: 'ogg-only', ext: 'ogg' })], { id: 'e-ogg', title: 'Only Ogg' })]),
    { mp4Only: true, canMerge: false },
  )

  const kept = effect.outcome.entries[0]
  assert.equal(effect.outcome.entries.length, 1, 'a video that was found must not disappear')
  assert.deepEqual(kept.options, [])
  assert.equal(kept.title, 'Only Ogg')
  assert.match(kept.error, /只提供 mp4/)
  assert.equal(effect.emptied, 1)
})

test('an entry error the engine already set is not overwritten', () => {
  const effect = applyMediaPolicy(
    outcome([entry([], { error: '该条目没有可下载的视频流' })]),
    { mp4Only: true, canMerge: false },
  )
  assert.equal(effect.outcome.entries[0].error, '该条目没有可下载的视频流')
})

test('same-resolution rows are folded, keeping the highest bitrate', () => {
  const effect = applyMediaPolicy(
    outcome([entry([
      option({ id: 'a', height: 1080, tbr: 4775 }),
      option({ id: 'b', height: 1080, tbr: 8366 }),
      option({ id: 'c', height: 1080, tbr: 6307 }),
      option({ id: 'd', height: 720, tbr: 3240 }),
    ])]),
    { mp4Only: true, canMerge: false },
  )

  assert.deepEqual(effect.outcome.entries[0].options.map(o => o.id), ['b', 'd'])
  assert.equal(effect.merged, 2)
  assert.deepEqual(effect.outcome.policy, { mp4Only: true, hidden: 0, merged: 2 })
})

test('the kept row holds its group position, so the best-first order survives', () => {
  const folded = foldSameResolution([
    option({ id: 'first-720', height: 720, tbr: 1000 }),
    option({ id: '1080-low', height: 1080, tbr: 4000 }),
    option({ id: '1080-high', height: 1080, tbr: 8000 }),
    option({ id: 'last-360', height: 360, tbr: 500 }),
  ])
  assert.deepEqual(folded.options.map(o => o.id), ['first-720', '1080-high', 'last-360'])
  assert.equal(folded.merged, 1)
})

test('an unknown resolution is never folded: two rows may be two different files', () => {
  const folded = foldSameResolution([
    option({ id: 'no-height-1', ext: 'mp4' }),
    option({ id: 'no-height-2', ext: 'mp4' }),
    option({ id: 'tall', height: 1080, tbr: 100 }),
  ])
  assert.deepEqual(folded.options.map(o => o.id), ['no-height-1', 'no-height-2', 'tall'])
  assert.equal(folded.merged, 0)
})

test('a missing bitrate never beats a known one, and muxed breaks a real tie', () => {
  assert.equal(foldSameResolution([
    option({ id: 'unknown', height: 1080 }),
    option({ id: 'known', height: 1080, tbr: 1 }),
  ]).options[0].id, 'known')

  assert.equal(foldSameResolution([
    option({ id: 'video-only', height: 1080, tbr: 5000, kind: 'video-only' }),
    option({ id: 'muxed', height: 1080, tbr: 5000, kind: 'muxed' }),
  ]).options[0].id, 'muxed', 'with identical bitrates the row that needs no merge wins')
})

test('with the policy off nothing is touched, not even the object identity', () => {
  const original = outcome([entry([option({ id: 'ogg', ext: 'ogg' }), option({ id: 'mp4' })])])
  const effect = applyMediaPolicy(original, { mp4Only: false, canMerge: false })

  assert.equal(effect.outcome, original, 'the same object comes back')
  assert.equal(effect.hidden, 0)
  assert.equal(effect.merged, 0)
  assert.equal(effect.emptied, 0)
  assert.equal(effect.outcome.entries[0].options.length, 2)
})

test('an empty entry list is not a special case', () => {
  const effect = applyMediaPolicy(outcome([]), { mp4Only: true, canMerge: false })
  assert.deepEqual(effect.outcome.entries, [])
  assert.equal(effect.hidden, 0)
  assert.deepEqual(effect.outcome.notes, [], 'no notes are invented for a page with nothing on it')
})

test('the engine notes are kept, and the policy notes are appended after them', () => {
  const original = { source: 'html', entries: [entry([option({ id: 'ogv', ext: 'ogv' })])], notes: ['静态解析'] }
  const effect = applyMediaPolicy(original, { mp4Only: true, canMerge: false })
  assert.equal(effect.outcome.notes[0], '静态解析')
  assert.ok(effect.outcome.notes.length > 1)
})

/**
 * The separated pair: the one row whose fate is decided by the MACHINE, not by the setting.
 *
 * A 视频轨 + 音轨 row is two downloads and an ffmpeg run, so it may be offered only where
 * that can happen. The filter therefore runs whatever `mp4Only` says — and it runs here,
 * before a click, so the failure is a sentence rather than a job that fetches a track and
 * then gives up.
 */
test('a pair is a normal row where a muxer exists, and is not even policy business', () => {
  const whole = option({ id: 'whole-720', height: 720, bytes: 48_408_844 })
  const pair = option({ id: 'pair-1080', height: 1080, approxBytes: 170_116_000, audioUrl: 'https://cdn.test/a.m4s' })
  const original = outcome([entry([whole, pair])])
  const effect = applyMediaPolicy(original, { mp4Only: true, canMerge: true })

  assert.deepEqual(effect.outcome.entries[0].options.map(o => o.id), ['whole-720', 'pair-1080'])
  assert.equal(effect.hidden, 0)
  assert.equal(effect.outcome, original, 'nothing was done, so not even the identity changes')
})

test('without a muxer the pair is withheld, and the note names the missing program', () => {
  const pair = option({ id: 'pair-1080', height: 1080, approxBytes: 170_116_000, audioUrl: 'https://cdn.test/a.m4s' })
  const effect = applyMediaPolicy(
    outcome([entry([option({ id: 'whole-720', height: 720 }), pair])]),
    { mp4Only: true, canMerge: false },
  )

  assert.deepEqual(effect.outcome.entries[0].options.map(o => o.id), ['whole-720'])
  assert.equal(effect.hidden, 1)
  assert.deepEqual(effect.outcome.policy, { mp4Only: true, hidden: 1, merged: 0 })
  assert.ok(effect.outcome.notes.some(note => note.includes('需要合并音视频轨')), JSON.stringify(effect.outcome.notes))
  assert.ok(effect.outcome.notes.some(note => note.includes('ffmpeg.exe')), JSON.stringify(effect.outcome.notes))
})

test('the machine-level filter does not depend on the mp4 setting', () => {
  // With `mp4Only` off the user asked for every format, and a pair is still refused: the
  // reason is not a preference, it is that this machine cannot produce that file at all.
  const pair = option({ id: 'pair-1080', height: 1080, audioUrl: 'https://cdn.test/a.m4s' })
  const effect = applyMediaPolicy(outcome([entry([option({ id: 'ogv', ext: 'ogv' }), pair])]), { mp4Only: false, canMerge: false })

  assert.deepEqual(effect.outcome.entries[0].options.map(o => o.id), ['ogv'], 'the ogg is untouched: only the pair needed a decision')
  assert.equal(effect.hidden, 1)
  assert.deepEqual(effect.outcome.policy, { mp4Only: false, hidden: 1, merged: 0 })
  assert.ok(effect.outcome.notes.some(note => !note.startsWith('只提供 mp4')), JSON.stringify(effect.outcome.notes))
})

test('an entry emptied by the missing muxer says that, not that a muxer does not exist', () => {
  // Two different sentences for two different machines: on the one WITH ffmpeg, "this app
  // has no muxer" would be a lie, and the fix the user needs is a different one.
  const withMuxer = applyMediaPolicy(outcome([entry([option({ id: 'v', kind: 'video-only' })])]), { mp4Only: true, canMerge: true })
  assert.match(withMuxer.outcome.entries[0].error, /没有配对的音轨/)
  assert.ok(!withMuxer.outcome.entries[0].error.includes('本机没找到的 ffmpeg'))

  const withoutMuxer = applyMediaPolicy(outcome([entry([option({ id: 'v', kind: 'video-only' })])]), { mp4Only: true, canMerge: false })
  assert.match(withoutMuxer.outcome.entries[0].error, /本机没找到的 ffmpeg/)
})

test('an entry emptied with the switch OFF never blames the mp4 setting', () => {
  // The only way into this branch with `mp4Only: false` is a separated pair on a machine
  // with no muxer. Quoting 「只提供 mp4」 here would tell the user a switch they turned off
  // is responsible — the exact lie this sentence was written to avoid.
  const pair = option({ id: 'pair-1080', height: 1080, audioUrl: 'https://cdn.test/a.m4s' })
  const effect = applyMediaPolicy(outcome([entry([pair])]), { mp4Only: false, canMerge: false })

  const reason = effect.outcome.entries[0].error
  assert.equal(effect.emptied, 1)
  assert.ok(!reason.includes('只提供 mp4'), `the switch is off, so it must not be quoted: ${reason}`)
  assert.match(reason, /ffmpeg/)
  assert.match(reason, /分离/)
  assert.ok(effect.outcome.notes.some(note => !note.startsWith('只提供 mp4')), JSON.stringify(effect.outcome.notes))
})

test('at one resolution a single file beats a pair, because it needs no merge', () => {
  // Both are 1080P, both are `muxed`, and neither has a bitrate to separate them. The pair
  // costs two downloads and an ffmpeg run for the same picture, so it is the one folded away.
  const folded = foldSameResolution([
    option({ id: 'pair', height: 1080, audioUrl: 'https://cdn.test/a.m4s', approxBytes: 900_000_000 }),
    option({ id: 'whole', height: 1080, bytes: 100_000_000 }),
  ])
  assert.deepEqual(folded.options.map(o => o.id), ['whole'])
  assert.equal(folded.merged, 1)
})
