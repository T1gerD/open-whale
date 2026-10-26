// 配对与握手判定：用**真实的** protocol 实现驱动，覆盖字段边界语义。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PAIR_SECRET_TTL_MS, PROTOCOL_VERSION } from '../../protocol/src/index.mjs'
import {
  buildAssistantFromPairing,
  buildHelloFrame,
  extractJsonObject,
  handshakeErrorHint,
  helloSignatureMessage,
  interpretHelloAck,
  validatePairingQr,
} from '../src/core/pairing.mts'
import { fixedRandom, pairingPayload, realDeps } from './helpers.mjs'

const deps = await realDeps()

test('validatePairingQr accepts a real protocol payload and normalizes endpoints', () => {
  const result = validatePairingQr(pairingPayload({ endpoints: ['https://a.example/', 17, 'http://192.168.1.20:8787/'] }), deps)
  assert.equal(result.ok, true)
  // protocol 的校验允许数组里混入非字符串（只要求“不是全都不是字符串”），这里必须滤掉
  assert.deepEqual(result.endpoints, ['https://a.example', 'http://192.168.1.20:8787'])
})

test('validatePairingQr surfaces protocol errors verbatim', () => {
  const foreign = validatePairingQr({ v: 1, p: 'someone-else' }, deps)
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /Open Whale/)

  const expired = validatePairingQr(pairingPayload({ expires: new Date(Date.now() - 1).toISOString() }), deps)
  assert.equal(expired.ok, false)
  assert.match(expired.error, /过期/)

  assert.equal(validatePairingQr('https://example.com', deps).ok, false)

  // 剩余 1ms 仍然有效：与 protocol 的边界语义保持一致
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const boundary = validatePairingQr(pairingPayload({ expires: new Date(now + 1).toISOString() }), deps, now)
  assert.equal(boundary.ok, true)
  assert.equal(validatePairingQr(pairingPayload({ expires: new Date(now).toISOString() }), deps, now).ok, false)
})

test('validatePairingQr rejects a payload whose endpoints are all unusable', () => {
  const result = validatePairingQr(pairingPayload({ endpoints: ['ftp://x', 'nonsense'] }), deps)
  assert.equal(result.ok, false)
  assert.match(result.error, /地址都不可用/)
})

test('buildAssistantFromPairing produces a record the app can persist', () => {
  const payload = pairingPayload()
  const validated = validatePairingQr(payload, deps)
  assert.equal(validated.ok, true)
  const record = buildAssistantFromPairing({
    payload: validated.payload,
    endpoints: validated.endpoints,
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '我的手机',
    now: Date.parse('2026-02-02T00:00:00.000Z'),
  })
  assert.equal(record.id, 'cmp_abc123')
  assert.equal(record.name, '书房电脑')
  assert.equal(record.fingerprint, payload.fp)
  assert.equal(record.preferredEndpoint, 'https://quiet-whale.trycloudflare.com')
  assert.equal(record.lan, 'http://192.168.1.20:8787')
  assert.equal(record.deviceId, 'dev_abcdefghijklmnopqrst')
  assert.equal(record.online, false)
  // 未连上之前不知道电脑端的策略，先给全套，由 assistants 帧纠正
  assert.deepEqual(record.powerAllowed, ['shutdown', 'restart', 'cancel'])
  assert.throws(
    () => buildAssistantFromPairing({ payload, endpoints: validated.endpoints, deviceId: 'bad id', deviceName: 'x' }),
    /deviceId/,
  )
})

test('interpretHelloAck accepts a matching computer and clamps the heartbeat', () => {
  const outcome = interpretHelloAck(
    {
      t: 'hello/ack',
      version: '1.0.0',
      computerId: 'cmp_abc123',
      computerName: 'DESKTOP-7',
      // 电脑端用大写/分组格式，笔记录里是纯小写十六进制
      computerFingerprint: 'A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90 A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90',
      paired: true,
      pairAccepted: false,
      nonce: 'n1',
      proof: 'p1',
      heartbeatMs: 20_000,
      serverTime: '2026-01-01T00:00:00.000Z',
      endpoints: ['https://new.example.com/'],
    },
    { computerId: 'cmp_abc123', fingerprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', pairing: false },
    Date.parse('2026-01-01T00:00:00.000Z'),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.heartbeatMs, 20_000)
  assert.deepEqual(outcome.endpoints, ['https://new.example.com'])
  assert.equal(outcome.patch.online, true)
  assert.equal(outcome.patch.lastConnectedAt, '2026-01-01T00:00:00.000Z')
})

test('interpretHelloAck defends against the wrong computer and bad values', () => {
  const base = { computerId: 'cmp_abc123', fingerprint: 'aabb', pairing: false }
  assert.equal(interpretHelloAck({ t: 'hello/ack' }, base).code, 'bad-ack')
  assert.equal(interpretHelloAck({ t: 'hello/ack', computerId: 'other' }, base).code, 'wrong-computer')
  assert.equal(
    interpretHelloAck({ t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'ffff', paired: true }, base).code,
    'fingerprint-mismatch',
  )
  assert.equal(
    interpretHelloAck({ t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: false }, base).code,
    'not-paired',
  )
  assert.equal(
    interpretHelloAck(
      { t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true, pairAccepted: false },
      { ...base, pairing: true },
    ).code,
    'pairing-refused',
  )
})

test('heartbeat values outside a sane range are clamped in both directions', () => {
  const expected = { computerId: 'cmp_abc123', fingerprint: 'aabb', pairing: false }
  const low = interpretHelloAck({ t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true, heartbeatMs: 200 }, expected)
  const high = interpretHelloAck({ t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true, heartbeatMs: 10 ** 9 }, expected)
  const missing = interpretHelloAck({ t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true }, expected)
  assert.equal(low.heartbeatMs, 5000)
  assert.equal(high.heartbeatMs, 120_000)
  assert.equal(missing.heartbeatMs, 25_000)
})

test('buildHelloFrame omits optional fields instead of sending nulls', () => {
  const frame = buildHelloFrame({
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '我的手机',
    devicePublicKey: 'PUBKEY',
    nonce: 'n1',
  })
  assert.deepEqual(frame, {
    t: 'hello',
    version: PROTOCOL_VERSION,
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '我的手机',
    devicePublicKey: 'PUBKEY',
    nonce: 'n1',
  })
  const pairingFrame = buildHelloFrame({
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '我的手机',
    devicePublicKey: 'PUBKEY',
    nonce: 'n1',
    pairSecret: 's3cr3t',
    signature: 'sig',
  })
  assert.equal(pairingFrame.pairSecret, 's3cr3t')
  assert.equal(pairingFrame.signature, 'sig')
  assert.throws(
    () => buildHelloFrame({ deviceId: 'bad id!', deviceName: 'x', devicePublicKey: 'k', nonce: 'n' }),
    /deviceId/,
  )
  assert.throws(() => buildHelloFrame({ deviceId: 'dev_abcdefghijklmnopqrst', deviceName: 'x', devicePublicKey: '', nonce: 'n' }), /devicePublicKey/)
})

test('the signed hello message follows the documented shape', () => {
  assert.equal(helloSignatureMessage('nonce-1'), 'openwhale-hello:nonce-1')
  // 电脑端在握手前下发挑战值后，客户端无需改协议即可切换
  assert.equal(helloSignatureMessage('client-nonce', 'server-nonce'), 'openwhale-hello:server-nonce')
})

test('handshake errors become actionable Chinese hints', () => {
  assert.match(handshakeErrorHint('bad-signature'), /重新扫码/)
  assert.match(handshakeErrorHint('pairing-required'), /二维码/)
  assert.match(handshakeErrorHint('handshake-timeout'), /同一网络/)
  assert.equal(handshakeErrorHint('whatever', '原始消息'), '原始消息')
  assert.equal(handshakeErrorHint('whatever'), '握手失败')
})

test('extractJsonObject digs a payload out of pasted text', () => {
  assert.deepEqual(extractJsonObject('  前缀 {"v":1,"p":"openwhale"} 后缀 '), { v: 1, p: 'openwhale' })
  assert.equal(extractJsonObject('no json here'), undefined)
  assert.equal(extractJsonObject(''), undefined)
})

test('a fixed random source yields a stable device id', async () => {
  const { formatDeviceId } = await import('../src/core/keys.mts')
  const first = formatDeviceId(fixedRandom(16, 3))
  assert.equal(first, formatDeviceId(fixedRandom(16, 3)))
  assert.equal(first.startsWith('dev_'), true)
  assert.ok(PAIR_SECRET_TTL_MS > 0)
})

test('the QR connection mode becomes the assistant record preference', () => {
  const validated = validatePairingQr(pairingPayload({ mode: 'tailscale' }), deps)
  assert.equal(validated.ok, true)
  const record = buildAssistantFromPairing({
    payload: validated.payload,
    endpoints: validated.endpoints,
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '我的手机',
  })
  assert.equal(record.connectionMode, 'tailscale')
  assert.equal(record.sessionCursor, 0)
  // 老插件不传 mode：默认自动
  const legacy = validatePairingQr(pairingPayload(), deps)
  assert.equal(
    buildAssistantFromPairing({
      payload: legacy.payload,
      endpoints: legacy.endpoints,
      deviceId: 'dev_abcdefghijklmnopqrst',
      deviceName: '我的手机',
    }).connectionMode,
    'auto',
  )
})

test('hello carries capabilities, cursor and sessionId when known', () => {
  const frame = buildHelloFrame({
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '我的手机',
    devicePublicKey: 'PUBKEY',
    nonce: 'n1',
    capabilities: ['chat-echo-v1', 'upload-v1', ''],
    cursor: 42,
    sessionId: 'sess_1',
  })
  assert.deepEqual(frame.capabilities, ['chat-echo-v1', 'upload-v1'])
  assert.equal(frame.cursor, 42)
  assert.equal(frame.sessionId, 'sess_1')
  // cursor=0 / 空能力列表不发送，保持老端兼容
  const bare = buildHelloFrame({
    deviceId: 'dev_abcdefghijklmnopqrst',
    deviceName: '手机',
    devicePublicKey: 'PUBKEY',
    nonce: 'n1',
    capabilities: [],
    cursor: 0,
    sessionId: '',
  })
  assert.equal('capabilities' in bare, false)
  assert.equal('cursor' in bare, false)
  assert.equal('sessionId' in bare, false)
})

test('hello/ack exposes 2.2.0 session fields and classified endpoints', () => {
  const outcome = interpretHelloAck(
    {
      t: 'hello/ack',
      version: '1.1.0',
      computerId: 'cmp_abc123',
      computerFingerprint: 'aabb',
      paired: true,
      heartbeatMs: 25_000,
      capabilities: ['chat-echo-v1', 'session-sync-v1', 'upload-v1'],
      sessionId: 'sess_shared',
      sessionEpoch: 3,
      eventCursor: 42,
      collaboration: true,
      connectionMode: 'tailscale',
      endpointList: [
        { url: 'http://100.88.1.2:8787', kind: 'tailscale' },
        { url: 'https://a.example', kind: 'tunnel' },
      ],
      endpoints: ['http://192.168.1.20:8787/'],
    },
    { computerId: 'cmp_abc123', fingerprint: 'aabb', pairing: false },
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.capabilities, ['chat-echo-v1', 'session-sync-v1', 'upload-v1'])
  assert.equal(outcome.sessionId, 'sess_shared')
  assert.equal(outcome.sessionEpoch, 3)
  assert.equal(outcome.eventCursor, 42)
  assert.equal(outcome.collaboration, true)
  assert.equal(outcome.connectionMode, 'tailscale')
  assert.deepEqual(outcome.endpoints, [
    'http://100.88.1.2:8787',
    'https://a.example',
    'http://192.168.1.20:8787',
  ])
})

test('an old hello/ack without 2.2.0 fields degrades to "no capabilities"', () => {
  const outcome = interpretHelloAck(
    { t: 'hello/ack', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true },
    { computerId: 'cmp_abc123', fingerprint: 'aabb', pairing: false },
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.capabilities, [])
  assert.equal(outcome.sessionId, undefined)
  assert.equal(outcome.eventCursor, undefined)
  assert.equal(outcome.collaboration, undefined)
})

test('the displayed server version is the plugin version, not the protocol version', () => {
  // 真实插件：version='1.1.0'（协议版本）、serverVersion='2.2.0'（插件版本）
  const withPluginVersion = interpretHelloAck(
    { t: 'hello/ack', version: '1.1.0', serverVersion: '2.2.0', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true },
    { computerId: 'cmp_abc123', fingerprint: 'aabb', pairing: false },
  )
  assert.equal(withPluginVersion.ok, true)
  assert.equal(withPluginVersion.patch.serverVersion, '2.2.0')

  // 老插件没有 serverVersion：回退到协议版本，至少不显示 undefined
  const legacy = interpretHelloAck(
    { t: 'hello/ack', version: '1.0.0', computerId: 'cmp_abc123', computerFingerprint: 'aabb', paired: true },
    { computerId: 'cmp_abc123', fingerprint: 'aabb', pairing: false },
  )
  assert.equal(legacy.patch.serverVersion, '1.0.0')
})
