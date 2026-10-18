/**
 * WebSocket-server tests.
 *
 * The handshake is the part a browser is strict about, so the RFC 6455 accept
 * value is pinned against a known vector. Framing is checked for all three length
 * forms, and the refusal paths are asserted to write a real HTTP response rather
 * than hanging the client until its own timeout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptUpgrade, encodeFrame, handshakeResponse, parseSessionId, scanOpcodes } from '../lib/test/events.js'

/** The RFC 6455 example key and its expected accept value. */
const SAMPLE_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
const SAMPLE_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='

/** A socket double capturing writes. */
function fakeSocket() {
  const written = []
  const listeners = new Map()
  return {
    written,
    listeners,
    write(chunk) { written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true },
    end(chunk) { if (chunk !== undefined) written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) },
    destroy() { /* recorded nothing */ },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return this
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

/** The headers of a valid upgrade request. */
function upgradeHeaders(overrides = {}) {
  return {
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': SAMPLE_KEY,
    'sec-websocket-version': '13',
    ...overrides,
  }
}

test('handshakeResponse computes the RFC 6455 accept value', () => {
  const result = handshakeResponse(upgradeHeaders())
  assert.ok('response' in result)
  assert.ok(result.response.startsWith('HTTP/1.1 101 Switching Protocols'))
  assert.ok(result.response.includes(`Sec-WebSocket-Accept: ${SAMPLE_ACCEPT}`))
  assert.ok(result.response.includes('Upgrade: websocket'))
  assert.ok(result.response.endsWith('\r\n\r\n'))
})

test('handshakeResponse refuses what it cannot serve', () => {
  assert.equal(handshakeResponse(upgradeHeaders({ upgrade: 'h2c' })).rejection, 'not a websocket upgrade')
  assert.equal(handshakeResponse(upgradeHeaders({ 'sec-websocket-key': undefined })).rejection, 'missing Sec-WebSocket-Key')
  assert.ok(
    handshakeResponse(upgradeHeaders({ 'sec-websocket-version': '8' })).rejection?.includes('8'),
    'an older protocol version is refused by number',
  )
})

test('encodeFrame uses the 7-bit, 16-bit, and 64-bit length forms', () => {
  const short = encodeFrame(Buffer.from('hi'))
  assert.equal(short.length, 4)
  assert.equal(short[0], 0x81, 'FIN set, text opcode')
  assert.equal(short[1], 2, 'unmasked, length inline')

  const medium = encodeFrame(Buffer.alloc(200))
  assert.equal(medium[1], 126)
  assert.equal(medium.readUInt16BE(2), 200)
  assert.equal(medium.length, 4 + 200)

  const long = encodeFrame(Buffer.alloc(70_000))
  assert.equal(long[1], 127)
  assert.equal(Number(long.readBigUInt64BE(2)), 70_000)
  assert.equal(long.length, 10 + 70_000)
})

test('encodeFrame honors an explicit opcode', () => {
  const close = encodeFrame(Buffer.alloc(0), 0x8)
  assert.equal(close[0], 0x88)
  assert.equal(close.length, 2)
})

test('acceptUpgrade completes the handshake and exposes a sendable socket', () => {
  const socket = fakeSocket()
  const result = acceptUpgrade(
    { url: '/video-downloader/ws/events?sessionId=session-7', headers: upgradeHeaders() },
    socket,
    Buffer.alloc(0),
    () => 'sock-1',
  )
  assert.ok(result.socket !== undefined)
  assert.equal(result.socket.id, 'sock-1')
  assert.equal(result.socket.sessionId, 'session-7')
  assert.ok(socket.written[0].toString().includes('101 Switching Protocols'))

  assert.equal(result.socket.send('{"type":"hello"}'), true)
  const frame = socket.written[1]
  assert.equal(frame[0], 0x81)
  assert.equal(frame.subarray(2).toString('utf8'), '{"type":"hello"}')
})

test('acceptUpgrade refuses with a real 400 and destroys the socket', () => {
  const socket = fakeSocket()
  let destroyed = false
  const tracked = { ...socket, destroy() { destroyed = true } }
  const result = acceptUpgrade({ headers: { upgrade: 'websocket' } }, tracked, Buffer.alloc(0), () => 'x')
  assert.equal(result.socket, undefined)
  assert.equal(result.rejection, 'missing Sec-WebSocket-Key')
  assert.ok(socket.written[0].toString().startsWith('HTTP/1.1 400 Bad Request'))
  assert.equal(destroyed, true, 'a refused upgrade must not leave the socket open')
})

test('a closed socket reports failure from send and notifies subscribers once', () => {
  const socket = fakeSocket()
  const result = acceptUpgrade({ headers: upgradeHeaders() }, socket, Buffer.alloc(0), () => 'sock-2')
  const live = result.socket
  let closes = 0
  live.onClose(() => { closes += 1 })

  socket.emit('close')
  assert.equal(closes, 1)
  assert.equal(live.send('after close'), false, 'a send after close reports failure')
  socket.emit('close')
  assert.equal(closes, 1, 'closure is reported exactly once')
})

test('a close frame from the client is answered and tears the connection down', () => {
  const socket = fakeSocket()
  const result = acceptUpgrade({ headers: upgradeHeaders() }, socket, Buffer.alloc(0), () => 'sock-3')
  let closes = 0
  result.socket.onClose(() => { closes += 1 })
  // A masked, empty close frame: FIN + opcode 8, mask bit set, zero length, key.
  socket.emit('data', Buffer.from([0x88, 0x80, 1, 2, 3, 4]))
  assert.equal(closes, 1)
})

test('a ping frame is answered with a pong', () => {
  const socket = fakeSocket()
  acceptUpgrade({ headers: upgradeHeaders() }, socket, Buffer.alloc(0), () => 'sock-4')
  socket.written.length = 0
  // A masked, empty ping frame (opcode 9).
  socket.emit('data', Buffer.from([0x89, 0x80, 1, 2, 3, 4]))
  assert.equal(socket.written.length, 1)
  assert.equal(socket.written[0][0], 0x8a, 'the pong opcode')
})

test('scanOpcodes reads whole frames and stops at an incomplete one', () => {
  const first = encodeFrame(Buffer.from('a'))
  const second = encodeFrame(Buffer.from('bb'), 0x9)
  assert.deepEqual(scanOpcodes(Buffer.concat([first, second])), [0x1, 0x9])

  // A frame whose PAYLOAD is incomplete must not be reported: the header alone
  // is readable, but the frame is not a frame yet.
  const long = encodeFrame(Buffer.alloc(300))
  assert.deepEqual(scanOpcodes(long.subarray(0, 4)), [], 'header read, payload missing')
  assert.deepEqual(scanOpcodes(long), [0x1])
  // A truncated header cannot be read at all.
  assert.deepEqual(scanOpcodes(first.subarray(0, 1)), [])
  assert.deepEqual(scanOpcodes(Buffer.alloc(0)), [])
})

test('parseSessionId reads the query parameter and tolerates junk', () => {
  assert.equal(parseSessionId('/p?sessionId=abc'), 'abc')
  assert.equal(parseSessionId('/p'), '')
  assert.equal(parseSessionId(undefined), '')
  assert.equal(parseSessionId('http://x/p?sessionId=%E4%B8%AD'), '中')
})
