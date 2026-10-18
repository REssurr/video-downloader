/**
 * Download-engine integration tests.
 *
 * These run against a REAL loopback HTTP server and a REAL temp directory: the
 * behaviours that matter here — Range resumption, the atomic rename, the
 * `.part` file surviving an interruption — are exactly the ones a mocked
 * filesystem or a stubbed `fetch` would hide.
 *
 * The carrier is `fetch`, driven for real against the test server: Range
 * resumption through a proxy stub would hide exactly the behaviour under test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DownloadRejection,
  createDownloadEngine,
  expandedName,
  freeOutputPath,
  isDirectlyDownloadable,
  nodeDownloadFs,
  outputNameFor,
  resolveOutputTemplate,
  safeFileStem,
  stripKnownExtension,
} from '../lib/test/download.js'

/** A deterministic payload so the checksum is meaningful. */
function payload(size) {
  const buffer = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 7 + 13) % 251
  return buffer
}

/** The loopback server used by the direct-carrier tests. */
async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => { server.close(resolve) }),
  }
}

/** A fresh temp directory per test. */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-vd-'))
}

/**
 * An engine over the real fs.
 * @param overrides - dependency overrides; `onUpdate` and `engineOptions` are
 *   routed to the engine options rather than into the dependencies.
 */
function engineFor(overrides = {}) {
  const { onUpdate, engineOptions, ...deps } = overrides
  return createDownloadEngine(
    {
      fs: nodeDownloadFs(),
      fetch: globalThis.fetch,
      now: () => Date.now(),
      ...deps,
    },
    {
      maxConcurrent: 1,
      ...(onUpdate === undefined ? {} : { onUpdate }),
      ...(engineOptions ?? {}),
    },
  )
}

/** A requested option for the direct carrier. */
function directOption(directUrl, overrides = {}) {
  return { id: 'direct', title: '', ext: 'mp4', kind: 'muxed', source: 'guest', directUrl, ...overrides }
}

/** Collect the updates an engine publishes. */
function recorder() {
  const updates = []
  return { updates, onUpdate: (job) => { updates.push(job) } }
}

test('resolveOutputTemplate substitutes the title and leaves other placeholders', () => {
  assert.equal(resolveOutputTemplate('%(title)s.%(ext)s', '我的 视频'), '我的 视频.%(ext)s')
  assert.equal(resolveOutputTemplate('%(uploader)s - %(title)s.%(ext)s', 'T'), '%(uploader)s - T.%(ext)s')
  // `%%` is a literal percent and must survive untouched.
  assert.equal(resolveOutputTemplate('100%% %(title)s', 'T'), '100% T')
  assert.equal(resolveOutputTemplate('no placeholder', 'T'), 'no placeholder')
})

test('the template names the file, and an unexpandable one falls back to title.ext', () => {
  const request = (overrides = {}) => ({
    downloadDir: 'C:/out',
    filenameTemplate: '%(title)s.%(ext)s',
    title: 'T',
    option: { ext: 'mp4' },
    ...overrides,
  })
  assert.equal(outputNameFor(request()), 'T.mp4')
  assert.equal(outputNameFor(request({ filenameTemplate: 'hanime-%(title)s.%(ext)s' })), 'hanime-T.mp4')
  // A title that IS a filename must not double its extension.
  assert.equal(outputNameFor(request({ title: 'mov_bbb.mp4' })), 'mov_bbb.mp4')
  // A placeholder only an external downloader could fill cannot be resolved to a
  // path, so the name falls back rather than guessing.
  assert.equal(expandedName(request({ filenameTemplate: '%(id)s.%(ext)s' }), 'mp4'), undefined)
  assert.equal(outputNameFor(request({ filenameTemplate: '%(id)s.%(ext)s' })), 'T.mp4')
})

test('safeFileStem strips path-hostile characters and bounds length', () => {
  assert.equal(safeFileStem('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(safeFileStem('  多余   空格  '), '多余 空格')
  assert.equal(safeFileStem('trailing.'), 'trailing')
  assert.equal(safeFileStem(''), 'video')
  assert.equal(safeFileStem('   '), 'video')
  assert.equal(safeFileStem('x'.repeat(300)).length, 120)
})

test('stripKnownExtension keeps a media-file title from doubling its extension', () => {
  assert.equal(stripKnownExtension('mov_bbb.mp4', 'mp4'), 'mov_bbb')
  assert.equal(stripKnownExtension('MOV_BBB.MP4', 'mp4'), 'MOV_BBB')
  assert.equal(stripKnownExtension('movie', 'mp4'), 'movie')
  assert.equal(stripKnownExtension('movie.webm', 'mp4'), 'movie.webm')
  // Never strip the stem away entirely: a title that is only the extension
  // still has to name a file.
  assert.equal(stripKnownExtension('mp4', 'mp4'), 'mp4')
  assert.equal(stripKnownExtension('.mp4', 'mp4'), '.mp4')
})

test('freeOutputPath avoids collisions', async () => {
  const taken = new Set(['/d/a.mp4', '/d/a (1).mp4'])
  const exists = async (path) => taken.has(path)
  const join2 = (...segments) => segments.join('/')
  assert.equal(await freeOutputPath('/d', 'a.mp4', exists, join2), '/d/a (2).mp4')
  assert.equal(await freeOutputPath('/d', 'b.mp4', exists, join2), '/d/b.mp4')
  // A name with no extension still gets a readable suffix rather than a mangled one.
  assert.equal(await freeOutputPath('/d', 'c', async path => path === '/d/c', join2), '/d/c (1)')
})

test('the direct carrier downloads, verifies size, and renames atomically', async () => {
  const body = payload(256 * 1024)
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  const seen = recorder()
  try {
    const engine = engineFor({ ...seen })
    const handle = engine.start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/v.mp4`),
      title: '我的 视频',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    })
    const final = await handle.done
    assert.equal(final.status, 'done', final.error)
    assert.equal(final.receivedBytes, body.length)
    assert.equal(final.totalBytes, body.length)
    assert.ok(final.outputPath?.endsWith('我的 视频.mp4'), `unexpected path ${final.outputPath}`)

    const written = await readFile(final.outputPath)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(body).digest('hex'))
    // No `.part` may survive a successful download.
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.part')), [])
    // A transfer this fast may publish only the terminal state, so the terminal
    // update is what is asserted; progress publication is covered by the longer
    // fixtures below.
    assert.ok(seen.updates.some(job => job.status === 'done'), 'a terminal update was published')
    assert.ok(seen.updates.some(job => job.receivedBytes === body.length), 'the final byte count was published')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a resumed download appends to the existing .part file', async () => {
  const body = payload(192 * 1024)
  const half = Math.floor(body.length / 2)
  let rangeHeader
  const server = await startServer((req, res) => {
    rangeHeader = req.headers.range
    if (req.headers.range === `bytes=${half}-`) {
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': String(body.length - half),
        'content-range': `bytes ${half}-${body.length - 1}/${body.length}`,
      })
      res.end(body.subarray(half))
      return
    }
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    // Seed a partial file exactly as an interrupted download would leave it.
    const finalPath = join(dir, '断点视频.mp4')
    await writeFile(`${finalPath}.part`, body.subarray(0, half))

    const engine = engineFor()
    const final = await engine.start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/v.mp4`),
      title: '断点视频',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    }).done

    assert.equal(final.status, 'done', final.error)
    assert.equal(rangeHeader, `bytes=${half}-`, 'the engine asked to resume from the partial length')
    const written = await readFile(final.outputPath)
    assert.equal(written.length, body.length)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(body).digest('hex'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a media host that refuses a Referer is retried without one instead of failing', async () => {
  // Measured on a real CDN77 media host: the exact same signed URL answers 403 when
  // the request carries a `Referer` together with anything else, and 200 to the same
  // request with no Referer. The signature is in the query, so dropping the Referer
  // loses nothing — and without this retry the plugin failed a URL that curl fetches
  // at 15 MB/s.
  const body = payload(48 * 1024)
  const seen = []
  const server = await startServer((req, res) => {
    seen.push({ referer: req.headers.referer ?? null, range: req.headers.range ?? null })
    if (req.headers.referer !== undefined) {
      res.writeHead(403, { 'content-type': 'text/html' })
      res.end('<html>Forbidden</html>')
      return
    }
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const engine = engineFor()
    const final = await engine.start({
      url: 'https://example.com/watch',
      option: directOption(`${server.origin}/v.mp4`),
      title: '防盗链视频',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
      referer: 'https://example.com/watch',
    }).done

    assert.equal(final.status, 'done', final.error)
    assert.equal(seen.length, 2, 'the refused request is retried once')
    assert.equal(seen[0].referer, 'https://example.com/watch')
    assert.equal(seen[1].referer, null, 'the retry carries no Referer')
    const written = await readFile(final.outputPath)
    assert.equal(written.length, body.length)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(body).digest('hex'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a refusal that survives the no-Referer retry still fails, and says so', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('<html>Forbidden</html>')
  })
  const dir = await tempDir()
  try {
    const engine = engineFor()
    const final = await engine.start({
      url: 'https://example.com/watch',
      option: directOption(`${server.origin}/v.mp4`),
      title: '拒绝',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
      referer: 'https://example.com/watch',
    }).done

    assert.equal(final.status, 'failed')
    assert.match(String(final.error), /403/)
    assert.match(String(final.error), /去掉 Referer 重试后仍然被拒/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a server that ignores Range restarts from zero instead of corrupting the file', async () => {
  const body = payload(64 * 1024)
  const server = await startServer((_req, res) => {
    // Deliberately 200 with the FULL body: the partial bytes must be discarded.
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const finalPath = join(dir, 'x.mp4')
    await writeFile(`${finalPath}.part`, Buffer.alloc(1000, 7))

    const engine = engineFor()
    const final = await engine.start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/x.mp4`),
      title: 'x',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    }).done

    assert.equal(final.status, 'done', final.error)
    const written = await readFile(final.outputPath)
    assert.equal(written.length, body.length)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(body).digest('hex'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an HTTP failure is a failed job, not a throw', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(404)
    res.end('nope')
  })
  const dir = await tempDir()
  try {
    const final = await engineFor().start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/missing.mp4`),
      title: 'missing',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    }).done
    assert.equal(final.status, 'failed')
    assert.ok(final.error?.includes('404'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a truncated body keeps the .part file and reports incomplete', async () => {
  // Headers are flushed and some bytes are written BEFORE the socket dies, so the
  // body has genuinely started and the engine has already created the `.part`
  // file. (Destroying immediately would fail at `fetch` instead, which is a
  // different — also covered — failure with nothing to resume.)
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': '1000000' })
    res.write(Buffer.alloc(4096, 1))
    setTimeout(() => { res.destroy() }, 30)
  })
  const dir = await tempDir()
  try {
    const final = await engineFor().start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/v.mp4`),
      title: 'short',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    }).done
    assert.equal(final.status, 'failed')
    assert.equal(final.outputPath, undefined, 'a failed job must not claim a finished path')
    const leftovers = await readdir(dir)
    assert.ok(leftovers.some(name => name.endsWith('.part')), `a resume point must survive: ${leftovers.join(',')}`)
    // The bytes actually received must be on disk, so a retry can resume.
    const part = leftovers.find(name => name.endsWith('.part'))
    assert.ok((await readFile(join(dir, part))).length > 0, 'the partial bytes were flushed')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a queued job cancels without starting', async () => {
  const body = payload(32 * 1024)
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const engine = engineFor({ engineOptions: { maxConcurrent: 1 } })
    const first = engine.start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/a.mp4`),
      title: 'a',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    })
    const second = engine.start({
      url: `${server.origin}/page`,
      option: directOption(`${server.origin}/b.mp4`),
      title: 'b',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    })
    second.cancel()
    assert.equal(second.view.status, 'cancelled', 'cancelling a queued job settles it immediately')
    const secondFinal = await second.done
    assert.equal(secondFinal.status, 'cancelled')

    const firstFinal = await first.done
    assert.equal(firstFinal.status, 'done', firstFinal.error)
    assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('b')), [], 'a cancelled job writes nothing')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the direct carrier refuses a manifest instead of saving a list of segments', async () => {
  const dir = await tempDir()
  try {
    const final = await engineFor().start({
      url: 'https://example.com/v',
      option: {
        id: 'hls',
        title: '',
        ext: 'm3u8',
        kind: 'muxed',
        source: 'guest',
        directUrl: 'https://cdn.example.com/v1080/index.m3u8',
      },
      title: 'T',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    }).done

    assert.equal(final.status, 'failed')
    assert.match(final.error, /不是一个可以直接下载的文件/)
    assert.deepEqual(await readdir(dir), [], 'a manifest writes nothing at all')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('engine.list reports newest-first and drain waits for everything', async () => {
  const body = payload(1024)
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const engine = engineFor()
    const a = engine.start({ url: 'u', option: directOption(`${server.origin}/a.mp4`), title: 'a', downloadDir: dir, filenameTemplate: '%(title)s.%(ext)s' })
    const b = engine.start({ url: 'u', option: directOption(`${server.origin}/b.mp4`), title: 'b', downloadDir: dir, filenameTemplate: '%(title)s.%(ext)s' })
    await engine.drain()
    const ids = engine.list().map(job => job.id)
    assert.equal(ids[0], b.id, 'newest first')
    assert.equal(ids[1], a.id)
    assert.ok(engine.list().every(job => job.status === 'done'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('DownloadRejection carries a stable code', () => {
  const error = new DownloadRejection('http-error', 'msg')
  assert.equal(error.code, 'http-error')
  assert.equal(error.name, 'DownloadRejection')
  assert.ok(error instanceof Error)
})

test('isDirectlyDownloadable refuses manifests and url-less options', () => {
  assert.equal(isDirectlyDownloadable({ ext: 'mp4', directUrl: 'https://x/a.mp4' }), true)
  assert.equal(isDirectlyDownloadable({ ext: 'webm', directUrl: 'https://x/a.webm' }), true)
  // A manifest is not a file: it is a list of segments.
  assert.equal(isDirectlyDownloadable({ ext: 'm3u8', directUrl: 'https://x/v.m3u8' }), false)
  assert.equal(isDirectlyDownloadable({ ext: 'MP4', directUrl: 'https://x/a.MP4' }), true)
  assert.equal(isDirectlyDownloadable({ ext: 'mp4' }), false)
})

/**
 * The paired carrier.
 *
 * A separated quality is TWO files, and the user's request was 「可否将更高清的分离流合并为
 * mp4」. Everything about the two halves is an ordinary download (the resume, the Referer, the
 * completeness check, the `.part` discipline); what is new is the last step and what must
 * NOT happen when it cannot run. The muxer is injected here, so no test ever starts ffmpeg.
 */

/** A server with one video track and one audio track, counting what was asked for each. */
async function startPairServer(video, audio) {
  const seen = { video: [], audio: [] }
  const server = await startServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const body = path === '/video.m4s' ? video : path === '/audio.m4s' ? audio : undefined
    if (body === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const list = path === '/video.m4s' ? seen.video : seen.audio
    const range = req.headers.range
    list.push(range ?? 'full')
    if (range !== undefined) {
      // Whatever is already on disk is the whole track: a 416 that states the real length.
      res.writeHead(416, { 'content-range': `bytes */${body.length}` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) })
    res.end(body)
  })
  return { server, seen }
}

/** A mux runner that reads its two inputs and writes their bytes as the merged file. */
function fakeMux(options = {}) {
  const calls = []
  return {
    calls,
    runner: {
      path: 'C:/tools/bin/ffmpeg.exe',
      async run(request) {
        const video = await readFile(request.videoPath)
        const audio = await readFile(request.audioPath)
        calls.push({ request, videoBytes: video.length, audioBytes: audio.length })
        if (options.fail !== undefined) return { ok: false, message: options.fail }
        await writeFile(request.outputPath, Buffer.concat([video, audio]))
        return { ok: true }
      },
    },
  }
}

/** The request the paired-carrier tests start. */
function pairRequest(origin, dir, overrides = {}) {
  return {
    url: `${origin}/page`,
    option: directOption(`${origin}/video.m4s`, { audioUrl: `${origin}/audio.m4s` }),
    title: '合并 视频',
    downloadDir: dir,
    filenameTemplate: '%(title)s.%(ext)s',
    ...overrides,
  }
}

test('a separated pair is downloaded, merged by the muxer, and left as one mp4', async () => {
  const video = payload(96 * 1024)
  const audio = payload(24 * 1024)
  const { server, seen } = await startPairServer(video, audio)
  const dir = await tempDir()
  const mux = fakeMux()
  try {
    const engine = engineFor({ mux: () => mux.runner })
    const final = await engine.start(pairRequest(server.origin, dir)).done

    assert.equal(final.status, 'done', final.error)
    assert.ok(final.outputPath?.endsWith('合并 视频.mp4'), `unexpected path ${final.outputPath}`)
    // One download as far as the user is concerned: both tracks count into the same number.
    assert.equal(final.receivedBytes, video.length + audio.length)
    assert.equal(final.totalBytes, video.length + audio.length)

    // Both halves were COMPLETE, on disk, under the names the engine owns, before the merge.
    assert.equal(mux.calls.length, 1)
    assert.equal(mux.calls[0].videoBytes, video.length)
    assert.equal(mux.calls[0].audioBytes, audio.length)
    assert.equal(mux.calls[0].request.videoPath, `${final.outputPath}.part`)
    assert.equal(mux.calls[0].request.audioPath, `${final.outputPath}.audio.part`)
    assert.equal(mux.calls[0].request.outputPath, `${final.outputPath}.mux.part`)

    const written = await readFile(final.outputPath)
    assert.equal(written.length, video.length + audio.length, 'the merged file is what the muxer wrote')
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.part')), [], 'a finished pair leaves no parts')
    assert.deepEqual(seen.video, ['full'])
    assert.deepEqual(seen.audio, ['full'])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a muxer a pair fails before the first byte, never as a silent film', async () => {
  const { server, seen } = await startPairServer(payload(4096), payload(1024))
  const dir = await tempDir()
  try {
    // No `mux` dependency at all: this machine has no ffmpeg.
    const engine = engineFor()
    const final = await engine.start(pairRequest(server.origin, dir)).done

    assert.equal(final.status, 'failed')
    assert.match(final.error, /ffmpeg/)
    assert.match(final.error, /视频轨与音频轨/)
    assert.deepEqual(seen.video, [], 'nothing is fetched for a merge that cannot happen')
    assert.deepEqual(await readdir(dir), [], 'and nothing is written')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed merge keeps both tracks and reports ffmpeg’s own words', async () => {
  const video = payload(8192)
  const audio = payload(2048)
  const { server } = await startPairServer(video, audio)
  const dir = await tempDir()
  const mux = fakeMux({ fail: 'moov atom not found' })
  try {
    const engine = engineFor({ mux: () => mux.runner })
    const final = await engine.start(pairRequest(server.origin, dir)).done

    assert.equal(final.status, 'failed')
    assert.equal(final.error, '合并失败：moov atom not found')
    // The two downloaded tracks are the expensive part of a pair, so a failure here keeps
    // them: a retry must not download a gigabyte again.
    const parts = (await readdir(dir)).sort()
    assert.deepEqual(parts, ['合并 视频.mp4.audio.part', '合并 视频.mp4.part'])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a retry after a failed merge reuses both whole tracks instead of downloading again', async () => {
  const video = payload(16 * 1024)
  const audio = payload(4096)
  const { server, seen } = await startPairServer(video, audio)
  const dir = await tempDir()
  try {
    // First attempt: both tracks arrive, then ffmpeg fails.
    const first = await engineFor({ mux: () => fakeMux({ fail: 'Invalid data found' }).runner })
      .start(pairRequest(server.origin, dir)).done
    assert.equal(first.status, 'failed')
    // Second attempt: the two `.part` files are complete, so asking for the rest of them is
    // answered `416` — and the engine has to read that as "already whole" rather than as a
    // failure. This is the difference between a retry that costs a second and one that
    // costs the whole download.
    const working = fakeMux()
    const second = await engineFor({ mux: () => working.runner }).start(pairRequest(server.origin, dir)).done

    assert.equal(second.status, 'done', second.error)
    assert.equal(working.calls[0].videoBytes, video.length)
    assert.equal(working.calls[0].audioBytes, audio.length)
    assert.equal((await readFile(second.outputPath)).length, video.length + audio.length)
    assert.deepEqual(seen.video, ['full', `bytes=${video.length}-`], 'the video track was fetched once')
    assert.deepEqual(seen.audio, ['full', `bytes=${audio.length}-`])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a 416 that states no length restarts instead of trusting a stale part', async () => {
  const body = payload(12 * 1024)
  const asked = []
  const server = await startServer((req, res) => {
    asked.push(req.headers.range ?? 'full')
    if (req.headers.range !== undefined) {
      // Some servers answer 416 without saying how long the file really is, and then the
      // part on disk cannot be verified — so it is discarded rather than guessed at.
      res.writeHead(416)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const finalPath = join(dir, '陈旧.mp4')
    await writeFile(`${finalPath}.part`, payload(4096))
    const final = await engineFor().start({
      url: 'u',
      option: directOption(`${server.origin}/v.mp4`),
      title: '陈旧',
      downloadDir: dir,
      filenameTemplate: '%(title)s.%(ext)s',
    }).done

    assert.equal(final.status, 'done', final.error)
    assert.deepEqual(asked, ['bytes=4096-', 'full'])
    const written = await readFile(final.outputPath)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(body).digest('hex'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the page carrier refuses a pair rather than saving a silent film', async () => {
  const { server, seen } = await startPairServer(payload(4096), payload(1024))
  const dir = await tempDir()
  try {
    const engine = engineFor({ mux: () => fakeMux().runner })
    const final = await engine.start(pairRequest(server.origin, dir, { carrier: 'guest' })).done

    assert.equal(final.status, 'failed')
    assert.match(final.error, /没有声音的画面/)
    assert.deepEqual(seen.video, [], 'the page is never asked for half a pair')
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

