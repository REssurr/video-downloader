/**
 * Tests for the "this file is already there" question.
 *
 * The rule the user asked for is a REFUSAL plus a question: a download that would
 * land on an existing file must not start, must not be renamed around the
 * problem, and must not be silently overwritten when the answer says keep. Each
 * of those is a different way to get it wrong, so each has its own test here.
 *
 * The carrier is driven for real (a loopback HTTP server) because the difference
 * between "refused" and "started and quietly renamed" is exactly a filesystem
 * outcome.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDownloadEngine,
  expectedOutputPath,
  nodeDownloadFs,
} from '../lib/test/download.js'

/** A deterministic payload. */
function payload(size, seed = 7) {
  const buffer = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) buffer[index] = (index * seed + 13) % 251
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
  return await mkdtemp(join(tmpdir(), 'dsh-vd-conflict-'))
}

/** An engine over the real fs. */
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

/** A request for the direct carrier. */
function directRequest(dir, directUrl, overrides = {}) {
  return {
    url: 'https://example.com/page',
    option: { id: 'direct', title: '', ext: 'mp4', kind: 'muxed', source: 'guest', directUrl },
    title: 'T',
    downloadDir: dir,
    filenameTemplate: '%(title)s.%(ext)s',
    ...overrides,
  }
}

test('expectedOutputPath predicts the name, and refuses the rest', () => {
  const deps = { fs: nodeDownloadFs() }
  const base = {
    title: 'T',
    downloadDir: '/d',
    filenameTemplate: '%(title)s.%(ext)s',
    option: { id: '1', ext: 'mp4', kind: 'muxed', source: 'guest', directUrl: 'https://cdn.test/v.mp4' },
  }
  assert.equal(expectedOutputPath(deps, base), '/d/T.mp4')
  // The template names the file, so a prefix in it is honoured by the prediction
  // exactly as it is by the carrier.
  assert.equal(expectedOutputPath(deps, { ...base, filenameTemplate: 'hanime-%(title)s.%(ext)s' }), '/d/hanime-T.mp4')
  // An option that is not a whole file has no name to ask about.
  assert.equal(expectedOutputPath(deps, { ...base, option: { ...base.option, ext: 'm3u8' } }), undefined)
  assert.equal(expectedOutputPath(deps, { ...base, option: { id: '1', ext: 'mp4', kind: 'muxed', source: 'guest' } }), undefined)
  // A placeholder this Host cannot fill means the name cannot be verified, and
  // guessing wrong would either miss a conflict or invent one.
  assert.equal(expectedOutputPath(deps, { ...base, filenameTemplate: '%(title)s-%(id)s.%(ext)s' }), undefined)
  // Title sanitization is shared with what the carrier writes.
  assert.equal(expectedOutputPath(deps, { ...base, title: 'a|b' }), '/d/a_b.mp4')
})

test('inspect answers with the occupied path and nothing else', async () => {
  const dir = await tempDir()
  try {
    const engine = engineFor()
    const request = directRequest(dir, 'http://127.0.0.1:1/x.mp4')
    assert.equal(await engine.inspect(request), undefined, 'an empty directory has no conflict')

    await writeFile(join(dir, 'T.mp4'), payload(1234))
    const found = await engine.inspect(request)
    assert.equal(found.path.replace(/\\/g, '/'), join(dir, 'T.mp4').replace(/\\/g, '/'))
    assert.equal(found.bytes, 1234)

    // A DIRECTORY at the target path is not something to ask about overwriting:
    // there is no file to replace, and "覆盖" would be a lie.
    await rm(join(dir, 'T.mp4'))
    await mkdir(join(dir, 'T.mp4'))
    assert.equal(await engine.inspect(request), undefined, 'a directory is not a file to replace')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unanswered conflict starts nothing at all', async () => {
  const body = payload(2048)
  let hits = 0
  const server = await startServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const engine = engineFor()
    const request = directRequest(dir, `${server.origin}/v.mp4`)
    await writeFile(join(dir, 'T.mp4'), 'the file the user already has')

    // What the ROUTE does: inspect first, and never call start when the answer
    // has not been given. Nothing below may touch the network or the disk.
    const existing = await engine.inspect(request)
    assert.ok(existing !== undefined)
    assert.equal(hits, 0, 'inspect must not fetch anything')
    assert.equal(await readFile(join(dir, 'T.mp4'), 'utf8'), 'the file the user already has')
    assert.deepEqual(await readdir(dir), ['T.mp4'], 'no .part file, no second copy')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('answering keep settles as skipped and leaves the file alone', async () => {
  const dir = await tempDir()
  try {
    const engine = engineFor()
    const request = directRequest(dir, 'http://127.0.0.1:1/never-fetched.mp4', {
      onConflict: 'keep',
      existingPath: join(dir, 'T.mp4'),
    })
    await writeFile(join(dir, 'T.mp4'), 'kept')

    const handle = engine.start(request)
    const final = await handle.done
    assert.equal(final.status, 'skipped')
    assert.equal(final.outputPath, join(dir, 'T.mp4'))
    assert.equal(final.receivedBytes, 0, 'nothing was transferred')
    assert.deepEqual(engine.list().map(job => job.status), ['skipped'])
    assert.equal(await readFile(join(dir, 'T.mp4'), 'utf8'), 'kept')
    assert.deepEqual(await readdir(dir), ['T.mp4'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('answering overwrite replaces the file instead of making a second one', async () => {
  const body = payload(4096)
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const engine = engineFor()
    await writeFile(join(dir, 'T.mp4'), 'old bytes')
    const final = await engine.start(directRequest(dir, `${server.origin}/v.mp4`, { onConflict: 'overwrite' })).done
    assert.equal(final.status, 'done', final.error)
    assert.deepEqual(await readdir(dir), ['T.mp4'], 'the old file was replaced, not joined by a (1)')
    assert.equal((await readFile(join(dir, 'T.mp4'))).length, body.length)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('with no answer the direct carrier still refuses to clobber a name', async () => {
  const body = payload(64)
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  const dir = await tempDir()
  try {
    const engine = engineFor()
    await writeFile(join(dir, 'T.mp4'), 'old bytes')
    // This is the pre-existing behaviour, kept for the case where nothing was
    // asked (an unpredicable template, a race): a new name, never a lost file.
    const final = await engine.start(directRequest(dir, `${server.origin}/v.mp4`)).done
    assert.equal(final.status, 'done', final.error)
    assert.equal(await readFile(join(dir, 'T.mp4'), 'utf8'), 'old bytes')
    assert.deepEqual((await readdir(dir)).sort(), ['T (1).mp4', 'T.mp4'])
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

