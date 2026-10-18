/**
 * End-to-end test of the Host's wire surface with a FAKE extension.
 *
 * Everything the extension does is a message on one socket plus bytes on the
 * upload route, so a test can play the extension's part exactly: handshake,
 * tab events, command answers, and a chunked byte push. What is exercised here is
 * the real server, the real download engine, the real refusal rules and the real
 * file on disk — not a mock of them.
 *
 * The fixture video is served by a real HTTP server on 127.0.0.1, so the test
 * needs no network access.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHostServer } from '../lib/test/host/server.js'

// Point the legacy-settings import at an empty directory: a test must never
// adopt the machine's real plugin config (or write into its download folder).
process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'vd-empty-home-'))

const HAS_WEBSOCKET = typeof WebSocket === 'function'

/** Serve one buffer on a loopback port; resolves with its URL. */
function serveBuffer(body, contentType) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const range = req.headers.range
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (match !== null) {
          const start = match[1] === '' ? 0 : Number(match[1])
          const end = match[2] === '' ? body.length - 1 : Math.min(Number(match[2]), body.length - 1)
          res.statusCode = 206
          res.setHeader('content-type', contentType)
          res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
          res.setHeader('accept-ranges', 'bytes')
          res.end(body.subarray(start, end + 1))
          return
        }
      }
      res.statusCode = 200
      res.setHeader('content-type', contentType)
      res.setHeader('content-length', String(body.length))
      res.setHeader('accept-ranges', 'bytes')
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port, url: `http://127.0.0.1:${address.port}/sample.mp4` })
    })
  })
}

/** POST one JSON API method. */
async function api(port, method, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/video-downloader/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

/** A fake extension: one socket, one command handler. */
function fakeExtension(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/video-downloader/ext/ws`)
  const commands = []
  const waiters = new Map()
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('扩展连接失败')), { once: true })
  })
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.type !== 'command') return
    commands.push(frame)
    const waiter = waiters.get(frame.name)
    if (waiter !== undefined) {
      waiters.delete(frame.name)
      waiter(frame)
    }
  })
  /** Answer every command of one name as it arrives. */
  const when = (name, handler) => new Promise((resolve) => {
    waiters.set(name, (_frame) => {
      void Promise.resolve(handler(_frame)).then(resolve)
    })
  })
  const reply = (frame, value) => {
    socket.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value }))
  }
  return {
    socket,
    commands,
    opened,
    when,
    reply,
    hello: () => socket.send(JSON.stringify({ type: 'hello', protocol: 1, version: '0.0.1-test', browser: 'Chrome' })),
    tab: (tab) => socket.send(JSON.stringify({ type: 'tab', tab })),
    close: () => socket.close(),
  }
}

test('host serves the renderer and the API on a loopback port', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'vd-state-'))
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-dl-'))
  const host = await startHostServer({
    stateDir,
    defaultDownloadDir: downloadDir,
    staticDir: join(process.cwd(), 'dist/renderer'),
    version: '0.0.0-test',
    basePort: 47_900,
    pickDirectory: async () => null,
  })
  try {
    const page = await fetch(`${host.url}`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<div id="root">/)
    const script = await fetch(new URL('/app.js', host.url))
    assert.equal(script.status, 200)
    const state = await api(host.port, 'state')
    assert.equal(state.body.ok, true)
    assert.equal(state.body.value.version, '0.0.0-test')
    assert.equal(state.body.value.extension.connected, false)
    assert.equal(state.body.value.health.api, true)
  } finally {
    await host.close()
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
})

test('a request carrying another site Origin is refused', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'vd-state-'))
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-dl-'))
  const host = await startHostServer({
    stateDir,
    defaultDownloadDir: downloadDir,
    staticDir: join(process.cwd(), 'dist/renderer'),
    version: '0.0.0-test',
    basePort: 47_910,
    pickDirectory: async () => null,
  })
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/video-downloader/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })
    assert.equal(response.status, 403)
  } finally {
    await host.close()
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
})

test('the extension can register a harvest and download it end to end', { skip: !HAS_WEBSOCKET }, async () => {
  const video = Buffer.alloc(256 * 1024)
  for (let index = 0; index < video.length; index += 1) video[index] = index % 251
  const served = await serveBuffer(video, 'video/mp4')
  const stateDir = mkdtempSync(join(tmpdir(), 'vd-state-'))
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-dl-'))
  const host = await startHostServer({
    stateDir,
    defaultDownloadDir: downloadDir,
    staticDir: join(process.cwd(), 'dist/renderer'),
    version: '0.0.0-test',
    basePort: 47_920,
    pickDirectory: async () => null,
  })
  const pageUrl = `http://127.0.0.1:${served.port}/page.html`
  const extension = fakeExtension(host.port)
  try {
    await extension.opened
    extension.hello()
    extension.tab({ id: 7, url: pageUrl, title: '本地验收页', media: 'fp-1' })

    // The Host must learn about the connection and the tab from the socket alone.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const status = await api(host.port, 'ext.status')
    assert.equal(status.body.ok, true)
    assert.equal(status.body.value.connected, true)
    assert.equal(status.body.value.browser, 'Chrome')
    assert.equal(status.body.value.tab.id, 7)

    // A harvest: the Host asks, the fake extension answers with the same shape
    // the real one produces, and the Host turns it into rows.
    const harvestAnswer = extension.when('harvest', (frame) => {
      assert.equal(frame.args.tabId, 7)
      extension.reply(frame, {
        url: pageUrl,
        title: '本地验收页',
        videos: [{ src: served.url, duration: 3, width: 320, height: 240 }],
        sources: [],
        links: [],
        og: [],
        perf: [],
        jsonLd: [],
        site: null,
      })
    })
    const harvested = await api(host.port, 'ext.harvest', { canMerge: false })
    await harvestAnswer
    assert.equal(harvested.body.ok, true)
    assert.deepEqual(harvested.body.value.videos[0].src, served.url)

    const registered = await api(host.port, 'probe.registerGuest', {
      url: pageUrl,
      title: '本地验收页',
      candidates: [{ url: served.url, ext: 'mp4', height: 240, label: '页面 <video>' }],
    })
    assert.equal(registered.body.ok, true)
    const entries = registered.body.value.record.entries
    assert.equal(entries.length, 1)
    const formatId = entries[0].options[0].id

    // Start it on the EXTENSION carrier: the Host must ask the fake extension to
    // fetch, hand it a token, and accept the bytes that come back on /upload.
    const started = await api(host.port, 'download.start', {
      url: pageUrl,
      formatId,
      carrier: 'guest',
    })
    assert.equal(started.body.ok, true)
    const { jobId, guestToken } = started.body.value
    assert.ok(typeof jobId === 'string')
    assert.ok(typeof guestToken === 'string')

    const asked = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 2_000)
      const poll = () => {
        const frame = extension.commands.find(candidate => candidate.name === 'fetchMedia')
        if (frame !== undefined) { clearTimeout(timer); resolve(frame) }
        else setTimeout(poll, 20)
      }
      poll()
    })
    assert.ok(asked !== undefined, 'the Host must ask the extension to fetch the bytes')
    assert.equal(asked.args.token, guestToken)

    // Push the bytes the way the real extension does: ordered chunks, then done.
    const chunkBytes = 64 * 1024
    let offset = 0
    for (; offset < video.length; offset += chunkBytes) {
      const part = video.subarray(offset, Math.min(video.length, offset + chunkBytes))
      const response = await fetch(
        `http://127.0.0.1:${host.port}/video-downloader/upload?token=${encodeURIComponent(guestToken)}&offset=${offset}`,
        { method: 'POST', headers: { 'content-type': 'text/plain' }, body: part },
      )
      assert.equal(response.status, 200)
    }
    const finished = await fetch(
      `http://127.0.0.1:${host.port}/video-downloader/upload?token=${encodeURIComponent(guestToken)}&offset=${offset}&done=1&total=${video.length}`,
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '' },
    )
    assert.equal(finished.status, 200)

    // The job reaches `done` and the file on disk is byte-for-byte the fixture.
    let job
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const jobs = await api(host.port, 'jobs.list')
      job = jobs.body.value.jobs.find(candidate => candidate.id === jobId)
      if (job !== undefined && (job.status === 'done' || job.status === 'failed')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(job?.status, 'done', `job status: ${job?.status} ${job?.error ?? ''}`)
    assert.ok(job.outputPath !== undefined)
    assert.deepEqual(readFileSync(job.outputPath), video)
  } finally {
    extension.close()
    await host.close()
    served.server.close()
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
})

test('an extension that never connects makes the page features answer with a sentence', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'vd-state-'))
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-dl-'))
  const host = await startHostServer({
    stateDir,
    defaultDownloadDir: downloadDir,
    staticDir: join(process.cwd(), 'dist/renderer'),
    version: '0.0.0-test',
    basePort: 47_930,
    pickDirectory: async () => null,
  })
  try {
    const harvested = await api(host.port, 'ext.harvest', { canMerge: false })
    assert.equal(harvested.body.ok, false)
    assert.match(harvested.body.error.message, /扩展未连接/)
  } finally {
    await host.close()
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
})
