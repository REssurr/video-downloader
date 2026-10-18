/**
 * Route-dispatcher tests.
 *
 * The dispatcher is the wire contract, so these cases pin the things a client
 * depends on: stable error codes, URL validation that refuses what the Host must
 * not fetch, the conflict question riding along with a download start, and config
 * mutations that actually persist through the injected writer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, hostOf, requireHttpUrl } from '../lib/test/routes.js'

/** A config document for the fake services. */
function baseConfig(overrides = {}) {
  return {
    schema: 1,
    downloadDir: 'C:/out',
    filenameTemplate: '%(title)s.%(ext)s',
    maxConcurrent: 1,
    mp4Only: true,
    downloadPath: 'auto',
    ...overrides,
  }
}

/** A harvest outcome with two options of different quality. */
function outcome(overrides = {}) {
  return {
    source: 'guest',
    pageTitle: '页面标题',
    notes: [],
    entries: [
      {
        id: 'e1',
        title: '第一个视频',
        url: 'https://example.com/v/1',
        options: [
          { id: '1080', title: '第一个视频', ext: 'mp4', kind: 'muxed', source: 'guest', height: 1080 },
          { id: '360', title: '第一个视频', ext: 'mp4', kind: 'muxed', source: 'guest', height: 360 },
        ],
      },
    ],
    ...overrides,
  }
}

/** A fake DownloaderServices that records every mutation. */
function fakeServices(overrides = {}) {
  const state = {
    config: baseConfig(),
    saved: [],
    jobs: [],
    started: [],
    cancelled: [],
    notices: [],
    // What this fake machine answered about ffmpeg: found, and where.
    merge: { available: true, path: 'C:/tools/bin/ffmpeg.exe', version: 'ffmpeg version 9.0.2-essentials' },
  }
  const services = {
    version: '9.9.9',
    config: () => state.config,
    configPath: 'C:/cfg/config.json',
    notices: () => state.notices,
    async setConfig(next) {
      state.config = next
      state.saved.push(next)
    },
    async network() {
      state.networkReads = (state.networkReads ?? 0) + 1
      return { proxied: true, proxy: 'http://127.0.0.1:65532', source: 'system' }
    },
    invalidateNetwork() { state.networkInvalidated = (state.networkInvalidated ?? 0) + 1 },
    // Finding a muxer is asynchronous and happens once, so the state envelope has to wait
    // for the answer: the panel and the page adapter are told the same fact from here.
    async merge() {
      state.mergeReads = (state.mergeReads ?? 0) + 1
      return state.merge
    },
    invalidateProbes() { state.probesInvalidated = (state.probesInvalidated ?? 0) + 1 },
    async pickDirectory() { return 'D:/videos' },
    startDownload(input) {
      state.started.push(input)
      return { jobId: 'job-1' }
    },
    cancelJob(jobId) { state.cancelled.push(jobId) },
    jobs: () => state.jobs,
    extension: () => ({ connected: false, note: '扩展未连接', since: 0 }),
    health: () => ({ api: true, eventSocket: true, socketAccepted: false }),
    ...overrides,
  }
  return { services, state }
}

test('requireHttpUrl normalizes, adds a scheme, and refuses what must not be fetched', () => {
  assert.equal(requireHttpUrl('example.com/a'), 'https://example.com/a')
  assert.equal(requireHttpUrl('http://example.com/a'), 'http://example.com/a')
  assert.equal(requireHttpUrl('  https://example.com/a  '), 'https://example.com/a')
  const rejects = (input, code) => {
    try {
      requireHttpUrl(input)
      assert.fail(`expected ${input} to be refused`)
    } catch (error) {
      assert.equal(error.code, code, `${input} -> ${error.code}`)
    }
  }
  rejects('', 'bad-request')
  rejects('   ', 'bad-request')
  rejects('not a url', 'bad-request')
  // A non-web scheme would make the HOST fetch something the user never meant.
  rejects('file:///c:/a.mp4', 'bad-request')
  rejects('javascript:alert(1)', 'bad-request')
  rejects('ftp://example.com/a', 'bad-request')
  rejects('https://user:pw@example.com/a', 'bad-request')
  rejects(`https://example.com/${'x'.repeat(17_000)}`, 'bad-request')
})

test('hostOf lower-cases and returns empty for an unparsable value', () => {
  assert.equal(hostOf('https://Www.Example.COM/a'), 'www.example.com')
  // A scheme-less word has no absolute URL, so there is no host to report.
  assert.equal(hostOf('nonsense'), '')
  assert.equal(hostOf(''), '')
})

test('ping reports the version and the live prefix', async () => {
  const { services } = fakeServices()
  const dispatcher = createDispatcher(services)
  const envelope = await dispatcher.dispatch('ping', {})
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.version, '9.9.9')
  assert.equal(envelope.value.pong, true)
})

test('state bundles config, network, jobs, and notices', async () => {
  const { services, state } = fakeServices()
  state.notices.push('配置里有不认识的值，已丢弃')
  state.jobs.push({ id: 'j1', status: 'done' })
  const envelope = await createDispatcher(services).dispatch('state', {})
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.config.downloadDir, 'C:/out')
  assert.equal(envelope.value.configPath, 'C:/cfg/config.json')
  // The panel needs to be able to say WHICH proxy these requests use; without it
  // "the browser opens it, the plugin does not" has no visible cause.
  assert.equal(envelope.value.network.proxied, true)
  assert.equal(envelope.value.network.proxy, 'http://127.0.0.1:65532')
  assert.equal(state.networkReads, 1)
  assert.equal(envelope.value.jobs.length, 1)
  assert.deepEqual(envelope.value.notices, ['配置里有不认识的值，已丢弃'])
  // Whether this machine can merge a separated pair travels with everything else: a row
  // that needs ffmpeg must not appear on a machine that has none.
  assert.deepEqual(envelope.value.merge, state.merge)
  assert.equal(state.mergeReads, 1)
})

test('config.set clamps numbers and persists through the injected writer', async () => {
  const { services, state } = fakeServices()
  const envelope = await createDispatcher(services).dispatch('config.set', {
    downloadDir: 'E:/media',
    maxConcurrent: 99,
  })
  assert.equal(envelope.ok, true)
  assert.equal(state.saved.length, 1, 'the writer was called once')
  assert.equal(state.config.downloadDir, 'E:/media')
  assert.equal(state.config.maxConcurrent, 4, 'clamped to the maximum')
  // An absent field must not be reset to a default.
  assert.equal(state.config.filenameTemplate, '%(title)s.%(ext)s')
})

test('config.set accepts the proxy, and drops the cached decision', async () => {
  const { services, state } = fakeServices()
  const envelope = await createDispatcher(services).dispatch('config.set', {
    proxy: '  127.0.0.1:65532  ',
  })
  assert.equal(envelope.ok, true)
  // Trimmed here; the config validator is the gate that rejects anything unusable,
  // this route only normalizes.
  assert.equal(state.config.proxy, '127.0.0.1:65532')
  // The other fields must survive a patch that does not mention them.
  assert.equal(state.config.downloadDir, 'C:/out')
  assert.equal(state.config.downloadPath, 'auto')
  assert.equal(state.networkInvalidated, 1, 'the proxy decision is cached, so it must be dropped')
})

test('config.set flips the media policy, and drops the probe cache only when it changes', async () => {
  const { services, state } = fakeServices()
  const dispatcher = createDispatcher(services)

  const off = await dispatcher.dispatch('config.set', { mp4Only: false })
  assert.equal(off.ok, true)
  assert.equal(state.config.mp4Only, false)
  // A cached probe was filtered by the OLD policy, and `download.start` resolves its
  // option against that cache: without the drop, a format the user just re-enabled
  // would still be missing and a hidden one would still be startable.
  assert.equal(state.probesInvalidated, 1, 'the cached probes were filtered by the old policy')

  // Re-sending the same value is not a change, and must not cost the cache.
  await dispatcher.dispatch('config.set', { mp4Only: false })
  assert.equal(state.probesInvalidated, 1)

  // Anything else is not a boolean and is ignored rather than coerced: "false" is
  // truthy in JavaScript, so a text field must never be able to turn the filter on.
  await dispatcher.dispatch('config.set', { mp4Only: 'false' })
  assert.equal(state.config.mp4Only, false)
  assert.equal(state.probesInvalidated, 1)
})

test('config.pickDirectory updates the directory, or reports a cancelled pick', async () => {
  const { services, state } = fakeServices()
  const dispatcher = createDispatcher(services)
  const picked = await dispatcher.dispatch('config.pickDirectory', {})
  assert.deepEqual(picked.value.cancelled, false)
  assert.equal(state.config.downloadDir, 'D:/videos')

  const cancelling = fakeServices({ pickDirectory: async () => null })
  const cancelled = await createDispatcher(cancelling.services).dispatch('config.pickDirectory', {})
  assert.equal(cancelled.value.cancelled, true)
  assert.equal(cancelling.state.saved.length, 0, 'a cancelled pick must not write anything')
})

test('download.start forwards the resolved coordinates and download.cancel reaches the engine', async () => {
  const { services, state } = fakeServices()
  const dispatcher = createDispatcher(services)
  const started = await dispatcher.dispatch('download.start', {
    url: 'https://example.com/v',
    formatId: '1080',
    entryId: 'e1',
  })
  assert.equal(started.ok, true)
  assert.equal(started.value.jobId, 'job-1')
  assert.deepEqual(state.started[0], { url: 'https://example.com/v', formatId: '1080', entryId: 'e1' })

  const cancelled = await dispatcher.dispatch('download.cancel', { jobId: 'job-1' })
  assert.equal(cancelled.ok, true)
  assert.deepEqual(state.cancelled, ['job-1'])
})

test('download.start surfaces a start failure as a wire error with its message', async () => {
  const { services } = fakeServices({
    startDownload() { throw new Error('请先探测该网址') },
  })
  const envelope = await createDispatcher(services).dispatch('download.start', {
    url: 'https://example.com/v',
    formatId: '1080',
  })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.message, '请先探测该网址')
})

test('download.start carries the question back, and only accepts the two answers', async () => {
  // The Host refuses to start when a file is already at the target path: the
  // envelope is a SUCCESS carrying a conflict, not an error, because nothing has
  // gone wrong — the user simply has not been asked yet.
  const conflict = { path: 'D:/videos/T.mp4', existingBytes: 1234, incomingHeight: 720 }
  const { services, state } = fakeServices({
    async startDownload(input) {
      state.started.push(input)
      return input.onConflict === undefined ? { conflict } : { jobId: 'job-1' }
    },
  })
  const dispatcher = createDispatcher(services)

  const asked = await dispatcher.dispatch('download.start', { url: 'https://example.com/v', formatId: '720' })
  assert.equal(asked.ok, true)
  assert.deepEqual(asked.value.conflict, conflict)
  assert.equal(asked.value.jobId, undefined)
  assert.deepEqual(state.started[0], { url: 'https://example.com/v', formatId: '720' }, 'no answer is sent until the user gives one')

  for (const onConflict of ['overwrite', 'keep']) {
    const answered = await dispatcher.dispatch('download.start', { url: 'https://example.com/v', formatId: '720', onConflict })
    assert.equal(answered.ok, true)
    assert.equal(answered.value.jobId, 'job-1')
    assert.equal(state.started.at(-1).onConflict, onConflict)
  }

  // A third answer is a client bug, and it must not reach the engine to be
  // interpreted as "not overwrite" by accident.
  const rejected = await dispatcher.dispatch('download.start', {
    url: 'https://example.com/v',
    formatId: '720',
    onConflict: 'rename',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'bad-request')
  assert.equal(state.started.length, 3)
})

test('the removed rules and chat methods answer not-found instead of half-working', async () => {
  // The rules engine and its natural-language assistant were deleted. A stale
  // client (or an old tab) that still calls them must get the same envelope an
  // unknown method gets, so nothing silently pretends a rule was saved.
  const { services, state } = fakeServices()
  const dispatcher = createDispatcher(services)
  for (const method of ['rules.list', 'rules.upsert', 'rules.delete', 'rules.toggle', 'chat.send', 'chat.apply']) {
    const envelope = await dispatcher.dispatch(method, {
      id: 'r1',
      host: 'example.com',
      when: { minHeight: 720 },
      effect: { action: 'deny' },
    })
    assert.equal(envelope.ok, false, method)
    assert.equal(envelope.error.code, 'not-found', method)
  }
  assert.equal(state.saved.length, 0, 'nothing may be written for a method that no longer exists')
})

test('jobs.list returns the engine list', async () => {
  const { services, state } = fakeServices()
  state.jobs.push({ id: 'j1', status: 'running' })
  const envelope = await createDispatcher(services).dispatch('jobs.list', {})
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.jobs.length, 1)
})

test('an unknown method is a not-found envelope, never a throw', async () => {
  const { services } = fakeServices()
  const envelope = await createDispatcher(services).dispatch('nope', {})
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'not-found')
})

test('an unexpected service failure becomes an internal envelope', async () => {
  const { services } = fakeServices({
    config() { throw new Error('boom') },
  })
  const envelope = await createDispatcher(services).dispatch('state', {})
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'internal')
  assert.equal(envelope.error.message, 'boom')
})
