// 会话选择器（2.3.0）的纯逻辑：帧编码、会话列表归一化、相对时间、可用性判定。
//
// 为什么要单独一个模块：这条链路（列表 → 选中 → 快照替换整页消息）是 v2.3.0 的
// 核心新功能，而它最容易出错的地方全是**纯逻辑**——帧字段拼错、列表里混进坏数据、
// 离线时还发请求。放在这里就能在没有 Expo、没有设备的机器上测掉。
//
// 帧名与字段一律以 `packages/protocol/src/index.mjs`（已冻结）为准。

import { CAPABILITIES, CLIENT_FRAME, SESSION_LIST_LIMIT, SESSION_WATCH_LIMIT } from './frames.mts'

/** 电脑上的一个 DSH 会话，字段与 protocol 的 `SessionSummary` typedef 一致。 */
export interface SessionSummary {
  /** DSH 会话 id（`session/select` 的入参）。 */
  id: string
  /** 日志里的标题；没有标题时电脑端会给「新会话」这类兜底文案。 */
  title: string
  /** 会话工作目录（可缺省）。 */
  cwd?: string
  /** Unix 毫秒。 */
  createdAt: number
  /** Unix 毫秒；电脑端拿不到事件时间时会省略。 */
  updatedAt?: number
  /** 电脑上现在有 agent 在跑。 */
  live: boolean
  /** 这台手机当前绑定的那个会话。 */
  current?: boolean
}

/** `sessions` 帧归一化后的本地视图（进 reducer 状态）。 */
export interface SessionListState {
  /** 这台手机当前绑定的会话 id（电脑端权威）。 */
  current?: string
  /** 最新的在前；电脑端已按 createdAt 倒序，这里只做清洗，不重排。 */
  sessions: SessionSummary[]
  /** 电脑上的会话比这次发来的多。 */
  truncated: boolean
  /** 收到这份列表的本地时间（UI 用来显示“刚刚刷新”）。 */
  fetchedAt: number
}

export interface SessionListFrame {
  t: 'session/list'
  rid: string
}

export interface SessionSelectFrame {
  t: 'session/select'
  rid: string
  sessionId: string
}

export interface SessionCreateFrame {
  t: 'session/create'
  rid: string
}

export interface SessionWatchFrame {
  t: 'session/watch'
  sessionIds: string[]
}

export interface SessionSnapshotFrame {
  t: 'session/snapshot'
  rid: string
  sessionId: string
}

/** 拼 `session/list`。rid 由调用方生成并保留，用来对回包。 */
export function buildSessionListFrame(rid: string): SessionListFrame {
  return { t: CLIENT_FRAME.SESSION_LIST, rid }
}

/** 拼 `session/select`。sessionId 为空时不产生帧（返回 undefined，让 UI 直接提示）。 */
export function buildSessionSelectFrame(rid: string, sessionId: unknown): SessionSelectFrame | undefined {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return undefined
  return { t: CLIENT_FRAME.SESSION_SELECT, rid, sessionId: id }
}

/** 拼 `session/create`（不带参数：工作目录由电脑端的设置决定）。 */
export function buildSessionCreateFrame(rid: string): SessionCreateFrame {
  return { t: CLIENT_FRAME.SESSION_CREATE, rid }
}

/**
 * 拼 `session/watch`（2.4.0）：把"除活跃会话以外、要一直收事件的标签"告诉电脑端。
 *
 * 帧语义是**整体替换**，所以调用方必须每次传全量，而不是增量。三个清洗步骤都很重要：
 *  1. 去掉空串/重复（重复 id 会让电脑端订阅列表里出现两条）；
 *  2. 截断到 `SESSION_WATCH_LIMIT`——超出的部分电脑端会直接忽略，与其让用户以为
 *     "这个标签也在跑"不如在这里就截断，和电脑端的上限保持一致；
 *  3. 空列表是合法的：它就是"取消全部后台订阅"。
 */
export function buildSessionWatchFrame(sessionIds: unknown): SessionWatchFrame {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const raw of Array.isArray(sessionIds) ? sessionIds : []) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= SESSION_WATCH_LIMIT) break
  }
  return { t: CLIENT_FRAME.SESSION_WATCH, sessionIds: ids }
}

/** 拼 `session/snapshot`：只取某一个标签的状态，不改变 `chat/send` 的目标会话。 */
export function buildSessionSnapshotFrame(rid: string, sessionId: unknown): SessionSnapshotFrame | undefined {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return undefined
  return { t: CLIENT_FRAME.SESSION_SNAPSHOT, rid, sessionId: id }
}

/**
 * 把收到的 `sessions` 帧洗成视图。
 * 返回 undefined 表示“这不是一份可用的列表”，调用方应保持原有列表不变：
 * 空数组是合法结果（电脑上真的一个会话都没有），不能和解析失败混为一谈。
 */
export function normalizeSessionsFrame(
  frame: { current?: unknown; sessions?: unknown; truncated?: unknown },
  now: number = Date.now(),
): SessionListState | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  if (!Array.isArray(frame.sessions)) return undefined
  const sessions: SessionSummary[] = []
  const seen = new Set<string>()
  for (const raw of frame.sessions.slice(0, SESSION_LIST_LIMIT)) {
    const summary = normalizeSessionSummary(raw)
    if (!summary || seen.has(summary.id)) continue
    seen.add(summary.id)
    sessions.push(summary)
  }
  const current = typeof frame.current === 'string' && frame.current !== '' ? frame.current : undefined
  // 电脑端可能漏标 `current`（刚切换的一瞬间）：这里按 frame.current 补上，
  // 免得 UI 上没有任何一行是“当前”，用户以为选错了。
  const withCurrent = sessions.map(item => (current !== undefined && item.id === current ? { ...item, current: true } : item))
  return {
    current,
    sessions: withCurrent,
    truncated: frame.truncated === true,
    fetchedAt: now,
  }
}

/** 单条会话的归一化：id/title 缺失就丢弃（宁可不显示，也不显示一条点不动的坏行）。 */
export function normalizeSessionSummary(value: unknown): SessionSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as {
    id?: unknown
    title?: unknown
    cwd?: unknown
    createdAt?: unknown
    updatedAt?: unknown
    live?: unknown
    current?: unknown
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return undefined
  const createdAt = toMillis(raw.createdAt) ?? 0
  const updatedAt = toMillis(raw.updatedAt)
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : '新会话'
  const summary: SessionSummary = {
    id,
    title,
    createdAt,
    live: raw.live === true,
  }
  if (typeof raw.cwd === 'string' && raw.cwd !== '') summary.cwd = raw.cwd
  if (updatedAt !== undefined) summary.updatedAt = updatedAt
  if (raw.current === true) summary.current = true
  return summary
}

/**
 * 会话选择器是否可用。
 *
 * 离线时**不发** `session/list`（发出去只会石沉大海，用户还以为是电脑没会话），
 * 直接给一句可操作的话；电脑端不支持 `sessions-v1` 时也不能发——老插件不认识
 * 这些帧，等于是个永远不会有回包的请求。
 */
export function sessionAvailability(
  online: boolean,
  capabilities: readonly string[] | undefined,
): { ok: true } | { ok: false; error: string; hint: string } {
  if (!online) {
    return {
      ok: false,
      error: '当前离线，暂时不能切换会话',
      hint: '等右上角显示“在线”后再打开会话列表；现在发的消息仍会排队，连上后自动发出。',
    }
  }
  const list = Array.isArray(capabilities) ? capabilities : []
  if (!list.includes(CAPABILITIES.SESSIONS)) {
    return {
      ok: false,
      error: '电脑端版本较旧，不支持在手机上切换会话',
      hint: '请在电脑上把 dsh-openwhale 插件升级到这个版本后重连；旧的会话仍可继续使用。',
    }
  }
  return { ok: true }
}

/** 列表里某条会话的展示标题（用于标题栏那一颗胶囊）。 */
export function sessionTitleOf(list: SessionListState | undefined, sessionId: string | undefined): string | undefined {
  if (!list) return undefined
  const id = sessionId ?? list.current
  if (!id) return undefined
  const hit = list.sessions.find(session => session.id === id)
  return hit?.title
}

/** 当前会话是否在列表里活着（用于「继续这个会话」之类的提示）。 */
export function sessionIsLive(list: SessionListState | undefined, sessionId: string | undefined): boolean {
  const id = sessionId ?? list?.current
  if (!list || !id) return false
  return list.sessions.find(session => session.id === id)?.live === true
}

/**
 * 相对时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / M 月 D 日。
 *
 * 刻意不用 Intl.RelativeTimeFormat：Hermes 上不一定有完整时区数据，而这里的文案
 * 就四个分支，手写比依赖运行时更可控（与列表页的 formatRelative 保持同一语气）。
 */
export function relativeSessionTime(at: number | undefined, now: number = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
  const diff = now - at
  if (!Number.isFinite(diff)) return ''
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(at)
  const current = new Date(now)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === current.toDateString()) return `今天 ${time}`
  const yesterday = new Date(now - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  if (date.getFullYear() !== current.getFullYear()) {
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
  }
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 会话的一行副标题：相对时间 + 目录名（电脑端没给 cwd 就只留时间）。 */
export function sessionSubtitle(session: SessionSummary, now: number = Date.now()): string {
  const when = relativeSessionTime(session.updatedAt ?? session.createdAt, now)
  const dir = cwdTail(session.cwd)
  if (when && dir) return `${when} · ${dir}`
  return when || dir || ''
}

/** 工作目录的最后一段（`C:\work\demo` → `demo`），兼容正反斜杠。 */
export function cwdTail(cwd: string | undefined): string {
  const value = typeof cwd === 'string' ? cwd.trim() : ''
  if (!value) return ''
  const parts = value.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value === 'string' && value !== '') {
    // 纯数字字符串也是 Unix 毫秒（有些 JSON 序列化会把大整数写成字符串）。
    if (/^\d+$/.test(value)) {
      const numeric = Number(value)
      return Number.isFinite(numeric) ? Math.floor(numeric) : undefined
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
