// 设备密钥相关的纯逻辑：id 格式、公钥编码、密钥引用命名。
//
// 关键取舍：协议 typedef 只说 `devicePublicKey` 是 “base64url 编码的 Ed25519 公钥”，
// 而电脑端 `state.mjs#verifyDeviceSignature` 是用
// `createPublicKey({ key, format: 'der', type: 'spki' })` 导入的，
// 也就是必须发 **SPKI DER**（44 字节），不是裸 32 字节公钥。以电脑端实现为准，
// 这里统一把 tweetnacl 的裸公钥包成 SPKI。

/** Ed25519 公钥的 SPKI DER 前缀：AlgorithmIdentifier = 1.3.101.112, BIT STRING 32B。 */
export const ED25519_SPKI_PREFIX: Uint8Array = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

/** 电脑端 `gateway.mjs` 对 deviceId 的正则；不匹配会被直接断开。 */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

export function isValidDeviceId(value: unknown): boolean {
  return typeof value === 'string' && DEVICE_ID_RE.test(value)
}

/**
 * 把 32 字节裸 Ed25519 公钥包成 SPKI DER。
 * @throws 长度不是 32 字节时抛错——宁可启动就失败，也不要送出一个电脑端永远验不过的密钥。
 */
export function spkiFromRawEd25519(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new Error(`Ed25519 公钥必须是 32 字节，收到 ${raw.length}`)
  const out = new Uint8Array(ED25519_SPKI_PREFIX.length + 32)
  out.set(ED25519_SPKI_PREFIX, 0)
  out.set(raw, ED25519_SPKI_PREFIX.length)
  return out
}

/** SPKI DER → 裸 32 字节公钥。仅用于测试与诊断，App 正常路径不需要。 */
export function rawFromSpki(spki: Uint8Array): Uint8Array {
  if (spki.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new Error(`SPKI DER 长度不对：${spki.length}`)
  }
  for (let i = 0; i < ED25519_SPKI_PREFIX.length; i++) {
    if (spki[i] !== ED25519_SPKI_PREFIX[i]) throw new Error('SPKI DER 前缀不是 Ed25519')
  }
  return spki.slice(ED25519_SPKI_PREFIX.length)
}

/**
 * 生成一个满足电脑端校验的 deviceId。
 * 用注入的随机字节而不是内部取随机数，纯函数才能被测试。
 * @param random 16 字节随机数
 */
export function formatDeviceId(random: Uint8Array): string {
  if (random.length < 16) throw new Error('deviceId 需要至少 16 字节随机数')
  // 前缀只是给日志和调试用，随机部分确保同机重装也不会撞 id。
  const id = `dev_${toBase64Url(random.slice(0, 16))}`
  if (!isValidDeviceId(id)) throw new Error(`生成的 deviceId 不合法：${id}`)
  return id
}

/** SecureStore 里设备私钥的键名。按设备 id 分区，便于将来支持多身份。 */
export function deviceSecretKeyName(deviceId: string): string {
  return `openwhale.device.${deviceId}.seed`
}

export function seedKeyName(deviceId: string): string {
  return deviceSecretKeyName(deviceId)
}

/** 秒级时间戳转 ISO，避免各处重复写 new Date(...).toISOString()。 */
export function toIso(at: number): string {
  return new Date(at).toISOString()
}

/** 本地函数，避免为了一个 base64url 去 import 整个 base64 模块造成循环。 */
function toBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += alphabet[b0 >> 2]
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 !== undefined) out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 !== undefined) out += alphabet[b2 & 0x3f]
  }
  return out
}
