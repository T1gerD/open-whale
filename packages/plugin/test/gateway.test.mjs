import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { Gateway, mergeSnapshotMessages, PLUGIN_VERSION, WS_PATH } from '../src/gateway.mjs'
import { renderPageHtml } from '../src/page.mjs'
import { StateStore } from '../src/state.mjs'

/** A bridge that records calls and lets tests inject events / canned answers. */
function makeBridge() {
  const sent = []
  const cancelled = []
  const renamed = []
  const powerCalls = []
  const answeredApprovals = []
  const answeredQuestions = []
  const releasedSessions = []
  // Mutable so a test can flip the power policy the same way the real plugin
  // reads it from the state store's preferences, and can steer the session API.
  const harness = {
    sent,
    cancelled,
    renamed,
    powerCalls,
    answeredApprovals,
    answeredQuestions,
    releasedSessions,
    /** Every sessionId the gateway asked the bridge to open. */
    selectedRequests: [],
    allowShutdown: true,
    /** How many DSH sessions the gateway asked the bridge to create. */
    createCount: 0,
    /** @type {{sessions: any[], truncated?: boolean}} */
    listResult: { sessions: [], truncated: false },
    /** @type {((sessionId: string) => any) | any} */
    selectResult: undefined,
    /** @type {any} */
    createResult: undefined,
    /** @type {(sessionId: string) => any[]} */
    history: () => [],
    answerResult: true,
    /** @type {(sessionId: string) => any[]} */
    pendingApprovals: () => [],
    /** Set by the test to inspect the last bridge.send input. */
    lastSend: undefined,
    /** @type {any} */
    bridge: null,
  }
  harness.bridge = {
    send: async input => {
      harness.lastSend = input
      sent.push(input)
    },
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
    // v2.3.0：手机端的会话列表 / 选择 / 新建、历史快照与审批作答。
    listSessions: async () => harness.listResult,
    selectSession: async sessionId => {
      harness.selectedRequests.push(sessionId)
      const result = typeof harness.selectResult === 'function' ? harness.selectResult(sessionId) : harness.selectResult
      return result ?? { ok: false, error: 'not-found', message: '找不到这个会话' }
    },
    createSession: async () => {
      harness.createCount += 1
      return harness.createResult ?? { ok: true, sessionId: `auto-session-${harness.createCount}` }
    },
    historyMessages: async sessionId => harness.history(sessionId),
    answerApproval: input => {
      answeredApprovals.push(input)
      return harness.answerResult
    },
    answerQuestion: input => {
      answeredQuestions.push(input)
      return harness.answerResult
    },
    /** 待答审批：重连/刷新后网关应重发。 */
    pendingApprovals: sessionId => harness.pendingApprovals(sessionId),
    releaseSession: async sessionId => { releasedSessions.push(sessionId) },
    onEvent: listener => {
      listener
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
  // 3.0.1：审批代理加固状态随 health 暴露；测试用的假桥没有这个可选 seam → null。
  assert.equal(body.approvalProxy, null)
})

test('health exposes the bridge approval-proxy status when the bridge provides it', async t => {
  const status = {
    enabled: true,
    selfCheck: 'passed',
    hostVersion: '0.2.2-rc.1',
    tested: true,
    reason: '已实测版本 0.2.2-rc.1，signal 代理可用',
  }
  const { gateway, port } = await makeGateway({ bridge: { approvalProxyStatus: () => status } })
  t.after(() => gateway.close())
  const body = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.deepEqual(body.approvalProxy, status)
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
  const entries = (html.match(/class="web-entry"/g) ?? []).length
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

test('the binding page is a three-step wizard with per-mode QR images', async t => {
  const { gateway, port } = await makeGateway({ lanUrls: ['http://192.168.1.9:8787'] })
  t.after(() => gateway.close())
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()
  // 第一步：两种绑定方式；第二步：三种连接方式；第三步：按线路生成二维码 img。
  assert.match(html, /data-bind="app"/)
  assert.match(html, /data-bind="web"/)
  assert.match(html, /data-mode="lan"/)
  assert.match(html, /data-mode="tailscale"/)
  assert.match(html, /data-mode="tunnel"/)
  assert.match(html, /qr\.png\?mode=lan/)
  // 只有局域网可用：其它线路按钮禁用。
  assert.match(html, /data-mode="tailscale"[^>]*disabled/)
  // 指定线路的二维码路由：有地址的返回 PNG，没有的明确拒绝。
  const lan = await fetch(`http://127.0.0.1:${port}/openwhale/qr.png?mode=lan`)
  assert.equal(lan.status, 200)
  assert.equal(lan.headers.get('content-type'), 'image/png')
  const tunnel = await fetch(`http://127.0.0.1:${port}/openwhale/qr.png?mode=tunnel`)
  assert.equal(tunnel.status, 409)
  const body = await tunnel.json()
  assert.equal(body.error, 'mode-unavailable')
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

test('device presence separates foreground from background and expires stale heartbeats', async t => {
  // 注入时钟：freshness 窗口（70s）可以一次性跳过，不用真的等。
  let now = 1_000_000
  const { gateway, port } = await makeGateway({ now: () => now })
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device)

  const waitPresence = async expected => {
    for (let i = 0; i < 200; i += 1) {
      if (gateway.devicePresence(device.deviceId) === expected) return true
      await delay(5)
    }
    return false
  }

  // 握手即视为前台（旧客户端不发 visible，协议规定按前台处理）。
  assert.equal(gateway.devicePresence(device.deviceId), 'foreground')
  assert.equal(gateway.deviceOnline(device.deviceId), true)

  // 显式后台：锁屏/切后台的新客户端会立刻补一帧 ping{visible:false}。
  client.send({ t: 'ping', visible: false })
  assert.ok(await client.waitFor(f => f.t === 'pong'))
  assert.ok(await waitPresence('background'))
  assert.equal(gateway.deviceOnline(device.deviceId), true, '后台设备仍然在线')
  assert.deepEqual(
    gateway.devicesInSession(ack.sessionId),
    [device.deviceId],
    '前后台只影响展示，不改变审批/提问的转发资格',
  )

  // 回到前台：visible:true 的心跳立即恢复。
  client.send({ t: 'ping', visible: true })
  assert.ok(await waitPresence('foreground'))

  // 心跳过期（浏览器冻结/丢包）：没有任何新帧，只靠时间也应降级为后台。
  now += 71_000
  assert.equal(gateway.devicePresence(device.deviceId), 'background', '超过 freshness 窗口的可见心跳视为后台')

  // 旧客户端不带 visible：按前台处理，但仍必须靠心跳续期。
  client.send({ t: 'ping' })
  assert.ok(await waitPresence('foreground'))

  // health：在线设备数（connections）语义不变，另给出前台/后台细分。
  client.send({ t: 'ping', visible: false })
  assert.ok(await waitPresence('background'))
  const health = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.equal(health.onlineDevices, 1)
  assert.equal(health.foregroundDevices, 0)
  assert.equal(health.backgroundDevices, 1)
  assert.equal(health.connections, 1, 'connections 仍是「在线设备数」')
  assert.equal(health.sessions, 1)

  // 同一设备两条 socket（竞速/多窗口）：任意一条前台就算前台；关掉后按剩下的
  // 那条正确退回，不能把「还有一条后台 socket」当成离线。
  const second = await reconnectSession(port, device)
  client.send({ t: 'ping', visible: false })
  second.send({ t: 'ping', visible: true })
  assert.ok(await waitPresence('foreground'), '任意一条 socket 前台即算前台')
  second.send({ t: 'ping', visible: false })
  assert.ok(await waitPresence('background'))
  second.close()
  await delay(80)
  assert.ok(await waitPresence('background'), '一条 socket 关闭后按剩下那条的状态')

  client.close()
  await delay(80)
  assert.equal(gateway.deviceOnline(device.deviceId), false)
  // 2026-11-10：移动浏览器切后台会直接杀掉 WebSocket。后台断开后保留一段
  // 「在线（后台）」宽限期，否则用户会看到“切后台 → 离线”而以为手机断开了。
  assert.equal(gateway.devicePresence(device.deviceId), 'background', '后台断开后在宽限期内仍算在线（后台）')
  const healthClosed = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.equal(healthClosed.onlineDevices, 1, '宽限期内的后台设备仍计入在线设备')
  assert.equal(healthClosed.foregroundDevices, 0)
  assert.equal(healthClosed.backgroundDevices, 1)
  assert.equal(healthClosed.connections, 0, 'connections 仍只统计真实 socket')
  // 超过宽限期才真正离线。
  now += 10 * 60_000 + 1
  assert.equal(gateway.devicePresence(device.deviceId), 'offline')
  const healthExpired = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.equal(healthExpired.onlineDevices, 0)
  assert.equal(healthExpired.backgroundDevices, 0)
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
  const sessionId = gateway.deviceSession.get(device.deviceId)

  gateway.pushEvent({ kind: 'typing', sessionId, deviceId: device.deviceId, callId: 'c9', active: true })
  gateway.pushEvent({ kind: 'delta', sessionId, deviceId: device.deviceId, callId: 'c9', seq: 0, text: '你好' })
  gateway.pushEvent({ kind: 'delta', sessionId, deviceId: device.deviceId, callId: 'c9', seq: 1, text: '，' })
  gateway.pushEvent({ kind: 'tool', sessionId, deviceId: device.deviceId, callId: 'c9', phase: 'tool-start', toolCallId: 't1', tool: 'read_image', summary: '读取图片' })
  gateway.pushEvent({ kind: 'done', sessionId, deviceId: device.deviceId, callId: 'c9', text: '你好，我在。' })

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
  gateway.pushEvent({
    kind: 'done',
    sessionId: gateway.deviceSession.get(device.deviceId),
    deviceId: device.deviceId,
    callId: 'c1',
    text: 'x'.repeat(30_000),
  })
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

  const conversationId = first.ack.sessionId
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
// v2.2.0 idempotency + 会话同步，v2.3.0 每设备会话绑定 / 会话选择 / 审批转发
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

/** Reconnect an already-bound device (key proof, no QR). */
async function reconnectWith(port, device, options = {}) {
  const client = await connectClient(port)
  const nonce = `reconnect-${randomUUID()}`
  client.send({
    t: 'hello',
    version: '1.0.0',
    deviceId: device.deviceId,
    deviceName: options.deviceName ?? '我的手机',
    devicePublicKey: device.publicKeyB64,
    nonce,
    signature: sign(null, Buffer.from(helloSignatureMessage(nonce)), device.privateKey).toString('base64url'),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  })
  const ack = await client.waitFor(f => f.t === 'hello/ack')
  assert.ok(ack, 'a reconnect with a valid device key must be accepted')
  assert.equal(ack.pairAccepted, false, 'a reconnect is not a new pairing')
  return { client, ack }
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
    createSession: async () => ({ ok: true, sessionId: 'conv-inflight' }),
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
    createSession: async () => ({ ok: true, sessionId: 'conv-failed' }),
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

test('chat/echo reaches the device other sockets and carries no speaker nickname', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const caps = [CAPABILITIES.CHAT_ECHO]
  const one = await pairDevice(port, device, { capabilities: caps })
  const two = await reconnectWith(port, device, { capabilities: caps })

  one.client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '大家好' })
  const echoed = await one.client.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm1')
  assert.ok(echoed, 'the sender receives its own echo for dedupe')
  assert.equal(echoed.deviceId, device.deviceId)
  assert.equal(echoed.text, '大家好')
  assert.equal(typeof echoed.seq, 'number')
  // 协作已删除：对话里不再有「谁在说话」的前缀/昵称。
  assert.equal(echoed.speaker, undefined, 'no in-conversation nickname any more')
  assert.equal(harness.lastSend.speaker, undefined, 'the bridge is not told a speaker either')
  assert.ok(await two.client.waitFor(f => f.t === 'chat/echo' && f.msgId === 'm1'), 'the other socket of the device sees it')
  one.client.close()
  two.client.close()
})

test('assistant frames reach every socket of the owning device, with a legacy fallback', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const modern = await pairDevice(port, device, {
    capabilities: [CAPABILITIES.CHAT_MESSAGE, CAPABILITIES.CHAT_ECHO],
  })
  const sessionId = modern.ack.sessionId
  const legacy = await reconnectWith(port, device, { deviceName: '老手机' })

  gateway.pushEvent({
    kind: 'message',
    sessionId,
    deviceId: device.deviceId,
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
  assert.ok(delta, 'a legacy socket must still receive the answer')
  assert.equal(delta.text, '第一条')
  assert.equal(delta.seq, 0)
  assert.equal(legacy.client.frames.some(f => f.t === 'chat/message'), false)

  gateway.pushEvent({ kind: 'done', sessionId, deviceId: device.deviceId, callId: 'c1', text: '第一条' })
  assert.ok(await modern.client.waitFor(f => f.t === 'chat/done'))
  assert.ok(await legacy.client.waitFor(f => f.t === 'chat/done'))
  modern.client.close()
  legacy.client.close()
})

test('a fresh client gets a session snapshot and a returning one gets a replay', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const sync = [CAPABILITIES.SESSION_SYNC, CAPABILITIES.CHAT_ECHO]
  const first = await pairDevice(port, device, { capabilities: sync })
  const sessionId = first.ack.sessionId
  const state = await first.client.waitFor(f => f.t === 'session/state')
  assert.ok(state, 'a client without a cursor must receive session/state')
  assert.equal(state.sessionId, sessionId)
  assert.equal(typeof state.head, 'number')
  assert.equal('collaboration' in state, false, 'collaboration is gone from session/state')
  assert.ok(Array.isArray(state.snapshot.messages))

  first.client.send({ t: 'chat/send', rid: 'r0', callId: 'c0', msgId: 'm0', text: '之前说的话' })
  assert.ok(await first.client.waitFor(f => f.t === 'chat/ack'))
  gateway.pushEvent({
    kind: 'message', sessionId, deviceId: device.deviceId, callId: 'c0', messageId: 'am_0', index: 0, text: '回答',
  })
  gateway.pushEvent({ kind: 'done', sessionId, deviceId: device.deviceId, callId: 'c0', text: '回答' })
  const head = gateway.eventLogs.get(sessionId).head
  assert.ok(head >= 2)
  first.client.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  // Reconnecting with a cursor that is still in the log window gets the missed
  // events instead of a full snapshot.
  const catchUp = await reconnectWith(port, device, { capabilities: sync, cursor: 0 })
  const events = await catchUp.client.waitFor(f => f.t === 'session/events')
  assert.ok(events, 'a client with a usable cursor must receive session/events')
  assert.equal(events.sessionId, sessionId)
  assert.equal(events.from, 0)
  assert.ok(events.head >= head)
  assert.ok(events.events.length > 0)
  assert.deepEqual(
    events.events.map(event => event.seq),
    events.events.map(event => event.seq).slice().sort((a, b) => a - b),
  )
  catchUp.client.close()
})

test('session/state is built from the DSH session log, not just this process', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const at = new Date('2026-10-01T08:00:00.000Z').toISOString()
  harness.history = () => [
    { id: 'hist_1', kind: 'user', text: '几天前的问题', at },
    { id: 'hist_2', kind: 'assistant', text: '几天前的回答', at },
  ]
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_SYNC] })
  const state = await client.waitFor(f => f.t === 'session/state')
  assert.ok(state)
  assert.deepEqual(state.snapshot.messages.map(message => message.text), ['几天前的问题', '几天前的回答'])
  assert.deepEqual(state.snapshot.messages.map(message => message.kind), ['user', 'assistant'])
  client.close()
})

test('a history read failure falls back to the in-process log instead of throwing', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  harness.history = () => { throw new Error('sessionQuery 挂了') }
  const device = freshDevice()
  const first = await pairDevice(port, device, { capabilities: [CAPABILITIES.CHAT_ECHO] })
  first.client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '进程内的消息' })
  assert.ok(await first.client.waitFor(f => f.t === 'chat/ack'))
  first.client.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  const second = await reconnectWith(port, device, { capabilities: [CAPABILITIES.SESSION_SYNC] })
  const state = await second.client.waitFor(f => f.t === 'session/state')
  assert.ok(state, 'the snapshot must still be sent when history cannot be read')
  assert.ok(state.snapshot.messages.some(message => message.text === '进程内的消息'))
  second.client.close()
})

test('a late joiner sees the in-flight assistant turn in the snapshot', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const sync = [CAPABILITIES.SESSION_SYNC]
  const one = await pairDevice(port, device, { capabilities: sync })
  const sessionId = one.ack.sessionId
  assert.ok(await one.client.waitFor(f => f.t === 'session/state'))

  // The assistant is mid-answer: the message exists but no done frame yet.
  gateway.pushEvent({
    kind: 'message', sessionId, deviceId: device.deviceId, callId: 'c1', messageId: 'am_1', index: 0, text: '正在写…',
  })
  const two = await reconnectWith(port, device, { capabilities: sync, deviceName: '后来者' })
  const state = await two.client.waitFor(f => f.t === 'session/state')
  assert.ok(state)
  assert.equal(state.snapshot.activeCall.callId, 'c1')
  assert.match(state.snapshot.activeCall.text, /正在写/)
  assert.equal(state.snapshot.activeCall.typing, true)
  one.client.close()
  two.client.close()
})

test('a late joiner sees an in-flight turn that has only typing/tools (no text yet)', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const sync = [CAPABILITIES.SESSION_SYNC]
  const one = await pairDevice(port, device, { capabilities: sync })
  const sessionId = one.ack.sessionId
  assert.ok(await one.client.waitFor(f => f.t === 'session/state'))

  // 桌面回合刚开始、还在跑工具：只有 typing/tool，没有任何 assistant 正文。
  gateway.pushEvent({ kind: 'typing', sessionId, deviceId: '', callId: 'desk_1', active: true })
  gateway.pushEvent({ kind: 'tool', sessionId, deviceId: '', callId: 'desk_1', phase: 'tool-start', toolCallId: 't1', tool: 'ops_bash', summary: '跑命令' })
  const two = await reconnectWith(port, device, { capabilities: sync, deviceName: '后来者2' })
  const state = await two.client.waitFor(f => f.t === 'session/state')
  assert.ok(state)
  assert.equal(state.snapshot.activeCall?.callId, 'desk_1', '只有 typing/tool 的回合也必须出现在快照里')
  assert.equal(state.snapshot.activeCall.typing, true)
  one.client.close()
  two.client.close()
})

test('typing and tool activity reach every socket of the device', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const one = await pairDevice(port, device, { deviceName: '手机一' })
  const sessionId = one.ack.sessionId
  const two = await reconnectWith(port, device, { deviceName: '手机一（第二个窗口）' })

  gateway.pushEvent({ kind: 'typing', sessionId, deviceId: device.deviceId, callId: 'c1', active: true })
  gateway.pushEvent({
    kind: 'tool', sessionId, deviceId: device.deviceId, callId: 'c1',
    phase: 'tool-start', toolCallId: 't1', tool: 'read_file', summary: '正在读取文件',
  })
  assert.ok(await two.client.waitFor(f => f.t === 'chat/typing' && f.active === true), 'the peer socket must see the typing state')
  const tool = await two.client.waitFor(f => f.t === 'chat/tool')
  assert.ok(tool, 'the peer socket must see the activity row')
  assert.equal(tool.summary, '正在读取文件')
  one.client.close()
  two.client.close()
})

test('a hello whose sessionId disagrees with the computer gets a snapshot, never a replay', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const sync = [CAPABILITIES.SESSION_SYNC, CAPABILITIES.CHAT_ECHO]
  const one = await pairDevice(port, device, { capabilities: sync })
  const sessionId = one.ack.sessionId
  gateway.pushEvent({
    kind: 'message', sessionId, deviceId: device.deviceId, callId: 'c-old', messageId: 'am_old', index: 0, text: '旧消息',
  })
  gateway.pushEvent({ kind: 'done', sessionId, deviceId: device.deviceId, callId: 'c-old', text: '旧消息' })
  one.client.close()
  await new Promise(resolve => setTimeout(resolve, 40))

  const stale = await reconnectWith(port, device, {
    capabilities: sync,
    cursor: 0,
    sessionId: 'conv-that-no-longer-exists',
  })
  const state = await stale.client.waitFor(f => f.t === 'session/state')
  assert.ok(state, 'a stale sessionId must yield a full snapshot')
  assert.equal(state.sessionId, sessionId)
  await delay(60)
  assert.equal(stale.client.frames.some(f => f.t === 'session/events'), false, 'no cross-session replay is allowed')
  stale.client.close()
})

test('session/sync asks for missed events on demand', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_SYNC] })
  assert.ok(await client.waitFor(f => f.t === 'session/state'))

  gateway.pushEvent({
    kind: 'message', sessionId: ack.sessionId, deviceId: device.deviceId, callId: 'c1', messageId: 'am_1', index: 0, text: '新内容',
  })
  client.send({ t: 'session/sync', rid: 's1', cursor: 0 })
  const events = await client.waitFor(f => f.t === 'session/events' && f.sessionId === ack.sessionId)
  assert.ok(events, 'session/sync must return the missed events')
  assert.ok(events.events.some(event => event.t === 'chat/message'))
  client.close()
})

// --- v2.3.0：会话列表 / 选择 / 新建 ----------------------------------------

test('a new device is bound to a freshly created DSH session at hello', async t => {
  const { gateway, port, store, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { ack } = await pairDevice(port, device)
  assert.equal(harness.createCount, 1, 'the default experience is still "one new conversation per phone"')
  assert.equal(ack.sessionId, 'auto-session-1')
  assert.equal(gateway.deviceSession.get(device.deviceId), 'auto-session-1')
  assert.deepEqual(store.getPreference('deviceSession'), { [device.deviceId]: 'auto-session-1' },
    'the binding survives a plugin restart')

  // A reconnect must NOT create another conversation (that would silently move
  // the phone into an empty chat).
  const again = await reconnectWith(port, device)
  assert.equal(again.ack.sessionId, 'auto-session-1')
  assert.equal(harness.createCount, 1)
  again.client.close()
})

test('session/list returns the picker list, the current session and truncation', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSIONS] })
  harness.listResult = {
    sessions: [
      { id: 's-old', title: '旧会话', createdAt: 1, live: false },
      { id: ack.sessionId, title: '当前会话', createdAt: 2, live: true },
    ],
    truncated: true,
  }

  client.send({ t: 'session/list', rid: 'l1' })
  const frame = await client.waitFor(f => f.t === 'sessions')
  assert.ok(frame)
  assert.equal(frame.rid, 'l1')
  assert.equal(frame.current, ack.sessionId)
  assert.equal(frame.truncated, true)
  assert.deepEqual(frame.sessions.map(session => session.id), ['s-old', ack.sessionId])
  assert.equal(frame.sessions.find(session => session.id === ack.sessionId)?.current, true)
  assert.equal(frame.sessions.find(session => session.id === 's-old')?.current, undefined)
  client.close()
})

test('session/select binds the device to an existing session and pushes its snapshot', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSIONS, CAPABILITIES.SESSION_SYNC] })
  assert.ok(await client.waitFor(f => f.t === 'session/state'))
  const epochBefore = ack.sessionEpoch
  harness.history = () => [{ id: 'hist_1', kind: 'user', text: '这个会话的历史', at: new Date().toISOString() }]
  harness.selectResult = { ok: true, sessionId: 's-old', title: '旧会话' }

  client.send({ t: 'session/select', rid: 'r1', sessionId: 's-old' })
  const selected = await client.waitFor(f => f.t === 'session/selected')
  assert.ok(selected)
  assert.equal(selected.rid, 'r1')
  assert.equal(selected.ok, true)
  assert.equal(selected.sessionId, 's-old')
  assert.equal(selected.title, '旧会话')
  assert.equal(selected.sessionEpoch, epochBefore + 1, 'every switch bumps the epoch')
  assert.deepEqual(harness.selectedRequests, ['s-old'])

  const state = await client.waitFor(f => f.t === 'session/state' && f.sessionId === 's-old')
  assert.ok(state, 'a successful switch must be followed by the new snapshot')
  assert.equal(state.sessionEpoch, epochBefore + 1)
  assert.ok(state.snapshot.messages.some(message => message.text === '这个会话的历史'))
  assert.equal(gateway.deviceSession.get(device.deviceId), 's-old')
  client.close()
})

test('session/select reports a missing session and keeps the old binding', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSIONS, CAPABILITIES.SESSION_SYNC] })
  harness.selectResult = { ok: false, error: 'not-found', message: '电脑上找不到这个会话' }

  client.send({ t: 'session/select', rid: 'r1', sessionId: 'missing' })
  const selected = await client.waitFor(f => f.t === 'session/selected')
  assert.ok(selected)
  assert.equal(selected.ok, false)
  assert.equal(selected.error, 'not-found')
  assert.equal(selected.sessionEpoch, undefined)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(client.frames.some(f => f.t === 'session/state' && f.sessionId === 'missing'), false)
  assert.equal(gateway.deviceSession.get(device.deviceId), ack.sessionId, 'the binding must not move on failure')
  client.close()
})

test('session/create makes a new conversation and moves the device into it', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const first = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSIONS] })
  const epochBefore = first.ack.sessionEpoch
  harness.createResult = { ok: true, sessionId: 'fresh-session' }

  first.client.send({ t: 'session/create', rid: 'c1' })
  const selected = await first.client.waitFor(f => f.t === 'session/selected')
  assert.ok(selected)
  assert.equal(selected.ok, true)
  assert.equal(selected.sessionId, 'fresh-session')
  assert.equal(selected.sessionEpoch, epochBefore + 1)
  const state = await first.client.waitFor(f => f.t === 'session/state' && f.sessionId === 'fresh-session')
  assert.ok(state, 'a newly created session also gets its snapshot')
  assert.equal(gateway.deviceSession.get(device.deviceId), 'fresh-session')
  first.client.close()
})

test('a session frame from a client without sessions-v1 is ignored', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device)
  client.send({ t: 'session/list', rid: 'l1' })
  client.send({ t: 'session/create', rid: 'c1' })
  await delay(60)
  assert.equal(client.frames.some(f => f.t === 'sessions' || f.t === 'session/selected'), false)
  assert.equal(harness.createCount, 1, 'only the hello default, never the ignored frame')
  client.close()
})

// --- v2.3.0：审批转发（网关侧） --------------------------------------------

test('an approval request is forwarded to the bound device and its answer reaches the bridge', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.APPROVAL] })
  gateway.pushEvent({
    kind: 'approval-ask',
    sessionId: ack.sessionId,
    approvalId: 'ap_1',
    toolName: 'bash',
    reason: '需要执行命令',
    displayReason: { en: 'Run a command?', zh: '要执行命令吗？' },
    callId: 'c1',
  })
  const ask = await client.waitFor(f => f.t === 'approval/ask')
  assert.ok(ask, 'the phone must receive the pending approval')
  assert.equal(ask.approvalId, 'ap_1')
  assert.equal(ask.toolName, 'bash')
  assert.equal(ask.reason, '需要执行命令')
  assert.deepEqual(ask.displayReason, { en: 'Run a command?', zh: '要执行命令吗？' })
  assert.equal(ask.callId, 'c1')
  assert.equal('expiresAt' in ask, false, 'the card relies on the 60s handoff, not an expiry')

  client.send({ t: 'approval/reply', approvalId: 'ap_1', outcome: 'allowed-once' })
  await delay(30)
  assert.deepEqual(harness.answeredApprovals, [
    { approvalId: 'ap_1', deviceId: device.deviceId, outcome: 'allowed-once' },
  ])

  gateway.pushEvent({
    kind: 'approval-resolved', sessionId: ack.sessionId, approvalId: 'ap_1', outcome: 'allowed-once', source: 'phone',
  })
  const resolved = await client.waitFor(f => f.t === 'approval/resolved')
  assert.ok(resolved, 'the card must be dismissible')
  assert.equal(resolved.approvalId, 'ap_1')
  assert.equal(resolved.outcome, 'allowed-once')
  assert.equal(resolved.source, 'phone')
  client.close()
})

test('an outgoing approval lands on a phone that is bound to that session only', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const owner = freshDevice()
  const stranger = freshDevice()
  const one = await pairDevice(port, owner, { capabilities: [CAPABILITIES.APPROVAL] })
  const two = await pairDevice(port, stranger, { capabilities: [CAPABILITIES.APPROVAL], deviceName: '手机二' })
  assert.notEqual(one.ack.sessionId, two.ack.sessionId, 'each phone starts in its own session')

  gateway.pushEvent({
    kind: 'approval-ask', sessionId: one.ack.sessionId, approvalId: 'ap_2', toolName: 'write', expiresAt: Date.now() + 1000,
  })
  assert.ok(await one.client.waitFor(f => f.t === 'approval/ask' && f.approvalId === 'ap_2'))
  await delay(60)
  assert.equal(two.client.frames.some(f => f.t === 'approval/ask'), false, 'another session must never be asked')
  one.client.close()
  two.client.close()
})

test('a phone without approval-v1 is never asked', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.CHAT_ECHO] })
  gateway.pushEvent({
    kind: 'approval-ask', sessionId: ack.sessionId, approvalId: 'ap_3', toolName: 'bash', expiresAt: Date.now() + 1000,
  })
  await delay(60)
  assert.equal(client.frames.some(f => f.t === 'approval/ask'), false)
  client.close()
})

test('an approval reply with an unknown outcome is normalised to rejected', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.APPROVAL] })
  client.send({ t: 'approval/reply', approvalId: 'ap_4', outcome: 'always-allow-everything' })
  await delay(30)
  assert.equal(harness.answeredApprovals.length, 1)
  assert.equal(harness.answeredApprovals[0].outcome, 'rejected')
  client.close()
})

test('mergeSnapshotMessages keeps unsent increments and drops the overlap', () => {
  const history = [
    { id: 'hist_1', kind: 'user', text: '重复' },
    { id: 'hist_2', kind: 'assistant', text: '回答' },
  ]
  const incremental = [
    { id: 'usr_1', kind: 'user', text: '重复' },
    { id: 'msg_1', kind: 'assistant', text: '回答' },
    { id: 'usr_2', kind: 'user', text: '刚发出还没提交' },
  ]
  const merged = mergeSnapshotMessages(history, incremental, 60)
  assert.deepEqual(merged.map(message => message.text), ['重复', '回答', '刚发出还没提交'])
  assert.deepEqual(mergeSnapshotMessages([], incremental, 60), incremental)
  // A limit keeps the newest messages only.
  assert.deepEqual(mergeSnapshotMessages(history, incremental, 1).map(message => message.text), ['刚发出还没提交'])
})

test('state-changing HTTP routes refuse requests that did not originate on this machine', async t => {
  const { gateway, port, store } = await makeGateway()
  t.after(() => gateway.close())
  const base = `http://127.0.0.1:${port}`
  // A request proxied through the public tunnel arrives as loopback on the socket,
  // so the forwarding headers are what distinguish "this machine" from "internet".
  const remote = { headers: { 'x-forwarded-for': '203.0.113.9' } }

  const writes = [
    [`${base}/openwhale/unbind`, { method: 'POST' }],
    [`${base}/openwhale/device-rename?deviceId=x&label=y`, { method: 'POST' }],
    [`${base}/openwhale/connection-mode?mode=lan`, { method: 'POST' }],
    [`${base}/openwhale/send-file`, { method: 'POST', body: '{"path":"x"}' }],
  ]
  for (const [url, init] of writes) {
    const response = await fetch(url, { ...init, ...remote })
    assert.equal(response.status, 403, `${url} must not be writable from a remote origin`)
  }
  assert.equal(store.getPreference('connectionMode'), undefined, 'a remote request must not change the mode')

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

test('the collaboration switch and its route no longer exist', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const response = await fetch(`http://127.0.0.1:${port}/openwhale/collaboration`, { method: 'POST' })
  assert.equal(response.status, 404, 'v2.3.0 removed collaboration entirely')
  const device = freshDevice()
  const { client } = await pairDevice(port, device)
  client.send({ t: 'collab/set', on: true })
  await delay(60)
  assert.equal(client.frames.some(f => f.t === 'collab/state'), false)
  assert.equal(client.frames.some(f => f.t === 'error'), false, 'an old frame is silently ignored')
  client.close()
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
  })
  t.after(() => gateway.close())
  store.setPreference('connectionMode', 'auto')
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device)

  assert.equal(ack.version, '3.0.0', 'version keeps meaning the wire-protocol version')
  assert.equal(ack.serverVersion, PLUGIN_VERSION)
  assert.ok(Array.isArray(ack.capabilities))
  assert.ok(ack.capabilities.includes(CAPABILITIES.CHAT_ECHO))
  assert.ok(ack.capabilities.includes(CAPABILITIES.UPLOAD))
  assert.ok(ack.capabilities.includes(CAPABILITIES.SESSIONS), 'v2.3.0 advertises the session picker')
  assert.ok(ack.capabilities.includes(CAPABILITIES.APPROVAL), 'v2.3.0 advertises phone approvals')
  assert.equal(ack.sessionId, 'auto-session-1', 'a new device is bound to a freshly created conversation')
  assert.equal(typeof ack.sessionEpoch, 'number')
  assert.equal(ack.eventCursor, 0)
  assert.equal(ack.collaboration, undefined, 'collaboration is gone in v2.3.0')
  assert.equal(ack.connectionMode, 'auto')
  assert.deepEqual(ack.endpointList.map(endpoint => endpoint.kind), ['tailscale', 'lan', 'tunnel'])
  assert.equal(ack.endpointList[0].url, 'http://100.88.1.2:8787')
  client.close()
})

test('health and info expose version, connection mode and kinds', async t => {
  const { gateway, store, port } = await makeGateway({
    lanUrls: ['http://192.168.1.9:8787'],
    tunnelUrls: ['https://example.trycloudflare.com'],
  })
  t.after(() => gateway.close())
  store.setPreference('connectionMode', 'lan')
  const health = await (await fetch(`http://127.0.0.1:${port}/openwhale/health`)).json()
  assert.equal(health.version, PLUGIN_VERSION)
  assert.equal(health.collaboration, undefined, 'v2.3.0 removed collaboration from the health payload')
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

test('the binding page carries the v2.3.0 features the user has to see', async t => {
  const { gateway, port } = await makeGateway({ lanUrls: ['http://192.168.1.9:8787'] })
  t.after(() => gateway.close())
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()
  assert.match(html, /Open Whale 3\.0\.\d/)
  assert.match(html, /连接方式/)
  assert.match(html, /Tailscale/)
  assert.match(html, /局域网/)
  assert.match(html, /公网隧道/)
  assert.match(html, /发送到手机/)
  assert.match(html, /openwhale\/app/, 'the page must offer the web client')
  assert.match(html, /192\.168\.1\.9:8787\/openwhale\/app/, 'the web client URL uses a phone-reachable endpoint')
})

test('连接方式选成「只走 Tailscale」时，局域网按钮不能被一起禁掉', async t => {
  // 报过的真机问题：默认方式切成 tailscale 后，页面上「局域网」「公网隧道」
  // 都变成「（当前不可用）」并禁用 —— 因为可选线路是用**已过滤**的地址列表算的。
  // 用户于是再也切不回局域网，只能看着一个能用的地址被锁掉。
  const { gateway, store, port } = await makeGateway({
    lanUrls: ['http://192.168.1.9:8787'],
    tunnelUrls: ['https://example.trycloudflare.com'],
  })
  t.after(() => gateway.close())
  store.setPreference('connectionMode', 'tailscale')
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()
  const button = kind => html.match(new RegExp(`<button class="choice" data-mode="${kind}"[^>]*>`))?.[0] ?? ''
  assert.ok(button('lan'), '局域网按钮必须存在')
  assert.equal(button('lan').includes('disabled'), false, '局域网有地址就不该禁用')
  assert.equal(button('tunnel').includes('disabled'), false, '隧道有地址就不该禁用')
  assert.equal(html.includes('局域网（当前不可用）'), false)
  // 地址列表确实被 mode 过滤了，页面要把这件事说清楚。
  assert.match(html, /已按「只走 Tailscale（独立于局域网）」过滤/)
})

test('线路确实没有地址时，按钮要写明原因而不是只说不可用', async t => {
  const { gateway, port } = await makeGateway({ lanUrls: ['http://192.168.1.9:8787'] })
  t.after(() => gateway.close())
  const html = await (await fetch(`http://127.0.0.1:${port}/openwhale`)).text()
  assert.match(html, /公网隧道（当前不可用）/)
  assert.match(html, /没有隧道地址：电脑端未开启隧道，或没装 cloudflared/)
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
  await new Promise(resolve => setTimeout(resolve, 40))
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




// ---------------------------------------------------------------------------
// v1.3.0 / 2.4.0: session tabs — several conversations stay live at once
// ---------------------------------------------------------------------------

test('every conversation frame names the session it belongs to', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_TABS] })
  const sessionId = gateway.deviceSession.get(device.deviceId)

  gateway.pushEvent({ kind: 'typing', sessionId, deviceId: device.deviceId, callId: 'c1', active: true })
  gateway.pushEvent({ kind: 'done', sessionId, deviceId: device.deviceId, callId: 'c1', text: '好' })

  const typing = await client.waitFor(f => f.t === 'chat/typing')
  assert.equal(typing.sessionId, sessionId, 'a client with several tabs needs the routing key')
  const done = await client.waitFor(f => f.t === 'chat/done')
  assert.equal(done.sessionId, sessionId)
  client.close()
})

test('a watched tab keeps receiving events without becoming the active conversation', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_TABS] })
  const active = gateway.deviceSession.get(device.deviceId)

  client.send({ t: 'session/watch', sessionIds: ['tab-b'] })
  await delay(30)
  assert.equal(gateway.deviceSession.get(device.deviceId), active, 'watching must not move the binding')

  gateway.pushEvent({ kind: 'delta', sessionId: 'tab-b', deviceId: device.deviceId, callId: 'cb', seq: 0, text: '后台' })
  gateway.pushEvent({ kind: 'done', sessionId: 'tab-b', deviceId: device.deviceId, callId: 'cb', text: '后台跑完了' })

  const delta = await client.waitFor(f => f.t === 'chat/delta' && f.sessionId === 'tab-b')
  assert.ok(delta, 'a background tab must still stream while another tab is shown')
  const done = await client.waitFor(f => f.t === 'chat/done' && f.sessionId === 'tab-b')
  assert.equal(done.text, '后台跑完了')
  client.close()
})

test('a session that is neither bound nor watched never leaks to the device', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_TABS] })
  gateway.pushEvent({ kind: 'delta', sessionId: 'someone-elses', deviceId: device.deviceId, callId: 'x', seq: 0, text: 'leak' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(client.frames.some(f => f.t === 'chat/delta'), false)
  client.close()
})

test('session/snapshot answers for an open tab and refuses a foreign one', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_TABS] })
  client.send({ t: 'session/watch', sessionIds: ['tab-b'] })
  await delay(20)

  client.send({ t: 'session/snapshot', rid: 'snap-b', sessionId: 'tab-b' })
  const state = await client.waitFor(f => f.t === 'session/state' && f.rid === 'snap-b')
  assert.ok(state, 'a watched tab must be snapshot-able')
  assert.equal(state.sessionId, 'tab-b')
  assert.equal(state.active, false, 'a background snapshot must not look like a switch')

  client.send({ t: 'session/snapshot', rid: 'snap-x', sessionId: 'not-mine' })
  const error = await client.waitFor(f => f.t === 'error' && f.code === 'not-allowed')
  assert.ok(error, 'a device must not read arbitrary conversations')
  client.close()
})

test('switching tabs does not tear down the conversation left behind', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSIONS] })
  const first = gateway.deviceSession.get(device.deviceId)

  harness.selectResult = { ok: true, sessionId: 'tab-b' }
  client.send({ t: 'session/select', rid: 'sel', sessionId: 'tab-b' })
  assert.ok(await client.waitFor(f => f.t === 'session/selected' && f.ok === true))
  await delay(30)

  assert.deepEqual(harness.releasedSessions, [], 'the old tab keeps running; switching is not unbinding')
  assert.equal(gateway.deviceSession.get(device.deviceId), 'tab-b')
  assert.notEqual(first, 'tab-b')
  client.close()
})

test('closing a tab is client-side; unbinding still releases everything it used', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_TABS] })
  const bound = gateway.deviceSession.get(device.deviceId)
  client.send({ t: 'session/watch', sessionIds: ['tab-b'] })
  await delay(20)

  client.send({ t: 'device/forget', deviceId: device.deviceId })
  assert.ok(await client.waitFor(f => f.t === 'assistants' && f.unbound === true))
  assert.ok(harness.releasedSessions.includes('tab-b'), 'an unbound device must not leave background agents alive')
  assert.ok(harness.releasedSessions.includes(bound))
  client.close()
})

// ---------------------------------------------------------------------------
// v3.0.0: structured questions — ask_user_question / plan review on the phone
// ---------------------------------------------------------------------------

test('a desktop user message is echoed to the phone that is watching the conversation', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.SESSION_SYNC] })

  gateway.pushEvent({
    kind: 'user-message',
    sessionId: ack.sessionId,
    messageId: 'dsh-msg-1',
    text: '电脑上发的消息',
    at: Date.now(),
  })

  const echo = await client.waitFor(f => f.t === 'chat/echo')
  assert.ok(echo, 'the phone must receive the desktop message live')
  assert.equal(echo.msgId, 'dsh_dsh-msg-1')
  assert.equal(echo.text, '电脑上发的消息')
  assert.equal(echo.sessionId, ack.sessionId)
  client.close()
})

test('a dual-display approval is marked onDesktop for the phone', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client, ack } = await pairDevice(port, device, { capabilities: [CAPABILITIES.APPROVAL] })

  gateway.pushEvent({
    kind: 'approval-ask',
    sessionId: ack.sessionId,
    approvalId: 'ap_desk',
    toolName: 'bash',
    reason: '电脑端同时展示',
    onDesktop: true,
  })
  const ask = await client.waitFor(f => f.t === 'approval/ask')
  assert.ok(ask)
  assert.equal(ask.onDesktop, true)
  client.close()
})

test('a question is pushed to a capable device with its routing session', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.QUESTIONS] })
  const sessionId = gateway.deviceSession.get(device.deviceId)

  gateway.pushEvent({
    kind: 'question-ask',
    sessionId,
    questionId: 'qst_1',
    items: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }],
    callId: 'call_1',
    expiresAt: Date.now() + 60_000,
    canAnswerLate: true,
  })

  const ask = await client.waitFor(f => f.t === 'question/ask')
  assert.ok(ask, 'the phone must receive question/ask')
  assert.equal(ask.questionId, 'qst_1')
  assert.equal(ask.sessionId, sessionId)
  assert.equal(ask.items[0].options.length, 2)
  assert.equal(ask.callId, 'call_1')
  assert.equal(ask.canAnswerLate, true)
  client.close()
})

test('a reconnecting device receives the approvals still waiting', async t => {
  // 审批常驻、没有本地超时：页面刷新或断线重连后必须把未答的卡片再推一次，
  // 否则手机看着空白、电脑那边工具调用一直挂着。
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  harness.pendingApprovals = sessionId => [{ approvalId: 'ap_replay', toolName: 'ops_bash', reason: '写文件', sessionId }]

  const { client } = await pairDevice(port, device, {
    capabilities: [CAPABILITIES.APPROVAL, CAPABILITIES.SESSION_SYNC],
  })
  const ask = await client.waitFor(f => f.t === 'approval/ask')
  assert.ok(ask, 'the pending approval must be replayed after connecting')
  assert.equal(ask.approvalId, 'ap_replay')
  assert.equal(ask.toolName, 'ops_bash')
  assert.equal(ask.reason, '写文件')
  assert.equal(ask.sessionId, gateway.deviceSession.get(device.deviceId))
  assert.equal('expiresAt' in ask, false, 'approvals rely on the 60s desktop handoff, not an expiry')
  client.close()
})

test('a device without the questions capability is never sent question frames', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.APPROVAL] })
  gateway.pushEvent({
    kind: 'question-ask',
    sessionId: gateway.deviceSession.get(device.deviceId),
    questionId: 'qst_2',
    items: [{ id: 'q1', question: 'x' }],
    expiresAt: Date.now() + 60_000,
  })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(client.frames.some(f => f.t === 'question/ask'), false)
  client.close()
})

test('question/reply reaches the bridge with the device identity', async t => {
  const { gateway, port, harness } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.QUESTIONS] })

  client.send({
    t: 'question/reply',
    questionId: 'qst_3',
    answers: [{ id: 'q1', selected: ['A'] }],
  })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(harness.answeredQuestions.length, 1)
  assert.equal(harness.answeredQuestions[0].questionId, 'qst_3')
  assert.equal(harness.answeredQuestions[0].deviceId, device.deviceId)
  assert.deepEqual(harness.answeredQuestions[0].answers, [{ id: 'q1', selected: ['A'] }])
  client.close()
})

test('question/resolved dismisses the card for every device in the conversation', async t => {
  const { gateway, port } = await makeGateway()
  t.after(() => gateway.close())
  const device = freshDevice()
  const { client } = await pairDevice(port, device, { capabilities: [CAPABILITIES.QUESTIONS] })
  const sessionId = gateway.deviceSession.get(device.deviceId)

  gateway.pushEvent({ kind: 'question-resolved', sessionId, questionId: 'qst_4', outcome: 'answered', source: 'phone' })
  const resolved = await client.waitFor(f => f.t === 'question/resolved')
  assert.equal(resolved.questionId, 'qst_4')
  assert.equal(resolved.outcome, 'answered')
  client.close()
})

// ---------------------------------------------------------------------------
// v3.0.0: 幂等表落盘（重启后仍然识别重复消息）
// ---------------------------------------------------------------------------

test('the idempotency table survives a gateway restart on the same data dir', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openwhale-gw-dedupe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new StateStore({ dir, hostName: '测试电脑' })
  const harness = makeBridge()
  const first = new Gateway({ store, bridge: harness.bridge, lanUrls: () => ['http://127.0.0.1:1'] })
  t.after(() => first.close().catch(() => {}))
  const firstPort = await first.listen(0, '127.0.0.1')
  const device = freshDevice()
  const { client } = await pairDevice(firstPort, device)
  client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  assert.ok(await client.waitFor(f => f.t === 'chat/ack'))
  await delay(50)
  assert.equal(harness.sent.length, 1)
  client.close()
  await first.close()
  assert.equal(existsSync(join(dir, 'dedupe.json')), true, 'the table must be flushed on dispose')

  // 插件重启：内存表清空，但同一个 dataDir 上的新网关必须还认得这条 msgId。
  const second = new Gateway({ store, bridge: harness.bridge, lanUrls: () => ['http://127.0.0.1:1'] })
  t.after(() => second.close().catch(() => {}))
  const secondPort = await second.listen(0, '127.0.0.1')
  const again = await reconnectWith(secondPort, device)
  again.client.send({ t: 'chat/send', rid: 'r1', callId: 'c1', msgId: 'm1', text: '你好' })
  const duplicate = await again.client.waitFor(f => f.t === 'chat/ack' && f.duplicate === true)
  assert.ok(duplicate, 'a retried msgId must be recognised after a restart')
  await delay(50)
  assert.equal(harness.sent.length, 1, 'the assistant must not be woken a second time')
  again.client.close()
})

test('a corrupt idempotency file is ignored instead of breaking the gateway', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openwhale-gw-dedupe-bad-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'dedupe.json'), '{ this is not json')
  const { gateway, port } = await makeGateway({ dir })
  t.after(() => gateway.close())
  assert.equal(gateway.dedupeRecords.size, 0)
  assert.equal((await fetch(`http://127.0.0.1:${port}/openwhale/health`)).status, 200)
})

// ---------------------------------------------------------------------------
// v3.0.0: 绑定页模板已抽到 page.mjs
// ---------------------------------------------------------------------------

test('the page renderer escapes untrusted values and hides local-only controls remotely', () => {
  const view = {
    payload: { ok: false, message: 'x' },
    qr: null,
    webEntries: [],
    webUrl: undefined,
    endpoints: [{ url: 'http://192.168.1.9:8787', kind: 'lan' }],
    local: true,
  }
  const deps = {
    version: '0.0.0-test',
    mode: 'auto',
    report: { detected: { lan: ['http://192.168.1.9:8787'] } },
    devices: [{ id: 'd1', label: '<script>alert(1)</script>' }],
    online: () => true,
    presence: () => 'background',
    computerName: '<img src=x>',
    computerId: 'cmp_test',
    fingerprint: 'abcdef',
    webClientAvailable: false,
    port: 8787,
  }
  const local = renderPageHtml(view, deps)
  assert.equal(local.includes('<script>alert(1)</script>'), false, 'device labels must be escaped')
  assert.match(local, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(local, /&lt;img src=x&gt;/)
  assert.match(local, /data-unbind="d1"/)
  assert.match(local, /id="send-file-btn"/)
  // v3.0.0：local 视图也要显示状态（改名前/移除按钮同排），后台不算离线。
  assert.equal(local.includes('在线（后台）'), true, 'local view must show the device presence')

  const remote = renderPageHtml({ ...view, local: false }, deps)
  assert.match(remote, /请在本机浏览器/)
  assert.equal(remote.includes('id="send-file-btn"'), false)
  assert.equal(remote.includes('data-unbind="d1"'), false)
  assert.equal(remote.includes('在线（后台）'), true, 'remote view must say online-but-background')

  const foreground = renderPageHtml(view, { ...deps, presence: () => 'foreground' })
  assert.equal(foreground.includes('在线（前台）'), true)
  const offline = renderPageHtml({ ...view, local: false }, { ...deps, presence: () => 'offline' })
  assert.equal(offline.includes('离线'), true)
})
