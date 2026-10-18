/**
 * The proxied HTTP client: response parsing, body framing, and one real round trip
 * through a real proxy process.
 *
 * The end-to-end half matters most. The live failure was "the browser reaches the
 * site, the plugin does not", and the fix is only believable if a request actually
 * travels through a proxy — so the test starts a loopback origin server AND a
 * loopback proxy, then asserts on the bytes that arrived, the redirect that was
 * followed, the chunked body that was reassembled, and the Range request that was
 * passed through.
 *
 * TLS is deliberately absent here: generating a certificate would add a dependency
 * for no extra coverage of THIS code (CONNECT plus `tls.connect`), and the
 * real-world check — the user's own proxy against a real HTTPS site — exercises it
 * far better than a fixture could. The one TLS-adjacent thing that IS pinned is
 * `awaitTlsHandshake`'s timer, because no fixture is needed to see a timer outlive
 * the handshake it was timing — only a fake socket.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, before, describe, it } from 'node:test'
import { awaitTlsHandshake, bodyFraming, createBodyDecoder, createHttpFetch, parseResponseHead } from '../lib/test/net/http-fetch.js'

describe('parseResponseHead', () => {
  it('reads the status line and headers case-insensitively', () => {
    const head = parseResponseHead([
      'HTTP/1.1 206 Partial Content',
      'Content-Type: video/mp4',
      'Content-Range: bytes 10-19/100',
    ].join('\r\n'))
    assert.equal(head.status, 206)
    assert.equal(head.statusText, 'Partial Content')
    assert.equal(head.headers.get('content-type'), 'video/mp4')
    assert.equal(head.headers.get('CONTENT-RANGE'), 'bytes 10-19/100')
  })

  it('joins a folded header instead of dropping half of it', () => {
    // A proxy is allowed to fold; a lost `location` would turn a redirect into an
    // empty page, which is a bug that looks like a site problem.
    const head = parseResponseHead(['HTTP/1.1 302 Found', 'Location: https://example.com/a', '  ?b=1'].join('\r\n'))
    assert.equal(head.headers.get('location'), 'https://example.com/a ?b=1')
  })

  it('keeps repeated set-cookie headers', () => {
    const head = parseResponseHead(['HTTP/1.1 200 OK', 'Set-Cookie: a=1', 'Set-Cookie: b=2'].join('\r\n'))
    assert.deepEqual(head.headers.getSetCookie(), ['a=1', 'b=2'])
  })

  it('refuses something that is not an HTTP response', () => {
    assert.throws(() => parseResponseHead('<html>nope</html>'), /不是 HTTP 响应/)
  })
})

describe('bodyFraming', () => {
  it('prefers chunked, then content-length, then close-delimited', () => {
    assert.equal(bodyFraming(new Headers({ 'transfer-encoding': 'chunked', 'content-length': '10' }), 200), 'chunked')
    assert.deepEqual(bodyFraming(new Headers({ 'content-length': '42' }), 200), { length: 42 })
    assert.equal(bodyFraming(new Headers(), 200), 'eof')
  })

  it('gives a bodyless status no body even with headers', () => {
    assert.deepEqual(bodyFraming(new Headers({ 'content-length': '10' }), 304), { length: 0 })
    assert.deepEqual(bodyFraming(new Headers(), 204), { length: 0 })
  })
})

describe('createBodyDecoder', () => {
  it('stops exactly at the declared length', () => {
    const decoder = createBodyDecoder({ length: 5 })
    assert.deepEqual(decoder.push(Buffer.from('abc')), [Buffer.from('abc')])
    assert.equal(decoder.complete, false)
    assert.deepEqual(decoder.push(Buffer.from('defgh')), [Buffer.from('de')])
    assert.equal(decoder.complete, true)
    assert.deepEqual(decoder.push(Buffer.from('ignored')), [])
  })

  it('reassembles a chunked body split at every possible boundary', () => {
    // Fed one byte at a time: a decoder that only works on whole frames would pass
    // a friendly fixture and fail on a real socket.
    const wire = Buffer.from('5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n')
    const decoder = createBodyDecoder('chunked')
    const out = []
    for (const byte of wire) out.push(...decoder.push(Buffer.from([byte])))
    assert.equal(Buffer.concat(out).toString(), 'hello world')
    assert.equal(decoder.complete, true)
  })

  it('refuses a corrupt chunk size instead of streaming garbage', () => {
    const decoder = createBodyDecoder('chunked')
    assert.throws(() => decoder.push(Buffer.from('zz\r\nhello\r\n')), /分块长度/)
  })

  it('passes everything through for close-delimited bodies', () => {
    const decoder = createBodyDecoder('eof')
    assert.deepEqual(decoder.push(Buffer.from('a')), [Buffer.from('a')])
    assert.equal(decoder.complete, false, 'only the socket close completes it')
  })
})

describe('awaitTlsHandshake', () => {
  /** A socket double: it records whether it was destroyed, and replays one event. */
  function fakeSocket() {
    const handlers = new Map()
    return {
      destroyed: false,
      once(event, listener) { handlers.set(event, listener); return this },
      emit(event, payload) { handlers.get(event)?.(payload) },
      destroy() { this.destroyed = true },
    }
  }
  const tick = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  it('leaves the socket alone once the handshake succeeded', async () => {
    // The measured bug this pins: the timeout was never cleared after
    // `secureConnect`, so a healthy 243 MB download through the user's proxy was
    // torn down at exactly 15.0 s — 96% of the way in — and the body reader could
    // only report "the connection was closed before the end of the response body".
    const socket = fakeSocket()
    const handshake = awaitTlsHandshake(socket, 30)
    socket.emit('secureConnect')
    await handshake
    await tick(60)
    assert.equal(socket.destroyed, false, 'a timer must not outlive the handshake it timed')
  })

  it('destroys the socket and rejects when the handshake never completes', async () => {
    const socket = fakeSocket()
    await assert.rejects(() => awaitTlsHandshake(socket, 20), /TLS 握手超时/)
    assert.equal(socket.destroyed, true, 'a handshake that never comes must not hold the socket')
  })

  it('passes a handshake error through, and still clears its timer', async () => {
    const socket = fakeSocket()
    const handshake = awaitTlsHandshake(socket, 30)
    socket.emit('error', new Error('unable to verify the first certificate'))
    await assert.rejects(() => handshake, /unable to verify/)
    await tick(60)
    assert.equal(socket.destroyed, false)
  })
})

/** A real HTTP origin and a real HTTP proxy, both on loopback. */
describe('createHttpFetch through a proxy', () => {
  /** @type {http.Server} */ let origin
  /** @type {net.Server} */ let proxy
  /** @type {string[]} */ let proxiedTargets
  let originPort = 0
  let proxyPort = 0

  before(async () => {
    proxiedTargets = []
    origin = http.createServer((request, response) => {
      if (request.url === '/page') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<html><title>页面</title></html>')
        return
      }
      if (request.url === '/chunked') {
        // No content-length: Node frames this as chunked, which is the path a real
        // HLS manifest or HTML page takes.
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.write('first-')
        response.write('second')
        response.end()
        return
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/page' })
        response.end()
        return
      }
      if (request.url === '/range') {
        const range = request.headers.range
        if (typeof range === 'string') {
          response.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 10-19/100', 'content-length': '10' })
          response.end(Buffer.alloc(10, 7))
          return
        }
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '100' })
        response.end(Buffer.alloc(100, 3))
        return
      }
      response.writeHead(404)
      response.end('missing')
    })
    await new Promise((resolve) => { origin.listen(0, '127.0.0.1', resolve) })
    originPort = origin.address().port

    proxy = net.createServer((socket) => {
      let buffer = ''
      const onData = (chunk) => {
        buffer += chunk.toString('latin1')
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.off('data', onData)
        const head = buffer.slice(0, end)
        const [method, target] = head.split('\r\n')[0].split(' ')
        if (method === 'CONNECT') {
          const [host, port] = target.split(':')
          const upstream = net.connect(Number(port), host, () => {
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
            socket.pipe(upstream)
            upstream.pipe(socket)
          })
          upstream.on('error', () => socket.destroy())
          return
        }
        // Absolute-form request: this is what a proxied plain-HTTP GET looks like.
        const url = new URL(target)
        proxiedTargets.push(`${url.host}${url.pathname}`)
        const headers = head.split('\r\n').slice(1).join('\r\n')
        const upstream = net.connect(Number(url.port), url.hostname, () => {
          upstream.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`)
        })
        socket.pipe(upstream)
        upstream.pipe(socket)
        upstream.on('error', () => socket.destroy())
      }
      socket.on('data', onData)
      socket.on('error', () => socket.destroy())
    })
    await new Promise((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
    proxyPort = proxy.address().port
  })

  after(async () => {
    await new Promise((resolve) => { origin.close(resolve) })
    await new Promise((resolve) => { proxy.close(resolve) })
  })

  /** The client under test, pointed at the loopback proxy. */
  const proxied = (bypass = []) => createHttpFetch({
    proxy: async () => ({ url: `http://127.0.0.1:${proxyPort}`, source: 'system', bypass, found: true }),
  })

  it('fetches a page and returns a real Response', async () => {
    proxiedTargets = []
    const response = await proxied()(`http://127.0.0.1:${originPort}/page`)
    assert.equal(response.status, 200)
    assert.equal(response.ok, true)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(await response.text(), /页面/)
    assert.deepEqual(proxiedTargets, [`127.0.0.1:${originPort}/page`], 'the request went through the proxy')
  })

  it('reassembles a chunked body', async () => {
    const response = await proxied()(`http://127.0.0.1:${originPort}/chunked`)
    assert.equal(await response.text(), 'first-second')
  })

  it('follows a redirect through the proxy', async () => {
    const response = await proxied()(`http://127.0.0.1:${originPort}/redirect`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /页面/)
  })

  it('passes a Range request through and keeps the 206', async () => {
    // The direct download carrier resumes with a Range header; a proxy client that
    // swallowed it would silently restart every download from zero.
    const response = await proxied()(`http://127.0.0.1:${originPort}/range`, { headers: { range: 'bytes=10-19' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 10-19/100')
    const body = new Uint8Array(await response.arrayBuffer())
    assert.equal(body.byteLength, 10)
  })

  it('streams rather than buffering the whole body', async () => {
    const response = await proxied()(`http://127.0.0.1:${originPort}/range`)
    assert.notEqual(response.body, null)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    assert.equal(first.value.byteLength > 0, true)
    await reader.cancel()
  })

  it('goes direct for a bypassed host, and for no proxy at all', async () => {
    proxiedTargets = []
    const response = await proxied(['127.0.0.1'])(`http://127.0.0.1:${originPort}/page`)
    assert.equal(response.status, 200)
    assert.deepEqual(proxiedTargets, [], 'a bypassed host must not be sent to the proxy')

    const noProxy = createHttpFetch({ proxy: async () => ({ source: 'none', bypass: [], found: false }) })
    const direct = await noProxy(`http://127.0.0.1:${originPort}/page`)
    assert.equal(direct.status, 200)
    assert.deepEqual(proxiedTargets, [])
  })

  it('reports a proxy that refuses the request', async () => {
    const refusing = createHttpFetch({
      // A port nobody listens on: the failure must be an error, never a hang.
      proxy: async () => ({ url: 'http://127.0.0.1:1', source: 'system', bypass: [], found: true }),
    })
    await assert.rejects(() => refusing('http://127.0.0.1:1/page'))
  })
})
