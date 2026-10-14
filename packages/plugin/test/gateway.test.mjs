import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

import { helloAckProofMessage, helloSignatureMessage } from '../src/protocol.mjs'
import { Gateway, WS_PATH } from '../src/gateway.mjs'
import { StateStore } from '../src/state.mjs'

/** A bridge that records calls and lets tests inject events. */
function makeBridge() {
  const sent = []
  const cancelled = []
  const listeners = []
  const renamed = []
  const powerCalls = []
  // Mutable so a test can flip the power policy the same way the real plugin
  // reads it from the state store's preferences.
  const harness = {
    sent,
    cancelled,
    listeners,
    renamed,
    powerCalls,
    allowShutdown: true,
    /** @type {any} */
    bridge: null,
  }
  harness.bridge = {
    send: async input => { sent.push(input) },
    cancel: callId => cancelled.push(callId),
    renameAssistant: async input => { renamed.push(input) },
    power: async input => {
      powerCalls.push(input)
      // Mirrors PowerManager: the shutdown policy can refuse a new
      // shutdown/restart, but never a cancel — refusing the safe direction would
      // turn a mistake into a shutdown the user cannot stop.
      if (input.action === 'cancel') return { accepted: true, message: '已取消' }
      if (harness.allowShutdown === false) {
        return { accepted: false, reason: 'disabled-by-policy', message: '已禁止' }
      }
      return { accepted: true, delaySeconds: input.delaySeconds ?? 30, cancelToken: 'tok' }
    },
    onEvent: listener => {
      listeners.push(listener)
      return () => {}
    },
  }
  return harness
}

async function makeGateway(options = {}) {
  // Note the spread: `lanUrls`/`tunnelUrls` must stay functions, so the
  // array-valued test inputs are translated instead of passed through. Passing
  // an array here is the mistake this helper exists to prevent — the gateway
  // would then call an array and every route would answer 500.
  const { lanUrls = ['http://127.0.0.1:1'], tunnelUrls = [], ...rest } = options
  const dir = rest.dir ?? mkdtempSync(join(tmpdir(), 'openwhale-gw-'))
  const store = new StateStore({ dir, hostName: '测试电脑' })
  const harness = makeBridge()
  const gateway = new Gateway({
    store,
    bridge: rest.bridge ?? harness.bridge,
    lanUrls: () => lanUrls,
    tunnelUrls: () => tunnelUrls,
    ...rest,
  })
  const port = await gateway.listen(0, '127.0.0.1')
  return { gateway, store, port, dir, harness }
}

/**
 * A real phone-side client: real TCP, real WebSocket frames, real signatures.
 * Reusing the plugin's own framing code would hide a framing bug, so this client
 * encodes frames independently (masked) and decodes server frames itself.
 */
async function connectClient(port) {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise(resolve => socket.once('connect', resolve))

  const frames = []
  let buffer = Buffer.alloc(0)
  // The 101 response must be fully consumed before the first frame is written.
  // Node's HTTP parser owns the socket until the upgrade completes, so a frame
  // sent earlier is parsed as a bogus HTTP request and the socket is reset —
  // which is a test-sequencing bug, not a gateway bug.
  let handshakeDone = false
  let resolveHandshake
  const handshake = new Promise(resolve => { resolveHandshake = resolve })

  const decode = () => {
    while (offset + 2 <= buffer.length) {
      const opcode = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let headerLen = 2
      if (length === 126) {
        if (buffer.length < 4) break
        length = buffer.readUInt16BE(2)
        headerLen = 4
      } else if (length === 127) {
        if (buffer.length < 10) break
        length = Number(buffer.readBigUInt64BE(2))
        headerLen = 10
      }
      if (buffer.length < headerLen + length) break
      const payload = buffer.subarray(headerLen, headerLen + length)
      buffer = buffer.subarray(headerLen + length)
      if (opcode === 0x1) {
        try {
          frames.push(JSON.parse(payload.toString('utf8')))
        } catch {
          frames.push({ t: '__unparseable', raw: payload.toString('utf8') })
        }
      } else if (opcode === 0x8) {
        frames.push({ t: '__close' })
      } else if (opcode === 0x9) {
        // answer ping so keepalive tests exercise the real path
        socket.write(encodeMasked(0xa, payload))
      }
    }
  }

  let offset = 0
  socket.on('data', chunk => {
    if (process.env.GWDEBUG) console.log('  [client raw]', JSON.stringify(chunk.toString('latin1').slice(0, 120)))
    buffer = Buffer.concat([buffer, chunk])
    if (!handshakeDone) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end !== -1) {
        const rest = buffer.subarray(end + 4)
        buffer = rest
        handshakeDone = true
        decode()
        resolveHandshake()
        return
      }
    }
    decode()
  })

  socket.write(
    `GET ${WS_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${Buffer.from('openwhale-client1').toString('base64')}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n\r\n',
  )
  await Promise.race([
    handshake,
    new Promise(resolve => { setTimeout(resolve, 2000).unref?.() }),
  ])
  if (!handshakeDone) throw new Error('websocket handshake did not complete')

  /**
   * Wait for a frame matching the predicate.
   *
   * Polling with an unref'd timer rather than an awaited promise: an awaited
   * 15ms timer is exactly what keeps the test process alive when a test fails
   * early, and the timer itself must therefore not hold the event loop open.
   */
  async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const found = frames.find(predicate)
      if (found) return found
      if (Date.now() >= deadline) return undefined
      await new Promise(resolve => {
        setTimeout(resolve, 10).unref?.()
      })
    }
  }

  return {
    socket,
    frames,
    waitFor,
    send: frame => {
      const encoded = encodeMasked(0x1, Buffer.from(JSON.stringify(frame), 'utf8'))
      if (process.env.GWDEBUG) console.log('  [client send]', JSON.stringify(frame), 'bytes', encoded.length)
      socket.write(encoded)
    },
    close: () => socket.destroy(),
  }
}

/** Independent client → server frame encoder (always masked). */
function encodeMasked(opcode, payload) {
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  let header
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | payload.length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, mask, masked])
}

/** Build a fresh bound-device identity. */
function freshDevice() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  // A random id, not a slice of the public key: the Ed25519 SPKI prefix is
  // constant, so `spki.subarray(0, 8)` collides across keypairs and silently
  // turned later tests into "already bound device" reconnect flows.
  return {
    privateKey,
    publicKeyB64: spki.toString('base64url'),
    deviceId: `dev_${randomUUID().replaceAll('-', '')}`,
  }
}

test('health route reports identity and pairing state', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const response = await fetch(`http://127.0.0.1:${port}/openwhale/health`)
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.computerId, store.computerId)
  assert.equal(body.paired, false)
  assert.equal(body.connections, 0)
})

test('an unknown path is not handled', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const response = await fetch(`http://127.0.0.1:${port}/something-else`)
  assert.equal(response.status, 404)
})

test('pairing.json exposes a scannable payload with a single-use secret', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const first = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  assert.equal(first.ok, true)
  assert.equal(first.payload.p, 'openwhale')
  assert.equal(first.payload.id, store.computerId)
  assert.equal(typeof first.payload.secret, 'string')

  // Reloading must reuse the live secret, not invalidate a QR mid-scan.
  const second = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  assert.equal(second.payload.secret, first.payload.secret)
})

test('qr routes return a real PNG and SVG', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const png = await fetch(`http://127.0.0.1:${port}/openwhale/qr.png`)
  assert.equal(png.headers.get('content-type'), 'image/png')
  const pngBytes = Buffer.from(await png.arrayBuffer())
  // PNG magic number.
  assert.deepEqual([...pngBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])

  const svg = await fetch(`http://127.0.0.1:${port}/openwhale/qr.svg`)
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
  assert.match(await svg.text(), /<svg/)
})

test('the binding page shows fingerprint and addresses', async t => {
  const { gateway, store, port } = await makeGateway({ lanUrls: ['http://192.168.1.9:8787'] })
  t.after(() => gateway.close())
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()
  assert.match(html, /Open Whale/)
  assert.match(html, /192\.168\.1\.9:8787/)
  assert.ok(html.includes(store.fingerprint.slice(0, 4).toUpperCase()))
})

test('qr routes refuse to mint a code when no endpoint exists', async t => {
  const { gateway, port } = await makeGateway({ lanUrls: [] })
  t.after(() => gateway.close())
  const response = await fetch(`http://127.0.0.1:${port}/openwhale/qr.png`)
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.error, 'no-endpoint')
})

test('a first-time device pairs with the QR secret and receives a signed hello/ack', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const pairing = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const payload = pairing.payload

  const client = await connectClient(port)
  client.send({
    t: 'hello',
    version: '1.0.0',
    deviceId: device.deviceId,
    deviceName: '我的手机',
    devicePublicKey: device.publicKeyB64,
    pairSecret: payload.secret,
  })

  const ack = await client.waitFor(f => f.t === 'hello/ack')
  assert.ok(ack, 'expected hello/ack')
  assert.equal(ack.pairAccepted, true)
  assert.equal(ack.paired, true)
  assert.equal(ack.computerId, store.computerId)
  assert.equal(ack.computerFingerprint, store.fingerprint)
  assert.equal(typeof ack.proof, 'string')
  assert.equal(typeof ack.heartbeatMs, 'number')

  // The computer signed the ack with the key whose fingerprint it advertised,
  // and a phone can verify it using only what the QR published.
  const { createPublicKey, verify } = await import('node:crypto')
  const advertised = createPublicKey({
    key: Buffer.from(payload.pk, 'base64url'),
    format: 'der',
    type: 'spki',
  })
  const verified = verify(
    null,
    Buffer.from(helloAckProofMessage(ack.nonce, device.deviceId)),
    advertised,
    Buffer.from(ack.proof, 'base64url'),
  )
  assert.equal(verified, true, 'hello/ack proof must verify against the public key in the QR')
  assert.equal(payload.pk, store.publicKeySpkiBase64Url)

  assert.equal(store.isPaired, true)
  assert.equal(store.device(device.deviceId).label, '我的手机')
  client.close()
})

test('pairing requires a secret and rejects a wrong one', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()

  const without = await connectClient(port)
  without.send({ t: 'hello', deviceId: device.deviceId, devicePublicKey: device.publicKeyB64 })
  const err = await without.waitFor(f => f.t === 'error')
  assert.equal(err.code, 'pairing-required')
  without.close()

  await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)
  const wrong = await connectClient(port)
  wrong.send({
    t: 'hello',
    deviceId: device.deviceId,
    devicePublicKey: device.publicKeyB64,
    pairSecret: 'definitely-not-the-secret',
  })
  const err2 = await wrong.waitFor(f => f.t === 'error')
  assert.equal(err2.code, 'pairing-rejected')
  assert.equal(store.isPaired, false)
  wrong.close()
})

test('a second phone is refused even with a valid pairing secret', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const first = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const one = await connectClient(port)
  one.send({
    t: 'hello',
    deviceId: first.deviceId,
    deviceName: '手机一',
    devicePublicKey: first.publicKeyB64,
    pairSecret: payload.payload.secret,
  })
  assert.ok(await one.waitFor(f => f.t === 'hello/ack'))

  // Mint a fresh window for the second phone; the computer is still bound.
  const second = freshDevice()
  const secondPayload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  // Already paired: the page refuses to offer a new window at all.
  assert.equal(secondPayload.error, 'already-paired')

  // A *different* phone. Its deviceId is unknown to the computer, so the
  // pairing path is taken and the single-phone policy is what refuses it.
  const two = await connectClient(port)
  two.send({
    t: 'hello',
    deviceId: 'dev_ffffffffffffffff',
    deviceName: '手机二',
    devicePublicKey: second.publicKeyB64,
    nonce: 'second-phone-nonce-1',
    pairSecret: payload.payload.secret,
  })
  const refused = await two.waitFor(f => f.t === 'error')
  assert.equal(refused.code, 'already-paired')
  assert.equal(store.devices.length, 1)
  one.close(); two.close()
})

test('a bound device reconnects by proving possession of its key — no QR needed', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()

  const first = await connectClient(port)
  first.send({
    t: 'hello',
    deviceId: device.deviceId,
    deviceName: '我的手机',
    devicePublicKey: device.publicKeyB64,
    pairSecret: payload.payload.secret,
  })
  await first.waitFor(f => f.t === 'hello/ack')
  first.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  // Reconnect: hello with a client-chosen nonce and its signature, no pairSecret.
  const second = await connectClient(port)
  const wrongKey = freshDevice()
  second.send({
    t: 'hello',
    deviceId: device.deviceId,
    devicePublicKey: wrongKey.publicKeyB64,
    nonce: 'unsigned-reconnect-1',
    signature: sign(null, Buffer.from(helloSignatureMessage('unsigned-reconnect-1')), wrongKey.privateKey).toString('base64url'),
  })
  const unsigned = await second.waitFor(f => f.t === 'error')
  assert.equal(unsigned.code, 'bad-signature', 'a signature from the wrong key must be refused')
  second.close()

  const third = await connectClient(port)
  const nonce = 'reconnect-nonce-0001'
  third.send({
    t: 'hello',
    deviceId: device.deviceId,
    deviceName: '我的手机',
    devicePublicKey: device.publicKeyB64,
    nonce,
    signature: sign(null, Buffer.from(helloSignatureMessage(nonce)), device.privateKey).toString('base64url'),
  })
  const ack = await third.waitFor(f => f.t === 'hello/ack')
  assert.ok(ack, 'a bound device must reconnect by proving its key, without scanning again')
  assert.equal(ack.pairAccepted, false, 'a reconnect is not a new pairing')
  assert.equal(ack.paired, true)
  third.close()
})

test('a replayed hello nonce is refused the second time', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const first = await connectClient(port)
  first.send({
    t: 'hello',
    deviceId: device.deviceId,
    deviceName: '我的手机',
    devicePublicKey: device.publicKeyB64,
    pairSecret: payload.payload.secret,
  })
  await first.waitFor(f => f.t === 'hello/ack')
  first.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  const nonce = 'replay-me-please-1'
  const signature = sign(null, Buffer.from(helloSignatureMessage(nonce)), device.privateKey).toString('base64url')
  const second = await connectClient(port)
  second.send({ t: 'hello', deviceId: device.deviceId, devicePublicKey: device.publicKeyB64, nonce, signature })
  assert.ok(await second.waitFor(f => f.t === 'hello/ack'), 'the first use of a nonce is accepted')
  second.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  // Identical hello bytes, replayed: the signature is still valid for the key,
  // so only the replay guard can reject it.
  const third = await connectClient(port)
  third.send({ t: 'hello', deviceId: device.deviceId, devicePublicKey: device.publicKeyB64, nonce, signature })
  const replayed = await third.waitFor(f => f.t === 'error')
  assert.equal(replayed.code, 'replayed-nonce')
  third.close()
})

test('a bound device signature is verified against the nonce the server issued', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const first = await connectClient(port)
  first.send({
    t: 'hello',
    deviceId: device.deviceId,
    deviceName: '我的手机',
    devicePublicKey: device.publicKeyB64,
    pairSecret: payload.payload.secret,
  })
  const ack = await first.waitFor(f => f.t === 'hello/ack')
  first.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  // A signature over the *server's* ack nonce must not authenticate: the client
  // has to sign the nonce it itself presents. This is the exact bug that made
  // "reopen the app without re-pairing" impossible before the fix.
  const stale = sign(null, Buffer.from(helloSignatureMessage(ack.nonce)), device.privateKey).toString('base64url')
  const second = await connectClient(port)
  second.send({ t: 'hello', deviceId: device.deviceId, devicePublicKey: device.publicKeyB64, nonce: 'client-nonce-for-mismatch', signature: stale })
  const err = await second.waitFor(f => f.t === 'error')
  assert.equal(err.code, 'bad-signature')
  second.close()

  // Signing one nonce but presenting another must also fail.
  const third = await connectClient(port)
  const mismatched = sign(null, Buffer.from(helloSignatureMessage('signed-this-one-0001')), device.privateKey).toString('base64url')
  third.send({ t: 'hello', deviceId: device.deviceId, devicePublicKey: device.publicKeyB64, nonce: 'but-presented-this', signature: mismatched })
  const err2 = await third.waitFor(f => f.t === 'error')
  assert.equal(err2.code, 'bad-signature')
  third.close()
})

test('frames other than hello are refused before authentication', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const client = await connectClient(port)
  client.send({ t: 'chat/send', callId: 'c1', text: 'hi' })
  const err = await client.waitFor(f => f.t === 'error')
  assert.equal(err.code, 'not-authenticated')
  client.close()
})

test('a malformed frame is reported instead of crashing the socket', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  // Raw text that is not JSON, and JSON that is missing `t`: both must be
  // reported on the same socket instead of tearing it down.
  client.socket.write(encodeMasked(0x1, Buffer.from('this is not json', 'utf8')))
  const err = await client.waitFor(f => f.t === 'error' && f.code === 'bad-json')
  assert.ok(err, 'invalid JSON must produce a bad-json error frame')
  client.socket.write(encodeMasked(0x1, Buffer.from('{"no":"type"}', 'utf8')))
  const err2 = await client.waitFor(f => f.t === 'error' && f.code === 'bad-frame')
  assert.ok(err2, 'a frame without t must produce a bad-frame error')

  client.send({ t: 'ping' })
  assert.ok(await client.waitFor(f => f.t === 'pong'), 'the socket must still work')
  client.close()
})

test('ping is answered with pong once authenticated, and refused before that', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()

  const unauthenticated = await connectClient(port)
  unauthenticated.send({ t: 'ping' })
  const refusal = await unauthenticated.waitFor(f => f.t === 'error')
  assert.equal(refusal.code, 'not-authenticated', 'an unauthenticated peer must not reach the API')
  unauthenticated.close()

  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  client.send({ t: 'ping' })
  assert.ok(await client.waitFor(f => f.t === 'pong'))
  client.close()
})

test('an unauthenticated socket is registered before it ever authenticates', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const client = await connectClient(port)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(gateway.sessions.size, 1)
  assert.equal(gateway.byDevice.size, 0, 'no device is trusted before the handshake')
  client.close()
})

test('chat/send is acknowledged before the bridge answers, and reaches the bridge', async t => {
  const { gateway, port, harness, store } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello',
    deviceId: device.deviceId,
    deviceName: '我的手机',
    devicePublicKey: device.publicKeyB64,
    pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', text: '你好' })
  const ack = await client.waitFor(f => f.t === 'chat/ack')
  assert.equal(ack.rid, 'r1')
  assert.equal(ack.callId, 'c1')

  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0].text, '你好')
  assert.equal(harness.sent[0].deviceId, device.deviceId)
  client.close()
})

test('an empty message is refused without waking the assistant', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  client.send({ t: 'chat/send', rid: 'r2', callId: 'c2', text: '   ' })
  const err = await client.waitFor(f => f.t === 'error')
  assert.equal(err.code, 'empty-message')
  assert.equal(harness.sent.length, 0)
  client.close()
})

test('assistant deltas, tools and completion are pushed to the owning device', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  gateway.pushEvent({ kind: 'typing', deviceId: device.deviceId, callId: 'c9', active: true })
  gateway.pushEvent({ kind: 'delta', deviceId: device.deviceId, callId: 'c9', seq: 0, text: '你好' })
  gateway.pushEvent({ kind: 'delta', deviceId: device.deviceId, callId: 'c9', seq: 1, text: '，' })
  gateway.pushEvent({ kind: 'tool', deviceId: device.deviceId, callId: 'c9', phase: 'tool-start', toolCallId: 't1', tool: 'read_image', summary: '读取图片' })
  gateway.pushEvent({ kind: 'done', deviceId: device.deviceId, callId: 'c9', text: '你好，我在。' })

  assert.ok(await client.waitFor(f => f.t === 'chat/typing'))
  const deltas = client.frames.filter(f => f.t === 'chat/delta')
  assert.equal(deltas.length, 2)
  assert.deepEqual(deltas.map(d => d.seq), [0, 1])
  assert.ok(await client.waitFor(f => f.t === 'chat/tool' && f.phase === 'tool-start'))
  const done = await client.waitFor(f => f.t === 'chat/done')
  assert.equal(done.text, '你好，我在。')
  client.close()
})

test('a push for an unknown device is dropped, not broadcast', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  assert.equal(gateway.pushEvent({ kind: 'delta', deviceId: 'someone-else', callId: 'x', text: 'leak' }), false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(client.frames.some(f => f.t === 'chat/delta'), false)
  client.close()
})

test('an over-long assistant answer is clamped and flagged', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  gateway.pushEvent({ kind: 'done', deviceId: device.deviceId, callId: 'c1', text: 'x'.repeat(30_000) })
  const done = await client.waitFor(f => f.t === 'chat/done')
  assert.equal(done.truncated, true)
  assert.ok(done.text.length < 25_000)
  client.close()
})

test('file/fetch streams meta, chunks and an end marker', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openwhale-files-'))
  const filePath = join(dir, 'report.txt')
  writeFileSync(filePath, 'A'.repeat(300_000))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const bridge = {
    send: async () => {},
    fileFor: async fileId => (fileId === 'f1' ? { name: 'report.txt', mime: 'text/plain', path: filePath } : undefined),
  }
  const { gateway, port } = await makeGateway({ bridge })
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  client.send({ t: 'file/fetch', rid: 'r1', fileId: 'f1' })
  const meta = await client.waitFor(f => f.t === 'file/meta')
  assert.equal(meta.name, 'report.txt')
  assert.equal(meta.size, 300_000)
  assert.match(meta.downloadPath, /^\/openwhale\/download\?token=/)

  const end = await client.waitFor(f => f.t === 'file/end', 4000)
  assert.ok(end, 'expected file/end')
  const chunks = client.frames.filter(f => f.t === 'file/chunk')
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`)
  const reassembled = Buffer.concat(chunks.map(c => Buffer.from(c.dataBase64, 'base64')))
  assert.equal(reassembled.length, 300_000)
  assert.equal(reassembled.toString('utf8'), 'A'.repeat(300_000))
  assert.deepEqual(chunks.map(c => c.seq), chunks.map((_, i) => i))
  client.close()
})

test('the HTTP download fallback serves the file once and then expires', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openwhale-dl-'))
  const filePath = join(dir, 'note.txt')
  writeFileSync(filePath, 'hello file')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const bridge = {
    send: async () => {},
    fileFor: async () => ({ name: 'note.txt', mime: 'text/plain', path: filePath }),
  }
  const { gateway, port } = await makeGateway({ bridge })
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  client.send({ t: 'file/fetch', rid: 'r1', fileId: 'f1' })
  const meta = await client.waitFor(f => f.t === 'file/meta')

  const download = await fetch(`http://127.0.0.1:${port}${meta.downloadPath}`)
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'hello file')

  const again = await fetch(`http://127.0.0.1:${port}${meta.downloadPath}`)
  assert.equal(again.status, 403, 'a download token must be single-use')
  client.close()
})

test('file/fetch reports a missing file instead of hanging', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  client.send({ t: 'file/fetch', rid: 'r1', fileId: 'nope' })
  const err = await client.waitFor(f => f.t === 'file/error')
  assert.equal(err.code, 'not-found')
  client.close()
})

test('renaming an assistant persists and is pushed back', async t => {
  const { gateway, store, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  client.send({ t: 'assistant/rename', rid: 'r1', label: '书房那台' })
  // Wait for the frame that carries the new label. The hello/ack push already
  // delivered an assistant list with the old name, so a predicate on "any
  // assistants frame" would assert against the stale one.
  const assistants = await client.waitFor(f => f.t === 'assistants' && f.assistants?.[0]?.name === '书房那台')
  assert.ok(assistants, 'the rename must be pushed back to the phone')
  assert.equal(store.device(device.deviceId).label, '书房那台')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(harness.renamed, [{ deviceId: device.deviceId, label: '书房那台' }])
  client.close()
})

test('power requests are routed to the bridge, and cancel is always allowed', async t => {
  const { gateway, port, harness, store } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')

  client.send({ t: 'power/request', rid: 'r1', action: 'shutdown', delaySeconds: 45 })
  const state = await client.waitFor(f => f.t === 'power/state')
  assert.equal(state.accepted, true)
  assert.equal(state.delaySeconds, 45)
  assert.equal(harness.powerCalls.length, 1)

  // The plugin reads this preference from the state store, and the bridge mock
  // mirrors the same policy, so flipping it here exercises the real branch.
  store.setPreference('power.allowShutdown', false)
  harness.allowShutdown = false
  client.send({ t: 'power/request', rid: 'r2', action: 'restart' })
  const refused = await client.waitFor(f => f.t === 'power/state' && f.rid === 'r2')
  assert.equal(refused.accepted, false)
  assert.equal(refused.reason, 'disabled-by-policy')

  client.send({ t: 'power/request', rid: 'r3', action: 'cancel' })
  const cancel = await client.waitFor(f => f.t === 'power/state' && f.rid === 'r3')
  assert.equal(cancel.accepted, true, 'cancel must stay available even when shutdown is disabled')
  client.close()
})

test('an unknown power action is refused', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  client.send({ t: 'power/request', rid: 'r1', action: 'launch-missiles' })
  const state = await client.waitFor(f => f.t === 'power/state')
  assert.equal(state.accepted, false)
  client.close()
})

test('the device may unbind itself, which revokes trust immediately', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  assert.equal(store.isPaired, true)

  client.send({ t: 'device/forget', deviceId: device.deviceId })
  const listing = await client.waitFor(f => f.t === 'assistants' && f.unbound === true)
  assert.ok(listing)
  assert.equal(store.isPaired, false)
  client.close()
})

test('a device cannot unbind a different device', async t => {
  const { gateway, store, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  client.send({ t: 'device/forget', deviceId: 'other-device' })
  const err = await client.waitFor(f => f.t === 'error')
  assert.equal(err.code, 'forbidden')
  assert.equal(store.isPaired, true)
  client.close()
})

test('an unknown frame type is ignored so both sides can ship independently', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const client = await connectClient(port)
  client.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  await client.waitFor(f => f.t === 'hello/ack')
  client.send({ t: 'future/feature', anything: true })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(client.frames.some(f => f.t === 'error'), false)
  assert.equal(client.frames.some(f => f.t === '__close'), false)
  client.close()
})

test('an upgrade on a foreign path is left alone', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise(resolve => socket.once('connect', resolve))
  const chunks = []
  socket.on('data', c => chunks.push(c))
  socket.write(`GET /other/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from('abcdefghijkl').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  await new Promise(resolve => setTimeout(resolve, 120))
  const raw = Buffer.concat(chunks).toString('latin1')
  assert.match(raw, /404|Upgrade/i)
  assert.equal(raw.includes('101 Switching Protocols'), false)
  socket.destroy()
})

test('a bad handshake gets a real HTTP 400 rather than a hang', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise(resolve => socket.once('connect', resolve))
  const chunks = []
  socket.on('data', c => chunks.push(c))
  socket.write(`GET ${WS_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.match(Buffer.concat(chunks).toString('latin1'), /400 Bad Request/)
  socket.destroy()
})

test('a new connection for the same device replaces the stale one', async t => {
  const { gateway, port, store } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const payload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const first = await connectClient(port)
  first.send({
    t: 'hello', deviceId: device.deviceId, deviceName: '手机', devicePublicKey: device.publicKeyB64, pairSecret: payload.payload.secret,
  })
  const ack = await first.waitFor(f => f.t === 'hello/ack')
  assert.ok(ack, 'the first connection must be bound')

  // The same device reconnects while the first socket is still open — what
  // happens whenever an app is killed and restarted, or a network path changes.
  // It must win, or the phone would be stuck talking to a half-dead socket.
  const probe = await connectClient(port)
  const probeNonce = 'probe-nonce-0000000001'
  probe.send({
    t: 'hello',
    deviceId: device.deviceId,
    deviceName: '手机',
    devicePublicKey: device.publicKeyB64,
    nonce: probeNonce,
    signature: sign(null, Buffer.from(helloSignatureMessage(probeNonce)), device.privateKey).toString('base64url'),
  })
  const secondAck = await probe.waitFor(f => f.t === 'hello/ack')
  assert.ok(secondAck, 'a reconnect with a valid device key must be accepted')
  assert.equal(secondAck.pairAccepted, false, 'a reconnect is not a new pairing')

  // The stale socket is closed, and the device slot now belongs to the new one.
  const closed = await first.waitFor(f => f.t === '__close')
  assert.ok(closed, 'the stale connection must be closed so the phone stops using it')
  assert.equal(gateway.sessionFor(device.deviceId)?.id !== undefined, true)
  assert.equal(store.isPaired, true)
  probe.close()
})


