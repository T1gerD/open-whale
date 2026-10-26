// 设备密钥测试：验证浏览器生成的 SPKI DER / 签名能被电脑端 Node crypto 接受。
//
// 这是网页版能不能绑定的硬门槛：tweetnacl 给的是 32 字节裸公钥，电脑端
// `crypto.createPublicKey({ format: 'der', type: 'spki' })` 要 44 字节 SPKI DER；
// 签名必须是 `openwhale-hello:<nonce>` 的 Ed25519 detached signature。
// 测试直接用 node:crypto 扮演电脑端做双向验证，不依赖真机。

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto'

import { fromBase64Url, toBase64Url } from '../lib/bytes.mjs'
import {
  ED25519_SPKI_PREFIX,
  buildHello,
  createIdentity,
  newNonce,
  normalizeDeviceName,
  rawFromSpki,
  restoreIdentity,
  serializeIdentity,
  signHello,
  spkiFromRawPublicKey,
  verifyHelloAckProof,
} from '../lib/keys.mjs'
import { helloAckProofMessage, helloSignatureMessage } from '../lib/protocol.mjs'

const require = createRequire(import.meta.url)
// 浏览器里是 <script src="./vendor/tweetnacl.min.js"> 挂到 window.nacl；
// Node 测试加载同一个本地文件（vendor/package.json 把它标成 CommonJS）。
const nacl = require('../vendor/tweetnacl.min.js')

test('createIdentity 生成电脑端能接受的 SPKI DER 公钥与合法 deviceId', () => {
  const identity = createIdentity(nacl, { deviceName: '网页版 · 测试' })
  assert.match(identity.deviceId, /^[A-Za-z0-9_-]{8,128}$/)
  assert.equal(identity.publicKeySpki.length, 44)
  assert.deepEqual(Array.from(identity.publicKeySpki.slice(0, 12)), Array.from(ED25519_SPKI_PREFIX))
  assert.equal(identity.secretKey.length, 64)
  // 电脑端（node:crypto）用同一段 DER 建公钥。
  const keyObject = createPublicKey({
    key: Buffer.from(identity.publicKeySpki),
    format: 'der',
    type: 'spki',
  })
  assert.equal(keyObject.asymmetricKeyType, 'ed25519')
  assert.deepEqual(Array.from(rawFromSpki(toBase64Url(identity.publicKeySpki))), Array.from(identity.publicKeyRaw))
})

test('signHello 的签名能被 node:crypto 验证（电脑端验签路径）', () => {
  const identity = createIdentity(nacl)
  const nonce = newNonce()
  const signature = signHello(nacl, identity, nonce)
  const publicKey = createPublicKey({
    key: Buffer.from(identity.publicKeySpki),
    format: 'der',
    type: 'spki',
  })
  const valid = nodeVerify(
    null,
    Buffer.from(helloSignatureMessage(nonce)),
    publicKey,
    fromBase64Url(signature),
  )
  assert.equal(valid, true, '电脑端必须能验通过浏览器签名')
  // 换个 nonce 必须验不过（防止签名与 nonce 脱钩）。
  assert.equal(
    nodeVerify(null, Buffer.from(helloSignatureMessage('other')), publicKey, fromBase64Url(signature)),
    false,
  )
})

test('buildHello 首次绑定带 pairSecret，重连带签名与 cursor/sessionId', () => {
  const identity = createIdentity(nacl)
  const first = buildHello({ identity, nonce: newNonce(), pairSecret: 'pair-secret' })
  assert.equal(first.t, 'hello')
  assert.equal(first.devicePublicKey, identity.publicKeySpkiB64)
  assert.equal(first.pairSecret, 'pair-secret')
  assert.equal(first.signature, undefined)
  assert.match(first.version, /^1\./)
  assert.ok(Array.isArray(first.capabilities) && first.capabilities.includes('chat-message-v1'))

  const nonce = newNonce()
  const reconnect = buildHello({
    identity,
    nonce,
    signature: signHello(nacl, identity, nonce),
    cursor: 42,
    sessionId: 'sess_1',
  })
  assert.equal(reconnect.pairSecret, undefined)
  assert.equal(reconnect.cursor, 42)
  assert.equal(reconnect.sessionId, 'sess_1')
  assert.equal(typeof reconnect.signature, 'string')
})

test('verifyHelloAckProof：验证电脑端 proof（node:crypto 生成的电脑身份）', () => {
  const computer = generateKeyPairSync('ed25519')
  const computerSpkiB64 = toBase64Url(computer.publicKey.export({ type: 'spki', format: 'der' }))
  const deviceId = 'web_deadbeef12345678'
  const nonce = 'nonce-来自浏览器'
  const signature = nodeSign(null, Buffer.from(helloAckProofMessage(nonce, deviceId)), computer.privateKey)
  const ack = {
    t: 'hello/ack',
    paired: true,
    pairAccepted: true,
    nonce,
    proof: toBase64Url(signature),
  }
  const ok = verifyHelloAckProof({ nacl, computerPublicKey: computerSpkiB64, ack, deviceId })
  assert.equal(ok.ok, true)
  assert.equal(ok.verified, true)

  // nonce 对不上 → 拒绝（防重放/中间人拿别的 hello 的 proof）。
  const wrongNonce = verifyHelloAckProof({ nacl, computerPublicKey: computerSpkiB64, ack: { ...ack, nonce: 'other' }, deviceId })
  assert.equal(wrongNonce.ok, false)
  assert.match(wrongNonce.reason, /身份校验失败/)

  // 用另一台「电脑」的公钥验同一段 proof → 拒绝。
  const attacker = generateKeyPairSync('ed25519')
  const attackerSpki = toBase64Url(attacker.publicKey.export({ type: 'spki', format: 'der' }))
  const impostor = verifyHelloAckProof({ nacl, computerPublicKey: attackerSpki, ack, deviceId })
  assert.equal(impostor.ok, false)
})

test('verifyHelloAckProof：老电脑端没有 pk / proof 时放行但标记未验证', () => {
  const ack = { t: 'hello/ack', nonce: 'n' }
  const noPk = verifyHelloAckProof({ nacl, computerPublicKey: '', ack, deviceId: 'dev_1' })
  assert.equal(noPk.ok, true)
  assert.equal(noPk.verified, false)
  assert.match(noPk.reason, /公钥/)
  const noProof = verifyHelloAckProof({
    nacl,
    computerPublicKey: toBase64Url(spkiFromRawPublicKey(nacl.sign.keyPair().publicKey)),
    ack,
    deviceId: 'dev_1',
  })
  assert.equal(noProof.ok, true)
  assert.equal(noProof.verified, false)
  assert.match(noProof.reason, /身份证明/)
})

test('身份可序列化 / 恢复（刷新页面后仍能签名重连）', () => {
  const identity = createIdentity(nacl, { deviceName: '网页版 · 鸿蒙' })
  const saved = serializeIdentity(identity)
  assert.equal(saved.secretKeyB64.includes('+'), false, 'base64url 不能带 +')
  assert.equal(saved.secretKeyB64.includes('/'), false)
  const restored = restoreIdentity(saved)
  assert.equal(restored.deviceId, identity.deviceId)
  assert.equal(restored.publicKeySpkiB64, identity.publicKeySpkiB64)
  assert.deepEqual(Array.from(restored.secretKey), Array.from(identity.secretKey))

  // 恢复出的身份签出来的名，电脑端仍然认。
  const nonce = newNonce()
  const publicKey = createPublicKey({ key: Buffer.from(restored.publicKeySpki), format: 'der', type: 'spki' })
  assert.equal(
    nodeVerify(null, Buffer.from(helloSignatureMessage(nonce)), publicKey, fromBase64Url(signHello(nacl, restored, nonce))),
    true,
  )
  assert.throws(() => restoreIdentity({ deviceId: 'x' }), /身份记录不完整/)
  assert.throws(() => restoreIdentity({ ...saved, secretKeyB64: toBase64Url(new Uint8Array(10)) }), /密钥长度不合法/)
})

test('spki 编解码拒绝坏公钥', () => {
  assert.throws(() => spkiFromRawPublicKey(new Uint8Array(31)), /32 字节/)
  assert.throws(() => rawFromSpki(toBase64Url(new Uint8Array(20))), /公钥长度不合法/)
  assert.throws(() => rawFromSpki(toBase64Url(new Uint8Array(44))), /SPKI DER/)
  // 32 字节裸钥也接受（容错）
  const raw = new Uint8Array(32).fill(7)
  assert.deepEqual(Array.from(rawFromSpki(toBase64Url(raw))), Array.from(raw))
})

test('newNonce 每次不同且长度够电脑端校验（16..256）', () => {
  const seen = new Set()
  for (let index = 0; index < 50; index += 1) {
    const nonce = newNonce()
    assert.ok(nonce.length >= 16 && nonce.length <= 256)
    assert.equal(seen.has(nonce), false)
    seen.add(nonce)
  }
})

test('normalizeDeviceName 截断到电脑端 24 字符上限', () => {
  assert.equal(normalizeDeviceName('  小明  '), '小明')
  assert.equal(normalizeDeviceName('x'.repeat(50)).length, 24)
  assert.equal(normalizeDeviceName(undefined), '')
})

test('identity 的 secretKey 能重建出同一把私钥（序列化不丢签名能力）', () => {
  // 电脑端把设备公钥存进 state.json；浏览器只保存 secretKey。用 tweetnacl 的
  // fromSecretKey 重建，确保序列化没有丢掉签名能力。
  const identity = createIdentity(nacl)
  const rebuilt = nacl.sign.keyPair.fromSecretKey(identity.secretKey)
  assert.deepEqual(Array.from(rebuilt.publicKey), Array.from(identity.publicKeyRaw))
  // 重建出的身份签的名，电脑端同样能验。
  const nonce = newNonce()
  const restored = restoreIdentity(serializeIdentity({
    ...identity,
    secretKey: rebuilt.secretKey,
  }))
  const publicKey = createPublicKey({ key: Buffer.from(restored.publicKeySpki), format: 'der', type: 'spki' })
  assert.equal(
    nodeVerify(null, Buffer.from(helloSignatureMessage(nonce)), publicKey, fromBase64Url(signHello(nacl, restored, nonce))),
    true,
  )
})

