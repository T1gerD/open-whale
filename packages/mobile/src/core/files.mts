// 文件收发的纯逻辑：命名、进度、体积、可落盘性判断。
//
// 实际写盘/分享由 `src/services/transfers.ts` 做（依赖 expo-file-system），
// 这里只保留不需要任何依赖、但容易写错且必须被测到的部分。

import { FILE_CHUNK_BYTES, MAX_FILE_BYTES } from './frames.mts'
import type { Transfer } from './reducer.mts'

/**
 * 手机端「内存拼装」下载的字节上限（v2.2.0 保留的兜底路径）。
 *
 * v2.2.0 默认走流式落盘（services/transfers.ts 的 DownloadSink，边收边写文件），
 * 所以这个上限只约束「设备不支持 FileHandle 时的内存兜底」，不再是主路径。
 * 真正允许的文件大小由协议 `MAX_FILE_BYTES`（512 MB）决定。
 */
export const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024

export function canAssemble(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= Math.min(MAX_ASSEMBLY_BYTES, MAX_FILE_BYTES)
}

/** base64 的字节数，不解码即可算进度；非法字符按 0 计（坏帧不该让进度跳成负数）。 */
export function base64ByteLength(text: unknown): number {
  if (typeof text !== 'string' || text === '') return 0
  const clean = text.replace(/[\r\n\s]/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/**
 * 文件名消毒：电脑端给的名字不可信（可能带路径分隔符、`..`、控制字符）。
 * 策略是替换而不是拒绝——用户仍然要能认出这个文件。
 */
export function sanitizeFileName(name: unknown, fallback = 'file'): string {
  let value = typeof name === 'string' ? name : ''
  // 只取最后一段，杜绝 ../../ 之类的路径穿越。
  value = value.split(/[\\/]/).pop() ?? ''
  value = value.replace(/[\u0000-\u001f\u007f]/g, '')
  value = value.replace(/[:*?"<>|]/g, '_')
  value = value.replace(/^\.+/, '').trim()
  if (value === '') return fallback
  // 留出空间给 `-2` 这类重名后缀，同时避免超出文件系统的单段上限。
  return value.length > 96 ? `${value.slice(0, 80)}${value.slice(-12)}` : value
}

/** 重名时追加序号，保证同一目录里不会互相覆盖。 */
export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  const safe = sanitizeFileName(name)
  if (!taken.has(safe)) return safe
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/** 分块临时文件名：序号补零，便于按字典序检查完整性。 */
export function partFileName(name: string, seq: number): string {
  return `${sanitizeFileName(name)}.part-${String(seq).padStart(5, '0')}`
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 电脑端不保证给 mime，落盘/分享前自己补一个常见的。 */
export function guessMime(name: string): string {
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    log: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    apk: 'application/vnd.android.package-archive',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return map[extOf(name)] ?? 'application/octet-stream'
}

export function isImage(name: string, mime?: string): boolean {
  if (mime && mime.startsWith('image/')) return true
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extOf(name))
}

export function isText(name: string, mime?: string): boolean {
  if (mime && mime.startsWith('text/')) return true
  return ['txt', 'md', 'json', 'csv', 'log', 'yml', 'yaml'].includes(extOf(name))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 0–1 的进度；大小未知时返回 undefined（UI 显示不确定进度条）。 */
export function transferProgress(transfer: Pick<Transfer, 'receivedBytes' | 'size'>): number | undefined {
  if (!transfer || !Number.isFinite(transfer.size) || transfer.size <= 0) return undefined
  return Math.max(0, Math.min(1, transfer.receivedBytes / transfer.size))
}

/** 文件卡片上的一行状态文案（中文、口语化，面向用户而不是日志）。 */
export function describeTransfer(transfer: Pick<Transfer, 'status' | 'receivedBytes' | 'size' | 'error'>): string {
  const progress = transferProgress(transfer)
  const percent = progress === undefined ? undefined : Math.round(progress * 100)
  switch (transfer.status) {
    case 'offered':
      return `${formatBytes(transfer.size)} · 点按下载`
    case 'queued':
      return '正在向电脑请求…'
    case 'downloading':
      return percent === undefined
        ? `下载中 ${formatBytes(transfer.receivedBytes)}`
        : `下载中 ${percent}% · ${formatBytes(transfer.receivedBytes)}`
    case 'done':
      return `${formatBytes(transfer.size)} · 已保存，点按打开`
    case 'cancelled':
      return '已取消下载'
    case 'too-large':
      return transfer.error ?? `超过 ${formatBytes(MAX_ASSEMBLY_BYTES)} 的内置下载上限`
    case 'failed':
    default:
      return transfer.error ? `下载失败：${transfer.error}` : '下载失败'
  }
}

export interface AssemblyPlan {
  name: string
  totalBytes: number
  expectedParts: number
  chunkBytes: number
}

/** 根据 meta 预估分块数（与电脑端 `FILE_CHUNK_BYTES` 对齐）。 */
export function planAssembly(meta: { name: string; size: number }, chunkBytes: number = FILE_CHUNK_BYTES): AssemblyPlan {
  const size = Number.isFinite(meta.size) && meta.size > 0 ? meta.size : 0
  return {
    name: sanitizeFileName(meta.name),
    totalBytes: size,
    expectedParts: size === 0 ? 1 : Math.ceil(size / chunkBytes),
    chunkBytes,
  }
}

/** 分块到达时的累计器（纯函数式，方便测试）。 */
export interface ChunkAccumulator {
  fileId: string
  nextSeq: number
  bytes: number
  size: number
}

export function startAccumulator(fileId: string, size: number): ChunkAccumulator {
  return { fileId, nextSeq: 0, bytes: 0, size }
}

export type ChunkPush =
  | { ok: true; accumulator: ChunkAccumulator }
  | { ok: false; reason: 'duplicate' | 'out-of-order' | 'overflow' | 'finished'; accumulator: ChunkAccumulator }

export function pushChunk(acc: ChunkAccumulator, seq: number, dataBase64: string): ChunkPush {
  if (seq < acc.nextSeq) return { ok: false, reason: 'duplicate', accumulator: acc }
  if (seq > acc.nextSeq) return { ok: false, reason: 'out-of-order', accumulator: acc }
  const bytes = acc.bytes + base64ByteLength(dataBase64)
  if (acc.size > 0 && bytes > acc.size) {
    return { ok: false, reason: 'overflow', accumulator: { ...acc, nextSeq: acc.nextSeq + 1, bytes } }
  }
  return { ok: true, accumulator: { ...acc, nextSeq: acc.nextSeq + 1, bytes } }
}

export function isAccumulatorComplete(acc: ChunkAccumulator): boolean {
  return acc.size === 0 ? acc.nextSeq > 0 : acc.bytes >= acc.size
}

/**
 * 老协议「内联 base64」附件的上限（兼容没有 upload-v1 能力的电脑端）。
 *
 * v2.2.0 的正常路径是分块上传（上限 64 MiB，见 core/upload.mts）。只有对端是
 * v2.1.0 插件、不声明 `upload-v1` 时，才退回整包 base64；此时把上限压到 8 MiB，
 * 避免一个帧把隧道打爆。
 */
export const INLINE_UPLOAD_BYTES = 8 * 1024 * 1024

/** 兼容老名字：`uploadGuard` 现在专门指“内联 base64 路径”。 */
export function uploadGuard(size: number): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(size) || size < 0) return { ok: false, message: '无法读取这个文件的大小' }
  if (size > INLINE_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `电脑端版本较旧，内联附件上限 ${formatBytes(INLINE_UPLOAD_BYTES)}：请升级电脑端插件以支持大文件分块上传`,
    }
  }
  return { ok: true }
}
