// 设备密钥：公钥必须能被电脑端（Node crypto）当作 SPKI DER 导入。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

import { DEVICE_ID_RE, formatDeviceId, isValidDeviceId, rawFromSpki, spkiFromRawEd25519 } from '../src/core/keys.mts'

test('wrapping a raw Ed25519 key reproduces Node’s SPKI DER byte for byte', () => {
  for (let i = 0; i < 5; i++) {
    const { publicKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ type: 'spki', format: 'der' })
    const raw = new Uint8Array(der.subarray(der.length - 32))
    const wrapped = spkiFromRawEd25519(raw)
    assert.deepEqual(Array.from(wrapped), Array.from(der))
    assert.deepEqual(Array.from(rawFromSpki(wrapped)), Array.from(raw))
  }
})

test('a wrapped key is importable by the computer and verifies a signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const wrapped = spkiFromRawEd25519(new Uint8Array(der.subarray(der.length - 32)))
  // 电脑端 state.mjs 就是这么导入的：base64url → der/spki
  const imported = createPublicKey({ key: Buffer.from(wrapped), format: 'der', type: 'spki' })
  const message = 'openwhale-hello:nonce-value'
  const signature = sign(null, Buffer.from(message, 'utf8'), privateKey)
  assert.equal(verify(null, Buffer.from(message, 'utf8'), imported, signature), true)
})

test('a wrong-length or non-Ed25519 key is rejected loudly', () => {
  assert.throws(() => spkiFromRawEd25519(new Uint8Array(31)), /32 字节/)
  assert.throws(() => spkiFromRawEd25519(new Uint8Array(33)), /32 字节/)
  const bogus = spkiFromRawEd25519(new Uint8Array(32))
  bogus[0] = 0x00
  assert.throws(() => rawFromSpki(bogus), /前缀/)
})

test('generated device ids satisfy the computer-side regex', () => {
  const id = formatDeviceId(Uint8Array.from({ length: 16 }, (_, i) => i * 7))
  assert.match(id, DEVICE_ID_RE)
  assert.equal(isValidDeviceId(id), true)
  assert.equal(isValidDeviceId('short'), false)
  assert.equal(isValidDeviceId('has space and more'), false)
  assert.equal(isValidDeviceId(null), false)
  // 同一随机源必须给出同一个 id（可复现，便于排查）
  assert.equal(formatDeviceId(Uint8Array.from({ length: 16 }, (_, i) => i * 7)), id)
  assert.throws(() => formatDeviceId(new Uint8Array(4)), /16 字节/)
})
