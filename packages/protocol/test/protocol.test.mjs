import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVITY_KIND,
  CLIENT_FRAME,
  PAIR_SECRET_TTL_MS,
  PROTOCOL_VERSION,
  SERVER_FRAME,
  clampAssistantText,
  formatFingerprint,
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

test('pickEndpoint falls back to https first, then the first entry', () => {
  assert.equal(
    pickEndpoint(['http://192.168.1.5:8787', 'https://a.trycloudflare.com'], 'https://dead.example'),
    'https://a.trycloudflare.com',
  )
  assert.equal(pickEndpoint(['http://192.168.1.5:8787'], undefined), 'http://192.168.1.5:8787')
  assert.equal(pickEndpoint([], undefined), undefined)
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
