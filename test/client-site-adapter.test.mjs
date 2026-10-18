/**
 * The bilibili adapter, called as the extension calls it.
 *
 * `bilibiliSite()` is the only reason a bilibili video can be downloaded at all: the site
 * plays through MSE and serves separate DASH tracks, so the DOM describes a video that
 * cannot be saved as one file — while the site's own API, called with the browser's own
 * session, hands over a whole mp4. The plugin used to build that adapter as a STRING and
 * evaluate it inside the page; the extension now imports it and calls it from its
 * background worker, so this test calls the REAL `extension-src/adapter/bilibili.ts` and
 * stubs only the two things the worker supplies: `fetch` and the page's address/title
 * (which the content script reads as `location.href` / `document.title`).
 *
 * The answers are the shapes measured live on 2026-10-01 (`BV1LvYA6QEGP`, cid 42352905122).
 * Everything after the adapter — parse, rank, explain — is the real app pipeline too, which
 * is what makes the 「为什么只有 720P」 assertion the acceptance criterion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bilibiliSite } from '../lib/test/ext/adapter/bilibili.js'
import {
  describeHarvest,
  parseHarvest,
  pickMediaCandidates,
  siteQualityNotes,
} from '../lib/test/client/guest-harvester.js'

/** The recorded view answer: the only place the per-part cid comes from in a worker. */
const VIEW = {
  code: 0,
  data: {
    bvid: 'BV1LvYA6QEGP',
    title: '某个视频_哔哩哔哩_bilibili',
    pages: [{ cid: 42_352_905_122, page: 1 }],
  },
}

/** The recorded whole-file answer: 720P, and only 720P/360P in the session's own list. */
const PLAY_720P = {
  code: 0,
  data: {
    quality: 64,
    accept_quality: [64, 16],
    accept_description: ['高清 720P', '流畅 360P'],
    timelength: 2_130_000,
    durl: [{ order: 1, size: 48_408_844, url: 'https://xy.bilivideo.com/42352905122-1-192.mp4?deadline=1' }],
  },
}

/** The recorded DASH answer: the video's REAL ladder, up to 1080P+. */
const PLAY_DASH = {
  code: 0,
  data: {
    accept_quality: [112, 80, 64, 32, 16],
    accept_description: ['1080P 高码率', '1080P 高清', '高清 720P', '清晰 480P', '流畅 360P'],
    dash: { duration: 2_130, video: [{ id: 112 }, { id: 80 }, { id: 64 }, { id: 32 }, { id: 16 }], audio: [{ id: 30280 }] },
  },
}

/**
 * The same DASH answer with real track addresses, as the site actually writes it.
 *
 * Two video tracks share 1080P — 高码率 (112) and 高清 (80) — which is the case that decides
 * how many rows a pair may become, and which of them wins. Two audio tracks is the same
 * question for the sound.
 */
const PLAY_DASH_TRACKS = {
  code: 0,
  data: {
    accept_quality: [112, 80, 64, 32, 16],
    accept_description: ['1080P 高码率', '1080P 高清', '高清 720P', '清晰 480P', '流畅 360P'],
    dash: {
      duration: 284,
      video: [
        { id: 112, baseUrl: 'https://xy.bilivideo.com/42352905122-1-112.m4s', bandwidth: 4_600_000, codecs: 'avc1.640032', width: 1920, height: 1080 },
        { id: 80, baseUrl: 'https://xy.bilivideo.com/42352905122-1-80.m4s', bandwidth: 2_400_000, codecs: 'avc1.640028', width: 1920, height: 1080 },
        { id: 64, baseUrl: 'https://xy.bilivideo.com/42352905122-1-64.m4s', bandwidth: 1_200_000, codecs: 'avc1.64001F', width: 1280, height: 720 },
        { id: 32, baseUrl: 'https://xy.bilivideo.com/42352905122-1-32.m4s', bandwidth: 600_000, codecs: 'avc1.64001E', width: 854, height: 480 },
      ],
      audio: [
        { id: 30216, baseUrl: 'https://xy.bilivideo.com/42352905122-1-30216.m4s', bandwidth: 64_000, codecs: 'mp4a.40.2' },
        { id: 30280, baseUrl: 'https://xy.bilivideo.com/42352905122-1-30280.m4s', bandwidth: 192_000, codecs: 'mp4a.40.2' },
      ],
    },
  },
}

/** The four answers a 720P video needs, when the Host can also merge. */
const MERGE_ANSWERS = [
  ['/x/web-interface/view', VIEW],
  ['fnval=16', PLAY_DASH_TRACKS],
  ['fnval=1', PLAY_720P],
  ['/x/web-interface/nav', { code: 0, data: { isLogin: true, vipStatus: 1, vip_label: { text: '年度大会员' } } }],
]

/**
 * Call the production adapter the way the extension's background worker does.
 * @param options - the page (its host, path and query), the API answers keyed by a URL
 *   substring, the page's `__INITIAL_STATE__` if it has one, and whether the Host can
 *   merge separated tracks — the three arguments production actually passes.
 * @returns the adapter's own answer, the harvest-shaped object the app stores, and every
 *   request the adapter made.
 */
async function runPage({ hostname = 'www.bilibili.com', pathname = '/video/BV1LvYA6QEGP', search = '', state, answers = [], canMerge = false } = {}) {
  const requests = []
  const fetchStub = async (url, init) => {
    requests.push({ url: String(url), credentials: init?.credentials, signal: init?.signal })
    for (const [match, answer] of answers) {
      if (String(url).includes(match)) {
        if (answer instanceof Error) throw answer
        if (typeof answer === 'string') return { status: 200, text: async () => answer }
        return { status: 200, text: async () => JSON.stringify(answer) }
      }
    }
    return { status: 404, text: async () => 'not found' }
  }
  // The page as the extension sees it. `harvestDom()` reads exactly these two fields, and
  // `background.ts` hands them to the adapter as `pageUrl` / `pageTitle` — so the test
  // supplies them the same way instead of reaching into the adapter's source.
  const locationStub = { hostname, pathname, search, href: `https://${hostname}${pathname}${search}` }
  const documentStub = { title: '某个视频_哔哩哔哩_bilibili', querySelectorAll: () => [] }
  const saved = { fetch: globalThis.fetch, window: globalThis.window, location: globalThis.location, document: globalThis.document, performance: globalThis.performance }
  const hadWindow = 'window' in globalThis
  globalThis.fetch = fetchStub
  globalThis.window = state === undefined ? {} : { __INITIAL_STATE__: state }
  globalThis.location = locationStub
  globalThis.document = documentStub
  globalThis.performance = { getEntriesByType: () => [] }
  try {
    const site = await bilibiliSite({ pageUrl: locationStub.href, pageTitle: documentStub.title, canMerge })
    // What the extension reports: `facts['site'] = (await bilibiliSite(...)) ?? null`.
    const raw = { url: locationStub.href, title: documentStub.title, site: site ?? null }
    return { site, raw, requests }
  } finally {
    globalThis.fetch = saved.fetch
    if (hadWindow) globalThis.window = saved.window
    else delete globalThis.window
    globalThis.location = saved.location
    globalThis.document = saved.document
    globalThis.performance = saved.performance
  }
}

/** The state a bilibili watch page carries — kept because production must NOT need it. */
const WATCH_STATE = {
  bvid: 'BV1LvYA6QEGP',
  cid: 42_352_905_122,
  videoData: { bvid: 'BV1LvYA6QEGP', cid: 42_352_905_122, title: '某个视频_哔哩哔哩_bilibili' },
}

/** The four answers a 720P video needs. Order matters: `fnval=16` is asked first here
 * because its URL also contains `fnval=1` as a substring. */
const RECORDED_ANSWERS = [
  ['/x/web-interface/view', VIEW],
  ['fnval=16', PLAY_DASH],
  ['fnval=1', PLAY_720P],
  ['/x/web-interface/nav', { code: -101, message: '账号未登录' }],
]

test('the recorded 720P video: one whole mp4, the session’s answer, and the real ladder', async () => {
  const { raw, site, requests } = await runPage({ state: WATCH_STATE, answers: RECORDED_ANSWERS })
  const page = parseHarvest(raw)
  assert.equal(site.name, 'bilibili')
  assert.equal(site.title, '某个视频', 'the tab string 「…_哔哩哔哩_bilibili」 is not a file name')
  assert.deepEqual(page.site.session, { login: false, vip: false }, '-101 IS an answer: nobody is signed in')
  assert.deepEqual(page.site.quality.listed, [
    { quality: 112, text: '1080P 高码率' },
    { quality: 80, text: '1080P 高清' },
    { quality: 64, text: '高清 720P' },
    { quality: 32, text: '清晰 480P' },
    { quality: 16, text: '流畅 360P' },
  ], 'the ladder comes from the DASH answer, which is the only place it exists')
  assert.equal(page.site.quality.granted, 64)
  assert.equal(page.site.quality.grantedText, '高清 720P', 'the site’s own description, not the id map')

  assert.equal(page.site.candidates.length, 1)
  const [only] = page.site.candidates
  assert.equal(only.ext, 'mp4')
  assert.equal(only.height, 720)
  assert.equal(only.bytes, 48_408_844)
  assert.equal(only.label, 'bilibili 整份 mp4 · 高清 720P')
  assert.equal(only.title, '某个视频')
  assert.match(page.site.notes[0], /拿到 1 个整份 mp4（高清 720P）/)

  // The page's own `__INITIAL_STATE__` carries the cid, and production still asks the view
  // API first: a background worker cannot read the page's globals, so the URL is its only
  // input and the view answer is its only cid.
  assert.equal(requests.length, 4, 'view, then the session + whole-file questions, then DASH')
  assert.match(requests[0].url, /^https:\/\/api\.bilibili\.com\/x\/web-interface\/view\?bvid=BV1LvYA6QEGP$/)
  assert.ok(requests.some(request => request.url.includes('/x/web-interface/nav')))
  assert.ok(requests.some(request => request.url.includes('fnval=1')))
  assert.ok(requests.some(request => request.url.includes('fnval=16')))
  // The session question and the whole-file question go out TOGETHER (the session does not
  // depend on the video): nav is started before the whole-file call is awaited.
  const navAt = requests.findIndex(request => request.url.includes('/x/web-interface/nav'))
  const wholeAt = requests.findIndex(request => request.url.includes('fnval=1'))
  assert.ok(navAt < wholeAt, 'the session question is not serialised behind the video question')
  // The DASH question follows only because 720P is below 1080P.
  assert.ok(requests.findIndex(request => request.url.includes('fnval=16')) > wholeAt)
  for (const request of requests.filter(one => one.url.includes('playurl'))) {
    assert.match(request.url, /qn=120/, 'the highest rung is asked for: a lower one cannot raise the answer')
  }
  for (const request of requests) assert.equal(request.credentials, 'include', 'the page’s own session is the whole point')
})

test('the user is TOLD the site has 1080P+ while the whole file stops at 720P', () => {
  // The end of the pipeline, and the requirement itself: no 诊断 drawer, no guessing, the
  // site's own two facts in one sentence.
  return runPage({ state: WATCH_STATE, answers: RECORDED_ANSWERS }).then(({ raw }) => {
    const page = parseHarvest(raw)
    const report = describeHarvest(page, pickMediaCandidates(page))
    assert.equal(report.candidates, 1, 'the row is there')
    assert.ok(report.quality !== undefined)
    assert.equal(report.quality.got, '高清 720P')
    assert.match(report.quality.hint, /站点另有 1080P 高码率/)
    assert.match(report.quality.hint, /整份 mp4 只到 高清 720P/)
    // And the session fact rides along, because "you are a guest" is the other half of the
    // answer to "why only 720P".
    assert.match(report.site.notes.join(' '), /未登录/)
    assert.deepEqual(siteQualityNotes(page.site), ['当前浏览器会话未登录 B 站：站点按游客档回答，在这个浏览器里登录后再读一次'])
  })
})

test('a 1080P whole file skips the DASH question entirely', async () => {
  // The cost contract: the second request is asked only when the answer came back below
  // 1080P. With a 1080P whole file in hand the ladder cannot change anything.
  const { raw, requests } = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', { code: 0, data: { ...PLAY_720P.data, quality: 80, accept_quality: [80, 64], accept_description: ['1080P 高清', '高清 720P'] } }],
      ['/x/web-interface/nav', { code: 0, data: { isLogin: true, vipStatus: 1, vip_label: { text: '年度大会员' } } }],
    ],
  })
  assert.equal(requests.length, 3, 'view + session + whole file, and nothing more')
  assert.ok(!requests.some(request => request.url.includes('fnval=16')), 'no DASH call for a 1080P whole file')
  const page = parseHarvest(raw)
  assert.equal(page.site.quality.grantedText, '1080P 高清')
  assert.deepEqual(page.site.session, { login: true, vip: true, label: '年度大会员' })
  assert.deepEqual(siteQualityNotes(page.site), ['浏览器会话已登录 B 站（年度大会员）'])
  const report = describeHarvest(page, pickMediaCandidates(page))
  assert.equal(report.quality, undefined, 'nothing to explain: the best whole file IS the top rung')
})

test('DASH-only: the refusal names the tracks, and the ladder still explains the video', async () => {
  // Some content has no whole-file channel at all. The count of video tracks is the site's
  // own answer to "but the player is playing it", and it must be in the refusal.
  const { raw } = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', PLAY_DASH],
      ['/x/web-interface/nav', { code: -101 }],
    ],
  })
  const page = parseHarvest(raw)
  assert.deepEqual(page.site.candidates, [], 'nothing whole to offer')
  assert.match(page.site.refused[0], /只给 DASH 分离音视频（5 条视频轨 \+ 独立音轨）/)
  // The copy is the app's own now: 本程序, not 本插件.
  assert.match(page.site.refused[0], /没有整份文件，本程序不做合并/)
  assert.match(page.site.refused[0], /站点为该视频列出的档位：1080P 高码率 \/ 1080P 高清 \/ 高清 720P/)

  const report = describeHarvest(page, pickMediaCandidates(page))
  assert.equal(report.candidates, 0)
  assert.ok(report.quality !== undefined)
  // Five listed rungs and no way to fetch any of them: that is the empty-list answer.
  assert.match(report.quality.hint, /一个都抓不到整份文件/)
  assert.match(report.refused[0].why, /只给 DASH 分离音视频/)
})

test('a bilibili page without a投稿号 says which page it is, without asking the API', async () => {
  const { raw, requests } = await runPage({ pathname: '/bangumi/play/ss12345', state: {} })
  const page = parseHarvest(raw)
  assert.match(page.site.refused[0], /没有投稿号/)
  assert.equal(requests.length, 0, 'there is nothing to ask about')
})

test('the view question comes first, even when the page’s state already knows the cid', async () => {
  // The plugin read `window.__INITIAL_STATE__` for the ids. The extension's worker cannot,
  // so production derives the bvid from the URL and always asks the view API for the cid —
  // and stops there when the answer is an error, because no cid means no playurl.
  const { raw, site, requests } = await runPage({
    state: WATCH_STATE,
    answers: [['/x/web-interface/view', { code: -404, message: '啥都木有' }]],
  })
  const page = parseHarvest(raw)
  assert.match(page.site.refused[0], /B 站投稿接口 code=-404：啥都木有/)
  assert.equal(requests.length, 1, 'and it stopped there: no playurl without a cid')
  assert.equal(site.name, 'bilibili')
  assert.equal(site.candidates, undefined, 'a page whose cid is unknown offers no row')
})

test('the cid is read from the page number the URL carries', async () => {
  // `?p=2` is how a multi-part video addresses its second part; the view answer lists the
  // pages in order, and the URL is the only place the part number survives in a worker.
  const played = await runPage({
    search: '?p=2',
    answers: [
      ['/x/web-interface/view', { code: 0, data: { pages: [{ cid: 111 }, { cid: 222 }] } }],
      ['fnval=1', PLAY_720P],
      ['/x/web-interface/nav', { code: -101 }],
    ],
  })
  assert.ok(played.requests.some(request => request.url.includes('cid=222')), 'the second part’s cid, not the first')
})

test('a multi-part video names each part, so two parts cannot share one file name', async () => {
  const parts = [1, 2].map(order => ({ order, size: 1_000 * order, url: `https://xy.bilivideo.com/p${order}-1-192.mp4` }))
  const { raw } = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', { code: 0, data: { ...PLAY_720P.data, durl: parts } }],
      ['/x/web-interface/nav', { code: -101 }],
    ],
  })
  const titles = parseHarvest(raw).site.candidates.map(candidate => candidate.title)
  assert.deepEqual(titles, ['某个视频（第1段）', '某个视频（第2段）'])
})

test('an API that throws, or answers with HTML, becomes a sentence in 诊断', async () => {
  const throwing = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', new Error('Failed to fetch')],
    ],
  })
  assert.match(parseHarvest(throwing.raw).site.refused[0], /取清晰度列表失败：Failed to fetch/)

  const html = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', '<html>502 Bad Gateway</html>'],
    ],
  })
  assert.match(parseHarvest(html.raw).site.refused[0], /取清晰度列表失败：HTTP 200（应答不是 JSON）/)

  // JSON `null` parses, but it is not an answer object: production says so in its own
  // words (the deleted page-side copy called this "not JSON", which it was).
  const nulled = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', 'null'],
    ],
  })
  assert.match(parseHarvest(nulled.raw).site.refused[0], /取清晰度列表失败：HTTP 200（应答不是对象）/)

  // The adapter must never take the harvest down with it, whatever the page does.
  assert.equal(parseHarvest(throwing.raw).site.name, 'bilibili')
})

test('a page on another host is not asked anything at all', async () => {
  const { raw, site, requests } = await runPage({ hostname: 'www.youtube.com', pathname: '/watch', state: { bvid: 'BV1LvYA6QEGP' } })
  assert.equal(site, undefined, 'the adapter’s own answer: not my site')
  assert.equal(raw.site, null, 'and the harvest reports no site block at all')
  assert.equal(requests.length, 0)
  // Even a page that merely MENTIONS bilibili.com in its hostname is not bilibili.
  const impostor = await runPage({ hostname: 'notbilibili.com', pathname: '/video/BV1LvYA6QEGP', state: WATCH_STATE })
  assert.equal(impostor.site, undefined)
  assert.equal(impostor.raw.site, null)
  assert.equal(impostor.requests.length, 0)
  // And a look-alike suffix is not the site either: the match is anchored at the label.
  const suffix = await runPage({ hostname: 'www.bilibili.com.evil.example', pathname: '/video/BV1LvYA6QEGP', answers: RECORDED_ANSWERS })
  assert.equal(suffix.site, undefined)
  assert.equal(suffix.requests.length, 0)
})

test('a merge-capable host gets the 1080P pair, above the 720P whole file', async () => {
  // The user's request, end to end: 「可否将更高清的分离流合并为mp4」. The site serves a 720P
  // whole file and a 1080P video track with a separate audio track — so the picker must
  // offer BOTH, best first, and the pair must carry the audio URL that makes it playable.
  const { raw } = await runPage({ state: WATCH_STATE, answers: MERGE_ANSWERS, canMerge: true })
  const page = parseHarvest(raw)
  const rows = pickMediaCandidates(page)

  assert.equal(rows.length, 2, 'the whole file AND the pair: the pair does not replace what works')
  const [pair, whole] = rows
  assert.equal(pair.height, 1080)
  assert.equal(pair.ext, 'mp4', 'the container the merge produces, not the .m4s the URL names')
  assert.equal(pair.audioUrl, 'https://xy.bilivideo.com/42352905122-1-30280.m4s', 'the richest audio track')
  assert.equal(pair.bytes, undefined, 'the pair does not exist yet, so a byte count would be a lie')
  assert.equal(pair.approxBytes, 170_116_000, '(4.6M + 192k) / 8 * 284s, reported as an estimate')
  assert.equal(pair.label, '1080p · bilibili 合并 · 1080P 高码率', 'the picker prefixes the resolution when the row does not state it in the shape it looks for')
  assert.equal(pair.title, '某个视频 · 1080P 高码率', 'the rung is in the name: the 720P file already owns 某个视频')
  assert.equal(whole.height, 720)
  assert.equal(whole.audioUrl, undefined)
  assert.equal(whole.bytes, 48_408_844)

  // ONE row per height: 112 and 80 are both 1080P, and the pair cannot be two looks of the
  // same picture. The richer track wins the tie.
  assert.equal(rows.filter(row => row.height === 1080).length, 1)
  assert.match(page.site.notes.join(' '), /另有 1 档更高的清晰度只有分离的视频轨与音轨/)
})

test('a separated pair is assembled from the tracks that actually have an address', async () => {
  // The richest audio track is the one that is USABLE, not the one with the biggest number:
  // a track the site listed without a URL cannot be downloaded, so the next one is used.
  // (The deleted page-side copy picked on bandwidth alone and then dropped the whole pair.)
  const dash = {
    code: 0,
    data: {
      accept_quality: [112, 80],
      accept_description: ['1080P 高码率', '1080P 高清'],
      dash: {
        duration: 100,
        video: [{ id: 112, baseUrl: 'https://xy.bilivideo.com/v-112.m4s', bandwidth: 4_600_000, codecs: 'avc1.640032', height: 1080 }],
        audio: [
          { id: 1, bandwidth: 999_000 },
          { id: 30280, baseUrl: 'https://xy.bilivideo.com/a-30280.m4s', bandwidth: 192_000 },
        ],
      },
    },
  }
  const { raw } = await runPage({
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', dash],
      ['fnval=1', { code: 0, data: { durl: [] } }],
      ['/x/web-interface/nav', { code: -101 }],
    ],
    canMerge: true,
  })
  const rows = pickMediaCandidates(parseHarvest(raw))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].audioUrl, 'https://xy.bilivideo.com/a-30280.m4s')
})

test('the pair is offered only above the whole file, never instead of it', async () => {
  // A 1080P whole file plus 1080P tracks: the pair would be the same picture at the cost of
  // two downloads and an ffmpeg run, so it is not a row. The site's own 1080P file is.
  const { raw, requests } = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH_TRACKS],
      ['fnval=1', { code: 0, data: { ...PLAY_720P.data, quality: 80, accept_quality: [80, 64], accept_description: ['1080P 高清', '高清 720P'] } }],
      ['/x/web-interface/nav', { code: 0, data: { isLogin: true, vipStatus: 1 } }],
    ],
    canMerge: true,
  })
  const page = parseHarvest(raw)
  const rows = pickMediaCandidates(page)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].audioUrl, undefined)
  assert.equal(rows[0].height, 1080)
  // But the DASH question IS asked now: with a muxer the answer is where a row can come
  // from, not only an explanation of a ceiling. That is the cost the option buys.
  assert.ok(requests.some(request => request.url.includes('fnval=16')))
  assert.equal(requests.length, 4)
})

test('without a muxer the pair is never offered, and the sentence says what to do', async () => {
  // The other half of the contract: a row this machine cannot assemble must not appear, and
  // the panel must explain the missing rows rather than leave the user guessing. The harvest
  // is told which machine it is on, so the two cases are two different pages.
  const { raw } = await runPage({ state: WATCH_STATE, answers: MERGE_ANSWERS })
  const page = parseHarvest(raw)
  const rows = pickMediaCandidates(page)
  assert.equal(rows.length, 1, 'the 720P whole file, and nothing that cannot be joined')
  assert.equal(rows[0].audioUrl, undefined)

  const report = describeHarvest(page, rows, { canMerge: false })
  assert.match(report.quality.hint, /站点另有 1080P 高码率/)
  assert.match(report.quality.hint, /不合并/)
  assert.match(report.quality.hint, /没找到 ffmpeg\.exe/)
  assert.match(report.quality.hint, /tools.{0,4}bin/)

  // The very same page, harvested on a machine WITH a muxer: the sentence promises the row
  // that exists, instead of the one that cannot be built.
  const capable = await runPage({ state: WATCH_STATE, answers: MERGE_ANSWERS, canMerge: true })
  const capableReport = describeHarvest(parseHarvest(capable.raw), pickMediaCandidates(parseHarvest(capable.raw)), { canMerge: true })
  assert.match(capableReport.quality.hint, /已提供合并下载/)
  assert.match(capableReport.quality.hint, /站点另有 1080P 高码率/)
})

test('a pair below the site’s ceiling still explains itself, instead of going silent', async () => {
  // Logged out, the pair is real but modest (the guest DASH answer tops out at 480P) while
  // the site's ladder goes to 1080P. Rows without a word about why would be the old failure
  // in a new place.
  const guestDash = {
    code: 0,
    data: {
      accept_quality: [112, 80, 64, 32, 16],
      accept_description: ['1080P 高码率', '1080P 高清', '高清 720P', '清晰 480P', '流畅 360P'],
      dash: {
        duration: 284,
        video: [{ id: 32, baseUrl: 'https://xy.bilivideo.com/g-32.m4s', bandwidth: 600_000, codecs: 'avc1.64001E', height: 480 }],
        audio: [{ id: 30280, baseUrl: 'https://xy.bilivideo.com/g-a.m4s', bandwidth: 192_000 }],
      },
    },
  }
  const { raw } = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', guestDash],
      ['fnval=1', PLAY_DASH],
      ['/x/web-interface/nav', { code: -101 }],
    ],
    canMerge: true,
  })
  const page = parseHarvest(raw)
  const rows = pickMediaCandidates(page)
  assert.equal(rows.length, 1, 'no whole file at all, so the pair is all there is')
  assert.equal(rows[0].height, 480)
  const report = describeHarvest(page, rows, { canMerge: true })
  assert.ok(report.quality !== undefined, 'a 480P row when the site lists 1080P must be explained')
  assert.match(report.quality.hint, /能合并下载到的最高档是 清晰 480P/)
  assert.match(report.quality.hint, /站点列出 1080P 高码率/)
})

test('a durl entry with no address of its own still uses the backup URL the site sent', async () => {
  // The deleted page-side copy only ever looked at `backup_url[0]`; the worker keeps that
  // fallback because a CDN host that refuses is normal and the row is otherwise lost.
  const { site } = await runPage({
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', PLAY_DASH],
      ['fnval=1', { code: 0, data: { ...PLAY_720P.data, durl: [{ order: 1, backup_url: ['https://backup.bilivideo.com/a.mp4'] }] } }],
      ['/x/web-interface/nav', { code: -101 }],
    ],
  })
  assert.equal(site.candidates.length, 1)
  assert.equal(site.candidates[0].url, 'https://backup.bilivideo.com/a.mp4')
  assert.equal(site.candidates[0].bytes, undefined, 'a size the answer did not carry is not invented')
})

test('a DASH answer with video tracks but no audio offers nothing, and says so', async () => {
  // Half a pair is a silent film. The adapter refuses it in the worker, where the fact lives.
  const silentDash = {
    code: 0,
    data: {
      accept_quality: [112, 80],
      accept_description: ['1080P 高码率', '1080P 高清'],
      dash: { duration: 284, video: [{ id: 112, baseUrl: 'https://xy.bilivideo.com/s-112.m4s', bandwidth: 4_600_000, codecs: 'avc1.640032', height: 1080 }], audio: [] },
    },
  }
  const { raw } = await runPage({
    state: WATCH_STATE,
    answers: [
      ['/x/web-interface/view', VIEW],
      ['fnval=16', silentDash],
      ['fnval=1', PLAY_720P],
      ['/x/web-interface/nav', { code: -101 }],
    ],
    canMerge: true,
  })
  const page = parseHarvest(raw)
  assert.equal(page.site.candidates.length, 1, 'only the whole file')
  assert.match(page.site.refused.join(' '), /没有可用的音轨地址/)
})
