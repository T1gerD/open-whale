// 选文件作为消息附件。
//
// 为什么用 expo-document-picker：它是 Expo 官方模块，一个入口就能选图片/文档/任意文件
// （`type: '*/*'`），比 expo-image-picker（只能图片）覆盖面广。它需要在 prebuild 时
// 打进原生工程——本项目本来就要 prebuild 出 APK，所以不额外增加门槛。
//
// 大小限制：协议里 `chat/send.files` 是整包 base64（见 core/files.mts 的 uploadGuard），
// 大文件会一次性进内存，因此这里就拦下来，并告诉用户该怎么办。

import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'

import { formatBytes, guessMime, uploadGuard } from '../core/files.mts'
import { bytesToBase64 } from '../core/base64.mts'

export interface PickedAttachment {
  name: string
  mime: string
  size: number
  dataBase64: string
}

export type PickResult =
  | { ok: true; attachment: PickedAttachment }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string }

export async function pickAttachment(): Promise<PickResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  })
  if (result.canceled || !result.assets || result.assets.length === 0) {
    return { ok: false, cancelled: true }
  }
  const asset = result.assets[0]
  const size = typeof asset.size === 'number' ? asset.size : 0
  const guard = uploadGuard(size || 0)
  if (!guard.ok && size > 0) {
    return { ok: false, message: guard.message }
  }

  try {
    const file = new File(asset.uri)
    // 新 API 提供 base64()；如果真机上这个方法名不同，这里是唯一需要改的一处。
    const dataBase64 = await file.base64()
    const actual = Math.floor((dataBase64.replace(/=+$/, '').length * 3) / 4)
    const actualGuard = uploadGuard(actual)
    if (!actualGuard.ok) return { ok: false, message: actualGuard.message }
    return {
      ok: true,
      attachment: {
        name: asset.name || '附件',
        mime: asset.mimeType || guessMime(asset.name ?? ''),
        size: actual,
        dataBase64,
      },
    }
  } catch (error) {
    return { ok: false, message: `读取文件失败：${(error as Error).message}` }
  }
}

/** 附件回显文案（聊天气泡里显示“附件：报告.pdf (1.2 MB)”）。 */
export function describeAttachment(attachment: { name: string; size: number }): string {
  return `${attachment.name} · ${formatBytes(attachment.size)}`
}

/** 把 Uint8Array 直接转成 base64（WOL 之外的备用路径，测试与调试用）。 */
export function bytesToAttachmentBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
}
