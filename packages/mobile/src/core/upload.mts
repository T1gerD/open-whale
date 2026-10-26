// 分块上传状态机（纯逻辑）。
//
// 背景：v2.1.0 的附件是「整包 base64 塞进 chat/send」，一张 5 MB 的照片就会变成
// 一个 ~6.7 MB 的 JSON 帧，隧道下必然超时/失败，而且整个文件在手机内存里至少存在
// 三份（原文件 + base64 字符串 + JSON）。v2.2.0 改成上传握手：
//
//   upload/start → upload/ready（电脑端定 chunkBytes / 剩余额度）
//   → 逐块 upload/chunk，每块必须等 upload/progress 的 nextSeq 才能发下一块（背压）
//   → upload/end → upload/done（拿 fileId，放进 chat/send.files[{uploadId}]）
//
// 这个文件只描述「状态怎么变」；真正读文件、发帧、等帧在 services/upload.ts。
// 所有边界条件（序号、背压、重试、取消、大小上限）都在这里测。

import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from './frames.mts'

export type UploadPhase = 'pending' | 'starting' | 'uploading' | 'ending' | 'done' | 'failed' | 'cancelled'

export interface UploadState {
  uploadId: string
  name: string
  size: number
  mime?: string
  phase: UploadPhase
  /** 电脑端允许的分块大小（upload/ready.chunkBytes）。 */
  chunkBytes: number
  /** 下一个要发送的分块序号（= 已被电脑端确认的分块数）。 */
  nextSeq: number
  /** 正在等待 progress 确认的分块序号；undefined 表示可以发下一块。 */
  inflightSeq?: number
  /** 已写入 socket 的字节数（本地视角的进度，可能领先 confirmed）。 */
  sentBytes: number
  /** 电脑端确认收到的字节数。 */
  receivedBytes: number
  /** 上传成功后的电脑端文件 id。 */
  fileId?: string
  /** 电脑端落盘路径（会话 cwd 内，调试/展示用）。 */
  path?: string
  error?: string
  /** 这块附件被重试过几次（重试会换新的 uploadId 从头传）。 */
  attempts: number
  startedAt: number
  updatedAt: number
}

export interface CreateUploadInput {
  uploadId: string
  name: string
  size: number
  mime?: string
  now?: number
}

/**
 * 发送前的体积检查。
 * 协议上限 64 MiB；0 字节文件允许（start→end 直接完成）。
 */
export function uploadGuard(size: unknown): { ok: true } | { ok: false; message: string } {
  const value = typeof size === 'number' && Number.isFinite(size) ? size : NaN
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, message: '无法读取这个文件的大小，换一个文件试试' }
  }
  if (value > MAX_UPLOAD_BYTES) {
    const limit = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)
    return {
      ok: false,
      message: `单个附件上限 ${limit} MB，请压缩/裁剪后再发，或把文件放到电脑上直接打开`,
    }
  }
  return { ok: true }
}

export function createUploadState(input: CreateUploadInput): UploadState {
  const now = input.now ?? Date.now()
  const size = Number.isFinite(input.size) && input.size > 0 ? Math.floor(input.size) : 0
  return {
    uploadId: input.uploadId,
    name: input.name || '附件',
    size,
    mime: input.mime,
    phase: 'pending',
    chunkBytes: UPLOAD_CHUNK_BYTES,
    nextSeq: 0,
    sentBytes: 0,
    receivedBytes: 0,
    attempts: 0,
    startedAt: now,
    updatedAt: now,
  }
}

/** 分块总数（0 字节文件是 0 块）。 */
export function totalChunks(state: Pick<UploadState, 'size' | 'chunkBytes'>): number {
  if (state.size <= 0) return 0
  const chunk = Math.max(1, Math.floor(state.chunkBytes))
  return Math.ceil(state.size / chunk)
}

/** 已确认的分块数。 */
export function confirmedChunks(state: Pick<UploadState, 'nextSeq'>): number {
  return Math.max(0, state.nextSeq)
}

export function markStartSent(state: UploadState, at: number = state.updatedAt): UploadState {
  return { ...state, phase: 'starting', updatedAt: at }
}

export type AcceptReadyResult =
  | { ok: true; state: UploadState }
  | { ok: false; message: string }

/**
 * 处理 `upload/ready`：采用电脑端给的分块大小，并检查剩余额度。
 * 电脑端是权威，但分块大小必须在一个理性范围内（太小=往返爆炸，太大=帧超限）。
 */
export function acceptReady(
  state: UploadState,
  ready: { chunkBytes?: unknown; maxBytes?: unknown },
  at: number = state.updatedAt,
): AcceptReadyResult {
  const raw = typeof ready.chunkBytes === 'number' && Number.isFinite(ready.chunkBytes) ? Math.floor(ready.chunkBytes) : 0
  if (raw <= 0 || raw > 4 * 1024 * 1024) {
    return { ok: false, message: `电脑端给的分块大小不合法（${String(ready.chunkBytes)} 字节）` }
  }
  const maxBytes = typeof ready.maxBytes === 'number' && Number.isFinite(ready.maxBytes) ? ready.maxBytes : undefined
  if (maxBytes !== undefined && maxBytes > 0 && state.size > maxBytes) {
    return { ok: false, message: `电脑端剩余可接收额度不足（还剩 ${Math.round(maxBytes / 1024 / 1024)} MB）` }
  }
  return {
    ok: true,
    state: { ...state, phase: 'uploading', chunkBytes: raw, nextSeq: 0, inflightSeq: undefined, error: undefined, updatedAt: at },
  }
}

export interface ChunkPlan {
  seq: number
  offset: number
  length: number
}

/**
 * 下一块要发送的范围；undefined 表示没有待发分块（可以走 upload/end）。
 * 背压规则：上一块还没被 `upload/progress` 确认时不允许发下一块。
 */
export function nextChunkPlan(state: UploadState): ChunkPlan | undefined {
  if (state.phase !== 'uploading') return undefined
  if (state.inflightSeq !== undefined) return undefined
  const chunk = Math.max(1, Math.floor(state.chunkBytes))
  const total = totalChunks(state)
  if (state.nextSeq >= total) return undefined
  const offset = state.nextSeq * chunk
  return { seq: state.nextSeq, offset, length: Math.max(0, Math.min(chunk, state.size - offset)) }
}

/** 分块写入 socket 成功（还没被确认）。 */
export function markChunkSent(state: UploadState, seq: number, bytes: number, at: number = state.updatedAt): UploadState {
  if (state.inflightSeq !== undefined) return state
  return {
    ...state,
    inflightSeq: seq,
    sentBytes: state.sentBytes + Math.max(0, bytes),
    updatedAt: at,
  }
}

/**
 * 处理 `upload/progress`（背压信号）。
 * `nextSeq` 是电脑端期望的下一块序号，`received` 是已落盘字节数。
 * 返回 undefined 表示这是一个重复/过期的 progress，忽略即可。
 */
export function acceptProgress(
  state: UploadState,
  progress: { nextSeq?: unknown; received?: unknown },
  at: number = state.updatedAt,
): UploadState | undefined {
  const nextSeq = typeof progress.nextSeq === 'number' && Number.isFinite(progress.nextSeq) ? Math.floor(progress.nextSeq) : -1
  if (nextSeq < 0) return undefined
  const received = typeof progress.received === 'number' && Number.isFinite(progress.received) ? Math.max(0, progress.received) : state.receivedBytes
  const expected = state.inflightSeq !== undefined ? state.inflightSeq + 1 : state.nextSeq
  if (nextSeq < expected) {
    // 迟到的确认：只更新已收字节数，不让状态倒退。
    return received > state.receivedBytes ? { ...state, receivedBytes: received, updatedAt: at } : undefined
  }
  if (nextSeq > expected) {
    return { ...state, phase: 'failed', error: `电脑端确认的分块序号跳变（期望 ${expected}，收到 ${nextSeq}）`, updatedAt: at, inflightSeq: undefined }
  }
  return {
    ...state,
    nextSeq,
    inflightSeq: undefined,
    receivedBytes: Math.max(state.receivedBytes, received),
    updatedAt: at,
  }
}

/** 全部分块都已被确认，可以发 upload/end。 */
export function readyToEnd(state: UploadState): boolean {
  return state.phase === 'uploading' && state.inflightSeq === undefined && state.nextSeq >= totalChunks(state)
}

export function markEndSent(state: UploadState, at: number = state.updatedAt): UploadState {
  return { ...state, phase: 'ending', updatedAt: at }
}

export interface UploadDoneInfo {
  fileId: string
  name?: string
  size?: number
  mime?: string
  path?: string
}

export function acceptDone(state: UploadState, done: UploadDoneInfo, at: number = state.updatedAt): UploadState {
  return {
    ...state,
    phase: 'done',
    fileId: done.fileId,
    name: done.name || state.name,
    size: typeof done.size === 'number' && done.size > 0 ? done.size : state.size,
    mime: done.mime || state.mime,
    path: done.path,
    error: undefined,
    receivedBytes: state.size,
    nextSeq: totalChunks(state),
    inflightSeq: undefined,
    updatedAt: at,
  }
}

/** 电脑端 upload/error：标记失败并保留可重试信息。 */
export function acceptError(
  state: UploadState,
  error: { code?: unknown; message?: unknown },
  at: number = state.updatedAt,
): UploadState {
  const message = typeof error.message === 'string' && error.message ? error.message : String(error.code ?? '上传失败')
  return { ...state, phase: 'failed', error: message, inflightSeq: undefined, updatedAt: at }
}

export function cancelUpload(state: UploadState, at: number = state.updatedAt): UploadState {
  if (state.phase === 'done') return state
  return { ...state, phase: 'cancelled', error: undefined, inflightSeq: undefined, updatedAt: at }
}

/** 0–1 的进度；大小未知（0 字节）时按是否完成给 0/1。 */
export function uploadProgress(state: Pick<UploadState, 'receivedBytes' | 'size' | 'phase'>): number {
  if (state.phase === 'done') return 1
  if (!Number.isFinite(state.size) || state.size <= 0) return 0
  return Math.max(0, Math.min(1, state.receivedBytes / state.size))
}

/** 还在占用资源的阶段（UI 显示进度条、断线时标记中断）。 */
export function isUploadActive(state: Pick<UploadState, 'phase'>): boolean {
  return state.phase === 'pending' || state.phase === 'starting' || state.phase === 'uploading' || state.phase === 'ending'
}

/** 失败后是否值得自动重试（取消/成功不值得）。 */
export function canRetryUpload(state: Pick<UploadState, 'phase' | 'attempts'>, maxAttempts = 3): boolean {
  if (state.phase !== 'failed') return false
  return state.attempts < maxAttempts
}

/** 重试退避：1s → 2s → 4s，封顶 8s（上传失败通常立刻重试也没用，但等太久用户会以为卡死）。 */
export function uploadRetryDelayMs(attempt: number): number {
  const index = Math.max(0, Math.floor(attempt))
  return Math.min(8000, 1000 * Math.pow(2, index))
}

/** 上传空闲超时（三分钟没有任何进展就中止，避免临时文件占着电脑端配额）。 */
export function uploadIdleExceeded(state: UploadState, now: number, idleMs: number): boolean {
  if (!isUploadActive(state)) return false
  return now - state.updatedAt > idleMs
}

/** 上传失败原因（决定 UI 给「重试」还是「改设置/换文件」）。 */
export type UploadFailureKind = 'network' | 'server' | 'cancelled' | 'too-large' | 'local'

export interface UploadFailure {
  kind: UploadFailureKind
  /** 自动/手动重试是否可能成功（网络类失败可以，服务端拒绝/文件太大不行）。 */
  retryable: boolean
  /** 追加给用户的原因（原始错误文案已经在 message 里）。 */
  hint: string
}

/**
 * 把上传错误归类成 UI 能直接用的「能不能重试 + 下一步怎么做」。
 *
 * 决策（Lead v2.2.0）：上传失败**不做后台自动重试**（避免重复占用电脑端额度），
 * 但 UI 必须能区分「网络断开（可重试）」和「电脑端拒绝（改设置/换文件）」。
 * @param kind 失败类型
 * @param message 原始错误文案
 */
export function describeUploadFailure(kind: UploadFailureKind, message?: string): UploadFailure {
  const detail = typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined
  switch (kind) {
    case 'cancelled':
      return { kind, retryable: false, hint: '上传已取消，可以重新发送。' }
    case 'too-large':
      return {
        kind,
        retryable: false,
        hint: detail ?? `单个附件上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB，请换一个更小的文件。`,
      }
    case 'server':
      return {
        kind,
        retryable: false,
        hint: detail
          ? `电脑端拒绝了这次上传：${detail}`
          : '电脑端拒绝了这次上传，请到电脑上检查插件状态/磁盘空间，或换一个文件。',
      }
    case 'local':
      return { kind, retryable: false, hint: detail ? `读取本地文件失败：${detail}` : '读取本地文件失败，请重新选择文件。' }
    case 'network':
    default:
      return {
        kind: 'network',
        retryable: true,
        hint: detail ? `网络中断：${detail}。连接恢复后可以点重试。` : '网络中断导致上传失败，连接恢复后可以点重试。',
      }
  }
}

/** 失败类型的中文短标签（气泡/日志用）。 */
export function uploadFailureLabel(kind: UploadFailureKind): string {
  switch (kind) {
    case 'network':
      return '网络断开'
    case 'server':
      return '电脑端拒绝'
    case 'cancelled':
      return '已取消'
    case 'too-large':
      return '文件过大'
    case 'local':
      return '本地文件读取失败'
    default:
      return '上传失败'
  }
}
export function describeUpload(state: Pick<UploadState, 'phase' | 'name' | 'size' | 'receivedBytes' | 'error'>): string {
  const percent = Math.round(uploadProgress({ ...state, phase: 'uploading' }) * 100)
  switch (state.phase) {
    case 'pending':
    case 'starting':
      return `${state.name} · 准备上传…`
    case 'uploading':
      return `${state.name} · 上传中 ${percent}%`
    case 'ending':
      return `${state.name} · 正在电脑端落盘…`
    case 'done':
      return `${state.name} · 已上传`
    case 'cancelled':
      return `${state.name} · 已取消上传`
    case 'failed':
    default:
      return `${state.name} · 上传失败${state.error ? `：${state.error}` : ''}`
  }
}
