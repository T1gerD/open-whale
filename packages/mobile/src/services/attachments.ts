// 选文件/图片作为消息附件（原生能力层）。
//
// v2.2.0 起附件不再一次性读成 base64（大文件会爆内存 + 单帧超限），而是把本地 URI
// 交给 services/upload.ts 分块上传。这里只负责“选哪个文件、叫什么名字、多大”。
//
// 兼容：电脑端是 v2.1.0（不声明 upload-v1）时，ChatController 会退回内联 base64，
// 但它只对 ≤ 8 MiB 的小文件生效（见 core/files.mts 的 uploadGuard）。

import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'

import { bytesToBase64 } from '../core/base64.mts'
import { formatBytes, guessMime } from '../core/files.mts'

export type AttachmentKind = 'file' | 'image'

export interface PickedAttachment {
  name: string
  mime: string
  size: number
  /** 本地文件 URI；分块上传直接读它。 */
  uri: string
  kind: AttachmentKind
}

export type PickResult =
  | { ok: true; attachment: PickedAttachment }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string }

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

function extensionForMime(mime: string): string {
  return IMAGE_MIME_EXT[mime] ?? 'jpg'
}

/** 从 URI 里猜一个可读文件名（有些 Android 相册返回 content://，没有 fileName）。 */
function nameFromUri(uri: string, fallback: string): string {
  try {
    const clean = uri.split('?')[0] ?? ''
    const last = clean.split('/').pop() ?? ''
    const decoded = decodeURIComponent(last)
    if (decoded && decoded.includes('.')) return decoded
  } catch {
    // ignore
  }
  return fallback
}

/** 实际字节数：优先 asset 自带的 size，拿不到再问 File（避免上传时大小对不上）。 */
async function resolveSize(uri: string, hint: number | undefined): Promise<number> {
  if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) return hint
  try {
    const size = new File(uri).size
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) return size
  } catch {
    // ignore
  }
  return 0
}

async function pickImage(): Promise<PickResult> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as never,
      quality: 1,
      allowsEditing: false,
      exif: false,
    })
    if (!result || result.canceled || !Array.isArray(result.assets) || result.assets.length === 0) {
      return { ok: false, cancelled: true }
    }
    const asset = result.assets[0]
    const uri = typeof asset?.uri === 'string' ? asset.uri : ''
    if (!uri) return { ok: false, message: '没有拿到图片地址，换一张图试试' }
    const mime = typeof asset.mimeType === 'string' && asset.mimeType ? asset.mimeType : 'image/jpeg'
    const name = typeof asset.fileName === 'string' && asset.fileName
      ? asset.fileName
      : nameFromUri(uri, `photo.${extensionForMime(mime)}`)
    const size = await resolveSize(uri, typeof asset.fileSize === 'number' ? asset.fileSize : undefined)
    if (size <= 0) return { ok: false, message: '无法读取图片大小，换一张图试试' }
    return { ok: true, attachment: { name, mime, size, uri, kind: 'image' } }
  } catch (error) {
    return { ok: false, message: `读取相册失败：${(error as Error).message}` }
  }
}

async function pickFile(): Promise<PickResult> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['*/*'],
      copyToCacheDirectory: true,
      multiple: false,
    })
    if (result.canceled || !result.assets || result.assets.length === 0) {
      return { ok: false, cancelled: true }
    }
    const asset = result.assets[0]
    const uri = typeof asset.uri === 'string' ? asset.uri : ''
    if (!uri) return { ok: false, message: '没有拿到文件地址，换一个文件试试' }
    const name = asset.name || nameFromUri(uri, '附件')
    const size = await resolveSize(uri, typeof asset.size === 'number' ? asset.size : undefined)
    if (size <= 0) return { ok: false, message: '无法读取文件大小，换一个文件试试' }
    return {
      ok: true,
      attachment: {
        name,
        mime: asset.mimeType || guessMime(name),
        size,
        uri,
        kind: 'file',
      },
    }
  } catch (error) {
    return { ok: false, message: `读取文件失败：${(error as Error).message}` }
  }
}

/**
 * 选一个附件。`kind` 决定入口：file = 任意文件，image = 相册图片。
 * 取消返回 `{ok:false, cancelled:true}`（UI 静默处理，不要弹错误）。
 */
export async function pickAttachment(kind: AttachmentKind = 'file'): Promise<PickResult> {
  return kind === 'image' ? pickImage() : pickFile()
}

/** 输入栏「图片」按钮的便捷入口。 */
export function pickImageAttachment(): Promise<PickResult> {
  return pickAttachment('image')
}

/** 附件回显文案（聊天气泡里显示“附件：报告.pdf (1.2 MB)”）。 */
export function describeAttachment(attachment: { name: string; size: number }): string {
  return `${attachment.name} · ${formatBytes(attachment.size)}`
}

/**
 * 老电脑端（没有 upload-v1）的内联兜底：把整个文件读成 base64。
 * ⚠️ 只有 ≤ 8 MiB 的小文件才允许走这里（调用方先用 `uploadGuard` 判断）。
 */
export async function readFileBase64(uri: string): Promise<string> {
  const bytes = await new File(uri).bytes()
  return bytesToBase64(bytes)
}
