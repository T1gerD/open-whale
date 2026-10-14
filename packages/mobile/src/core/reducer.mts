// 聊天状态 reducer（纯逻辑，本模块是整个 App 的业务核心）。
//
// 设计要点：
//  1. reducer 只吃“事件”，只吐“新状态 + 副作用”，不做任何 I/O——文件落盘、发帧、
//     写数据库都在服务层按 effects 执行。这样网络与磁盘都没法让状态机变得不可测。
//  2. 消息 id 是**确定性**的（用户消息 `usr_<rid>`，助手消息 `msg_<callId>`），
//     所以断线重连后重复收到的帧不会造出第二条消息，写库也能直接用 upsert。
//  3. `chat/tool` 只累积成 assistant 消息里的**活动行**（activity），永远不写进
//     `text`：工具调用不是助理在说话，语义混了以后 UI 就没法正确渲染。
//  4. delta 按 `seq` 聚合：重复/迟到的丢弃，缺口先缓存、补齐后连续 flush；
//     `chat/done` 的完整文本是权威的，到达时直接覆盖并清空缓冲。

import { base64ByteLength } from './files.mts'
import { MAX_FILE_BYTES, SERVER_FRAME } from './frames.mts'

export type MessageKind = 'user' | 'assistant' | 'system'
export type MessageSendState = 'pending' | 'sent' | 'failed'
export type ActivityPhase = 'thinking' | 'tool-start' | 'tool-end'

/** 文件引用（助手产出的文件，或用户附件在本地聊天流里的回显）。 */
export interface FileRef {
  fileId: string
  name: string
  size: number
  mime?: string
}

export interface ActivityItem {
  id: string
  callId: string
  phase: ActivityPhase
  tool: string
  summary?: string
  ok?: boolean
  at: number
}

export interface ChatMessage {
  id: string
  kind: MessageKind
  text: string
  at: number
  /** 助手消息：对应的 callId；用户消息：发送后电脑端分配的 callId。 */
  callId?: string
  /** 用户消息：请求 id（幂等键，离线队列按它去重）。 */
  rid?: string
  state?: MessageSendState
  /** 用户消息：附件回显（只留元信息，不留 base64）。 */
  files?: FileRef[]
  /** 助手消息是否还在流式输出。 */
  streaming?: boolean
  /** 断线时把还在流的消息标记为中断，UI 提示“内容可能不完整”。 */
  interrupted?: boolean
  truncated?: boolean
  durationMs?: number
  error?: string
  /** 助手消息内的小活动行，按到达顺序。 */
  activity?: ActivityItem[]
  /** 已连续消费到的 delta 序号。 */
  deltaSeq?: number
  /** 因序号缺口跳过的 delta 数。 */
  deltaGaps?: number
  /** 自动重发次数。 */
  attempts?: number
  level?: 'info' | 'error'
}

export type TransferStatus =
  | 'offered'
  | 'queued'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'too-large'

export interface Transfer {
  fileId: string
  name: string
  size: number
  mime?: string
  status: TransferStatus
  receivedBytes: number
  /** 下一个期望的分块序号；strictly 递增，乱序即判定失败。 */
  nextSeq: number
  chunks: number
  localPath?: string
  error?: string
  updatedAt: number
}

export interface ChatState {
  assistantId: string
  messages: ChatMessage[]
  /** callId → 助手消息 id 的索引，避免每条 delta 都线性搜索。 */
  callIndex: Record<string, string>
  transfers: Record<string, Transfer>
  typing: { callId: string; active: boolean } | null
  /** callId → 已消费到的最大 seq。 */
  lastSeq: Record<string, number>
  /** 乱序到达、等待补缺的 delta（callId → seq → text）。 */
  deltaBuffers: Record<string, Record<number, string>>
  /** 累计缺口次数，用来在 UI 上提示“内容可能不完整”。 */
  gapCount: number
  lastEventAt: number
}

export type ChatEffect =
  | { kind: 'file-chunk'; fileId: string; seq: number; dataBase64: string }
  | { kind: 'file-complete'; fileId: string }
  | { kind: 'file-abort'; fileId: string; reason: string }
  | { kind: 'fetch-file'; fileId: string }
  | { kind: 'cancel-file'; fileId: string }

/** 服务端帧事件（字段与 protocol 一致；未知帧在服务层就被过滤掉了）。 */
export type WireEvent =
  | { t: 'chat/ack'; rid?: string; callId?: string; cancelled?: boolean; at?: number }
  | { t: 'chat/delta'; callId: string; seq: number; text: string; at?: number }
  | {
      t: 'chat/done'
      callId: string
      text: string
      truncated?: boolean
      durationMs?: number
      files?: FileRef[]
      at?: number
    }
  | {
      t: 'chat/tool'
      callId: string
      phase: 'tool-start' | 'tool-end'
      toolCallId: string
      tool: string
      summary?: string
      ok?: boolean
      at?: number
    }
  | { t: 'chat/typing'; callId: string; active?: boolean; at?: number }
  | { t: 'chat/error'; callId?: string; message: string; retryable?: boolean; at?: number }
  | { t: 'file/meta'; fileId: string; name: string; size: number; mime?: string; at?: number }
  | { t: 'file/chunk'; fileId: string; seq: number; dataBase64: string; at?: number }
  | { t: 'file/end'; fileId: string; seq?: number; at?: number }
  | { t: 'file/error'; fileId: string; code?: string; message?: string; at?: number }

/** 本地事件：用户操作与连接生命周期。 */
export type LocalEvent =
  | { t: 'state/hydrate'; messages: ChatMessage[]; transfers?: Transfer[]; at: number }
  | {
      t: 'user/send'
      rid: string
      text: string
      files?: FileRef[]
      at: number
    }
  | { t: 'outbox/acked'; rid: string; callId?: string; at?: number }
  | { t: 'outbox/failed'; rid: string; reason: string; at: number }
  | { t: 'outbox/retry'; rid: string; at: number }
  | { t: 'conn/disconnected'; at: number; reason?: string }
  | { t: 'conn/connected'; at: number }
  | { t: 'transfer/request'; fileId: string; at: number }
  | { t: 'transfer/cancel'; fileId: string; at: number }
  | { t: 'transfer/saved'; fileId: string; path: string; at: number }
  | { t: 'transfer/failed'; fileId: string; reason: string; at: number }
  | { t: 'transfer/offered'; files: FileRef[]; at: number }

export type ChatEvent = WireEvent | LocalEvent

export interface ReduceResult {
  state: ChatState
  effects: ChatEffect[]
}

/** 服务层用它把未知帧挡在 reducer 之外（协议规定双方都必须忽略未知帧）。 */
export function isKnownServerFrame(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const t = (value as { t?: unknown }).t
  return typeof t === 'string' && (KNOWN_SERVER_FRAMES as readonly string[]).includes(t)
}

const KNOWN_SERVER_FRAMES = [
  SERVER_FRAME.CHAT_ACK,
  SERVER_FRAME.CHAT_DELTA,
  SERVER_FRAME.CHAT_DONE,
  SERVER_FRAME.CHAT_ERROR,
  SERVER_FRAME.TOOL,
  SERVER_FRAME.TYPING,
  SERVER_FRAME.FILE_META,
  SERVER_FRAME.FILE_CHUNK,
  SERVER_FRAME.FILE_END,
  SERVER_FRAME.FILE_ERROR,
] as const

export function emptyChatState(assistantId: string): ChatState {
  return {
    assistantId,
    messages: [],
    callIndex: {},
    transfers: {},
    typing: null,
    lastSeq: {},
    deltaBuffers: {},
    gapCount: 0,
    lastEventAt: 0,
  }
}

/**
 * 从持久化数据恢复状态。
 * 仍在流式输出中的助手消息保留 `streaming: true` 并标记 `interrupted: true`：
 * 电脑端的同一次回答在重连后可能继续推 delta，`deltaSeq` 会被恢复成
 * `lastSeq`，所以已经收到的增量不会被重复追加。
 */
export function hydrateChat(
  assistantId: string,
  messages: ChatMessage[],
  transfers: Transfer[] = [],
  now: number = Date.now(),
): ChatState {
  const state = emptyChatState(assistantId)
  const callIndex: Record<string, string> = {}
  const lastSeq: Record<string, number> = {}
  const restored = messages
    .filter(message => message && typeof message.id === 'string')
    .map(message => {
      const next = { ...message }
      if (next.kind === 'assistant') {
        if (next.callId) callIndex[next.callId] = next.id
        if (next.callId && typeof next.deltaSeq === 'number') lastSeq[next.callId] = next.deltaSeq
        if (next.streaming) next.interrupted = true
      }
      return next
    })
    .sort((a, b) => a.at - b.at)
  const transferMap: Record<string, Transfer> = {}
  for (const transfer of transfers) {
    if (!transfer || typeof transfer.fileId !== 'string') continue
    // 上次没跑完的下载在重启后不可能继续：直接标失败，允许用户重新点下载。
    transferMap[transfer.fileId] =
      transfer.status === 'downloading' || transfer.status === 'queued'
        ? { ...transfer, status: 'failed', error: '应用重启，传输已中断' }
        : transfer
  }
  return { ...state, messages: restored, callIndex, lastSeq, transfers: transferMap, lastEventAt: now }
}

/** 聊天状态可 JSON 往返（用于进度快照/调试面板）。 */
export function serializeChatState(state: ChatState): string {
  return JSON.stringify(state)
}

export function deserializeChatState(text: string, assistantId: string, now: number = Date.now()): ChatState {
  try {
    const parsed = JSON.parse(text) as ChatState
    if (!parsed || !Array.isArray(parsed.messages)) return emptyChatState(assistantId)
    return hydrateChat(assistantId, parsed.messages, Object.values(parsed.transfers ?? {}), now)
  } catch {
    return emptyChatState(assistantId)
  }
}

/** reducer 主入口。未知事件（含未知帧）一律原样返回，绝不抛错。 */
export function reduceChat(state: ChatState, event: ChatEvent, now: number = Date.now()): ReduceResult {
  const at = eventAt(event, now)
  const none: ChatEffect[] = []
  switch (event.t) {
    case 'state/hydrate':
      return { state: hydrateChat(state.assistantId, event.messages, event.transfers ?? [], at), effects: none }

    case 'conn/connected':
      return { state: { ...state, lastEventAt: at }, effects: none }

    case 'conn/disconnected': {
      // 断线时把仍在流式输出的助手消息标成“可能不完整”，但保留 streaming，
      // 因为重连后同一次回答可能继续；done 到达时会清掉标记。
      const messages = state.messages.map(message =>
        message.kind === 'assistant' && message.streaming ? { ...message, interrupted: true } : message,
      )
      return { state: { ...state, messages, typing: null, lastEventAt: at }, effects: none }
    }

    case 'user/send': {
      const id = userMessageId(event.rid)
      const existing = state.messages.find(message => message.id === id)
      const message: ChatMessage = existing
        ? { ...existing, text: event.text, files: event.files ?? existing.files, state: 'pending', at: event.at }
        : {
            id,
            kind: 'user',
            text: event.text,
            at: event.at,
            rid: event.rid,
            state: 'pending',
            files: event.files,
          }
      const messages = existing
        ? state.messages.map(item => (item.id === id ? message : item))
        : [...state.messages, message]
      return { state: { ...state, messages, lastEventAt: at }, effects: none }
    }

    case 'outbox/acked': {
      if (!event.rid) return { state: { ...state, lastEventAt: at }, effects: none }
      const id = userMessageId(event.rid)
      const messages = state.messages.map(message =>
        message.id === id
          ? { ...message, state: 'sent' as MessageSendState, callId: event.callId ?? message.callId }
          : message,
      )
      const withAck: ChatState = { ...state, messages, lastEventAt: at }
      if (event.cancelled) {
        return {
          state: appendSystem(withAck, '已取消本次回答', at, 'info'),
          effects: none,
        }
      }
      return { state: withAck, effects: none }
    }

    case 'outbox/failed': {
      const id = userMessageId(event.rid)
      const messages = state.messages.map(message =>
        message.id === id ? { ...message, state: 'failed' as MessageSendState, error: event.reason } : message,
      )
      return { state: { ...state, messages, lastEventAt: at }, effects: none }
    }

    case 'outbox/retry': {
      const id = userMessageId(event.rid)
      const messages = state.messages.map(message =>
        message.id === id
          ? {
              ...message,
              state: 'pending' as MessageSendState,
              attempts: (message.attempts ?? 0) + 1,
              error: undefined,
            }
          : message,
      )
      return { state: { ...state, messages, lastEventAt: at }, effects: none }
    }

    case 'chat/ack':
      return reduceChat(state, { t: 'outbox/acked', rid: event.rid ?? '', callId: event.callId, cancelled: event.cancelled, at }, at)

    case 'chat/delta': {
      const next = applyDelta(state, event.callId, event.seq, event.text, at)
      return { state: { ...next, lastEventAt: at }, effects: none }
    }

    case 'chat/done': {
      let next = patchAssistant(
        state,
        event.callId,
        message => ({
          ...message,
          text: typeof event.text === 'string' ? event.text : message.text,
          streaming: false,
          interrupted: false,
          truncated: Boolean(event.truncated),
          durationMs: event.durationMs,
          deltaGaps: undefined,
        }),
        at,
      )
      next = clearDeltaBuffer(next, event.callId)
      // done 之后这个 callId 不会再产生增量：把序号推到上限，
      // 这样任何迟到的 delta 都会被丢弃，不会污染权威文本。
      next = { ...next, lastSeq: { ...next.lastSeq, [event.callId]: Number.MAX_SAFE_INTEGER } }
      // done 可能带上助手产出的文件：登记成可下载的卡片。
      const files = (event.files ?? []).filter(file => file && typeof file.fileId === 'string')
      if (files.length > 0) {
        next = upsertTransfers(
          next,
          files.map(file => ({ ...file, status: 'offered' as TransferStatus })),
          at,
        )
      }
      return { state: { ...next, typing: typingAfter(next.typing, event.callId), lastEventAt: at }, effects: none }
    }

    case 'chat/tool': {
      // 工具调用只生成活动行。这一步是“不要渲染成助理说话”的硬保证。
      const id = `${event.toolCallId}:${event.phase}`
      const next = patchAssistant(
        state,
        event.callId,
        message => {
          const activity = message.activity ?? []
          const index = activity.findIndex(item => item.id === id)
          const item: ActivityItem = {
            id,
            callId: event.callId,
            phase: event.phase,
            tool: event.tool,
            summary: event.summary,
            ok: event.ok,
            at,
          }
          const merged = index >= 0 ? activity.map((old, i) => (i === index ? item : old)) : [...activity, item]
          return { ...message, activity: merged }
        },
        at,
      )
      return { state: { ...next, lastEventAt: at }, effects: none }
    }

    case 'chat/typing': {
      // active 缺省按 true 处理：电脑端也可能只在“开始输入”时发这一帧。
      const typing = event.active === false ? null : { callId: event.callId, active: true }
      return { state: { ...state, typing, lastEventAt: at }, effects: none }
    }

    case 'chat/error': {
      if (!event.callId) {
        return { state: appendSystem(state, event.message, at, 'error'), effects: none }
      }
      const next = patchAssistant(
        state,
        event.callId,
        message => ({ ...message, error: event.message, streaming: false, interrupted: true }),
        at,
      )
      return { state: { ...next, typing: typingAfter(next.typing, event.callId), lastEventAt: at }, effects: none }
    }

    case 'file/meta': {
      const size = typeof event.size === 'number' && event.size >= 0 ? event.size : 0
      const tooLarge = size > MAX_FILE_BYTES
      const next = upsertTransfer(
        state,
        {
          fileId: event.fileId,
          name: event.name || event.fileId,
          size,
          mime: event.mime,
          status: tooLarge ? 'too-large' : 'downloading',
          receivedBytes: 0,
          nextSeq: 0,
          chunks: 0,
          error: tooLarge
            ? `文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB 上限`
            : undefined,
        },
        at,
      )
      return {
        state: { ...next, lastEventAt: at },
        effects: tooLarge ? [{ kind: 'file-abort', fileId: event.fileId, reason: 'too-large' }] : none,
      }
    }

    case 'file/chunk': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) {
        // 没见过 meta 就收到分块：不猜测文件内容，明确失败比写坏文件好。
        return { state: { ...state, lastEventAt: at }, effects: [{ kind: 'file-abort', fileId: event.fileId, reason: 'missing-meta' }] }
      }
      if (event.seq < transfer.nextSeq) {
        // 重复分块：丢弃，不重复计数也不重复写入。
        return { state: { ...state, lastEventAt: at }, effects: none }
      }
      if (event.seq > transfer.nextSeq) {
        // 序号跳变说明中间丢块，拼出来的文件一定是坏的：直接判失败。
        const reason = `分块序号跳变（期望 ${transfer.nextSeq}，收到 ${event.seq}）`
        const next = upsertTransfer(state, { ...transfer, status: 'failed', error: reason }, at)
        return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'file-abort', fileId: event.fileId, reason }] }
      }
      const bytes = typeof event.dataBase64 === 'string' ? base64ByteLength(event.dataBase64) : 0
      const receivedBytes = transfer.receivedBytes + bytes
      const overSize = transfer.size > 0 && receivedBytes > transfer.size
      const next = upsertTransfer(
        state,
        {
          ...transfer,
          receivedBytes,
          nextSeq: transfer.nextSeq + 1,
          chunks: transfer.chunks + 1,
          status: overSize ? 'failed' : 'downloading',
          error: overSize ? '收到的数据比声明的大小还多，已中止' : transfer.error,
        },
        at,
      )
      return {
        state: { ...next, lastEventAt: at },
        effects: overSize
          ? [{ kind: 'file-abort', fileId: event.fileId, reason: 'size-overflow' }]
          : [{ kind: 'file-chunk', fileId: event.fileId, seq: event.seq, dataBase64: event.dataBase64 }],
      }
    }

    case 'file/end': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) return { state: { ...state, lastEventAt: at }, effects: [{ kind: 'file-abort', fileId: event.fileId, reason: 'missing-meta' }] }
      const complete = transfer.size === 0 || transfer.receivedBytes >= transfer.size
      if (!complete) {
        const reason = `传输不完整：${transfer.receivedBytes}/${transfer.size} 字节`
        const next = upsertTransfer(state, { ...transfer, status: 'failed', error: reason }, at)
        return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'file-abort', fileId: event.fileId, reason }] }
      }
      const next = upsertTransfer(state, { ...transfer, status: 'done', error: undefined }, at)
      return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'file-complete', fileId: event.fileId }] }
    }

    case 'file/error': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) return { state: { ...state, lastEventAt: at }, effects: none }
      const next = upsertTransfer(
        state,
        { ...transfer, status: 'failed', error: event.message || event.code || '下载失败' },
        at,
      )
      return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'file-abort', fileId: event.fileId, reason: event.code ?? 'error' }] }
    }

    case 'transfer/offered': {
      const next = upsertTransfers(
        state,
        event.files.map(file => ({ ...file, status: 'offered' as TransferStatus })),
        at,
      )
      return { state: { ...next, lastEventAt: at }, effects: none }
    }

    case 'transfer/request': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) return { state: { ...state, lastEventAt: at }, effects: [{ kind: 'fetch-file', fileId: event.fileId }] }
      if (transfer.status === 'downloading' || transfer.status === 'queued') {
        return { state: { ...state, lastEventAt: at }, effects: none }
      }
      if (transfer.status === 'too-large') {
        return { state: { ...state, lastEventAt: at }, effects: none }
      }
      const next = upsertTransfer(
        state,
        { ...transfer, status: 'queued', receivedBytes: 0, nextSeq: 0, chunks: 0, error: undefined, localPath: undefined },
        at,
      )
      return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'fetch-file', fileId: event.fileId }] }
    }

    case 'transfer/cancel': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) return { state: { ...state, lastEventAt: at }, effects: none }
      const next = upsertTransfer(state, { ...transfer, status: 'cancelled', error: undefined }, at)
      return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'cancel-file', fileId: event.fileId }] }
    }

    case 'transfer/saved': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) return { state: { ...state, lastEventAt: at }, effects: none }
      const next = upsertTransfer(state, { ...transfer, localPath: event.path, status: 'done' }, at)
      return { state: { ...next, lastEventAt: at }, effects: none }
    }

    case 'transfer/failed': {
      const transfer = state.transfers[event.fileId]
      if (!transfer) return { state: { ...state, lastEventAt: at }, effects: none }
      const next = upsertTransfer(state, { ...transfer, status: 'failed', error: event.reason }, at)
      return { state: { ...next, lastEventAt: at }, effects: none }
    }

    default:
      // 未知事件/未知帧：按协议要求忽略，且必须让连接继续。
      return { state, effects: none }
  }
}

/** delta 聚合：重复丢弃、缺口缓存、连续 flush。 */
function applyDelta(state: ChatState, callId: string, seq: number, text: string, at: number): ChatState {
  if (!callId || typeof seq !== 'number' || !Number.isFinite(seq)) return state
  const last = state.lastSeq[callId] ?? -1
  if (seq <= last) return state
  const buffered = { ...(state.deltaBuffers[callId] ?? {}) }
  if (seq > last + 1) {
    buffered[seq] = text
    const withBuffer = patchAssistant(
      state,
      callId,
      message => ({ ...message, deltaGaps: (message.deltaGaps ?? 0) + 1, streaming: true, interrupted: false }),
      at,
    )
    return {
      ...withBuffer,
      deltaBuffers: { ...withBuffer.deltaBuffers, [callId]: buffered },
      gapCount: withBuffer.gapCount + 1,
    }
  }
  let cursor = seq
  const pieces = [text]
  while (buffered[cursor + 1] !== undefined) {
    cursor += 1
    pieces.push(buffered[cursor]!)
    delete buffered[cursor]
  }
  const merged = pieces.join('')
  const next = patchAssistant(
    state,
    callId,
    message => ({
      ...message,
      text: message.text + merged,
      streaming: true,
      interrupted: false,
      deltaSeq: cursor,
    }),
    at,
  )
  return {
    ...next,
    lastSeq: { ...next.lastSeq, [callId]: cursor },
    deltaBuffers: { ...next.deltaBuffers, [callId]: buffered },
  }
}

function clearDeltaBuffer(state: ChatState, callId: string): ChatState {
  const deltaBuffers = { ...state.deltaBuffers }
  delete deltaBuffers[callId]
  return { ...state, deltaBuffers }
}

function patchAssistant(
  state: ChatState,
  callId: string,
  update: (message: ChatMessage) => ChatMessage,
  at: number,
): ChatState {
  const id = state.callIndex[callId] ?? assistantMessageId(callId)
  const existing = state.messages.find(message => message.id === id)
  if (!existing) {
    const created: ChatMessage = {
      id,
      kind: 'assistant',
      text: '',
      at,
      callId,
      streaming: true,
      activity: [],
    }
    return {
      ...state,
      messages: [...state.messages, update(created)],
      callIndex: { ...state.callIndex, [callId]: id },
    }
  }
  return {
    ...state,
    messages: state.messages.map(message => (message.id === id ? update(message) : message)),
  }
}

function appendSystem(state: ChatState, text: string, at: number, level: 'info' | 'error'): ChatState {
  const message: ChatMessage = {
    id: `sys_${at}_${state.messages.length}`,
    kind: 'system',
    text,
    at,
    level,
  }
  return { ...state, messages: [...state.messages, message] }
}

/** 把一批文件登记成可下载卡片；已有进度或已完成的条目不被元信息覆盖。 */
function upsertTransfers(
  state: ChatState,
  files: Array<FileRef & { status: TransferStatus; error?: string }>,
  at: number,
): ChatState {
  let next = state
  for (const file of files) {
    const existing = next.transfers[file.fileId]
    if (existing && (existing.status === 'downloading' || existing.status === 'done' || existing.status === 'queued')) continue
    next = upsertTransfer(
      next,
      {
        fileId: file.fileId,
        name: file.name,
        size: file.size,
        mime: file.mime,
        status: file.status,
        receivedBytes: existing?.receivedBytes ?? 0,
        nextSeq: existing?.nextSeq ?? 0,
        chunks: existing?.chunks ?? 0,
        localPath: existing?.localPath,
        error: file.error,
      },
      at,
    )
  }
  return next
}

function upsertTransfer(state: ChatState, transfer: Omit<Transfer, 'updatedAt'>, at: number): ChatState {
  return {
    ...state,
    transfers: { ...state.transfers, [transfer.fileId]: { ...transfer, updatedAt: at } },
  }
}

function typingAfter(typing: ChatState['typing'], callId: string): ChatState['typing'] {
  if (!typing) return null
  return typing.callId === callId ? null : typing
}

function eventAt(event: { at?: number }, fallback: number): number {
  return typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : fallback
}

export function userMessageId(rid: string): string {
  return `usr_${rid}`
}

export function assistantMessageId(callId: string): string {
  return `msg_${callId}`
}

// 进度计算只有一处实现（files.mts），这里转出去方便 reducer 的使用方直接拿。
export { base64ByteLength }

/** 当前是否还有消息在流式输出（UI 用来决定要不要显示“停止”按钮）。 */
export function streamingCallIds(state: ChatState): string[] {
  return state.messages
    .filter(message => message.kind === 'assistant' && message.streaming)
    .map(message => message.callId ?? message.id)
}

/** 未确认（pending）/失败的用户消息，UI 用于展示重试入口。 */
export function unconfirmedMessages(state: ChatState): ChatMessage[] {
  return state.messages.filter(message => message.kind === 'user' && (message.state === 'pending' || message.state === 'failed'))
}
