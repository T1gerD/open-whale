// 会话模型：把电脑端推来的帧合并成一份「可直接渲染的消息列表」。
//
// 这是网页版最容易出 bug 的一层（v2.2.0 专门修的就是「重复拼接 / 看不到别人消息 /
// 重连丢消息」），所以它被写成零 DOM 的纯逻辑，`test/messages.test.mjs` 全量覆盖：
//
//  * 用户消息 id = `usr_<msgId>`（本地先插入，echo 回来时**更新**而不是再插一条）；
//  * 助手消息 id = `msg_<callId>`（按 messageId upsert，`chat/done` 全文覆盖）；
//  * `chat/delta` 只在不支持 `chat/message` 的老电脑端上追加，且按 seq 去重；
//  * `session/state` 幂等覆盖，`session/events` 按 seq 回放，cursor 持久化；
//  * 未知帧一律忽略（协议只增不改）。

import { CLIENT_FRAME, SERVER_FRAME } from './protocol.mjs'
import { clampAssistantText } from './protocol.mjs'

/** 用户消息 id 前缀。 */
export const USER_MESSAGE_PREFIX = 'usr_'
/** 助手消息 id 前缀。 */
export const ASSISTANT_MESSAGE_PREFIX = 'msg_'
/** 电脑推送的文件消息 id 前缀。 */
export const FILE_MESSAGE_PREFIX = 'file_'

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
    this.collaboration = false
    /** @type {Array<{deviceId: string, name: string, online: boolean}>} */
    this.participants = []
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

  /** 清空会话（会话切换 / 用户手动清空）。 */
  clearConversation() {
    this.messages = []
    this.byId.clear()
    this.parts.clear()
    this.deltaSeq.clear()
    this.typing.clear()
    this.files.clear()
    this.cursor = 0
    this.lastError = null
    this.#touch()
  }

  /**
   * 本地先插入用户消息（乐观 UI）。之后 `chat/echo` 回来会按同一个 id 合并。
   * @param {{msgId: string, text: string, at?: string, speaker?: string, files?: any[], status?: string}} input
   * @returns {any}
   */
  addLocalUserMessage(input) {
    const msgId = String(input.msgId ?? '')
    const message = {
      id: userMessageId(msgId),
      kind: 'user',
      text: String(input.text ?? ''),
      at: String(input.at ?? new Date().toISOString()),
      speaker: input.speaker,
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
      case SERVER_FRAME.PARTICIPANTS:
        return this.#onParticipants(frame, now)
      case SERVER_FRAME.COLLAB_STATE:
        return this.#onCollabState(frame, now)
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
        speaker: frame.speaker ?? existing.speaker,
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
      speaker: frame.speaker,
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
    this.sessionId = sessionId
    this.sessionEpoch = epoch
    this.collaboration = frame.collaboration === true
    if (Number.isFinite(Number(frame.head))) {
      this.cursor = Math.max(this.cursor, Number(frame.head))
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
      speaker: raw.speaker,
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

  /** @param {any} frame @param {number} now */
  #onParticipants(frame, now) {
    const list = Array.isArray(frame.participants) ? frame.participants : []
    this.participants = list
      .filter(item => item && typeof item.deviceId === 'string')
      .map(item => ({
        deviceId: item.deviceId,
        name: String(item.name ?? item.deviceName ?? '设备'),
        online: item.online !== false,
        self: item.deviceId === this.myDeviceId,
      }))
    if (typeof frame.collaboration === 'boolean') this.collaboration = frame.collaboration
    if (typeof frame.sessionId === 'string' && frame.sessionId !== '') this.sessionId = frame.sessionId
    this.#touch(now)
    return { handled: true, changed: true, frame }
  }

  /** @param {any} frame @param {number} now */
  #onCollabState(frame, now) {
    this.collaboration = frame.on === true
    const epoch = Number.isFinite(Number(frame.sessionEpoch)) ? Number(frame.sessionEpoch) : this.sessionEpoch
    const sessionId = String(frame.sessionId ?? this.sessionId ?? '')
    const sessionChanged = sessionId !== this.sessionId || epoch !== this.sessionEpoch
    this.sessionEpoch = epoch
    this.sessionId = sessionId
    if (sessionChanged) {
      // 协作模式开关会重建会话：本地旧消息必须清掉，等 session/state 快照。
      this.clearConversation()
      this.sessionId = sessionId
      this.sessionEpoch = epoch
      this.collaboration = frame.on === true
    }
    this.#touch(now)
    return { handled: true, changed: true, sessionChanged, needsSync: sessionChanged, frame }
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
      version: 1,
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      cursor: this.cursor,
      collaboration: this.collaboration,
      participants: this.participants.slice(0, 20),
      messages: this.messages.slice(-limit).map(message => ({
        id: message.id,
        kind: message.kind,
        text: message.text,
        at: message.at,
        speaker: message.speaker,
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
    this.cursor = Number.isFinite(Number(saved.cursor)) ? Number(saved.cursor) : 0
    this.collaboration = saved.collaboration === true
    this.participants = Array.isArray(saved.participants) ? saved.participants : []
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
