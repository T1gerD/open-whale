// 长期密钥与设备身份的持久化（expo-secure-store）。
//
// 只放两样东西：设备种子（Ed25519 私钥材料）与设备身份元信息。
// 助理列表、消息、备注名这些不是秘密，放 SQLite 更合适也更方便查询。

import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'

import { deviceSecretKeyName } from '../core/keys.mts'
import { seedFromBase64Url, seedToBase64Url } from './crypto'

const IDENTITY_KEY = 'openwhale.identity.v1'

export interface DeviceIdentity {
  deviceId: string
  deviceName: string
  /** 种子单独存在 SecureStore 的 device key 里；这个字段只在导出身份时使用。 */
  seedBase64Url?: string
  createdAt: string
}

/** SecureStore 在 Android 上只保证 ASCII 键值；键名保持纯 ASCII。 */
export async function saveSeed(deviceId: string, seed: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(deviceSecretKeyName(deviceId), seedToBase64Url(seed), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function loadSeed(deviceId: string): Promise<Uint8Array | undefined> {
  const stored = await SecureStore.getItemAsync(deviceSecretKeyName(deviceId))
  if (!stored) return undefined
  return seedFromBase64Url(stored)
}

export async function deleteSeed(deviceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(deviceSecretKeyName(deviceId))
}

export async function loadIdentity(): Promise<DeviceIdentity | undefined> {
  const raw = await SecureStore.getItemAsync(IDENTITY_KEY)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as DeviceIdentity
    if (!parsed?.deviceId) return undefined
    return parsed
  } catch {
    // 身份损坏就当没绑定过：让用户重新扫码比带着半坏的密钥运行更安全。
    return undefined
  }
}

export async function saveIdentity(identity: DeviceIdentity): Promise<void> {
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function clearIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(IDENTITY_KEY)
}

/** 首启时展示给电脑端看的设备名（手机型号比 “我的手机” 有用）。 */
export function defaultDeviceName(): string {
  const constants = Platform.constants as { Model?: string; systemName?: string; Brand?: string } | undefined
  const model = constants?.Model
  if (typeof model === 'string' && model.length > 0) return model.slice(0, 40)
  const system = Platform.OS === 'ios' ? 'iPhone' : 'Android 手机'
  return constants?.systemName ? `${system}（${constants.systemName}）` : system
}
