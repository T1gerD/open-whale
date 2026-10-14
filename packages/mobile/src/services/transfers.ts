// 文件落盘与分享（expo-file-system 新 API + expo-sharing）。
//
// 两种传输路径，默认只走第一种：
//  1. 「分块组装」：电脑端按 `file/meta → file/chunk* → file/end` 推 base64 分块，
//     我们在内存里按序拼接后一次写入。任何 HTTP 代理下都能用，是本项目的默认路径。
//  2. 「HTTP 一次性下载」：`file/meta` 里带 `downloadPath`（电脑端的单次令牌链接）时
//     可以直接下载。省内存，但**未在真机验证**，所以默认关闭（见 PREFER_HTTP_DOWNLOAD）。
//
// 已知限制（README 也写了）：expo-file-system SDK 57 的 FileHandle 分块追加写入我们
// 没有验证过，所以组装阶段是内存里的，`MAX_ASSEMBLY_BYTES` 之前就拦住了大文件。

import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'

import { MAX_ASSEMBLY_BYTES, canAssemble, formatBytes, guessMime, sanitizeFileName, uniqueFileName } from '../core/files.mts'

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
 * 把已完成的分块写进应用目录。
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
    onProgress: progress => onProgress?.(progress.totalBytesWritten, progress.totalBytesExpectedToWrite),
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
