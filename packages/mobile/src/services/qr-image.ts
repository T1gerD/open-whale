// 相册选图解码二维码（原生能力层）。
//
// 结论来自 R1-qr-crossplatform 研究：
//  1. **首选** `expo-camera` 的具名导出 `scanFromURLAsync(uri, ['qr'])`：SDK 57 内置、
//     无新依赖、iOS 用 CIDetector、Android 用 MLKit；
//  2. **必须**有 jsQR 纯 JS 兜底：Android 无 GMS（华为/部分国产 ROM）时 MLKit 会
//     直接 reject；iOS 的 CIDetector 对截图里的小码也偏弱；
//  3. 大图必须先缩放到 1024/2048 再解码（48MP 原图直接喂 jsQR 会 OOM）；
//  4. HEIC/AVIF 原图不可控，兜底路径统一经 ImageManipulator 转 JPEG。
//
// 纯逻辑（缩放档位、结果校验、错误文案）在 core/qr-image.mts，可被 node --test 覆盖。

import * as Camera from 'expo-camera'
import { File } from 'expo-file-system'
import * as ImageManipulatorModule from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
// @ts-ignore jsqr 没有随包类型定义（纯 CJS）
import jsQR from 'jsqr'
// @ts-ignore jpeg-js 没有随包类型定义（纯 CJS）
import jpeg from 'jpeg-js'

import { QR_JPEG_QUALITY, qrDecodeFailure, qrPickFailure, qrResizePlan } from '../core/qr-image.mts'

export type QrDecodeResult =
  | { ok: true; text: string; source: 'native' | 'jsqr' }
  | { ok: false; message: string; hint: string }

/** 原生路径：expo-camera 的 scanFromURLAsync。失败/无结果时返回原因，交给 jsQR 兜底。 */
async function decodeWithNative(uri: string): Promise<{ ok: true; text: string } | { ok: false; error?: unknown }> {
  const scan = (Camera as unknown as { scanFromURLAsync?: (url: string, types?: string[]) => Promise<Array<{ data?: string }>> }).scanFromURLAsync
  if (typeof scan !== 'function') return { ok: false }
  try {
    const hits = await scan(uri, ['qr'])
    const text = Array.isArray(hits) ? hits.find(hit => hit && typeof hit.data === 'string' && hit.data)?.data : undefined
    if (typeof text === 'string' && text) return { ok: true, text }
    return { ok: false }
  } catch (error) {
    // Android 无 GMS（MLKitUnavailableException）/ 不支持的图片格式都会走到这里。
    return { ok: false, error }
  }
}

/** 缩放 + 统一转 JPEG；兼容 SDK 57 新 API 与旧 manipulateAsync。 */
async function renderJpeg(uri: string, width: number): Promise<string> {
  const module = ImageManipulatorModule as unknown as {
    ImageManipulator?: { manipulate: (uri: string) => { resize: (size: { width: number }) => { renderAsync: () => Promise<{ saveAsync: (options: unknown) => Promise<{ uri: string }> }> } } }
    manipulateAsync?: (uri: string, actions: unknown[], options: unknown) => Promise<{ uri: string }>
    SaveFormat?: { JPEG: unknown }
  }
  const format = module.SaveFormat?.JPEG
  if (module.ImageManipulator && typeof module.ImageManipulator.manipulate === 'function') {
    const image = await module.ImageManipulator.manipulate(uri).resize({ width }).renderAsync()
    const saved = await image.saveAsync({ format, compress: QR_JPEG_QUALITY })
    return saved.uri
  }
  if (typeof module.manipulateAsync === 'function') {
    const saved = await module.manipulateAsync(uri, [{ resize: { width } }], { compress: QR_JPEG_QUALITY, format })
    return saved.uri
  }
  throw new Error('expo-image-manipulator 不可用')
}

/** 纯 JS 兜底：resize → JPEG → 字节 → jpeg-js 解 RGBA → jsQR。 */
async function decodeWithJsQr(uri: string, width: number): Promise<string | null> {
  const jpegUri = await renderJpeg(uri, width)
  const bytes = await new File(jpegUri).bytes()
  const decoded = jpeg.decode(bytes, { useTArray: true }) as { data: Uint8Array; width: number; height: number }
  if (!decoded || !decoded.width || !decoded.height) return null
  const rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
  const code = jsQR(rgba, decoded.width, decoded.height, { inversionAttempts: 'attemptBoth' })
  return code?.data ?? null
}

/**
 * 从一张本地图片里解码二维码。
 * 永远不抛错：失败时返回可操作的中文文案（UI 直接展示）。
 */
export async function decodeQrFromImage(uri: string): Promise<QrDecodeResult> {
  if (typeof uri !== 'string' || uri === '') {
    return { ok: false, ...qrDecodeFailure(undefined, false) }
  }
  const native = await decodeWithNative(uri)
  if (native.ok) return { ok: true, text: native.text, source: 'native' }

  // 兜底路径按 1024 → 2048 两档尝试：小图 1024 就够（快），截图里的小码第二档更稳。
  for (const step of qrResizePlan()) {
    try {
      const text = await decodeWithJsQr(uri, step.width)
      if (typeof text === 'string' && text.trim() !== '') return { ok: true, text, source: 'jsqr' }
    } catch {
      // 单档失败不致命：换下一档继续；两档都失败才给最终文案。
    }
  }
  return { ok: false, ...qrDecodeFailure(native.error, true) }
}

export type QrPickResult =
  | { ok: true; uri: string; width?: number; height?: number }
  | { ok: false; cancelled?: true; message: string; hint?: string }

/** 从相册选择一张图（不裁剪、不压缩：压缩会糊掉二维码模块）。 */
export async function pickQrImageFromAlbum(): Promise<QrPickResult> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      // SDK 54+ 用数组形式；旧版本也接受字符串，这里用数组并放宽类型。
      mediaTypes: ['images'] as never,
      quality: 1,
      allowsEditing: false,
      exif: false,
    })
    if (!result || result.canceled || !Array.isArray(result.assets) || result.assets.length === 0) {
      return { ok: false, cancelled: true, ...qrPickFailure('cancelled') }
    }
    const asset = result.assets[0]
    const uri = typeof asset?.uri === 'string' ? asset.uri : ''
    if (!uri) return { ok: false, ...qrPickFailure('unknown', '没有拿到图片地址') }
    return { ok: true, uri, width: asset.width, height: asset.height }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '')
    if (/permission|denied|权限/i.test(message)) return { ok: false, ...qrPickFailure('denied') }
    return { ok: false, ...qrPickFailure('unknown', message) }
  }
}
