/**
 * The permanent quality-ladder answer.
 *
 * The requirement: whenever a site offers several qualities and one of them cannot be
 * fetched as a whole file, the user must be TOLD — without opening 诊断, and without
 * guessing. The judging lives in `qualityLadder`/`siteQualityNotes`, which is why this is
 * a TypeScript test and not something that needs the sidebar browser.
 *
 * Every fixture here is a shape a page really produces: element heights, resource-timing
 * URLs, a site adapter's own list. None of them needs a request, which is the design
 * constraint the whole feature had to satisfy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeHarvest,
  parseHarvest,
  pickMediaCandidates,
  siteQualityNotes,
} from '../lib/test/client/guest-harvester.js'

/** The whole pipeline for one raw page: parse → pick → describe. */
function reportOf(raw) {
  const page = parseHarvest(raw)
  return describeHarvest(page, pickMediaCandidates(page))
}

/** Just the ladder, which is what most of these cases are about. */
function ladderOf(raw) {
  return reportOf(raw).quality
}

test('a page with one quality and a downloadable row is not worth a sentence', () => {
  // The failure mode this guards is noise: a hint on every single harvest would train the
  // user to ignore the one that matters.
  assert.equal(ladderOf({ videos: [{ src: 'https://cdn.test/clip-720p.mp4', height: 720 }] }), undefined)
  // The same, with the quality only in the URL.
  assert.equal(ladderOf({ videos: [{ src: 'https://cdn.test/clip-720p.mp4' }] }), undefined)
})

test('a page with nothing at all says nothing, rather than guessing a quality', () => {
  assert.equal(ladderOf({}), undefined)
  assert.equal(ladderOf({ title: 'no media here', links: [{ href: 'https://example.com/' }] }), undefined)
  // A resource that is not media is not evidence of a ladder either.
  assert.equal(ladderOf({ perf: [{ name: 'https://cdn.test/app.js', initiatorType: 'script' }] }), undefined)
})

test('the recorded bilibili case: 1080P+ exists, the whole file stops at 720P', () => {
  // Measured live on 2026-10-01: the whole-file channel answered `quality: 64` 高清 720P,
  // and the DASH answer listed the video's real ladder up to 112 (1080P+).
  const ladder = ladderOf({
    videos: [{ src: 'blob:https://www.bilibili.com/1' }],
    perf: [{ name: 'https://xy.bilivideo.com/upgcxcode/1-1-112.m4s', initiatorType: 'fetch' }],
    site: {
      name: 'bilibili',
      title: '某个视频',
      session: { login: false, vip: false },
      quality: {
        granted: 64,
        grantedText: '高清 720P',
        listed: [
          { quality: 112, text: '1080P 高码率' },
          { quality: 80, text: '1080P 高清' },
          { quality: 64, text: '高清 720P' },
          { quality: 32, text: '清晰 480P' },
        ],
      },
      candidates: [
        { url: 'https://xy.bilivideo.com/42352905122-1-192.mp4?deadline=1', ext: 'mp4', height: 720, bytes: 48_408_844, label: 'bilibili 整份 mp4 · 高清 720P', title: '某个视频' },
      ],
    },
  })
  assert.ok(ladder !== undefined, 'this is exactly the case the hint exists for')
  assert.equal(ladder.got, '高清 720P', 'the site’s own words, not a number invented here')
  assert.deepEqual(ladder.rungs.slice(0, 4), ['1080P 高码率', '1080P 高清', '高清 720P', '清晰 480P'])
  assert.ok(ladder.rungs.includes('720p'), 'and the rung the row itself carries is in the list')
  assert.match(ladder.why, /1080P 高码率/)
  // The line the user actually reads, on the surface.
  assert.match(ladder.hint, /站点另有 1080P 高码率/)
  assert.match(ladder.hint, /整份 mp4 只到 高清 720P/)
  assert.match(ladder.hint, /不合并/)
})

test('the site’s ladder above the rung is what makes the difference, not the row count', () => {
  // Same granted rung, but the video has 1080P: the sentence appears. Drop the higher
  // rungs and the very same page says nothing — the claim is about the site's list.
  const flat = ladderOf({
    site: {
      name: 'bilibili',
      quality: { granted: 64, grantedText: '高清 720P', listed: [{ quality: 64, text: '高清 720P' }, { quality: 16, text: '流畅 360P' }] },
      candidates: [{ url: 'https://cdn.test/a.mp4', ext: 'mp4', height: 720, label: '整份 mp4' }],
    },
  })
  assert.equal(flat, undefined)
})

test('several qualities and not one fetchable is said out loud', () => {
  // The MSE case: the player reports three qualities and its real stream is elsewhere, so
  // the list is empty. "Why is the list empty" needs the answer the most.
  const ladder = ladderOf({
    videos: [
      { src: 'blob:https://hanime.tv/1', height: 1080 },
      { src: 'blob:https://hanime.tv/2', height: 720 },
      { src: 'blob:https://hanime.tv/3', height: 480 },
    ],
  })
  assert.ok(ladder !== undefined)
  assert.deepEqual(ladder.rungs, ['1080p', '720p', '480p'])
  assert.match(ladder.hint, /有 3 个清晰度/)
  assert.match(ladder.hint, /一个都抓不到整份文件/)
  assert.match(ladder.hint, /\.mp4 直链/, 'and it says what the user can do instead')
})

test('a manifest and its fragments are named even when there is only one rung', () => {
  // A stream that has no quality vocabulary at all still has a SHAPE, and "the page only
  // ever requested a playlist and its parts" is the fact that explains an empty list.
  const ladder = ladderOf({
    perf: [
      { name: 'https://cdn.test/hls/master.m3u8', initiatorType: 'xmlhttprequest' },
      { name: 'https://cdn.test/hls/1080p/seg-1.ts', initiatorType: 'xmlhttprequest' },
      { name: 'https://cdn.test/hls/1080p/seg-2.ts', initiatorType: 'xmlhttprequest' },
    ],
  })
  assert.ok(ladder !== undefined)
  assert.match(ladder.why, /清单 与 2 个分段/)
  assert.match(ladder.hint, /分段\/清单流/)
  assert.deepEqual(ladder.rungs, ['1080p'], 'the one rung a URL named is still reported')
})

test('the ladder is capped, and never repeats a rung', () => {
  const ladder = ladderOf({
    videos: [
      { src: 'blob:https://x.test/1', height: 2160 },
      { src: 'blob:https://x.test/2', height: 1440 },
      { src: 'blob:https://x.test/3', height: 1080 },
      { src: 'blob:https://x.test/4', height: 720 },
      { src: 'blob:https://x.test/5', height: 480 },
      { src: 'blob:https://x.test/6', height: 360 },
      { src: 'blob:https://x.test/7', height: 240 },
      { src: 'blob:https://x.test/8', height: 2160 },
    ],
  })
  assert.equal(ladder.rungs.length, 6)
  assert.equal(new Set(ladder.rungs).size, 6, 'the same rung twice is not a ladder')
})

test('the granted rung is reported as unknown rather than invented', () => {
  // A row whose height nothing knows: the site said nothing, the element said nothing and
  // the URL says nothing. Claiming a number here would be the exact guess this feature
  // exists to avoid — the id→height map is a fallback for the adapter, not for this.
  const ladder = ladderOf({
    site: {
      name: 'bilibili',
      quality: {
        granted: 64,
        listed: [{ quality: 112, text: '1080P 高码率' }, { quality: 80, text: '1080P 高清' }],
      },
      candidates: [{ url: 'https://cdn.test/42352905122-1-192.mp4', ext: 'mp4', label: 'bilibili 整份 mp4' }],
    },
  })
  assert.ok(ladder !== undefined)
  assert.equal(ladder.got, '整份文件')
  assert.match(ladder.why, /整份文件这一路只到 整份文件/)
})

test('the session facts are sentences, and never conflate two different facts', () => {
  // 1. signed in, and the site named the membership
  assert.deepEqual(
    siteQualityNotes({ name: 'bilibili', session: { login: true, vip: true, label: '年度大会员' } }),
    ['浏览器会话已登录 B 站（年度大会员）'],
  )
  // 2. signed in, no membership
  assert.deepEqual(
    siteQualityNotes({ name: 'bilibili', session: { login: true, vip: false, label: '' } }),
    ['浏览器会话已登录 B 站（普通账号）'],
  )
  // 3. the site said nobody is signed in: a FACT, and it names the fix
  const signedOut = siteQualityNotes({ name: 'bilibili', session: { login: false, vip: false } })
  assert.equal(signedOut.length, 1)
  assert.match(signedOut[0], /未登录/)
  assert.match(signedOut[0], /登录后再读一次/)
  // 4. a session record that answered nothing usable is treated as no answer at all
  assert.deepEqual(siteQualityNotes({ name: 'bilibili', session: {} }), [])
  // 5. the adapter asked (it reported a quality) but the session question went unanswered
  const unknown = siteQualityNotes({ name: 'bilibili', quality: { granted: 64, grantedText: '高清 720P' } })
  assert.equal(unknown.length, 1)
  assert.match(unknown[0], /没能读到会话状态/)
  assert.match(unknown[0], /不猜/)
  // 6. no adapter ran: nothing to say about a session that was never asked about
  assert.deepEqual(siteQualityNotes(undefined), [])
  assert.deepEqual(siteQualityNotes({ name: 'other' }), [])
})

test('the session and quality blocks survive the realm crossing, bounded', () => {
  // Everything here came out of someone else's page through `executeJavaScript`, so a
  // hostile or merely odd value must be dropped field by field rather than truthy-coerced.
  const page = parseHarvest({
    site: {
      name: 'bilibili',
      session: { login: 'yes', vip: 1, label: 'x'.repeat(200) },
      quality: {
        granted: '64',
        grantedText: '  高清 720P  ',
        listed: [
          { quality: 112, text: '1080P 高码率' },
          { quality: -5, text: '' },
          { quality: 999_999 },
          { quality: 80, text: 'y'.repeat(50) },
          'not an object',
        ],
      },
    },
  })
  assert.deepEqual(page.site.session, { label: 'x'.repeat(24) }, 'a non-boolean is dropped, not coerced')
  assert.equal(page.site.quality.granted, undefined, 'a numeric string is not a number')
  assert.equal(page.site.quality.grantedText, '高清 720P', 'trimmed')
  assert.deepEqual(page.site.quality.listed, [
    { quality: 112, text: '1080P 高码率' },
    { quality: 80, text: 'y'.repeat(24) },
  ], 'an out-of-range quality is dropped, and a site-written label is bounded')
  // A `site` block with nothing usable in it is not a site block.
  assert.equal(parseHarvest({ site: { name: '' } }).site, undefined)
  assert.equal(parseHarvest({ site: 'bilibili' }).site, undefined)
  assert.equal(parseHarvest({ site: null }).site, undefined)
})
