// 会话模型：把电脑端推来的帧合并成一份「可直接渲染的消息列表」。
//
// 这一层刻意是零 DOM 的纯逻辑，`test/messages.test.mjs` 全量覆盖：
//
//  * 用户消息 id = `usr_<msgId>`（本地先插入，echo 回来时**更新**而不是再插一条）；
//  * 助手消息 id = `msg_<callId>`（按 messageId upsert，`chat/done` 全文覆盖）；
//  * `chat/delta` 只在不支持 `chat/message` 的老电脑端上追加，且按 seq 去重；
//  * `session/state` 幂等覆盖，`session/events` 按 seq 回放，cursor 持久化；
//  * v2.3.0：`sessions` / `session/selected` 维护会话选择器状态，会话切换后由
//    `session/state` 整页替换消息；`approval/ask` 进队列、`approval/resolved` 出队，
//    多条待办审批**排队**而不是互相覆盖；
//  * 未知帧一律忽略（协议只增不改）。
//
// 协作（共享会话 / 在线成员 / 昵称前缀）已在 v2.3.0 删除：每台设备只驱动它当前
// 绑定的那个 DSH 会话，消息里不再有 `speaker`。

import { CLIENT_FRAME, SERVER_FRAME } from './protocol.mjs'
import { clampAssistantText } from './protocol.mjs'

/** 用户消息 id 前缀。 */
export const USER_MESSAGE_PREFIX = 'usr_'
/** 助手消息 id 前缀。 */
export const ASSISTANT_MESSAGE_PREFIX = 'msg_'
/** 电脑推送的文件消息 id 前缀。 */
export const FILE_MESSAGE_PREFIX = 'file_'

/**
 * 待处理审批的队列上限。电脑端超时（60s）后会补 `approval/resolved`，正常不会
 * 堆积；这里留一个硬上限，保证一个出错的对端也不能把手机内存撑爆。
 */
export const APPROVAL_QUEUE_LIMIT = 8

/** 本地消息状态。 */
export const MESSAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  STREAMING: 'streaming',
  DONE: 'done',
  ERROR: 'error',
})

/** @param {string} msgId */
export function userMessageId(msgId) {
  return `${USER_MESSAGE_PREFIX}${msgId}`
}

/** @param {string} callId */
export function assistantMessageId(callId) {
  return `${ASSISTANT_MESSAGE_PREFIX}${callId}`
}

/** @param {string} fileId */
export function fileMessageId(fileId) {
  return `${FILE_MESSAGE_PREFIX}${fileId}`
}

/**
 * 归一化一条 `sessions` 里的会话摘要（`SessionSummary`）。
 * 缺 id 的条目直接丢掉：没有 id 就没法 `session/select`。
 * @param {any} raw
 * @returns {any | undefined}
 */
export function normalizeSessionSummary(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim().slice(0, 200) : '新会话'
  const createdAt = Number(raw.createdAt)
  const updatedAt = Number(raw.updatedAt)
  return {
    id,
    title,
    ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
    live: raw.live === true,
    current: raw.current === true,
  }
}

/**
 * 归一化一条 `approval/ask`。
 * @param {any} raw
 * @param {number} now
 * @returns {any | undefined}
 */
export function normalizeApproval(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return undefined
  const approvalId = typeof raw.approvalId === 'string' ? raw.approvalId : ''
  if (approvalId === '') return undefined
  const expiresAt = Number(raw.expiresAt)
  let displayReason = ''
  if (raw.displayReason && typeof raw.displayReason === 'object') {
    // `displayReason` 是本地化字典（至少含 en）；优先中文，其次 en。
    const entries = raw.displayReason
    displayReason = String(entries.zh ?? entries['zh-CN'] ?? entries.en ?? '')
  } else if (typeof raw.displayReason === 'string') {
    displayReason = raw.displayReason
  }
  return {
    approvalId,
    toolName: typeof raw.toolName === 'string' && raw.toolName !== '' ? raw.toolName : '工具',
    ...(typeof raw.reason === 'string' && raw.reason !== '' ? { reason: raw.reason } : {}),
    ...(displayReason !== '' ? { displayReason } : {}),
    ...(typeof raw.callId === 'string' && raw.callId !== '' ? { callId: raw.callId } : {}),
    ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
    at: new Date(now).toISOString(),
    /** 本地是否已经点过按钮（避免连点；电脑端 pending 期间不重发）。 */
    replied: false,
    repliedOutcome: undefined,
  }
}

/**
 * 把一个附件的各种来源（inline / upload / echo / 文件推送）归一成渲染结构。
 * @param {any} file
 * @returns {{name: string, size: number, mime: string, fileId?: string, uploadId?: string, url?: string} | undefined}
 */
export function normalizeAttachment(file) {
  if (!file || typeof file !== 'object') return undefined
  const name = String(file.name ?? '').slice(0, 200) || '附件'
  const size = Number.isFinite(Number(file.size)) ? Math.max(0, Number(file.size)) : 0
  return {
    name,
    size,
    mime: String(file.mime ?? ''),
    ...(typeof file.fileId === 'string' && file.fileId !== '' ? { fileId: file.fileId } : {}),
    ...(typeof file.uploadId === 'string' && file.uploadId !== '' ? { uploadId: file.uploadId } : {}),
    ...(typeof file.url === 'string' && file.url !== '' ? { url: file.url } : {}),
    ...(typeof file.path === 'string' && file.path !== '' ? { path: file.path } : {}),
  }
}

/**
 * @param {any} files
 * @returns {ReturnType<typeof normalizeAttachment>[]}
 */
export function normalizeAttachments(files) {
  if (!Array.isArray(files)) return []
  return files.map(normalizeAttachment).filter(Boolean)
}

/**
 * 会话模型。
 */
export class ChatModel {
  /**
   * @param {{limit?: number, myDeviceId?: string}} [options]
   */
  constructor(options = {}) {
    /** 本地最多保留的消息条数（超出丢最旧的，避免手机内存无限涨）。 */
    this.limit = Math.max(20, options.limit ?? 400)
    /** @type {any[]} 渲染顺序即数组顺序 */
    this.messages = []
    /** @type {Map<string, any>} */
    this.byId = new Map()
    /** @type {Map<string, Map<string, {index: number, text: string}>>} callId → messageId → part */
    this.parts = new Map()
    /** @type {Map<string, number>} callId → 已应用的 delta seq */
    this.deltaSeq = new Map()
    /** @type {Set<string>} 正在输入的 callId */
    this.typing = new Set()
    /** @type {Map<string, any>} fileId → 文件元信息 */
    this.files = new Map()
    /** 已应用的最大事件 seq。 */
    this.cursor = 0
    /** @type {string | null} */
    this.sessionId = null
    this.sessionEpoch = 0
    /** 当前会话的人类可读标题（来自 session/state / session/selected / 会话列表）。 */
    this.sessionTitle = ''
    /** @type {any[]} 电脑上的会话列表（`sessions` 帧，新的在前）。 */
    this.sessions = []
    /** `sessions.current`：电脑认为这台设备当前绑定的会话。 */
    this.sessionsCurrent = ''
    /** 会话列表是否被电脑截断。 */
    this.sessionsTruncated = false
    /** @type {any | null} 最近一次 session/selected 的结果（UI 用来提示/关面板）。 */
    this.lastSessionSelection = null
    /** @type {any[]} 待处理审批，队首是最早收到的。 */
    this.approvals = []
    /** @type {Map<string, any>} */
    this.approvalsById = new Map()
    /** @type {{message: string, code?: string, at: string} | null} */
    this.lastError = null
    this.myDeviceId = options.myDeviceId ?? ''
    this.changedAt = 0
  }

  /** @param {string} deviceId */
  setDeviceId(deviceId) {
    this.myDeviceId = String(deviceId ?? '')
  }

  /** 最近一条助手消息是否还在生成（决定「停止生成」按钮显隐）。 */
  get activeCallId() {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]
      if (message.kind === 'assistant' && message.status === MESSAGE_STATUS.STREAMING) return message.callId
    }
    return undefined
  }

  /** 是否有任何 call 正在输入（渲染打字指示器）。 */
  get isTyping() {
    return this.typing.size > 0
  }

  /** @param {number} [now] */
  #touch(now = Date.now()) {
    this.changedAt = now
  }

  /**
   * 插入一条消息；同 id 已存在时返回 false（去重的唯一入口）。
   * @param {any} message
   * @returns {boolean}
   */
  #insert(message) {
    if (!message?.id || this.byId.has(message.id)) return false
    this.byId.set(message.id, message)
    this.messages.push(message)
    this.#trim()
    return true
  }

  /**
   * @param {string} id
   * @param {object} patch
   * @returns {boolean}
   */
  #update(id, patch) {
    const existing = this.byId.get(id)
    if (!existing) return false
    Object.assign(existing, patch)
    return true
  }

  #trim() {
    while (this.messages.length > this.limit) {
      const removed = this.messages.shift()
      if (removed) {
        this.byId.delete(removed.id)
        if (removed.callId) this.parts.delete(removed.callId)
      }
    }
  }

  /** 清空会话（会话切换 / 用户手动清空）。审批属于某个会话，一并清掉。 */
  clearConversation() {
    this.messages = []
    this.byId.clear()
    this.parts.clear()
    this.deltaSeq.clear()
    this.typing.clear()
    this.files.clear()
    this.cursor = 0
    this.lastError = null
    this.clearApprovals()
    this.#touch()
  }

  /**
   * 电脑端在 hello/ack 里告诉我们「你绑定的会话变了」（插件重启后重建了绑定、
   * 或另一个窗口切换过会话）：旧会话的本地视图 / cursor / 审批全部作废，
   * 等随后到达的 `session/state` 整页替换。
   * @param {unknown} sessionId
   * @param {unknown} sessionEpoch
   * @returns {boolean} 是否真的换了会话
   */
  adoptServerSession(sessionId, sessionEpoch) {
    const nextId = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
    const nextEpoch = Number.isFinite(Number(sessionEpoch)) ? Number(sessionEpoch) : 0
    if (nextId === this.sessionId && nextEpoch === this.sessionEpoch) return false
    this.clearConversation()
    this.sessionId = nextId
    this.sessionEpoch = nextEpoch
    this.sessionTitle = ''
    this.#touch()
    return true
  }

  /** 清空待处理审批（会话切换、解绑时调用）。 */
  clearApprovals() {
    this.approvals = []
    this.approvalsById.clear()
  }

  /**
   * 本地已经点了审批按钮：标记该条为已回复，避免连点/重发。
   * @param {string} approvalId
   * @param {'allowed-once'|'rejected'} outcome
   * @returns {boolean} false 表示这条审批已不在队列里（已 resolved / 已回复）
   */
  markApprovalReplied(approvalId, outcome) {
    const approval = this.approvalsById.get(String(approvalId ?? ''))
    if (!approval || approval.replied === true) return false
    approval.replied = true
    approval.repliedOutcome = outcome
    approval.repliedAt = new Date().toISOString()
    this.#touch()
    return true
  }

  /** 是否还有未回答的审批（决定是否跑倒计时定时器）。 */
  get hasPendingApprovals() {
    return this.approvals.length > 0
  }

  /**
   * 本地先插入用户消息（乐观 UI）。之后 `chat/echo` 回来会按同一个 id 合并。
   * @param {{msgId: string, text: string, at?: string, files?: any[], status?: string}} input
   * @returns {any}
   */
  addLocalUserMessage(input) {
    const msgId = String(input.msgId ?? '')
    const message = {
      id: userMessageId(msgId),
      kind: 'user',
      text: String(input.text ?? ''),
      at: String(input.at ?? new Date().toISOString()),
      files: normalizeAttachments(input.files),
      status: input.status ?? MESSAGE_STATUS.PENDING,
      msgId,
      mine: true,
      streaming: false,
    }
    if (!this.#insert(message)) {
      const existing = this.byId.get(message.id)
      if (existing) Object.assign(existing, { text: message.text, files: message.files, status: message.status })
      this.#touch()
      return existing
    }
    this.#touch()
    return message
  }

  /**
   * 发送被电脑确认。`duplicate: true` 表示电脑端判定为重发（幂等命中），同样算已发送。
   * @param {string} msgId
   * @param {{callId?: string, duplicate?: boolean}} [info]
   * @returns {boolean}
   */
  markUserMessageSent(msgId, info = {}) {
    const id = userMessageId(msgId)
    const changed = this.#update(id, {
      status: MESSAGE_STATUS.SENT,
      callId: info.callId,
      duplicate: info.duplicate === true,
      error: undefined,
    })
    if (changed) this.#touch()
    return changed
  }

  /**
   * 发送失败（断线 / 服务端拒绝），UI 显示重发按钮。
   * @param {string} msgId
   * @param {string} reason
   * @returns {boolean}
   */
  markUserMessageFailed(msgId, reason) {
    const changed = this.#update(userMessageId(msgId), {
      status: MESSAGE_STATUS.ERROR,
      error: String(reason ?? '发送失败'),
    })
    if (changed) this.#touch()
    return changed
  }

  /**
   * 把一条用户消息重新标为待发送（重发用；重发沿用同一个 msgId 保证幂等）。
   * @param {string} msgId
   * @returns {boolean}
   */
  resetUserMessageForRetry(msgId) {
    const changed = this.#update(userMessageId(msgId), { status: MESSAGE_STATUS.PENDING, error: undefined })
    if (changed) this.#touch()
    return changed
  }

  /**
   * 处理一条电脑端帧。
   * @param {any} frame
   * @param {{now?: number}} [options]
   * @returns {{handled: boolean, changed: boolean, sessionChanged?: boolean, needsSync?: boolean, frame?: any}}
   */
  applyFrame(frame, options = {}) {
    if (!frame || typeof frame.t !== 'string') return { handled: false, changed: false }
    const now = options.now ?? Date.now()
    switch (frame.t) {
      case SERVER_FRAME.CHAT_ACK:
        return this.#onChatAck(frame, now)
      case SERVER_FRAME.CHAT_ECHO:
        return this.#onEcho(frame, now)
      case SERVER_FRAME.CHAT_MESSAGE:
        return this.#onAssistantMessage(frame, now)
      case SERVER_FRAME.CHAT_DELTA:
        return this.#onDelta(frame, now)
      case SERVER_FRAME.CHAT_DONE:
        return this.#onDone(frame, now)
      case SERVER_FRAME.CHAT_ERROR:
        return this.#onChatError(frame, now)
      case SERVER_FRAME.TOOL:
        return this.#onTool(frame, now)
      case SERVER_FRAME.TYPING:
        return this.#onTyping(frame, now)
      case SERVER_FRAME.SESSION_STATE:
        return this.#onSessionState(frame, now)
      case SERVER_FRAME.SESSION_EVENTS:
        return this.#onSessionEvents(frame, now)
      case SERVER_FRAME.SESSIONS:
        return this.#onSessions(frame, now)
      case SERVER_FRAME.SESSION_SELECTED:
        return this.#onSessionSelected(frame, now)
      case SERVER_FRAME.APPROVAL_ASK:
        return this.#onApprovalAsk(frame, now)
      case SERVER_FRAME.APPROVAL_RESOLVED:
        return this.#onApprovalResolved(frame, now)
      case SERVER_FRAME.FILE_OFFERED:
        return this.#onFileOffered(frame, now)
      case SERVER_FRAME.ERROR:
        return this.#onError(frame, now)
      default:
        // 未知帧忽略：老客户端 / 新电脑端互相都靠这条规则活着。
        return { handled: false, changed: false, frame }
    }
  }

  /** @param {any} frame @param {number} now */
  #onChatAck(frame, now) {
    const rid = String(frame.rid ?? frame.callId ?? '')
    if (rid === '') return { handled: true, changed: false, frame }
    const changed = this.markUserMessageSent(rid, { callId: frame.callId, duplicate: frame.duplicate === true })
    if (changed) this.#touch(now)
    return { handled: true, changed, frame }
  }

  /** @param {any} frame @param {number} now */
  #onEcho(frame, now) {
    const msgId = String(frame.msgId ?? '')
    if (msgId === '') return { handled: true, changed: false, frame }
    const id = userMessageId(msgId)
    const existing = this.byId.get(id)
    if (existing) {
      // 本地乐观消息 or 回放重复：用电脑端权威内容覆盖，但保住本地状态里更有用的信息。
      Object.assign(existing, {
        text: typeof frame.text === 'string' && frame.text !== '' ? frame.text : existing.text,
        at: String(frame.at ?? existing.at),
        files: normalizeAttachments(frame.files).length > 0 ? normalizeAttachments(frame.files) : existing.files,
        status: MESSAGE_STATUS.SENT,
        deviceId: frame.deviceId,
        seq: Number.isFinite(Number(frame.seq)) ? Number(frame.seq) : existing.seq,
      })
      this.#advanceCursor(frame.seq)
      this.#touch(now)
      return { handled: true, changed: true, frame }
    }
    const inserted = this.#insert({
      id,
      kind: 'user',
      text: String(frame.text ?? ''),
      at: String(frame.at ?? new Date().toISOString()),
      files: normalizeAttachments(frame.files),
      status: MESSAGE_STATUS.SENT,
      msgId,
      deviceId: frame.deviceId,
      seq: Number.isFinite(Number(frame.seq)) ? Number(frame.seq) : undefined,
      mine: this.myDeviceId !== '' && frame.deviceId === this.myDeviceId,
    })
    this.#advanceCursor(frame.seq)
    if (this.myDeviceId !== '' && frame.deviceId === this.myDeviceId) this.typing.delete(frame.callId)
    if (inserted) this.#touch(now)
    return { handled: true, changed: inserted, frame }
  }

  /** 把 callId 的 parts 合成全文。 */
  #joinParts(callId) {
    const parts = this.parts.get(callId)
    if (!parts || parts.size === 0) return ''
    return [...parts.values()]
      .sort((a, b) => a.index - b.index)
      .map(part => part.text)
      .filter(text => text !== '')
      .join('\n\n')
  }

  /** 确保 callId 对应一条助手气泡，返回它。 */
  #ensureAssistantMessage(callId, now) {
    const id = assistantMessageId(callId)
    const existing = this.byId.get(id)
    if (existing) return { message: existing, inserted: false }
    const message = {
      id,
      kind: 'assistant',
      text: '',
      at: new Date(now).toISOString(),
      callId,
      status: MESSAGE_STATUS.STREAMING,
      tools: [],
    }
    this.#insert(message)
    return { message, inserted: true }
  }

  /** @param {any} frame @param {number} now */
  #onAssistantMessage(frame, now) {
    const callId = String(frame.callId ?? '')
    const messageId = String(frame.messageId ?? '')
    if (callId === '' || messageId === '') return { handled: true, changed: false, frame }
    const parts = this.parts.get(callId) ?? new Map()
    const index = Number.isFinite(Number(frame.index)) ? Number(frame.index) : parts.size
    parts.set(messageId, { index, text: String(frame.text ?? '') })
    this.parts.set(callId, parts)
    const { message, inserted } = this.#ensureAssistantMessage(callId, now)
    this.#advanceCursor(frame.seq)
    // 已经 chat/done 收尾的消息不允许被迟到的 chat/message 回退（重连回放时可能出现）。
    if (!inserted && message.status === MESSAGE_STATUS.DONE) return { handled: true, changed: false, frame }
    const text = this.#joinParts(callId)
    const nextText = text === '' ? message.text : text
    const changed = inserted || message.text !== nextText || message.status !== MESSAGE_STATUS.STREAMING
    message.text = nextText
    message.status = MESSAGE_STATUS.STREAMING
    message.typing = false
    if (changed) this.#touch(now)
    return { handled: true, changed, frame }
  }

  /** @param {any} frame @param {number} now */
  #onDelta(frame, now) {
    const callId = String(frame.callId ?? '')
    if (callId === '') return { handled: true, changed: false, frame }
    const seq = Number(frame.seq)
    if (Number.isFinite(seq)) {
      const last = this.deltaSeq.get(callId) ?? -1
      if (seq <= last) return { handled: true, changed: false, frame }
      this.deltaSeq.set(callId, seq)
    }
    // 新版电脑端会用 chat/message 推全文；这时 delta 只是心跳，不能重复拼文本。
    if (this.parts.has(callId)) return { handled: true, changed: false, frame }
    const existing = this.byId.get(assistantMessageId(callId))
    if (existing && existing.status === MESSAGE_STATUS.DONE) return { handled: true, changed: false, frame }
    const { message, inserted } = this.#ensureAssistantMessage(callId, now)
    const text = String(frame.text ?? '')
    message.text = `${message.text ?? ''}${text}`
    message.status = MESSAGE_STATUS.STREAMING
    this.#advanceCursor(seq)
    if (inserted || text !== '') this.#touch(now)
    return { handled: true, changed: inserted || text !== '', frame }
  }

  /** @param {any} frame @param {number} now */
  #onDone(frame, now) {
    const callId = String(frame.callId ?? '')
    if (callId === '') return { handled: true, changed: false, frame }
    const { message, inserted } = this.#ensureAssistantMessage(callId, now)
    const authoritative = typeof frame.text === 'string' ? frame.text : ''
    const joined = this.#joinParts(callId)
    const next = authoritative !== '' ? authoritative : joined !== '' ? joined : message.text
    message.text = next
    message.status = MESSAGE_STATUS.DONE
    message.truncated = frame.truncated === true
    message.durationMs = Number.isFinite(Number(frame.durationMs)) ? Number(frame.durationMs) : undefined
    if (Array.isArray(frame.files) && frame.files.length > 0) message.files = normalizeAttachments(frame.files)
    this.typing.delete(callId)
    this.#advanceCursor(frame.seq)
    this.parts.delete(callId)
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /** @param {any} frame @param {number} now */
  #onChatError(frame, now) {
    const callId = String(frame.callId ?? '')
    const reason = String(frame.message ?? '处理失败')
    this.lastError = { message: reason, code: frame.code, at: new Date(now).toISOString() }
    if (callId === '') return { handled: true, changed: true, frame }
    const info = this.#ensureAssistantMessage(callId, now)
    info.message.status = MESSAGE_STATUS.ERROR
    info.message.text = info.message.text || reason
    info.message.error = reason
    this.typing.delete(callId)
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /** @param {any} frame @param {number} now */
  #onTool(frame, now) {
    const callId = String(frame.callId ?? '')
    if (callId === '') return { handled: true, changed: false, frame }
    const { message, inserted } = this.#ensureAssistantMessage(callId, now)
    const toolCallId = String(frame.toolCallId ?? `${frame.tool ?? 'tool'}-${now}`)
    const tools = Array.isArray(message.tools) ? message.tools : []
    const existing = tools.find(tool => tool.toolCallId === toolCallId)
    const phase = String(frame.phase ?? 'tool-end')
    if (existing) {
      existing.phase = phase
      existing.summary = frame.summary ?? existing.summary
      existing.ok = frame.ok ?? existing.ok
    } else {
      tools.push({
        toolCallId,
        tool: String(frame.tool ?? '工具'),
        phase,
        summary: frame.summary,
        ok: frame.ok,
      })
    }
    message.tools = tools
    if (phase === 'tool-start') message.status = MESSAGE_STATUS.STREAMING
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /** @param {any} frame @param {number} now */
  #onTyping(frame, now) {
    const callId = String(frame.callId ?? '')
    if (callId === '') return { handled: true, changed: false, frame }
    const active = frame.active !== false
    if (active) this.typing.add(callId)
    else this.typing.delete(callId)
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /** @param {any} frame @param {number} now */
  #onSessionState(frame, now) {
    const sessionId = String(frame.sessionId ?? this.sessionId ?? '')
    const epoch = Number.isFinite(Number(frame.sessionEpoch)) ? Number(frame.sessionEpoch) : this.sessionEpoch
    const sessionChanged = sessionId !== this.sessionId || epoch !== this.sessionEpoch
    if (sessionChanged) {
      // 换会话 = 换一整套上下文：旧会话的待办审批与输入态必须先清掉，再按新快照
      // 重建；否则上一会话的“正在输入”会残留到新会话里。
      this.clearApprovals()
      this.typing.clear()
    }
    const snapshot = frame.snapshot && typeof frame.snapshot === 'object' ? frame.snapshot : {}
    const incoming = Array.isArray(snapshot.messages) ? snapshot.messages : []
    /** @type {any[]} */
    const nextMessages = []
    /** @type {Map<string, any>} */
    const nextById = new Map()
    for (const raw of incoming) {
      const normalized = this.#normalizeSnapshotMessage(raw, now)
      if (!normalized || nextById.has(normalized.id)) continue
      nextById.set(normalized.id, normalized)
      nextMessages.push(normalized)
    }
    // 快照里可能带一条正在生成的助手消息（activeCall）。
    const activeCall = snapshot.activeCall
    if (activeCall && typeof activeCall.callId === 'string' && activeCall.callId !== '') {
      const id = assistantMessageId(activeCall.callId)
      const existing = nextById.get(id)
      if (existing) {
        existing.status = MESSAGE_STATUS.STREAMING
        existing.text = String(activeCall.text ?? existing.text ?? '')
      } else {
        const message = {
          id,
          kind: 'assistant',
          text: String(activeCall.text ?? ''),
          at: new Date(now).toISOString(),
          callId: activeCall.callId,
          status: MESSAGE_STATUS.STREAMING,
          tools: [],
        }
        nextById.set(id, message)
        nextMessages.push(message)
      }
      if (activeCall.typing !== false) this.typing.add(activeCall.callId)
    }
    this.messages = nextMessages.slice(-this.limit)
    this.byId = new Map(this.messages.map(message => [message.id, message]))
    this.parts.clear()
    this.deltaSeq.clear()
    if (typeof frame.title === 'string' && frame.title !== '') this.sessionTitle = frame.title
    this.sessionId = sessionId
    this.sessionEpoch = epoch
    const head = Number(frame.head)
    if (Number.isFinite(head)) {
      // 换会话后 cursor 必须跟着新会话走（取快照的 head，而不是和旧会话取 max），
      // 否则下一次 session/sync 会用旧会话的 seq 去要增量。
      this.cursor = sessionChanged ? Math.max(0, head) : Math.max(this.cursor, head)
    }
    this.#touch(now)
    return { handled: true, changed: true, sessionChanged, frame }
  }

  /**
   * 把快照里的一条消息归一化成渲染结构。
   * @param {any} raw
   * @param {number} now
   */
  #normalizeSnapshotMessage(raw, now) {
    if (!raw || typeof raw !== 'object') return undefined
    const kind = raw.kind === 'assistant' ? 'assistant' : 'user'
    let id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : ''
    if (id === '') {
      if (kind === 'user' && typeof raw.msgId === 'string') id = userMessageId(raw.msgId)
      else if (kind === 'assistant' && typeof raw.callId === 'string') id = assistantMessageId(raw.callId)
      else return undefined
    }
    return {
      id,
      kind,
      text: String(raw.text ?? ''),
      at: String(raw.at ?? new Date(now).toISOString()),
      files: normalizeAttachments(raw.files),
      status: kind === 'assistant' ? MESSAGE_STATUS.DONE : MESSAGE_STATUS.SENT,
      msgId: raw.msgId,
      callId: raw.callId,
      mine: kind === 'user' && this.myDeviceId !== '' ? false : undefined,
    }
  }

  /** @param {any} frame @param {number} now */
  #onSessionEvents(frame, now) {
    const events = Array.isArray(frame.events) ? frame.events : []
    const sessionId = String(frame.sessionId ?? this.sessionId ?? '')
    const epoch = Number.isFinite(Number(frame.sessionEpoch)) ? Number(frame.sessionEpoch) : this.sessionEpoch
    const sessionChanged = sessionId !== this.sessionId || epoch !== this.sessionEpoch
    if (sessionChanged) {
      this.sessionId = sessionId
      this.sessionEpoch = epoch
      // 事件回放里出现新会话：上一会话的审批作废（电脑端会补 resolved，但界面要立刻清），
      // cursor 也要从新会话的 from 重新起算，不能被旧会话的 seq 挡住。
      this.clearApprovals()
      this.typing.clear()
      this.cursor = Number.isFinite(Number(frame.from)) ? Math.max(0, Number(frame.from)) : 0
    }
    let changed = false
    for (const event of events) {
      const seq = Number(event?.seq)
      if (Number.isFinite(seq)) {
        if (seq <= this.cursor) continue
        const result = this.applyFrame(event, { now })
        this.cursor = Math.max(this.cursor, seq)
        changed = changed || result.changed
      } else if (event && typeof event.t === 'string') {
        const result = this.applyFrame(event, { now })
        changed = changed || result.changed
      }
    }
    if (Number.isFinite(Number(frame.head))) this.cursor = Math.max(this.cursor, Number(frame.head))
    if (changed) this.#touch(now)
    return { handled: true, changed, sessionChanged, frame }
  }

  /**
   * `sessions`：会话选择器的数据源（电脑上的 DSH 会话，新的在前）。
   * 重复/非法条目直接过滤，`current` 以帧为准重算，避免本地标记过期。
   * @param {any} frame
   * @param {number} now
   */
  #onSessions(frame, now) {
    const raw = Array.isArray(frame.sessions) ? frame.sessions : []
    /** @type {any[]} */
    const next = []
    const seen = new Set()
    for (const item of raw) {
      const summary = normalizeSessionSummary(item)
      if (!summary || seen.has(summary.id)) continue
      seen.add(summary.id)
      next.push(summary)
    }
    const current = typeof frame.current === 'string' && frame.current !== '' ? frame.current : this.sessionsCurrent
    this.sessions = next
    this.sessionsCurrent = current
    this.sessionsTruncated = frame.truncated === true
    for (const summary of this.sessions) summary.current = summary.id === current
    // 列表里的标题比会话快照更及时（重命名后刷新列表就能看到）。
    const active = this.sessions.find(summary => summary.id === this.sessionId)
    if (active) this.sessionTitle = active.title
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /**
   * `session/selected`：`session/select` / `session/create` 的结果。
   * 成功时电脑紧接着推 `session/state`，由它整页替换消息；这里只记录结果。
   * @param {any} frame
   * @param {number} now
   */
  #onSessionSelected(frame, now) {
    const ok = frame.ok === true
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
    const title = typeof frame.title === 'string' ? frame.title : ''
    this.lastSessionSelection = {
      ok,
      sessionId,
      title: title || undefined,
      error: typeof frame.error === 'string' ? frame.error : undefined,
      message: typeof frame.message === 'string' ? frame.message : undefined,
      at: new Date(now).toISOString(),
    }
    if (ok) {
      this.sessionsCurrent = sessionId || this.sessionsCurrent
      for (const summary of this.sessions) summary.current = summary.id === this.sessionsCurrent
      if (title !== '') this.sessionTitle = title
      if (sessionId !== '' && sessionId !== this.sessionId) {
        // 真正的消息替换在随后到达的 session/state；先清掉上一会话的审批。
        this.clearApprovals()
        this.typing.clear()
      }
    }
    this.#touch(now)
    return { handled: true, changed: true, frame, selection: this.lastSessionSelection }
  }

  /**
   * `approval/ask`：进待处理队列。同 approvalId 的重发只更新内容（幂等），
   * 不同 approvalId 一律排队——多条请求同时到来时不能互相覆盖。
   * @param {any} frame
   * @param {number} now
   */
  #onApprovalAsk(frame, now) {
    const approval = normalizeApproval(frame, now)
    if (!approval) return { handled: true, changed: false, frame }
    const existing = this.approvalsById.get(approval.approvalId)
    if (existing) {
      Object.assign(existing, approval, {
        replied: existing.replied === true,
        repliedOutcome: existing.repliedOutcome,
        repliedAt: existing.repliedAt,
      })
      this.#touch(now)
      return { handled: true, changed: true, frame, approval: existing }
    }
    if (this.approvals.length >= APPROVAL_QUEUE_LIMIT) {
      const dropped = this.approvals.shift()
      if (dropped) this.approvalsById.delete(dropped.approvalId)
    }
    this.approvals.push(approval)
    this.approvalsById.set(approval.approvalId, approval)
    this.#touch(now)
    return { handled: true, changed: true, frame, approval }
  }

  /**
   * `approval/resolved`：出队（无论结果如何都不该再显示可点的按钮）。
   * @param {any} frame
   * @param {number} now
   */
  #onApprovalResolved(frame, now) {
    const approvalId = String(frame.approvalId ?? '')
    if (approvalId === '') return { handled: true, changed: false, frame }
    const index = this.approvals.findIndex(item => item.approvalId === approvalId)
    this.approvalsById.delete(approvalId)
    if (index >= 0) this.approvals.splice(index, 1)
    const outcome = typeof frame.outcome === 'string' ? frame.outcome : ''
    const source = typeof frame.source === 'string' ? frame.source : ''
    if (index >= 0) this.#touch(now)
    return {
      handled: true,
      changed: index >= 0,
      frame,
      resolved: { approvalId, outcome, source },
    }
  }

  /** @param {any} frame @param {number} now */
  #onFileOffered(frame, now) {
    const fileId = String(frame.fileId ?? '')
    if (fileId === '') return { handled: true, changed: false, frame }
    const meta = {
      fileId,
      name: String(frame.name ?? '文件'),
      size: Number.isFinite(Number(frame.size)) ? Number(frame.size) : 0,
      mime: String(frame.mime ?? ''),
      url: typeof frame.url === 'string' ? frame.url : '',
      from: typeof frame.from === 'string' ? frame.from : '',
      at: String(frame.at ?? new Date(now).toISOString()),
      seq: Number.isFinite(Number(frame.seq)) ? Number(frame.seq) : undefined,
    }
    this.files.set(fileId, { ...(this.files.get(fileId) ?? {}), ...meta })
    const id = fileMessageId(fileId)
    if (this.byId.has(id)) {
      this.#update(id, { file: meta })
      this.#advanceCursor(frame.seq)
      this.#touch(now)
      return { handled: true, changed: true, frame }
    }
    const inserted = this.#insert({
      id,
      kind: 'file',
      text: meta.name,
      at: meta.at,
      file: meta,
      callId: undefined,
      status: MESSAGE_STATUS.DONE,
    })
    this.#advanceCursor(frame.seq)
    if (inserted) this.#touch(now)
    return { handled: true, changed: inserted, frame }
  }

  /** @param {any} frame @param {number} now */
  #onError(frame, now) {
    this.lastError = {
      message: String(frame.message ?? '连接出错'),
      code: typeof frame.code === 'string' ? frame.code : undefined,
      at: new Date(now).toISOString(),
    }
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /** @param {unknown} seq */
  #advanceCursor(seq) {
    const value = Number(seq)
    if (Number.isFinite(value) && value > this.cursor) this.cursor = value
  }

  /**
   * 需要持久化到 localStorage 的最小状态。
   * @param {{limit?: number}} [options]
   * @returns {object}
   */
  snapshotForStorage(options = {}) {
    const limit = options.limit ?? 200
    return {
      version: 2,
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      sessionTitle: this.sessionTitle,
      cursor: this.cursor,
      messages: this.messages.slice(-limit).map(message => ({
        id: message.id,
        kind: message.kind,
        text: message.text,
        at: message.at,
        files: message.files,
        status: message.status === MESSAGE_STATUS.PENDING ? MESSAGE_STATUS.ERROR : message.status,
        error: message.error,
        callId: message.callId,
        msgId: message.msgId,
        file: message.file,
        truncated: message.truncated,
      })),
    }
  }

  /**
   * 从 localStorage 恢复。
   *
   * 待处理审批**不**落盘：`approval/ask` 是一次性、有时效的请求，刷新后界面
   * 重新等电脑端推；把旧卡片恢复出来只会让人对已经超时的请求点按钮。
   * @param {any} saved
   * @returns {boolean}
   */
  restoreFromStorage(saved) {
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.messages)) return false
    this.messages = []
    this.byId.clear()
    this.parts.clear()
    this.deltaSeq.clear()
    this.typing.clear()
    this.files.clear()
    this.clearApprovals()
    for (const raw of saved.messages) {
      if (!raw || typeof raw.id !== 'string') continue
      const message = { ...raw, tools: Array.isArray(raw.tools) ? raw.tools : [] }
      if (message.kind === 'file' && message.file?.fileId) this.files.set(message.file.fileId, message.file)
      if (this.byId.has(message.id)) continue
      this.byId.set(message.id, message)
      this.messages.push(message)
    }
    this.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : null
    this.sessionEpoch = Number.isFinite(Number(saved.sessionEpoch)) ? Number(saved.sessionEpoch) : 0
    this.sessionTitle = typeof saved.sessionTitle === 'string' ? saved.sessionTitle : ''
    this.cursor = Number.isFinite(Number(saved.cursor)) ? Number(saved.cursor) : 0
    this.#trim()
    this.#touch()
    return true
  }

  /**
   * 把一段超长助手文本按协议上限截断（渲染前兜底）。
   * @param {string} text
   * @returns {{text: string, truncated: boolean}}
   */
  static clamp(text) {
    return clampAssistantText(String(text ?? ''))
  }
}

/** 客户端会发的帧（导出便于测试与 UI 逻辑判断）。 */
export const CLIENT_FRAMES = CLIENT_FRAME
