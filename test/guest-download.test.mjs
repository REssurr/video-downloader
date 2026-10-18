/**
 * The page carrier, end to end.
 *
 * These tests play the part of the sidebar page: they open a REAL loopback HTTP
 * server whose handler IS the upload route, push bytes over it exactly the way the
 * injected script does (query-string metadata, raw body), and then check the file
 * on disk. That is the only way to cover the parts that matter — the offset
 * contract, the loopback guard, the atomic rename after a push, and the watchdog
 * that fails a job whose page never arrives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUEST_MAX_CHUNK_BYTES,
  createDownloadEngine,
  isDirectlyDownloadable,
  nodeDownloadFs,
  resolveCarrier,
} from '../lib/test/download.js'
import { isLoopbackAddress, readGuestUpload } from '../lib/test/guest-upload.js'

/** A deterministic payload, so a byte-level mistake cannot hide in repeated data. */
function payload(size) {
  const buffer = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 7 + 13) % 251
  return buffer
}

/** The sha256 of a buffer, for an assertion that reads as one number. */
function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** A fresh temp directory per test. */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-vd-guest-'))
}

/** A guest option: found inside the page, with the URL the page would fetch. */
function guestOption(directUrl, overrides = {}) {
  return { id: 'guest-1-media', title: 'Guest Video', ext: 'mp4', kind: 'muxed', source: 'guest', directUrl, ...overrides }
}

/** An engine, the real upload route over a real server, and the pieces to drive it. */
async function harness(engineOptions = {}) {
  const dir = await tempDir()
  const updates = []
  const engine = createDownloadEngine(
    {
      fs: nodeDownloadFs(),
      fetch: globalThis.fetch,
      now: () => Date.now(),
    },
    { maxConcurrent: 1, guestStallMs: 300, onUpdate: (job) => { updates.push(job) }, ...engineOptions },
  )
  const target = {
    maxBytes: GUEST_MAX_CHUNK_BYTES,
    isLocal: isLoopbackAddress,
    push: (input) => engine.pushGuest(input.token, input),
    report: (input) => { engine.failGuest(input.token, input.code, input.message) },
  }
  const server = createServer((req, res) => {
    void readGuestUpload(req, target).then((outcome) => {
      res.statusCode = outcome.status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(outcome.body))
    }, (error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`

  /** Push one chunk the way the injected script does. */
  const push = async ({ token, offset, body = Buffer.alloc(0), done = false, total }) => {
    const query = `?token=${encodeURIComponent(token)}&offset=${offset}${done ? '&done=1' : ''}${total === undefined ? '' : `&total=${total}`}`
    const response = await fetch(`${origin}/upload${query}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    })
    return { status: response.status, body: await response.json() }
  }

  /** Report a failure the way the page does. */
  const report = async ({ token, code, message }) => {
    const response = await fetch(`${origin}/upload?token=${encodeURIComponent(token)}&fail=1&code=${encodeURIComponent(code)}&msg=${encodeURIComponent(message)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '',
    })
    return { status: response.status, body: await response.json() }
  }

  return {
    dir,
    engine,
    origin,
    updates,
    push,
    report,
    start(option, overrides = {}) {
      return engine.start({
        url: 'https://example.com/watch',
        option,
        title: 'Guest Video',
        downloadDir: dir,
        filenameTemplate: '%(title)s.%(ext)s',
        carrier: 'guest',
        ...overrides,
      })
    },
    async close() {
      await new Promise((resolve) => { server.close(resolve) })
      await engine.drain()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Wait for one job's terminal view. */
async function settle(handle, timeoutMs = 5000) {
  return await Promise.race([
    handle.done,
    new Promise((resolve) => { setTimeout(() => { resolve(handle.view) }, timeoutMs) }),
  ])
}

test('resolveCarrier only sends the page when the client asked for it', () => {
  const base = { url: 'https://example.com/a', title: 'T', downloadDir: 'D:/d', filenameTemplate: '%(title)s.%(ext)s' }
  const direct = { id: 'x', title: 'T', ext: 'mp4', kind: 'muxed', source: 'guest', directUrl: 'https://cdn.example.com/a.mp4' }
  const manifest = { id: 'x', title: 'T', ext: 'm3u8', kind: 'muxed', source: 'guest', directUrl: 'https://cdn.example.com/a.m3u8' }
  assert.equal(resolveCarrier({ ...base, option: direct }), 'direct')
  // A manifest is still routed to the Host, which then refuses it in words the
  // user can act on: there is no second carrier left to hand it to.
  assert.equal(resolveCarrier({ ...base, option: manifest }), 'direct')
  // A page-sourced option with no explicit request is a byte fetch like any other:
  // the Host's direct carrier is the honest fallback when the page is unusable.
  assert.equal(resolveCarrier({ ...base, option: direct }), 'direct')
  assert.equal(resolveCarrier({ ...base, option: direct, carrier: 'guest' }), 'guest')
  assert.equal(isDirectlyDownloadable(direct), true)
  assert.equal(isDirectlyDownloadable(manifest), false)
  assert.equal(isDirectlyDownloadable({ ...direct, directUrl: undefined }), false)
})

test('the guest carrier writes what the page pushes and renames it into place', async () => {
  const body = payload(300 * 1024)
  const scene = await harness()
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/video.mp4'))
    const token = handle.guest?.token
    assert.equal(typeof token, 'string', 'a guest job mints a token for the page')
    assert.ok(token.length >= 32, 'the token is unguessable rather than a counter')

    const first = body.subarray(0, 100 * 1024)
    const second = body.subarray(100 * 1024)
    const one = await scene.push({ token, offset: 0, body: first, total: body.length })
    assert.equal(one.status, 200)
    assert.equal(one.body.value.received, first.length)
    // `total` came from the page's own `content-length`, and it is what makes the
    // progress bar and the completeness check possible.
    assert.equal(scene.engine.list()[0].totalBytes, body.length)

    const two = await scene.push({ token, offset: first.length, body: second })
    assert.equal(two.body.value.received, body.length)
    const three = await scene.push({ token, offset: body.length, done: true, total: body.length })
    assert.equal(three.body.value.done, true)

    const final = await settle(handle)
    assert.equal(final.status, 'done', `job ended as ${final.status}: ${final.error ?? ''}`)
    assert.equal(final.receivedBytes, body.length)
    assert.equal(final.outputPath?.replace(/\\/g, '/'), join(scene.dir, 'Guest Video.mp4').replace(/\\/g, '/'))
    const written = await readFile(join(scene.dir, 'Guest Video.mp4'))
    assert.equal(digest(written), digest(body), 'the file is exactly the bytes the page pushed')
    const entries = await readdir(scene.dir)
    assert.deepEqual(entries, ['Guest Video.mp4'], 'the .part file is gone: a complete name means a complete file')
  } finally {
    await scene.close()
  }
})

test('an out-of-order chunk is refused, and the file survives it', async () => {
  const body = payload(64 * 1024)
  const scene = await harness()
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/v.mp4'))
    const token = handle.guest?.token
    await scene.push({ token, offset: 0, body: body.subarray(0, 32 * 1024) })

    const wrong = await scene.push({ token, offset: 4096, body: body.subarray(0, 1024) })
    assert.equal(wrong.status, 409)
    assert.equal(wrong.body.error.code, 'offset-mismatch')
    assert.equal(scene.engine.list()[0].receivedBytes, 32 * 1024, 'the refused chunk wrote nothing')

    await scene.push({ token, offset: 32 * 1024, body: body.subarray(32 * 1024), done: true, total: body.length })
    const final = await settle(handle)
    assert.equal(final.status, 'done')
    assert.equal(digest(await readFile(join(scene.dir, 'Guest Video.mp4'))), digest(body))
  } finally {
    await scene.close()
  }
})

test('the upload route refuses what it cannot attribute or identify', async () => {
  const scene = await harness()
  try {
    const unknown = await scene.push({ token: 'nope', offset: 0, body: Buffer.from('x') })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'unknown-token')

    const noToken = await fetch(`${scene.origin}/upload?offset=0`, { method: 'POST', body: 'x' })
    assert.equal(noToken.status, 400)
    const badOffset = await fetch(`${scene.origin}/upload?token=t&offset=-1`, { method: 'POST', body: 'x' })
    assert.equal(badOffset.status, 400)
    const get = await fetch(`${scene.origin}/upload?token=t`, { method: 'GET' })
    assert.equal(get.status, 405)
  } finally {
    await scene.close()
  }
})

test('only a request from this machine may push', async () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress('203.0.113.9'), false)
  // A carrier that cannot tell us where the request came from is refused, not
  // trusted: this route hands bytes to a file.
  assert.equal(isLoopbackAddress(undefined), false)

  const calls = []
  const fakeRequest = (remoteAddress, url) => ({
    method: 'POST',
    url,
    socket: { remoteAddress },
    on(event, listener) {
      if (event === 'end') queueMicrotask(() => { listener() })
      return this
    },
  })
  const target = {
    maxBytes: 1024,
    isLocal: isLoopbackAddress,
    push: (input) => { calls.push(input); return Promise.resolve({ ok: true, received: input.body.length, done: input.done }) },
    report: () => undefined,
  }
  const refused = await readGuestUpload(fakeRequest('203.0.113.9', '/upload?token=t&offset=0'), target)
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, 'forbidden')
  assert.equal(calls.length, 0, 'a remote request never reaches the engine')

  const tooBig = await readGuestUpload(fakeRequest('127.0.0.1', '/upload?token=t&offset=0'), {
    ...target,
    maxBytes: 4,
    push: (input) => { calls.push(input); return Promise.resolve({ ok: true, received: input.body.length, done: input.done }) },
  })
  // The fake body is empty, so this one is accepted; the cap itself is exercised
  // by the oversized-body case below.
  assert.equal(tooBig.status, 200)
})

test('a body over the cap is refused before it can be buffered', async () => {
  const chunk = Buffer.alloc(64)
  const target = {
    maxBytes: 32,
    isLocal: () => true,
    push: () => Promise.resolve({ ok: true, received: 0, done: false }),
    report: () => undefined,
  }
  const request = {
    method: 'POST',
    url: '/upload?token=t&offset=0',
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) {
      if (event === 'data') queueMicrotask(() => { listener(chunk) })
      if (event === 'end') queueMicrotask(() => { listener() })
      return this
    },
  }
  const outcome = await readGuestUpload(request, target)
  assert.equal(outcome.status, 413)
  assert.equal(outcome.body.error.code, 'too-large')
})

test('a page that never pushes fails the job instead of holding the slot', async () => {
  const scene = await harness({ guestStallMs: 200 })
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/quiet.mp4'))
    const final = await settle(handle)
    assert.equal(final.status, 'failed')
    assert.match(String(final.error), /没有(再)?传来数据/)
    assert.deepEqual(await readdir(scene.dir), [], 'nothing was written for a download that never arrived')
  } finally {
    await scene.close()
  }
})

test('a failure the page reports is the job failure, in the page words', async () => {
  const scene = await harness()
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/blocked.mp4'))
    const token = handle.guest?.token
    const reported = await scene.report({ token, code: 'http-error', message: '站点返回 HTTP 403' })
    assert.equal(reported.status, 200)
    const final = await settle(handle)
    assert.equal(final.status, 'failed')
    assert.equal(final.error, '站点返回 HTTP 403')
  } finally {
    await scene.close()
  }
})

test('a manifest is refused before anything is created', async () => {
  const scene = await harness()
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/master.m3u8', { ext: 'm3u8' }))
    assert.equal(typeof handle.guest?.token, 'string', 'the token exists; the refusal happens inside the carrier')
    const final = await settle(handle)
    assert.equal(final.status, 'failed')
    assert.match(String(final.error), /不是一个可以直接保存的文件/)
    assert.deepEqual(await readdir(scene.dir), [])
  } finally {
    await scene.close()
  }
})

test('a short push against a declared total is incomplete, and keeps the part file', async () => {
  const body = payload(8192)
  const scene = await harness()
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/cut.mp4'))
    const token = handle.guest?.token
    await scene.push({ token, offset: 0, body: body.subarray(0, 4096), total: body.length })
    await scene.push({ token, offset: 4096, done: true, total: body.length })
    const final = await settle(handle)
    assert.equal(final.status, 'failed')
    assert.match(String(final.error), /实际只收到 4096/)
    assert.deepEqual(await readdir(scene.dir), ['Guest Video.mp4.part'], 'the partial file is kept, and never renamed')
  } finally {
    await scene.close()
  }
})

test('cancelling a guest job stops the transfer and keeps the partial file', async () => {
  const body = payload(4096)
  const scene = await harness({ guestStallMs: 5000 })
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/cancel.mp4'))
    const token = handle.guest?.token
    await scene.push({ token, offset: 0, body })
    handle.cancel()
    const final = await settle(handle)
    assert.equal(final.status, 'cancelled')
    const part = join(scene.dir, 'Guest Video.mp4.part')
    assert.equal((await stat(part)).size, body.length)
  } finally {
    await scene.close()
  }
})

test('the token stops working once the job is over', async () => {
  const scene = await harness()
  try {
    const handle = scene.start(guestOption('https://cdn.example.com/once.mp4'))
    const token = handle.guest?.token
    await scene.push({ token, offset: 0, body: Buffer.from('abc'), total: 3 })
    await scene.push({ token, offset: 3, done: true, total: 3 })
    assert.equal((await settle(handle)).status, 'done')
    const late = await scene.push({ token, offset: 3, body: Buffer.from('late') })
    assert.equal(late.status, 404)
    assert.equal(late.body.error.code, 'unknown-token')
  } finally {
    await scene.close()
  }
})
