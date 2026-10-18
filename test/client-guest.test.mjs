/**
 * The page-side machinery: what is harvested, which carrier is chosen, and how the
 * bytes are got out.
 *
 * The orchestration tests inject the guest's `run`, its clock and its sleep, so the
 * two transports and the watchdog between them are exercised WITHOUT a browser —
 * which is the only way they can be exercised here at all, since the Electron
 * `<webview>` path cannot be reproduced by the plain web harness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { carrierHint, carrierLabel, chooseCarrier, shouldFallBackToPage } from '../lib/test/client/carrier.js'
import { parseHarvest, pickMediaCandidates, describeHarvest, heightFromUrl, CANDIDATE_LIMIT } from '../lib/test/client/guest-harvester.js'
/** A base of facts for the carrier decision. */
function carrierInput(overrides = {}) {
  return {
    source: 'guest',
    downloadPath: 'auto',
    guestUsable: true,
    sameSite: true,
    ...overrides,
  }
}

test('under auto the host fetches first, and the page is the fallback', () => {
  // The order that was measured: on a real site the page carrier never delivered a byte
  // while the Host's own fetch pulled 104 MB in seven seconds. So `auto` — the default —
  // puts the Host first. There are only two carriers now: the picker offers whole files
  // only, so yt-dlp (which existed for `.m3u8`) has nothing left to fetch.
  assert.equal(chooseCarrier(carrierInput()), 'host')
  // `page` is the explicit "use my browser first" setting.
  assert.equal(chooseCarrier({ ...carrierInput(), downloadPath: 'page' }), 'guest')
  assert.equal(chooseCarrier({ ...carrierInput(), downloadPath: 'page', guestUsable: false }), 'host')
  // `host` never uses the page at all.
  assert.equal(chooseCarrier({ ...carrierInput(), downloadPath: 'host' }), 'host')
  // No usable page: the Host's own client is the only one left.
  assert.equal(chooseCarrier(carrierInput({ guestUsable: false })), 'host')
})

test('the page is offered a refused job once, and only when there is something to retry', () => {
  const refused = {
    status: 'failed',
    receivedBytes: 0,
    stopped: false,
    carrier: 'host',
    pageUsable: true,
    alreadyTried: false,
  }
  // The case this exists for: the Host's own fetch was refused, nothing was written,
  // and the page is there to inherit the browser's identity.
  assert.equal(shouldFallBackToPage(refused), true)
  // Cancelled is the user's decision, not a refusal.
  assert.equal(shouldFallBackToPage({ ...refused, status: 'cancelled' }), false)
  assert.equal(shouldFallBackToPage({ ...refused, status: 'done' }), false)
  // Bytes on disk belong to the carrier that wrote them: a second transport writing
  // the same name gives two files and one lie.
  assert.equal(shouldFallBackToPage({ ...refused, receivedBytes: 1 }), false)
  assert.equal(shouldFallBackToPage({ ...refused, stopped: true }), false)
  // A page job that failed has nowhere left to go.
  assert.equal(shouldFallBackToPage({ ...refused, carrier: 'guest' }), false)
  assert.equal(shouldFallBackToPage({ ...refused, pageUsable: false }), false)
  // And it happens once.
  assert.equal(shouldFallBackToPage({ ...refused, alreadyTried: true }), false)
})

test('the quality a `<source>` cannot report is read out of its URL', () => {
  // The reported bug, exactly: a page with three `<source>` children showed one row
  // labelled `720p` and two labelled `<source> · video/mp4` — so the 1080p row was
  // invisible and "why only 720p" looked like a limitation of the plugin. The quality
  // is in the file name; the QUERY is deliberately not inspected, because a signed
  // URL's token is full of digits and would produce a nonsense resolution.
  assert.equal(heightFromUrl('https://cdn.example.com/408455-1080p.mp4'), 1080)
  assert.equal(heightFromUrl('https://cdn.example.com/a/720P.mp4?x=1'), 720)
  assert.equal(heightFromUrl('https://cdn.example.com/v/9f8a7b'), undefined)
  assert.equal(heightFromUrl('https://cdn.example.com/a.mp4?secure=hIsui9pthtppu5T5dRJtZA==,1790823632'), undefined)
  assert.equal(heightFromUrl('not a url'), undefined)

  const candidates = pickMediaCandidates(parseHarvest({
    videos: [{ src: 'https://cdn.example.com/408455-720p.mp4' }],
    sources: [
      { src: 'https://cdn.example.com/408455-480p.mp4', type: 'video/mp4' },
      { src: 'https://cdn.example.com/408455-1080p.mp4', type: 'video/mp4' },
    ],
  }))
  // Highest first, because the picker preselects the first row.
  assert.deepEqual(candidates.map(candidate => candidate.height), [1080, 720, 480])
  assert.equal(candidates[0].label, '1080p · <source> · video/mp4')
  // A label that already names the height is not made to say it twice.
  assert.equal(candidates[1].label, '720p · 页面播放器')
})

test('every carrier says what it costs', () => {
  assert.equal(carrierLabel('guest'), '扩展下载')
  assert.equal(carrierLabel('host'), '本机直连')
  assert.match(carrierHint('guest', carrierInput()), /扩展/)
  assert.match(carrierHint('host', carrierInput()), /本程序/)
  // The hint for the default carrier promises the fallback, because that is what the
  // user is choosing between: "host, and then the page if the site says no".
  assert.match(carrierHint('host', carrierInput()), /自动改用扩展下载/)
  assert.ok(!carrierHint('host', carrierInput({ downloadPath: 'host' })).includes('自动改用页面'))
  assert.match(carrierHint('host', carrierInput({ downloadPath: 'host' })), /设置要求始终用本程序/)
})

test('a separated pair is always the Host’s job, whatever the user asked for', () => {
  // 「下载这一档」 means two files and a merge, and the page carrier can push exactly one URL.
  // Handing it over would save the video track alone — a silent film under the name of the
  // video the user asked for — so the preference is overridden rather than honoured.
  assert.equal(chooseCarrier(carrierInput({ needsMux: true })), 'host')
  assert.equal(chooseCarrier({ ...carrierInput({ needsMux: true }), downloadPath: 'page' }), 'host')
  assert.equal(chooseCarrier({ ...carrierInput({ needsMux: true }), downloadPath: 'page', sameSite: true }), 'host')
  // And the fallback, which exists to give a refused job to the page, must not do it: the
  // page cannot deliver this job at all.
  const refused = { status: 'failed', receivedBytes: 0, stopped: false, carrier: 'host', pageUsable: true, alreadyTried: false }
  assert.equal(shouldFallBackToPage({ ...refused, needsMux: true }), false)
  assert.equal(shouldFallBackToPage(refused), true, 'an ordinary row still falls back')

  // The row says which of the two jobs it is doing, and the hover text explains the cost.
  assert.equal(carrierLabel('host', true), '本机合并')
  assert.equal(carrierLabel('host', false), '本机直连')
  assert.equal(carrierLabel('guest', true), '扩展下载', 'a pair never reaches the page, but a label must not lie if it did')
  assert.match(carrierHint('host', carrierInput({ needsMux: true })), /ffmpeg/)
  assert.match(carrierHint('host', carrierInput({ needsMux: true })), /没声音/)
  assert.ok(!carrierHint('host', carrierInput({ needsMux: true })).includes('自动改用页面'))
})

test('pickMediaCandidates offers whole files only, highest quality first', () => {
  const candidates = pickMediaCandidates(parseHarvest({
    url: 'https://example.com/watch',
    videos: [{ src: 'https://cdn.example.com/stream/9f8.mp4', width: 1280, height: 720 }],
    og: [{ url: 'https://cdn.example.com/og.mp4', type: 'video/mp4' }],
    sources: [{ src: 'https://cdn.example.com/a.webm', type: 'video/webm' }],
    links: [{ href: 'https://cdn.example.com/download.mp4', text: '下载' }],
    perf: [
      { name: 'https://cdn.example.com/hls/master.m3u8', initiatorType: 'xmlhttprequest' },
      { name: 'https://cdn.example.com/hls/seg-0001.ts', initiatorType: 'xmlhttprequest' },
      { name: 'https://cdn.example.com/stream/9f8a7b?token=abc', initiatorType: 'xmlhttprequest' },
      { name: 'https://example.com/logo.png', initiatorType: 'img' },
    ],
    jsonLd: ['https://cdn.example.com/from-page-data.mp4'],
    // A page can define anything; none of it may crash the picking.
    nonsense: 42,
  }))
  const urls = candidates.map(candidate => candidate.url)
  // Every source that named an mp4/webm is a row; everything that is not a whole file —
  // the manifest, the fragment, the extension-less stream request, the image — is not.
  assert.deepEqual(urls, [
    'https://cdn.example.com/stream/9f8.mp4',
    'https://cdn.example.com/og.mp4',
    'https://cdn.example.com/a.webm',
    'https://cdn.example.com/from-page-data.mp4',
    'https://cdn.example.com/download.mp4',
  ])
  assert.ok(!urls.some(url => url.endsWith('.ts')), 'a fragment is not a download')
  assert.ok(!urls.some(url => url.endsWith('.m3u8')), 'a manifest is a list of files, not a file')
  assert.ok(!urls.some(url => url.endsWith('.png')))
  assert.equal(candidates[0].height, 720, 'the resolution the element reported rides the row')
  assert.match(candidates[0].label, /页面播放器/)
  // The container is named from the type attribute when the URL has none.
  assert.equal(pickMediaCandidates(parseHarvest({ sources: [{ src: 'https://cdn.example.com/x', type: 'video/webm' }] }))[0].ext, 'webm')
  assert.equal(pickMediaCandidates(parseHarvest({ videos: [{ src: 'blob:https://example.com/1' }] })).length, 0)
  assert.equal(pickMediaCandidates(parseHarvest({ videos: [{ src: 'data:video/mp4;base64,AA' }] })).length, 0)
  assert.equal(pickMediaCandidates(parseHarvest({ videos: [{ src: 'https://cdn.example.com/a.mp4' }] })).length, 1)
  assert.ok(pickMediaCandidates(parseHarvest({ perf: Array.from({ length: 500 }, (_, index) => ({ name: `https://cdn.example.com/${index}.mp4` })) })).length <= CANDIDATE_LIMIT)
  assert.deepEqual(pickMediaCandidates(parseHarvest(null)), [])
  assert.deepEqual(pickMediaCandidates(parseHarvest('nope')), [])
})

test('a site adapter answers first, and its rows carry what the site said', () => {
  // The shape a bilibili harvest comes back in: the page's own player is a blob (MSE)
  // and its real streams are fragments, so the DOM contributes nothing usable — the
  // adapter's `durl` answers are the only whole files on the page.
  const page = parseHarvest({
    url: 'https://www.bilibili.com/video/BV1LvYA6QEGP',
    title: '某个视频_哔哩哔哩_bilibili',
    videos: [{ src: 'blob:https://www.bilibili.com/9a1e' }],
    perf: [{ name: 'https://xy.bilivideo.com/upgcxcode/1/2/3/4-1-30280.m4s', initiatorType: 'fetch' }],
    site: {
      name: 'bilibili',
      title: '某个视频',
      notes: ['B 站：页面用自己这份登录态问了「投稿播放」接口，拿到 1 个整份 mp4（高清 1080P）'],
      candidates: [{
        url: 'https://cn-bj-se-01-05.bilivideo.com/upgcxcode/22/51/42352905122/42352905122-1-192.mp4?deadline=1&upsig=ab',
        ext: 'mp4',
        height: 1080,
        bytes: 48_408_844,
        label: 'bilibili 整份 mp4 · 高清 1080P',
        title: '某个视频',
      }],
    },
  })
  const candidates = pickMediaCandidates(page)
  assert.equal(candidates.length, 1, 'the fragment and the blob are still not downloads')
  assert.equal(candidates[0].url, page.site.candidates[0].url)
  assert.equal(candidates[0].height, 1080)
  assert.equal(candidates[0].bytes, 48_408_844)
  assert.equal(candidates[0].title, '某个视频')
  assert.match(candidates[0].label, /bilibili/)

  const report = describeHarvest(page, candidates)
  assert.equal(report.candidates, 1)
  assert.equal(report.mediaSourceVideos, 1, 'the MSE handle is still reported as such')
  assert.equal(report.site.name, 'bilibili')
  assert.match(report.site.notes.join(' '), /投稿播放/)

  // Nothing came back: the adapter's sentence is the ANSWER to "why is the list empty",
  // so it leads the refusals instead of being pushed off by the page's own noise.
  const dashOnly = parseHarvest({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    videos: [{ src: 'blob:https://www.bilibili.com/1' }],
    site: { name: 'bilibili', refused: ['B 站对这个视频只给 DASH 分离音视频（6 条视频轨 + 独立音轨）：没有整份文件，本插件不做合并'] },
  })
  const empty = describeHarvest(dashOnly, pickMediaCandidates(dashOnly))
  assert.match(empty.refused[0].why, /DASH/)
  assert.equal(empty.site.name, 'bilibili')
})

test('a site adapter’s answer is read defensively, whatever the page put in it', () => {
  // The answer now comes from the extension's background worker, but it is still a
  // cross-process value: a field can be the wrong type, an array can be a string, and the
  // name a row is saved as is page-authored text.
  assert.deepEqual(parseHarvest({ site: { name: 42, candidates: 'nope', notes: [1, 'ok'], refused: null } }).site,
    { notes: ['ok'], refused: [], candidates: [] })
  assert.equal(parseHarvest({ site: { title: 'x'.repeat(400), notes: ['n'] } }).site.title.length, 120)
  assert.equal(parseHarvest({ site: null }).site, undefined)
  assert.equal(parseHarvest({ site: [] }).site, undefined)
})

test('an MSE player with no whole file to offer yields no rows, and says why', () => {
  // The shape of a signed, streamed player: `<video src="blob:…">` (the real stream is
  // requested by script) and no media URL that names a container. This tool downloads
  // whole files only, so the list is empty — and the harvest report is what turns that
  // empty list into an answer, which is what 诊断 shows.
  const page = parseHarvest({
    videos: [{ src: 'blob:https://hanime.tv/9d1f' }],
    perf: [
      { name: 'https://cdn.example.com/stream/9f8a7b?token=abc', initiatorType: 'xmlhttprequest' },
      { name: 'https://example.com/api/views?id=1', initiatorType: 'xmlhttprequest' },
      { name: 'https://cdn.example.com/hls/master.m3u8', initiatorType: 'xmlhttprequest' },
      { name: 'https://cdn.example.com/seg-0001.ts', initiatorType: 'xmlhttprequest' },
    ],
  })
  const candidates = pickMediaCandidates(page)
  assert.deepEqual(candidates, [], 'a blob handle, a manifest, a fragment and a guessed stream URL are not downloads')
  const report = describeHarvest(page, candidates)
  assert.equal(report.candidates, 0)
  assert.equal(report.mediaSourceVideos, 1)
  assert.equal(report.evidence.perf, 4)
  assert.ok(report.refused.some(item => item.why.includes('分段')), 'the fragment is reported as seen-and-refused')
  assert.ok(report.refused.some(item => item.why.includes('清单')), 'so is the manifest')
  assert.ok(report.refused.some(item => item.url.startsWith('blob:')))
})

test('describeHarvest explains a page that has no media at all', () => {
  const page = parseHarvest({ url: 'https://example.com/a', title: '文章', links: [{ href: 'https://cdn.example.com/a.mp4' }] })
  const candidates = pickMediaCandidates(page)
  const report = describeHarvest(page, candidates)
  assert.equal(report.candidates, 1)
  assert.equal(report.mediaSourceVideos, 0)
  assert.deepEqual(report.evidence, { videos: 0, sources: 0, og: 0, links: 1, perf: 0, jsonLd: 0 })

  const empty = describeHarvest(parseHarvest({}), [])
  assert.equal(empty.candidates, 0)
  assert.deepEqual(empty.refused, [])
})

