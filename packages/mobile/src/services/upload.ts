// 分块上传的传输实现（原生能力层）。
//
// 协议握手（PROTOCOL-V2 §5 / PLAN 问题 8）：
//   upload/start → upload/ready（电脑端定 chunkBytes / 剩余额度）
//   → upload/chunk（每块等 upload/progress 才能发下一块，背压）
//   → upload/end → upload/done（拿 fileId）
//
// 状态机在 core/upload.mts（纯逻辑、有单测），这里只做：
//  * 读本地文件的分块（优先 FileHandle 分段读，读不了再整体读后切片）；
//  * 发帧 / 等帧（超时、取消、错误）；
//  * 把每次状态变化回调给 UI（进度条）。
//
// 失败重试策略：重试会换一个新的 uploadId 从头传（电脑端的临时文件按 uploadId 隔离，
// 复用旧 id 可能撞上半截残留），所以调用方（ChatController）看到失败后整块重试即可。

import { File, type FileHandle } from 'expo-file-system'

import { bytesToBase64 } from '../core/base64.mts'
import { guessMime } from '../core/files.mts'
import {
  acceptDone,
  acceptError,
  acceptProgress,
  acceptReady,
  cancelUpload as cancelUploadState,
  createUploadState,
  describeUploadFailure,
  isUploadActive,
  markChunkSent,
  markEndSent,
  markStartSent,
  nextChunkPlan,
  readyToEnd,
  uploadGuard,
  uploadIdleExceeded,
  type UploadFailureKind,
  type UploadState,
} from '../core/upload.mts'
import type { ClientFrame, ServerFrame } from '../protocol/types'

/** 等 upload/ready 的上限（电脑端可能正在初始化会话）。 */
const READY_TIMEOUT_MS = 20_000
/** 单块确认的上限：512 KiB base64 在慢速隧道上也不该超过这个数。 */
const CHUNK_TIMEOUT_MS = 60_000
/** 等 upload/done（电脑端落盘 + sha 校验）的上限。 */
const DONE_TIMEOUT_MS = 60_000

export interface UploadRequest {
  uri: string
  name: string
  mime?: string
  size: number
  /** 调用方预生成的 uploadId（让 UI 的附件 chip 能提前关联进度）。 */
  uploadId?: string
}

export interface UploadResult {
  uploadId: string
  fileId: string
  name: string
  size: number
  mime?: string
  path?: string
}

export interface UploadOptions {
  /** 每次状态变化（开始/进度/落盘/失败）都会回调，UI 用它画进度条。 */
  onState?(state: UploadState): void
}

export class UploadCancelledError extends Error {
  readonly kind: UploadFailureKind = 'cancelled'
  constructor() {
    super('上传已取消')
    this.name = 'UploadCancelledError'
  }
}

/** 上传失败（带可重试语义，UI 用它决定给「重试」还是「改设置/换文件」）。 */
export class UploadFailureError extends Error {
  readonly kind: UploadFailureKind
  readonly retryable: boolean
  readonly hint: string
  constructor(kind: UploadFailureKind, message?: string) {
    const failure = describeUploadFailure(kind, message)
    super(message && message.trim() !== '' ? message : failure.hint)
    this.name = 'UploadFailureError'
    this.kind = failure.kind
    this.retryable = failure.retryable
    this.hint = failure.hint
  }
}

/** 把任意上传异常收敛成 UI 可用的失败信息（网络类默认可重试）。 */
export function classifyUploadError(error: unknown): {
  kind: UploadFailureKind
  retryable: boolean
  message: string
  hint: string
} {
  if (error instanceof UploadFailureError) {
    return { kind: error.kind, retryable: error.retryable, message: error.message, hint: error.hint }
  }
  if (error instanceof UploadCancelledError) {
    const failure = describeUploadFailure('cancelled', error.message)
    return { kind: 'cancelled', retryable: false, message: error.message, hint: failure.hint }
  }
  const message = error instanceof Error && error.message ? error.message : '上传失败'
  const failure = describeUploadFailure('network', message)
  return { kind: 'network', retryable: true, message, hint: failure.hint }
}

interface Waiter {
  resolve(frame: ServerFrame): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 一次 App 生命周期内复用的上传客户端：store 把 upload/* 帧喂给 `onFrame`，
 * ChatController 调 `upload()` 发一个附件。
 */
export class UploadClient {
  private readonly send: (frame: ClientFrame) => boolean
  private readonly makeUploadId: () => string
  private readonly waiters = new Map<string, Waiter>()
  private readonly states = new Map<string, UploadState>()
  private readonly files = new Map<string, Uint8Array>()
  private readonly cancelled = new Set<string>()

  constructor(options: { send(frame: ClientFrame): boolean; makeUploadId?: () => string }) {
    this.send = options.send
    this.makeUploadId = options.makeUploadId ?? (() => `upl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  }

  /** 当前所有上传的只读快照（调试/UI 兜底用）。 */
  snapshot(): UploadState[] {
    return [...this.states.values()]
  }

  getState(uploadId: string): UploadState | undefined {
    return this.states.get(uploadId)
  }

  /**
   * store 收到 upload/* 帧后调用。返回被更新的状态（未知 uploadId 返回 undefined）。
   */
  onFrame(frame: ServerFrame): UploadState | undefined {
    const uploadId = typeof (frame as { uploadId?: unknown }).uploadId === 'string' ? (frame as { uploadId: string }).uploadId : ''
    if (!uploadId) return undefined
    const state = this.states.get(uploadId)
    if (frame.t === 'upload/error') {
      // 失败要让正在 await 的那一步立即抛错，而不是干等 60s 超时。
      const message = typeof frame.message === 'string' && frame.message ? frame.message : String(frame.code ?? '上传失败')
      this.rejectWaiter(uploadId, new UploadFailureError('server', message))
    } else {
      this.resolveWaiter(uploadId, frame)
    }
    if (!state) return undefined
    const at = Date.now()
    let next = state
    switch (frame.t) {
      case 'upload/ready':
        next = { ...state, chunkBytes: frame.chunkBytes }
        break
      case 'upload/progress':
        next = acceptProgress(state, frame, at) ?? state
        break
      case 'upload/done':
        next = acceptDone(state, frame, at)
        break
      case 'upload/error':
        next = acceptError(state, frame, at)
        break
      default:
        return undefined
    }
    this.states.set(uploadId, next)
    return next
  }

  /** 取消一个正在进行的上传（UI 可选能力）。 */
  cancel(uploadId: string): void {
    if (!uploadId) return
    this.cancelled.add(uploadId)
    const state = this.states.get(uploadId)
    if (state && isUploadActive(state)) {
      this.states.set(uploadId, cancelUploadState(state, Date.now()))
    }
    try {
      this.send({ t: 'upload/cancel', uploadId })
    } catch {
      // 连接已断：本地取消已经生效，帧发不出去也无所谓。
    }
    this.rejectWaiter(uploadId, new UploadCancelledError())
  }

  /** 连接断开：所有进行中的上传立即失败（调用方会把消息退回待发队列）。 */
  abortAll(reason = '网络已断开，上传中断'): void {
    for (const [uploadId, state] of this.states) {
      if (!isUploadActive(state)) continue
      this.states.set(uploadId, acceptError(state, { message: reason }, Date.now()))
      this.rejectWaiter(uploadId, new UploadFailureError('network', reason))
    }
  }

  dispose(): void {
    for (const uploadId of [...this.waiters.keys()]) this.rejectWaiter(uploadId, new UploadCancelledError())
    this.waiters.clear()
    this.states.clear()
    this.files.clear()
    this.cancelled.clear()
  }

  /**
   * 上传一个附件，成功返回电脑端 fileId。
   * 失败抛错（调用方负责把消息标记失败/重试）；取消抛 UploadCancelledError。
   */
  async upload(request: UploadRequest, options: UploadOptions = {}): Promise<UploadResult> {
    const guard = uploadGuard(request.size)
    if (!guard.ok) throw new UploadFailureError('too-large', guard.message)
    const uploadId = request.uploadId || this.makeUploadId()
    let state = createUploadState({
      uploadId,
      name: request.name || '附件',
      size: request.size,
      mime: request.mime || guessMime(request.name ?? ''),
    })
    this.states.set(uploadId, state)
    const notify = (): void => {
      options.onState?.(state)
    }
    notify()

    try {
      // 1) upload/start —— 先挂 waiter 再发帧，避免电脑端回得比 await 还快时丢帧。
      const readyPromise = this.waitFor(uploadId, 'upload/ready', READY_TIMEOUT_MS)
      state = markStartSent(state, Date.now())
      this.states.set(uploadId, state)
      if (!this.send({ t: 'upload/start', uploadId, name: state.name, size: state.size, mime: state.mime })) {
        this.dropWaiter(uploadId)
        throw new UploadFailureError('network', '连接已断开，无法开始上传')
      }
      const ready = await this.expectType(uploadId, readyPromise, 'upload/ready')
      const accepted = acceptReady(state, { chunkBytes: ready.chunkBytes, maxBytes: ready.maxBytes })
      if (!accepted.ok) throw new UploadFailureError('server', accepted.message)
      state = accepted.state
      this.states.set(uploadId, state)
      notify()

      // 2) 逐块上传（严格背压：上一块没有 upload/progress 不发下一块）。
      let idleGuard = Date.now()
      while (true) {
        this.throwIfCancelled(uploadId)
        if (uploadIdleExceeded(state, Date.now(), 3 * 60 * 1000) || Date.now() - idleGuard > 10 * 60 * 1000) {
          throw new UploadFailureError('network', '上传超时，请检查网络后重试')
        }
        if (readyToEnd(state)) break
        const plan = nextChunkPlan(state)
        if (!plan) {
          // 理论上不该发生：既不能结束又没有下一块，说明状态机被未知帧弄坏了。
          throw new UploadFailureError('server', '上传状态异常，请重试')
        }
        const bytes = await this.readChunkSafe(request.uri, plan.offset, plan.length)
        const progressPromise = this.waitFor(uploadId, 'upload/progress', CHUNK_TIMEOUT_MS)
        state = markChunkSent(state, plan.seq, plan.length, Date.now())
        this.states.set(uploadId, state)
        notify()
        const sent = this.send({
          t: 'upload/chunk',
          uploadId,
          seq: plan.seq,
          dataBase64: bytesToBase64(bytes),
        })
        if (!sent) {
          this.dropWaiter(uploadId)
          throw new UploadFailureError('network', '连接已断开，上传中断')
        }
        const progress = await this.expectType(uploadId, progressPromise, 'upload/progress')
        const advanced = acceptProgress(state, { nextSeq: progress.nextSeq, received: progress.received })
        if (advanced) state = advanced
        idleGuard = Date.now()
        if (state.phase === 'failed') throw new UploadFailureError('server', state.error ?? '上传失败')
        this.states.set(uploadId, state)
        notify()
      }

      // 3) upload/end → upload/done
      this.throwIfCancelled(uploadId)
      const donePromise = this.waitFor(uploadId, 'upload/done', DONE_TIMEOUT_MS)
      state = markEndSent(state, Date.now())
      this.states.set(uploadId, state)
      if (!this.send({ t: 'upload/end', uploadId })) {
        this.dropWaiter(uploadId)
        throw new UploadFailureError('network', '连接已断开，无法完成上传')
      }
      const done = await this.expectType(uploadId, donePromise, 'upload/done')
      state = acceptDone(state, {
        fileId: done.fileId,
        name: done.name,
        size: done.size,
        mime: done.mime,
        path: done.path,
      })
      this.states.set(uploadId, state)
      notify()
      return {
        uploadId,
        fileId: done.fileId,
        name: done.name || state.name,
        size: typeof done.size === 'number' && done.size > 0 ? done.size : state.size,
        mime: done.mime || state.mime,
        path: done.path,
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      const latest = this.states.get(uploadId) ?? state
      if (failure instanceof UploadCancelledError || latest.phase === 'cancelled') {
        // 用户主动取消：保留 cancelled 状态，不要改写成 failed。
        this.states.set(uploadId, cancelUploadState(latest, Date.now()))
      } else {
        // 取消/断线/超时都要把本地状态收敛掉，不能让 UI 一直转圈。
        this.states.set(uploadId, acceptError(latest, { message: failure.message }, Date.now()))
      }
      notify()
      this.rejectWaiter(uploadId, failure)
      throw failure
    } finally {
      this.files.delete(request.uri)
      this.cancelled.delete(uploadId)
    }
  }

  // -------------------------------------------------------------------------

  private throwIfCancelled(uploadId: string): void {
    if (this.cancelled.has(uploadId)) throw new UploadCancelledError()
  }

  /** 注册一个帧等待者（按 uploadId + 帧类型）。 */
  private waitFor(
    uploadId: string,
    type: 'upload/ready' | 'upload/progress' | 'upload/done',
    timeoutMs: number,
  ): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const key = `${uploadId}\u0000${type}`
      const existing = this.waiters.get(key)
      if (existing) {
        clearTimeout(existing.timer)
        existing.reject(new Error('上一个等待已被新的等待取代'))
      }
      const timer = setTimeout(() => {
        this.waiters.delete(key)
        reject(new Error(type === 'upload/ready' ? '电脑端没有响应上传请求（可能插件版本过旧）' : '等待电脑端确认超时'))
      }, timeoutMs)
      this.waiters.set(key, { resolve, reject, timer })
    })
  }

  /** 把 waiter 的通用帧收窄成具体类型；类型不符时按协议错误处理。 */
  private async expectType<K extends 'upload/ready' | 'upload/progress' | 'upload/done'>(
    uploadId: string,
    promise: Promise<ServerFrame>,
    type: K,
  ): Promise<Extract<ServerFrame, { t: K }>> {
    const frame = await promise
    if (frame.t !== type) {
      throw new UploadFailureError('server', `电脑端返回了意外帧：${String(frame.t)}`)
    }
    this.dropWaiter(uploadId, type)
    return frame as Extract<ServerFrame, { t: K }>
  }

  private resolveWaiter(uploadId: string, frame: ServerFrame): void {
    const key = `${uploadId}\u0000${frame.t}`
    const waiter = this.waiters.get(key)
    if (!waiter) return
    // progress 只接受匹配的 uploadId（key 已保证）；resolve 后由 expectType 清理。
    waiter.resolve(frame)
  }

  private dropWaiter(uploadId: string, type?: string): void {
    if (type) {
      const key = `${uploadId}\u0000${type}`
      const waiter = this.waiters.get(key)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.waiters.delete(key)
      }
      return
    }
    for (const [key, waiter] of [...this.waiters.entries()]) {
      if (!key.startsWith(`${uploadId}\u0000`)) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(key)
    }
  }

  private rejectWaiter(uploadId: string, error: Error): void {
    for (const [key, waiter] of [...this.waiters.entries()]) {
      if (!key.startsWith(`${uploadId}\u0000`)) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(key)
      waiter.reject(error)
    }
  }

  /**
   * 读一个分块。优先 FileHandle 分段读（64 MiB 附件不会整体进内存）；
   * 设备/API 不支持时退回「整体读一次 + 切片」，并把整份字节缓存到本次上传结束。
   */
  private async readChunkSafe(uri: string, offset: number, length: number): Promise<Uint8Array> {
    try {
      return await this.readChunk(uri, offset, length)
    } catch (error) {
      // 本地文件被删除/权限变化/读取失败：重试同一个文件也不会好，提示用户重新选择。
      throw new UploadFailureError('local', (error as Error).message)
    }
  }

  private async readChunk(uri: string, offset: number, length: number): Promise<Uint8Array> {
    const file = new File(uri)
    let handle: FileHandle | undefined
    try {
      handle = file.open()
    } catch {
      handle = undefined
    }
    if (handle && typeof handle.readBytes === 'function') {
      try {
        handle.offset = offset
        const bytes = handle.readBytes(length)
        if (bytes && bytes.length > 0) return bytes
      } catch {
        // 分段读失败：落到下面的整体读。
      } finally {
        try {
          handle.close()
        } catch {
          // ignore
        }
      }
    }
    const whole = this.files.get(uri) ?? (await file.bytes())
    this.files.set(uri, whole)
    return whole.subarray(offset, Math.min(whole.length, offset + length))
  }
}
