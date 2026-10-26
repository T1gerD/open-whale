// 浏览器端设备身份（Ed25519）。
//
// 信任模型（与电脑端 gateway 对应）：
//  1. 首次绑定：浏览器自己生成一对 Ed25519 密钥，把公钥（SPKI DER → base64url）
//     随 hello 发给电脑，并附上二维码里的一次性 `pairSecret`；
//  2. 之后每次重连：用私钥对 `openwhale-hello:<nonce>` 签名，电脑端验签放行；
//     长期密钥从不离开本机（localStorage），网络上只传签名。
//
// 加密实现用本地 vendor 的 tweetnacl（浏览器里是 `window.nacl`，Node 测试里用
// createRequire 加载同一个文件），不依赖 WebCrypto —— 后者在 `http://` 的局域网
// 地址上不是安全上下文，`crypto.subtle` 直接不存在。

import { helloAckProofMessage, helloSignatureMessage, PROTOCOL_VERSION, ALL_CAPABILITIES } from './protocol.mjs'
import { concatBytes, fromBase64Url, hexFromBytes, randomBytes, toBase64Url, utf8Encode } from './bytes.mjs'

/**
 * Ed25519 SubjectPublicKeyInfo 的 DER 前缀（RFC 8410）：
 * SEQUENCE(42) { SEQUENCE { OID 1.3.101.112 } BIT STRING(33) 00 }。
 * 电脑端 `crypto.createPublicKey({ key, format: 'der', type: 'spki' })` 要求整段 DER，
 * 而 tweetnacl 只给 32 字节裸公钥，所以要自己拼。
 */
export const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

/**
 * 裸 32 字节公钥 → SPKI DER。
 * @param {Uint8Array} rawPublicKey
 * @returns {Uint8Array}
 */
export function spkiFromRawPublicKey(rawPublicKey) {
  if (!(rawPublicKey instanceof Uint8Array) || rawPublicKey.length !== 32) {
    throw new Error('Ed25519 公钥必须是 32 字节')
  }
  return concatBytes([ED25519_SPKI_PREFIX, rawPublicKey])
}

/**
 * SPKI DER（base64url 或字节）→ 裸 32 字节公钥。
 * 兼容直接传 32 字节裸钥（老二维码若这么编码也不至于崩）。
 * @param {string | Uint8Array} spkiOrRaw
 * @returns {Uint8Array}
 */
export function rawFromSpki(spkiOrRaw) {
  const bytes = spkiOrRaw instanceof Uint8Array ? spkiOrRaw : fromBase64Url(String(spkiOrRaw ?? ''))
  if (bytes.length === 32) return bytes
  if (bytes.length === 44) {
    for (let index = 0; index < ED25519_SPKI_PREFIX.length; index += 1) {
      if (bytes[index] !== ED25519_SPKI_PREFIX[index]) throw new Error('公钥不是 Ed25519 SPKI DER')
    }
    return bytes.slice(12)
  }
  throw new Error(`公钥长度不合法（${bytes.length} 字节，应为 32 或 44）`)
}

/**
 * 生成新的设备身份。
 *
 * `deviceId` 必须匹配电脑端的 `/^[A-Za-z0-9_-]{8,128}$/`，且要足够随机——它是
 * 幂等键的命名空间，两台设备撞 id 会互相顶掉连接。
 * @param {{sign: {keyPair: () => {publicKey: Uint8Array, secretKey: Uint8Array}}}} nacl tweetnacl 命名空间
 * @param {{deviceName?: string, deviceId?: string, now?: number}} [options]
 * @returns {{deviceId: string, deviceName: string, publicKeyRaw: Uint8Array, publicKeySpki: Uint8Array,
 *            publicKeySpkiB64: string, secretKey: Uint8Array, createdAt: string}}
 */
export function createIdentity(nacl, options = {}) {
  if (!nacl?.sign?.keyPair) throw new Error('缺少 tweetnacl（window.nacl 未加载）')
  const keyPair = nacl.sign.keyPair()
  const spki = spkiFromRawPublicKey(keyPair.publicKey)
  const deviceId = options.deviceId ?? `web_${hexFromBytes(randomBytes(9))}`
  return {
    deviceId,
    deviceName: String(options.deviceName ?? '网页版 · 浏览器').slice(0, 40),
    publicKeyRaw: keyPair.publicKey,
    publicKeySpki: spki,
    publicKeySpkiB64: toBase64Url(spki),
    secretKey: keyPair.secretKey,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
  }
}

/**
 * 从持久化记录恢复身份（页面刷新 / 重连）。
 * @param {{deviceId: string, deviceName?: string, publicKeySpkiB64: string, secretKeyB64: string}} saved
 * @returns {{deviceId: string, deviceName: string, publicKeyRaw: Uint8Array, publicKeySpki: Uint8Array,
 *            publicKeySpkiB64: string, secretKey: Uint8Array, createdAt?: string}}
 */
export function restoreIdentity(saved) {
  if (!saved || typeof saved.deviceId !== 'string' || typeof saved.secretKeyB64 !== 'string') {
    throw new Error('本机身份记录不完整，需要重新扫码绑定')
  }
  const secretKey = fromBase64Url(saved.secretKeyB64)
  if (secretKey.length !== 64) throw new Error('本机身份密钥长度不合法，需要重新扫码绑定')
  const publicKeySpki = fromBase64Url(saved.publicKeySpkiB64)
  return {
    deviceId: saved.deviceId,
    deviceName: String(saved.deviceName ?? '网页版 · 浏览器'),
    publicKeyRaw: rawFromSpki(publicKeySpki),
    publicKeySpki,
    publicKeySpkiB64: toBase64Url(publicKeySpki),
    secretKey,
    createdAt: saved.createdAt,
  }
}

/**
 * 身份的可持久化形式（绑定记录里与电脑信息放一起）。
 * @param {ReturnType<typeof createIdentity>} identity
 * @returns {{deviceId: string, deviceName: string, publicKeySpkiB64: string, secretKeyB64: string, createdAt: string}}
 */
export function serializeIdentity(identity) {
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKeySpkiB64: identity.publicKeySpkiB64,
    secretKeyB64: toBase64Url(identity.secretKey),
    createdAt: identity.createdAt ?? new Date().toISOString(),
  }
}

/**
 * 新握手随机数。每次 hello（包括竞速时两个 socket 各发一次）都必须是新的：
 * 电脑端用 NonceReplayGuard 拒绝重复 nonce，复用会直接握手失败。
 * @returns {string}
 */
export function newNonce() {
  return toBase64Url(randomBytes(24))
}

/**
 * 用设备私钥对 nonce 签名（已绑定设备重连用）。
 * @param {{sign: {detached: (message: Uint8Array, secretKey: Uint8Array) => Uint8Array}}} nacl
 * @param {ReturnType<typeof createIdentity>} identity
 * @param {string} nonce
 * @returns {string} base64url 签名
 */
export function signHello(nacl, identity, nonce) {
  const signature = nacl.sign.detached(utf8Encode(helloSignatureMessage(nonce)), identity.secretKey)
  return toBase64Url(signature)
}

/**
 * 构造 hello 帧。
 * @param {object} input
 * @param {ReturnType<typeof createIdentity>} input.identity
 * @param {string} input.nonce
 * @param {string} [input.pairSecret] 仅首次绑定时传
 * @param {number} [input.cursor] 已应用的最大事件 seq
 * @param {string} [input.sessionId] 客户端认为自己在的会话
 * @param {string[]} [input.capabilities]
 * @param {string} [input.deviceName]
 * @returns {object} hello 帧
 */
export function buildHello(input) {
  const identity = input.identity
  /** @type {Record<string, unknown>} */
  const frame = {
    t: 'hello',
    version: PROTOCOL_VERSION,
    deviceId: identity.deviceId,
    deviceName: String(input.deviceName ?? identity.deviceName ?? '网页版 · 浏览器').slice(0, 40),
    devicePublicKey: identity.publicKeySpkiB64,
    nonce: input.nonce,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : [...ALL_CAPABILITIES],
  }
  if (typeof input.cursor === 'number' && Number.isFinite(input.cursor) && input.cursor > 0) frame.cursor = input.cursor
  if (typeof input.sessionId === 'string' && input.sessionId !== '') frame.sessionId = input.sessionId
  if (typeof input.pairSecret === 'string' && input.pairSecret !== '') frame.pairSecret = input.pairSecret
  if (typeof input.signature === 'string' && input.signature !== '') frame.signature = input.signature
  return frame
}

/**
 * 校验电脑在 hello/ack 里返回的身份证明。
 *
 * - 二维码带 `pk` 且 ack 带 `proof`：强校验，失败即拒绝（防隧道地址被冒充）；
 * - 两者缺一：放行但标记 `verified: false`，界面提示「本次连接未验证电脑身份」。
 * @param {object} input
 * @param {{sign: {detached: {verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean}}}} input.nacl
 * @param {string} input.computerPublicKey 二维码里的 pk（base64url SPKI DER）
 * @param {object} input.ack hello/ack 帧
 * @param {string} input.deviceId
 * @param {string} [input.expectedNonce] 本次 hello 用的 nonce（ack.nonce 缺失时兜底）
 * @returns {{ok: boolean, verified: boolean, reason?: string}}
 */
export function verifyHelloAckProof(input) {
  const { nacl, computerPublicKey, ack, deviceId } = input
  const proof = typeof ack?.proof === 'string' ? ack.proof : ''
  if (!computerPublicKey) {
    return { ok: true, verified: false, reason: '绑定二维码没有电脑公钥，无法校验电脑身份' }
  }
  if (!proof) {
    return { ok: true, verified: false, reason: '电脑端未提供身份证明（可能是不支持该能力的老版本）' }
  }
  const nonce = typeof ack?.nonce === 'string' && ack.nonce !== '' ? ack.nonce : String(input.expectedNonce ?? '')
  if (!nonce) return { ok: false, verified: false, reason: '电脑端身份证明缺少 nonce，已拒绝连接' }
  try {
    const message = utf8Encode(helloAckProofMessage(nonce, deviceId))
    const signature = fromBase64Url(proof)
    const publicKey = rawFromSpki(computerPublicKey)
    const valid = nacl.sign.detached.verify(message, signature, publicKey)
    if (!valid) return { ok: false, verified: false, reason: '电脑身份校验失败（可能是中间人），已拒绝连接' }
    return { ok: true, verified: true }
  } catch (error) {
    return { ok: false, verified: false, reason: `电脑身份证明无法解析：${/** @type {Error} */ (error).message}` }
  }
}

/**
 * 设备名（昵称）上限：电脑端 device/rename 限制 24 字符，hello 的 deviceName 也截断。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDeviceName(value) {
  return String(value ?? '').trim().slice(0, 24)
}
