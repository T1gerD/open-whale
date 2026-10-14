// Minimal RFC 6455 server-side WebSocket implementation.
//
// Why hand-rolled instead of the `ws` package: the plugin must install with zero
// dependencies and no build step, and both directions of this protocol only need
// text frames up to the size the protocol itself caps. The implementation below
// is intentionally small and fully covered by tests.
//
// Supported: text frames, fragmentation (reassembly + fragmented sends), ping /
// pong, close handshake, and payloads above 64 KiB via the 64-bit length form.
// Not supported (and rejected loudly rather than half-working): extensions,
// compression, binary application payloads.
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

/** The RFC 6455 handshake GUID. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

/** Guard against a peer forcing unbounded memory growth with one huge frame. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
/** Guard against an unbounded number of fragments in one message. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/**
 * Compute the `Sec-WebSocket-Accept` value for a client key.
 * @param {string} key
 */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/**
 * Validate an `Upgrade: websocket` request. Returns a reason string when the
 * handshake must be refused, so the caller can answer with a real HTTP error
 * instead of a half-open socket.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null} null when acceptable
 */
export function validateUpgrade(req) {
  if (!req.headers.host) return 'missing Host header'
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return 'not a websocket upgrade'
  if (!String(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()).includes('upgrade')) {
    return 'missing Connection: Upgrade'
  }
  if (!req.headers['sec-websocket-version'] || req.headers['sec-websocket-version'] !== '13') {
    return 'unsupported websocket version'
  }
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) return 'missing Sec-WebSocket-Key'
  return null
}

/**
 * Encode a single frame (server → client, so unmasked).
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} [fin]
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, fin = true) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode
  return Buffer.concat([header, payload])
}

/**
 * Incremental frame decoder. Feed it raw socket bytes; it yields complete
 * messages once every fragment of a message has arrived.
 */
export class FrameDecoder extends EventEmitter {
  constructor(options = {}) {
    super()
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    /** @type {Buffer[]} */
    this.fragments = []
    this.fragmentOpcode = 0
    this.fragmented = false
    this.fragmentBytes = 0
    this.closed = false
  }

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    try {
      while (this.#step()) { /* decode as many frames as are complete */ }
    } catch (error) {
      this.emit('error', error)
    }
  }

  /**
   * Try to decode one frame. Returns true when a frame was consumed.
   * @returns {boolean}
   */
  #step() {
    const buf = this.buffer
    if (buf.length < 2) return false
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buf.length < offset + 2) return false
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return false
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(this.maxFrameBytes)) throw new Error(`frame too large: ${big} bytes`)
      length = Number(big)
      offset += 8
    }
    if (length > this.maxFrameBytes) throw new Error(`frame too large: ${length} bytes`)

    // A client → server frame MUST be masked (RFC 6455 §5.1).
    let mask = null
    if (masked) {
      if (buf.length < offset + 4) return false
      mask = buf.subarray(offset, offset + 4)
      offset += 4
    } else if (opcode !== OPCODE.CLOSE) {
      throw new Error('unmasked client frame')
    }

    if (buf.length < offset + length) return false
    const payload = Buffer.allocUnsafe(length)
    buf.copy(payload, 0, offset, offset + length)
    if (mask) {
      for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3]
    }
    this.buffer = buf.subarray(offset + length)
    this.#deliver(fin, opcode, payload)
    return true
  }

  #deliver(fin, opcode, payload) {
    if (opcode === OPCODE.CLOSE) {
      this.closed = true
      this.emit('close', payload)
      return
    }
    if (opcode === OPCODE.PING) {
      this.emit('ping', payload)
      return
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong', payload)
      return
    }
    if (opcode === OPCODE.CONTINUATION) {
      if (!this.fragmented) throw new Error('continuation without an initial frame')
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > this.maxMessageBytes) throw new Error('fragmented message too large')
      this.fragments.push(payload)
      if (fin) {
        const whole = Buffer.concat(this.fragments)
        const initial = this.fragmentOpcode
        this.fragments = []
        this.fragmented = false
        this.fragmentBytes = 0
        this.#message(initial, whole)
      }
      return
    }
    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (this.fragmented) throw new Error('new data frame while a fragmented message is open')
      if (!fin) {
        this.fragmented = true
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        this.fragmentBytes = payload.length
        return
      }
      this.#message(opcode, payload)
      return
    }
    throw new Error(`unsupported opcode 0x${opcode.toString(16)}`)
  }

  #message(opcode, payload) {
    if (opcode === OPCODE.BINARY) {
      this.emit('error', new Error('binary frames are not accepted by this protocol'))
      return
    }
    this.emit('message', payload.toString('utf8'))
  }
}

/**
 * Build the payload of a close frame.
 * @param {number} code
 * @param {string} reason
 */
function closePayload(code, reason) {
  const head = Buffer.alloc(2)
  head.writeUInt16BE(code, 0)
  return reason ? Buffer.concat([head, Buffer.from(reason, 'utf8')]) : head
}

/**
 * A connected peer: thin wrapper over the socket adding framing and lifecycle
 * events. Emits `message` (string), `close`, and `error`.
 */
export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:stream').Duplex} socket
   * @param {{maxFrameBytes?: number, maxMessageBytes?: number, isAlive?: () => boolean}} [options]
   */
  constructor(socket, options = {}) {
    super()
    this.socket = socket
    this.closed = false
    this.decoder = new FrameDecoder(options)
    this.pingIntervalMs = options.pingIntervalMs ?? 0

    socket.on('data', chunk => this.decoder.push(chunk))
    this.decoder.on('message', text => this.emit('message', text))
    this.decoder.on('ping', payload => this.#send(encodeFrame(OPCODE.PONG, payload)))
    this.decoder.on('pong', () => { this.lastPongAt = Date.now() })
    this.decoder.on('error', error => {
      this.emit('error', error)
      this.close(1002, 'protocol error')
    })
    this.decoder.on('close', payload => {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.#closeFromPeer(code === 1005 ? 1000 : code)
    })
    socket.on('close', () => this.#settle())
    socket.on('error', error => {
      this.emit('error', error)
      this.#settle()
    })
  }

  /** @param {string} text */
  send(text) {
    if (this.closed) return false
    return this.#send(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')))
  }

  /**
   * Send one text frame and report whether the socket kept up.
   *
   * Bulk transfers use this instead of `send()` so they can await `waitForDrain()`
   * when the peer is slower than the disk: queueing a whole file into an
   * un-drained socket makes the transfer stall instead of completing.
   * @param {string} text
   * @returns {boolean} false when the connection is gone or the write buffered
   */
  sendWithBackpressure(text) {
    if (this.closed) return false
    return this.#send(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8')))
  }

  /** Resolve once the socket has drained, or immediately if it is already gone. */
  waitForDrain() {
    if (this.closed || this.socket.writableEnded || this.socket.destroyed) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        this.socket.off('drain', done)
        this.socket.off('close', done)
        this.socket.off('error', done)
        resolve(undefined)
      }
      this.socket.once('drain', done)
      this.socket.once('close', done)
      this.socket.once('error', done)
    })
  }

  /** @param {number} [code] @param {string} [reason] @param {{echo?: boolean}} [options] */
  close(code = 1000, reason = '', options = {}) {
    if (this.closed) return
    this.closed = true
    if (options.echo !== false) {
      try {
        this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)))
      } catch { /* socket already gone */ }
    }
    this.#endSocket()
    this.#settle()
  }

  /**
   * The peer sent us a close frame. RFC 6455 §5.5.1: echo the close frame and
   * let the peer close the TCP connection. Ending synchronously here would race
   * the echo (a reset can discard it), so the socket close is deferred to the
   * next tick, which is enough for the echo to be flushed for a local peer.
   */
  #closeFromPeer(code) {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, '')))
    } catch { /* socket already gone */ }
    this.#endSocket()
    this.#settle()
  }

  #endSocket() {
    const socket = this.socket
    setImmediate(() => {
      try {
        socket.end()
      } catch { /* ignore */ }
      // If the peer never closes, reclaim the fd rather than leaking it.
      setTimeout(() => {
        try {
          socket.destroy()
        } catch { /* ignore */ }
      }, 1000).unref?.()
    })
  }

  #send(frame) {
    try {
      return this.socket.write(frame)
    } catch (error) {
      this.emit('error', error)
      return false
    }
  }

  #settle() {
    if (this.settled) return
    this.settled = true
    this.closed = true
    this.emit('close')
  }
}

/**
 * Create the HTTP response that completes a WebSocket upgrade and return the
 * wrapped connection.
 *
 * `head` is the documented buffer of bytes already read past the request headers.
 * In practice the request parser has consumed them and `head` is an empty buffer;
 * feeding it to the frame decoder unconditionally is what breaks connections, so
 * a leftover HTTP header block is detected and rejected instead of being decoded.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{maxFrameBytes?: number, pingIntervalMs?: number}} [options]
 * @returns {WsConnection}
 */
export function acceptUpgrade(req, socket, head, options = {}) {
  const key = String(req.headers['sec-websocket-key'])
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
    + '\r\n',
  )
  const connection = new WsConnection(socket, options)
  if (head && head.length > 0) {
    if (looksLikeHttpHead(head)) {
      connection.emit('error', new Error('refusing upgrade: unparsed HTTP head bytes'))
      connection.close(1002, 'bad upgrade')
      return connection
    }
    connection.decoder.push(head)
  }
  return connection
}

/**
 * True when a buffer starts like an HTTP request line (i.e. the HTTP parser did
 * not consume it). A WebSocket frame can never start with an uppercase ASCII
 * method followed by a space, because bit 7 of the first byte is FIN and the
 * remaining bits are a 4-bit opcode.
 * @param {Buffer} head
 */
export function looksLikeHttpHead(head) {
  if (head.length < 4) return false
  const methodChars = head.subarray(0, 4).toString('latin1')
  return /^(GET|POST|PUT|HEAD|OPTI)$/.test(methodChars) && head.length > 4 && head[4] === 0x20
}

/** Generate a client-side masking key (used by tests and by the mobile app). */
export function newMaskKey() {
  return randomBytes(4)
}

/**
 * Encode a client → server frame (masked). Exported because our own end-to-end
 * tests act as a real client rather than trusting the server's encoder.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} [fin]
 */
export function encodeMaskedFrame(opcode, payload, fin = true) {
  const mask = newMaskKey()
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode
  return Buffer.concat([header, mask, masked])
}
