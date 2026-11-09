// 会话模型：两层结构，把电脑端推来的帧合并成「可直接渲染的消息列表」。
//
// 这一层刻意是零 DOM 的纯逻辑，`test/messages.test.mjs` 全量覆盖：
//
//  * 用户消息 id = `usr_<msgId>`（本地先插入，echo 回来时**更新**而不是再插一条）；
//  * 助手消息 id = `msg_<callId>`（按 messageId upsert，`chat/done` 全文覆盖）；
//  * `chat/delta` 只在不支持 `chat/message` 的老电脑端上追加，且按 seq 去重；
//  * `session/state` 幂等覆盖，`session/events` 按 seq 回放，cursor 持久化；
//  * `approval/ask` 进队列、`approval/resolved` 出队，多条待办审批**排队**而不是互相覆盖；
//  * 未知帧一律忽略（协议只增不改）。
//
// v2.4.0（协议 1.3.0）把「一个会话」升级成「一组会话标签」：
//
//  * `ChatModel` 仍然只管**一个**会话的消息 / 游标 / 审批；
//  * `ChatTabsModel` 负责标签（`tabs` / `activeSessionId` / `chats` / `activity`），
//    按帧里的 `sessionId` 把事件路由到对应会话（没有 `sessionId` 的旧帧进当前会话），
//    并维护「运行中 / 未读 / 最近活动时间」与审批角标。
//
// 协作（共享会话 / 在线成员 / 昵称前缀）已在 v2.3.0 删除：每台设备只驱动它当前
// 绑定的那个 DSH 会话，消息里不再有 `speaker`。

import {
  CLIENT_FRAME,
  QUESTION_MAX_ITEMS,
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_TEXT,
  SERVER_FRAME,
  SESSION_WATCH_LIMIT,
} from './protocol.mjs'
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

/**
 * 这条文本是不是 harness 内部注入（运行时上下文 / 系统提醒）？
 *
 * 服务端 bridge 已经过滤，但网页版会把聊天记录缓存在 localStorage：
 * 之前渲染出来的旧气泡会在下次打开时恢复回来（真机反馈「仍有残余多余信息」）。
 * 渲染/恢复/插入三处统一用这个判定兜底。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInjectedHistoryText(value) {
  const text = String(value ?? '').trim()
  if (text === '') return false
  return (
    /^<system-reminder>/i.test(text)
    || /^Current runtime context[.:]/i.test(text)
    || /^Time sampled while preparing turn /i.test(text)
    || /^Browser time zone for this request:/i.test(text)
    || /^Elapsed since the preceding model-visible message:/i.test(text)
    || /^The available skill catalog changed/i.test(text)
  )
}

/**
 * 输入区右侧按钮的决策（用户需求）：
 *  - 正在生成且输入框为空 → 「停止」；
 *  - 其余情况（含生成中但已输入文字）→ 「发送」，生成中的消息由电脑端排队。
 * @param {{streaming?: boolean, hasText?: boolean, hasAttachments?: boolean, hasSession?: boolean, sending?: boolean}} input
 * @returns {{showStop: boolean, sendDisabled: boolean}}
 */
export function composerAction(input = {}) {
  const streaming = input.streaming === true
  const hasText = input.hasText === true
  const hasAttachments = input.hasAttachments === true
  const hasSession = input.hasSession !== false
  const sending = input.sending === true
  const empty = !hasText && !hasAttachments
  return {
    showStop: streaming && empty,
    sendDisabled: !hasSession || sending || empty,
  }
}

/**
 * 待回答提问的队列上限。一批提问可能有好几道题，正常情况下同时只有一两批；
 * 这里给一个硬上限，避免坏掉的对端把页面内存撑爆。
 */
export const QUESTION_QUEUE_LIMIT = 4

/**
 * 标签条最多同时打开多少个会话：当前会话 + `SESSION_WATCH_LIMIT` 个后台会话。
 * 多出来的后台会话电脑端根本不会推事件，标签上只能是一片死气，所以干脆不让开。
 */
export const TAB_LIMIT = SESSION_WATCH_LIMIT + 1

/** 没有活动会话时给调用方一个稳定的空容器，避免到处写 `?.`。 */
const EMPTY_MAP = new Map()
const EMPTY_ARRAY = Object.freeze([])

/**
 * `session/watch` 帧（整体替换订阅集）。调用方传 `tabs - active`，这里再兜一层：
 * 过滤非法值、去重、截断到 `SESSION_WATCH_LIMIT`（协议上限 8）。
 * @param {unknown[]} sessionIds
 * @returns {{t: string, sessionIds: string[]}}
 */
export function buildWatchFrame(sessionIds) {
  const list = []
  for (const raw of Array.isArray(sessionIds) ? sessionIds : []) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id === '' || id.length > 200 || list.includes(id)) continue
    list.push(id)
    if (list.length >= SESSION_WATCH_LIMIT) break
  }
  return { t: CLIENT_FRAME.SESSION_WATCH, sessionIds: list }
}

/**
 * `session/snapshot` 帧：只取某个标签的现状，不改变绑定。
 * @param {string} rid
 * @param {string} sessionId
 * @returns {{t: string, rid: string, sessionId: string}}
 */
export function buildSnapshotFrame(rid, sessionId) {
  return {
    t: CLIENT_FRAME.SESSION_SNAPSHOT,
    rid: String(rid ?? ''),
    sessionId: String(sessionId ?? ''),
  }
}

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
 * 归一化一条 `question/ask`（3.0.0 的结构化提问）。
 * @param {any} raw
 * @param {number} now
 * @returns {any | undefined}
 */
export function normalizeQuestion(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return undefined
  const questionId = typeof raw.questionId === 'string' ? raw.questionId.trim() : ''
  if (questionId === '') return undefined
  const items = []
  for (const candidate of Array.isArray(raw.items) ? raw.items : []) {
    if (items.length >= QUESTION_MAX_ITEMS) break
    if (!candidate || typeof candidate !== 'object') continue
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '' || typeof candidate.question !== 'string') continue
    const options = []
    for (const option of Array.isArray(candidate.options) ? candidate.options : []) {
      if (options.length >= QUESTION_MAX_OPTIONS) break
      if (!option || typeof option !== 'object' || typeof option.label !== 'string' || option.label.trim() === '') continue
      options.push({
        label: option.label.slice(0, 200),
        ...(typeof option.description === 'string' && option.description !== ''
          ? { description: option.description.slice(0, 500) }
          : {}),
      })
    }
    items.push({
      id: candidate.id.trim(),
      question: candidate.question.slice(0, QUESTION_MAX_TEXT),
      ...(typeof candidate.detail === 'string' && candidate.detail !== '' ? { detail: candidate.detail.slice(0, QUESTION_MAX_TEXT) } : {}),
      ...(typeof candidate.header === 'string' && candidate.header !== '' ? { header: candidate.header.slice(0, 200) } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(candidate.multiSelect === true ? { multiSelect: true } : {}),
      ...(candidate.intent && candidate.intent.kind === 'plan-review' && typeof candidate.intent.approve === 'string'
        ? { intent: { kind: 'plan-review', approve: candidate.intent.approve.slice(0, 200) } }
        : {}),
    })
  }
  if (items.length === 0) return undefined
  const expiresAt = Number(raw.expiresAt)
  return {
    questionId,
    items,
    ...(typeof raw.callId === 'string' && raw.callId !== '' ? { callId: raw.callId } : {}),
    ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
    canAnswerLate: raw.canAnswerLate === true,
    at: new Date(now).toISOString(),
    /** 本地是否已经提交过（避免连点）。 */
    replied: false,
  }
}

/**
 * 把页面上的草稿拼成 `question/reply`。规则与手机端/core 完全一致：
 * 每个问题恰好一条；单选填了「其他」时 selected 置空；未答的问题发空答案表示跳过。
 * @param {any} question
 * @param {Record<string, {selected?: string[], custom?: string}>} draft
 * @returns {{questionId: string, answers: Array<{id: string, selected: string[], custom?: string}>} | undefined}
 */
export function buildQuestionReply(question, draft = {}) {
  if (!question || typeof question.questionId !== 'string' || question.questionId === '') return undefined
  const answers = question.items.map(item => {
    const entry = draft[item.id] ?? {}
    const allowed = new Set((item.options ?? []).map(option => option.label))
    const selected = Array.isArray(entry.selected) ? entry.selected.filter(label => allowed.has(label)) : []
    const custom = typeof entry.custom === 'string' ? entry.custom.trim().slice(0, QUESTION_MAX_TEXT) : ''
    if (item.multiSelect !== true) {
      return { id: item.id, selected: custom !== '' ? [] : selected, ...(custom !== '' ? { custom } : {}) }
    }
    return { id: item.id, selected, ...(custom !== '' ? { custom } : {}) }
  })
  return { questionId: question.questionId, answers }
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
    /** @type {any[]} 待处理审批，队首是最早收到的。 */
    this.approvals = []
    /** @type {Map<string, any>} */
    this.approvalsById = new Map()
    /** @type {any[]} 待回答的结构化提问（3.0.0），队首是最早收到的。 */
    this.questions = []
    /** @type {Map<string, any>} */
    this.questionsById = new Map()
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
  /** 按时间稳定排序：快照/回放/乐观消息混在一起时，保证气泡顺序与电脑端一致。 */
  #sortByTime() {
    this.messages.sort((left, right) => {
      const a = Date.parse(left?.at ?? '') || 0
      const b = Date.parse(right?.at ?? '') || 0
      return a - b
    })
  }

  #insert(message) {
    if (!message?.id || this.byId.has(message.id)) return false
    // 内部注入（runtime context / system-reminder）永远不当聊天气泡展示。
    if (message.kind === 'user' && isInjectedHistoryText(message.text)) return false
    this.byId.set(message.id, message)
    this.messages.push(message)
    this.#sortByTime()
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
    this.clearQuestions()
    this.#touch()
  }

  /** 清空待处理审批（会话切换、解绑时调用）。 */
  clearApprovals() {
    this.approvals = []
    this.approvalsById.clear()
  }

  /** 清空待回答提问（会话切换、解绑时调用）。 */
  clearQuestions() {
    this.questions = []
    this.questionsById.clear()
  }

  /**
   * 本地已经提交了一批回答：标记为已回复，避免连点。
   * @param {string} questionId
   * @returns {boolean} false 表示这条提问已经不在队列里
   */
  markQuestionReplied(questionId) {
    const question = this.questionsById.get(String(questionId ?? ''))
    if (!question || question.replied === true) return false
    question.replied = true
    question.repliedAt = new Date().toISOString()
    this.#touch()
    return true
  }

  /** 是否有待回答的提问（决定是否跑倒计时定时器）。 */
  get hasPendingQuestions() {
    return this.questions.length > 0
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
      case SERVER_FRAME.APPROVAL_ASK:
        return this.#onApprovalAsk(frame, now)
      case SERVER_FRAME.APPROVAL_RESOLVED:
        return this.#onApprovalResolved(frame, now)
      case SERVER_FRAME.QUESTION_ASK:
        return this.#onQuestionAsk(frame, now)
      case SERVER_FRAME.QUESTION_RESOLVED:
        return this.#onQuestionResolved(frame, now)
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
      // 只清输入态；**审批不能清**：手机切走会话再切回来时，待答审批必须还在
      // （真机反馈「切会话权限审核消失」）。审批按会话路由，不会串到别的标签。
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
    const hasActiveCall = Boolean(activeCall && typeof activeCall.callId === 'string' && activeCall.callId !== '')
    if (!hasActiveCall) {
      // 快照是权威的：没有在跑的一轮，就不能剩着上一轮的「正在输入」。
      this.typing.clear()
    }
    if (hasActiveCall) {
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
    // 快照里的消息可能不是严格按时间排的（回放/乐观消息混入），统一按时间排，
    // 否则手机会出现「我的提问排在回复后面」（真机反馈：和电脑端顺序不一致）。
    this.#sortByTime()
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
      // 只清输入态与游标；审批保留，理由同上（切会话不应让待答审批消失）。
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

  /**
   * `question/ask`：进待回答队列。同一 questionId 的重发只更新内容（幂等），
   * 不同批次一律排队。
   * @param {any} frame
   * @param {number} now
   */
  #onQuestionAsk(frame, now) {
    const question = normalizeQuestion(frame, now)
    if (!question) return { handled: true, changed: false, frame }
    const existing = this.questionsById.get(question.questionId)
    if (existing) {
      Object.assign(existing, question, { replied: existing.replied === true, repliedAt: existing.repliedAt })
      this.#touch(now)
      return { handled: true, changed: true, frame, question: existing }
    }
    if (this.questions.length >= QUESTION_QUEUE_LIMIT) {
      const dropped = this.questions.shift()
      if (dropped) this.questionsById.delete(dropped.questionId)
    }
    this.questions.push(question)
    this.questionsById.set(question.questionId, question)
    this.#touch(now)
    return { handled: true, changed: true, frame, question }
  }

  /**
   * `question/resolved`：出队（无论结果如何都不该再显示可点的表单）。
   * @param {any} frame
   * @param {number} now
   */
  #onQuestionResolved(frame, now) {
    const questionId = String(frame.questionId ?? '')
    if (questionId === '') return { handled: true, changed: false, frame }
    const index = this.questions.findIndex(item => item.questionId === questionId)
    this.questionsById.delete(questionId)
    if (index >= 0) this.questions.splice(index, 1)
    const outcome = typeof frame.outcome === 'string' ? frame.outcome : ''
    const source = typeof frame.source === 'string' ? frame.source : ''
    if (index >= 0) this.#touch(now)
    return { handled: true, changed: index >= 0, frame, resolved: { questionId, outcome, source } }
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
      if (message.kind === 'user' && isInjectedHistoryText(message.text)) continue
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

/** 没有活动状态时的只读占位。 */
const EMPTY_ACTIVITY = Object.freeze({ typing: false, unread: 0, lastAt: 0 })

/**
 * 多会话标签 store：DSH 桌面侧边栏的网页版等价物。
 *
 * 状态形状（与协议契约 §3 一致）：
 *   tabs: string[]                         已打开的标签，按打开顺序
 *   activeSessionId: string                当前显示的标签
 *   chats: Map<sessionId, ChatModel>       每个标签自己的消息 / 游标 / 审批
 *   activity: Map<sessionId, {typing, unread, lastAt}>
 *
 * 帧路由：`frame.sessionId` 存在就进那个会话；没有（旧电脑端）就进当前会话。
 */
export class ChatTabsModel {
  /**
   * @param {{chatLimit?: number, tabLimit?: number, myDeviceId?: string}} [options]
   */
  constructor(options = {}) {
    this.chatLimit = Math.max(20, options.chatLimit ?? 400)
    this.tabLimit = Math.max(1, Math.min(TAB_LIMIT, options.tabLimit ?? TAB_LIMIT))
    this.myDeviceId = options.myDeviceId ?? ''
    /** @type {string[]} */
    this.tabs = []
    /** @type {string} */
    this.activeSessionId = ''
    /** @type {Map<string, ChatModel>} */
    this.chats = new Map()
    /** @type {Map<string, {typing: boolean, unread: number, lastAt: number}>} */
    this.activity = new Map()
    /**
     * 最近被用户关掉的标签。关掉后电脑端可能还有几帧在途（尤其被跑着的会话），
     * 这些帧不能把标签又弹回来；用户主动再打开时才移除。
     * @type {Set<string>}
     */
    this.closedSessions = new Set()
    /** @type {any[]} 电脑上的会话列表（`sessions` 帧，新的在前）。 */
    this.sessions = []
    /** `sessions.current`：电脑认为这台设备当前绑定的会话。 */
    this.sessionsCurrent = ''
    this.sessionsTruncated = false
    /** 是否收到过一次会话列表（没收到前不要按列表丢标签）。 */
    this.sessionsReceived = false
    /** @type {any | null} 最近一次 session/selected 的结果（UI 用来提示/关面板）。 */
    this.lastSessionSelection = null
    /** 最近一次按会话列表清掉的标签（恢复后会话已不存在的提示）。 */
    this.droppedSessions = []
    this.changedAt = 0
  }

  /** @param {string} deviceId */
  setDeviceId(deviceId) {
    this.myDeviceId = String(deviceId ?? '')
    for (const chat of this.chats.values()) chat.setDeviceId(this.myDeviceId)
  }

  /** @param {number} [now] */
  #touch(now = Date.now()) {
    this.changedAt = now
  }

  // -------------------------------------------------------------------------
  // 当前标签转发（渲染层只认识「当前会话」，不用到处查 tabs）
  // -------------------------------------------------------------------------

  /** @returns {ChatModel | undefined} */
  get active() {
    return this.activeSessionId ? this.chats.get(this.activeSessionId) : undefined
  }

  get messages() {
    return this.active?.messages ?? EMPTY_ARRAY
  }

  get byId() {
    return this.active?.byId ?? EMPTY_MAP
  }

  get files() {
    return this.active?.files ?? EMPTY_MAP
  }

  get approvals() {
    return this.active?.approvals ?? EMPTY_ARRAY
  }

  get approvalsById() {
    return this.active?.approvalsById ?? EMPTY_MAP
  }

  get typing() {
    return this.active?.typing ?? new Set()
  }

  get activeCallId() {
    return this.active?.activeCallId
  }

  get isTyping() {
    return this.active?.isTyping === true
  }

  get hasPendingApprovals() {
    return (this.active?.approvals.length ?? 0) > 0
  }

  /**
   * 所有标签里待答的审批（跨标签聚合）：切到别的标签后，提醒横幅要能继续提示。
   * @returns {Array<{sessionId: string, approval: any}>}
   */
  pendingApprovals() {
    const out = []
    for (const [sessionId, chat] of this.chats) {
      if (!chat) continue
      for (const approval of chat.approvals) out.push({ sessionId, approval })
    }
    return out
  }

  get questions() {
    return this.active?.questions ?? EMPTY_ARRAY
  }

  get questionsById() {
    return this.active?.questionsById ?? EMPTY_MAP
  }

  get hasPendingQuestions() {
    return (this.active?.questions.length ?? 0) > 0
  }

  get cursor() {
    return this.active?.cursor ?? 0
  }

  get sessionId() {
    return this.activeSessionId
  }

  get sessionEpoch() {
    return this.active?.sessionEpoch ?? 0
  }

  get sessionTitle() {
    return this.active?.sessionTitle ?? ''
  }

  get lastError() {
    return this.active?.lastError ?? null
  }

  // -------------------------------------------------------------------------
  // 标签 / 会话
  // -------------------------------------------------------------------------

  /** @param {string} sessionId */
  chatFor(sessionId) {
    return this.chats.get(String(sessionId ?? ''))
  }

  /** 确保某个会话有一个 ChatModel（不改变标签）。 */
  ensureChat(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return undefined
    let chat = this.chats.get(id)
    if (!chat) {
      chat = new ChatModel({ limit: this.chatLimit, myDeviceId: this.myDeviceId })
      chat.sessionId = id
      this.chats.set(id, chat)
    }
    this.#activityFor(id)
    return chat
  }

  /** @param {string} sessionId */
  #activityFor(sessionId) {
    let activity = this.activity.get(sessionId)
    if (!activity) {
      activity = { typing: false, unread: 0, lastAt: 0 }
      this.activity.set(sessionId, activity)
    }
    return activity
  }

  /** @param {string} sessionId */
  activityFor(sessionId) {
    return this.activity.get(String(sessionId ?? '')) ?? EMPTY_ACTIVITY
  }

  /** @param {string} sessionId */
  titleFor(sessionId) {
    const id = String(sessionId ?? '')
    const summary = this.sessions.find(item => item.id === id)
    return summary?.title || this.chats.get(id)?.sessionTitle || '会话'
  }

  /**
   * 标签条显示用的标题：同名标签在后面追加 `#序号`。
   *
   * 新建的会话在电脑端取到标题之前都叫「会话」，直接渲染会出现一排一模一样的
   * 标签，用户无法分辨（真机反馈）。这里只影响**显示**，不影响标题本身。
   * @returns {Map<string, string>}
   */
  tabDisplayTitles() {
    const ids = Array.isArray(this.tabs) ? this.tabs : []
    const base = ids.map(id => [id, this.titleFor(id)])
    const counts = new Map()
    for (const [, title] of base) counts.set(title, (counts.get(title) ?? 0) + 1)
    const seen = new Map()
    const out = new Map()
    for (const [id, title] of base) {
      if ((counts.get(title) ?? 0) <= 1) {
        out.set(id, title)
        continue
      }
      const index = (seen.get(title) ?? 0) + 1
      seen.set(title, index)
      out.set(id, `${title} #${index}`)
    }
    return out
  }

  /** 是否有 agent 正在这个会话里跑（电脑端 live 或本地看到 typing）。 */
  liveFor(sessionId) {
    const id = String(sessionId ?? '')
    if (this.#activityFor(id).typing) return true
    return this.sessions.find(item => item.id === id)?.live === true
  }

  /** @param {string} sessionId */
  unreadFor(sessionId) {
    return this.#activityFor(String(sessionId ?? '')).unread
  }

  /** @param {string} sessionId */
  typingFor(sessionId) {
    return this.#activityFor(String(sessionId ?? '')).typing
  }

  /** 该标签里是否有待处理的审批（标签角标）。 */
  hasApprovalIn(sessionId) {
    return (this.chats.get(String(sessionId ?? ''))?.approvals.length ?? 0) > 0
  }

  /**
   * 打开一个标签。
   * @param {string} sessionId
   * @param {{activate?: boolean}} [options]
   * @returns {{ok: boolean, opened: boolean, activated: boolean, reason?: string}}
   */
  openTab(sessionId, options = {}) {
    const id = String(sessionId ?? '')
    if (id === '') return { ok: false, opened: false, activated: false, reason: 'invalid' }
    const existed = this.tabs.includes(id)
    if (!existed && this.tabs.length >= this.tabLimit) {
      return { ok: false, opened: false, activated: false, reason: 'limit' }
    }
    this.closedSessions.delete(id)
    this.ensureChat(id)
    if (!existed) this.tabs.push(id)
    const activate = options.activate !== false
    let activated = false
    if (activate && this.activeSessionId !== id) {
      this.activeSessionId = id
      this.#activityFor(id).unread = 0
      activated = true
    }
    if (!existed || activated) this.#touch()
    return { ok: true, opened: !existed, activated }
  }

  /**
   * 切换当前标签（本地立即生效；网络上的 select/snapshot 由 app 负责）。
   * @param {string} sessionId
   */
  activateTab(sessionId) {
    const id = String(sessionId ?? '')
    if (!this.tabs.includes(id)) return { ok: false, changed: false }
    const activity = this.#activityFor(id)
    const hadUnread = activity.unread > 0
    activity.unread = 0
    if (this.activeSessionId === id) {
      if (hadUnread) this.#touch()
      return { ok: true, changed: hadUnread, activated: false }
    }
    const previousSessionId = this.activeSessionId
    this.activeSessionId = id
    this.#touch()
    return { ok: true, changed: true, activated: true, previousSessionId }
  }

  /**
   * 关闭本地标签。关掉当前标签时切到相邻标签（并告诉调用方需要 select 它）。
   * 不会通知电脑端，也不会停止那个会话里的 agent。
   * @param {string} sessionId
   */
  closeTab(sessionId) {
    const id = String(sessionId ?? '')
    const index = this.tabs.indexOf(id)
    if (index < 0) return { ok: false, changed: false }
    this.tabs.splice(index, 1)
    this.#forgetChat(id)
    // 记住「刚关掉」：在途帧不能把标签弹回来（用户主动 openTab 时才解除）。
    this.closedSessions.add(id)
    while (this.closedSessions.size > 16) {
      const oldest = this.closedSessions.values().next().value
      if (oldest === undefined) break
      this.closedSessions.delete(oldest)
    }
    let nextActive = this.activeSessionId
    let activated = false
    if (this.activeSessionId === id) {
      nextActive = this.tabs[Math.min(index, this.tabs.length - 1)] ?? ''
      this.activeSessionId = nextActive
      if (nextActive) {
        this.#activityFor(nextActive).unread = 0
        activated = true
      }
    }
    this.#touch()
    return { ok: true, changed: true, closed: id, activeSessionId: nextActive, activated }
  }

  /** @param {string} sessionId */
  #forgetChat(sessionId) {
    this.chats.delete(sessionId)
    this.activity.delete(sessionId)
  }

  /**
   * 用会话列表清理已不存在的标签（只在列表未被截断时可信）。
   * @param {Iterable<string>} knownIds
   * @param {number} [now]
   * @returns {string[]} 被丢掉的会话 id
   */
  dropMissingSessions(knownIds, now = Date.now()) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? [])
    const missing = this.tabs.filter(id => !known.has(id))
    if (missing.length === 0) {
      this.droppedSessions = []
      return []
    }
    for (const id of missing) {
      const index = this.tabs.indexOf(id)
      if (index >= 0) this.tabs.splice(index, 1)
      this.#forgetChat(id)
      this.closedSessions.add(id)
    }
    if (!this.tabs.includes(this.activeSessionId)) {
      this.activeSessionId = this.tabs[0] ?? ''
      if (this.activeSessionId) this.#activityFor(this.activeSessionId).unread = 0
    }
    this.droppedSessions = missing
    this.#touch(now)
    return missing
  }

  /** 需要发给电脑端的后台订阅（不含当前标签，最多 SESSION_WATCH_LIMIT 个）。 */
  watchList() {
    return this.tabs.filter(id => id !== this.activeSessionId).slice(0, SESSION_WATCH_LIMIT)
  }

  // -------------------------------------------------------------------------
  // 帧处理
  // -------------------------------------------------------------------------

  /**
   * 处理一条电脑端帧：按 `sessionId` 路由到对应会话。
   * @param {any} frame
   * @param {{now?: number}} [options]
   * @returns {{handled: boolean, changed: boolean, targetSessionId?: string,
   *            sessionChanged?: boolean, activityChanged?: boolean, needsWatch?: boolean,
   *            opened?: boolean, selection?: any, resolved?: any, unread?: number}}
   */
  applyFrame(frame, options = {}) {
    if (!frame || typeof frame.t !== 'string') return { handled: false, changed: false }
    const now = options.now ?? Date.now()

    if (frame.t === SERVER_FRAME.SESSIONS) {
      const result = this.applySessions(frame, now)
      return { ...result, needsWatch: result.changed }
    }
    if (frame.t === SERVER_FRAME.SESSION_SELECTED) {
      return this.#onSelected(frame, now)
    }

    const explicit = typeof frame.sessionId === 'string' && frame.sessionId !== ''
    const target = explicit ? frame.sessionId : this.activeSessionId
    if (target === '') {
      // 还没有任何会话（第一条 session/state 之前的杂帧）：交给调用方当全局处理。
      return { handled: false, changed: false, frame }
    }

    // 标签里没有这个会话：自动开一个（不抢焦点）。可能是电脑端刚把绑定切过来，
    // 也可能是后台订阅里的会话——消息不能丢，也不能把当前标签顶掉。刚被用户
    // 关掉的标签例外：在途帧只更新它的缓存，不再弹回来。
    let opened = false
    if (!this.tabs.includes(target) && !this.closedSessions.has(target)) {
      const result = this.openTab(target, { activate: this.activeSessionId === '' })
      opened = result.opened === true
      if (!result.ok) {
        // 标签数到上限：仍然保留 ChatModel，事件不丢，只是没有可见标签。
        this.ensureChat(target)
      }
    }

    const chat = this.ensureChat(target)
    if (!chat) return { handled: false, changed: false, frame }
    if (chat.sessionId !== target) chat.sessionId = target
    const result = chat.applyFrame(frame, { now })

    // 活动状态：未读只在后台标签累积；typing 由 chat/typing 与 done/error 驱动。
    const activity = this.#activityFor(target)
    const beforeTyping = activity.typing
    const beforeUnread = activity.unread
    activity.lastAt = now
    switch (frame.t) {
      case SERVER_FRAME.CHAT_ECHO:
      case SERVER_FRAME.CHAT_MESSAGE:
        if (target !== this.activeSessionId) activity.unread += 1
        break
      case SERVER_FRAME.TYPING:
        activity.typing = frame.active !== false
        break
      case SERVER_FRAME.SESSION_STATE:
        // 快照是权威的：没有 activeCall 就说明这一轮已经结束，运行点不能残留。
        activity.typing = chat.isTyping === true
        break
      case SERVER_FRAME.CHAT_DONE:
      case SERVER_FRAME.CHAT_ERROR:
        activity.typing = false
        break
      default:
        break
    }
    // 当前会话的快照 = 电脑端此刻的绑定；后台快照（active:false）不改变绑定。
    if (frame.t === SERVER_FRAME.SESSION_STATE && frame.active !== false) {
      this.sessionsCurrent = target
    }
    const activityChanged = activity.typing !== beforeTyping || activity.unread !== beforeUnread
    if (activityChanged) this.#touch(now)
    return {
      handled: result.handled !== false,
      changed: result.changed === true || activityChanged || opened,
      targetSessionId: target,
      sessionChanged: result.sessionChanged === true,
      activityChanged,
      needsWatch: opened,
      opened,
      unread: activity.unread,
      resolved: result.resolved ? { ...result.resolved, sessionId: target } : undefined,
    }
  }

  /**
   * `sessions`：会话列表（标签标题 / live / 打开新标签的来源）。
   * 未被截断时顺手清掉恢复出来但电脑上已不存在的标签。
   * @param {any} frame
   * @param {number} [now]
   */
  applySessions(frame, now = Date.now()) {
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
    this.sessionsReceived = true
    for (const summary of next) summary.current = summary.id === current
    // 列表里的标题比会话快照更及时（重命名后刷新列表就能看到）。
    for (const id of this.tabs) {
      const summary = next.find(item => item.id === id)
      const chat = this.chats.get(id)
      if (summary && chat && summary.title) chat.sessionTitle = summary.title
    }
    const dropped = this.sessionsTruncated ? [] : this.dropMissingSessions(new Set(next.map(item => item.id)), now)
    this.#touch(now)
    return { handled: true, changed: true, dropped }
  }

  /**
   * `session/selected`：`session/select` / `session/create` 的结果。成功时把该会话
   * 补进标签（不抢焦点），随后到达的 `session/state` 填内容。
   * @param {any} frame
   * @param {number} now
   */
  #onSelected(frame, now) {
    const ok = frame.ok === true
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
    const title = typeof frame.title === 'string' ? frame.title : ''
    this.lastSessionSelection = {
      ok,
      sessionId: sessionId || undefined,
      title: title || undefined,
      error: typeof frame.error === 'string' ? frame.error : undefined,
      message: typeof frame.message === 'string' ? frame.message : undefined,
      at: new Date(now).toISOString(),
    }
    let opened = false
    if (ok) {
      if (sessionId !== '') {
        this.sessionsCurrent = sessionId
        for (const summary of this.sessions) summary.current = summary.id === sessionId
        const result = this.openTab(sessionId, { activate: false })
        opened = result.opened === true
        const chat = this.chats.get(sessionId)
        if (chat && title !== '') chat.sessionTitle = title
        const summary = this.sessions.find(item => item.id === sessionId)
        if (summary && title !== '') summary.title = title
      }
    }
    this.#touch(now)
    return { handled: true, changed: true, opened, needsWatch: opened, selection: this.lastSessionSelection }
  }

  // -------------------------------------------------------------------------
  // 本地操作（发送 / 重发 / 审批）
  // -------------------------------------------------------------------------

  /**
   * 把本地用户消息插进某一个会话（默认当前标签）。
   * @param {any} input
   * @param {string} [sessionId]
   */
  addLocalUserMessage(input, sessionId) {
    const target = String(sessionId || this.activeSessionId || '')
    if (target === '') return undefined
    const chat = this.ensureChat(target)
    if (!chat) return undefined
    const message = chat.addLocalUserMessage(input)
    this.#activityFor(target).lastAt = Date.now()
    this.#touch()
    return { sessionId: target, message }
  }

  /**
   * 在任意标签里找一条本地用户消息（重发时用）。
   * @param {string} msgId
   * @returns {{sessionId: string, message: any, chat: ChatModel} | undefined}
   */
  findUserMessage(msgId) {
    for (const [sessionId, chat] of this.chats) {
      const message = chat.byId.get(userMessageId(msgId))
      if (message) return { sessionId, message, chat }
    }
    return undefined
  }

  /** 重发前把消息标回待发送；找不到就返回 false。 */
  resetUserMessageForRetry(msgId) {
    const found = this.findUserMessage(msgId)
    if (!found) return false
    return found.chat.resetUserMessageForRetry(msgId)
  }

  /**
   * `chat/ack` 可能在我们切到别的标签后才到（ack 帧不带 sessionId）：
   * 按 msgId 找到真正持有这条消息的会话再标记，避免它永远停在「发送中」。
   */
  markUserMessageSent(msgId, info = {}) {
    const found = this.findUserMessage(msgId)
    return found ? found.chat.markUserMessageSent(msgId, info) : false
  }

  /** @param {string} msgId @param {string} reason */
  markUserMessageFailed(msgId, reason) {
    const found = this.findUserMessage(msgId)
    return found ? found.chat.markUserMessageFailed(msgId, reason) : false
  }

  /** 是否已经收到了某条消息的 ack（重连后重复回放时用来跳过）。 */
  hasMessage(msgId) {
    return Boolean(this.findUserMessage(msgId))
  }

  /**
   * 在任意标签里找一条审批（approval/reply 只带 approvalId）。
   * @param {string} approvalId
   */
  findApproval(approvalId) {
    const id = String(approvalId ?? '')
    if (id === '') return undefined
    for (const [sessionId, chat] of this.chats) {
      const approval = chat.approvalsById.get(id)
      if (approval) return { sessionId, approval, chat }
    }
    return undefined
  }

  /** @param {string} approvalId @param {'allowed-once'|'rejected'} outcome */
  markApprovalReplied(approvalId, outcome) {
    const found = this.findApproval(approvalId)
    if (!found) return false
    return found.chat.markApprovalReplied(approvalId, outcome)
  }

  /**
   * 在任意标签里找一批提问（question/reply 只带 questionId）。
   * @param {string} questionId
   */
  findQuestion(questionId) {
    const id = String(questionId ?? '')
    if (id === '') return undefined
    for (const [sessionId, chat] of this.chats) {
      const question = chat.questionsById.get(id)
      if (question) return { sessionId, question, chat }
    }
    return undefined
  }

  /** 标记一批提问已经提交（避免连点）。 */
  markQuestionReplied(questionId) {
    const found = this.findQuestion(questionId)
    if (!found) return false
    return found.chat.markQuestionReplied(questionId)
  }

  /** 清空当前标签的消息（「清空本机聊天记录」）。 */
  clearActiveConversation() {
    const chat = this.active
    if (!chat) return false
    chat.clearConversation()
    const activity = this.#activityFor(this.activeSessionId)
    activity.unread = 0
    activity.typing = false
    this.#touch()
    return true
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  /** 标签列表要保存的最小状态（每个助理一份）。 */
  snapshotTabs() {
    return { version: 1, tabs: this.tabs.slice(), activeSessionId: this.activeSessionId }
  }

  /** 当前标签的消息快照（沿用 v2.3.0 的会话缓存，刷新后先出内容再对账）。 */
  snapshotActiveChat(options = {}) {
    return this.active?.snapshotForStorage(options)
  }

  /**
   * 恢复标签列表（按打开顺序），并建立空的 ChatModel。
   * @param {any} saved
   */
  restoreTabs(saved) {
    const input = saved && typeof saved === 'object' ? saved : {}
    /** @type {string[]} */
    const ids = []
    if (Array.isArray(input.tabs)) {
      for (const raw of input.tabs) {
        const id = typeof raw === 'string' ? raw.trim() : ''
        if (id === '' || ids.includes(id)) continue
        if (ids.length >= this.tabLimit) break
        ids.push(id)
      }
    }
    this.tabs = ids
    this.closedSessions.clear()
    for (const id of ids) this.ensureChat(id)
    const wanted = typeof input.activeSessionId === 'string' ? input.activeSessionId : ''
    this.activeSessionId = ids.includes(wanted) ? wanted : ids[0] ?? ''
    if (this.activeSessionId) this.#activityFor(this.activeSessionId).unread = 0
    this.#touch()
    return { restored: ids.length, activeSessionId: this.activeSessionId }
  }

  /**
   * 把缓存的当前会话内容塞回对应标签（sessionId 不匹配就丢弃，避免把 A 的消息
   * 显示在 B 的标签里）。
   * @param {any} saved
   */
  restoreActiveChat(saved) {
    const chat = this.active
    if (!chat || !saved || typeof saved !== 'object') return false
    const savedSessionId = typeof saved.sessionId === 'string' ? saved.sessionId : ''
    if (savedSessionId !== '' && savedSessionId !== this.activeSessionId) return false
    const restored = chat.restoreFromStorage(saved)
    if (restored && chat.sessionId !== this.activeSessionId) chat.sessionId = this.activeSessionId
    return restored
  }
}

/** 客户端会发的帧（导出便于测试与 UI 逻辑判断）。 */
export const CLIENT_FRAMES = CLIENT_FRAME


