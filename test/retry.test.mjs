/**
 * 「重新下载」：失败的任务换成另一条通道再跑一遍。
 *
 * 复现的是用户真实遇到的那次失败：直连的 TCP 连接在传输开始前就被服务端掐断
 * （页面上显示 `read ECONNRESET`），任务的错误只是原始的网络错误文本，没有任何
 * 自动重试。这里用一台「开关打开时直接断开、打开关掉后正常」的本机服务器制造同一个
 * 失败，然后验证：点重新下载会新建任务、换通道、最终落盘字节与原文件一致。
 *
 * 每个用例起自己的 Host：端口和下载目录都写进它自己的配置里，互相不干扰。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHostServer } from '../lib/test/host/server.js'

// 测试绝不能读到这台机器上真实的旧插件配置，也不能往用户下载目录里写东西。
process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'vd-empty-home-'))

let nextPort = 48_950

/** 起一个只用一次的 Host（独立端口 + 独立下载目录）。 */
async function makeHost() {
  const stateDir = mkdtempSync(join(tmpdir(), 'vd-state-'))
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-dl-'))
  const port = nextPort
  nextPort += 1
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ schema: 1, port, downloadDir }))
  const host = await startHostServer({
    stateDir,
    defaultDownloadDir: downloadDir,
    staticDir: join(process.cwd(), 'dist/renderer'),
    version: '0.0.0-test',
    basePort: port,
    pickDirectory: async () => null,
  })
  return {
    host,
    async cleanup() {
      await host.close()
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(downloadDir, { recursive: true, force: true })
    },
  }
}

/** POST 一个 JSON API 方法。 */
async function api(host, method, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${host.port}/video-downloader/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return await response.json()
}

/**
 * 一台可切换「掐断连接」的本机视频服务器：开关打开时一个字节都不给直接断开
 * （像 CDN 那样），关掉后正常提供整份文件并支持 Range。
 * 用 127.0.0.1 上的真实 socket 制造，而不是 mock fetch。
 */
function makeSource(bytes, contentType) {
  const state = { failing: true, hits: 0 }
  const server = createServer((req, res) => {
    state.hits += 1
    if (state.failing) {
      req.socket.destroy()
      return
    }
    const range = req.headers.range
    const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match !== null) {
      const start = match[1] === '' ? 0 : Number(match[1])
      const end = match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1)
      res.statusCode = 206
      res.setHeader('content-type', contentType)
      res.setHeader('content-range', `bytes ${start}-${end}/${bytes.length}`)
      res.setHeader('accept-ranges', 'bytes')
      res.end(bytes.subarray(start, end + 1))
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', contentType)
    res.setHeader('content-length', String(bytes.length))
    res.setHeader('accept-ranges', 'bytes')
    res.end(bytes)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ state, server, url: `http://127.0.0.1:${address.port}/sample.mp4` })
    })
  })
}

/** 注册一份页面候选，返回它的清晰度 id。 */
async function register(host, pageUrl, sourceUrl) {
  const registered = await api(host, 'probe.registerGuest', {
    url: pageUrl,
    title: '重新下载测试页',
    candidates: [{ url: sourceUrl, ext: 'mp4', height: 720, label: '页面 <video>' }],
  })
  assert.equal(registered.ok, true, JSON.stringify(registered))
  return registered.value.record.entries[0].options[0].id
}

/** 一个只回 hello、只会收 fetchMedia 的假扩展。 */
function fakeExtension(host) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/video-downloader/ext/ws`)
  const commands = []
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.type === 'command') commands.push(frame)
  })
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('扩展连接失败')), { once: true })
  })
  return {
    socket,
    commands,
    opened,
    hello: () => socket.send(JSON.stringify({ type: 'hello', protocol: 1, version: '0.0.1-test', browser: 'Chrome' })),
  }
}

/** 轮询到一个任务结束（done / failed）。 */
async function waitForJob(host, jobId) {
  assert.ok(typeof jobId === 'string', 'Host 必须返回任务 id')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const jobs = await api(host, 'jobs.list')
    const job = jobs.value.jobs.find(candidate => candidate.id === jobId)
    if (job !== undefined && (job.status === 'done' || job.status === 'failed')) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`任务 ${jobId} 一直没有结束`)
}

/** 在扩展通道上按真实扩展的方式把字节推给 Host。 */
async function pushBytes(host, token, bytes) {
  const chunkBytes = 32 * 1024
  let offset = 0
  for (; offset < bytes.length; offset += chunkBytes) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes))
    const response = await fetch(
      `http://127.0.0.1:${host.port}/video-downloader/upload?token=${encodeURIComponent(token)}&offset=${offset}`,
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: part },
    )
    assert.equal(response.status, 200)
  }
  const finished = await fetch(
    `http://127.0.0.1:${host.port}/video-downloader/upload?token=${encodeURIComponent(token)}&offset=${offset}&done=1&total=${bytes.length}`,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '' },
  )
  assert.equal(finished.status, 200)
}

/** 一份可辨识的假视频。 */
function sampleBytes() {
  const bytes = Buffer.alloc(96 * 1024)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
  return bytes
}

test('a failed job is retried and the same file finishes on the second run', async () => {
  const bytes = sampleBytes()
  const source = await makeSource(bytes, 'video/mp4')
  const { host, cleanup } = await makeHost()
  const pageUrl = `http://127.0.0.1:${source.server.address().port}/page.html`
  try {
    const formatId = await register(host, pageUrl, source.url)
    const started = await api(host, 'download.start', { url: pageUrl, formatId })
    assert.equal(started.ok, true, JSON.stringify(started))
    const failed = await waitForJob(host, started.value.jobId)
    assert.equal(failed.status, 'failed', `第一次就应该失败：${failed.status} ${failed.error ?? ''}`)
    assert.equal(failed.carrier, 'direct')
    // 错误原文来自 socket，用户看到的就是它：至少得是传输类错误，而不是「链接不对」。
    assert.match(String(failed.error), /ECONNRESET|socket hang up|fetch failed|传输失败/i)

    // 服务端恢复正常（用户那句「能正常下下来就行」面对的就是这种瞬时中断）。
    source.state.failing = false
    const retried = await api(host, 'download.retry', { jobId: failed.id })
    assert.equal(retried.ok, true, JSON.stringify(retried))
    const newJobId = retried.value.jobId
    assert.notEqual(newJobId, failed.id)

    const done = await waitForJob(host, newJobId)
    assert.equal(done.status, 'done', `重试后应该完成：${done.status} ${done.error ?? ''}`)
    // 扩展没连上，只能按原通道再跑一遍——这就是「先重试一次」的行为。
    assert.equal(done.carrier, 'direct')
    assert.ok(done.outputPath !== undefined)
    assert.deepEqual(readFileSync(done.outputPath), bytes)

    // 失败的那条仍然留在列表里，是历史，不是被替换掉的。
    const jobs = await api(host, 'jobs.list')
    assert.ok(jobs.value.jobs.some(job => job.id === failed.id && job.status === 'failed'))
  } finally {
    source.server.close()
    await cleanup()
  }
})

test('a failed DIRECT job is retried on the extension carrier when one is connected', async () => {
  const bytes = sampleBytes()
  const source = await makeSource(bytes, 'video/mp4')
  const { host, cleanup } = await makeHost()
  const pageUrl = `http://127.0.0.1:${source.server.address().port}/page.html`
  const extension = fakeExtension(host)
  try {
    await extension.opened
    extension.hello()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal((await api(host, 'ext.status')).value.connected, true)

    const formatId = await register(host, pageUrl, source.url)
    const started = await api(host, 'download.start', { url: pageUrl, formatId })
    const failed = await waitForJob(host, started.value.jobId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.carrier, 'direct')

    // 重试时服务已恢复：Host 应该改让扩展去取，而不是再撞一次同一个断点。
    source.state.failing = false
    const retried = await api(host, 'download.retry', { jobId: failed.id })
    assert.equal(retried.ok, true, JSON.stringify(retried))
    const { jobId: newJobId, guestToken } = retried.value
    assert.ok(typeof guestToken === 'string', '换到扩展通道时必须发一个上传令牌')

    // Host 必须让扩展去取这份文件，并且带上的是新的令牌。
    let asked
    for (let attempt = 0; attempt < 100; attempt += 1) {
      asked = extension.commands.find(frame => frame.name === 'fetchMedia')
      if (asked !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(asked !== undefined, 'Host 必须让扩展去抓字节')
    assert.equal(asked.args.token, guestToken)
    assert.equal(asked.args.url, source.url)

    await pushBytes(host, guestToken, bytes)
    const done = await waitForJob(host, newJobId)
    assert.equal(done.status, 'done', `换通道后应该完成：${done.status} ${done.error ?? ''}`)
    assert.equal(done.carrier, 'guest')
    assert.deepEqual(readFileSync(done.outputPath), bytes)
  } finally {
    extension.socket.close()
    source.server.close()
    await cleanup()
  }
})

test('retry refuses a job that is not failed and a job it does not know', async () => {
  const bytes = sampleBytes()
  const source = await makeSource(bytes, 'video/mp4')
  const { host, cleanup } = await makeHost()
  const pageUrl = `http://127.0.0.1:${source.server.address().port}/page.html`
  try {
    const unknown = await api(host, 'download.retry', { jobId: 'job-does-not-exist' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'not-found')

    // 先失败一次、再成功重试一次，然后拿已经完成的任务点重试：这不是出错，是没什么可重试的。
    const formatId = await register(host, pageUrl, source.url)
    const started = await api(host, 'download.start', { url: pageUrl, formatId })
    const failed = await waitForJob(host, started.value.jobId)
    assert.equal(failed.status, 'failed')
    source.state.failing = false
    const retried = await api(host, 'download.retry', { jobId: failed.id })
    const done = await waitForJob(host, retried.value.jobId)
    assert.equal(done.status, 'done')

    const refused = await api(host, 'download.retry', { jobId: done.id })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'bad-request')
    assert.match(refused.error.message, /只有失败的下载/)
  } finally {
    source.server.close()
    await cleanup()
  }
})
