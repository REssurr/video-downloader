/**
 * The in-page harvest, as the HOST sees it.
 *
 * The client does the DOM work and sends plain URLs; everything here is the Host's
 * decision about them — which URLs it will accept at all, what the file is called,
 * and what a row may not be. That makes this the security-relevant half of the
 * feature (the payload comes from a page the Host does not control), so the
 * refusals are tested as carefully as the acceptances.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extFor, extHintFromUrl, guestEntries, readGuestCandidates, stemFromUrl, GUEST_CANDIDATE_LIMIT } from '../lib/test/guest-harvest.js'
import { createDispatcher } from '../lib/test/routes.js'

test('extFor prefers the URL, then the hint, and names a last resort', () => {
  assert.equal(extFor('https://cdn.example.com/a/b.mp4?token=1', 'webm'), 'mp4')
  assert.equal(extFor('https://cdn.example.com/stream/1080', 'video/webm'), 'webm')
  assert.equal(extFor('https://cdn.example.com/manifest/index.m3u8'), 'm3u8')
  // No evidence at all: the name is a guess, and `guestEntries` says so in a note.
  assert.equal(extFor('https://cdn.example.com/v/9f8a7b', undefined), 'mp4')
  // An extension nobody can name a container with is not an extension.
  assert.equal(extHintFromUrl('https://cdn.example.com/v/9f8a7b'), undefined)
  assert.equal(extHintFromUrl('https://cdn.example.com/a.zip'), undefined)
})

test('readGuestCandidates accepts only what the Host would fetch itself', () => {
  const read = readGuestCandidates([
    { url: 'https://cdn.example.com/a.mp4', height: 720.4, label: '页面播放器 · 720p' },
    // The fragment is not part of the resource: the same file twice is one row.
    { url: 'https://cdn.example.com/a.mp4#t=10' },
    { url: 'blob:https://example.com/1234' },
    { url: 'data:video/mp4;base64,AAAA' },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:pw@cdn.example.com/a.mp4' },
    { url: 'not a url' },
    null,
    'https://cdn.example.com/nope.mp4',
    { url: 'https://cdn.example.com/stream.m3u8' },
  ])
  assert.deepEqual(read.candidates.map(candidate => candidate.url), [
    'https://cdn.example.com/a.mp4',
    'https://cdn.example.com/stream.m3u8',
  ])
  assert.equal(read.candidates[0].height, 720)
  assert.equal(read.candidates[0].label, '页面播放器 · 720p')
  // The extension is resolved when the entry is built, so an accepted candidate
  // carries only the client's HINT — the URL is the stronger evidence, and it is
  // read at the same moment the row is named.
  assert.equal(read.candidates[1].ext, undefined)
  assert.equal(extFor(read.candidates[1].url, read.candidates[1].ext), 'm3u8')
  // Six bad shapes plus the duplicate plus the trailing string: dropped, not thrown.
  assert.equal(read.dropped, 8)

  // The name a site adapter sends is bounded and trimmed here too: it becomes a FILE
  // NAME, and a page is not the authority on what this Host will write to disk.
  const titled = readGuestCandidates([
    { url: 'https://cdn.example.com/a.mp4', title: '  某个视频（第1段）  ', label: 'l' },
    { url: 'https://cdn.example.com/b.mp4', title: 'x'.repeat(400) },
    { url: 'https://cdn.example.com/c.mp4', title: 42 },
  ])
  assert.equal(titled.candidates[0].title, '某个视频（第1段）')
  assert.equal(titled.candidates[1].title.length, 120)
  assert.equal(titled.candidates[2].title, undefined)
})

test('readGuestCandidates bounds how much one page can add', () => {
  const many = Array.from({ length: GUEST_CANDIDATE_LIMIT + 5 }, (_, index) => ({ url: `https://cdn.example.com/v${index}.mp4` }))
  const read = readGuestCandidates(many)
  assert.equal(read.candidates.length, GUEST_CANDIDATE_LIMIT)
  assert.equal(read.dropped, 5)
  assert.deepEqual(readGuestCandidates('nonsense'), { candidates: [], dropped: 0 })
})

test('the audio half of a pair is accepted on exactly the same terms as the video half', () => {
  const read = readGuestCandidates([
    {
      url: 'https://xy.bilivideo.com/42352905122-1-112.m4s',
      ext: 'mp4',
      height: 1080,
      approxBytes: 170_116_000.4,
      audioUrl: 'https://xy.bilivideo.com/42352905122-1-30280.m4s#t=3',
      label: 'bilibili 合并 · 1080P 高码率',
      title: '某个视频 · 1080P 高码率',
    },
    // An audio URL the Host would not fetch makes this an ordinary candidate again: a pair
    // with one half is a silent film, and this is the layer that must not invent one.
    { url: 'https://cdn.example.com/b.m4s', audioUrl: 'blob:https://cdn.example.com/x' },
    { url: 'https://cdn.example.com/c.m4s', audioUrl: 'https://user:pw@cdn.example.com/x.m4s' },
    { url: 'https://cdn.example.com/d.m4s', audioUrl: 'not a url' },
    { url: 'https://cdn.example.com/e.m4s', audioUrl: '' },
  ])

  const [pair, ...singles] = read.candidates
  assert.equal(pair.audioUrl, 'https://xy.bilivideo.com/42352905122-1-30280.m4s', 'normalized, and the fragment is not part of the resource')
  assert.equal(pair.approxBytes, 170_116_000, 'rounded, like every other byte count here')
  for (const single of singles) assert.equal(single.audioUrl, undefined)
  assert.equal(read.dropped, 0, 'a bad audio URL drops the PAIR, not the row')
})

test('a pair becomes an mp4 row, whatever the two track URLs are called', () => {
  // The site serves both halves as `.m4s` fragments, and reading the container out of the
  // URL would name the merged file `…m4s`, label it a fragment nobody can play, and hide it
  // from the mp4-only policy — the exact opposite of what the user asked for.
  const [pair] = guestEntries({
    pageUrl: 'https://www.bilibili.com/video/BV1LvYA6QEGP',
    pageTitle: '某个视频',
    candidates: [
      {
        url: 'https://xy.bilivideo.com/42352905122-1-112.m4s',
        ext: 'mp4',
        height: 1080,
        approxBytes: 170_116_000,
        audioUrl: 'https://xy.bilivideo.com/42352905122-1-30280.m4s',
        label: 'bilibili 合并 · 1080P 高码率',
        title: '某个视频 · 1080P 高码率',
      },
    ],
  }).entries

  const [option] = pair.options
  assert.equal(pair.title, '某个视频 · 1080P 高码率', 'the rung is in the name, so it cannot collide with the 720P file')
  assert.equal(option.ext, 'mp4')
  assert.equal(option.kind, 'muxed', 'it ends up with sound, so it is not a video-only row')
  assert.equal(option.directUrl, 'https://xy.bilivideo.com/42352905122-1-112.m4s')
  assert.equal(option.audioUrl, 'https://xy.bilivideo.com/42352905122-1-30280.m4s')
  assert.equal(option.bytes, undefined, 'the pair does not exist yet: a byte count would be a lie')
  assert.equal(option.approxBytes, 170_116_000)
  assert.equal(pair.error, undefined, 'a pair is not a fragment, even though its URLs are .m4s')

  // The control: the same URL WITHtout an audio half is a fragment, and says so.
  const [alone] = guestEntries({
    pageUrl: 'https://www.bilibili.com/video/BV1LvYA6QEGP',
    candidates: [{ url: 'https://xy.bilivideo.com/42352905122-1-112.m4s', ext: 'mp4', height: 1080 }],
  }).entries
  assert.equal(alone.options[0].ext, 'm4s')
  assert.match(alone.error, /流媒体分段文件/)
})

test('a row is named after the URL when the URL names something, and the page when it does not', () => {
  // The user's own request, in their words: "在 hanime 中统一使用第一个形式的名字" —
  // the CDN calls the file `408455-720p.mp4`, so that is what lands on disk, exactly as
  // curl or yt-dlp's generic extractor would have named it.
  assert.equal(stemFromUrl('https://vdownload.hembed.com/408455-720p.mp4?secure=abc==,1790823632'), '408455-720p')
  assert.equal(stemFromUrl('https://cdn.example.com/media-a.mp4'), 'media-a')
  assert.equal(stemFromUrl('https://cdn.example.com/a/b/%E8%A7%86%E9%A2%91-1080p.mp4'), '视频-1080p')
  // Names that say nothing useful fall back to the page's title plus the quality.
  assert.equal(stemFromUrl('https://cdn.example.com/video.mp4'), undefined)
  assert.equal(stemFromUrl('https://cdn.example.com/hls/master.m3u8'), undefined)
  assert.equal(stemFromUrl('https://cdn.example.com/9f8a7b3c2d1e4f5a6b7c8d9e0f1a2b3c.mp4'), undefined)
  assert.equal(stemFromUrl('https://cdn.example.com/a.mp4'), undefined)
  assert.equal(stemFromUrl('https://cdn.example.com/'), undefined)

  const [named, anonymous] = guestEntries({
    pageUrl: 'https://example.com/watch',
    pageTitle: '页面标题',
    candidates: [
      { url: 'https://cdn.example.com/408455-1080p.mp4', ext: 'mp4', height: 1080 },
      { url: 'https://cdn.example.com/video', ext: 'mp4', height: 480 },
    ],
  }).entries
  assert.equal(named.title, '408455-1080p')
  assert.equal(named.options[0].title, '408455-1080p', 'the option keeps a name for the picker too')
  assert.equal(anonymous.title, '页面标题 · 480p')
})

test('a name a site adapter read from the site wins over the URL', () => {
  // bilibili serves `…/42352905122-1-192.mp4`: a content id, which `stemFromUrl` refuses
  // anyway — and a two-part video would put BOTH parts on that one name, which is one file
  // and one conflict question for two different downloads. So the adapter's own name wins.
  const built = guestEntries({
    pageUrl: 'https://www.bilibili.com/video/BV1LvYA6QEGP',
    pageTitle: '某个视频_哔哩哔哩_bilibili',
    candidates: [
      { url: 'https://cn-bj-se-01-05.bilivideo.com/upgcxcode/22/51/42352905122/42352905122-1-192.mp4?deadline=1', ext: 'mp4', height: 1080, bytes: 48_408_844, title: '某个视频（第1段）' },
      { url: 'https://cn-bj-se-01-05.bilivideo.com/upgcxcode/22/51/42352905122/42352905122-2-192.mp4?deadline=1', ext: 'mp4', height: 1080, bytes: 40_000_000, title: '某个视频（第2段）' },
    ],
  }).entries
  assert.deepEqual(built.map(entry => entry.title), ['某个视频（第1段）', '某个视频（第2段）'])
  assert.equal(built[0].options[0].bytes, 48_408_844, 'the size the API reported rides the row')
  // Last year's behaviour is untouched: with no name from the site, the URL still wins.
  const plain = guestEntries({
    pageUrl: 'https://hanime.tv/videos/x',
    pageTitle: '页面标题',
    candidates: [{ url: 'https://cdn.example.com/408455-720p.mp4', ext: 'mp4', height: 720 }],
  }).entries
  assert.equal(plain[0].title, '408455-720p')
})

test('guestEntries turns one candidate into one downloadable row', () => {
  const built = guestEntries({
    pageUrl: 'https://example.com/watch',
    pageTitle: '页面标题',
    candidates: [
      { url: 'https://cdn.example.com/a.mp4', ext: 'mp4', height: 1080, label: '页面播放器 · 1080p' },
      { url: 'https://cdn.example.com/seg1.ts', ext: 'ts' },
      { url: 'https://cdn.example.com/v/9f8a7b' },
    ],
  })
  assert.equal(built.entries.length, 3)
  const [first, second, third] = built.entries
  assert.equal(first.id, 'guest-1')
  // The row's title is also the FILE NAME, so it is the page's title plus the
  // quality — not the client's diagnostic label, which named a real 1080p download
  // `_source_ · video_mp4.mp4` until this changed.
  assert.equal(first.title, '页面标题 · 1080p')
  assert.equal(first.options[0].title, '页面播放器 · 1080p', 'the evidence label is kept, on the option')
  assert.equal(first.url, 'https://cdn.example.com/a.mp4', 'the entry carries the media URL, not the page URL')
  assert.equal(first.options[0].source, 'guest')
  assert.equal(first.options[0].directUrl, 'https://cdn.example.com/a.mp4')
  assert.equal(first.options[0].height, 1080)
  assert.equal(first.error, undefined)
  // A transport-stream fragment is a real URL and a real download, and it is also
  // almost never playable on its own — the row says so instead of pretending.
  assert.match(String(second.error), /分段/)
  // The extension was guessed, and the notes say that out loud.
  assert.equal(third.options[0].ext, 'mp4')
  assert.ok(built.notes.some(note => note.includes('看不出容器格式')))
  assert.ok(built.notes[0].includes('3 个媒体地址'))
})

/** A fake services object with just enough for the two routes under test. */
function fakeServices(overrides = {}) {
  const state = { registered: [], started: [] }
  const config = {
    schema: 1,
    downloadDir: 'C:/out',
    filenameTemplate: '%(title)s.%(ext)s',
    maxConcurrent: 1,
    proxy: '',
    mp4Only: true,
    downloadPath: 'auto',
    rules: [],
  }
  const services = {
    version: '9.9.9',
    config: () => config,
    configPath: 'C:/cfg/config.json',
    notices: () => [],
    setConfig: async () => undefined,
    network: async () => ({ proxied: false, source: 'none' }),
    merge: async () => ({ available: true, path: 'C:/tools/bin/ffmpeg.exe' }),
    invalidateNetwork: () => undefined,
    invalidateProbes: () => undefined,
    pickDirectory: async () => null,
    registerGuest: async (input) => { state.registered.push(input); return { record: { url: input.url, source: 'guest', entries: [], notes: [] }, decisions: [] } },
    startDownload: async (input) => { state.started.push(input); return { jobId: 'job-1' } },
    cancelJob: () => undefined,
    jobs: () => [],
    health: () => ({ api: true, eventSocket: true, socketAccepted: false }),
    ...overrides,
  }
  return { services, state }
}

test('probe.registerGuest normalizes the page URL before the Host stores it', async () => {
  const { services, state } = fakeServices()
  const envelope = await createDispatcher(services).dispatch('probe.registerGuest', {
    url: 'example.com/watch',
    title: '标题',
    candidates: [{ url: 'https://cdn.example.com/a.mp4', ext: 'mp4' }],
  })
  assert.equal(envelope.ok, true)
  assert.equal(state.registered.length, 1)
  assert.equal(state.registered[0].url, 'https://example.com/watch')
  assert.equal(state.registered[0].title, '标题')
  assert.equal(envelope.value.record.source, 'guest')

  const missing = await createDispatcher(services).dispatch('probe.registerGuest', { candidates: [] })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bad-request')
  const bad = await createDispatcher(services).dispatch('probe.registerGuest', { url: 'file:///c:/a.mp4' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad-request')
})

test('download.start forwards the page carrier and refuses any other claim', async () => {
  const { services, state } = fakeServices()
  const dispatcher = createDispatcher(services)
  const guest = await dispatcher.dispatch('download.start', {
    url: 'https://example.com/watch',
    formatId: 'guest-1-media',
    carrier: 'guest',
  })
  assert.equal(guest.ok, true)
  assert.equal(state.started[0].carrier, 'guest')

  // Only `guest` is expressible: everything else follows from the option, and
  // accepting a name for it would let a client claim one the Host cannot honour.
  const claimed = await dispatcher.dispatch('download.start', {
    url: 'https://example.com/watch',
    formatId: 'x',
    carrier: 'ytdlp',
  })
  assert.equal(claimed.ok, false)
  assert.equal(claimed.error.code, 'bad-request')

  const plain = await dispatcher.dispatch('download.start', { url: 'https://example.com/watch', formatId: 'x' })
  assert.equal(plain.ok, true)
  assert.equal(state.started[1].carrier, undefined)
})
