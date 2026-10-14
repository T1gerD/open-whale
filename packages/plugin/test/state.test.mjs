import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StateStore, fingerprintOf, newToken } from '../src/state.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'openwhale-state-'))
}

/** A store with a controllable clock and a scratch directory. */
function makeStore(nowRef = { value: Date.parse('2026-03-01T00:00:00.000Z') }) {
  const dir = tempDir()
  const store = new StateStore({ dir, hostName: '书房电脑', now: () => nowRef.value })
  return { store, dir, nowRef }
}

test('a fresh store generates a stable identity that survives reload', () => {
  const { store, dir, nowRef } = makeStore()
  const id = store.computerId
  const fp = store.fingerprint
  assert.match(id, /^cmp_[0-9a-f]{18}$/)
  assert.match(fp, /^[0-9a-f]{64}$/)

  const reopened = new StateStore({ dir, now: () => nowRef.value })
  assert.equal(reopened.computerId, id, 'computer id must be stable across restarts')
  assert.equal(reopened.fingerprint, fp, 'fingerprint must be stable across restarts')
  rmSync(dir, { recursive: true, force: true })
})

test('two stores never share an identity', () => {
  const a = makeStore().store
  const b = makeStore().store
  assert.notEqual(a.computerId, b.computerId)
  assert.notEqual(a.fingerprint, b.fingerprint)
})

test('computer identity is stored on disk with the private key intact', () => {
  const { store, dir, nowRef } = makeStore()
  const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.identity.id, store.computerId)
  assert.match(raw.identity.privateKey, /BEGIN PRIVATE KEY/)
  rmSync(dir, { recursive: true, force: true })
})

test('a corrupt state file is moved aside instead of bricking the plugin', () => {
  const { dir, nowRef } = makeStore()
  writeFileSync(join(dir, 'state.json'), '{ this is not json')
  const store = new StateStore({ dir, now: () => nowRef.value })
  assert.match(store.computerId, /^cmp_/)
  rmSync(dir, { recursive: true, force: true })
})

test('a state file from a future schema version is not silently reused', () => {
  const { store, dir, nowRef } = makeStore()
  const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  raw.version = 99
  writeFileSync(join(dir, 'state.json'), JSON.stringify(raw))
  const reopened = new StateStore({ dir, now: () => nowRef.value })
  assert.notEqual(reopened.computerId, store.computerId)
  rmSync(dir, { recursive: true, force: true })
})

test('signatures verify against the advertised fingerprint key', () => {
  const { store } = makeStore()
  const signature = store.sign('challenge-1')
  assert.match(signature, /^[A-Za-z0-9_-]+$/)
  const ok = verify(null, Buffer.from('challenge-1'), store.publicKeyObject, Buffer.from(signature, 'base64url'))
  assert.equal(ok, true)
  assert.equal(
    verify(null, Buffer.from('challenge-2'), store.publicKeyObject, Buffer.from(signature, 'base64url')),
    false,
  )
})

test('pairing secrets are single-use', () => {
  const { store } = makeStore()
  const { secret } = store.issuePairingSecret()
  assert.deepEqual(store.consumePairingSecret(secret), { ok: true })
  assert.deepEqual(store.consumePairingSecret(secret), { ok: false, reason: 'used' })
})

test('pairing secrets expire', () => {
  const nowRef = { value: Date.parse('2026-03-01T00:00:00.000Z') }
  const { store } = makeStore(nowRef)
  const { secret } = store.issuePairingSecret({ ttlMs: 1000 })
  nowRef.value += 1001
  assert.deepEqual(store.consumePairingSecret(secret), { ok: false, reason: 'expired' })
  assert.equal(store.activePairing, null)
})

test('a new QR invalidates the previous pairing secret', () => {
  const { store } = makeStore()
  const first = store.issuePairingSecret()
  const second = store.issuePairingSecret()
  assert.notEqual(first.secret, second.secret)
  assert.deepEqual(store.consumePairingSecret(first.secret), { ok: false, reason: 'mismatch' })
  assert.deepEqual(store.consumePairingSecret(second.secret), { ok: true })
})

test('a wrong pairing secret is rejected without consuming the window', () => {
  const { store } = makeStore()
  const { secret } = store.issuePairingSecret()
  assert.deepEqual(store.consumePairingSecret('not-the-secret'), { ok: false, reason: 'mismatch' })
  assert.deepEqual(store.consumePairingSecret(secret), { ok: true })
})

test('pairing without an issued window is refused', () => {
  const { store } = makeStore()
  assert.deepEqual(store.consumePairingSecret('anything'), { ok: false, reason: 'no-window' })
})

test('binding a device records it and flips isPaired', () => {
  const { store } = makeStore()
  assert.equal(store.isPaired, false)
  const record = store.bindDevice({
    deviceId: 'dev_1',
    deviceName: '我的手机',
    publicKey: Buffer.from('key-material').toString('base64url'),
  })
  assert.equal(record.label, '我的手机')
  assert.equal(store.isPaired, true)
  assert.equal(store.devices.length, 1)
})

test('re-binding the same device refreshes it instead of duplicating the assistant', () => {
  const { store } = makeStore()
  store.bindDevice({ deviceId: 'dev_1', deviceName: '旧名字', publicKey: 'k1' })
  store.bindDevice({ deviceId: 'dev_1', deviceName: '新名字', publicKey: 'k2' })
  assert.equal(store.devices.length, 1)
  assert.equal(store.device('dev_1').deviceName, '新名字')
  assert.equal(store.device('dev_1').publicKey, 'k2')
})

test('a device label can be renamed and is preserved across a re-bind', () => {
  const { store } = makeStore()
  store.bindDevice({ deviceId: 'dev_1', deviceName: '我的手机', publicKey: 'k1' })
  store.updateDevice('dev_1', { label: '家里的电脑' })
  assert.equal(store.device('dev_1').label, '家里的电脑')
  store.bindDevice({ deviceId: 'dev_1', deviceName: '我的手机', publicKey: 'k2' })
  assert.equal(store.device('dev_1').label, '家里的电脑')
})

test('renaming an unknown device reports missing instead of creating it', () => {
  const { store } = makeStore()
  assert.equal(store.updateDevice('nope', { label: 'x' }), undefined)
})

test('unbinding removes trust immediately', () => {
  const { store } = makeStore()
  store.bindDevice({ deviceId: 'dev_1', deviceName: '手机', publicKey: 'k1' })
  assert.equal(store.unbindDevice('dev_1'), true)
  assert.equal(store.isPaired, false)
  assert.equal(store.unbindDevice('dev_1'), false)
})

test('a device signature is only accepted for a bound key', () => {
  const { store } = makeStore()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  store.bindDevice({ deviceId: 'dev_1', deviceName: '手机', publicKey: spki.toString('base64url') })
  const signature = sign(null, Buffer.from('nonce'), privateKey).toString('base64url')
  assert.equal(store.verifyDeviceSignature('dev_1', 'nonce', signature), true)
  assert.equal(store.verifyDeviceSignature('dev_1', 'other', signature), false)
  assert.equal(store.verifyDeviceSignature('unknown', 'nonce', signature), false)
  assert.equal(store.verifyDeviceSignature('dev_1', 'nonce', 'not-base64url!'), false)
})

test('session ids are deterministic per device and differ between devices', () => {
  const { store } = makeStore()
  const a = store.sessionIdFor('dev_1')
  const b = store.sessionIdFor('dev_2')
  assert.equal(store.sessionIdFor('dev_1'), a, 'same device must keep one conversation')
  assert.notEqual(a, b)
  assert.match(a, /^ow-[0-9a-f]{32}$/)
})

test('session ids differ between computers for the same device', () => {
  const a = makeStore().store
  const b = makeStore().store
  assert.notEqual(a.sessionIdFor('dev_1'), b.sessionIdFor('dev_1'))
})

test('preferences round-trip and survive reload', () => {
  const { store, dir, nowRef } = makeStore()
  assert.equal(store.getPreference('missing', 'fallback'), 'fallback')
  store.setPreference('power.allowShutdown', true)
  const reopened = new StateStore({ dir, now: () => nowRef.value })
  assert.equal(reopened.getPreference('power.allowShutdown'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('newToken returns a high-entropy url-safe string', () => {
  const token = newToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(newToken(), token)
})

test('fingerprintOf is a pure function of the public key bytes', () => {
  assert.equal(fingerprintOf(Buffer.from('abc')), fingerprintOf(Buffer.from('abc')))
  assert.notEqual(fingerprintOf(Buffer.from('abc')), fingerprintOf(Buffer.from('abd')))
})
