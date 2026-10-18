/**
 * The one WebSocket frame decoder this app needs.
 *
 * The renderer's event channel is send-only, so `events.ts` only had to look at
 * opcodes. The extension channel is the opposite: the app RECEIVES its messages,
 * which means unmasking and reassembly — the two things a browser's client-side
 * framing always does (`FIN=1` and a 4-byte mask key are guaranteed for a real
 * WebSocket, but the decoder handles fragmentation anyway so a future client
 * cannot silently break the channel).
 */

/** One decoded frame's payload, already unmasked. */
export interface DecodedFrame {
  /** 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xa pong. */
  readonly opcode: number
  /** UTF-8 payload (binary frames included: this protocol only speaks JSON). */
  readonly text: string
}

/** The decoder's running state, kept between chunks. */
export interface FrameDecoder {
  /** Bytes received but not yet forming a complete frame. */
  buffer: Buffer
  /** Payload of a fragmented message in progress, when there is one. */
  fragments: Buffer[]
}

/** A fresh decoder. */
export function createFrameDecoder(): FrameDecoder {
  return { buffer: Buffer.alloc(0), fragments: [] }
}

/** The most one reassembled message may take up, fragments included. */
const MAX_MESSAGE_BYTES = 1_048_576

/**
 * Add one continuation payload, refusing a message that grows without bound.
 * @param decoder - the running state.
 * @param payload - the fragment just decoded.
 */
function appendFragment(decoder: FrameDecoder, payload: Buffer): void {
  const total = decoder.fragments.reduce((sum, part) => sum + part.length, payload.length)
  if (total > MAX_MESSAGE_BYTES) {
    decoder.fragments = []
    throw new Error('WebSocket 消息过大')
  }
  decoder.fragments.push(payload)
}

/**
 * Feed received bytes in and take complete frames out.
 *
 * Frames are DELETED from the buffer as they are consumed, so the same decoder
 * can be handed every chunk of a long-lived connection. A frame whose header or
 * payload is incomplete stays buffered and produces nothing yet.
 * @param decoder - the running state.
 * @param chunk - bytes just read off the socket.
 * @returns every frame that is now complete, in arrival order.
 */
export function decodeFrames(decoder: FrameDecoder, chunk: Buffer): DecodedFrame[] {
  decoder.buffer = Buffer.concat([decoder.buffer, chunk])
  const out: DecodedFrame[] = []
  for (;;) {
    const buffer = decoder.buffer
    if (buffer.length < 2) break
    const first = buffer[0]!
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const second = buffer[1]!
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) break
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) break
      const wide = buffer.readBigUInt64BE(offset)
      // A payload this large is never a JSON control message; refuse rather than
      // allocate it.
      if (wide > 1_048_576n) {
        decoder.buffer = Buffer.alloc(0)
        throw new Error('WebSocket 帧过大')
      }
      length = Number(wide)
      offset += 8
    }
    const maskOffset = masked ? offset : -1
    if (masked) offset += 4
    if (buffer.length < offset + length) break
    let payload = buffer.subarray(offset, offset + length)
    if (masked) {
      const copy = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) {
        copy[index] = payload[index]! ^ buffer[maskOffset + (index % 4)]!
      }
      payload = copy
    }
    decoder.buffer = buffer.subarray(offset + length)

    if (opcode === 0x0) {
      // Continuation of a fragmented text/binary message.
      appendFragment(decoder, payload as Buffer)
      if (fin) {
        const whole = Buffer.concat(decoder.fragments)
        decoder.fragments = []
        out.push({ opcode: 0x1, text: whole.toString('utf8') })
      }
      continue
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        // A complete data frame ENDS any message that was being assembled; leftovers
        // from an abandoned one must not be glued onto it.
        decoder.fragments = []
        out.push({ opcode, text: (payload as Buffer).toString('utf8') })
      } else {
        decoder.fragments = []
        appendFragment(decoder, payload as Buffer)
      }
      continue
    }
    // Control frames are never fragmented.
    out.push({ opcode, text: (payload as Buffer).toString('utf8') })
  }
  return out
}
