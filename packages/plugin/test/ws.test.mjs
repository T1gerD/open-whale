import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'

import {
  MAX_FRAME_BYTES,
  OPCODE,
  WsConnection,
  acceptKey,
  encodeFrame,
  encodeMaskedFrame,
  newMaskKey,
  validateUpgrade,
} from '../src/ws.mjs'

/** Collect decoder events for assertions. */
function decodeAll(chunks) {
  const { FrameDecoder } = framesModule
  const decoder = new FrameDecoder()
  const messages = []
  const closes = []
  const errors = []
  decoder.on('message', m => messages.push(m))
  decoder.on('close', c => closes.push(c))
  decoder.on('error', e => errors.push(e))
  for (const chunk of chunks) decoder.push(chunk)
  return { messages, closes, errors }
}

const framesModule = await import('../src/ws.mjs')

test('acceptKey matches the RFC 6455 example vector', () => {
  // The canonical example from RFC 6455 §1.3.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('decodeFrame reads a masked text frame from a client', () => {
  const frame = encodeMaskedFrame(OPCODE.TEXT, Buffer.from('hello whale', 'utf8'))
  assert.equal(decodeAll([frame]).messages[0], 'hello whale')
})

test('a frame split across arbitrary chunk boundaries still decodes', () => {
  const frame = encodeMaskedFrame(OPCODE.TEXT, Buffer.from('长连接测试 payload', 'utf8'))
  for (let split = 1; split < frame.length; split++) {
    const { messages } = decodeAll([frame.subarray(0, split), frame.subarray(split)])
    assert.equal(messages[0], '长连接测试 payload', `split at ${split}`)
  }
})

test('two frames arriving in one TCP chunk are both decoded', () => {
  const both = Buffer.concat([
    encodeMaskedFrame(OPCODE.TEXT, Buffer.from('one')),
    encodeMaskedFrame(OPCODE.TEXT, Buffer.from('two')),
  ])
  assert.deepEqual(decodeAll([both]).messages, ['one', 'two'])
})

test('a frame arriving in single-byte chunks decodes', () => {
  const frame = encodeMaskedFrame(OPCODE.TEXT, Buffer.from('byte by byte'))
  const chunks = [...frame].map(b => Buffer.from([b]))
  assert.deepEqual(decodeAll(chunks).messages, ['byte by byte'])
})

test('empty text frames and multi-byte characters round-trip', () => {
  assert.deepEqual(decodeAll([encodeMaskedFrame(OPCODE.TEXT, Buffer.from(''))]).messages, [''])
  assert.deepEqual(
    decodeAll([encodeMaskedFrame(OPCODE.TEXT, Buffer.from('🐳 助理回复'))]).messages,
    ['🐳 助理回复'],
  )
})

test('a 16-bit and a 64-bit length frame decode correctly', () => {
  const medium = 'm'.repeat(1000)
  const large = 'L'.repeat(70000)
  assert.equal(decodeAll([encodeMaskedFrame(OPCODE.TEXT, Buffer.from(medium))]).messages[0], medium)
  assert.equal(decodeAll([encodeMaskedFrame(OPCODE.TEXT, Buffer.from(large))]).messages[0], large)
})

test('fragmented messages are reassembled', () => {
  const frame = Buffer.concat([
    encodeMaskedFrame(OPCODE.TEXT, Buffer.from('part1-'), false),
    encodeMaskedFrame(OPCODE.CONTINUATION, Buffer.from('part2-'), false),
    encodeMaskedFrame(OPCODE.CONTINUATION, Buffer.from('part3'), true),
  ])
  assert.deepEqual(decodeAll([frame]).messages, ['part1-part2-part3'])
})

test('a continuation without an opening frame is a protocol error', () => {
  const { errors } = decodeAll([encodeMaskedFrame(OPCODE.CONTINUATION, Buffer.from('x'), true)])
  assert.match(errors[0].message, /continuation without an initial frame/)
})

test('an unmasked client data frame is rejected', () => {
  const { errors } = decodeAll([encodeFrame(OPCODE.TEXT, Buffer.from('unmasked'))])
  assert.match(errors[0].message, /unmasked client frame/)
})

test('a pixel-large declared frame is refused before allocating', () => {
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1), 2)
  const { errors } = decodeAll([header])
  assert.match(errors[0].message, /frame too large/)
})

test('a fragmented message larger than the cap is refused', () => {
  const { FrameDecoder } = framesModule
  const decoder = new FrameDecoder({ maxMessageBytes: 4 })
  const errors = []
  decoder.on('error', e => errors.push(e))
  decoder.push(encodeMaskedFrame(OPCODE.TEXT, Buffer.from('abc'), false))
  decoder.push(encodeMaskedFrame(OPCODE.CONTINUATION, Buffer.from('de'), true))
  assert.match(errors[0].message, /fragmented message too large/)
})

test('binary frames are refused instead of silently decoded as text', () => {
  const { errors } = decodeAll([encodeMaskedFrame(OPCODE.BINARY, Buffer.from([1, 2, 3]))])
  assert.match(errors[0].message, /binary frames/)
})

test('a close frame is surfaced with its payload', () => {
  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(1001, 0)
  assert.equal(decodeAll([encodeMaskedFrame(OPCODE.CLOSE, payload)]).closes[0].readUInt16BE(0), 1001)
})

test('encodeFrame writes the three length forms', () => {
  const small = encodeFrame(OPCODE.TEXT, Buffer.alloc(10))
  assert.equal(small[1], 10)
  const medium = encodeFrame(OPCODE.TEXT, Buffer.alloc(200))
  assert.equal(medium[1], 126)
  assert.equal(medium.readUInt16BE(2), 200)
  const large = encodeFrame(OPCODE.TEXT, Buffer.alloc(70000))
  assert.equal(large[1], 127)
  assert.equal(Number(large.readBigUInt64BE(2)), 70000)
})

test('validateUpgrade accepts a well-formed handshake', () => {
  const req = {
    headers: {
      host: 'localhost:8787',
      upgrade: 'WebSocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  }
  assert.equal(validateUpgrade(req), null)
})

test('validateUpgrade explains each refusal', () => {
  const base = {
    headers: {
      host: 'h',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'k',
      'sec-websocket-version': '13',
    },
  }
  const broken = patch => ({ headers: { ...base.headers, ...patch } })
  assert.match(validateUpgrade(broken({ upgrade: 'h2c' })), /not a websocket upgrade/)
  assert.match(validateUpgrade(broken({ connection: 'keep-alive' })), /Connection/)
  assert.match(validateUpgrade(broken({ 'sec-websocket-version': '8' })), /version/)
  assert.match(validateUpgrade(broken({ 'sec-websocket-key': '' })), /Sec-WebSocket-Key/)
  assert.match(validateUpgrade({ headers: {} }), /Host/)
})

test('newMaskKey returns four fresh random bytes', () => {
  const key = newMaskKey()
  assert.equal(key.length, 4)
  assert.notDeepEqual(newMaskKey(), newMaskKey())
})

// --- WsConnection over a real socket pair -----------------------------------

/**
 * Open a real WebSocket client against a real HTTP server using our own
 * handshake + framing code, so the socket path is exercised end to end rather
 * than mocked. Every socket carries an error listener: a reset during teardown
 * is expected and must not surface as an unhandled 'error' event.
 */
async function openClient(t) {
  const { createServer: createHttpServer } = await import('node:http')
  const httpServer = createHttpServer()
  const serverErrors = []
  httpServer.on('clientError', (error, socket) => {
    serverErrors.push(error.message)
    socket.destroy()
  })

  /** @type {WsConnection[]} */
  const connections = []
  /** Resolves with the first accepted server-side connection. */
  const firstConnection = new Promise(resolve => {
    httpServer.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {})
      const reason = validateUpgrade(req)
      if (reason) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const conn = acceptsConnection(socket, head, req)
      connections.push(conn)
      resolve(conn)
    })
  })

  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (httpServer.address())

  const socket = connect(port, '127.0.0.1')
  const clientErrors = []
  socket.on('error', error => clientErrors.push(error.code ?? error.message))

  const clientFrames = []
  let clientBuffer = Buffer.alloc(0)
  const pushClientBytes = chunk => {
    clientBuffer = Buffer.concat([clientBuffer, chunk])
    const decoded = decodeClientFrames(clientBuffer)
    clientFrames.push(...decoded.frames)
    clientBuffer = decoded.rest
  }

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  // A complete, valid client handshake. Omitting Host makes Node's HTTP parser
  // treat the bytes as an incomplete request and reset the socket on timeout,
  // which is a test bug, not a server behaviour.
  socket.write(
    'GET /openwhale/ws HTTP/1.1\r\n'
    + `Host: 127.0.0.1:${port}\r\n`
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${Buffer.from('openwhale-testkey').toString('base64')}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n\r\n',
  )

  let handshake = Buffer.alloc(0)
  await new Promise(resolve => {
    const onData = chunk => {
      handshake = Buffer.concat([handshake, chunk])
      const end = handshake.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const rest = handshake.subarray(end + 4)
      if (rest.length) pushClientBytes(rest)
      resolve()
    }
    socket.on('data', onData)
  })
  socket.on('data', pushClientBytes)

  const settle = async () => {
    for (const conn of connections) conn.close(1001, 'test over')
    socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 15))
    await new Promise(resolve => httpServer.close(() => resolve()))
  }
  t.after(settle)

  return {
    port,
    connections,
    socket,
    clientFrames,
    serverErrors,
    clientErrors,
    sendText: text => socket.write(encodeMaskedFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'))),
    sendPing: () => socket.write(encodeMaskedFrame(OPCODE.PING, Buffer.from('hi'))),
    sendClose: () => socket.write(encodeMaskedFrame(OPCODE.CLOSE, Buffer.alloc(2))),
    /** Wait for a predicate over collected client frames. */
    waitFor: async (predicate, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = clientFrames.find(predicate)
        if (found) return found
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return undefined
    },
    waitForServer: async (predicate, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs
      while (true) {
        for (const conn of connections) {
          const value = predicate(conn)
          if (value) return value
        }
        if (Date.now() >= deadline) return undefined
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    /**
     * Resolve with the server-side connection for this client. This awaits a
     * promise settled by the upgrade handler instead of polling the array: the
     * server connection is an event, and polling observable state is what made
     * this helper flaky before.
     */
    waitForConnection: async (timeoutMs = 3000) => {
      const timed = new Promise(resolve => setTimeout(() => resolve(undefined), timeoutMs))
      const conn = await Promise.race([firstConnection, timed])
      if (!conn) throw new Error(`server never accepted the connection (timeout ${timeoutMs}ms)`)
      return conn
    },
  }
}

/** Server-side upgrade completion, mirroring what gateway.mjs does. */
function acceptsConnection(socket, head, req) {
  const expected = createHash('sha1')
    .update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${expected}\r\n\r\n`,
  )
  const conn = new WsConnection(socket)
  conn.on('error', () => {})
  if (head?.length) conn.decoder.push(head)
  return conn
}

/**
 * Decode unmasked server → client frames out of an accumulating buffer.
 * Returns the frames that are complete plus the bytes of a trailing partial
 * frame, so the caller can keep feeding chunks (a TCP read boundary does not
 * respect frame boundaries).
 * @param {Buffer} buffer
 * @returns {{frames: Array<{text?: string, pong?: boolean, close?: boolean, ping?: boolean}>, rest: Buffer}}
 */
function decodeClientFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f
    let length = buffer[offset + 1] & 0x7f
    let headerLen = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      headerLen = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(offset + 2))
      headerLen = 10
    }
    if (offset + headerLen + length > buffer.length) break
    const payload = buffer.subarray(offset + headerLen, offset + headerLen + length)
    if (opcode === OPCODE.TEXT) frames.push({ text: payload.toString('utf8') })
    else if (opcode === OPCODE.PONG) frames.push({ pong: true })
    else if (opcode === OPCODE.CLOSE) frames.push({ close: true })
    else if (opcode === OPCODE.PING) frames.push({ ping: true })
    offset += headerLen + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

test('a real client handshake is accepted and text frames flow both ways', async t => {
  const client = await openClient(t)
  await client.waitForConnection()
  assert.equal(client.connections.length, 1)
  assert.deepEqual(client.serverErrors, [])

  const received = []
  client.connections[0].on('message', m => received.push(m))

  client.sendText('来自手机')
  await client.waitForServer(() => received.length > 0)
  assert.deepEqual(received, ['来自手机'])

  client.connections[0].send('来自电脑')
  const frame = await client.waitFor(f => f.text === '来自电脑')
  assert.ok(frame, 'server text frame should reach the client')
})

test('a fragmented client message is reassembled by the server', async t => {
  const client = await openClient(t)
  const server = await client.waitForConnection()
  assert.ok(server, 'client connection should reach the server')
  const received = []
  server.on('message', m => received.push(m))

  client.socket.write(encodeMaskedFrame(OPCODE.TEXT, Buffer.from('上半'), false))
  client.socket.write(encodeMaskedFrame(OPCODE.CONTINUATION, Buffer.from('下半'), true))
  await client.waitForServer(() => received.length > 0, 3000)
  assert.deepEqual(received, ['上半下半'])
})

test('server answers a ping with a pong', async t => {
  const client = await openClient(t)
  await client.waitForConnection()
  client.sendPing()
  const pong = await client.waitFor(f => f.pong === true)
  assert.ok(pong, 'expected a pong')
})

test('a close handshake is echoed and the connection reports itself closed', async t => {
  const client = await openClient(t)
  const server = await client.waitForConnection()
  client.sendClose()
  const echoed = await client.waitFor(f => f.close === true, 3000)
  assert.ok(echoed, 'expected the close frame to be echoed')
  assert.equal(server.closed, true)
})

test('sending on a closed connection is a no-op, not a crash', async t => {
  const client = await openClient(t)
  await client.waitForConnection()
  const server = client.connections[0]
  server.close(1000, 'bye')
  assert.equal(server.send('after close'), false)
})

test('a server push larger than one TCP segment arrives intact', async t => {
  const client = await openClient(t)
  await client.waitForConnection()
  const big = '鲸'.repeat(40000)
  client.connections[0].send(big)
  const frame = await client.waitFor(f => f.text === big, 3000)
  assert.ok(frame, 'a large server frame must be reassembled on the client')
})

test('an invalid handshake is refused with a real HTTP status', async t => {
  const { createServer: createHttpServer } = await import('node:http')
  const httpServer = createHttpServer()
  httpServer.on('upgrade', (req, socket) => {
    socket.on('error', () => {})
    const reason = validateUpgrade(req)
    if (reason) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (httpServer.address())
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise(resolve => socket.once('connect', resolve))
  const chunks = []
  socket.on('data', c => chunks.push(c))
  // Missing Sec-WebSocket-Key: the server must answer HTTP, not hang.
  socket.write(
    'GET /openwhale/ws HTTP/1.1\r\n'
    + `Host: 127.0.0.1:${port}\r\n`
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n',
  )
  await new Promise(resolve => setTimeout(resolve, 100))
  const raw = Buffer.concat(chunks).toString('latin1')
  assert.match(raw, /400 Bad Request/)
  socket.destroy()
  await new Promise(resolve => httpServer.close(() => resolve()))
})
