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
 * 同步期间必须排进 buffer、等快照落地后再按序应用的帧。
 *
 * 这份名单就是「会改消息列表」的那部分协议：会话快照是这些帧的全序基准，
 * 先应用帧再被快照整表覆盖，正是「回复被吞、我的消息先出现又消失」的根因。
 * 其余帧（ack / session/* / 审批 / 提问）与列表顺序无关，直接应用更稳。
 */
const SYNC_BUFFERED_FRAMES = new Set([
  SERVER_FRAME.CHAT_ECHO,
  SERVER_FRAME.CHAT_MESSAGE,
  SERVER_FRAME.CHAT_DELTA,
  SERVER_FRAME.CHAT_DONE,
  SERVER_FRAME.CHAT_ERROR,
  SERVER_FRAME.TOOL,
  SERVER_FRAME.TYPING,
  SERVER_FRAME.FILE_OFFERED,
])

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
 * 保留多少张「已作答」的提问摘要卡。
 *
 * 答完的卡片不能凭空消失（真机反馈「答完之后聊天流里没有任何记录」），但也不能
 * 无限堆在聊天流里，所以只留最近若干张。
 */
export const QUESTION_LOG_LIMIT = 20

/** 题干彻底取不到时的兜底文案：宁可显示一句实话，也不要渲染一行空白。 */
export const QUESTION_FALLBACK_TEXT = '电脑端没有给出题干内容'

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
 * 去掉电脑端给「手机附件消息」注入的提示段，只留下用户真正输入的文字。
 *
 * 服务端历史快照已经会剥掉；这里再兜一层（老服务端 / 旧缓存里仍可能带原文），
 * 避免手机聊天流里出现一长串「用户通过手机发来了 N 个附件…」的路径文本。
 * @param {unknown} text
 * @returns {string}
 */
export function stripInjectedAttachmentNotice(text) {
  const raw = String(text ?? '')
  const marker = '用户通过手机发来了 '
  const index = raw.indexOf(marker)
  if (index === -1) return raw
  const kept = raw.slice(0, index).trim()
  return kept !== '' ? kept : '（来自手机的附件）'
}

/**
 * 把帧里的 seq 变成一个可信的数字（`undefined` = 这条消息没有权威次序）。
 * 注意不能直接 `Number(x)`：`Number(null)` 和 `Number('')` 都是 0，会被当成
 * 「seq 0」，把消息顶到会话最前面。
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteSeq(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 历史消息 id（网关历史快照里的 `hist_<seq>`）携带的会话序号。
 * @param {unknown} id
 * @returns {number | undefined}
 */
export function historyMessageSeq(id) {
  const match = /^hist_([0-9]+)$/.exec(String(id ?? ''))
  return match ? Number(match[1]) : undefined
}

/**
 * 快照消息的落位 seq：显式 `seq` 优先，其次从 `hist_<seq>` 形式的 id 解析。
 * @param {any} raw
 * @returns {number | undefined}
 */
function snapSeqOf(raw) {
  return finiteSeq(raw?.seq) ?? historyMessageSeq(raw?.id)
}

/**
 * 一条消息的排序键（纯函数版，导出给测试与调试用）。
 * 与 `ChatModel.#orderKey` 完全同构：`[层级, 次序, 时间]`。
 *
 * 四层，每层的「次序」都是**同一套空间内的比较**，绝不跨空间比大小：
 *  0. 有 seq 且整表都有 seq：按事件日志 seq（权威，与电脑端一致）；
 *  1. 没有 seq 的历史/旧缓存消息：按墙钟 at；
 *  2. `tail`（快照之后才到达的实时消息）：按**到达序号** arrival，不看 at——
 *     助手帧不带上行时间，用 at 会把回答排到提问前面；
 *  3. 本地乐观消息：永远最后，等 echo 落位。
 *
 * `bySeq` 为 false 时整表退回墙钟：见 `ChatModel.#sortMessages` 的说明——只要有
 * 任何一条已确认消息没有 seq，就不能把「有 seq 的」和「没 seq 的」混在两个层级里，
 * 否则后拿到 seq 的那条会整条跳到最前面（历史快照 + 正在生成的气泡就会这样）。
 * @param {any} message
 * @param {boolean} [bySeq]
 * @returns {[number, number, number]}
 */
export function messageOrderKey(message, bySeq = true) {
  const at = Date.parse(String(message?.at ?? '')) || 0
  // 本地乐观消息永远在最后：它们的 seq 还不存在，位置只能等网关确认。
  if (message?.optimistic === true) return [3, at, 0]
  // 比快照水位更新、但还没进历史的实时消息：快照之后的所有内容，排在已确认消息之后。
  // 不能用 seq 直接比：历史 id 是 `hist_<DSH 事件 seq>`，实时帧是插件事件日志序号，
  // 两套序号没有大小关系，混着比会把刚到的消息排到最前面。
  if (message?.tail === true) {
    const arrival = Number(message?.arrival)
    // 没有 arrival（旧缓存 / 从存档恢复时漏标）：退到 at，宁可排在这一段末尾也不跳到最前。
    return [2, Number.isFinite(arrival) ? arrival : at, at]
  }
  const seq = finiteSeq(message?.seq)
  if (bySeq && seq !== undefined) return [0, seq, at]
  return [1, at, 0]
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
    ...(raw.onDesktop === true ? { onDesktop: true } : {}),
    at: new Date(now).toISOString(),
    /** 本地是否已经点过按钮（避免连点；电脑端 pending 期间不重发）。 */
    replied: false,
    repliedOutcome: undefined,
  }
}

/**
 * 从本地化字典（`{en, zh, 'zh-CN', ...}`）或普通字符串里取一段可显示文本。
 *
 * DSH 的 `intent.display` 是这种形状：中文优先、英文兜底——网页版界面是中文，
 * 回退到 en 也好过在手机上留一行空白。
 * @param {unknown} value
 * @returns {string}
 */
export function localizedText(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  for (const key of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hant', 'zh-TW', 'en']) {
    const text = value[key]
    if (typeof text === 'string' && text.trim() !== '') return text.trim()
  }
  for (const text of Object.values(value)) {
    if (typeof text === 'string' && text.trim() !== '') return text.trim()
  }
  return ''
}

/** @param {...unknown} values @returns {string} 第一段非空的可显示文本 */
function firstVisibleText(...values) {
  for (const value of values) {
    const text = localizedText(value)
    if (text !== '') return text
  }
  return ''
}

/**
 * DSH 新版把「人话」放在 `intent.display`（本地化的 question/detail/approve）。
 * @param {unknown} intent
 * @returns {{question: string, detail: string, approve: string}}
 */
export function questionDisplayOf(intent) {
  const display = intent && typeof intent === 'object' ? intent.display : undefined
  if (!display || typeof display !== 'object' || Array.isArray(display)) {
    return { question: '', detail: '', approve: '' }
  }
  return {
    question: localizedText(display.question),
    detail: localizedText(display.detail),
    approve: localizedText(display.approve),
  }
}

/**
 * 归一化一条 `question/ask`（3.0.0 的结构化提问）。
 *
 * 题干有两条来源：老的 `item.question`，以及 DSH 新版 `intent.display.question`
 * （本地化字典）。计划审阅 / 新版提问里 `question` 可能是空串甚至缺省——只认
 * `question` 会让手机卡片只剩「需要你的回答」和选项、题目那一行是空的
 * （真机反馈「提问语句手机上不显示，但能在手机上回答」）。所以逐级回退：
 * `question` → `intent.display.question` → `header` → `detail` →
 * `intent.display.detail` → 兜底文案；`detail` / `approve` 同样支持 display 回退。
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
    // 注意：**不再**要求 `question` 是字符串。新版 shape 可能没有它（文字在
    // intent.display 里），直接 continue 会让整批提问变成空数组、卡片根本不出现。
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    if (id === '') continue
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
    const display = questionDisplayOf(candidate.intent)
    const header = firstVisibleText(candidate.header)
    const detail = firstVisibleText(candidate.detail, display.detail)
    const prompt = firstVisibleText(candidate.question, display.question, header, detail) || QUESTION_FALLBACK_TEXT
    const approve = firstVisibleText(candidate.intent?.approve, display.approve)
    const planReview = candidate.intent?.kind === 'plan-review'
    items.push({
      id,
      question: prompt.slice(0, QUESTION_MAX_TEXT),
      // 回退后 detail/header 常和题干撞车（display.question === header），不再渲染第二遍。
      ...(detail !== '' && detail !== prompt ? { detail: detail.slice(0, QUESTION_MAX_TEXT) } : {}),
      ...(header !== '' && header !== prompt ? { header: header.slice(0, 200) } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(candidate.multiSelect === true ? { multiSelect: true } : {}),
      ...(planReview
        ? { intent: { kind: 'plan-review', ...(approve !== '' ? { approve: approve.slice(0, 200) } : {}) } }
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
 * 归一化一条「已作答提问」摘要（模型内部生成 / localStorage 恢复）。
 * @param {any} raw
 * @returns {any | undefined}
 */
export function normalizeQuestionLogEntry(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const questionId = typeof raw.questionId === 'string' ? raw.questionId.trim() : ''
  if (questionId === '') return undefined
  const items = []
  for (const candidate of Array.isArray(raw.items) ? raw.items : []) {
    if (items.length >= QUESTION_MAX_ITEMS) break
    if (!candidate || typeof candidate !== 'object') continue
    if (typeof candidate.id !== 'string' || candidate.id === '') continue
    const selected = []
    for (const label of Array.isArray(candidate.selected) ? candidate.selected : []) {
      if (typeof label !== 'string' || label === '') continue
      if (selected.length >= QUESTION_MAX_OPTIONS) break
      selected.push(label.slice(0, 200))
    }
    items.push({
      id: candidate.id.slice(0, 200),
      question: String(candidate.question ?? '').slice(0, QUESTION_MAX_TEXT),
      ...(typeof candidate.header === 'string' && candidate.header !== '' ? { header: candidate.header.slice(0, 200) } : {}),
      selected,
      ...(typeof candidate.custom === 'string' && candidate.custom !== ''
        ? { custom: candidate.custom.slice(0, QUESTION_MAX_TEXT) }
        : {}),
    })
  }
  if (items.length === 0) return undefined
  return {
    questionId,
    items,
    outcome: typeof raw.outcome === 'string' ? raw.outcome : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    answered: raw.answered === true,
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
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
    /**
     * 已经收尾的提问（只读摘要：题目 + 所选答案 + 结果）。
     * 答完的卡片不能凭空消失——真机反馈「答完之后聊天流里没有任何记录」。
     * @type {any[]}
     */
    this.questionLog = []
    /** @type {{message: string, code?: string, at: string} | null} */
    this.lastError = null
    this.myDeviceId = options.myDeviceId ?? ''
    this.changedAt = 0
    /**
     * 同步状态机：`ready`（可直接接收实时帧）或 `syncing`（在等快照，实时帧先进
     * buffer）。只有这两条路径能改消息列表，且快照永远在 buffer 之前应用——
     * 晚到的旧快照因此**物理上**不可能覆盖已经到达的新帧。
     * @type {'ready' | 'syncing'}
     */
    this.syncState = 'ready'
    /** 每次开始同步自增；旧 generation 的快照一律丢弃。 */
    this.syncGeneration = 0
    /** 同步期间到达的实时帧，按到达顺序保存。 */
    this.syncBuffer = []
    /** 本次同步的原因（诊断用）。 */
    this.syncReason = ''
    /** 显式快照请求的 rid → generation（服务端会原样回传 rid）。 */
    this.syncRids = new Map()
    /** 同步过程计数（诊断用，不影响逻辑）。 */
    this.syncStats = { snapshots: 0, staleSnapshots: 0, replayed: 0, droppedStale: 0, degraded: 0 }
    /**
     * 列表里有没有「快照底座」。有的话，之后实时插入的消息就是快照的**后缀**，
     * 排序时钉在后面；没有的话（新会话、纯实时）整表按 seq 排。
     * @type {boolean}
     */
    this.hasSnapshotBase = false
    /**
     * 到达序号（单调递增）：给「快照之后才到」的消息一个与墙钟无关的全序。
     *
     * 不能用 `at` 排这一段：助手帧（`chat/message` / `chat/delta`）根本不带 `at`，
     * 本地填的是**接收时刻**；而用户消息的 `at` 是发送时刻。异步到达时两者会交叉，
     * 于是「回答」被排到「提问」前面。到达顺序（插入/重放顺序）才是这一段唯一
     * 可靠的次序，正好对应同步层「按到达顺序重放 buffer」的语义。
     * @type {number}
     */
    this.arrivalCounter = 0
  }

  /**
   * 分配下一个到达序号。
   * @returns {number}
   */
  #nextArrival() {
    this.arrivalCounter += 1
    return this.arrivalCounter
  }

  /**
   * 给一条消息补上到达序号（已有则保留：同一条消息被重复处理时不能改次序）。
   * @param {any} message
   * @returns {number}
   */
  #noteArrival(message) {
    if (message && !Number.isFinite(Number(message.arrival))) message.arrival = this.#nextArrival()
    return Number(message?.arrival) || 0
  }

  /**
   * 开始一次同步：此后到达的实时帧先入 buffer，等 `endSync` 再按序应用。
   * @param {{reason?: string, rid?: string}} [options]
   * @returns {number} generation（调用方在快照到达时用它判断是否已被更新的同步取代）
   */
  beginSync(options = {}) {
    this.syncGeneration += 1
    this.syncState = 'syncing'
    this.syncReason = String(options.reason ?? 'manual')
    this.syncBuffer = []
    const rid = String(options.rid ?? '')
    if (rid !== '') {
      this.syncRids.set(rid, this.syncGeneration)
      // 只需要记住最近几次：慢请求被取代后，rid 不该无限堆积。
      while (this.syncRids.size > 8) {
        const oldest = this.syncRids.keys().next().value
        if (oldest === undefined) break
        this.syncRids.delete(oldest)
      }
    }
    return this.syncGeneration
  }

  /** 是否正在等快照（渲染层据此决定要不要显示「正在同步」）。 */
  get isSyncing() {
    return this.syncState === 'syncing'
  }

  /**
   * 结束一次同步（快照已应用 / 回放已到 / 超时兜底）：按到达顺序重放 buffer。
   * 带着 seq 且 seq 已经落在 cursor 之内的帧说明快照里已经包含它，直接丢掉。
   * @param {number} [generation] 传入时只有当前 generation 才生效
   * @returns {boolean} 是否真的结束了
   */
  endSync(generation) {
    if (generation !== undefined && generation !== this.syncGeneration) return false
    if (this.syncState !== 'syncing') return false
    this.syncState = 'ready'
    const buffer = this.syncBuffer
    this.syncBuffer = []
    let changed = false
    let replayed = 0
    for (const entry of buffer) {
      const seq = Number(entry?.frame?.seq)
      if (Number.isFinite(seq) && seq > 0 && seq <= this.cursor) {
        this.syncStats.droppedStale += 1
        continue
      }
      const result = this.#dispatch(entry.frame, entry.now ?? Date.now())
      changed = changed || result.changed === true
      replayed += 1
    }
    this.syncStats.replayed += replayed
    if (replayed > 0 && changed) this.#touch()
    return true
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
  /**
   * 一条消息的权威次序键：`[层级, 次序, 时间]`。
   *
   * 为什么不能只按墙钟 `at` 排：网关给 `chat/echo` 的 `at` 是**它收到消息的时刻**。
   * 手机离线时消息进 outbox，重连补发才被记录，于是「先发的那条」拿到的 at 比它
   * 自己的回复还晚——按 at 排就把用户气泡排到所有回复之后（真机反馈「手机顺序与
   * 电脑端不一致，电脑端才是对的」）。每一条被网关记录的事件都带会话内单调的
   * `seq`（快照里的历史消息 id 是 `hist_<seq>`），它才是权威次序。
   *
   * 三层：
   *  0. 有 seq（已被电脑端落库）：按 seq；
   *  1. 没有 seq 的历史/快照消息（老电脑端、旧缓存），或整表退回墙钟时：按 at；
   *  2. 本地乐观消息（还没被网关确认，`optimistic`）：一律排在所有已确认消息
   *     之后，echo / 回放带着 seq 回来后再落位。
   * @param {any} message
   * @param {boolean} bySeq
   * @returns {[number, number, number]}
   */
  #orderKey(message, bySeq) {
    return messageOrderKey(message, bySeq)
  }

  /**
   * 「整张列表的已确认消息是不是都有 seq」。
   *
   * 为什么需要这个开关：有两种来源的消息必然没有 seq——旧 localStorage 缓存、
   * 以及老电脑端 / `chat/error` 这类不进事件日志的帧。如果让「有 seq 的」和
   * 「没 seq 的」各占一层，那么一条消息后拿到 seq 时（例如正在生成的气泡收到
   * `chat/message`）会整条跳到最前面，把历史顺序打乱。所以：
   *   全都有 seq → 按 seq 排（权威、与电脑端一致）；
   *   有一条没有  → 整表退回按 at 排（保持老行为，绝不制造新的跳位）。
   * @returns {boolean}
   */
  #allConfirmedHaveSeq() {
    for (const message of this.messages) {
      if (message?.optimistic === true) continue
      if (finiteSeq(message?.seq) === undefined) return false
    }
    return true
  }

  /**
   * 按 (层级, seq / at) 稳定排序。`Array#sort` 保证相同键保持原有插入顺序，
   * 所以乐观消息之间仍然是「先发的在前」。
   */
  #sortMessages() {
    const bySeq = this.#allConfirmedHaveSeq()
    this.messages.sort((left, right) => {
      const a = this.#orderKey(left, bySeq)
      const b = this.#orderKey(right, bySeq)
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    })
  }

  /**
   * 记住一条消息的落位 seq。同一个气泡的重发 / 回放可能带着**更新**的 seq，
   * 只保留最小值（它第一次被记录的位置），否则气泡会被迟到帧推着来回跳。
   * @param {any} message
   * @param {unknown} seq
   * @param {'log'|'history'} [space] 序号空间（实时帧是事件日志序号）
   * @returns {boolean} 位置是否变了（调用方据此决定要不要重排）
   */
  #noteSeq(message, seq, space = 'log') {
    const value = finiteSeq(seq)
    if (value === undefined || !message) return false
    const current = finiteSeq(message.seq)
    if (current !== undefined && current <= value) return false
    message.seq = value
    message.seqSpace = space
    return true
  }

  /**
   * 把一条消息钉到「快照之后」那一段（tail）。
   *
   * 只有已经存在快照底座、且这条消息不是从快照来的，才需要钉：它的 seq 属于插件
   * 事件日志，和快照历史里的 `hist_<DSH seq>` 没有大小关系，混在同一个层级里比
   * 会把刚到的消息排到最前面（真机：新发的提问跳到昨天上面）。
   *
   * 后续快照把它收进历史时，消息会被 `fromSnapshot` 的新对象替换，tail 自然消失。
   * @param {any} message
   */
  #markTail(message) {
    if (!message) return false
    if (this.hasSnapshotBase !== true) return false
    if (message.fromSnapshot === true || message.optimistic === true) return false
    message.tail = true
    this.#noteArrival(message)
    return true
  }

  #insert(message) {
    if (!message?.id || this.byId.has(message.id)) return false
    // 快照建立之后才到达的实时消息 = 快照的后缀：钉在列表尾部（见 messageOrderKey）。
    // 历史消息的 seq 是 DSH 事件序号、实时帧是插件日志序号，两套序号没有大小关系，
    // 混着比会把刚到的消息排到最前面。
    this.#markTail(message)
    // 到达序号：反正在这一段里只对 tail 生效，但给每条都记上，重放到一半被
    // 标记成 tail 的消息（carryOver）也有确定的次序，不会退回墙钟。
    this.#noteArrival(message)
    // 电脑端给手机附件消息注入的提示段（“用户通过手机发来了…”）只该给模型看。
    // 任何路径进入手机聊天流都先剥掉，否则会出现一张带路径原文的异常气泡。
    if (message.kind === 'user') message.text = stripInjectedAttachmentNotice(message.text)
    // 内部注入（runtime context / system-reminder）永远不当聊天气泡展示。
    if (message.kind === 'user' && isInjectedHistoryText(message.text)) return false
    this.byId.set(message.id, message)
    this.messages.push(message)
    this.#sortMessages()
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
    this.hasSnapshotBase = false
    this.arrivalCounter = 0
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
    this.questionLog = []
  }

  /**
   * 把一批提问记成只读摘要（同一 questionId 只留一份，重复调用只更新结果）。
   *
   * 目的：答完的提问**不能凭空消失**。真机反馈「手机上答完之后聊天流里没有任何
   * 记录」——原实现收到 `question/resolved` 就直接出队，卡片连同题目一起没了。
   * 现在改成入一张只读卡（题目 + 所选答案 + 结果），resolved 只更新结果不删卡。
   * @param {any} question
   * @param {Array<{id?: string, selected?: string[], custom?: string}>} [answers]
   * @param {string} [outcome]
   * @param {string} [source]
   * @returns {any | undefined}
   */
  #rememberQuestion(question, answers = [], outcome = '', source = '') {
    const questionId = String(question?.questionId ?? '')
    if (questionId === '') return undefined
    const answeredById = new Map()
    for (const answer of Array.isArray(answers) ? answers : []) {
      if (!answer || typeof answer.id !== 'string') continue
      answeredById.set(answer.id, answer)
    }
    const previousIndex = this.questionLog.findIndex(entry => entry.questionId === questionId)
    const previous = previousIndex >= 0 ? this.questionLog[previousIndex] : undefined
    const previousById = new Map((previous?.items ?? []).map(item => [item.id, item]))
    const items = (Array.isArray(question.items) ? question.items : []).map(item => {
      const answer = answeredById.get(item.id)
      const fallback = previousById.get(item.id)
      // 新一轮答案为空（例如 resolved 后到）时保留之前记下的选择，不能清空战绩。
      const selected = Array.isArray(answer?.selected)
        ? answer.selected.filter(label => typeof label === 'string')
        : fallback?.selected ?? []
      const custom = typeof answer?.custom === 'string' ? answer.custom : fallback?.custom ?? ''
      return {
        id: String(item.id),
        question: String(item.question ?? ''),
        ...(item.header ? { header: item.header } : {}),
        selected,
        ...(custom !== '' ? { custom } : {}),
      }
    })
    const entry = {
      questionId,
      items,
      outcome: String(outcome ?? ''),
      source: String(source ?? ''),
      answered: outcome === 'answered'
        || items.some(item => (item.selected?.length ?? 0) > 0 || (item.custom ?? '') !== ''),
      // 保留第一次记录的时间：同一批只更新结果，卡片不要因为更新而跳到时间线末尾。
      at: previous?.at ?? new Date().toISOString(),
    }
    if (previous) this.questionLog[previousIndex] = entry
    else {
      this.questionLog.push(entry)
      while (this.questionLog.length > QUESTION_LOG_LIMIT) this.questionLog.shift()
    }
    this.#touch()
    return entry
  }

  /**
   * 本地已经提交了这一批答案：除了标记已回复，还要落一张只读摘要卡。
   * @param {string} questionId
   * @param {Array<{id?: string, selected?: string[], custom?: string}>} [answers]
   * @returns {boolean}
   */
  recordQuestionAnswer(questionId, answers = []) {
    const question = this.questionsById.get(String(questionId ?? ''))
    if (!question) return false
    if (!this.markQuestionReplied(questionId)) return false
    this.#rememberQuestion(question, answers, 'answered', 'phone')
    return true
  }

  /** 某个 questionId 的只读摘要（渲染层用）。 */
  questionSummary(questionId) {
    const id = String(questionId ?? '')
    if (id === '') return undefined
    return this.questionLog.find(entry => entry.questionId === id)
  }

  /**
   * 收起一张已收尾的提问摘要。
   * 真机反馈“回答完的卡片一直待在聊天流下方不消失”：摘要卡只是即时反馈，
   * 展示一小段时间后由 UI 自动收起（题目/答案仍在会话历史里）。
   * @param {string} questionId
   * @returns {boolean}
   */
  dismissQuestionSummary(questionId) {
    const id = String(questionId ?? '')
    if (id === '') return false
    const index = this.questionLog.findIndex(entry => entry.questionId === id)
    if (index < 0) return false
    this.questionLog.splice(index, 1)
    this.#touch()
    return true
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

  /**
   * 本地撤掉一条审批卡：用户已经作答（允许/拒绝/转电脑）时立即生效，
   * 不等电脑端的 resolved 帧——否则电脑端漏发/延迟时卡片会一直挂在下方。
   * @param {string} approvalId
   */
  dismissApproval(approvalId) {
    const id = String(approvalId ?? '')
    if (id === '') return false
    const index = this.approvals.findIndex(item => item.approvalId === id)
    this.approvalsById.delete(id)
    if (index >= 0) this.approvals.splice(index, 1)
    if (index >= 0) this.#touch()
    return index >= 0
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
      // 还没被网关确认：排序时先放在所有已确认消息之后（见 #orderKey），
      // 等 echo / 回放带回 seq 再落到它在事件日志里的真实位置。
      optimistic: true,
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
   * 补上本地用户消息的附件信息。
   *
   * 发送路径改成「先上屏、后上传」：气泡先带着附件名/大小出现（用户立刻看到自己
   * 发的消息），上传完成后再把 fileId/uploadId 补进来（点得动下载）。
   * @param {string} msgId
   * @param {any[]} files
   * @returns {boolean} 是否有变化
   */
  setUserMessageFiles(msgId, files) {
    const message = this.byId.get(userMessageId(msgId))
    if (!message) return false
    const next = normalizeAttachments(files)
    if (JSON.stringify(next) === JSON.stringify(message.files ?? [])) return false
    message.files = next
    this.#touch()
    return true
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
    // 同步中：实时帧只入 buffer，绝不直接改列表（否则晚到的快照会把它覆盖掉）。
    // 只缓冲「会改消息列表」的帧：
    //  · `chat/ack` 只改本地乐观消息的状态，与快照无关，压住会让气泡一直「发送中」；
    //  · `session/*` 是同步响应本身；审批/提问是独立队列且幂等。
    if (this.syncState === 'syncing' && SYNC_BUFFERED_FRAMES.has(frame.t)) {
      this.syncBuffer.push({ frame, now })
      return { handled: true, changed: false, buffered: true, frame }
    }
    return this.#dispatch(frame, now)
  }

  /**
   * 真正的帧分发（不含同步缓冲判定；`endSync` 重放时直接走这里）。
   * @param {any} frame
   * @param {number} now
   */
  #dispatch(frame, now) {
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
      const files = normalizeAttachments(frame.files)
      Object.assign(existing, {
        text: typeof frame.text === 'string' && frame.text !== ''
          ? stripInjectedAttachmentNotice(frame.text)
          : existing.text,
        // 只补空缺，绝不覆盖：echo 的 at 是「网关收到补发消息的时刻」，比原始发送
        // 时刻晚得多。用它替换本地 at 会让这条气泡在墙钟兜底排序里被推到后面，
        // 这正是真机「我先发的消息被排到所有回复之后」的直接原因。
        at: typeof existing.at === 'string' && existing.at !== '' ? existing.at : String(frame.at ?? ''),
        files: files.length > 0 ? files : existing.files,
        status: MESSAGE_STATUS.SENT,
        deviceId: frame.deviceId,
      })
      // seq 才是权威次序：一旦拿到就把它从「乐观」层级挪到日志里的真实位置。
      if (this.#noteSeq(existing, frame.seq)) existing.optimistic = false
      // 确认后才可能进 tail 段：这条提问比底座新，位置在快照之后（按到达序号）。
      this.#markTail(existing)
      this.#advanceCursor(frame.seq)
      this.#sortMessages()
      this.#touch(now)
      return { handled: true, changed: true, frame }
    }
    const text = stripInjectedAttachmentNotice(String(frame.text ?? ''))
    // 电脑端把同一条手机消息回显回来（或旧缓存里带着附件提示原文）时，按「同文本 +
    // 本地还没被确认」合并到已有本地气泡，绝不再插一条重复气泡。这里只认
    // `optimistic` 标记，不再用「两分钟内」这种时间窗——消息在离线队列里可能躺很久。
    if (text.trim() !== '') {
      const duplicate = this.messages.find(message => message.kind === 'user'
        && message.id !== id
        && message.text === text
        && message.optimistic === true)
      if (duplicate) {
        if (Array.isArray(frame.files) && frame.files.length > 0
          && (!duplicate.files || duplicate.files.length === 0)) {
          duplicate.files = normalizeAttachments(frame.files)
        }
        duplicate.status = MESSAGE_STATUS.SENT
        if (this.#noteSeq(duplicate, frame.seq)) duplicate.optimistic = false
        this.#markTail(duplicate)
        this.#advanceCursor(frame.seq)
        this.#sortMessages()
        this.#touch(now)
        return { handled: true, changed: true, frame }
      }
    }
    const inserted = this.#insert({
      id,
      kind: 'user',
      text,
      at: String(frame.at ?? new Date().toISOString()),
      files: normalizeAttachments(frame.files),
      status: MESSAGE_STATUS.SENT,
      msgId,
      deviceId: frame.deviceId,
      seq: Number.isFinite(Number(frame.seq)) ? Number(frame.seq) : undefined,
      ...(Number.isFinite(Number(frame.seq)) ? { seqSpace: 'log' } : {}),
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
    const text = String(frame.text ?? '')
    // 空文本的 `chat/message` 只是「这一轮开始了」的占位，不能登记成「已收到全文」：
    // 一旦登记，后续 `chat/delta` 会被 `#onDelta` 当成重复内容整段丢掉，手机上就只剩
    // 工具行和三个点、正文永远空白（3.0.2 修过、3.0.3 又漏掉的那个 bug）。
    if (text !== '') {
      const parts = this.parts.get(callId) ?? new Map()
      const index = Number.isFinite(Number(frame.index)) ? Number(frame.index) : parts.size
      parts.set(messageId, { index, text })
      this.parts.set(callId, parts)
    }
    const { message, inserted } = this.#ensureAssistantMessage(callId, now)
    this.#advanceCursor(frame.seq)
    // 助手帧没有 `at`（手机只能拿接收时刻当时间），落位一律靠 seq：重连回放时
    // 一堆帧同时到达，接收时刻和真实发生顺序完全无关。
    if (this.#noteSeq(message, frame.seq)) this.#sortMessages()
    const joined = this.#joinParts(callId)
    // 正文只增不退：part 全文与已累积的 delta 取更长的那个。
    const nextText = joined.length >= String(message.text ?? '').length ? joined : message.text
    // 快照可能先把这条标成 DONE（迟到正文被「DONE 不再改动」挡住就是「回复被吞」）。
    // 这里只允许变长，不允许回退或清空。
    if (!inserted && message.status === MESSAGE_STATUS.DONE) {
      if (nextText === '' || nextText === message.text) return { handled: true, changed: false, frame }
      message.text = nextText
      this.#touch(now)
      return { handled: true, changed: true, frame }
    }
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
    // 注意判定的是「已经有正文」（joinParts 非空），不是「登记过 part」——空占位
    // 也登记过，用它判定就会把正文整段丢掉。
    if (this.#joinParts(callId) !== '') return { handled: true, changed: false, frame }
    const existing = this.byId.get(assistantMessageId(callId))
    // 已经有正文并且已收尾：迟到 delta 不再追加（避免重复文本）。
    if (existing && existing.status === MESSAGE_STATUS.DONE && String(existing.text ?? '') !== '') {
      return { handled: true, changed: false, frame }
    }
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
    const { message } = this.#ensureAssistantMessage(callId, now)
    const authoritative = typeof frame.text === 'string' ? frame.text : ''
    const joined = this.#joinParts(callId)
    const next = authoritative !== '' ? authoritative : joined !== '' ? joined : message.text
    message.text = next
    message.status = MESSAGE_STATUS.DONE
    // chat/done 也带会话 seq：气泡的落位点是这一轮第一次出现的位置（取最小值）。
    if (this.#noteSeq(message, frame.seq)) this.#sortMessages()
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

  /**
   * 应用一份会话快照。
   *
   * 这里是「多个来源抢着改同一个列表」的唯一收敛点，规则只有三条：
   *  1. **旧 generation 的快照直接丢**（同步期间又发起了新的同步）；
   *  2. **已有底座时，比已知水位更旧的快照直接丢**（同一会话，`head < cursor`：它
   *     必然缺少已经应用过的实时帧——这正是「回复被回滚 62→60」）。没有底座时
   *     必须接收：此时快照是唯一的历史来源，落后只说明它取得比那几帧实时消息早；
   *  3. **快照只负责 `<= head` 的那一段**：本地比 head 更新的消息、以及还没被
   *     网关确认的乐观消息，重置后原样接回去，再按到达顺序重放 buffer。
   *
   * 原来那套「120 秒内同文本算同一条」「空快照不清空」的时间启发式全部删除：
   * 顺序由 head/seq 保证，去重由 id（msgId / callId / hist_seq）与计数抵消保证。
   * @param {any} frame
   * @param {number} now
   */
  #onSessionState(frame, now) {
    const sessionId = String(frame.sessionId ?? this.sessionId ?? '')
    const epoch = Number.isFinite(Number(frame.sessionEpoch)) ? Number(frame.sessionEpoch) : this.sessionEpoch
    const sessionChanged = sessionId !== this.sessionId || epoch !== this.sessionEpoch
    const head = Number(frame.head)
    const rid = typeof frame.rid === 'string' ? frame.rid : ''
    const ridGeneration = rid !== '' ? this.syncRids.get(rid) : undefined

    // 规则 1：这次快照属于一个已经被取代的同步。
    if (rid !== '' && ridGeneration !== undefined && ridGeneration !== this.syncGeneration) {
      this.syncStats.staleSnapshots += 1
      return { handled: true, changed: false, stale: true, frame }
    }
    // 规则 2：同一会话里，比已知水位更旧的快照。
    //
    // 只有「已经有底座」时才丢：底座意味着本地列表本身就是从某份快照长出来的，
    // 再来一份更旧的快照只可能是纯回退（它会缺掉已应用过的实时帧，正是「回复被
    // 回滚 62→60」）。**还没有底座时不能丢**——这时候快照是唯一的历史来源，
    // head 落后只是因为它比本地那几帧实时消息取得早；丢掉它等于把整段历史扔掉
    // （真机症状：重连后只剩刚发的一条）。这种情况交给规则 3：快照负责 `<= head`
    // 的部分，本地更新的消息按到达顺序接在后面。
    const sameSession = this.sessionId == null || sessionId === this.sessionId
    if (!sessionChanged && sameSession && this.hasSnapshotBase === true
      && Number.isFinite(head) && head > 0
      && this.cursor > 0 && head < this.cursor) {
      this.syncStats.staleSnapshots += 1
      if (this.syncState === 'syncing') this.endSync(ridGeneration)
      return { handled: true, changed: false, stale: true, frame }
    }
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
    /**
     * 本地还没被网关确认的用户气泡（老服务端快照没带 msgId 时的身份兜底）。
     * 只认 `optimistic` 标记，不再看「时间接近」——那是个猜时间的启发式。
     * @param {any} message
     */
    const unconfirmedUserText = message => message?.kind === 'user'
      && message.optimistic === true
      && typeof message.text === 'string'
      && message.text.trim() !== ''
    for (const raw of incoming) {
      let normalized = this.#normalizeSnapshotMessage(raw, now)
      if (!normalized || nextById.has(normalized.id)) continue
      // 老服务端快照不带 msgId：同文本的**本地未确认**气泡就是同一条，沿用本地 id。
      if (normalized.kind === 'user' && (typeof normalized.msgId !== 'string' || normalized.msgId === '')) {
        const duplicate = this.messages.find(message => unconfirmedUserText(message)
          && message.text.trim() === normalized.text.trim()
          && !nextById.has(message.id))
        if (duplicate) normalized.id = duplicate.id
      }
      // 同一条消息在本地可能已经有更完整的气泡（附件卡、mine 标记、干净文本、工具流）。
      // 快照是权威文本，但不要因此丢掉这些本地信息，更不能再插一条重复气泡。
      const previous = this.byId.get(normalized.id) ?? this.#snapshotCounterpart(normalized)
      if (previous && previous.id !== normalized.id) normalized.id = previous.id
      if (previous) {
        if (Array.isArray(previous.files) && previous.files.length > 0) normalized.files = previous.files
        if (previous.mine === true) normalized.mine = true
        if (Array.isArray(previous.tools) && previous.tools.length > 0) normalized.tools = previous.tools
        if (Number.isFinite(Number(previous.durationMs))) normalized.durationMs = previous.durationMs
        if (previous.truncated === true) normalized.truncated = true
        if (normalized.kind === 'user' && typeof previous.text === 'string' && previous.text.trim() !== ''
          && normalized.text.length > previous.text.length && normalized.text.startsWith(previous.text)) {
          // 服务端已剥离附件提示；仍出现「本地文本 + 注入提示」的超集时保留干净文本。
          normalized.text = previous.text
        }
      }
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
        // 快照只带 activeCall、没有历史消息行时，也要把实时工具流接回来。
        const previousActive = this.messages.find(message => message?.kind === 'assistant'
          && message.callId === activeCall.callId)
        const message = {
          id,
          kind: 'assistant',
          text: String(activeCall.text ?? ''),
          at: new Date(now).toISOString(),
          callId: activeCall.callId,
          status: MESSAGE_STATUS.STREAMING,
          tools: Array.isArray(previousActive?.tools) && previousActive.tools.length > 0
            ? previousActive.tools
            : [],
        }
        nextById.set(id, message)
        nextMessages.push(message)
      }
      if (activeCall.typing !== false) this.typing.add(activeCall.callId)
    }
    const hadMessages = this.messages.length > 0
    if (sameSession && hadMessages && nextMessages.length === 0
      && Number.isFinite(head) && head > 0) {
      // 退化快照（历史没读到 / 事件日志已轮转）：整份为空但水位在前进。
      // 这不是「会话清空了」，而是「这份快照不可用」——保留现有列表，**不推进
      // cursor**，让下一次 session/sync 从旧水位重放，宁可重复也不吞消息。
      this.syncStats.degraded += 1
      if (this.sessionId == null) {
        this.sessionId = sessionId
        this.sessionEpoch = epoch
      }
      if (this.syncState === 'syncing') this.endSync(ridGeneration)
      return { handled: true, changed: false, sessionChanged, frame, degraded: true }
    }
    // 规则 3：快照只覆盖 `<= head` 的那一段。剩下的本地消息按「同 kind + 同文本」
    // 计数抵消（快照里已有同样内容就不再接回来，避免两条一样的气泡）。
    const snapshotKeys = new Map()
    for (const message of nextMessages) {
      const key = JSON.stringify([message.kind, message.text])
      snapshotKeys.set(key, (snapshotKeys.get(key) ?? 0) + 1)
    }
    const carryOver = []
    if (sameSession) {
      for (const message of this.messages) {
        if (!message || nextById.has(message.id)) continue
        const seq = Number(message.seq)
        // 「比快照新」只在同一套序号空间里成立：历史消息 id 是 hist_<DSH 事件 seq>，
        // 实时帧的 seq 是插件事件日志序号，两套序号不能直接比大小。
        const newer = Number.isFinite(seq) && Number.isFinite(head) && message.seqSpace === 'log' && seq > head
        if (message.optimistic !== true && !newer) continue
        const key = JSON.stringify([message.kind, message.text])
        const count = snapshotKeys.get(key) ?? 0
        if (count > 0) {
          snapshotKeys.set(key, count - 1)
          continue
        }
        // 比快照新的消息钉在快照之后（按到达顺序排，不按墙钟），不参与历史 seq 的排序。
        if (newer) {
          message.tail = true
          this.#noteArrival(message)
        }
        carryOver.push(message)
      }
    }
    this.messages = [...nextMessages.slice(-this.limit), ...carryOver]
    // 快照消息按 seq（历史 id 是 `hist_<seq>`）排，乐观消息永远排最后：
    // 手机会话「我的提问排在回复后面」就是这里按墙钟排错的。
    this.#sortMessages()
    this.#trim()
    this.byId = new Map(this.messages.map(message => [message.id, message]))
    this.hasSnapshotBase = true
    this.parts.clear()
    this.deltaSeq.clear()
    if (typeof frame.title === 'string' && frame.title !== '') this.sessionTitle = frame.title
    this.sessionId = sessionId
    this.sessionEpoch = epoch
    if (Number.isFinite(head)) {
      // 换会话后 cursor 必须跟着新会话走（取快照的 head，而不是和旧会话取 max），
      // 否则下一次 session/sync 会用旧会话的 seq 去要增量。
      this.cursor = sessionChanged ? Math.max(0, head) : Math.max(this.cursor, head)
    }
    this.#touch(now)
    this.syncStats.snapshots += 1
    // 快照落地 → 按到达顺序重放同步期间缓存的实时帧，然后才回到 ready。
    if (this.syncState === 'syncing') this.endSync(ridGeneration)
    return { handled: true, changed: true, sessionChanged, frame }
  }

  /**
   * 快照消息与本地已有消息的对应关系（callId → 同文本，最近的优先）。
   *
   * 用途：把实时帧积累的 `tools`（工具流）保留到快照重建后的气泡上，并沿用实时
   * 气泡的 id（后续 tool 帧才能落到同一条上）。
   *
   * 这里**不再按 seq 匹配**：快照的历史 id 是 `hist_<DSH 事件 seq>`，实时帧的 seq
   * 是插件事件日志序号，两套序号只是碰巧可能相等，用它匹配会在长会话里把两条
   * 不相干的消息合并成一条。
   * @param {any} normalized
   * @returns {any | undefined}
   */
  #snapshotCounterpart(normalized) {
    const callId = typeof normalized.callId === 'string' ? normalized.callId : ''
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]
      if (message?.kind !== normalized.kind) continue
      if (normalized.kind === 'assistant') {
        if (callId !== '' && message.callId === callId) return message
        if (normalized.text !== '' && message.text === normalized.text) return message
      }
    }
    return undefined
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
    // 用户消息只要带了 msgId，就一律用本地气泡 id（usr_<msgId>）：服务端历史里同一条
    // 手机消息的 id 是 hist_<seq>，不统一就会出现「同一句消息显示两遍」（真机反馈）。
    // 助手消息带了 callId 时同理：快照与实时帧用同一个 id，后续 tool/done 才会落到
    // 同一条气泡上，不用再靠文本/序号去猜对应关系。
    if (kind === 'user' && typeof raw.msgId === 'string' && raw.msgId !== '') {
      id = userMessageId(raw.msgId)
    } else if (kind === 'assistant' && typeof raw.callId === 'string' && raw.callId !== '') {
      id = assistantMessageId(raw.callId)
    } else if (id === '') {
      if (kind === 'user' && typeof raw.msgId === 'string') id = userMessageId(raw.msgId)
      else if (kind === 'assistant' && typeof raw.callId === 'string') id = assistantMessageId(raw.callId)
      else return undefined
    }
    const seq = snapSeqOf(raw)
    return {
      id,
      kind,
      fromSnapshot: true,
      text: kind === 'user' ? stripInjectedAttachmentNotice(String(raw.text ?? '')) : String(raw.text ?? ''),
      at: String(raw.at ?? new Date(now).toISOString()),
      files: normalizeAttachments(raw.files),
      status: kind === 'assistant' ? MESSAGE_STATUS.DONE : MESSAGE_STATUS.SENT,
      msgId: raw.msgId,
      callId: raw.callId,
      // 网关的历史消息 id 是 `hist_<seq>`。能解析就用 seq 排序：at 只有毫秒精度，
      // 一轮问答里很容易撞在一起，而 seq 是会话内严格单调的。
      seq,
      // 序号空间：历史消息（hist_<DSH 事件 seq>）与实时帧（插件事件日志序号）是
      // 两套单调计数，不能混着比大小。
      ...(seq !== undefined ? { seqSpace: /^hist_/.test(String(raw.id ?? '')) ? 'history' : 'log' } : {}),
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
        // 回放事件是权威顺序，直接分发（不能再进同步 buffer）。
        const result = this.#dispatch(event, now)
        this.cursor = Math.max(this.cursor, seq)
        changed = changed || result.changed
      } else if (event && typeof event.t === 'string') {
        const result = this.#dispatch(event, now)
        changed = changed || result.changed
      }
    }
    if (Number.isFinite(Number(frame.head))) this.cursor = Math.max(this.cursor, Number(frame.head))
    if (changed) this.#touch(now)
    // 事件回放就是这次同步的答案：重放同步期间缓存的实时帧，然后回到 ready。
    if (this.syncState === 'syncing') this.endSync()
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
      // 电脑端重新推送同一个 approvalId，说明它**仍然在等答复**：上一次答复
      // 没被接收（手机掉线 / 页面被系统挂起）。清掉本地「已答复」，让用户能
      // 重新点，而不是停在一张点不动、电脑却在等的卡上。
      existing.replied = false
      delete existing.repliedOutcome
      delete existing.repliedAt
      Object.assign(existing, approval)
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
    // 同一批重新推过来（电脑端重发 / 断线后补推）说明它又活了：把旧的只读摘要
    // 摘掉，保证同一 questionId 在任何时刻只有一张卡（可点的这张）。
    const logged = this.questionLog.findIndex(item => item.questionId === question.questionId)
    if (logged >= 0) this.questionLog.splice(logged, 1)
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
   * `question/resolved`：出队（无论结果如何都不该再显示可点的表单），
   * 但**留下一张只读摘要卡**——题目 +（已知的）所选答案 + 结果，答完不会凭空消失。
   * @param {any} frame
   * @param {number} now
   */
  #onQuestionResolved(frame, now) {
    const questionId = String(frame.questionId ?? '')
    if (questionId === '') return { handled: true, changed: false, frame }
    const question = this.questionsById.get(questionId)
    const index = this.questions.findIndex(item => item.questionId === questionId)
    this.questionsById.delete(questionId)
    if (index >= 0) this.questions.splice(index, 1)
    const outcome = typeof frame.outcome === 'string' ? frame.outcome : ''
    const source = typeof frame.source === 'string' ? frame.source : ''
    // 已经答过（本地提交时已落摘要）就只更新结果，不重复插卡。
    const summary = question ? this.#rememberQuestion(question, [], outcome, source) : undefined
    if (index >= 0 || summary) this.#touch(now)
    return {
      handled: true,
      changed: index >= 0 || summary !== undefined,
      frame,
      resolved: { questionId, outcome, source },
      question: summary,
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
      const existing = this.byId.get(id)
      this.#update(id, { file: meta })
      if (this.#noteSeq(existing, frame.seq)) this.#sortMessages()
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
      seq: meta.seq,
      ...(meta.seq !== undefined ? { seqSpace: 'log' } : {}),
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
        // seq / optimistic 必须落盘：刷新后若丢掉 seq，消息就退回「按 at 兜底」，
        // 顺序会在一次刷新后重新洗牌（正是这次要修的 bug）。
        seq: Number.isFinite(Number(message.seq)) ? Number(message.seq) : undefined,
        ...(message.seqSpace ? { seqSpace: message.seqSpace } : {}),
        ...(message.optimistic === true ? { optimistic: true } : {}),
        ...(message.tail === true ? { tail: true } : {}),
        ...(message.fromSnapshot === true ? { fromSnapshot: true } : {}),
      })),
      // 已收尾的提问摘要也落盘：刷新后聊天流里仍能看到之前问过什么、答了什么。
      questionLog: this.questionLog.slice(-QUESTION_LOG_LIMIT).map(entry => ({
        questionId: entry.questionId,
        items: entry.items,
        outcome: entry.outcome,
        source: entry.source,
        answered: entry.answered === true,
        at: entry.at,
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
    // 到达序号不落盘（跨进程没有意义）：按存档里的顺序重新发号，tail 段的相对
    // 次序就和刷新前一致。计数器必须先清零，否则会与旧号交叉。
    this.arrivalCounter = 0
    for (const raw of saved.messages) {
      if (!raw || typeof raw.id !== 'string') continue
      const message = { ...raw, tools: Array.isArray(raw.tools) ? raw.tools : [] }
      if (message.kind === 'user') message.text = stripInjectedAttachmentNotice(message.text)
      // 只有附件提示、没有用户文字的历史消息是旧版本重复气泡的残留：本地气泡已经
      // 带着附件卡，这里直接丢掉，别让它在刷新后又出现一句占位文本。
      if (message.kind === 'user' && message.text === '（来自手机的附件）') continue
      if (message.kind === 'user' && isInjectedHistoryText(message.text)) continue
      if (message.kind === 'file' && message.file?.fileId) this.files.set(message.file.fileId, message.file)
      if (this.byId.has(message.id)) continue
      // 缓存里的 seq 是权威次序的一部分，恢复时不能丢（丢了就退回按 at 兜底排序）。
      if (Number.isFinite(Number(raw.seq))) message.seq = Number(raw.seq)
      else delete message.seq
      if (message.seq === undefined) delete message.seqSpace
      else if (raw.seqSpace === 'history' || raw.seqSpace === 'log') message.seqSpace = raw.seqSpace
      message.optimistic = raw.optimistic === true
      if (raw.tail === true) message.tail = true
      else delete message.tail
      if (raw.fromSnapshot === true) message.fromSnapshot = true
      else delete message.fromSnapshot
      message.arrival = this.#nextArrival()
      this.byId.set(message.id, message)
      this.messages.push(message)
    }
    this.questionLog = []
    for (const raw of Array.isArray(saved.questionLog) ? saved.questionLog : []) {
      const entry = normalizeQuestionLogEntry(raw)
      if (entry) this.questionLog.push(entry)
      if (this.questionLog.length >= QUESTION_LOG_LIMIT) break
    }
    this.hasSnapshotBase = this.messages.some(message => message.fromSnapshot === true)
    this.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : null
    this.sessionEpoch = Number.isFinite(Number(saved.sessionEpoch)) ? Number(saved.sessionEpoch) : 0
    this.sessionTitle = typeof saved.sessionTitle === 'string' ? saved.sessionTitle : ''
    this.cursor = Number.isFinite(Number(saved.cursor)) ? Number(saved.cursor) : 0
    // 旧缓存可能不是排序后的顺序：恢复完统一按同一套键重排一次。
    this.#sortMessages()
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

  /**
   * 开始一次同步（某个会话）。快照请求前调用：期间到达的实时帧先进 buffer，
   * 快照落地后按序重放。
   * @param {string} sessionId
   * @param {{reason?: string, rid?: string}} [options]
   * @returns {number | undefined} generation
   */
  beginSync(sessionId, options = {}) {
    const chat = this.ensureChat(sessionId)
    return chat?.beginSync(options)
  }

  /**
   * 结束同步并重放 buffer。
   * @param {string} sessionId
   * @param {number} [generation]
   */
  endSync(sessionId, generation) {
    return this.chats.get(String(sessionId ?? ''))?.endSync(generation) === true
  }

  /** 某个会话是否正在同步（在等快照）。 */
  isSyncing(sessionId) {
    return this.chats.get(String(sessionId ?? ''))?.isSyncing === true
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

  /** 当前标签里已收尾的提问摘要（只读卡片，短暂展示后自动收起）。 */
  get questionLog() {
    return this.active?.questionLog ?? EMPTY_ARRAY
  }

  /** 收起一张已收尾的提问摘要。 */
  dismissQuestionSummary(questionId) {
    return this.active?.dismissQuestionSummary(questionId) === true
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

  /**
   * 会话的展示状态（标签条 / 会话列表右侧指示器）。
   * - `approval`：有等待用户处理的审批或结构化提问（黄点）——优先级最高；
   * - `running`：agent 正在这个会话里回复（转圈）；
   * - `online`：会话在电脑端 live、当前空闲（绿点）；
   * - `idle`：其余（没有指示器，例如尚未发送的本地草稿）。
   * @param {string} sessionId
   * @returns {'approval'|'running'|'online'|'idle'}
   */
  statusFor(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return 'idle'
    const chat = this.chats.get(id)
    if (chat) {
      const approval = (chat.approvals ?? []).some(item => item.replied !== true && item.expired !== true)
      const question = (chat.questions ?? []).some(item => item.replied !== true)
      if (approval || question) return 'approval'
    }
    if (this.#activityFor(id).typing === true) return 'running'
    if (this.sessions.find(item => item.id === id)?.live === true) return 'online'
    return 'idle'
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
   * 把本地草稿标签（draft:…）换成电脑端刚创建出来的真实会话 id。
   * `session/selected` 到达时模型可能已经把真实 id 自动开成了标签，所以这里要合并：
   * 真实 id 已存在就丢掉草稿标签，否则原地替换（聊天缓存、活动状态、当前标签一起搬）。
   * @param {string} fromSessionId 本地草稿 id
   * @param {string} toSessionId 电脑端真实 id
   * @returns {{ok: boolean, changed: boolean, activeSessionId: string}}
   */
  replaceSessionId(fromSessionId, toSessionId) {
    const from = String(fromSessionId ?? '')
    const to = String(toSessionId ?? '')
    if (from === '' || to === '' || from === to) {
      return { ok: false, changed: false, activeSessionId: this.activeSessionId }
    }
    const index = this.tabs.indexOf(from)
    if (index < 0) return { ok: false, changed: false, activeSessionId: this.activeSessionId }
    if (this.tabs.includes(to)) {
      // 真实标签已经开出来了：丢掉草稿，把焦点交给真实标签。
      this.tabs.splice(index, 1)
      this.#forgetChat(from)
      if (this.activeSessionId === from) {
        this.activeSessionId = to
        this.#activityFor(to).unread = 0
      }
    } else {
      this.tabs[index] = to
      const chat = this.chats.get(from)
      if (chat) {
        this.chats.delete(from)
        chat.sessionId = to
        this.chats.set(to, chat)
      }
      const activity = this.activity.get(from)
      if (activity) {
        this.activity.delete(from)
        this.activity.set(to, activity)
      }
      if (this.activeSessionId === from) this.activeSessionId = to
    }
    this.closedSessions.delete(to)
    this.#touch()
    return { ok: true, changed: true, activeSessionId: this.activeSessionId }
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

  /** 补上某条本地用户消息的附件（先上屏、后上传）。 */
  setUserMessageFiles(msgId, files) {
    const found = this.findUserMessage(msgId)
    if (!found) return false
    return found.chat.setUserMessageFiles(msgId, files)
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

  /**
   * 提交一批答案：标记已回复 + 在当前标签落一张只读摘要卡。
   * @param {string} questionId
   * @param {Array<{id?: string, selected?: string[], custom?: string}>} [answers]
   * @returns {boolean}
   */
  recordQuestionAnswer(questionId, answers = []) {
    const found = this.findQuestion(questionId)
    if (!found) return false
    const changed = found.chat.recordQuestionAnswer(questionId, answers)
    if (changed) this.#touch()
    return changed
  }

  /** 某个 questionId 的只读摘要（渲染层用；跨标签查找）。 */
  questionSummary(questionId) {
    const id = String(questionId ?? '')
    if (id === '') return undefined
    for (const chat of this.chats.values()) {
      const summary = chat.questionSummary(id)
      if (summary) return summary
    }
    return undefined
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
    // closedSessions 必须一起落盘：否则刷新后“刚关掉的会话”又被电脑端的绑定快照
    // 弹回来（真机：手机端删不掉已连接的会话，每回重启网页都会复现）。
    return {
      version: 1,
      tabs: this.tabs.slice(),
      activeSessionId: this.activeSessionId,
      closedSessions: [...this.closedSessions],
    }
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
    // 恢复“用户已关闭”的墓碑：电脑端仍绑定的旧会话发来快照时不能再自动开标签。
    this.closedSessions.clear()
    for (const raw of Array.isArray(input.closedSessions) ? input.closedSessions : []) {
      if (typeof raw !== 'string') continue
      const id = raw.trim()
      if (id === '' || ids.includes(id) || this.closedSessions.has(id)) continue
      this.closedSessions.add(id)
      if (this.closedSessions.size >= 16) break
    }
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


