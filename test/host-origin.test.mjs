/**
 * 谁可以访问本机服务：HTTP 与 WebSocket 两条路都必须只认"自己人"。
 *
 * 这一支钉的是安全边界，不是功能：面板（同源页面）、浏览器扩展（chrome-extension://）
 * 和本机原生客户端（没有 Origin）放行；任何网页命名自己的站点、以及拥有不透明来源的
 * `Origin: null`（沙箱 iframe、data: 页面）一律拒绝。WebSocket 没有 CORS 预检，这条
 * 校验就是它全部的访问控制。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHostServer, statusFor } from '../lib/test/host/server.js'

const API = '/video-downloader/api'
const EXT_WS = '/video-downloader/ext/ws'

let host
let staticDir

before(async () => {
  // 旧插件配置的继承读的是 DSH_HOME；指到空目录，测试不碰真实设置。
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'vd-origin-dsh-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'vd-origin-state-'))
  staticDir = mkdtempSync(join(tmpdir(), 'vd-origin-static-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>panel</title>')
  writeFileSync(join(staticDir, 'app.js'), 'console.log(1)')
  host = await startHostServer({
    stateDir,
    defaultDownloadDir: stateDir,
    staticDir,
    version: '0.0.0-test',
    basePort: 47_940,
    pickDirectory: async () => null,
  })
})

after(async () => {
  await host?.close()
})

/**
 * One request over a non-keep-alive socket (agent: false).
 *
 * Keep-alive would leave idle sockets behind and make `server.close()` wait for
 * them, which turns teardown into a hang instead of a check.
 */
function call(path, { method = 'POST', origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const headers = {}
    if (method === 'POST') {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    if (origin !== undefined) headers.origin = origin
    const request = httpRequest({ host: '127.0.0.1', port: host.port, path, method, headers, agent: false }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = undefined }
        resolve({ status: response.statusCode, body: parsed })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

/** POST one API call with an explicit Origin (or none at all). */
function post(method, body = {}, origin) {
  return call(`${API}/${method}`, { origin, body })
}

/**
 * Open a raw WebSocket upgrade and answer with the status line.
 * @returns `'101'` when the server switched protocols, the HTTP status otherwise.
 */
function upgrade(origin) {
  return new Promise((resolve, reject) => {
    const socket = connect(host.port, '127.0.0.1')
    let seen = ''
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('upgrade timed out')) })
    socket.on('connect', () => {
      const lines = [
        `GET ${EXT_WS} HTTP/1.1`,
        `Host: 127.0.0.1:${host.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...(origin === undefined ? [] : [`Origin: ${origin}`]),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      seen += chunk.toString('latin1')
      if (!seen.includes('\r\n')) return
      const statusLine = seen.split('\r\n')[0]
      socket.destroy()
      resolve(statusLine.split(' ')[1])
    })
    socket.on('error', reject)
  })
}

test('没有 Origin 的本机客户端被放行', async () => {
  const answer = await post('ping')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
})

test('任意网页（带自己的 Origin）访问 API 一律 403', async () => {
  for (const origin of ['http://evil.example', 'https://evil.example:8443']) {
    const answer = await post('ping', {}, origin)
    assert.equal(answer.status, 403, origin)
    assert.equal(answer.body.error.code, 'forbidden', origin)
  }
})

test('Origin: null 不再被放行（沙箱 iframe / data: 页面）', async () => {
  const answer = await post('config.set', { downloadDir: 'C:\\' }, 'null')
  assert.equal(answer.status, 403)
  assert.equal(answer.body.error.code, 'forbidden')
})

test('浏览器扩展的 chrome-extension:// 来源被放行', async () => {
  const answer = await post('ping', {}, 'chrome-extension://abcdefghijklmnop')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
})

test('静态页面同样受 Origin 约束', async () => {
  const blocked = await call('/', { method: 'GET', origin: 'http://evil.example' })
  assert.equal(blocked.status, 403)
  const allowed = await call('/', { method: 'GET' })
  assert.equal(allowed.status, 200)
})

test('非法 JSON 请求体报 400，不再是 500', async () => {
  const answer = await post('ping', '{')
  assert.equal(answer.status, 400)
  assert.equal(answer.body.error.code, 'bad-request')
})

test('未知接口方法报 404', async () => {
  const answer = await post('no.such.method')
  assert.equal(answer.status, 404)
})

test('WebSocket 升级：网页 Origin 被拒，扩展 Origin 与本机客户端被接受', async () => {
  assert.equal(await upgrade('http://evil.example'), '403')
  assert.equal(await upgrade('null'), '403')
  assert.equal(await upgrade('chrome-extension://abcdefghijklmnop'), '101')
  assert.equal(await upgrade(undefined), '101')
})

test('statusFor 把失败信封映射成对应状态码', () => {
  assert.equal(statusFor({ ok: true, value: {} }), 200)
  assert.equal(statusFor({ ok: false, error: { code: 'bad-request' } }), 400)
  assert.equal(statusFor({ ok: false, error: { code: 'not-found' } }), 404)
  assert.equal(statusFor({ ok: false, error: { code: 'forbidden' } }), 403)
  assert.equal(statusFor({ ok: false, error: { code: 'internal' } }), 500)
  assert.equal(statusFor({ ok: false, error: { code: 'something-new' } }), 500)
})
