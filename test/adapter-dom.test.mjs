/**
 * Reading a page from inside it: the content script's half of a harvest.
 *
 * `extension-src/adapter/dom.ts` is what the extension's content script runs in the page
 * (`content.ts` → `sendResponse({ value: harvestDom() })`). It used to be a string the
 * plugin evaluated; it is ordinary code now, so these tests import it and hand it the page
 * through minimal hand-written globals — no jsdom, because the only DOM surface this file
 * is allowed to touch is the one asserted below. Anything it starts needing beyond that is
 * a change worth noticing.
 *
 * Every read is wrapped in the implementation (`one hostile page must not take the whole
 * harvest down`), so the last test here is the one that keeps that promise honest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, harvestDom } from '../lib/test/ext/adapter/dom.js'

/** One `<video>`: the fields the adapter reads, plus its own `<source>` children. */
function videoStub(fields = {}, sources = []) {
  return {
    currentSrc: '',
    src: '',
    duration: Number.NaN,
    videoWidth: 0,
    videoHeight: 0,
    ...fields,
    querySelectorAll: selector => (selector === 'source' ? sources : []),
    querySelector: selector => (selector === 'source[src]' ? (sources.find(source => typeof source.src === 'string' && source.src !== '') ?? null) : null),
  }
}

/** One `<meta property=… content=…>`. */
function metaStub(content, property) {
  return {
    getAttribute: name => (name === 'content' ? content : (name === 'property' ? property : null)),
  }
}

/**
 * Run the page's globals for the length of one call.
 *
 * The order of the selectors an implementation asks for is not part of the contract, so the
 * answers are keyed by selector and unknown selectors return nothing — except in the
 * hostile cases, which make one selector throw on purpose.
 * @param page - what the page answers, per selector.
 * @param run - the adapter call to make with those globals in place.
 * @returns whatever `run` returned.
 */
function withPage(page, run) {
  const saved = {
    document: globalThis.document,
    location: globalThis.location,
    performance: globalThis.performance,
  }
  const documentStub = {
    title: page.title ?? '',
    querySelectorAll: (selector) => {
      if (page.throwsFor?.includes(selector)) throw new Error('page refuses to be read')
      return page.bySelector?.[selector] ?? []
    },
    querySelector: (selector) => {
      if (page.throwsFor?.includes(selector)) throw new Error('page refuses to be read')
      return page.bySelector?.[selector]?.[0] ?? null
    },
  }
  globalThis.document = documentStub
  globalThis.location = { href: page.url ?? 'https://www.bilibili.com/video/BV1' }
  globalThis.performance = { getEntriesByType: () => page.resources ?? [] }
  try {
    return run()
  } finally {
    globalThis.document = saved.document
    globalThis.location = saved.location
    globalThis.performance = saved.performance
  }
}

const OG = 'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'
const OG_TYPE = 'meta[property="og:video:type"]'
const LINKS = 'a[href]'
const JSON_LD = 'script[type="application/ld+json"]'

test('<video src>: the element the page is playing, with what it reports about itself', () => {
  const page = withPage({
    title: '某个视频',
    url: 'https://example.com/watch',
    bySelector: {
      video: [
        videoStub({ src: 'https://cdn.example.com/a.mp4', duration: 123.5, videoWidth: 1280, videoHeight: 720 }),
        // `currentSrc` is what the browser actually chose; `src` is only the attribute.
        videoStub({ src: 'https://cdn.example.com/ignored.mp4', currentSrc: 'https://cdn.example.com/playing.mp4' }),
        // A video with no address at all is not evidence.
        videoStub({ src: '' }),
      ],
    },
  }, harvestDom)

  assert.equal(page.url, 'https://example.com/watch')
  assert.equal(page.title, '某个视频')
  assert.deepEqual(page.videos, [
    { src: 'https://cdn.example.com/a.mp4', duration: 123.5, width: 1280, height: 720 },
    { src: 'https://cdn.example.com/playing.mp4' },
  ])
  assert.equal(page.site, null, 'the adapter fills this in afterwards, not here')
})

test('<video><source src type>: every source the player could switch to, and the element height', () => {
  const video = videoStub({ src: 'https://cdn.example.com/a.mp4', videoHeight: 720 }, [
    { src: 'https://cdn.example.com/a-720.webm', type: 'video/webm' },
    { src: 'https://cdn.example.com/a-1080.mp4', type: '' },
    { src: '', type: 'video/mp4' },
  ])
  const page = withPage({ bySelector: { video: [video] } }, harvestDom)

  assert.deepEqual(page.sources, [
    { src: 'https://cdn.example.com/a-720.webm', type: 'video/webm', height: 720 },
    { src: 'https://cdn.example.com/a-1080.mp4', height: 720 },
  ], 'the parent element is the only thing that knows how tall a <source> is')
  assert.equal(page.sources[1].type, undefined, 'no type attribute is reported as no type')
})

test('og:video in all three spellings, and og:video:type belongs to the last one', () => {
  const page = withPage({
    bySelector: {
      [OG]: [
        metaStub('https://cdn.example.com/og.mp4', 'og:video'),
        metaStub('https://cdn.example.com/og-url.mp4', 'og:video:url'),
        metaStub('https://cdn.example.com/og-secure.mp4', 'og:video:secure_url'),
        metaStub('', 'og:video'),
      ],
      [OG_TYPE]: [
        metaStub('video/mp4', 'og:video:type'),
        metaStub('', 'og:video:type'),
      ],
    },
  }, harvestDom)

  assert.deepEqual(page.og, [
    { url: 'https://cdn.example.com/og.mp4' },
    { url: 'https://cdn.example.com/og-url.mp4' },
    { url: 'https://cdn.example.com/og-secure.mp4', type: 'video/mp4' },
  ])

  // A `type` with no `url` before it is not a row, and must not crash the read.
  const typeOnly = withPage({ bySelector: { [OG_TYPE]: [metaStub('video/mp4', 'og:video:type')] } }, harvestDom)
  assert.deepEqual(typeOnly.og, [])
})

test('a[href]: media links only, with the text shortened to something a row can show', () => {
  const longText = '下载'.repeat(60)
  const page = withPage({
    bySelector: {
      [LINKS]: [
        { href: 'https://cdn.example.com/download.mp4', textContent: ' 下载 ' },
        { href: 'https://cdn.example.com/stream.m3u8?token=1', textContent: '播放列表' },
        { href: 'https://example.com/about', textContent: '关于' },
        { href: 'https://example.com/style.css', textContent: '样式' },
        { href: 'https://cdn.example.com/a-2160.webm', textContent: longText },
      ],
    },
  }, harvestDom)

  assert.deepEqual(page.links.map(link => link.href), [
    'https://cdn.example.com/download.mp4',
    'https://cdn.example.com/stream.m3u8?token=1',
    'https://cdn.example.com/a-2160.webm',
  ], 'a link to a page or a stylesheet is not a download')
  assert.equal(page.links[0].text, '下载')
  assert.equal(page.links[2].text.length, 60, 'a page can put anything in a link; the row text is bounded')
})

test('performance.getEntriesByType("resource"): only the requests that name a media file', () => {
  const page = withPage({
    resources: [
      { name: 'https://cdn.example.com/seg-00001.m4s', initiatorType: 'fetch' },
      { name: 'https://cdn.example.com/master.mpd', initiatorType: 'xmlhttprequest' },
      { name: 'https://example.com/api/views?id=1', initiatorType: 'xmlhttprequest' },
      { name: 'https://example.com/logo.png', initiatorType: 'img' },
      { name: '', initiatorType: 'fetch' },
      { name: 'https://cdn.example.com/a.mp4', initiatorType: '' },
    ],
  }, harvestDom)

  assert.deepEqual(page.perf, [
    { name: 'https://cdn.example.com/seg-00001.m4s', initiatorType: 'fetch' },
    { name: 'https://cdn.example.com/master.mpd', initiatorType: 'xmlhttprequest' },
    { name: 'https://cdn.example.com/a.mp4' },
  ], 'an interface call and an image are not media, however the page requested them')
  assert.equal(page.evidence, undefined, 'the raw read reports no counts: the app counts')
})

test('JSON-LD: the site escapes its own slashes, and the row must not', () => {
  const page = withPage({
    bySelector: {
      [JSON_LD]: [
        { textContent: '{"contentUrl":"https:\\/\\/cdn.example.com\\/a-1080p.mp4"}' },
        { textContent: '{"contentUrl":"https://cdn.example.com/plain.mp4","thumbnail":"https://cdn.example.com/t.jpg"}' },
        { textContent: 'not json at all' },
        { textContent: '{"playlist":"https:\\/\\/cdn.example.com\\/hls.m3u8"}' },
      ],
    },
  }, harvestDom)

  assert.deepEqual(page.jsonLd, [
    'https://cdn.example.com/a-1080p.mp4',
    'https://cdn.example.com/plain.mp4',
    'https://cdn.example.com/hls.m3u8',
  ])
})

test('the caps: 50 videos, 100 sources, 100 links, 300 resource entries', () => {
  const videos = Array.from({ length: 51 }, (_, index) => videoStub({ src: `https://cdn.example.com/v${index}.mp4` }))
  const manySources = videoStub({ src: 'https://cdn.example.com/a.mp4' },
    Array.from({ length: 101 }, (_, index) => ({ src: `https://cdn.example.com/s${index}.mp4`, type: 'video/mp4' })))
  const links = Array.from({ length: 101 }, (_, index) => ({ href: `https://cdn.example.com/l${index}.mp4`, textContent: `l${index}` }))
  const resources = Array.from({ length: 301 }, (_, index) => ({ name: `https://cdn.example.com/r${index}.mp4`, initiatorType: 'fetch' }))

  const page = withPage({
    bySelector: { video: videos, [LINKS]: links },
    resources,
  }, harvestDom)
  assert.equal(page.videos.length, 50)
  assert.equal(page.links.length, 100)
  assert.equal(page.perf.length, 300)

  const sourcesPage = withPage({ bySelector: { video: [manySources] } }, harvestDom)
  assert.equal(sourcesPage.sources.length, 100)
})

test('a hostile page: one selector that throws costs that evidence, not the harvest', () => {
  const page = withPage({
    title: '不让读的页面',
    url: 'https://example.com/hostile',
    bySelector: {
      // The video and link reads refuse; OpenGraph, resource timing and JSON-LD still answer.
      [OG]: [metaStub('https://cdn.example.com/og.mp4', 'og:video')],
      [JSON_LD]: [{ textContent: 'https://cdn.example.com/ld.mp4' }],
    },
    resources: [{ name: 'https://cdn.example.com/perf.mp4', initiatorType: 'fetch' }],
    throwsFor: ['video', LINKS],
  }, harvestDom)

  assert.equal(page.url, 'https://example.com/hostile')
  assert.equal(page.title, '不让读的页面')
  assert.deepEqual(page.videos, [])
  assert.deepEqual(page.sources, [])
  assert.deepEqual(page.links, [])
  // The rest of the read survived, which is the whole point of wrapping each step.
  assert.deepEqual(page.og, [{ url: 'https://cdn.example.com/og.mp4' }])
  assert.deepEqual(page.perf, [{ name: 'https://cdn.example.com/perf.mp4', initiatorType: 'fetch' }])
  assert.deepEqual(page.jsonLd, ['https://cdn.example.com/ld.mp4'])
})

test('fingerprint(): the title plus the playing source, so a player swap is visible', () => {
  const empty = withPage({ title: '文章', bySelector: {} }, fingerprint)
  assert.equal(empty, '文章\u0001', 'no video is still a fingerprint: the address may not change')

  const playing = withPage({
    title: '某个视频',
    bySelector: { video: [videoStub({ src: 'https://cdn.example.com/a.mp4' })] },
  }, fingerprint)
  assert.equal(playing, '某个视频\u0001https://cdn.example.com/a.mp4')

  // `currentSrc` wins over the attribute, exactly as in the harvest.
  const current = withPage({
    title: '某个视频',
    bySelector: { video: [videoStub({ src: 'https://cdn.example.com/attr.mp4', currentSrc: 'https://cdn.example.com/playing.mp4' })] },
  }, fingerprint)
  assert.equal(current, '某个视频\u0001https://cdn.example.com/playing.mp4')

  // A `<source>` child is the fallback when the element itself has no address.
  const inner = withPage({
    title: '某个视频',
    bySelector: {
      video: [videoStub({}, [{ src: 'https://cdn.example.com/source.mp4', type: 'video/mp4' }])],
      'source[src]': [{ src: 'https://cdn.example.com/source.mp4' }],
    },
  }, fingerprint)
  assert.equal(inner, '某个视频\u0001https://cdn.example.com/source.mp4')

  // Both halves are bounded: a title and a URL are page-authored strings.
  const long = withPage({
    title: 'x'.repeat(400),
    bySelector: { video: [videoStub({ src: `https://cdn.example.com/${'y'.repeat(400)}.mp4` })] },
  }, fingerprint)
  const [titlePart, mediaPart] = long.split('\u0001')
  assert.equal(titlePart.length, 120)
  assert.equal(mediaPart.length, 300)
})

test('fingerprint() on a page that cannot be read is empty, not an exception', () => {
  const hostile = withPage({ throwsFor: ['video'] }, fingerprint)
  assert.equal(hostile, '')
})
