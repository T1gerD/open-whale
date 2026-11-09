// 权限请求（approval，2.3.0）的纯逻辑：应答帧、队列维护、过期裁剪、倒计时文案。
//
// 关键约束（都来自冻结契约，别在这里“优化”）：
//  * `allowed-once` 只授权这一次工具调用，**不会**提升沙箱模式；
//  * 电脑端等 `APPROVAL_TIMEOUT_MS`，超时就把提示交回桌面，所以手机端的倒计时
//    是“电脑会代答”的时刻，不是“请求失效”的时刻；
//  * 同时可能有多条 ask 在等（不同工具/不同回合），队列必须按 approvalId 去重，
//    后到的不能覆盖先到的，否则用户会看不到正在等的那一条。

import { APPROVAL_REPLY_OUTCOMES, APPROVAL_TIMEOUT_MS, CAPABILITIES, CLIENT_FRAME } from './frames.mts'

/** `displayReason` 是「语言 → 文案」的映射，protocol 保证至少有 `en`。 */
export type ApprovalDisplayReason = { en: string; [locale: string]: string }

/** 一条待回答的权限请求（来自 `approval/ask`）。 */
export interface ApprovalPrompt {
  approvalId: string
  /** 想运行的工具名（例如 `bash`、`write`）。 */
  toolName: string
  /** 电脑端记录的机器原因（没有本地化文案时兜底显示）。 */
  reason?: string
  /** 电脑端给的本地化文案。 */
  displayReason?: ApprovalDisplayReason
  /** 这条请求属于哪个回合（可缺省）。 */
  callId?: string
  /** Unix 毫秒：电脑端到这个时刻会把提示交回桌面 UI。 */
  expiresAt?: number
  /** 收到这条请求的本地时间（排序/提示用）。 */
  receivedAt: number
}

/** 手机端唯一的两种答复。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'delegate'

/** 同时展示/排队的最多请求数：再多说明电脑端在狂刷，全堆上来反而挡住输入栏。 */
export const MAX_PENDING_APPROVALS = 4

export interface ApprovalAskFrameLike {
  approvalId?: unknown
  toolName?: unknown
  reason?: unknown
  displayReason?: unknown
  callId?: unknown
  expiresAt?: unknown
}

export interface ApprovalReplyFrame {
  t: 'approval/reply'
  approvalId: string
  outcome: ApprovalOutcome
}

/**
 * 归一化一条 `approval/ask`。没有 approvalId 或工具名就丢弃：
 * 一条点不出正确回包的卡片只会让用户以为“允许了但没生效”。
 */
export function normalizeApprovalAsk(frame: ApprovalAskFrameLike, now: number = Date.now()): ApprovalPrompt | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId.trim() : ''
  if (!approvalId) return undefined
  const toolName = typeof frame.toolName === 'string' && frame.toolName.trim() !== '' ? frame.toolName.trim() : '工具调用'
  const prompt: ApprovalPrompt = { approvalId, toolName, receivedAt: now }
  if (typeof frame.reason === 'string' && frame.reason.trim() !== '') prompt.reason = frame.reason.trim()
  const display = normalizeDisplayReason(frame.displayReason)
  if (display) prompt.displayReason = display
  if (typeof frame.callId === 'string' && frame.callId !== '') prompt.callId = frame.callId
  const expiresAt = toMillis(frame.expiresAt)
  if (expiresAt !== undefined) prompt.expiresAt = expiresAt
  return prompt
}

/** 本地化文案里优先中文，其次 `en`；一个都没有就当作没给。 */
export function normalizeDisplayReason(value: unknown): ApprovalDisplayReason | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries: Array<[string, string]> = []
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text.trim() !== '') entries.push([key, text.trim()])
  }
  if (entries.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const [key, text] of entries) out[key] = text
  const en = out.en ?? entries[0]![1]
  return { ...out, en }
}

/** 卡片上那段人能看懂的原因。 */
export function approvalReasonText(prompt: ApprovalPrompt): string {
  const display = prompt.displayReason
  if (display) {
    const preferred = display.zh ?? display['zh-CN'] ?? display['zh-Hans'] ?? display.en
    if (typeof preferred === 'string' && preferred.trim() !== '') return preferred.trim()
  }
  if (prompt.reason) return prompt.reason
  return '电脑上的 DSH 想执行这个工具操作，需要你确认一次。'
}

/** 拼 `approval/reply`。outcome 只接受白名单里的两个值，其余按拒绝处理（契约要求）。 */
export function buildApprovalReplyFrame(approvalId: unknown, outcome: unknown): ApprovalReplyFrame | undefined {
  const id = typeof approvalId === 'string' ? approvalId.trim() : ''
  if (!id) return undefined
  const decided: ApprovalOutcome = outcome === 'allowed-once' ? 'allowed-once' : outcome === 'delegate' ? 'delegate' : 'rejected'
  if (!APPROVAL_REPLY_OUTCOMES.includes(decided)) return undefined
  return { t: CLIENT_FRAME.APPROVAL_REPLY, approvalId: id, outcome: decided }
}

/**
 * 入队（按 approvalId upsert）。
 *
 * 同一 approvalId 再次到达时**更新**原条目而不是新增：电脑端可能重发同一条 ask
 * （重连/重放），若当成两条，用户答完第一条后第二条会永远挂着。
 */
export function enqueueApproval(list: ApprovalPrompt[], prompt: ApprovalPrompt): ApprovalPrompt[] {
  const current = Array.isArray(list) ? list : []
  const index = current.findIndex(item => item.approvalId === prompt.approvalId)
  const next = index >= 0 ? current.map((item, i) => (i === index ? prompt : item)) : [...current, prompt]
  // 超出上限时丢最老的：新的请求更可能还在等，老的多数已经超时。
  return next.length > MAX_PENDING_APPROVALS ? next.slice(next.length - MAX_PENDING_APPROVALS) : next
}

/** 收到 `approval/resolved`：不论结果（手机/电脑/超时），都把卡片撤掉。 */
export function resolveApproval(list: ApprovalPrompt[], approvalId: unknown): ApprovalPrompt[] {
  const id = typeof approvalId === 'string' ? approvalId : ''
  if (!id) return Array.isArray(list) ? list : []
  const current = Array.isArray(list) ? list : []
  const next = current.filter(item => item.approvalId !== id)
  return next.length === current.length ? current : next
}

/** 裁掉已经过期的请求（电脑端已经交回桌面，卡片必须自己消失，否则永远挂着）。 */
export function pruneExpiredApprovals(list: ApprovalPrompt[], now: number = Date.now()): ApprovalPrompt[] {
  const current = Array.isArray(list) ? list : []
  const next = current.filter(item => !isExpired(item, now))
  return next.length === current.length ? current : next
}

/** 是否已过期（没有 expiresAt 的请求永不过期：契约里它是必填，但老/坏数据不能卡死 UI）。 */
export function isExpired(prompt: ApprovalPrompt, now: number = Date.now()): boolean {
  if (typeof prompt.expiresAt !== 'number' || !Number.isFinite(prompt.expiresAt)) return false
  return prompt.expiresAt <= now
}

/** 剩余毫秒（没有 expiresAt 时 undefined，UI 就不画倒计时）。 */
export function approvalRemainingMs(prompt: ApprovalPrompt, now: number = Date.now()): number | undefined {
  if (typeof prompt.expiresAt !== 'number' || !Number.isFinite(prompt.expiresAt)) return undefined
  return Math.max(0, prompt.expiresAt - now)
}

/** 倒计时文案：`0:42`。剩余为 0 时给 `0:00`（卡片马上会被裁掉）。 */
export function formatApprovalCountdown(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * 手机能不能回答这条请求。
 * 电脑端没声明 approval-v1 时**不要**发 reply（老插件不认识），旧路径由桌面 UI 兜。
 */
export function approvalAvailability(
  online: boolean,
  capabilities: readonly string[] | undefined,
): { ok: true } | { ok: false; error: string; hint: string } {
  if (!online) {
    return {
      ok: false,
      error: '当前离线，没法回答这条请求',
      hint: `电脑端会等 ${Math.round(APPROVAL_TIMEOUT_MS / 1000)} 秒后把提示交回桌面；连上后可以在这里重试。`,
    }
  }
  const list = Array.isArray(capabilities) ? capabilities : []
  if (!list.includes(CAPABILITIES.APPROVAL)) {
    return {
      ok: false,
      error: '电脑端版本较旧，不能由手机回答权限请求',
      hint: '请在电脑上的 DSH 里直接处理这个提示，或把 dsh-openwhale 插件升级后重连。',
    }
  }
  return { ok: true }
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && value !== '') {
    // 纯数字字符串也是 Unix 毫秒（大整数被写成字符串的 JSON 很常见）。
    if (/^\d+$/.test(value)) {
      const numeric = Number(value)
      return Number.isFinite(numeric) ? Math.floor(numeric) : undefined
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
