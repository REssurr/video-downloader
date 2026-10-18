/**
 * A minimal WebSocket server for the app's event channel.
 *
 * Written by hand rather than pulled from a library because the app ships no
 * runtime dependencies and the surface it needs is one direction only: the server
 * sends JSON text frames, the client sends nothing. That reduces RFC 6455 to a
 * handshake plus server-side framing —— no masking, no fragmentation of outgoing
 * frames, no extensions, no subprotocols.
 *
 * The client half still degrades to polling when the channel cannot be opened, so
 * a handshake bug costs latency, not a broken panel.
 */
import { createHash } from 'node:crypto'

/** The RFC 6455 handshake GUID. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Frame opcodes this server cares about. */
const OPCODE_TEXT = 0x1
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** A connected client. */
export interface EventSocket {
  /** One opaque connection identity, used for bookkeeping. */
  readonly id: string
  /** The `sessionId` query parameter, when the client attached one. */
  readonly sessionId: string
  /**
   * Send one text frame.
   * @returns false when the socket is gone (the caller then drops it).
   */
  send(text: string): boolean
  /** Close the connection and release listeners. */
  close(): void
  /** Subscribe to closure. */
  onClose(listener: () => void): void
}

/** The request facts an upgrade needs (structural subset of `IncomingMessage`). */
export interface UpgradeRequestFacts {
  readonly url?: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/** The socket surface an upgrade uses (structural subset of `Duplex`). */
export interface UpgradeSocketFacts {
  write(chunk: Buffer | string): boolean
  end(chunk?: Buffer | string): void
  destroy(error?: Error): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close' | 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/** The outcome of one upgrade attempt. */
export interface UpgradeResult {
  /** The live socket, or `undefined` when the handshake was refused. */
  readonly socket?: EventSocket
  /** Why the handshake was refused. */
  readonly rejection?: string
}

/** Read a header value as a single string. */
function headerValue(headers: UpgradeRequestFacts['headers'], name: string): string | undefined {
  const raw = headers[name]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0]
  return undefined
}

/**
 * Frame one payload as a single unmasked server text frame.
 *
 * Server frames are never masked, so the payload follows the length field
 * directly. Lengths use the 7-bit, 16-bit, or 64-bit form as required.
 * @param payload - the UTF-8 bytes to send.
 * @param opcode - the frame opcode.
 * @returns the encoded frame.
 */
export function encodeFrame(payload: Buffer, opcode = OPCODE_TEXT): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** The handshake response for one request, or a rejection reason. */
export function handshakeResponse(
  headers: UpgradeRequestFacts['headers'],
): { response: string } | { rejection: string } {
  const upgrade = headerValue(headers, 'upgrade')?.toLowerCase()
  const key = headerValue(headers, 'sec-websocket-key')
  const version = headerValue(headers, 'sec-websocket-version')

  if (upgrade !== 'websocket') return { rejection: 'not a websocket upgrade' }
  if (key === undefined || key === '') return { rejection: 'missing Sec-WebSocket-Key' }
  // Only version 13 is implemented; accepting another would produce frames the
  // peer parses differently.
  if (version !== '13') return { rejection: `unsupported Sec-WebSocket-Version ${String(version)}` }

  const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
  return {
    response: [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  }
}

/**
 * Take over one upgraded socket.
 * @param req - the upgrade request.
 * @param socket - the raw duplex socket.
 * @param head - bytes already read past the handshake.
 * @param makeId - mints the connection identity.
 * @returns the live socket, or the rejection to answer with.
 */
export function acceptUpgrade(
  req: UpgradeRequestFacts,
  socket: UpgradeSocketFacts,
  head: Buffer,
  makeId: () => string,
): UpgradeResult {
  const handshake = handshakeResponse(req.headers)
  if ('rejection' in handshake) {
    // Refuse with a real HTTP response so a browser reports a failed handshake
    // instead of hanging until its own timeout.
    socket.write(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n${handshake.rejection}`)
    socket.destroy()
    return { rejection: handshake.rejection }
  }

  socket.write(handshake.response)

  const id = makeId()
  const sessionId = parseSessionId(req.url)
  const closeListeners = new Set<() => void>()
  let closed = false

  const finish = (): void => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) {
      try {
        listener()
      } catch {
        // A listener that throws must not keep the connection bookkeeping alive.
      }
    }
    closeListeners.clear()
  }

  // The client sends nothing on this channel, but it may still send a close or a
  // ping, and an unread socket buffers forever. Frames are drained and only
  // close/ping are acted on; anything else is ignored.
  socket.on('data', (chunk: Buffer) => {
    for (const opcode of scanOpcodes(chunk)) {
      if (opcode === OPCODE_CLOSE) {
        socket.end(encodeFrame(Buffer.alloc(0), OPCODE_CLOSE))
        finish()
        return
      }
      if (opcode === OPCODE_PING) {
        socket.write(encodeFrame(Buffer.alloc(0), OPCODE_PONG))
      }
    }
  })
  socket.on('close', finish)
  socket.on('end', finish)
  socket.on('error', finish)

  if (head.length > 0) {
    // Bytes that arrived with the handshake are part of the stream.
    for (const opcode of scanOpcodes(head)) {
      if (opcode === OPCODE_CLOSE) finish()
    }
  }

  return {
    socket: {
      id,
      sessionId,
      send(text) {
        if (closed) return false
        try {
          socket.write(encodeFrame(Buffer.from(text, 'utf8')))
          return true
        } catch {
          finish()
          return false
        }
      },
      close() {
        if (closed) return
        try {
          socket.end(encodeFrame(Buffer.alloc(0), OPCODE_CLOSE))
        } catch {
          socket.destroy()
        }
        finish()
      },
      onClose(listener) {
        if (closed) {
          listener()
          return
        }
        closeListeners.add(listener)
      },
    },
  }
}

/**
 * Parse the `sessionId` query parameter out of an upgrade URL.
 * @param url - the request URL, possibly relative.
 * @returns the value, or `''`.
 */
export function parseSessionId(url: string | undefined): string {
  if (url === undefined) return ''
  try {
    return new URL(url, 'http://dsh.internal').searchParams.get('sessionId') ?? ''
  } catch {
    return ''
  }
}

/**
 * Read the opcodes of the frames in a buffer.
 *
 * Deliberately shallow: this channel receives at most close and ping frames from
 * a well-behaved `WebSocket` client, so full unmasking and reassembly would be
 * unused code. A frame whose header is incomplete is skipped rather than guessed
 * at, which is safe because no received payload is ever acted on.
 * @param buffer - received bytes.
 * @returns the opcodes that could be read.
 */
export function scanOpcodes(buffer: Buffer): number[] {
  const opcodes: number[] = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset]! & 0x0f
    const masked = (buffer[offset + 1]! & 0x80) !== 0
    let length = buffer[offset + 1]! & 0x7f
    let headerLength = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(offset + 2))
      headerLength = 10
    }
    const maskLength = masked ? 4 : 0
    const total = headerLength + maskLength + length
    if (offset + total > buffer.length) break
    opcodes.push(opcode)
    offset += total
  }
  return opcodes
}
