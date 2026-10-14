// 设备身份的密钥操作（tweetnacl + expo-crypto）。
//
// 为什么用 seed 而不是 tweetnacl 的 64 字节 secretKey：
//  1. 32 字节的 seed 就能完整重建密钥对（`fromSeed`），存进 SecureStore 更短；
//  2. 不需要给 tweetnacl 打 PRNG 补丁——随机数只由 expo-crypto 提供，来源单一。
//
// 注意：`sign.keyPair.fromSeed` 用到的随机数与 expo-crypto 都是同步 API，
// 所以签名可以在 WebSocket 的 onopen 回调里同步完成，不会错过握手时机。

import nacl from 'tweetnacl'

import * as Crypto from 'expo-crypto'
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from '../core/base64.mts'
import { formatDeviceId, spkiFromRawEd25519 } from '../core/keys.mts'

interface SignKeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

interface NaclSign {
  keyPair: { fromSeed(seed: Uint8Array): SignKeyPair }
  detached(message: Uint8Array, secretKey: Uint8Array): Uint8Array
}

// 通过 unknown 收窄，避免依赖 tweetnacl 的 .d.ts 导出形状（它在 CJS/ESM 之间摇摆）。
const signApi = (nacl as unknown as { sign: NaclSign }).sign

export interface DeviceKeypair {
  /** 32 字节种子；这是唯一需要进 SecureStore 的私钥材料。 */
  seed: Uint8Array
  publicKeyRaw: Uint8Array
  /** base64url 的 SPKI DER，发给电脑端的 `devicePublicKey`。 */
  publicKeySpki: string
}

export function generateSeed(): Uint8Array {
  return new Uint8Array(Crypto.getRandomBytes(32))
}

export function keypairFromSeed(seed: Uint8Array): DeviceKeypair {
  if (seed.length !== 32) throw new Error(`Ed25519 seed 必须是 32 字节，收到 ${seed.length}`)
  const pair = signApi.keyPair.fromSeed(seed)
  return {
    seed,
    publicKeyRaw: pair.publicKey,
    publicKeySpki: bytesToBase64Url(spkiFromRawEd25519(pair.publicKey)),
  }
}

export function generateDeviceKeypair(): DeviceKeypair {
  return keypairFromSeed(generateSeed())
}

export function deviceIdFromSeed(seed: Uint8Array): string {
  // deviceId 只是不透明标识，用同一份随机种子派生即可（不需要额外的存储项）。
  return formatDeviceId(seed)
}

/** 用设备私钥签名，返回 base64url。 */
export function signMessage(seed: Uint8Array, message: string): string {
  const pair = signApi.keyPair.fromSeed(seed)
  return bytesToBase64Url(signApi.detached(utf8ToBytes(message), pair.secretKey))
}

/** 客户端自选 nonce（protocol 的 HelloFrame.nonce）。 */
export function randomNonce(): string {
  return bytesToBase64Url(new Uint8Array(Crypto.getRandomBytes(16)))
}

/** 稳定且唯一的请求 id（用于 chat/send 的 rid/callId、power/request 的 rid）。 */
export function randomRequestId(prefix = 'req'): string {
  return `${prefix}_${Crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** 新的设备 id（形状必须满足电脑端 gateway.mjs 的正则）。 */
export function newDeviceId(): string {
  return formatDeviceId(new Uint8Array(Crypto.getRandomBytes(16)))
}

export function seedToBase64Url(seed: Uint8Array): string {
  return bytesToBase64Url(seed)
}

export function seedFromBase64Url(text: string): Uint8Array {
  const seed = base64UrlToBytes(text)
  if (seed.length !== 32) throw new Error('SecureStore 里的设备种子长度不对，需要重新绑定')
  return seed
}
