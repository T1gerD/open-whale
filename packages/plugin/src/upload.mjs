// 分块上传状态机（手机 → 电脑附件）。
//
// 这一层只做「帧数据 → 磁盘文件」的确定性状态机，不碰 WebSocket，因此可以
// 脱离网络单测。协议契约见 PROTOCOL-V2.md §5：
//  · 512 KiB/块、单附件 64 MiB、每块必须等 `upload/progress` 才能发下一块；
//  · 落盘在**会话工作目录内**的 `.openwhale/uploads/`：DSH 的文件沙箱以工作
//    目录为根，写到别处模型就读不到，这正是「手机发的图片模型看不到」的根因；
//  · 保留原始扩展名（`photo.jpg` 不能变成 `photo`，否则图片工具识别不了）；
//  · 临时名写入、完成后 rename；空闲 3 分钟清理，避免半截文件永久堆在磁盘上。
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

import {
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_IDLE_TIMEOUT_MS,
} from './protocol.mjs'

/** 同时进行中的上传数上限：防止一个异常客户端开无限多临时文件。 */
const MAX_CONCURRENT_UPLOADS = 16

/** 完成后的记录保留多久（`chat/send` 可能晚几秒引用它）；文件本身不删。 */
const DEFAULT_COMPLETED_TTL_MS = 10 * 60 * 1000

/** 上传记录空闲多久清理一次。 */
const CLEANUP_INTERVAL_MS = 60 * 1000

/**
 * @typedef {object} UploadState
 * @property {string} uploadId
 * @property {string} deviceId
 * @property {string} name          Sanitised display/file name (extension kept).
 * @property {number} size
 * @property {string} [mime]
 * @property {string} [expectedSha256]
 * @property {string} tempPath
 * @property {number} received
 * @property {number} nextSeq
 * @property {import('node:crypto').Hash} hash
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} completed
 * @property {string} [path]
 * @property {string} [fileId]
 * @property {string} [sha256]
 */

/**
 * 手机附件上传管理器。
 *
 * 方法都返回判别式结果而不是抛异常：网关需要把失败变成一个 `upload/error`
 * 帧，而不是断开连接。
 */
export class UploadManager {
  /**
   * @param {object} [options]
   * @param {string | (() => string)} [options.dir] 落盘目录（默认在 cwd 下，由网关传入）。
   * @param {(message: string) => void} [options.log]
   * @param {() => number} [options.now]
   * @param {number} [options.idleTimeoutMs]
   * @param {number} [options.completedTtlMs]
   * @param {number} [options.chunkBytes]
   * @param {number} [options.maxBytes]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? (() => join(process.cwd(), '.openwhale', 'uploads'))
    this.log = options.log ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.idleTimeoutMs = options.idleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS
    this.chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_UPLOADS
    /** @type {Map<string, UploadState>} */
    this.uploads = new Map()
    this.cleanedUp = false
    // unref：清理定时器绝不能拖着进程/测试不退出。
    this.timer = setInterval(() => {
      this.cleanup().catch(error => this.log(`upload: cleanup failed: ${/** @type {Error} */ (error).message}`))
    }, CLEANUP_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 当前落盘目录（每次现算：工作目录可能随会话变化）。 */
  directory() {
    return typeof this.dir === 'function' ? this.dir() : this.dir
  }

  /**
   * 开始一次上传。
   * @param {{uploadId: string, deviceId: string, name: string, size: number, mime?: string, sha256?: string}} input
   */
  async start(input) {
    const uploadId = String(input.uploadId ?? '')
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(uploadId)) {
      return { ok: false, code: 'bad-upload-id', message: 'uploadId 格式不合法' }
    }
    const deviceId = String(input.deviceId ?? '')
    if (!deviceId) return { ok: false, code: 'forbidden', message: '缺少设备身份' }
    const size = Number(input.size)
    if (!Number.isInteger(size) || size < 0) {
      return { ok: false, code: 'bad-size', message: '文件大小不合法' }
    }
    if (size > this.maxBytes) {
      return {
        ok: false,
        code: 'too-large',
        message: `文件过大（${(size / 1024 / 1024).toFixed(1)} MB），单附件上限 ${(this.maxBytes / 1024 / 1024).toFixed(0)} MB`,
      }
    }
    const name = sanitizeFileName(input.name)
    const existing = this.uploads.get(uploadId)
    if (existing && existing.deviceId !== deviceId) {
      return { ok: false, code: 'in-use', message: '这个上传 ID 已被其它设备占用' }
    }
    if (existing) {
      // 同一个设备重试 start：丢弃旧的半截文件，从头开始。
      await this.#removeTemp(existing)
      this.uploads.delete(uploadId)
    }
    if (this.uploads.size >= this.maxConcurrent) {
      return { ok: false, code: 'busy', message: '同时进行的上传过多，请稍后再试' }
    }

    const dir = this.directory()
    try {
      await mkdir(dir, { recursive: true })
      const tempPath = join(dir, `.upload-${uploadId}.part`)
      await writeFile(tempPath, Buffer.alloc(0))
      const now = this.now()
      /** @type {UploadState} */
      const state = {
        uploadId,
        deviceId,
        name,
        size,
        mime: typeof input.mime === 'string' && input.mime ? input.mime : undefined,
        expectedSha256: normalizeSha256(input.sha256),
        tempPath,
        received: 0,
        nextSeq: 0,
        hash: createHash('sha256'),
        createdAt: now,
        updatedAt: now,
        completed: false,
      }
      this.uploads.set(uploadId, state)
      this.log(`upload: ${deviceId} 开始上传 ${name}（${size} 字节）`)
      return {
        ok: true,
        ready: { uploadId, chunkBytes: this.chunkBytes, maxBytes: this.maxBytes },
      }
    } catch (error) {
      return { ok: false, code: 'io-error', message: `无法准备上传目录：${/** @type {Error} */ (error).message}` }
    }
  }

  /**
   * 接收一块数据。返回的 `nextSeq` 就是背压信号。
   * @param {{uploadId: string, deviceId: string, seq: number, dataBase64: string}} input
   */
  async chunk(input) {
    const state = this.#owned(input.uploadId, input.deviceId)
    if (!state) return { ok: false, code: 'not-found', message: '找不到这个上传任务' }
    if (state.completed) return { ok: false, code: 'already-completed', message: '该文件已上传完成' }
    const seq = Number(input.seq)
    if (!Number.isInteger(seq) || seq < 0) {
      return { ok: false, code: 'bad-seq', message: '分块序号不合法' }
    }
    if (seq !== state.nextSeq) {
      return {
        ok: false,
        code: 'out-of-order',
        message: `分块顺序错误：期望 ${state.nextSeq}，收到 ${seq}`,
        nextSeq: state.nextSeq,
      }
    }
    if (typeof input.dataBase64 !== 'string') {
      return { ok: false, code: 'bad-frame', message: '分块缺少 dataBase64' }
    }
    const bytes = Buffer.from(input.dataBase64, 'base64')
    if (bytes.length === 0 && state.size > state.received) {
      return { ok: false, code: 'empty-chunk', message: '分块内容为空' }
    }
    if (state.received + bytes.length > state.size) {
      await this.#discard(state)
      return { ok: false, code: 'overflow', message: '收到的数据超过声明的大小，已丢弃该上传' }
    }
    try {
      await appendFile(state.tempPath, bytes)
    } catch (error) {
      await this.#discard(state)
      return { ok: false, code: 'io-error', message: `写入失败：${/** @type {Error} */ (error).message}` }
    }
    state.hash.update(bytes)
    state.received += bytes.length
    state.nextSeq += 1
    state.updatedAt = this.now()
    return {
      ok: true,
      progress: { uploadId: state.uploadId, nextSeq: state.nextSeq, received: state.received },
    }
  }

  /**
   * 收尾：校验大小/可选 sha256，rename 成正式文件。
   * @param {{uploadId: string, deviceId: string, sha256?: string}} input
   */
  async end(input) {
    const state = this.#owned(input.uploadId, input.deviceId)
    if (!state) return { ok: false, code: 'not-found', message: '找不到这个上传任务' }
    if (state.completed) return { ok: true, done: this.#doneFrame(state) }
    if (state.received !== state.size) {
      return {
        ok: false,
        code: 'incomplete',
        message: `上传未完成：已收到 ${state.received}/${state.size} 字节`,
        nextSeq: state.nextSeq,
      }
    }
    const digest = state.hash.digest('hex')
    const expected = normalizeSha256(input.sha256) ?? state.expectedSha256
    if (expected && expected !== digest) {
      await this.#discard(state)
      return { ok: false, code: 'sha256-mismatch', message: '文件校验失败（sha256 不一致），请重新上传' }
    }
    const dir = this.directory()
    const finalPath = join(dir, `${this.now()}-${randomBytes(3).toString('hex')}-${state.name}`)
    try {
      await rename(state.tempPath, finalPath)
    } catch (error) {
      await this.#discard(state)
      return { ok: false, code: 'io-error', message: `保存文件失败：${/** @type {Error} */ (error).message}` }
    }
    state.completed = true
    state.path = finalPath
    state.sha256 = digest
    state.fileId = `f_${randomBytes(9).toString('hex')}`
    state.updatedAt = this.now()
    this.log(`upload: ${state.deviceId} 完成 ${state.name} → ${finalPath}`)
    return { ok: true, done: this.#doneFrame(state) }
  }

  /**
   * 取消并清理临时文件。
   * @param {{uploadId: string, deviceId: string}} input
   */
  async cancel(input) {
    const state = this.#owned(input.uploadId, input.deviceId)
    if (!state) return { ok: false, code: 'not-found', message: '找不到这个上传任务' }
    await this.#discard(state)
    this.log(`upload: ${state.deviceId} 取消上传 ${state.name}`)
    return { ok: true }
  }

  /**
   * 找一个已完成、且属于该设备的上传（`chat/send.files[].uploadId` 用）。
   * @param {string} uploadId
   * @param {string} deviceId
   * @returns {UploadState | undefined}
   */
  completed(uploadId, deviceId) {
    const state = this.#owned(uploadId, deviceId)
    if (!state || !state.completed) return undefined
    return state
  }

  /** 清掉超时的临时文件与过期记录。 */
  async cleanup() {
    if (this.cleanedUp) return
    const now = this.now()
    for (const [uploadId, state] of [...this.uploads]) {
      const idle = now - state.updatedAt
      if (state.completed) {
        if (idle > this.completedTtlMs) this.uploads.delete(uploadId)
        continue
      }
      if (idle > this.idleTimeoutMs) {
        await this.#removeTemp(state)
        this.uploads.delete(uploadId)
        this.log(`upload: 清理空闲上传 ${state.name}`)
      }
    }
  }

  /** 插件卸载时释放定时器并清掉未完成的临时文件。 */
  async dispose() {
    this.cleanedUp = true
    clearInterval(this.timer)
    for (const state of this.uploads.values()) {
      if (!state.completed) await this.#removeTemp(state)
    }
    this.uploads.clear()
  }

  /** @param {string} uploadId @param {string} deviceId @returns {UploadState | undefined} */
  #owned(uploadId, deviceId) {
    const state = this.uploads.get(String(uploadId ?? ''))
    if (!state) return undefined
    if (state.deviceId !== String(deviceId ?? '')) return undefined
    return state
  }

  /** @param {UploadState} state */
  #doneFrame(state) {
    return {
      uploadId: state.uploadId,
      fileId: state.fileId,
      name: state.name,
      size: state.size,
      mime: state.mime,
      path: state.path,
      sha256: state.sha256,
    }
  }

  /** 丢弃一个上传：删临时文件 + 删记录。 @param {UploadState} state */
  async #discard(state) {
    await this.#removeTemp(state)
    this.uploads.delete(state.uploadId)
  }

  /** @param {UploadState} state */
  async #removeTemp(state) {
    try {
      await rm(state.tempPath, { force: true })
    } catch { /* 临时文件可能已经不在 */ }
  }
}

/**
 * 文件名消毒：只保留最后一段名字、去掉控制字符/Windows 保留字符，保留扩展名。
 *
 * 上传来自手机，名字完全不可信：`../../x`、`C:\path\x`、`bad:name?.png` 都必须
 * 落成上传目录里的一个普通文件。
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeFileName(name) {
  let value = String(name ?? '')
  // 先砍掉任何目录部分（Windows 与 POSIX 分隔符都算）。
  value = value.split(/[\\/]/).pop() ?? ''
  value = value.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  value = value.replace(/^\.+/, '')
  if (value === '' || value === '.' || value === '..') return 'upload.bin'
  if (value.length > 180) {
    const ext = extname(value).slice(0, 20)
    value = `${value.slice(0, 180 - ext.length)}${ext}`
  }
  return value
}

/**
 * sha256 归一化：接受 hex（大小写不敏感），其它一律忽略（不回传错误值）。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeSha256(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : undefined
}

/** 常用扩展名 → MIME。手机端靠它决定预览方式，下载路径也用它。 */
const MIME_BY_EXTENSION = Object.freeze({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
})

/**
 * 根据文件名猜 MIME；猜不到用 `application/octet-stream`。
 * @param {string} name
 * @returns {string}
 */
export function guessMimeType(name) {
  const ext = extname(String(name ?? '')).toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

// `stat` is imported for callers that want to verify a landed file, and keeps the
// fs surface explicit here rather than in the gateway.
export { stat }
