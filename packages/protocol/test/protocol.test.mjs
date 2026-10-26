import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVITY_KIND,
  ALL_CAPABILITIES,
  CAPABILITIES,
  CLIENT_FRAME,
  CONNECTION_MODE,
  ENDPOINT_KIND,
  IdempotencyCache,
  PAIR_SECRET_TTL_MS,
  PROTOCOL_VERSION,
  SERVER_FRAME,
  SessionEventLog,
  classifyEndpoint,
  clampAssistantText,
  dedupeKey,
  encodeEndpointKinds,
  endpointKindsForMode,
  formatFingerprint,
  isTailscaleHost,
  normalizeMessageId,
  orderEndpointCandidates,
  orderEndpoints,
  parseEndpointKinds,
  parsePairingPayload,
  pickEndpoint,
  timingSafeEqual,
} from '../src/index.mjs'

/** Build a valid payload; individual tests then break exactly one field. */
function payload(overrides = {}) {
  return {
    v: 1,
    p: 'openwhale',
    host: 'DESKTOP-7',
    id: 'cmp_abc123',
    fp: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    secret: 's3cr3t-single-use',
    expires: new Date(Date.now() + PAIR_SECRET_TTL_MS).toISOString(),
    endpoints: ['https://quiet-whale.trycloudflare.com', 'http://192.168.1.20:8787'],
    port: 8787,
    lan: 'http://192.168.1.20:8787',
    name: '书房电脑',
    version: '1.0.0',
    ...overrides,
  }
}

test('protocol exposes a semantic version that both sides can compare', () => {
  assert.match(PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/)
})

test('client and server frame vocabularies do not collide', () => {
  const client = new Set(Object.values(CLIENT_FRAME))
  for (const server of Object.values(SERVER_FRAME)) {
    assert.equal(client.has(server), false, `frame ${server} used by both directions`)
  }
})

test('parsePairingPayload accepts a well-formed payload', () => {
  const result = parsePairingPayload(payload())
  assert.equal(result.ok, true)
  assert.equal(result.payload.host, 'DESKTOP-7')
  assert.deepEqual(result.payload.endpoints, [
    'https://quiet-whale.trycloudflare.com',
    'http://192.168.1.20:8787',
  ])
})

test('parsePairingPayload rejects a foreign QR code', () => {
  const result = parsePairingPayload({ v: 1, p: 'someone-else' })
  assert.equal(result.ok, false)
  assert.match(result.error, /Open Whale/)
})

test('parsePairingPayload rejects a non-object payload', () => {
  assert.equal(parsePairingPayload('https://example.com').ok, false)
  assert.equal(parsePairingPayload(null).ok, false)
  assert.equal(parsePairingPayload(42).ok, false)
})

test('parsePairingPayload rejects an unsupported QR version', () => {
  const result = parsePairingPayload(payload({ v: 2 }))
  assert.equal(result.ok, false)
  assert.match(result.error, /版本/)
})

test('parsePairingPayload rejects a payload missing any required field', () => {
  for (const field of ['host', 'id', 'fp', 'secret', 'expires']) {
    const broken = payload()
    delete broken[field]
    const result = parsePairingPayload(broken)
    assert.equal(result.ok, false, `missing ${field} should be rejected`)
    assert.match(result.error, new RegExp(field))
  }
})

test('parsePairingPayload rejects an empty string where a value is required', () => {
  assert.equal(parsePairingPayload(payload({ host: '' })).ok, false)
  assert.equal(parsePairingPayload(payload({ secret: '' })).ok, false)
})

test('parsePairingPayload rejects an expired pairing secret', () => {
  const result = parsePairingPayload(payload({ expires: new Date(Date.now() - 1000).toISOString() }))
  assert.equal(result.ok, false)
  assert.match(result.error, /过期/)
})

test('parsePairingPayload treats the exact expiry instant as expired', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const result = parsePairingPayload(
    payload({ expires: new Date(now + 1).toISOString() }),
    { now },
  )
  // one millisecond of remaining life is still valid
  assert.equal(result.ok, true)
  const boundary = parsePairingPayload(
    payload({ expires: '2026-01-01T00:00:00.000Z' }),
    { now },
  )
  assert.equal(boundary.ok, false)
})

test('parsePairingPayload rejects a malformed expiry instead of guessing', () => {
  const result = parsePairingPayload(payload({ expires: 'tomorrow-ish' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /过期时间/)
})

test('parsePairingPayload rejects a payload with no usable endpoint', () => {
  assert.equal(parsePairingPayload(payload({ endpoints: [] })).ok, false)
  assert.equal(parsePairingPayload(payload({ endpoints: [17] })).ok, false)
  assert.equal(parsePairingPayload(payload({ endpoints: 'http://x' })).ok, false)
})

test('timingSafeEqual compares content and length without throwing on odd input', () => {
  assert.equal(timingSafeEqual('token-abc', 'token-abc'), true)
  assert.equal(timingSafeEqual('token-abc', 'token-abd'), false)
  assert.equal(timingSafeEqual('token-abc', 'token-abc-longer'), false)
  assert.equal(timingSafeEqual('', ''), true)
  assert.equal(timingSafeEqual('', 'x'), false)
  assert.equal(timingSafeEqual(/** @type {any} */ (null), 'x'), false)
  assert.equal(timingSafeEqual('x', /** @type {any} */ (undefined)), false)
})

test('formatFingerprint groups, uppercases and rejects junk input', () => {
  assert.equal(formatFingerprint('a1b2c3d4e5f6'), 'A1B2 C3D4 E5F6')
  assert.equal(formatFingerprint('a1 b2:c3-d4'), 'A1B2 C3D4')
  assert.equal(formatFingerprint(''), '')
  assert.equal(formatFingerprint('zz--'), '')
})

test('formatFingerprint caps the display length so the QR/UI stays readable', () => {
  const long = 'a'.repeat(256)
  const groups = formatFingerprint(long).split(' ')
  assert.equal(groups.length, 16)
})

test('pickEndpoint prefers the remembered endpoint when it is still advertised', () => {
  const endpoints = ['https://a.trycloudflare.com', 'http://192.168.1.5:8787']
  assert.equal(pickEndpoint(endpoints, 'http://192.168.1.5:8787'), 'http://192.168.1.5:8787')
})

test('pickEndpoint prefers the remembered endpoint, then the fastest network kind', () => {
  // 2.2.0: a LAN/Tailscale address must beat a public tunnel in auto mode.
  assert.equal(
    pickEndpoint(['https://a.trycloudflare.com', 'http://192.168.1.5:8787'], undefined),
    'http://192.168.1.5:8787',
  )
  // The remembered endpoint still wins while it is still advertised.
  assert.equal(
    pickEndpoint(['https://a.trycloudflare.com', 'http://192.168.1.5:8787'], 'https://a.trycloudflare.com'),
    'https://a.trycloudflare.com',
  )
  // Tailscale outranks the LAN.
  assert.equal(
    pickEndpoint(['http://192.168.1.5:8787', 'http://100.102.90.23:8787'], undefined),
    'http://100.102.90.23:8787',
  )
  assert.equal(pickEndpoint(['https://a.trycloudflare.com'], undefined), 'https://a.trycloudflare.com')
  assert.equal(pickEndpoint([], undefined), undefined)
})

// ---------------------------------------------------------------------------
// 2.2.0 — capabilities, endpoint kinds, idempotency, event log
// ---------------------------------------------------------------------------

test('every capability is namespaced and unique', () => {
  assert.ok(ALL_CAPABILITIES.length >= 6)
  assert.equal(new Set(ALL_CAPABILITIES).size, ALL_CAPABILITIES.length)
  for (const capability of ALL_CAPABILITIES) assert.match(capability, /^[a-z0-9-]+-v1$/)
  assert.equal(CAPABILITIES.UPLOAD, 'upload-v1')
})

test('Tailscale addresses are recognised in all three forms', () => {
  assert.equal(isTailscaleHost('100.102.90.23'), true)
  assert.equal(isTailscaleHost('100.64.0.1'), true)
  assert.equal(isTailscaleHost('100.127.255.254'), true)
  assert.equal(isTailscaleHost('100.63.255.255'), false)
  assert.equal(isTailscaleHost('100.128.0.1'), false)
  assert.equal(isTailscaleHost('fd7a:115c:a1e0::1'), true)
  assert.equal(isTailscaleHost('fd7a:115c:a1e0:ab12::42'), true)
  assert.equal(isTailscaleHost('my-laptop.tail1234.ts.net'), true)
  assert.equal(isTailscaleHost('192.168.1.4'), false)
})

test('classifyEndpoint separates Tailscale from LAN and tunnel', () => {
  assert.equal(classifyEndpoint('http://100.102.90.23:8787'), ENDPOINT_KIND.TAILSCALE)
  assert.equal(classifyEndpoint('http://192.168.1.20:8787'), ENDPOINT_KIND.LAN)
  assert.equal(classifyEndpoint('http://10.0.0.8:8787'), ENDPOINT_KIND.LAN)
  assert.equal(classifyEndpoint('http://172.20.1.2:8787'), ENDPOINT_KIND.LAN)
  assert.equal(classifyEndpoint('https://quiet-whale.trycloudflare.com'), ENDPOINT_KIND.TUNNEL)
  assert.equal(classifyEndpoint('wss://example.com/openwhale/ws'), ENDPOINT_KIND.TUNNEL)
  assert.equal(classifyEndpoint('http://127.0.0.1:8787'), ENDPOINT_KIND.LOOPBACK)
  assert.equal(classifyEndpoint('http://[fd7a:115c:a1e0::1]:8787'), ENDPOINT_KIND.TAILSCALE)
  assert.equal(classifyEndpoint('not a url'), ENDPOINT_KIND.UNKNOWN)
})

test('auto mode orders Tailscale, then LAN, then the public tunnel', () => {
  const endpoints = [
    'https://quiet-whale.trycloudflare.com',
    'http://192.168.1.20:8787',
    'http://100.102.90.23:8787',
  ]
  assert.deepEqual(orderEndpoints(endpoints), [
    'http://100.102.90.23:8787',
    'http://192.168.1.20:8787',
    'https://quiet-whale.trycloudflare.com',
  ])
  // mode filters beat the ordering: "tailscale only" never tries the tunnel.
  assert.deepEqual(orderEndpoints(endpoints, { mode: CONNECTION_MODE.TAILSCALE }), ['http://100.102.90.23:8787'])
  assert.deepEqual(orderEndpoints(endpoints, { mode: CONNECTION_MODE.LAN }), ['http://192.168.1.20:8787'])
  assert.deepEqual(orderEndpoints(endpoints, { mode: CONNECTION_MODE.TUNNEL }), [
    'https://quiet-whale.trycloudflare.com',
  ])
  // preferred wins even against a better-ranked kind, but only if the mode allows it.
  assert.equal(orderEndpoints(endpoints, { preferred: 'http://192.168.1.20:8787' })[0], 'http://192.168.1.20:8787')
  assert.deepEqual(orderEndpoints(endpoints, { mode: CONNECTION_MODE.TUNNEL, preferred: 'http://100.102.90.23:8787' }), [
    'https://quiet-whale.trycloudflare.com',
  ])
  // loopback (USB debugging) is only included when explicitly allowed.
  assert.deepEqual(orderEndpoints(['http://127.0.0.1:8787'], {}), [])
  assert.deepEqual(orderEndpoints(['http://127.0.0.1:8787'], { allowLoopback: true }), ['http://127.0.0.1:8787'])
})

test('orderEndpointCandidates reports the kind it used for each URL', () => {
  const ordered = orderEndpointCandidates([
    'https://a.trycloudflare.com',
    'http://100.102.90.23:8787',
  ])
  assert.deepEqual(ordered, [
    { url: 'http://100.102.90.23:8787', kind: 'tailscale' },
    { url: 'https://a.trycloudflare.com', kind: 'tunnel' },
  ])
  assert.deepEqual(endpointKindsForMode(CONNECTION_MODE.AUTO), ['tailscale', 'lan', 'tunnel', 'unknown'])
})

test('pairing QR endpoint kind codes round-trip', () => {
  const endpoints = ['http://100.102.90.23:8787', 'http://192.168.1.20:8787', 'https://a.trycloudflare.com']
  const codes = encodeEndpointKinds(endpoints)
  assert.deepEqual(codes, ['t', 'l', 'c'])
  assert.deepEqual(parseEndpointKinds(endpoints, codes), ['tailscale', 'lan', 'tunnel'])
  // A QR from an older plugin has no epk: classify from the URL instead.
  assert.deepEqual(parseEndpointKinds(endpoints, undefined), ['tailscale', 'lan', 'tunnel'])
  // Garbage codes fall back to URL classification rather than throwing.
  assert.deepEqual(parseEndpointKinds(['http://192.168.1.20:8787'], ['?']), ['lan'])
})

test('parsePairingPayload validates the additive 2.2.0 fields', () => {
  const ok = parsePairingPayload(
    payload({ epk: ['c', 'l'], web: 'http://192.168.1.20:8787/openwhale/app', mode: 'auto' }),
  )
  assert.equal(ok.ok, true)
  const badEpk = parsePairingPayload(payload({ epk: ['c', 42] }))
  assert.equal(badEpk.ok, false)
  const badWeb = parsePairingPayload(payload({ web: 42 }))
  assert.equal(badWeb.ok, false)
  const badMode = parsePairingPayload(payload({ mode: 'bluetooth' }))
  assert.equal(badMode.ok, false)
})

test('IdempotencyCache remembers within the TTL and forgets after it', () => {
  let now = 1_000
  const cache = new IdempotencyCache({ ttlMs: 100, maxEntries: 3, now: () => now })
  const key = dedupeKey('dev_1', 'msg_1')
  assert.equal(cache.get(key), undefined)
  cache.remember(key, { callId: 'c1' })
  assert.deepEqual(cache.get(key), { callId: 'c1' })
  now += 99
  assert.deepEqual(cache.get(key), { callId: 'c1' })
  now += 2
  assert.equal(cache.get(key), undefined)
  // bounded: more entries than maxEntries evicts the oldest.
  for (let i = 0; i < 5; i++) cache.remember(`k${i}`, i)
  assert.equal(cache.get('k0'), undefined)
  assert.equal(cache.get('k4'), 4)
})

test('normalizeMessageId rejects empty and over-long ids', () => {
  assert.equal(normalizeMessageId('msg_1'), 'msg_1')
  assert.equal(normalizeMessageId('  msg_2  '), 'msg_2')
  assert.equal(normalizeMessageId('', 'fallback'), 'fallback')
  assert.equal(normalizeMessageId(undefined, 'fallback'), 'fallback')
  assert.equal(normalizeMessageId('x'.repeat(201), 'fallback'), 'fallback')
})

test('SessionEventLog replays after a cursor and rebuilds a snapshot', () => {
  const log = new SessionEventLog({ limit: 10, snapshotLimit: 10 })
  assert.equal(log.head, 0)
  log.append({ t: SERVER_FRAME.CHAT_ECHO, msgId: 'm1', text: '第一句', at: '2026-01-01T00:00:00.000Z' })
  const msg = log.append({ t: SERVER_FRAME.CHAT_MESSAGE, callId: 'c1', messageId: 'a1', text: '收到' })
  log.append({ t: SERVER_FRAME.CHAT_MESSAGE, callId: 'c1', messageId: 'a2', text: '还有' })
  log.append({ t: SERVER_FRAME.CHAT_DONE, callId: 'c1', text: '收到\n\n还有', at: '2026-01-01T00:00:01.000Z' })
  assert.equal(log.head, 4)
  assert.equal(msg.seq, 2)
  const replay = log.eventsSince(1)
  assert.ok(replay && replay.length === 3)
  assert.equal(replay[0].callId, 'c1')
  assert.deepEqual(log.eventsSince(4), [])
  // A cursor older than the retained window cannot be replayed: snapshot instead.
  const tiny = new SessionEventLog({ limit: 1 })
  tiny.append({ t: SERVER_FRAME.CHAT_ECHO, msgId: 'm9', text: 'x' })
  tiny.append({ t: SERVER_FRAME.CHAT_ECHO, msgId: 'm10', text: 'y' })
  assert.equal(tiny.eventsSince(0), undefined)
  // …but a cursor inside the window still replays.
  assert.equal(tiny.eventsSince(1)?.length, 1)
  const snapshot = log.snapshot()
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot[0].id, 'usr_m1')
  assert.equal(snapshot[1].id, 'msg_c1')
  assert.equal(snapshot[1].text, '收到\n\n还有')
})

test('clampAssistantText leaves short answers untouched', () => {
  assert.deepEqual(clampAssistantText('hello', 100), { text: 'hello', truncated: false })
  assert.deepEqual(clampAssistantText('', 10), { text: '', truncated: false })
})

test('clampAssistantText truncates long answers and says so', () => {
  const result = clampAssistantText('x'.repeat(500), 100)
  assert.equal(result.truncated, true)
  assert.match(result.text, /截断/)
  assert.ok(result.text.length < 200)
})

test('clampAssistantText never splits a surrogate pair', () => {
  const emoji = '🐳'.repeat(50)
  const result = clampAssistantText(emoji, 5)
  assert.equal(result.truncated, true)
  // Whatever we kept must round-trip as valid text, with no lone surrogate.
  assert.equal(result.text.includes('\uFFFD'), false)
  const body = result.text.split('\n\n')[0]
  for (const char of body) {
    assert.ok(char.codePointAt(0) <= 0x10ffff)
  }
  assert.equal([...body].every(c => c === '🐳'), true)
})

test('activity kinds are stable identifiers the app can switch on', () => {
  assert.deepEqual(Object.values(ACTIVITY_KIND), ['thinking', 'tool-start', 'tool-end'])
})
