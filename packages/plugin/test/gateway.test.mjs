import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

import {
  CAPABILITIES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  helloAckProofMessage,
  helloSignatureMessage,
} from '../src/protocol.mjs'
import { Gateway, PLUGIN_VERSION, WS_PATH } from '../src/gateway.mjs'
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

test('PLUGIN_VERSION matches the shipped package.json version', () => {
  // v2.2.0 的发布踩过：发版只改了 package.json，gateway 里硬编码的 PLUGIN_VERSION
  // 忘了改，health/hello-ack 仍报旧版本。这条测试把两者钉在一起。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test('the binding page offers one short web QR per address, LAN first', async t => {
  const { gateway, port } = await makeGateway({
    lanUrls: ['http://192.168.1.9:8787', 'http://100.102.90.23:8787'],
  })
  t.after(() => gateway.close())
  const pairing = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()

  // iOS 之前的失败：二维码只给了一个地址（通常是 Tailscale），且**没有**绑定参数。
  // 现在每个地址一个二维码，链接里带一次性 secret，扫码即绑定。
  const entries = html.split('<div class="web-entry">').length - 1
  assert.equal(entries, 2, 'one web QR per reachable address')
  const lanAt = html.indexOf('局域网（同一 Wi-Fi）')
  const tsAt = html.indexOf('Tailscale（外网）')
  assert.ok(lanAt >= 0 && tsAt >= 0, 'each entry is labelled with its network path')
  assert.ok(lanAt < tsAt, 'LAN must be listed before Tailscale')
  assert.ok(html.includes('192.168.1.9:8787/openwhale/app'), 'LAN address is shown')
  assert.ok(html.includes('100.102.90.23:8787/openwhale/app'), 'Tailscale address is shown')
  assert.equal(html.includes(pairing.payload.secret), false, 'the secret stays inside the QR, not in page text')
  assert.equal(html.includes('#p='), false, 'no dense payload QR is needed for the web client any more')
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

test('a second phone may pair because one computer serves up to MAX_DEVICES phones', async t => {
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

  // The computer is already bound, but a new pairing window is still offered:
  // multi-phone support means the page must keep handing out QR codes until the
  // cap is reached.
  const second = freshDevice()
  const secondPayload = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  assert.equal(secondPayload.ok, true)
  assert.equal(typeof secondPayload.payload.secret, 'string')

  // A *different* phone. Its deviceId is unknown to the computer, so the
  // pairing path is taken — and it is accepted now.
  const two = await connectClient(port)
  two.send({
    t: 'hello',
    deviceId: 'dev_ffffffffffffffff',
    deviceName: '手机二',
    devicePublicKey: second.publicKeyB64,
    nonce: 'second-phone-nonce-1',
    pairSecret: secondPayload.payload.secret,
  })
  assert.ok(await two.waitFor(f => f.t === 'hello/ack'))
  assert.equal(store.devices.length, 2)
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

/** Open another authenticated socket for an already-bound device. */
async function reconnectSession(port, device, options = {}) {
  const client = await connectClient(port)
  const nonce = `reconnect-${randomUUID()}`
  client.send({
    t: 'hello',
    version: '1.0.0',
    deviceId: device.deviceId,
    deviceName: options.deviceName ?? '手机',
    devicePublicKey: device.publicKeyB64,
    nonce,
    signature: sign(null, Buffer.from(helloSignatureMessage(nonce)), device.privateKey).toString('base64url'),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  })
  const ack = await client.waitFor(f => f.t === 'hello/ack')
  assert.ok(ack, 'a reconnect with a valid device key must be accepted')
  assert.equal(ack.pairAccepted, false, 'a reconnect is not a new pairing')
  return client
}

test('a device may hold several live sessions at once (endpoint racing)', async t => {
  const { gateway, port, store } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const caps = [CAPABILITIES.CHAT_MESSAGE, CAPABILITIES.CHAT_ECHO]
  const first = await pairDevice(port, device, { capabilities: caps })
  // The phone races two endpoints: both handshakes carry the same deviceId and
  // both must stay usable. Kicking the older one here is exactly the infinite
  // connect → kicked → reconnect loop reported in the field.
  const second = await reconnectSession(port, device, { capabilities: caps })
  assert.equal(gateway.sessionsForDevice(device.deviceId).length, 2)
  assert.equal(gateway.deviceOnline(device.deviceId), true)
  const health = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.equal(health.connections, 1, 'connections counts online devices, not racing sockets')
  assert.equal(health.sessions, 2, 'the raw socket count is reported separately')

  // A chat/echo from one session reaches both sockets of the same device: the
  // racing loser must not miss frames (clients dedupe by msgId).
  first.client.send({ t: 'chat/send', rid: 'r-echo', callId: 'c-echo', msgId: 'm-echo', text: '大家好' })
  assert.ok(await first.client.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm-echo'))
  assert.ok(await second.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm-echo'), 'both sessions of the device receive the echo')

  const conversationId = store.sessionIdFor(device.deviceId)
  gateway.pushEvent({
    kind: 'message', sessionId: conversationId, deviceId: device.deviceId, callId: 'c1', messageId: 'am_1', index: 0, text: '答',
  })
  assert.ok(await first.client.waitFor(f => f.t === 'chat/message'), 'the first socket still receives frames')
  assert.ok(await second.waitFor(f => f.t === 'chat/message'), 'the racing socket receives the same frames')

  // One of them goes away (the race loser is closed by the client): the device
  // stays online through the other connection.
  first.client.close()
  await delay(80)
  assert.equal(gateway.deviceOnline(device.deviceId), true, 'the device is still online via the surviving session')
  assert.equal(gateway.sessionsForDevice(device.deviceId).length, 1)
  gateway.pushEvent({
    kind: 'message', sessionId: conversationId, deviceId: device.deviceId, callId: 'c1', messageId: 'am_2', index: 1, text: '继续',
  })
  assert.ok(await second.waitFor(f => f.t === 'chat/message' && f.messageId === 'am_2'), 'the survivor keeps working')

  second.close()
  await delay(80)
  assert.equal(gateway.deviceOnline(device.deviceId), false, 'the device is offline once the last session closes')
  assert.equal(store.isPaired, true)
})

test('a fourth concurrent session for one device evicts the oldest connection', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const first = await pairDevice(port, device)
  const second = await reconnectSession(port, device)
  const third = await reconnectSession(port, device)
  assert.equal(gateway.sessionsForDevice(device.deviceId).length, 3)

  const fourth = await reconnectSession(port, device)
  // The cap is 3, so authenticating a fourth session retires the oldest one.
  assert.ok(await first.client.waitFor(f => f.t === '__close'), 'the oldest connection must be replaced')
  assert.equal(gateway.sessionsForDevice(device.deviceId).length, 3)
  assert.equal(gateway.deviceOnline(device.deviceId), true)
  second.close()
  third.close()
  fourth.close()
})

// ---------------------------------------------------------------------------
// v2.2.0: idempotency, multi-device broadcast, session sync, collaboration
// ---------------------------------------------------------------------------

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Bind one device and return its live client (hello already acked). */
async function pairDevice(port, device, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)
  const pairing = await response.json()
  assert.equal(pairing.ok, true, `the computer must offer a QR: ${pairing.message ?? ''}`)
  const client = await connectClient(port)
  client.send({
    t: 'hello',
    version: '1.0.0',
    deviceId: device.deviceId,
    deviceName: options.deviceName ?? '我的手机',
    devicePublicKey: device.publicKeyB64,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    pairSecret: pairing.payload.secret,
  })
  const ack = await client.waitFor(f => f.t === 'hello/ack')
  assert.ok(ack, 'expected hello/ack')
  return { client, ack, payload: pairing.payload }
}

test('a repeated chat/send is dropped by msgId and the second ack says duplicate', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device)

  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  const first = await client.waitFor(f => f.t === 'chat/ack')
  assert.equal(first.msgId, 'm1')
  assert.equal(first.duplicate, undefined)

  // The phone's outbox re-sends the same message when the first ack is lost.
  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  const second = await client.waitFor(f => f.t === 'chat/ack' && f.duplicate === true)
  assert.ok(second, 'a replay must be answered with duplicate:true')
  assert.equal(second.msgId, 'm1')

  await delay(50)
  assert.equal(harness.sent.length, 1, 'the assistant must only be woken once')
  client.close()
})

test('a v2.1 client without msgId is still deduplicated by its callId', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device)

  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', text: '你好' })
  const first = await client.waitFor(f => f.t === 'chat/ack')
  assert.equal(first.msgId, 'c1', 'msgId falls back to the legacy callId')
  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', text: '你好' })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack' && f.duplicate === true))
  await delay(50)
  assert.equal(harness.sent.length, 1)
  client.close()
})

test('a duplicate while the first delivery is still in flight does not reach the bridge twice', async t => {
  const sent = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const bridge = {
    send: async input => {
      sent.push(input)
      await gate
    },
  }
  const { gateway, port } = await makeGateway({ bridge })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device)

  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack'))
  // Retry before the first delivery resolved: the claim must already be in place,
  // otherwise a slow resume() would make the user's message arrive twice.
  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack' && f.duplicate === true))
  release()
  await delay(50)
  assert.equal(sent.length, 1)
  client.close()
})

test('a failed delivery releases the claim so the retry is delivered', async t => {
  let attempts = 0
  const received = []
  const bridge = {
    send: async input => {
      attempts += 1
      if (attempts === 1) throw new Error('电脑上的 AI 暂时不可用')
      received.push(input)
    },
  }
  const { gateway, port } = await makeGateway({ bridge })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device)

  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  const failure = await client.waitFor(f => f.t === 'error' && f.code === 'send-failed')
  assert.ok(failure, 'a failed delivery must be reported, not silently swallowed')

  // The phone keeps the message in its outbox because of the error. The retry is
  // acknowledged as a duplicate (so the outbox clears) and is delivered again —
  // one transient DSH error must not permanently swallow the message.
  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack' && f.duplicate === true))
  await delay(50)
  assert.equal(received.length, 1)
  assert.equal(attempts, 2)
  client.close()
})

test('a user message is echoed to every device in the conversation', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  const first = freshDevice()
  const second = freshDevice()
  const caps = [CAPABILITIES.CHAT_ECHO]
  const one = await pairDevice(port, first, { capabilities: caps })
  const two = await pairDevice(port, second, { capabilities: caps, deviceName: '手机二' })

  one.client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '大家好', speaker: '我' })
  const echoOnB = await two.client.waitFor(f => f.t === 'chat/echo')
  assert.ok(echoOnB, 'the other device must see the message')
  assert.equal(echoOnB.deviceId, first.deviceId)
  assert.equal(echoOnB.msgId, 'm1')
  assert.equal(echoOnB.text, '大家好')
  assert.equal(echoOnB.speaker, '我的手机')
  assert.equal(typeof echoOnB.seq, 'number')

  // The sender also receives the echo so clients dedupe by msgId instead of
  // special-casing "my own message came back".
  assert.ok(await one.client.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm1'))
  one.client.close()
  two.client.close()
})

test('assistant frames are broadcast to the whole conversation, with a legacy fallback', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  const newDevice = freshDevice()
  const legacyDevice = freshDevice()
  const modern = await pairDevice(port, newDevice, {
    capabilities: [CAPABILITIES.CHAT_MESSAGE, CAPABILITIES.CHAT_ECHO],
  })
  const legacy = await pairDevice(port, legacyDevice, { deviceName: '老手机' })

  gateway.pushEvent({
    kind: 'message',
    sessionId: 'conv-1',
    deviceId: newDevice.deviceId,
    callId: 'c1',
    messageId: 'am_1',
    index: 0,
    text: '第一条',
  })
  const message = await modern.client.waitFor(f => f.t === 'chat/message')
  assert.ok(message)
  assert.equal(message.messageId, 'am_1')
  assert.equal(message.text, '第一条')
  assert.equal(typeof message.seq, 'number')

  // A v2.1.0 client has no chat/message-v1 capability: it keeps the old delta
  // frames instead of silently losing the answer.
  const delta = await legacy.client.waitFor(f => f.t === 'chat/delta')
  assert.ok(delta, 'a legacy device must still receive the answer')
  assert.equal(delta.text, '第一条')
  assert.equal(delta.seq, 0)
  assert.equal(legacy.client.frames.some(f => f.t === 'chat/message'), false)

  gateway.pushEvent({
    kind: 'done',
    sessionId: 'conv-1',
    deviceId: newDevice.deviceId,
    callId: 'c1',
    text: '第一条',
  })
  assert.ok(await modern.client.waitFor(f => f.t === 'chat/done'))
  assert.ok(await legacy.client.waitFor(f => f.t === 'chat/done'))
  modern.client.close()
  legacy.client.close()
})

test('hello pushes a session snapshot without a cursor and a replay with one', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  // Seed the conversation log before anyone connects: a fresh client must get a
  // snapshot of what already happened, not an empty screen.
  gateway.pushEvent({
    kind: 'message', sessionId: 'conv-1', deviceId: 'dev_old', callId: 'c-old', messageId: 'am_old', index: 0, text: '旧消息',
  })
  gateway.pushEvent({ kind: 'done', sessionId: 'conv-1', deviceId: 'dev_old', callId: 'c-old', text: '旧消息' })
  // No user message yet, so seed one through a real send on a throwaway device.
  const seeder = freshDevice()
  const seed = await pairDevice(port, seeder, { capabilities: [CAPABILITIES.CHAT_ECHO] })
  seed.client.send({ t: 'chat/send', rid: 'r0', callId: 'c0', msgId: 'm0', text: '之前说的话' })
  assert.ok(await seed.client.waitFor(f => f.t === 'chat/ack'))
  seed.client.close()
  await delay(30)

  const fresh = freshDevice()
  const snapshotClient = await pairDevice(port, fresh, {
    capabilities: [CAPABILITIES.SESSION_SYNC],
    deviceName: '新设备',
  })
  const state = await snapshotClient.client.waitFor(f => f.t === 'session/state')
  assert.ok(state, 'a client without a cursor must receive session/state')
  assert.equal(state.sessionId, 'conv-1')
  assert.equal(typeof state.head, 'number')
  assert.equal(state.collaboration, false)
  assert.ok(Array.isArray(state.snapshot.messages))
  assert.ok(state.snapshot.messages.some(message => message.text === '之前说的话'))
  assert.equal(snapshotClient.client.frames.some(f => f.t === 'session/events'), false)
  const head = state.head
  snapshotClient.client.close()
  await delay(30)

  // Reconnecting with a cursor that is still in the log window gets the missed
  // events instead of a full snapshot.
  const returning = freshDevice()
  const catchUp = await pairDevice(port, returning, {
    capabilities: [CAPABILITIES.SESSION_SYNC],
    cursor: 0,
    deviceName: '回连设备',
  })
  const events = await catchUp.client.waitFor(f => f.t === 'session/events')
  assert.ok(events, 'a client with a usable cursor must receive session/events')
  assert.equal(events.sessionId, 'conv-1')
  assert.equal(events.from, 0)
  assert.ok(events.head >= head)
  assert.ok(events.events.length > 0)
  assert.deepEqual(events.events.map(event => event.seq), events.events.map(event => event.seq).slice().sort((a, b) => a - b))
  catchUp.client.close()
})

test('a late joiner sees the in-flight assistant turn in the snapshot', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  const first = freshDevice()
  const one = await pairDevice(port, first, { capabilities: [CAPABILITIES.SESSION_SYNC] })
  assert.ok(await one.client.waitFor(f => f.t === 'session/state'))

  // The assistant is mid-answer: the message exists but no done frame yet.
  gateway.pushEvent({
    kind: 'message', sessionId: 'conv-1', deviceId: first.deviceId, callId: 'c1', messageId: 'am_1', index: 0, text: '正在写…',
  })
  const second = freshDevice()
  const two = await pairDevice(port, second, { capabilities: [CAPABILITIES.SESSION_SYNC], deviceName: '后来者' })
  const state = await two.client.waitFor(f => f.t === 'session/state')
  assert.ok(state)
  assert.equal(state.snapshot.activeCall.callId, 'c1')
  assert.match(state.snapshot.activeCall.text, /正在写/)
  assert.equal(state.snapshot.activeCall.typing, true)
  one.client.close()
  two.client.close()
})

test('typing and tool activity reach every device in the conversation', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  const first = freshDevice()
  const second = freshDevice()
  const one = await pairDevice(port, first, { deviceName: '手机一' })
  const two = await pairDevice(port, second, { deviceName: '手机二' })

  gateway.pushEvent({ kind: 'typing', sessionId: 'conv-1', deviceId: first.deviceId, callId: 'c1', active: true })
  gateway.pushEvent({
    kind: 'tool', sessionId: 'conv-1', deviceId: first.deviceId, callId: 'c1',
    phase: 'tool-start', toolCallId: 't1', tool: 'read_file', summary: '正在读取文件',
  })
  assert.ok(await two.client.waitFor(f => f.t === 'chat/typing' && f.active === true), 'the peer must see the typing state')
  const tool = await two.client.waitFor(f => f.t === 'chat/tool')
  assert.ok(tool, 'the peer must see the activity row')
  assert.equal(tool.summary, '正在读取文件')
  one.client.close()
  two.client.close()
})

test('a hello whose sessionId disagrees with the computer gets a snapshot, never a replay', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  // Seed the log so a cursor replay would be possible if the session matched.
  gateway.pushEvent({
    kind: 'message', sessionId: 'conv-1', deviceId: 'dev_old', callId: 'c-old', messageId: 'am_old', index: 0, text: '旧消息',
  })
  gateway.pushEvent({ kind: 'done', sessionId: 'conv-1', deviceId: 'dev_old', callId: 'c-old', text: '旧消息' })

  const device = freshDevice()
  const { client } = await pairDevice(port, device, {
    capabilities: [CAPABILITIES.SESSION_SYNC],
    cursor: 0,
    sessionId: 'conv-that-no-longer-exists',
  })
  const state = await client.waitFor(f => f.t === 'session/state')
  assert.ok(state, 'a stale sessionId must yield a full snapshot')
  assert.equal(state.sessionId, 'conv-1')
  await delay(60)
  assert.equal(client.frames.some(f => f.t === 'session/events'), false, 'no cross-session replay is allowed')
  client.close()
})

test('session/sync asks for missed events on demand', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_SYNC] })
  assert.ok(await client.waitFor(f => f.t === 'session/state'))

  gateway.pushEvent({
    kind: 'message', sessionId: 'conv-1', deviceId: device.deviceId, callId: 'c1', messageId: 'am_1', index: 0, text: '新内容',
  })
  client.send({ t: 'session/sync', rid: 's1', cursor: 0 })
  const events = await client.waitFor(f => f.t === 'session/events' && f.sessionId === 'conv-1')
  assert.ok(events, 'session/sync must return the missed events')
  assert.ok(events.events.some(event => event.t === 'chat/message'))
  client.close()
})

test('joining and leaving are announced through session/participants', async t => {
  const { gateway, port } = await makeGateway({ sessionIdFor: () => 'conv-1' })
  t.after(() => gateway.close())
  const first = freshDevice()
  const one = await pairDevice(port, first, { capabilities: [CAPABILITIES.PARTICIPANTS] })
  const initial = await one.client.waitFor(f => f.t === 'session/participants')
  assert.ok(initial)
  assert.equal(initial.sessionId, 'conv-1')
  assert.equal(initial.participants.length, 1)
  assert.equal(initial.participants[0].online, true)

  const second = freshDevice()
  const two = await pairDevice(port, second, { capabilities: [CAPABILITIES.PARTICIPANTS], deviceName: '手机二' })
  const joined = await one.client.waitFor(f => f.t === 'session/participants' && f.participants.length === 2)
  assert.ok(joined, 'the existing device must see the new participant')
  assert.equal(joined.participants.every(p => p.online === true), true)

  two.client.close()
  const left = await one.client.waitFor(f => f.t === 'session/participants' && f.participants.some(p => p.online === false))
  assert.ok(left, 'a disconnect must mark the device offline')
  one.client.close()
})

test('collab/set switches the shared session, bumps the epoch and broadcasts state', async t => {
  const remapped = []
  const bridge = {
    send: async () => {},
    attachDevice: deviceId => remapped.push(deviceId),
    resetSessions: async () => { remapped.length = 0 },
  }
  const { gateway, store, port } = await makeGateway({
    bridge,
    // The conversation id follows the persisted preference, exactly like the
    // real plugin wiring in index.mjs.
    sessionIdFor: deviceId => (store.getPreference('collaboration', false) === true ? 'shared-conv' : `device-${deviceId}`),
  })
  t.after(() => gateway.close())
  const first = freshDevice()
  const one = await pairDevice(port, first, {
    capabilities: [CAPABILITIES.COLLAB, CAPABILITIES.SESSION_SYNC, CAPABILITIES.PARTICIPANTS],
  })
  assert.equal(one.ack.sessionId, `device-${first.deviceId}`)
  assert.equal(one.ack.collaboration, false)
  const epochBefore = one.ack.sessionEpoch

  one.client.send({ t: 'collab/set', rid: 'col1', on: true })

  const state = await one.client.waitFor(f => f.t === 'collab/state')
  assert.ok(state, 'the phone must be told the collaboration state changed')
  assert.equal(state.on, true)
  assert.equal(state.sessionId, 'shared-conv')
  assert.equal(state.sessionEpoch, epochBefore + 1)
  const snapshot = await one.client.waitFor(f => f.t === 'session/state' && f.sessionId === 'shared-conv')
  assert.ok(snapshot, 'a session switch must resend the snapshot')
  assert.equal(snapshot.sessionEpoch, epochBefore + 1)
  await delay(30)
  assert.deepEqual(remapped, [first.deviceId], 'the bridge mapping is rebuilt for every connected device')
  one.client.close()
})

test('the HTTP collaboration switch keeps working and broadcasts to the phones', async t => {
  const { gateway, port } = await makeGateway({
    sessionIdFor: deviceId => (gateway.store.getPreference('collaboration', false) === true ? 'shared-conv' : `device-${deviceId}`),
  })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.COLLAB] })

  const response = await fetch(`http://127.0.0.1:${port}/openwhale/collaboration?on=1`, { method: 'POST' })
  assert.equal(response.status, 200)
  const state = await client.waitFor(f => f.t === 'collab/state')
  assert.ok(state, 'the local page toggle must reach connected phones')
  assert.equal(state.on, true)
  assert.equal(state.sessionId, 'shared-conv')
  client.close()
})

test('state-changing HTTP routes refuse requests that did not originate on this machine', async t => {
  const { gateway, port, store } = await makeGateway()
  t.after(() => gateway.close())
  const base = `http://127.0.0.1:${port}`
  // A request proxied through the public tunnel arrives as loopback on the socket,
  // so the forwarding headers are what distinguish "this machine" from "internet".
  const remote = { headers: { 'x-forwarded-for': '203.0.113.9' } }

  const writes = [
    [`${base}/openwhale/collaboration?on=1`, { method: 'POST' }],
    [`${base}/openwhale/unbind`, { method: 'POST' }],
    [`${base}/openwhale/device-rename?deviceId=x&label=y`, { method: 'POST' }],
    [`${base}/openwhale/connection-mode?mode=lan`, { method: 'POST' }],
    [`${base}/openwhale/send-file`, { method: 'POST', body: '{"path":"x"}' }],
  ]
  for (const [url, init] of writes) {
    const response = await fetch(url, { ...init, ...remote })
    assert.equal(response.status, 403, `${url} must not be writable from a remote origin`)
  }
  assert.equal(store.getPreference('collaboration'), undefined, 'a remote request must not flip the switch')

  // Read-only routes stay reachable, which is what makes debugging from a phone possible.
  assert.equal((await fetch(`${base}/openwhale/health`, remote)).status, 200)
  assert.equal((await fetch(`${base}/openwhale/pairing.json`, remote)).status, 200)
  // But the QR image carries the single-use pairing secret: local only.
  assert.equal((await fetch(`${base}/openwhale/qr.png`, remote)).status, 403)

  // The same routes do work from this machine.
  const local = await fetch(`${base}/openwhale/connection-mode?mode=lan`, { method: 'POST' })
  assert.equal(local.status, 200)
  assert.equal((await local.json()).mode, 'lan')
})

test('connection-mode reports detected endpoint kinds and the QR follows it', async t => {
  const { gateway, store, port } = await makeGateway({
    lanUrls: ['http://192.168.1.9:8787', 'http://100.88.1.2:8787'],
    tunnelUrls: ['https://example.trycloudflare.com'],
  })
  t.after(() => gateway.close())

  const info = await (await fetch(`http://127.0.0.1:${port}/openwhale/connection-mode`)).json()
  assert.equal(info.ok, true)
  assert.equal(info.mode, 'auto')
  assert.deepEqual(info.modes, ['auto', 'lan', 'tailscale', 'tunnel'])
  // auto prefers Tailscale, then LAN, then the public tunnel (the whole 2.2.0 fix).
  assert.deepEqual(info.endpoints.map(endpoint => endpoint.kind), ['tailscale', 'lan', 'tunnel'])
  assert.deepEqual(info.detected.tailscale, ['http://100.88.1.2:8787'])
  assert.deepEqual(info.detected.lan, ['http://192.168.1.9:8787'])
  assert.deepEqual(info.detected.tunnel, ['https://example.trycloudflare.com'])

  const switched = await (await fetch(`http://127.0.0.1:${port}/openwhale/connection-mode?mode=tailscale`, { method: 'POST' })).json()
  assert.equal(switched.mode, 'tailscale')
  assert.equal(store.getPreference('connectionMode'), 'tailscale')
  assert.deepEqual(switched.endpoints.map(endpoint => endpoint.kind), ['tailscale'])

  // The QR payload is ordered by the chosen mode and carries compact kind codes
  // plus a web-client URL.
  const pairing = await (await fetch(`http://127.0.0.1:${port}/openwhale/pairing.json`)).json()
  assert.equal(pairing.ok, true)
  assert.deepEqual(pairing.payload.endpoints, ['http://100.88.1.2:8787'])
  assert.deepEqual(pairing.payload.epk, ['t'])
  assert.equal(pairing.payload.mode, 'tailscale')
  assert.equal(pairing.payload.web, 'http://100.88.1.2:8787/openwhale/app')
  assert.equal(pairing.payload.version, PLUGIN_VERSION)
})

test('hello/ack advertises capabilities, the conversation and classified endpoints', async t => {
  const { gateway, store, port } = await makeGateway({
    lanUrls: ['http://192.168.1.9:8787', 'http://100.88.1.2:8787'],
    tunnelUrls: ['https://example.trycloudflare.com'],
    sessionIdFor: () => 'conv-ack',
    collaboration: () => true,
  })
  t.after(() => gateway.close())
  store.setPreference('connectionMode', 'auto')
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device)

  assert.equal(ack.version, '1.1.0', 'version keeps meaning the wire-protocol version')
  assert.equal(ack.serverVersion, PLUGIN_VERSION)
  assert.ok(Array.isArray(ack.capabilities))
  assert.ok(ack.capabilities.includes(CAPABILITIES.CHAT_ECHO))
  assert.ok(ack.capabilities.includes(CAPABILITIES.UPLOAD))
  assert.equal(ack.sessionId, 'conv-ack')
  assert.equal(typeof ack.sessionEpoch, 'number')
  assert.equal(ack.eventCursor, 0)
  assert.equal(ack.collaboration, true)
  assert.equal(ack.connectionMode, 'auto')
  assert.deepEqual(ack.endpointList.map(endpoint => endpoint.kind), ['tailscale', 'lan', 'tunnel'])
  assert.equal(ack.endpointList[0].url, 'http://100.88.1.2:8787')
  client.close()
})

test('health and info expose version, collaboration, connection mode and kinds', async t => {
  const { gateway, store, port } = await makeGateway({
    lanUrls: ['http://192.168.1.9:8787'],
    tunnelUrls: ['https://example.trycloudflare.com'],
  })
  t.after(() => gateway.close())
  store.setPreference('collaboration', true)
  store.setPreference('connectionMode', 'lan')
  const health = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.equal(health.version, PLUGIN_VERSION)
  assert.equal(health.collaboration, true)
  assert.equal(health.connectionMode, 'lan')
  assert.deepEqual(health.endpoints, [{ url: 'http://192.168.1.9:8787', kind: 'lan' }])
  // Existing fields are untouched.
  assert.equal(health.ok, true)
  assert.equal(typeof health.connections, 'number')

  const info = await (await fetch(`http://127.0.0.1:${port}/openwhale/info`)).json()
  assert.equal(info.version, PLUGIN_VERSION)
  assert.equal(info.connectionMode, 'lan')
  assert.equal(Array.isArray(info.endpoints), true)
  assert.equal(typeof info.endpoints[0].kind, 'string')
})

test('the binding page carries the 2.2.0 features the user has to see', async t => {
  const { gateway, port } = await makeGateway({ lanUrls: ['http://192.168.1.9:8787'] })
  t.after(() => gateway.close())
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()
  assert.match(html, /Open Whale 2\.2\.\d/)
  assert.match(html, /连接方式/)
  assert.match(html, /Tailscale/)
  assert.match(html, /局域网/)
  assert.match(html, /公网隧道/)
  assert.match(html, /发送到手机/)
  assert.match(html, /openwhale\/app/, 'the page must offer the web client')
  assert.match(html, /192\.168\.1\.9:8787\/openwhale\/app/, 'the web client URL uses a phone-reachable endpoint')
})

test('a page opened through the tunnel is read-only and says so', async t => {
  const { gateway, port } = await makeGateway({ lanUrls: ['http://192.168.1.9:8787'] })
  t.after(() => gateway.close())
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).text()
  assert.match(html, /请在本机浏览器/, 'a remote page must explain why the controls are disabled')
  assert.equal(html.includes('id="send-file-btn"'), false, 'the remote page must not render the send-file control')
})

test('upload/start → chunk → end lands the file in the session workspace and chat/send can reference it', async t => {
  const uploadDir = mkdtempSync(join(tmpdir(), 'openwhale-gw-upload-'))
  t.after(() => rmSync(uploadDir, { recursive: true, force: true }))
  const { gateway, port, harness } = await makeGateway({ uploadDir })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, {
    capabilities: [CAPABILITIES.UPLOAD, CAPABILITIES.CHAT_ECHO],
  })

  const bytes = Buffer.from('图片字节'.repeat(500), 'utf8')
  client.send({ t: 'upload/start', uploadId: 'up_1', name: 'photo.jpg', size: bytes.length, mime: 'image/jpeg' })
  const ready = await client.waitFor(f => f.t === 'upload/ready')
  assert.ok(ready, 'expected upload/ready')
  assert.equal(ready.uploadId, 'up_1')
  assert.equal(ready.chunkBytes, UPLOAD_CHUNK_BYTES)
  assert.equal(ready.maxBytes, MAX_UPLOAD_BYTES)

  // Backpressure: the client waits for progress before the next chunk.
  client.send({ t: 'upload/chunk', uploadId: 'up_1', seq: 0, dataBase64: bytes.toString('base64') })
  const progress = await client.waitFor(f => f.t === 'upload/progress')
  assert.equal(progress.nextSeq, 1)
  assert.equal(progress.received, bytes.length)

  client.send({ t: 'upload/end', uploadId: 'up_1' })
  const done = await client.waitFor(f => f.t === 'upload/done')
  assert.ok(done, 'expected upload/done')
  assert.equal(done.name, 'photo.jpg')
  assert.equal(done.size, bytes.length)
  assert.equal(done.path.startsWith(uploadDir), true)
  assert.equal(done.path.endsWith('photo.jpg'), true)
  assert.equal(readFileSync(done.path).equals(bytes), true)

  // The chat message references the upload instead of inlining base64.
  client.send({
    t: 'chat/send',
    rid: 'r1',
    callId: 'c1',
    msgId: 'm1',
    text: '看看这张图',
    files: [{ uploadId: 'up_1' }],
  })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack' && f.msgId === 'm1'))
  const started = Date.now()
  while (harness.sent.length === 0 && Date.now() - started < 2000) await delay(10)
  assert.equal(harness.sent.length, 1)
  const attachment = harness.sent[0].attachments[0]
  assert.equal(attachment.path, done.path, 'the assistant receives the real on-disk path')
  assert.equal(attachment.fileId, done.fileId)
  const echo = await client.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm1')
  assert.equal(echo.files[0].fileId, done.fileId)
  client.close()
})

test('a legacy inline attachment gets a file card and can be fetched in chunks', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.CHAT_ECHO] })

  const bytes = Buffer.from('内联附件的内容', 'utf8')
  client.send({
    t: 'chat/send',
    rid: 'r1',
    callId: 'c1',
    msgId: 'm1',
    text: '看这个',
    files: [{ name: '备注.txt', mime: 'text/plain', dataBase64: bytes.toString('base64') }],
  })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack'))
  const echo = await client.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm1')
  assert.ok(echo, 'the echo must carry the attachment metadata')
  assert.equal(echo.files.length, 1)
  assert.equal(echo.files[0].name, '备注.txt')
  assert.equal(echo.files[0].size, bytes.length)
  assert.match(echo.files[0].fileId, /^f_/, 'a legacy attachment needs a fileId for the download card')
  await delay(30)
  assert.equal(harness.sent[0].attachments[0].path.endsWith('备注.txt'), true)

  // The phone can pull it back with the normal chunked file/fetch path.
  client.send({ t: 'file/fetch', rid: 'r2', fileId: echo.files[0].fileId })
  const meta = await client.waitFor(f => f.t === 'file/meta')
  assert.equal(meta.name, '备注.txt')
  assert.equal(meta.size, bytes.length)
  const end = await client.waitFor(f => f.t === 'file/end')
  assert.ok(end, 'expected file/end')
  const chunks = client.frames.filter(f => f.t === 'file/chunk')
  assert.equal(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.dataBase64, 'base64'))).equals(bytes), true)
  client.close()
})

test('an unknown uploadId reference is refused without waking the assistant', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.UPLOAD] })
  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '看这个', files: [{ uploadId: 'nope' }] })
  const error = await client.waitFor(f => f.t === 'error')
  assert.equal(error.code, 'upload-not-found')
  await delay(40)
  assert.equal(harness.sent.length, 0)
  client.close()
})

test('POST /openwhale/send-file offers a local file to every phone', async t => {
  const cwdDir = mkdtempSync(join(tmpdir(), 'openwhale-gw-cwd-'))
  const outside = mkdtempSync(join(tmpdir(), 'openwhale-gw-outside-'))
  t.after(() => rmSync(cwdDir, { recursive: true, force: true }))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const filePath = join(cwdDir, '报告.pdf')
  writeFileSync(filePath, 'PDF-BYTES')
  const outsidePath = join(outside, 'secret.txt')
  writeFileSync(outsidePath, 'top secret')

  const { gateway, port } = await makeGateway({ cwd: () => cwdDir })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.FILE_OFFER] })

  const refused = await fetch(`http://127.0.0.1:${port}/openwhale/send-file`, {
    method: 'POST',
    body: JSON.stringify({ path: outsidePath }),
  })
  assert.equal(refused.status, 400, 'a path outside the session workspace must be refused')

  const offered = await fetch(`http://127.0.0.1:${port}/openwhale/send-file`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath }),
  })
  assert.equal(offered.status, 200)
  const body = await offered.json()
  assert.equal(body.ok, true)
  assert.equal(body.name, '报告.pdf')
  assert.equal(body.size, 'PDF-BYTES'.length)
  assert.match(body.url, /^\/openwhale\/download\?token=/)
  assert.equal(body.mime, 'application/pdf')

  const card = await client.waitFor(f => f.t === 'file/offered')
  assert.ok(card, 'the phone must receive a file card')
  assert.equal(card.name, '报告.pdf')
  assert.equal(card.url, body.url)
  assert.equal(typeof card.seq, 'number')

  // The one-shot URL really serves the bytes.
  const download = await fetch(`http://127.0.0.1:${port}${body.url}`)
  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'PDF-BYTES')
  client.close()
})

test('the built-in web client is served under /openwhale/app from either layout', async t => {
  const webRoot = mkdtempSync(join(tmpdir(), 'openwhale-gw-web-'))
  const dir = join(webRoot, 'webchat')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Open Whale Web</title>')
  writeFileSync(join(dir, 'lib', 'chat.mjs'), 'export const ok = true')
  t.after(() => rmSync(webRoot, { recursive: true, force: true }))

  const { gateway, port } = await makeGateway({ webClientDir: dir })
  t.after(() => gateway.close())

  const index = await fetch(`http://127.0.0.1:${port}/openwhale/app`)
  assert.equal(index.status, 200)
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(index.headers.get('cache-control'), 'no-store')
  assert.match(await index.text(), /Open Whale Web/)

  const trailing = await fetch(`http://127.0.0.1:${port}/openwhale/app/`)
  assert.equal(trailing.status, 200, 'the trailing-slash form must serve index.html too')

  const asset = await fetch(`http://127.0.0.1:${port}/openwhale/app/lib/chat.mjs`)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')

  const missing = await fetch(`http://127.0.0.1:${port}/openwhale/app/nope.js`)
  assert.equal(missing.status, 404)
})



