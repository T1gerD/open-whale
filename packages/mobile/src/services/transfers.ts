// 文件落盘与分享（expo-file-system 新 API + expo-sharing）。
//
// v2.2.0 的关键改动：下载不再「所有分块攒在内存里再一次性写盘」，而是边收边写
// （DownloadSink）。原因：
//  * 协议允许 512 MB 的文件，内存拼装在手机上必然 OOM；
//  * 512 MB / 256 KiB = 2048 个分块，全部留在 state 外（sinkBuffers）会让内存翻好几倍。
//
// 兼容：如果设备/Expo 版本的 FileHandle 写入不可用，自动退回内存缓冲（上限
// MAX_ASSEMBLY_BYTES），行为与 v2.1.0 相同，只是大文件会被提前拦下并给可读提示。

import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'

import {
  MAX_ASSEMBLY_BYTES,
  canAssemble,
  formatBytes,
  guessMime,
  sanitizeFileName,
  uniqueFileName,
} from '../core/files.mts'

/** 下载目录名（在应用私有目录下，不需要任何存储权限）。 */
const DOWNLOAD_DIR = 'openwhale-downloads'

/** 是否优先用 HTTP 直下。默认 false：分块路径已验证过协议行为，HTTP 路径没有。 */
export const PREFER_HTTP_DOWNLOAD = false

/** HTTP 直下的体积阈值（超过就值得省内存，但仍受 PREFER_HTTP_DOWNLOAD 控制）。 */
export const HTTP_DOWNLOAD_THRESHOLD = 2 * 1024 * 1024

export function downloadsDirectory(): Directory {
  return new Directory(Paths.document, DOWNLOAD_DIR)
}

export async function ensureDownloadsDirectory(): Promise<Directory> {
  const dir = downloadsDirectory()
  // idempotent + intermediates：目录已存在或父目录缺失都不该抛错
  await dir.create({ idempotent: true, intermediates: true })
  return dir
}

/** 目录里已有的文件名（用来避免下载同名文件互相覆盖）。 */
export async function listDownloadedNames(): Promise<Set<string>> {
  try {
    const dir = downloadsDirectory()
    if (!dir.exists) return new Set()
    const entries = dir.list()
    const names = new Set<string>()
    for (const entry of entries) {
      if (entry instanceof File) names.add(entry.name)
    }
    return names
  } catch {
    return new Set()
  }
}

export interface SavedFile {
  uri: string
  name: string
  size: number
}

/**
 * 把已完成的分块写进应用目录（内存兜底路径）。
 * @param bytes 已按序拼好的完整文件内容
 */
export async function writeDownloadedFile(name: string, bytes: Uint8Array): Promise<SavedFile> {
  if (!canAssemble(bytes.length)) {
    throw new Error(`文件 ${formatBytes(bytes.length)} 超过内置下载上限 ${formatBytes(MAX_ASSEMBLY_BYTES)}`)
  }
  const dir = await ensureDownloadsDirectory()
  const taken = await listDownloadedNames()
  const finalName = uniqueFileName(sanitizeFileName(name), taken)
  const file = new File(dir, finalName)
  if (file.exists) file.delete()
  file.create()
  file.write(bytes)
  return { uri: file.uri, name: finalName, size: bytes.length }
}

/** expo FileHandle 里我们真正用到的方法（不同小版本命名略有差异，全部可选）。 */
interface FileHandleLike {
  writeBytes?(bytes: Uint8Array): void
  write?(bytes: Uint8Array): void
  flush?(): void
  close?(): void
}

/** 打开一个可追加写的文件句柄；设备不支持时返回 undefined。 */
function openWriter(file: File): FileHandleLike | undefined {
  try {
    const candidate = (file as unknown as { open?: () => FileHandleLike }).open?.()
    if (!candidate) return undefined
    if (typeof candidate.writeBytes !== 'function' && typeof candidate.write !== 'function') return undefined
    return candidate
  } catch {
    return undefined
  }
}

export interface DownloadSink {
  readonly fileId: string
  /** 追加一块数据（按到达顺序）；失败会抛错，由调用方把传输标失败。 */
  write(bytes: Uint8Array): Promise<void>
  /** 收尾：flush + 改名为最终文件名；返回落盘信息。 */
  finish(): Promise<SavedFile>
  /** 中止：关闭句柄并删除半截文件。 */
  abort(): Promise<void>
  /** 是否走了流式落盘（false = 内存兜底）。 */
  readonly streaming: boolean
}

/**
 * 创建一个下载写入器：边收边写，避免整个文件驻留内存。
 * @param name 电脑端给的文件名（会被消毒）
 * @param size 声明大小（用于内存兜底的提前判断）
 */
export async function createDownloadSink(input: { fileId: string; name: string; size: number }): Promise<DownloadSink> {
  const dir = await ensureDownloadsDirectory()
  const taken = await listDownloadedNames()
  const finalName = uniqueFileName(sanitizeFileName(input.name), taken)
  const finalFile = new File(dir, finalName)
  const tempName = `.${finalName}.part`
  const tempFile = new File(dir, tempName)
  if (tempFile.exists) tempFile.delete()
  tempFile.create()
  const handle = openWriter(tempFile)
  const memoryParts: Uint8Array[] = []
  let written = 0
  let closed = false
  return {
    fileId: input.fileId,
    streaming: handle !== undefined,
    async write(bytes: Uint8Array): Promise<void> {
      if (closed) throw new Error('下载已结束，不能再写入')
      if (!bytes || bytes.length === 0) return
      if (handle) {
        const writer = handle.writeBytes ?? handle.write!
        writer.call(handle, bytes)
        written += bytes.length
        return
      }
      // 内存兜底：超过上限立即失败，避免真的 OOM。
      if (!canAssemble(written + bytes.length)) {
        throw new Error(`文件超过内置下载上限 ${formatBytes(MAX_ASSEMBLY_BYTES)}（当前设备不支持流式落盘）`)
      }
      memoryParts.push(bytes)
      written += bytes.length
    },
    async finish(): Promise<SavedFile> {
      if (closed) throw new Error('下载已经结束')
      closed = true
      if (handle) {
        try {
          handle.flush?.()
        } finally {
          handle.close?.()
        }
        if (finalFile.exists) finalFile.delete()
        tempFile.move(finalFile as unknown as Directory)
        return { uri: finalFile.uri, name: finalName, size: written }
      }
      const total = memoryParts.reduce((sum, part) => sum + part.length, 0)
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const part of memoryParts) {
        bytes.set(part, offset)
        offset += part.length
      }
      if (finalFile.exists) finalFile.delete()
      tempFile.delete()
      finalFile.create()
      finalFile.write(bytes)
      return { uri: finalFile.uri, name: finalName, size: total }
    },
    async abort(): Promise<void> {
      if (closed) return
      closed = true
      try {
        handle?.close?.()
      } catch {
        // ignore
      }
      try {
        if (tempFile.exists) tempFile.delete()
      } catch {
        // ignore
      }
      memoryParts.length = 0
    },
  }
}

/**
 * HTTP 直下（备用路径）。
 * `onProgress` 回调可用于进度条；电脑端的下载令牌是单次的，失败后需要重新 `file/fetch`。
 */
export async function downloadViaHttp(
  url: string,
  name: string,
  onProgress?: (received: number, total: number) => void,
): Promise<SavedFile> {
  const dir = await ensureDownloadsDirectory()
  const taken = await listDownloadedNames()
  const finalName = uniqueFileName(sanitizeFileName(name), taken)
  const target = new File(dir, finalName)
  const downloaded = await File.downloadFileAsync(url, target, {
    // expo-file-system SDK 57 的回调字段是 bytesWritten / totalBytes（-1 表示服务器没给 Content-Length）。
    onProgress: progress => onProgress?.(progress.bytesWritten, progress.totalBytes),
  })
  return { uri: downloaded.uri, name: finalName, size: downloaded.size ?? 0 }
}

/** 交给系统“打开方式”。expo-sharing 在没有可用 App 时会抛错，这里转成可读文案。 */
export async function openWithSystem(uri: string, name?: string, mime?: string): Promise<void> {
  const file = new File(uri)
  if (!file.exists) throw new Error('文件已被清理，请重新下载')
  const available = await Sharing.isAvailableAsync()
  if (!available) throw new Error('这台设备不支持系统分享，文件已保存在应用目录中')
  await Sharing.shareAsync(file.uri, {
    mimeType: mime ?? guessMime(name ?? file.name),
    dialogTitle: name ?? file.name,
    UTI: undefined,
  })
}

/** 清空下载目录（设置页的“清理已下载文件”）。 */
export async function clearDownloads(): Promise<void> {
  try {
    const dir = downloadsDirectory()
    if (!dir.exists) return
    dir.delete()
  } catch {
    // 目录被系统清理或权限变化时不该让设置页崩掉
  }
}

/** 下载目录的人类可读路径，设置页展示用。 */
export function downloadsLocationHint(): string {
  return `应用私有目录 /${DOWNLOAD_DIR}`
}
