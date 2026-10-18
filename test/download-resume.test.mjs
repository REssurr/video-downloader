/**
 * 下载引擎里两件"会静默出错"的事，各钉一组用例：
 *
 * 1. **断点续传必须有校验**：`.part` 只是字节，不能证明它和服务器现在要给的
 *    是同一份文件。只有 `Content-Range` 起点与磁盘长度一致、且 ETag/Last-Modified
 *    没变，才允许续；否则从头重下，绝不拼出新旧混合的文件。
 * 2. **扩展下载的令牌必须随任务结束一起作废**：排队中被取消、或用户选择"保留已有
 *    文件"时，任务从未真正运行，令牌却已经发布过。若不回收，页面之后再来推字节
 *    会永远等一个不会出现的接收方（HTTP 请求挂死）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDownloadEngine, nodeDownloadFs } from '../lib/test/download.js'

const CONTENT = Buffer.alloc(300)
for (let index = 0; index < CONTENT.length; index += 1) CONTENT[index] = index % 251

/** A loopback media server whose behaviour each test programs. */
async function mediaServer() {
  const state = { etag: '"v1"', forcedStart: undefined, ignoreRange: false, requests: [] }
  const server = createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers['range'] ?? '')
    state.requests.push({ range: req.headers['range'], ifRange: req.headers['if-range'] })
    if (range !== null && !state.ignoreRange) {
      const start = state.forcedStart ?? Number(range[1])
      const body = CONTENT.subarray(start)
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': String(body.length),
        'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
        etag: state.etag,
      })
      res.end(body)
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(CONTENT.length), etag: state.etag })
    res.end(CONTENT)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { state, base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** One request as the Host builds it for a plain mp4. */
function requestOf(base, downloadDir, overrides = {}) {
  return {
    url: `${base}/media.mp4`,
    option: { id: 'f1', title: 'resume-test', ext: 'mp4', directUrl: `${base}/media.mp4`, kind: 'muxed', source: 'guest' },
    title: 'resume-test',
    downloadDir,
    filenameTemplate: '%(title)s.%(ext)s',
    ...overrides,
  }
}

/** A fresh engine over the real filesystem and real fetch. */
function engineOf(fetchImpl, options = {}) {
  return createDownloadEngine(
    { fs: nodeDownloadFs(), fetch: fetchImpl ?? globalThis.fetch, now: () => Date.now(), mux: () => undefined },
    { maxConcurrent: options.maxConcurrent ?? 1 },
  )
}

/** A half-written download from an earlier attempt: a `.part` plus its validators. */
function seedPartial(dir, bytes, validators) {
  mkdirSync(dir, { recursive: true })
  const part = join(dir, 'resume-test.mp4.part')
  writeFileSync(part, CONTENT.subarray(0, bytes))
  if (validators !== undefined) writeFileSync(`${part}.meta`, JSON.stringify(validators), 'utf8')
  return part
}

test('校验一致的断点会续传，并带上 If-Range', async () => {
  const server = await mediaServer()
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-resume-'))
  const part = seedPartial(downloadDir, 100, { etag: '"v1"' })
  try {
    const engine = engineOf()
    const handle = engine.start(requestOf(server.base, downloadDir))
    const view = await handle.done
    assert.equal(view.status, 'done')
    assert.equal(view.receivedBytes, CONTENT.length)
    const file = join(downloadDir, 'resume-test.mp4')
    assert.deepEqual(readFileSync(file), CONTENT, '最终文件必须与服务器内容逐字节一致')
    assert.equal(server.state.requests[0].range, 'bytes=100-')
    assert.equal(server.state.requests[0].ifRange, '"v1"', '续传要带 If-Range')
    assert.equal(existsSync(`${part}.meta`), false, '完成后校验文件必须清掉')
  } finally {
    await server.close()
  }
})

test('服务器上的文件变了（ETag 不同）时丢弃断点、整份重下', async () => {
  const server = await mediaServer()
  server.state.etag = '"v2"'
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-resume-'))
  seedPartial(downloadDir, 100, { etag: '"v1"' })
  try {
    const engine = engineOf()
    const view = await engine.start(requestOf(server.base, downloadDir)).done
    assert.equal(view.status, 'done')
    const file = join(downloadDir, 'resume-test.mp4')
    assert.deepEqual(readFileSync(file), CONTENT, '不能把新文件拼在旧字节后面')
    const ranges = server.state.requests.map(item => item.range)
    assert.ok(ranges.some(range => range === undefined), `应当出现一次不带 Range 的重下，实际请求：${JSON.stringify(ranges)}`)
  } finally {
    await server.close()
  }
})

test('206 的 Content-Range 起点对不上时也重下', async () => {
  const server = await mediaServer()
  server.state.forcedStart = 0
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-resume-'))
  seedPartial(downloadDir, 100, undefined)
  try {
    const engine = engineOf()
    const view = await engine.start(requestOf(server.base, downloadDir)).done
    assert.equal(view.status, 'done')
    assert.deepEqual(readFileSync(join(downloadDir, 'resume-test.mp4')), CONTENT)
  } finally {
    await server.close()
  }
})

test('服务器忽略 Range（回 200 全量）时照样得到正确文件', async () => {
  const server = await mediaServer()
  server.state.ignoreRange = true
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-resume-'))
  seedPartial(downloadDir, 100, { etag: '"v1"' })
  try {
    const engine = engineOf()
    const view = await engine.start(requestOf(server.base, downloadDir)).done
    assert.equal(view.status, 'done')
    assert.deepEqual(readFileSync(join(downloadDir, 'resume-test.mp4')), CONTENT)
  } finally {
    await server.close()
  }
})

test('排队中被取消的扩展任务：令牌立刻作废，迟到推字节不会挂死', async () => {
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-token-'))
  const hanging = () => new Promise(() => {})
  const engine = engineOf(hanging, { maxConcurrent: 1 })
  const busy = engine.start(requestOf('http://127.0.0.1:1', downloadDir))
  const queued = engine.start(requestOf('http://127.0.0.1:1', downloadDir, { carrier: 'guest' }))
  assert.equal(queued.view.status, 'queued')
  engine.cancel(queued.id)
  assert.equal(queued.view.status, 'cancelled')
  const token = queued.guest?.token
  assert.equal(typeof token, 'string')
  const answer = await Promise.race([
    engine.pushGuest(token, { offset: 0, body: Buffer.from('x') }),
    new Promise(resolve => { setTimeout(() => resolve('timeout'), 2_000) }),
  ])
  assert.notEqual(answer, 'timeout', '取消后的令牌必须立即拒绝，而不是永远等待')
  assert.equal(answer.ok, false)
  // 令牌已经从会话表里回收：迟到的推送得到「不认识这个令牌」，而不是挂在一个永远
  // 不会有人来取数据的队列上。'not-running' 是另一条合法的终止说法（槽位已关）。
  assert.ok(['unknown-token', 'not-running'].includes(answer.code), answer.code)
  busy.cancel()
})

test('选择保留已有文件（keep）的扩展任务同样回收令牌', async () => {
  const downloadDir = mkdtempSync(join(tmpdir(), 'vd-token-'))
  const engine = engineOf(() => new Promise(() => {}), { maxConcurrent: 1 })
  const kept = engine.start(requestOf('http://127.0.0.1:1', downloadDir, {
    carrier: 'guest',
    onConflict: 'keep',
    existingPath: join(downloadDir, 'resume-test.mp4'),
  }))
  assert.equal(kept.view.status, 'skipped')
  const token = kept.guest?.token
  assert.equal(typeof token, 'string')
  const answer = await Promise.race([
    engine.pushGuest(token, { offset: 0, body: Buffer.from('x') }),
    new Promise(resolve => { setTimeout(() => resolve('timeout'), 2_000) }),
  ])
  assert.notEqual(answer, 'timeout')
  assert.equal(answer.ok, false)
  assert.ok(['unknown-token', 'not-running'].includes(answer.code), answer.code)
})
