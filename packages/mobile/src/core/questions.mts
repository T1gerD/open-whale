// 结构化提问（question，3.0.0）的纯逻辑：归一化、队列、草稿、回包、倒计时。
//
// 它与「审批」是两条独立的 seam（DSH 的 `ctx.userQuestions` vs `ctx.approval`）：
//  * 审批只有允许/拒绝；提问是「一批问题 + 选项 + 可选自定义文本」；
//  * 答案必须**每个问题恰好一条**（未答的发 `{id, selected: []}` 表示跳过）；
//  * 单选题填了「其他」时仍按 DSH 规则：`custom` 覆盖 `selected`（selected 置空），
//    多选题 `custom` 与 `selected` 并列；
//  * `askTimed()` 的问题在前台超时后仍可补答（`canAnswerLate`），所以卡片不能在
//    `expiresAt` 一到就永久消失——只有 `canAnswerLate=false` 才裁掉。

import { CAPABILITIES, CLIENT_FRAME, QUESTION_MAX_ITEMS, QUESTION_MAX_OPTIONS, QUESTION_MAX_TEXT, QUESTION_TIMEOUT_MS } from './frames.mts'

/** 一个可选项。 */
export interface QuestionOption {
  label: string
  description?: string
}

/** 计划审阅意图：`approve` 是表示同意的选项标签。 */
export interface QuestionIntent {
  kind: 'plan-review'
  approve: string
  callId?: string
}

/** 一条问题。 */
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
  intent?: QuestionIntent
}

/** 电脑端转发来的一批提问（来自 `question/ask`）。 */
export interface QuestionPrompt {
  questionId: string
  items: QuestionItem[]
  /** 该批提问属于哪个工具调用（可缺省）。 */
  callId?: string
  /** Unix 毫秒：电脑端在此时结束前台等待（之后仍然可以补答，见 canAnswerLate）。 */
  expiresAt?: number
  /** 超时后电脑端还会接受补答（DSH 的 askTimed / continued question）。 */
  canAnswerLate: boolean
  /** 收到时间（排序/提示用）。 */
  receivedAt: number
}

/** 用户对某一题的草稿：选中的选项 + 「其他」文本。 */
export interface QuestionDraftItem {
  selected: string[]
  custom?: string
}

/** 整批草稿：questionId → 该题的草稿。 */
export type QuestionDraft = Record<string, QuestionDraftItem>

/** 同时排队的最多提问批次；再多就挡住输入栏了。 */
export const MAX_PENDING_QUESTIONS = 3

export interface QuestionAskFrameLike {
  questionId?: unknown
  items?: unknown
  callId?: unknown
  expiresAt?: unknown
  canAnswerLate?: unknown
}

export interface QuestionReplyFrame {
  t: 'question/reply'
  questionId: string
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/**
 * 归一化一条 `question/ask`。没有 questionId 或没有任何合法问题就丢弃：
 * 一份点不出正确回包的卡片只会让用户以为「答了但没生效」。
 */
export function normalizeQuestionAsk(frame: QuestionAskFrameLike, now: number = Date.now()): QuestionPrompt | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  const questionId = typeof frame.questionId === 'string' ? frame.questionId.trim() : ''
  if (!questionId) return undefined
  const items = normalizeQuestionItems(frame.items)
  if (items.length === 0) return undefined
  const prompt: QuestionPrompt = {
    questionId,
    items,
    canAnswerLate: frame.canAnswerLate === true,
    receivedAt: now,
  }
  if (typeof frame.callId === 'string' && frame.callId !== '') prompt.callId = frame.callId
  const expiresAt = toMillis(frame.expiresAt)
  if (expiresAt !== undefined) prompt.expiresAt = expiresAt
  return prompt
}

/** 清洗问题数组：丢掉形状不合法的条目，并给数量/长度设上限。 */
export function normalizeQuestionItems(value: unknown): QuestionItem[] {
  const items: QuestionItem[] = []
  for (const candidate of Array.isArray(value) ? value : []) {
    if (items.length >= QUESTION_MAX_ITEMS) break
    if (!candidate || typeof candidate !== 'object') continue
    const q = candidate as Record<string, unknown>
    if (typeof q.id !== 'string' || q.id.trim() === '' || typeof q.question !== 'string') continue
    const item: QuestionItem = { id: q.id.trim(), question: q.question.slice(0, QUESTION_MAX_TEXT) }
    if (typeof q.detail === 'string' && q.detail.trim() !== '') item.detail = q.detail.slice(0, QUESTION_MAX_TEXT)
    if (typeof q.header === 'string' && q.header.trim() !== '') item.header = q.header.slice(0, 200)
    if (Array.isArray(q.options)) {
      const options: QuestionOption[] = []
      for (const option of q.options) {
        if (options.length >= QUESTION_MAX_OPTIONS) break
        if (!option || typeof option !== 'object') continue
        const o = option as Record<string, unknown>
        if (typeof o.label !== 'string' || o.label.trim() === '') continue
        options.push({
          label: o.label.slice(0, 200),
          ...(typeof o.description === 'string' && o.description.trim() !== ''
            ? { description: o.description.slice(0, 500) }
            : {}),
        })
      }
      if (options.length > 0) item.options = options
    }
    if (q.multiSelect === true) item.multiSelect = true
    const intent = q.intent as Record<string, unknown> | undefined
    if (intent && typeof intent === 'object' && intent.kind === 'plan-review' && typeof intent.approve === 'string') {
      item.intent = {
        kind: 'plan-review',
        approve: intent.approve.slice(0, 200),
        ...(typeof intent.callId === 'string' ? { callId: intent.callId } : {}),
      }
    }
    items.push(item)
  }
  return items
}

/**
 * 入队（按 questionId upsert）：电脑端重连/重发同一批时更新而不是重复排队，
 * 否则用户答完第一条后第二条会永远挂着。
 */
export function enqueueQuestion(list: QuestionPrompt[], prompt: QuestionPrompt): QuestionPrompt[] {
  const current = Array.isArray(list) ? list : []
  const index = current.findIndex(item => item.questionId === prompt.questionId)
  const next = index >= 0 ? current.map((item, i) => (i === index ? prompt : item)) : [...current, prompt]
  return next.length > MAX_PENDING_QUESTIONS ? next.slice(next.length - MAX_PENDING_QUESTIONS) : next
}

/** 收到 `question/resolved`：不论结果，都把卡片撤掉。 */
export function resolveQuestion(list: QuestionPrompt[], questionId: unknown): QuestionPrompt[] {
  const id = typeof questionId === 'string' ? questionId : ''
  if (!id) return Array.isArray(list) ? list : []
  const current = Array.isArray(list) ? list : []
  const next = current.filter(item => item.questionId !== id)
  return next.length === current.length ? current : next
}

/**
 * 裁掉真正失效的提问：`canAnswerLate=false` 且已过期的才删。
 * `canAnswerLate=true` 的卡片留到 `resolved` 或用户主动忽略。
 */
export function pruneExpiredQuestions(list: QuestionPrompt[], now: number = Date.now()): QuestionPrompt[] {
  const current = Array.isArray(list) ? list : []
  const next = current.filter(item => !(isQuestionExpired(item, now) && !item.canAnswerLate))
  return next.length === current.length ? current : next
}

/** 是否已过前台等待时间。 */
export function isQuestionExpired(prompt: QuestionPrompt, now: number = Date.now()): boolean {
  if (typeof prompt.expiresAt !== 'number' || !Number.isFinite(prompt.expiresAt)) return false
  return prompt.expiresAt <= now
}

/** 这张卡现在还能不能提交：过期后只有 canAnswerLate 的还能补答。 */
export function questionAnswerable(prompt: QuestionPrompt, now: number = Date.now()): boolean {
  return !isQuestionExpired(prompt, now) || prompt.canAnswerLate
}

/** 剩余毫秒；没有 expiresAt 时 undefined（UI 就不画倒计时）。 */
export function questionRemainingMs(prompt: QuestionPrompt, now: number = Date.now()): number | undefined {
  if (typeof prompt.expiresAt !== 'number' || !Number.isFinite(prompt.expiresAt)) return undefined
  return Math.max(0, prompt.expiresAt - now)
}

/** 倒计时文案：`1:30`。 */
export function formatQuestionCountdown(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 点击一个选项：单选替换、多选切换。
 * @returns 新的草稿（不修改入参，方便 React 层直接 setState）
 */
export function toggleQuestionOption(draft: QuestionDraft, item: QuestionItem, label: string): QuestionDraft {
  const current = draft[item.id] ?? { selected: [] }
  const selected = item.multiSelect === true
    ? current.selected.includes(label)
      ? current.selected.filter(value => value !== label)
      : [...current.selected, label]
    : current.selected.includes(label)
      ? []
      : [label]
  return { ...draft, [item.id]: { ...current, selected } }
}

/** 输入「其他」文本。 */
export function setQuestionCustom(draft: QuestionDraft, item: QuestionItem, custom: string): QuestionDraft {
  const current = draft[item.id] ?? { selected: [] }
  const text = custom.slice(0, QUESTION_MAX_TEXT)
  return { ...draft, [item.id]: { ...current, custom: text } }
}

/**
 * 把一份草稿拼成 `question/reply`。
 *
 * 规则（与 DSH 一致）：
 *  * 每个问题恰好一条，没答的发 `{id, selected: []}`；
 *  * 单选题填了「其他」时 selected 置空（custom 覆盖选项）；
 *  * 只有电脑端给过的选项才算数。
 */
export function buildQuestionReply(prompt: QuestionPrompt, draft: QuestionDraft): QuestionReplyFrame | undefined {
  if (!prompt || typeof prompt.questionId !== 'string' || prompt.questionId === '') return undefined
  const answers = prompt.items.map(item => {
    const entry = draft?.[item.id]
    const allowed = new Set((item.options ?? []).map(option => option.label))
    const selected = Array.isArray(entry?.selected) ? entry.selected.filter(label => allowed.has(label)) : []
    const custom = typeof entry?.custom === 'string' ? entry.custom.trim() : ''
    if (item.multiSelect !== true) {
      return { id: item.id, selected: custom !== '' ? [] : selected, ...(custom !== '' ? { custom } : {}) }
    }
    return { id: item.id, selected, ...(custom !== '' ? { custom } : {}) }
  })
  return { t: CLIENT_FRAME.QUESTION_REPLY, questionId: prompt.questionId, answers }
}

/** 这份草稿是否至少回答了一个问题（全是跳过就没必要拦着用户提交）。 */
export function draftHasAnswer(draft: QuestionDraft): boolean {
  return Object.values(draft ?? {}).some(entry =>
    (Array.isArray(entry.selected) && entry.selected.length > 0) ||
    (typeof entry.custom === 'string' && entry.custom.trim() !== ''),
  )
}

/**
 * 手机能不能回答这条提问。电脑端没声明 `questions-v1` 时不要发 reply。
 */
export function questionAvailability(
  online: boolean,
  capabilities: readonly string[] | undefined,
): { ok: true } | { ok: false; error: string; hint: string } {
  if (!online) {
    return {
      ok: false,
      error: '当前离线，没法回答这个问题',
      hint: `电脑端会等 ${Math.round(QUESTION_TIMEOUT_MS / 1000)} 秒后把问题交回桌面；连上后可以在这里重试。`,
    }
  }
  const list = Array.isArray(capabilities) ? capabilities : []
  if (!list.includes(CAPABILITIES.QUESTIONS)) {
    return {
      ok: false,
      error: '电脑端版本较旧，不能由手机回答提问',
      hint: '请在电脑上的 DSH 里直接回答，或把 dsh-openwhale 插件升级后重连。',
    }
  }
  return { ok: true }
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && value !== '') {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value)
      return Number.isFinite(numeric) ? Math.floor(numeric) : undefined
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
