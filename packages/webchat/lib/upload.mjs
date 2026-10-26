// 附件上传：小文件 inline，大文件走 upload/start|chunk|end 分块 + 背压。
//
// 背压规则（协议 §5）：**必须**收到 `upload/progress { nextSeq }` 才能发下一块。
// 这里把它实现成一个明确的单块在途状态机，`test/upload.test.mjs` 用假传输驱动，
// 断言「没收到 progress 就不会发第二块」——这是大文件在隧道上不把手机内存打爆的关键。

import {
  INLINE_ATTACHMENT_LIMIT,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
} from './protocol.mjs'
import { hexFromBytes, randomBytes, toBase64 } from './bytes.mjs'

/** 附件传输方式。 */
export const UPLOAD_TRANSPORT = Object.freeze({
  /** 塞进 chat/send.files[].dataBase64（<= 2 MiB）。 */
  INLINE: 'inline',
  /** upload/start → chunk → end。 */
  CHUNKED: 'chunked',
  /** 本机拒绝（太大 / 格式不支持）。 */
  REJECTED: 'rejected',
})

/**
 * 选传输方式：<= 2 MiB 走 inline，其余走分块；超过 64 MiB 直接拒绝。
 * @param {number} size
 * @param {{inlineLimit?: number, maxUploadBytes?: number}} [options]
 * @returns {{transport: string, reason?: string}}
 */
export function chooseTransport(size, options = {}) {
  const bytes = Number(size)
  const inlineLimit = options.inlineLimit ?? INLINE_ATTACHMENT_LIMIT
  const maxBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES
  if (!Number.isFinite(bytes) || bytes <= 0) return { transport: UPLOAD_TRANSPORT.REJECTED, reason: '空文件不能发送' }
  if (bytes > maxBytes) {
    return { transport: UPLOAD_TRANSPORT.REJECTED, reason: `文件过大（${formatMb(bytes)}，上限 ${formatMb(maxBytes)}）` }
  }
  if (bytes <= inlineLimit) return { transport: UPLOAD_TRANSPORT.INLINE }
  return { transport: UPLOAD_TRANSPORT.CHUNKED }
}

/** @param {number} bytes */
function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 图片 mime 判断；没有 mime 时按扩展名兜底（相册文件偶尔给空 mime）。
 * @param {string} mime
 * @param {string} name
 * @returns {boolean}
 */
export function isImageAttachment(mime, name) {
  if (typeof mime === 'string' && mime.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(String(name ?? ''))
}

/**
 * 分块计划：总块数与每块大小。最后一块可能不满。
 * @param {number} size
 * @param {number} [chunkBytes]
 * @returns {{chunkBytes: number, chunkCount: number, lastChunkBytes: number}}
 */
export function planChunks(size, chunkBytes = UPLOAD_CHUNK_BYTES) {
  const total = Math.max(0, Math.floor(Number(size) || 0))
  const chunk = Math.max(1, Math.floor(Number(chunkBytes) || UPLOAD_CHUNK_BYTES))
  const chunkCount = total === 0 ? 0 : Math.ceil(total / chunk)
  return {
    chunkBytes: chunk,
    chunkCount,
    lastChunkBytes: chunkCount === 0 ? 0 : total - (chunkCount - 1) * chunk,
  }
}

/** 上传状态。 */
export const UPLOAD_STATE = Object.freeze({
  IDLE: 'idle',
  WAITING_READY: 'waiting-ready',
  UPLOADING: 'uploading',
  FINISHING: 'finishing',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
})

/**
 * 一个分块上传的单块在途状态机。
 *
 * 用法：
 *   const uploader = new AttachmentUploader({ send, readSlice, onProgress, onDone, onError })
 *   uploader.start({ name, size, mime })
 *   // 每收到一帧都交给 uploader.handleFrame(frame)，返回 true 表示它消费了
 */
export class AttachmentUploader {
  /**
   * @param {object} options
   * @param {(frame: object) => boolean} options.send 发送帧；返回是否真的发出去了
   * @param {(seq: number, offset: number, length: number) => Promise<Uint8Array>} options.readSlice
   * @param {(progress: {received: number, size: number, percent: number, state: string}) => void} [options.onProgress]
   * @param {(result: {fileId?: string, name: string, size: number, mime?: string, path?: string, sha256?: string}) => void} [options.onDone]
   * @param {(error: {code?: string, message: string}) => void} [options.onError]
   * @param {number} [options.chunkBytes] 服务端 upload/ready 之前使用的保守块大小
   * @param {number} [options.maxBytes]
   * @param {() => string} [options.makeUploadId]
   */
  constructor(options) {
    this.send = options.send
    this.readSlice = options.readSlice
    this.onProgress = options.onProgress ?? (() => {})
    this.onDone = options.onDone ?? (() => {})
    this.onError = options.onError ?? (() => {})
    this.chunkBytes = Math.max(1, options.chunkBytes ?? UPLOAD_CHUNK_BYTES)
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES
    this.makeUploadId = options.makeUploadId ?? (() => `up_${hexFromBytes(randomBytes(8))}`)
    this.state = UPLOAD_STATE.IDLE
    this.uploadId = ''
    this.name = ''
    this.size = 0
    this.mime = ''
    /** 下一块要发的 seq。 */
    this.nextSeq = 0
    /** 服务端已确认到的 nextSeq（= 已收块数）；背压的唯一依据。 */
    this.confirmed = 0
    this.received = 0
    this.inFlight = false
    this.error = null
  }

  /**
   * 开始上传：发 `upload/start`，等 `upload/ready`。
   * @param {{name: string, size: number, mime?: string, sha256?: string}} file
   * @returns {{ok: boolean, uploadId?: string, error?: string}}
   */
  start(file) {
    if (this.state !== UPLOAD_STATE.IDLE) return { ok: false, error: '该上传任务已开始' }
    const size = Number(file?.size)
    if (!Number.isFinite(size) || size <= 0) {
      this.#fail({ code: 'empty-file', message: '空文件不能发送' })
      return { ok: false, error: '空文件不能发送' }
    }
    if (size > this.maxBytes) {
      const message = `文件过大（${formatMb(size)}，上限 ${formatMb(this.maxBytes)}）`
      this.#fail({ code: 'too-large', message })
      return { ok: false, error: message }
    }
    this.uploadId = this.makeUploadId()
    this.name = String(file.name ?? '附件')
    this.size = size
    this.mime = String(file.mime ?? '')
    this.state = UPLOAD_STATE.WAITING_READY
    const frame = {
      t: 'upload/start',
      uploadId: this.uploadId,
      name: this.name,
      size: this.size,
    }
    if (this.mime) frame.mime = this.mime
    if (typeof file.sha256 === 'string' && file.sha256 !== '') frame.sha256 = file.sha256
    const sent = this.send(frame)
    if (!sent) {
      this.#fail({ code: 'offline', message: '连接已断开，上传未开始' })
      return { ok: false, error: '连接已断开，上传未开始' }
    }
    return { ok: true, uploadId: this.uploadId }
  }

  /**
   * 处理与本次上传相关的服务端帧。返回 true 表示本帧被消费。
   * @param {any} frame
   * @returns {boolean}
   */
  handleFrame(frame) {
    if (!frame || typeof frame.t !== 'string') return false
    const uploadId = String(frame.uploadId ?? '')
    if (uploadId !== '' && uploadId !== this.uploadId) return false
    switch (frame.t) {
      case 'upload/ready': {
        if (this.state !== UPLOAD_STATE.WAITING_READY) return true
        const serverChunk = Number(frame.chunkBytes)
        if (Number.isFinite(serverChunk) && serverChunk > 0) this.chunkBytes = Math.min(serverChunk, UPLOAD_CHUNK_BYTES)
        const maxBytes = Number(frame.maxBytes)
        if (Number.isFinite(maxBytes) && maxBytes > 0 && this.size > maxBytes) {
          this.#fail({ code: 'too-large', message: `电脑端剩余空间不足（上限 ${formatMb(maxBytes)}）` })
          return true
        }
        this.state = UPLOAD_STATE.UPLOADING
        this.#pump()
        return true
      }
      case 'upload/progress': {
        const nextSeq = Number(frame.nextSeq)
        if (Number.isFinite(nextSeq)) {
          // 幂等：progress 可能重复/乱序，confirmed 只增不减。
          if (nextSeq > this.confirmed) this.confirmed = nextSeq
        }
        const received = Number(frame.received)
        if (Number.isFinite(received) && received >= this.received) this.received = received
        this.inFlight = false
        this.#emitProgress()
        if (this.state === UPLOAD_STATE.UPLOADING) this.#pump()
        return true
      }
      case 'upload/done': {
        this.state = UPLOAD_STATE.DONE
        this.received = this.size
        this.#emitProgress()
        this.onDone({
          fileId: String(frame.fileId ?? ''),
          name: String(frame.name ?? this.name),
          size: Number.isFinite(Number(frame.size)) ? Number(frame.size) : this.size,
          mime: typeof frame.mime === 'string' ? frame.mime : this.mime,
          ...(typeof frame.path === 'string' ? { path: frame.path } : {}),
          ...(typeof frame.sha256 === 'string' ? { sha256: frame.sha256 } : {}),
        })
        return true
      }
      case 'upload/error': {
        this.#fail({
          code: typeof frame.code === 'string' ? frame.code : undefined,
          message: String(frame.message ?? '上传失败'),
        })
        return true
      }
      default:
        return false
    }
  }

  /**
   * 取消上传（已完成后调用无效）。
   * @returns {boolean}
   */
  cancel() {
    if (this.state === UPLOAD_STATE.DONE || this.state === UPLOAD_STATE.ERROR || this.state === UPLOAD_STATE.CANCELLED) {
      return false
    }
    this.send({ t: 'upload/cancel', uploadId: this.uploadId })
    this.state = UPLOAD_STATE.CANCELLED
    return true
  }

  /** 下一块：背压在途时等待；全部块被确认后才发 `upload/end`。 */
  #pump() {
    if (this.state !== UPLOAD_STATE.UPLOADING) return
    const plan = planChunks(this.size, this.chunkBytes)
    // 服务端每确认一块，confirmed 就前进一格；只有 nextSeq <= confirmed 才允许再发一块。
    if (this.nextSeq < plan.chunkCount && this.nextSeq <= this.confirmed && !this.inFlight) {
      const seq = this.nextSeq
      const offset = seq * this.chunkBytes
      const length = Math.min(this.chunkBytes, this.size - offset)
      this.inFlight = true
      this.nextSeq = seq + 1
      Promise.resolve()
        .then(() => this.readSlice(seq, offset, length))
        .then(bytes => {
          if (this.state !== UPLOAD_STATE.UPLOADING) return
          const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
          if (chunk.length !== length) throw new Error(`第 ${seq + 1} 块读取长度不符（${chunk.length}/${length}）`)
          this.send({
            t: 'upload/chunk',
            uploadId: this.uploadId,
            seq,
            dataBase64: toBase64(chunk),
          })
        })
        .catch(error => {
          this.#fail({ code: 'read-failed', message: `读取文件失败：${/** @type {Error} */ (error).message}` })
        })
      return
    }
    if (this.nextSeq >= plan.chunkCount && this.confirmed >= plan.chunkCount) {
      this.state = UPLOAD_STATE.FINISHING
      this.inFlight = true
      this.send({ t: 'upload/end', uploadId: this.uploadId })
    }
  }

  #emitProgress() {
    this.onProgress({
      received: this.received,
      size: this.size,
      percent: this.size > 0 ? Math.min(100, Math.round((this.received / this.size) * 100)) : 0,
      state: this.state,
    })
  }

  /** @param {{code?: string, message: string}} error */
  #fail(error) {
    if (this.state === UPLOAD_STATE.DONE || this.state === UPLOAD_STATE.ERROR) return
    this.state = UPLOAD_STATE.ERROR
    this.error = error
    this.onError(error)
  }
}

/**
 * 把浏览器 File 切成可读的块（注入给 AttachmentUploader.readSlice）。
 * @param {Blob} blob
 * @returns {(seq: number, offset: number, length: number) => Promise<Uint8Array>}
 */
export function createBlobSliceReader(blob) {
  return async (_seq, offset, length) => {
    const buffer = await blob.slice(offset, offset + length).arrayBuffer()
    return new Uint8Array(buffer)
  }
}

/**
 * 把 File 读成 base64（inline 附件用）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function readBlobAsBase64(blob) {
  const buffer = await blob.arrayBuffer()
  return toBase64(new Uint8Array(buffer))
}

/**
 * 一串附件按顺序上传，一次只跑一个（手机流量/内存都有限）。
 * 这里只提供顺序调度所需的纯逻辑：把任务切成队列并汇总进度。
 * @param {Array<{size: number, name: string}>} files
 * @returns {{items: Array<{index: number, name: string, startPercent: number, endPercent: number}>}}
 */
export function planAttachmentProgress(files) {
  const list = Array.isArray(files) ? files : []
  const total = list.reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0)
  let consumed = 0
  const items = list.map((file, index) => {
    const size = Math.max(0, Number(file?.size) || 0)
    const startPercent = total > 0 ? (consumed / total) * 100 : 0
    consumed += size
    const endPercent = total > 0 ? (consumed / total) * 100 : 100
    return { index, name: String(file?.name ?? '附件'), startPercent, endPercent }
  })
  return { items }
}
