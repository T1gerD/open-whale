// 聊天状态 reducer（纯逻辑，本模块是整个 App 的业务核心）。
//
// 设计要点：
//  1. reducer 只吃“事件”，只吐“新状态 + 副作用”，不做任何 I/O——文件落盘、发帧、
//     写数据库都在服务层按 effects 执行。这样网络与磁盘都没法让状态机变得不可测。
//  2. 消息 id 是**确定性**的：用户消息 `usr_<msgId>`（msgId=rid），助手消息
//     `msg_<messageId>`（没有 messageId 的老协议回落到 `msg_<callId>`），文件卡片
//     `file_<fileId>`。所以断线重连、多端回显、事件日志回放都不会造出第二条消息。
//  3. `chat/tool` 只累积成 assistant 消息里的**活动行**（activity），永远不写进
//     `text`：工具调用不是助理在说话，语义混了以后 UI 就没法正确渲染。
//  4. delta 按 `seq` 聚合：重复/迟到的丢弃，缺口先缓存、补齐后连续 flush；
//     `chat/message` 是**全文替换**（messageId upsert），`chat/done` 是权威全文。
//  5. v2.2.0 多端同步：`chat/echo`（会话内所有人的消息）、`session/state`（快照）、
//     `session/events`（按 seq 追赶）、`session/participants`、`collab/state`、
//     `file/offered` 都在这里归约；会话游标 `sessionCursor` 由服务层持久化。

import { base64ByteLength } from './files.mts'
import { MAX_FILE_BYTES, SERVER_FRAME } from './frames.mts'

export type MessageKind = 'user' | 'assistant' | 'system'
export type MessageSendState = 'pending' | 'sent' | 'failed'
export type ActivityPhase = 'thinking' | 'tool-start' | 'tool-end'

/** 文件引用（助手产出的文件、用户附件回显、电脑推来的文件卡片）。 */
export interface FileRef {
  fileId: string
  name: string
  size: number
  mime?: string
  /** 上传中：对应 upload/* 的 uploadId（本地路径的附件才有）。 */
  uploadId?: string
  /** 上传状态（用户消息附件 chip 的进度展示）。 */
  uploadStatus?: 'uploading' | 'done' | 'failed'
  /** 已上传/已确认的字节数。 */
  uploadedBytes?: number
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

/** 消息发送者（多端协作时 UI 用它显示昵称/头像色块）。 */
export interface MessageSender {
  deviceId: string
  name: string
}

export interface ChatMessage {
  id: string
  kind: MessageKind
  text: string
  at: number
  /** 助手消息：对应的 callId；用户消息：发送后电脑端分配的 callId。 */
  callId?: string
  /** 助手消息：电脑端稳定的 messageId（chat/message 的 upsert 键）。 */
  messageId?: string
  /** 用户消息：幂等键（=rid=msgId，离线队列按它去重）。 */
  rid?: string
  /** 用户消息：电脑端消息 id（chat/echo 的 msgId）。 */
  msgId?: string
  state?: MessageSendState
  /** 用户消息：附件回显（只留元信息，不留 base64）。 */
  files?: FileRef[]
  /** 发送者（他人消息才有 sender；自己的消息 mine=true）。 */
  sender?: MessageSender
  /** 发送者 deviceId（chat/echo 里的原始字段；判断 mine 用）。 */
  deviceId?: string
  /** 这条用户消息是不是本机发的（协作模式气泡对齐用）。 */
  mine?: boolean
  /** 协作模式下发送者昵称（老字段，等价 sender.name）。 */
  speaker?: string
  /** 助手消息是否还在流式输出。 */
  streaming?: boolean
  /** 断线时把还在流的消息标记为中断，UI 提示“内容可能不完整”。 */
  interrupted?: boolean
  truncated?: boolean
  durationMs?: number
  error?: string
  /**
   * 发送失败后是否值得重试（UI 决定给「重试」还是「改设置/换文件」）。
   * 网络断开/超时 = true；电脑端拒绝、文件过大、本地文件读不出来 = false。
   */
  retryable?: boolean
  /** 助手消息内的小活动行，按到达顺序。 */
  activity?: ActivityItem[]
  /** 已连续消费到的 delta 序号。 */
  deltaSeq?: number
  /** 因序号缺口跳过的 delta 数。 */
  deltaGaps?: number
  /** 自动重发次数。 */
  attempts?: number
  level?: 'info' | 'error'
  /** 电脑端推来的文件卡片（用于 UI 与普通助手消息区分开）。 */
  fileOffer?: boolean
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

/** 在线成员（session/participants）。 */
export interface Participant {
  deviceId: string
  name: string
  online: boolean
}

/** 上传进度视图（uploadId → 状态；UI 也可以直接读 message.files[] 里的字段）。 */
export interface UploadView {
  uploadId: string
  name: string
  size: number
  mime?: string
  phase: 'uploading' | 'done' | 'failed'
  chunkBytes?: number
  uploadedBytes: number
  fileId?: string
  error?: string
}

export interface ChatState {
  assistantId: string
  messages: ChatMessage[]
  /** callId → 助手消息 id 的索引，避免每条 delta 都线性搜索。 */
  callIndex: Record<string, string>
  transfers: Record<string, Transfer>
  typing: { callId: string; active: boolean } | null
  /** callId → 已消费到的最大 delta seq。 */
  lastSeq: Record<string, number>
  /** 乱序到达、等待补缺的 delta（callId → seq → text）。 */
  deltaBuffers: Record<string, Record<number, string>>
  /** 累计缺口次数，用来在 UI 上提示“内容可能不完整”。 */
  gapCount: number
  lastEventAt: number
  // ---- 2.2.0 多端同步 ----
  /** 当前会话 id（协作模式切换会变）。 */
  sessionId?: string
  /** 会话纪元：每次切换 +1。 */
  sessionEpoch?: number
  /** 已应用到的会话事件序号（断点续传游标）。 */
  sessionCursor: number
  /** 协作模式开关（来自 session/state 或 collab/state）。 */
  collaboration: boolean
  /** 会话内在线成员。 */
  participants: Participant[]
  /** messageId → 助手消息 id（chat/message upsert 索引）。 */
  messageIndex: Record<string, string>
  /** callId → 助手消息 id 列表（同一回合可能有多条 messageId 消息）。 */
  turnMessages: Record<string, string[]>
  /** uploadId → 上传进度。 */
  uploads: Record<string, UploadView>
  /** 本机 deviceId（判断消息 mine，由服务层在启动/连接时注入）。 */
  selfDeviceId?: string
}

export type ChatEffect =
  | { kind: 'file-chunk'; fileId: string; seq: number; dataBase64: string }
  | { kind: 'file-complete'; fileId: string }
  | { kind: 'file-abort'; fileId: string; reason: string }
  | { kind: 'fetch-file'; fileId: string }
  | { kind: 'cancel-file'; fileId: string }
  | { kind: 'persist-cursor'; cursor: number }

/** 服务端帧事件（字段与 protocol 一致；未知帧在服务层就被过滤掉了）。 */
export type WireEvent =
  | { t: 'chat/ack'; rid?: string; msgId?: string; callId?: string; cancelled?: boolean; duplicate?: boolean; at?: number }
  | { t: 'chat/delta'; callId: string; seq: number; text: string; at?: number }
  | {
      t: 'chat/done'
      callId: string
      text: string
      truncated?: boolean
      durationMs?: number
      files?: FileRef[]
      seq?: number
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
      seq?: number
      at?: number
    }
  | { t: 'chat/typing'; callId: string; active?: boolean; at?: number }
  | { t: 'chat/error'; callId?: string; message: string; retryable?: boolean; at?: number }
  | {
      /** 会话内任意设备发出的用户消息，广播给所有设备（含发送者）。 */
      t: 'chat/echo'
      msgId: string
      rid?: string
      callId?: string
      deviceId?: string
      speaker?: string
      text?: string
      files?: FileRef[]
      seq?: number
      at?: number | string
    }
  | {
      /** 一条助手消息，按 messageId 全文替换（修「回复重复拼接」）。 */
      t: 'chat/message'
      callId: string
      messageId: string
      index?: number
      text: string
      seq?: number
      at?: number
    }
  | {
      t: 'session/state'
      sessionId?: string
      sessionEpoch?: number
      head?: number
      snapshot?: { messages?: SnapshotMessage[]; activeCall?: { callId?: string; text?: string; typing?: boolean } | null }
      collaboration?: boolean
      /** 会话切换时置 true：清空本地聊天后接快照。 */
      reset?: boolean
      at?: number
    }
  | {
      t: 'session/events'
      sessionId?: string
      from?: number
      head?: number
      events: Array<WireEvent | Record<string, unknown>>
      at?: number
    }
  | {
      t: 'session/participants'
      sessionId?: string
      collaboration?: boolean
      participants?: Array<{ deviceId?: unknown; name?: unknown; online?: unknown }>
      at?: number
    }
  | { t: 'collab/state'; on: boolean; sessionId?: string; sessionEpoch?: number; at?: number }
  | { t: 'file/offered'; fileId: string; name: string; size: number; mime?: string; url?: string; from?: string; seq?: number; at?: number }
  | { t: 'file/meta'; fileId: string; name: string; size: number; mime?: string; at?: number }
  | { t: 'file/chunk'; fileId: string; seq: number; dataBase64: string; at?: number }
  | { t: 'file/end'; fileId: string; seq?: number; at?: number }
  | { t: 'file/error'; fileId: string; code?: string; message?: string; at?: number }
  | { t: 'upload/ready'; uploadId: string; chunkBytes: number; maxBytes?: number; at?: number }
  | { t: 'upload/progress'; uploadId: string; nextSeq: number; received: number; at?: number }
  | { t: 'upload/done'; uploadId: string; fileId: string; name?: string; size?: number; mime?: string; path?: string; at?: number }
  | { t: 'upload/error'; uploadId: string; code?: string; message?: string; at?: number }

/** 快照里的单条消息（protocol 的 session/state.snapshot.messages）。 */
export interface SnapshotMessage {
  id?: string
  kind?: string
  text?: string
  at?: string | number
  callId?: string
  msgId?: string
  messageId?: string
  speaker?: string
  deviceId?: string
  files?: FileRef[]
}

/** 本地事件：用户操作与连接生命周期。 */
export type LocalEvent =
  | { t: 'state/hydrate'; messages: ChatMessage[]; transfers?: Transfer[]; at: number }
  | { t: 'state/identity'; deviceId: string; at?: number }
  | {
      t: 'user/send'
      rid: string
      msgId?: string
      text: string
      files?: FileRef[]
      at: number
    }
  | { t: 'outbox/acked'; rid: string; callId?: string; duplicate?: boolean; cancelled?: boolean; at?: number }
  | { t: 'outbox/failed'; rid: string; reason: string; retryable?: boolean; at: number }
  | { t: 'outbox/retry'; rid: string; at: number }
  | { t: 'conn/disconnected'; at: number; reason?: string }
  | { t: 'conn/connected'; at: number }
  | { t: 'session/reset'; sessionId?: string; sessionEpoch?: number; reason?: string; at: number }
  | { t: 'message/remove'; messageId: string; at: number }
  | { t: 'user/stop'; callId?: string; at: number }
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
  SERVER_FRAME.CHAT_ECHO,
  SERVER_FRAME.CHAT_MESSAGE,
  SERVER_FRAME.SESSION_STATE,
  SERVER_FRAME.SESSION_EVENTS,
  SERVER_FRAME.PARTICIPANTS,
  SERVER_FRAME.COLLAB_STATE,
  SERVER_FRAME.UPLOAD_READY,
  SERVER_FRAME.UPLOAD_PROGRESS,
  SERVER_FRAME.UPLOAD_DONE,
  SERVER_FRAME.UPLOAD_ERROR,
  SERVER_FRAME.FILE_OFFERED,
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
    sessionId: undefined,
    sessionEpoch: undefined,
    sessionCursor: 0,
    collaboration: false,
    participants: [],
    messageIndex: {},
    turnMessages: {},
    uploads: {},
    selfDeviceId: undefined,
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
  options: { selfDeviceId?: string } = {},
): ChatState {
  const state = emptyChatState(assistantId)
  const callIndex: Record<string, string> = {}
  const lastSeq: Record<string, number> = {}
  const restored = messages
    .filter(message => message && typeof message.id === 'string')
    .map(message => {
      const next = { ...message }
      if (next.kind === 'assistant') {
        if (next.callId) {
          if (!callIndex[next.callId]) callIndex[next.callId] = next.id
          if (typeof next.deltaSeq === 'number') lastSeq[next.callId] = next.deltaSeq
        }
        if (next.streaming) next.interrupted = true
      }
      if (next.kind === 'user' && next.mine === undefined) next.mine = true
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
  const base = { ...state, messages: restored, transfers: transferMap, selfDeviceId: options.selfDeviceId }
  const withIndexes = rebuildIndexes(base, restored)
  return { ...withIndexes, lastSeq, lastEventAt: now, sessionCursor: state.sessionCursor }
}

/** 聊天状态可 JSON 往返（用于进度快照/调试面板）。 */
export function serializeChatState(state: ChatState): string {
  return JSON.stringify(state)
}

export function deserializeChatState(
  text: string,
  assistantId: string,
  now: number = Date.now(),
  options: { selfDeviceId?: string } = {},
): ChatState {
  try {
    const parsed = JSON.parse(text) as ChatState
    if (!parsed || !Array.isArray(parsed.messages)) return emptyChatState(assistantId)
    const state = hydrateChat(assistantId, parsed.messages, Object.values(parsed.transfers ?? {}), now, options)
    return {
      ...state,
      sessionId: parsed.sessionId,
      sessionEpoch: parsed.sessionEpoch,
      sessionCursor: typeof parsed.sessionCursor === 'number' ? parsed.sessionCursor : 0,
      collaboration: parsed.collaboration === true,
      participants: Array.isArray(parsed.participants) ? parsed.participants : [],
      uploads: parsed.uploads && typeof parsed.uploads === 'object' ? parsed.uploads : {},
    }
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

    case 'state/identity': {
      const deviceId = typeof event.deviceId === 'string' ? event.deviceId : ''
      if (!deviceId) return { state, effects: none }
      return { state: { ...state, selfDeviceId: deviceId, messages: applyOwnership(state.messages, deviceId) }, effects: none }
    }

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

    case 'session/reset': {
      // 协作模式切换 / 会话纪元变化：本地旧会话立即清空，等待 session/state 快照。
      const cleared = clearConversation(state, at)
      const reason = event.reason ?? '协作会话已切换，正在同步聊天记录…'
      return {
        state: {
          ...appendSystem(cleared, reason, at, 'info'),
          sessionId: event.sessionId,
          sessionEpoch: event.sessionEpoch,
          sessionCursor: 0,
          lastEventAt: at,
        },
        effects: [{ kind: 'persist-cursor', cursor: 0 }],
      }
    }

    case 'message/remove': {
      const message = state.messages.find(item => item.id === event.messageId)
      if (!message) return { state: { ...state, lastEventAt: at }, effects: none }
      const messages = state.messages.filter(item => item.id !== event.messageId)
      return { state: { ...rebuildIndexes(state, messages), lastEventAt: at }, effects: none }
    }

    case 'user/send': {
      const msgId = event.msgId ?? event.rid
      const id = userMessageId(msgId)
      const existing = state.messages.find(message => message.id === id)
      const message: ChatMessage = existing
        ? {
            ...existing,
            text: event.text,
            files: event.files ?? existing.files,
            state: 'pending',
            at: event.at,
            rid: event.rid,
            msgId,
            mine: true,
          }
        : {
            id,
            kind: 'user',
            text: event.text,
            at: event.at,
            rid: event.rid,
            msgId,
            state: 'pending',
            files: event.files,
            mine: true,
          }
      const messages = existing ? state.messages.map(item => (item.id === id ? message : item)) : [...state.messages, message]
      return { state: { ...state, messages, lastEventAt: at }, effects: none }
    }

    case 'outbox/acked': {
      const key = event.rid
      if (!key) return { state: { ...state, lastEventAt: at }, effects: none }
      const id = userMessageId(key)
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
        message.id === id
          ? { ...message, state: 'failed' as MessageSendState, error: event.reason, retryable: event.retryable !== false }
          : message,
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
              retryable: undefined,
            }
          : message,
      )
      return { state: { ...state, messages, lastEventAt: at }, effects: none }
    }

    case 'user/stop': {
      let next = state
      if (event.callId) {
        next = patchAssistant(
          next,
          event.callId,
          message => ({ ...message, streaming: false, interrupted: true }),
          at,
        )
      } else {
        next = {
          ...next,
          messages: next.messages.map(message =>
            message.kind === 'assistant' && message.streaming ? { ...message, streaming: false, interrupted: true } : message,
          ),
        }
      }
      return {
        state: { ...appendSystem(next, '已停止生成', at, 'info'), typing: null, lastEventAt: at },
        effects: none,
      }
    }

    case 'chat/ack':
      return reduceChat(
        state,
        {
          t: 'outbox/acked',
          rid: event.rid ?? event.msgId ?? '',
          callId: event.callId,
          duplicate: event.duplicate,
          cancelled: event.cancelled,
          at,
        },
        at,
      )

    case 'chat/echo': {
      const next = withEventCursor(applyEcho(state, event, at), event)
      return { state: next, effects: cursorEffects(state, event).effects }
    }

    case 'chat/delta': {
      const next = withEventCursor(applyDelta(state, event.callId, event.seq, event.text, at), event)
      return { state: { ...next, lastEventAt: at }, effects: cursorEffects(state, event).effects }
    }

    case 'chat/message': {
      const next = withEventCursor(applyAssistantMessage(state, event, at), event)
      return { state: { ...next, lastEventAt: at }, effects: cursorEffects(state, event).effects }
    }

    case 'chat/done': {
      const next = withEventCursor(applyDone(state, event, at), event)
      return { state: { ...next, lastEventAt: at }, effects: cursorEffects(state, event).effects }
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

    case 'file/offered': {
      const ref = normalizeFileRef(event)
      if (!ref) return { state: { ...state, lastEventAt: at }, effects: none }
      const next = upsertTransfer(
        state,
        {
          fileId: ref.fileId,
          name: ref.name,
          size: ref.size,
          mime: ref.mime,
          status: 'offered',
          receivedBytes: 0,
          nextSeq: 0,
          chunks: 0,
        },
        at,
      )
      const id = fileOfferMessageId(ref.fileId)
      const existing = next.messages.find(message => message.id === id)
      const message: ChatMessage = existing
        ? { ...existing, files: mergeFileRefs(existing.files, [ref]), text: existing.text }
        : {
            id,
            kind: 'assistant',
            text: '',
            at,
            files: [ref],
            fileOffer: true,
          }
      const messages = existing ? next.messages.map(item => (item.id === id ? message : item)) : [...next.messages, message]
      const advanced = withEventCursor({ ...next, messages }, event)
      return { state: { ...advanced, lastEventAt: at }, effects: cursorEffects(state, event).effects }
    }

    case 'upload/ready':
    case 'upload/progress':
    case 'upload/done':
    case 'upload/error': {
      const next = applyUploadFrame(state, event, at)
      return { state: { ...next, lastEventAt: at }, effects: none }
    }

    case 'session/state': {
      const next = applySessionSnapshot(state, event, at)
      return { state: { ...next, lastEventAt: at }, effects: [{ kind: 'persist-cursor', cursor: next.sessionCursor }] }
    }

    case 'session/events': {
      let next = state
      const effects: ChatEffect[] = []
      const events = (Array.isArray(event.events) ? event.events : [])
        .filter(item => item && typeof item === 'object' && typeof (item as { t?: unknown }).t === 'string')
        .slice()
        .sort((a, b) => eventSeq(a) - eventSeq(b))
      for (const item of events) {
        const seq = eventSeq(item)
        // 已经在游标之内的重复事件直接丢弃（会话日志会重放，可能包含我们已应用过的事件）。
        if (Number.isFinite(seq) && seq > 0 && seq <= next.sessionCursor) continue
        const result = reduceChat(next, item as ChatEvent, at)
        next = result.state
        effects.push(...result.effects)
        if (Number.isFinite(seq) && seq > 0 && seq > next.sessionCursor) {
          next = { ...next, sessionCursor: seq }
        }
      }
      const head = typeof event.head === 'number' && Number.isFinite(event.head) ? Math.max(0, Math.floor(event.head)) : undefined
      if (head !== undefined && head > next.sessionCursor) next = { ...next, sessionCursor: head }
      const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : next.sessionId
      return {
        state: { ...next, sessionId, lastEventAt: at },
        effects: [...effects, { kind: 'persist-cursor', cursor: next.sessionCursor }],
      }
    }

    case 'session/participants': {
      const participants = normalizeParticipants(event.participants)
      return {
        state: {
          ...state,
          participants,
          collaboration: typeof event.collaboration === 'boolean' ? event.collaboration : state.collaboration,
          lastEventAt: at,
        },
        effects: none,
      }
    }

    case 'collab/state': {
      const next: ChatState = { ...state, collaboration: event.on === true, lastEventAt: at }
      const system = appendSystem(next, event.on ? '已开启协作模式' : '已关闭协作模式', at, 'info')
      return { state: system, effects: none }
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

// ---------------------------------------------------------------------------
// chat/echo（多端回显）
// ---------------------------------------------------------------------------

function applyEcho(
  state: ChatState,
  event: Extract<WireEvent, { t: 'chat/echo' }>,
  at: number,
): ChatState {
  const msgId = typeof event.msgId === 'string' && event.msgId ? event.msgId : typeof event.rid === 'string' ? event.rid : ''
  if (!msgId) return state
  const id = userMessageId(msgId)
  const existing = state.messages.find(message => message.id === id)
  const echoFiles = normalizeFileRefs(event.files)
  const deviceId = typeof event.deviceId === 'string' && event.deviceId ? event.deviceId : undefined
  // 自己的消息：本机 deviceId 已知时直接比；未知时沿用本地已有的 mine。
  const mine = deviceId !== undefined && state.selfDeviceId !== undefined ? deviceId === state.selfDeviceId : existing?.mine ?? false
  const files = existing?.files && existing.files.length > 0
    ? // 自己上传的附件：本地 ref 带 uploadId/进度，比 echo 里的电脑端元信息更有用，保留本地的。
      existing.files.map(file => ({ ...file, uploadStatus: file.uploadStatus ?? 'done' }))
    : echoFiles.length > 0
      ? echoFiles
      : undefined
  const message: ChatMessage = existing
    ? {
        ...existing,
        text: typeof event.text === 'string' ? event.text : existing.text,
        state: 'sent',
        callId: typeof event.callId === 'string' ? event.callId : existing.callId,
        msgId,
        speaker: typeof event.speaker === 'string' ? event.speaker : existing.speaker,
        deviceId,
        mine,
        files,
        at: existing.at,
      }
    : {
        id,
        kind: 'user',
        text: typeof event.text === 'string' ? event.text : '',
        at: eventAt(event, at),
        rid: typeof event.rid === 'string' ? event.rid : msgId,
        msgId,
        callId: typeof event.callId === 'string' ? event.callId : undefined,
        state: 'sent',
        speaker: typeof event.speaker === 'string' ? event.speaker : undefined,
        sender: deviceId ? { deviceId, name: typeof event.speaker === 'string' && event.speaker ? event.speaker : deviceId } : undefined,
        deviceId,
        mine,
        files,
      }
  const messages = existing ? state.messages.map(item => (item.id === id ? message : item)) : [...state.messages, message]
  return { ...state, messages }
}

// ---------------------------------------------------------------------------
// chat/message（messageId upsert，全文替换）
// ---------------------------------------------------------------------------

function applyAssistantMessage(
  state: ChatState,
  event: Extract<WireEvent, { t: 'chat/message' }>,
  at: number,
): ChatState {
  const callId = typeof event.callId === 'string' && event.callId ? event.callId : ''
  const messageId = typeof event.messageId === 'string' && event.messageId ? event.messageId : callId
  if (!callId || !messageId) return state
  const index = typeof event.index === 'number' && Number.isFinite(event.index) ? Math.max(0, Math.floor(event.index)) : 0
  let id = state.messageIndex[messageId]
  if (!id) {
    // 兼容：如果这条回答此前以 delta 建过 `msg_<callId>` 占位气泡，复用它（同一回合不能出现两个气泡）。
    const legacy = state.callIndex[callId]
    id = index === 0 && legacy ? legacy : assistantMessageId(messageId)
  }
  const existing = state.messages.find(message => message.id === id)
  const text = typeof event.text === 'string' ? event.text : existing?.text ?? ''
  const next: ChatMessage = existing
    ? {
        ...existing,
        kind: 'assistant',
        text,
        callId,
        messageId,
        streaming: true,
        interrupted: false,
        deltaGaps: undefined,
      }
    : {
        id,
        kind: 'assistant',
        text,
        at,
        callId,
        messageId,
        streaming: true,
        activity: [],
      }
  let messages = existing ? state.messages.map(message => (message.id === id ? next : message)) : [...state.messages, next]
  // 结束位置排序：同一回合的多条消息按到达顺序追加；这里保证它排在该回合用户消息之后。
  const messageIndex = { ...state.messageIndex, [messageId]: id }
  const callIndex = state.callIndex[callId] ? state.callIndex : { ...state.callIndex, [callId]: id }
  const turn = state.turnMessages[callId] ?? []
  const turnMessages = turn.includes(id) ? state.turnMessages : { ...state.turnMessages, [callId]: [...turn, id] }
  return { ...state, messages, messageIndex, callIndex, turnMessages }
}

// ---------------------------------------------------------------------------
// chat/done（权威全文收尾）
// ---------------------------------------------------------------------------

function applyDone(
  state: ChatState,
  event: Extract<WireEvent, { t: 'chat/done' }>,
  at: number,
): ChatState {
  const callId = event.callId
  const turnIds = (state.turnMessages[callId] ?? []).slice()
  const turnMessages = turnIds
    .map(id => state.messages.find(message => message.id === id))
    .filter((message): message is ChatMessage => Boolean(message) && message!.kind === 'assistant')
  const authoritative = typeof event.text === 'string' ? event.text : ''
  let next = state
  let targetId: string

  if (turnMessages.length === 0) {
    // 老协议：只有 delta / done，一条回答一个气泡（msg_<callId>）。
    next = patchAssistant(
      state,
      callId,
      message => ({
        ...message,
        text: authoritative || message.text,
        streaming: false,
        interrupted: false,
        truncated: Boolean(event.truncated),
        durationMs: event.durationMs,
        deltaGaps: undefined,
      }),
      at,
    )
    targetId = next.callIndex[callId] ?? assistantMessageId(callId)
  } else if (turnMessages.length === 1) {
    const only = turnMessages[0]!
    next = patchMessage(next, only.id, message => ({
      ...message,
      text: authoritative || message.text,
      streaming: false,
      interrupted: false,
      truncated: Boolean(event.truncated),
      durationMs: event.durationMs,
      deltaGaps: undefined,
    }))
    targetId = only.id
  } else {
    const joined = turnMessages.map(message => message.text).filter(Boolean).join('\n\n')
    const uniqueTexts = new Set(turnMessages.map(message => message.text))
    const duplicatedText = uniqueTexts.size === 1 && turnMessages.length > 1
    const collapseWith = (text: string): ChatState => {
      // 收敛成一个气泡，保留第一条 id（React key 稳定），删掉同回合其余气泡。
      const first = turnMessages[0]!
      let collapsed = patchMessage(next, first.id, message => ({
        ...message,
        text,
        streaming: false,
        interrupted: false,
        truncated: Boolean(event.truncated),
        durationMs: event.durationMs,
      }))
      const drop = new Set(turnMessages.slice(1).map(message => message.id))
      const messages = collapsed.messages.filter(message => !drop.has(message.id))
      collapsed = { ...rebuildIndexes(collapsed, messages), turnMessages: { ...collapsed.turnMessages, [callId]: [first.id] } }
      return collapsed
    }
    if (duplicatedText) {
      // v2.1.0 协作 bug 的典型表现：同一段回答被按设备重复 push，done.text = T\n\nT。
      // 手机端做最后一道去重：只保留一份文本，而不是把重复段照单全收。
      next = collapseWith(turnMessages[0]!.text)
      targetId = turnMessages[0]!.id
    } else if (authoritative !== '' && authoritative !== joined) {
      next = collapseWith(authoritative)
      targetId = turnMessages[0]!.id
    } else {
      for (const message of turnMessages) {
        next = patchMessage(next, message.id, item => ({
          ...item,
          streaming: false,
          interrupted: false,
          truncated: Boolean(event.truncated),
          durationMs: event.durationMs,
        }))
      }
      targetId = turnMessages[turnMessages.length - 1]!.id
    }
  }

  next = clearDeltaBuffer(next, callId)
  // done 之后这个 callId 不会再产生增量：把序号推到上限，
  // 这样任何迟到的 delta 都会被丢弃，不会污染权威文本。
  next = { ...next, lastSeq: { ...next.lastSeq, [callId]: Number.MAX_SAFE_INTEGER } }
  // done 可能带上助手产出的文件：登记成可下载的卡片，并挂到这条助手消息上。
  const files = normalizeFileRefs(event.files)
  if (files.length > 0) {
    next = upsertTransfers(
      next,
      files.map(file => ({ ...file, status: 'offered' as TransferStatus })),
      at,
    )
    next = attachFiles(next, targetId, files)
  }
  return { ...next, typing: typingAfter(next.typing, callId) }
}

// ---------------------------------------------------------------------------
// session/state（快照覆盖/合并，幂等）
// ---------------------------------------------------------------------------

function applySessionSnapshot(
  state: ChatState,
  event: Extract<WireEvent, { t: 'session/state' }>,
  at: number,
): ChatState {
  const snapshot = event.snapshot ?? {}
  const incoming = (Array.isArray(snapshot.messages) ? snapshot.messages : [])
    .map(item => messageFromSnapshot(item, at))
    .filter((message): message is ChatMessage => Boolean(message))
  const incomingIds = new Set(incoming.map(message => message.id))
  const reset = event.reset === true
  let messages: ChatMessage[]
  if (reset) {
    messages = incoming
  } else {
    const localById = new Map(state.messages.map(message => [message.id, message]))
    const merged = incoming.map(item => {
      const local = localById.get(item.id)
      if (!local) return item
      return {
        ...item,
        // 本地还在排队/失败的用户消息保留发送状态（它不在电脑端快照里是正常的）。
        state: local.state === 'pending' || local.state === 'failed' ? local.state : item.state,
        files: mergeFileRefs(local.files, item.files),
        // 本地已收到的流式文本可能比快照新，取更长的那份（快照 head 之后还有事件会补）。
        text: local.text.length > item.text.length ? local.text : item.text,
      }
    })
    /**
     * 快照里助手消息的粒度是「每个 callId 一条聚合气泡」（id=`msg_<callId>`，text 为
     * 各 message 用 "\n\n" 拼接），而本地在 chat-message-v1 下是「每条 message 一个气泡」
     * （id=`msg_<messageId>`）。同一 callId 的快照气泡已经覆盖了本地这些逐消息气泡，
     * 必须按 callId 抑制本地副本，否则「离线超过事件日志窗口 → 快照」时会重复显示整轮回答。
     */
    const incomingCallIds = new Set(
      incoming
        .filter(message => message.kind === 'assistant' && typeof message.callId === 'string')
        .map(message => message.callId as string),
    )
    const extras = state.messages.filter(message => {
      if (incomingIds.has(message.id)) return false
      if (message.kind === 'system') return true
      if (message.kind === 'user') return message.state === 'pending' || message.state === 'failed'
      if (message.callId && incomingCallIds.has(message.callId)) return false
      // 空助手气泡（v2.1.0 跨设备 callId 错乱留下的「没有提问的重复气泡」）直接清掉。
      return message.text !== ''
    })
    messages = [...merged, ...extras]
  }
  const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : state.sessionId
  const sessionEpoch = typeof event.sessionEpoch === 'number' && Number.isFinite(event.sessionEpoch)
    ? event.sessionEpoch
    : state.sessionEpoch
  const head = typeof event.head === 'number' && Number.isFinite(event.head) ? Math.max(0, Math.floor(event.head)) : state.sessionCursor
  const collaboration = typeof event.collaboration === 'boolean' ? event.collaboration : state.collaboration
  const activeCall = snapshot.activeCall
  let typing: ChatState['typing'] = reset ? null : state.typing
  if (activeCall && activeCall.typing === true && typeof activeCall.callId === 'string') {
    typing = { callId: activeCall.callId, active: true }
  }
  const rebuilt = rebuildIndexes({ ...state, sessionId, sessionEpoch, collaboration }, messages)
  // 进行中的回合：快照里带 activeCall 时把已生成的文本补成一条 streaming 消息，
  // 这样中途加入的设备也能看到“半个回答”，而不是等 done 才出现。
  let next: ChatState = rebuilt
  if (activeCall && typeof activeCall.callId === 'string' && typeof activeCall.text === 'string' && activeCall.text !== '') {
    next = patchAssistant(next, activeCall.callId, message => ({ ...message, text: activeCall.text as string, streaming: true }), at)
  }
  return { ...next, sessionCursor: Math.max(state.sessionCursor, head), typing }
}

/** 快照消息 → 本地消息（id 缺失时按协议约定推导，保证幂等）。 */
function messageFromSnapshot(item: SnapshotMessage, at: number): ChatMessage | undefined {
  if (!item || typeof item !== 'object') return undefined
  const kind: MessageKind = item.kind === 'user' || item.kind === 'assistant' || item.kind === 'system' ? item.kind : 'assistant'
  const msgId = typeof item.msgId === 'string' && item.msgId ? item.msgId : undefined
  const messageId = typeof item.messageId === 'string' && item.messageId ? item.messageId : undefined
  const callId = typeof item.callId === 'string' && item.callId ? item.callId : undefined
  const id = typeof item.id === 'string' && item.id
    ? item.id
    : kind === 'user' && msgId
      ? userMessageId(msgId)
      : kind === 'assistant' && messageId
        ? assistantMessageId(messageId)
        : kind === 'assistant' && callId
          ? assistantMessageId(callId)
          : `sys_${at}_${Math.random().toString(36).slice(2, 8)}`
  const text = typeof item.text === 'string' ? item.text : ''
  return {
    id,
    kind,
    text,
    at: toTime(item.at, at),
    callId,
    messageId,
    msgId,
    rid: msgId,
    speaker: typeof item.speaker === 'string' ? item.speaker : undefined,
    files: normalizeFileRefs(item.files),
    state: kind === 'user' ? 'sent' : undefined,
    mine: kind === 'user' ? true : undefined,
    // 快照里的消息是历史：不标 streaming（进行中的回合通过 activeCall/后续 delta 补全）。
    streaming: kind === 'assistant' ? false : undefined,
    activity: kind === 'assistant' ? [] : undefined,
  }
}

// ---------------------------------------------------------------------------
// upload/*（进度视图 + 附件 chip 状态）
// ---------------------------------------------------------------------------

function applyUploadFrame(
  state: ChatState,
  event:
    | { t: 'upload/ready'; uploadId: string; chunkBytes?: number; maxBytes?: number; at?: number }
    | { t: 'upload/progress'; uploadId: string; nextSeq?: number; received?: number; at?: number }
    | { t: 'upload/done'; uploadId: string; fileId?: string; name?: string; size?: number; mime?: string; path?: string; at?: number }
    | { t: 'upload/error'; uploadId: string; code?: string; message?: string; at?: number },
  at: number,
): ChatState {
  const uploadId = typeof event.uploadId === 'string' ? event.uploadId : ''
  if (!uploadId) return state
  const existing = state.uploads[uploadId]
  switch (event.t) {
    case 'upload/ready': {
      const upload: UploadView = {
        uploadId,
        name: existing?.name ?? uploadId,
        size: existing?.size ?? 0,
        mime: existing?.mime,
        phase: 'uploading',
        chunkBytes: typeof event.chunkBytes === 'number' ? event.chunkBytes : existing?.chunkBytes,
        uploadedBytes: existing?.uploadedBytes ?? 0,
      }
      return { ...state, uploads: { ...state.uploads, [uploadId]: upload } }
    }
    case 'upload/progress': {
      const received = typeof event.received === 'number' ? event.received : existing?.uploadedBytes ?? 0
      const upload: UploadView = {
        uploadId,
        name: existing?.name ?? uploadId,
        size: existing?.size ?? 0,
        mime: existing?.mime,
        phase: 'uploading',
        chunkBytes: existing?.chunkBytes,
        uploadedBytes: Math.max(existing?.uploadedBytes ?? 0, received),
      }
      return { ...state, uploads: { ...state.uploads, [uploadId]: upload } }
    }
    case 'upload/done': {
      const upload: UploadView = {
        uploadId,
        name: event.name ?? existing?.name ?? uploadId,
        size: event.size ?? existing?.size ?? 0,
        mime: event.mime ?? existing?.mime,
        phase: 'done',
        chunkBytes: existing?.chunkBytes,
        uploadedBytes: event.size ?? existing?.size ?? 0,
        fileId: typeof event.fileId === 'string' ? event.fileId : undefined,
      }
      return {
        ...state,
        uploads: { ...state.uploads, [uploadId]: upload },
        messages: patchUploadRefs(state.messages, uploadId, { uploadStatus: 'done', uploadedBytes: upload.uploadedBytes }),
      }
    }
    case 'upload/error': {
      const message = typeof event.message === 'string' && event.message ? event.message : String(event.code ?? '上传失败')
      const upload: UploadView = {
        uploadId,
        name: existing?.name ?? uploadId,
        size: existing?.size ?? 0,
        mime: existing?.mime,
        phase: 'failed',
        chunkBytes: existing?.chunkBytes,
        uploadedBytes: existing?.uploadedBytes ?? 0,
        error: message,
      }
      return {
        ...state,
        uploads: { ...state.uploads, [uploadId]: upload },
        messages: patchUploadRefs(state.messages, uploadId, { uploadStatus: 'failed' }),
      }
    }
    default:
      return state
  }
}

function patchUploadRefs(
  messages: ChatMessage[],
  uploadId: string,
  patch: Partial<FileRef>,
): ChatMessage[] {
  return messages.map(message => {
    if (!message.files || message.files.length === 0) return message
    if (!message.files.some(file => file.uploadId === uploadId)) return message
    return {
      ...message,
      files: message.files.map(file => (file.uploadId === uploadId ? { ...file, ...patch } : file)),
    }
  })
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

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
      turnMessages: { ...state.turnMessages, [callId]: [...(state.turnMessages[callId] ?? []), id] },
    }
  }
  return {
    ...state,
    messages: state.messages.map(message => (message.id === id ? update(message) : message)),
  }
}

function patchMessage(state: ChatState, id: string, update: (message: ChatMessage) => ChatMessage): ChatState {
  return { ...state, messages: state.messages.map(message => (message.id === id ? update(message) : message)) }
}

/** 把文件挂到指定消息上（按 fileId 去重，保留已有进度）。 */
function attachFiles(state: ChatState, messageId: string, files: FileRef[]): ChatState {
  const existing = state.messages.find(message => message.id === messageId)
  if (!existing) return state
  return patchMessage(state, messageId, message => ({
    ...message,
    files: mergeFileRefs(message.files, files),
  }))
}

function mergeFileRefs(a: FileRef[] | undefined, b: FileRef[] | undefined): FileRef[] | undefined {
  const left = Array.isArray(a) ? a : []
  const right = Array.isArray(b) ? b : []
  if (left.length === 0 && right.length === 0) return undefined
  const byId = new Map<string, FileRef>()
  for (const file of [...left, ...right]) {
    if (!file || typeof file.fileId !== 'string') continue
    const previous = byId.get(file.fileId)
    byId.set(file.fileId, previous ? { ...previous, ...file } : file)
  }
  return [...byId.values()]
}

function normalizeFileRefs(list: unknown): FileRef[] {
  if (!Array.isArray(list)) return []
  const out: FileRef[] = []
  for (const item of list) {
    const ref = normalizeFileRef(item)
    if (ref) out.push(ref)
  }
  return out
}

function normalizeFileRef(value: unknown): FileRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const file = value as Partial<FileRef>
  if (typeof file.fileId !== 'string' || file.fileId === '') return undefined
  const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 ? file.size : 0
  return {
    fileId: file.fileId,
    name: typeof file.name === 'string' && file.name ? file.name : file.fileId,
    size,
    mime: typeof file.mime === 'string' ? file.mime : undefined,
    uploadId: typeof file.uploadId === 'string' ? file.uploadId : undefined,
    uploadStatus: file.uploadStatus === 'done' || file.uploadStatus === 'failed' || file.uploadStatus === 'uploading'
      ? file.uploadStatus
      : undefined,
    uploadedBytes: typeof file.uploadedBytes === 'number' ? file.uploadedBytes : undefined,
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

/** 会话切换：清空本地会话视图（保留下载中的文件卡片，避免用户丢失正在下载的东西）。 */
function clearConversation(state: ChatState, at: number): ChatState {
  return {
    ...state,
    messages: [],
    callIndex: {},
    messageIndex: {},
    turnMessages: {},
    typing: null,
    lastSeq: {},
    deltaBuffers: {},
    gapCount: 0,
    participants: [],
    uploads: {},
    sessionCursor: 0,
    lastEventAt: at,
  }
}

/** 重建 callIndex / messageIndex / turnMessages（消息列表被整体替换后调用）。 */
function rebuildIndexes(state: ChatState, messages: ChatMessage[]): ChatState {
  const callIndex: Record<string, string> = {}
  const messageIndex: Record<string, string> = {}
  const turnMessages: Record<string, string[]> = {}
  for (const message of messages) {
    if (message.kind !== 'assistant') continue
    if (message.callId) {
      if (!callIndex[message.callId]) callIndex[message.callId] = message.id
      turnMessages[message.callId] = [...(turnMessages[message.callId] ?? []), message.id]
    }
    if (message.messageId) messageIndex[message.messageId] = message.id
  }
  return { ...state, messages, callIndex, messageIndex, turnMessages }
}

/** 给用户消息补上 mine（本机 deviceId 晚于历史消息就绪时调用）。 */
function applyOwnership(messages: ChatMessage[], deviceId: string): ChatMessage[] {
  return messages.map(message => {
    if (message.kind !== 'user') return message
    if (message.deviceId) return { ...message, mine: message.deviceId === deviceId }
    return message.mine === undefined ? { ...message, mine: true } : message
  })
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

function normalizeParticipants(list: unknown): Participant[] {
  if (!Array.isArray(list)) return []
  const out: Participant[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const raw = item as { deviceId?: unknown; name?: unknown; online?: unknown; deviceName?: unknown }
    const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : ''
    if (!deviceId || seen.has(deviceId)) continue
    seen.add(deviceId)
    const name = typeof raw.name === 'string' && raw.name
      ? raw.name
      : typeof raw.deviceName === 'string' && raw.deviceName
        ? raw.deviceName
        : deviceId
    out.push({ deviceId, name, online: raw.online !== false })
  }
  return out
}

/** 事件里的 seq（用于 session/events 排序与去重）。 */
function eventSeq(event: unknown): number {
  if (!event || typeof event !== 'object') return 0
  const seq = (event as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0
}

/** 带 seq 的帧要推进会话游标（并让服务层持久化）。 */
function cursorEffects(state: ChatState, event: { seq?: number }): { effects: ChatEffect[] } {
  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? Math.floor(event.seq) : 0
  if (seq <= 0 || seq <= state.sessionCursor) return { effects: [] }
  return { effects: [{ kind: 'persist-cursor', cursor: seq }] }
}

/** 把事件自带的 seq 写进会话游标（state 里存一份，服务层据此持久化）。 */
function withEventCursor(state: ChatState, event: { seq?: number }): ChatState {
  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? Math.floor(event.seq) : 0
  if (seq <= 0 || seq <= state.sessionCursor) return state
  return { ...state, sessionCursor: seq }
}

function eventAt(event: { at?: number | string }, fallback: number): number {
  if (typeof event.at === 'number' && Number.isFinite(event.at)) return event.at
  if (typeof event.at === 'string') {
    const parsed = Date.parse(event.at)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function toTime(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function userMessageId(msgId: string): string {
  return `usr_${msgId}`
}

export function assistantMessageId(callIdOrMessageId: string): string {
  return `msg_${callIdOrMessageId}`
}

export function fileOfferMessageId(fileId: string): string {
  return `file_${fileId}`
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

/** 会话游标（服务层持久化到助理记录）。 */
export function sessionCursorOf(state: ChatState): number {
  return state.sessionCursor
}
