/**
 * The WebSocket frame decoder — the only place bytes from the extension channel are
 * turned into messages.
 *
 * Why it matters: this decoder is on the receiving end of a loopback socket, so a
 * broken (or hostile) client must not be able to grow memory without bound or glue
 * an abandoned fragment onto a later message. Each test below pins one of those.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrameDecoder, decodeFrames } from '../lib/test/host/ws-frame.js'

/** One client-to-server frame: FIN bit, opcode, and the mask a browser always sends. */
function clientFrame(payload, { fin = true, opcode = 0x1, mask = [0x11, 0x22, 0x33, 0x44] } = {}) {
  const body = Buffer.from(payload, 'utf8')
  const length = body.length
  const header = [(fin ? 0x80 : 0x00) | opcode]
  if (length < 126) {
    header.push(0x80 | length)
  } else if (length < 65_536) {
    header.push(0x80 | 126, (length >> 8) & 0xff, length & 0xff)
  } else {
    // 64-bit length form; the high four bytes are zero for anything a test sends.
    header.push(0x80 | 127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
  }
  const key = Buffer.from(mask)
  header.push(...key)
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) masked[index] = body[index] ^ key[index % 4]
  return Buffer.concat([Buffer.from(header), masked])
}

test('解码一个带掩码的文本帧', () => {
  const frames = decodeFrames(createFrameDecoder(), clientFrame('{"type":"hello"}'))
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0], { opcode: 0x1, text: '{"type":"hello"}' })
})

test('空文本帧是合法消息', () => {
  const frames = decodeFrames(createFrameDecoder(), clientFrame(''))
  assert.deepEqual(frames, [{ opcode: 0x1, text: '' }])
})

test('跨 chunk 的帧会被攒起来，收全后才产出', () => {
  const decoder = createFrameDecoder()
  const frame = clientFrame('cross-chunk-payload')
  assert.deepEqual(decodeFrames(decoder, frame.subarray(0, 4)), [], '头部不完整时不应产出')
  assert.deepEqual(decodeFrames(decoder, frame.subarray(4, frame.length - 2)), [], '正文不完整时不应产出')
  const done = decodeFrames(decoder, frame.subarray(frame.length - 2))
  assert.deepEqual(done, [{ opcode: 0x1, text: 'cross-chunk-payload' }])
})

test('支持 16 位与 64 位长度字段', () => {
  const medium = 'a'.repeat(300)
  const large = 'b'.repeat(70_000)
  const frames = decodeFrames(createFrameDecoder(), Buffer.concat([clientFrame(medium), clientFrame(large)]))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].text.length, 300)
  assert.equal(frames[1].text.length, 70_000)
})

test('分片消息被拼成一条', () => {
  const decoder = createFrameDecoder()
  const first = decodeFrames(decoder, clientFrame('{"type":', { fin: false }))
  assert.deepEqual(first, [])
  const second = decodeFrames(decoder, clientFrame('"tab"}', { fin: false, opcode: 0x0 }))
  assert.deepEqual(second, [])
  const done = decodeFrames(decoder, clientFrame(''.padEnd(0), { fin: true, opcode: 0x0 }))
  assert.deepEqual(done, [{ opcode: 0x1, text: '{"type":"tab"}' }])
})

test('一条新消息不会继承上一段没写完的分片', () => {
  const decoder = createFrameDecoder()
  assert.deepEqual(decodeFrames(decoder, clientFrame('abc', { fin: false })), [])
  // 一个完整的新文本帧必须自成一条消息
  assert.deepEqual(decodeFrames(decoder, clientFrame('xyz', { fin: true })), [{ opcode: 0x1, text: 'xyz' }])
  // 之后若来了一个孤儿续帧，只能拿到它自己，而不是 "abcdef"
  assert.deepEqual(decodeFrames(decoder, clientFrame('def', { fin: true, opcode: 0x0 })), [{ opcode: 0x1, text: 'def' }])
})

test('分片累计超过 1MB 时抛错，而不是无限占内存', () => {
  const decoder = createFrameDecoder()
  const chunk = 'x'.repeat(400_000)
  decodeFrames(decoder, clientFrame(chunk, { fin: false }))
  decodeFrames(decoder, clientFrame(chunk, { fin: false, opcode: 0x0 }))
  assert.throws(() => decodeFrames(decoder, clientFrame(chunk, { fin: true, opcode: 0x0 })), /消息过大/)
  // 抛错后解码器必须清空，不能用残留状态再拼一条
  assert.deepEqual(decodeFrames(decoder, clientFrame('ok', { fin: true })), [{ opcode: 0x1, text: 'ok' }])
})

test('控制帧原样返回', () => {
  const frames = decodeFrames(createFrameDecoder(), clientFrame('hi', { opcode: 0x9 }))
  assert.deepEqual(frames, [{ opcode: 0x9, text: 'hi' }])
})
