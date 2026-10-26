// 相册扫码的纯逻辑：缩放策略、解码结果校验、错误文案。
//
// 真正的解码在 `services/qr-image.ts`（expo-camera / expo-image-manipulator / jsqr），
// 这里只保留不需要原生模块、但必须测到的规则：
//  * 大图必须先缩小再解码（48MP 原图直接喂 jsQR 会 OOM）；
//  * 一张图解不出来要换一档尺寸再试，而不是直接判死；
//  * 解出来的内容可能是「绑定二维码 JSON」也可能是随便一个二维码，必须给出不同的文案。
//
// 研究结论（R1）：原生 `scanFromURLAsync` 优先；Android 无 GMS 时 MLKit 直接 reject，
// 必须用 jsQR 兜底 —— 所以这里也描述了两条路径的失败原因合并方式。

import { extractJsonObject } from './pairing.mts'

/** 兜底路径的缩放档位：先 1024（快、内存小），失败再试 2048（截图里的小码更清楚）。 */
export const QR_RESIZE_STEPS = [1024, 2048] as const

/** JPEG 质量：不要 1.0（体积大 3–5 倍，解码更慢）；0.9 不会糊掉二维码模块。 */
export const QR_JPEG_QUALITY = 0.9

export interface ResizeStep {
  /** 目标最大宽度（只缩不放）。 */
  width: number
  /** 该档位的人类可读说明（失败文案用）。 */
  label: string
}

/** 解码尝试计划（纯函数，测试可断言顺序与档位）。 */
export function qrResizePlan(): ResizeStep[] {
  return QR_RESIZE_STEPS.map(width => ({ width, label: `${width}px` }))
}

/** 是否值得在下一档继续尝试（解码失败但还有档位）。 */
export function hasMoreResizeSteps(tried: number): boolean {
  return tried < QR_RESIZE_STEPS.length - 1
}

export type QrTextValidation =
  | { ok: true; text: string; payload: Record<string, unknown>; fromJson: true }
  | { ok: true; text: string; payload?: undefined; fromJson: false }
  | { ok: false; message: string; hint: string }

/**
 * 校验解码出来的二维码文本。
 *
 * 只做「这是不是能交给 bind() 的东西」这一层判断：
 *  * 能抠出 JSON 对象的，交给 protocol 的 parsePairingPayload 做严格校验（在 store 里）；
 *  * 纯文本（比如一个 URL）也放行 —— 它可能是网页版/旧版二维码，由 bind 给最终结论；
 *  * 空内容直接拒绝。
 */
export function validateQrText(text: unknown): QrTextValidation {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') {
    return {
      ok: false,
      message: '这张图里没有找到二维码',
      hint: '换一张更清晰、二维码更大的截图；相机扫码不行时也可以手动输入电脑地址。',
    }
  }
  const parsed = extractJsonObject(value)
  if (parsed && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return { ok: true, text: value, payload: parsed as Record<string, unknown>, fromJson: true }
  }
  // 不是 JSON：可能是 URL 形式的二维码。不在这里判死，交给 bind 流程给出更准确的提示。
  return { ok: true, text: value, fromJson: false }
}

/**
 * 合并两条解码路径的失败原因，给出可操作提示。
 * @param nativeError 原生 scanFromURLAsync 抛出的错误（没有则 undefined）
 * @param fallbackTried 是否已经试过 jsQR 兜底
 */
export function qrDecodeFailure(
  nativeError: unknown,
  fallbackTried: boolean,
): { message: string; hint: string } {
  const nativeText = nativeError instanceof Error ? nativeError.message : typeof nativeError === 'string' ? nativeError : ''
  const mlkitMissing = /mlkit|unavailable/i.test(nativeText)
  if (mlkitMissing) {
    return {
      message: '这台设备不支持系统扫码组件，已经用备用方式解码但没找到二维码',
      hint: '换一张二维码更清晰、占比更大的图；或者用手动输入电脑地址。',
    }
  }
  if (!fallbackTried) {
    return {
      message: '图片读取失败',
      hint: '换一张图（建议 PNG/JPG 截图）再试，或者手动输入电脑地址。',
    }
  }
  return {
    message: '这张图里没有找到二维码',
    hint: '换一张更清晰、二维码更大的截图（截图里只留二维码区域识别率最高）。',
  }
}

/** 从相册选图失败/取消时的文案。 */
export function qrPickFailure(reason: 'cancelled' | 'denied' | 'unknown', detail?: string): { message: string; hint?: string } {
  switch (reason) {
    case 'cancelled':
      return { message: '已取消选择图片' }
    case 'denied':
      return { message: '没有相册访问权限', hint: '到系统设置里允许 Open Whale 访问照片后再试。' }
    default:
      return { message: `无法读取相册：${detail ?? '未知错误'}`, hint: '也可以直接手动输入电脑地址。' }
  }
}
