// 离线发送队列（纯逻辑）。
//
// 手机是网络断续的一侧：消息可能刚发出去就断线，而电脑端**没有**去重，
// 所以“重发”必须由这一层决定边界：
//  * 未确认的消息在重连后重发，但同一个 rid 只保留一条；
//  * 每条消息的重试次数有上限，超过就交给用户手动重试（避免断网时无限空转、耗电）；
//  * 断线时“飞行中”的条目退回 pending，否则它们会永远卡住。

export type OutboxState = 'pending' | 'inflight' | 'sent' | 'failed'

/** 待发送附件：新路径带 uri（分块上传），老路径带 dataBase64（内联兼容）。 */
export interface OutboxFile {
  name: string
  mime: string
  size?: number
  /** 本地文件 URI（expo-document-picker / expo-image-picker）；分块上传用。 */
  uri?: string
  /** 老协议内联附件（仅小文件）。 */
  dataBase64?: string
}

/** 已上传完成、可以放进 chat/send.files 的引用。 */
export interface OutboxUploadRef {
  /** 对应 OutboxEntry.files 里的下标（同一条消息可能有两个同名附件）。 */
  index: number
  uploadId: string
  name: string
  size: number
  mime?: string
}

export interface OutboxEntry {
  /** 幂等键：与 chat/send 的 rid/callId 相同（v2.2.0 同时作为 msgId 发出去）。 */
  rid: string
  assistantId: string
  callId: string
  text: string
  /** 电脑端幂等键；老实现缺省时回落到 rid。 */
  msgId?: string
  /** 协作模式下发送者昵称（电脑端据此在别的设备上显示是谁发的）。 */
  speaker?: string
  files?: OutboxFile[]
  /** 已经上传完成的附件（重发时直接引用 uploadId，不重复上传）。 */
  uploads?: OutboxUploadRef[]
  createdAt: number
  attempts: number
  state: OutboxState
  lastAttemptAt?: number
  /** 下次允许重发的时间（失败后按退避设置）。 */
  retryAfter?: number
  error?: string
}

export interface Outbox {
  entries: OutboxEntry[]
  limit: number
}

export const DEFAULT_OUTBOX_LIMIT = 200

/**
 * 自动重发上限。
 *
 * 原先是 3，而且计数语义是"只要写进 socket 就算一次"，两者叠加非常脆弱：
 * 连接一抖动，同一条消息几秒内就能把 3 次机会耗光，之后**永远不再自动重发**，
 * 用户看到的现象就是「消息发出去十几分钟才收到回复」（要等某次手动重试或重启）。
 *
 * 现在：上限提高到 8，且计数只统计"未获确认的发送"（见 releaseInflight）。
 */
export const DEFAULT_MAX_ATTEMPTS = 8

export function createOutbox(limit: number = DEFAULT_OUTBOX_LIMIT): Outbox {
  return { entries: [], limit: Math.max(1, Math.floor(limit)) }
}

/** 入队。相同 rid 视为同一条消息（用户连点发送按钮时不会造出两条）。 */
export function enqueue(outbox: Outbox, entry: Omit<OutboxEntry, 'attempts' | 'state'>): Outbox {
  const existing = outbox.entries.find(item => item.rid === entry.rid)
  if (existing) {
    return {
      ...outbox,
      entries: outbox.entries.map(item =>
        item.rid === entry.rid ? { ...item, ...entry, attempts: item.attempts, state: item.state } : item,
      ),
    }
  }
  const created: OutboxEntry = { ...entry, attempts: 0, state: 'pending' }
  return {
    ...outbox,
    entries: [...outbox.entries, created].slice(-outbox.limit),
  }
}

export function markInflight(outbox: Outbox, rid: string, now: number): Outbox {
  return patch(outbox, rid, entry => ({
    ...entry,
    state: 'inflight',
    lastAttemptAt: now,
    retryAfter: undefined,
  }))
}

/** 收到 chat/ack：这条消息已经被电脑端接管，从队列里移除（历史在消息表里）。 */
export function markSent(outbox: Outbox, key: string): Outbox {
  return { ...outbox, entries: outbox.entries.filter(entry => !matches(entry, key)) }
}

/**
 * 记录已经上传完成的附件引用：重发时直接带 uploadId，不重复上传。
 * 这也是「一张图只上传一次」的保证（上传成功后消息可能还要等网络/重试）。
 */
export function markUploaded(outbox: Outbox, rid: string, uploads: OutboxUploadRef[]): Outbox {
  return patch(outbox, rid, entry => ({
    ...entry,
    uploads: dedupeUploads([...(entry.uploads ?? []), ...uploads]),
  }))
}

function dedupeUploads(list: OutboxUploadRef[]): OutboxUploadRef[] {
  const seen = new Set<string>()
  const out: OutboxUploadRef[] = []
  for (const item of list) {
    if (!item || typeof item.uploadId !== 'string' || seen.has(item.uploadId)) continue
    seen.add(item.uploadId)
    out.push({ ...item, index: typeof item.index === 'number' ? item.index : 0 })
  }
  return out
}

export function markFailed(outbox: Outbox, key: string, error: string, retryAfter?: number): Outbox {
  return patch(outbox, key, entry => ({ ...entry, state: 'failed', error, retryAfter }))
}

/**
 * 断线：飞行中的条目退回 pending，这样重连后会被重发。
 *
 * **同时 `attempts + 1`**：计数语义是"这条消息有过几次**未获确认**的发送"。
 * 以前在 `markInflight` 里就自增，结果是"只要写进 socket 就算一次尝试"，
 * 而抖动时 socket 可能已经是半死的，消息根本没被电脑端处理，
 * 3 次抖动就能把重试机会烧光，消息永远卡在队列里——
 * 这正是「消息发了十几分钟才收到回复」的直接原因。
 */
export function releaseInflight(outbox: Outbox): Outbox {
  return {
    ...outbox,
    entries: outbox.entries.map(entry =>
      entry.state === 'inflight'
        ? { ...entry, state: 'pending' as OutboxState, attempts: entry.attempts + 1 }
        : entry,
    ),
  }
}

/**
 * 重连后可以重发的条目（按入队顺序，保证聊天顺序）。
 * 只考虑 `pending`：`inflight` 表示这条消息在**当前**连接上已经发出去了，正在等 ack，
 * 断线时调用方必须先 `releaseInflight` 把它退回 pending，重发才是安全的。
 * @param maxAttempts 自动重发上限，超过后由用户在聊天页手动点“重试”。
 */
export function resendableEntries(
  outbox: Outbox,
  options: { now: number; maxAttempts?: number } = { now: Date.now() },
): OutboxEntry[] {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  return outbox.entries
    .filter(entry => entry.state === 'pending')
    .filter(entry => entry.attempts < maxAttempts)
    .filter(entry => entry.retryAfter === undefined || entry.retryAfter <= options.now)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 自动重发已放弃、但用户仍可手动重试的条目。 */
export function exhaustedEntries(outbox: Outbox, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): OutboxEntry[] {
  return outbox.entries.filter(entry => entry.state === 'failed' || entry.attempts >= maxAttempts)
}

/**
 * 手动重试：**真正清零计数**并允许立即重发。
 *
 * 以前这里只把状态改回 pending，忘记重置 `attempts`，
 * 而 `resendableEntries` 会用 `attempts < maxAttempts` 过滤，
 * 于是"重试"按钮对已经放弃的条目**完全无效**——点了也不发。
 */
export function retryEntry(outbox: Outbox, key: string): Outbox {
  return patch(outbox, key, entry => ({
    ...entry,
    state: 'pending',
    attempts: 0,
    error: undefined,
    retryAfter: undefined,
  }))
}

export function removeEntry(outbox: Outbox, key: string): Outbox {
  return { ...outbox, entries: outbox.entries.filter(entry => !matches(entry, key)) }
}

export function getEntry(outbox: Outbox, key: string): OutboxEntry | undefined {
  return outbox.entries.find(entry => matches(entry, key))
}

export function outboxSize(outbox: Outbox): number {
  return outbox.entries.length
}

export function pendingCount(outbox: Outbox): number {
  return outbox.entries.filter(entry => entry.state === 'pending' || entry.state === 'inflight').length
}

/**
 * 裁剪：超限时先丢已发送的（正常流程里它们已经被 ack 移除），
 * 再丢最老的已放弃条目；**永不**为了腾地方丢掉还在 pending 的消息。
 */
export function pruneOutbox(outbox: Outbox): Outbox {
  if (outbox.entries.length <= outbox.limit) return outbox
  const doomed = new Set<string>()
  const overflow = outbox.entries.length - outbox.limit
  const candidates = [...outbox.entries]
    .filter(entry => entry.state === 'sent' || entry.state === 'failed')
    .sort((a, b) => a.createdAt - b.createdAt)
  for (let i = 0; i < overflow && i < candidates.length; i++) doomed.add(candidates[i]!.rid)
  if (doomed.size === 0) return outbox
  return { ...outbox, entries: outbox.entries.filter(entry => !doomed.has(entry.rid)) }
}

/** 序列化用（入 SQLite / 内存快照），保持可 JSON 往返。 */
export function serializeOutbox(outbox: Outbox): string {
  return JSON.stringify(outbox)
}

export function deserializeOutbox(text: string | null | undefined, limit?: number): Outbox {
  if (!text) return createOutbox(limit)
  try {
    const parsed = JSON.parse(text) as Partial<Outbox>
    if (!parsed || !Array.isArray(parsed.entries)) return createOutbox(limit)
    const entries = parsed.entries.filter(isEntry).map(normalizeEntry)
    return { entries, limit: limit ?? parsed.limit ?? DEFAULT_OUTBOX_LIMIT }
  } catch {
    // 队列损坏不该让 App 起不来：丢掉它，用户最多丢一条待发消息。
    return createOutbox(limit)
  }
}

function isEntry(value: unknown): value is Partial<OutboxEntry> & { rid: string; text: string; assistantId: string } {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<OutboxEntry>
  return typeof entry.rid === 'string' && typeof entry.text === 'string' && typeof entry.assistantId === 'string'
}

const OUTBOX_STATES: readonly OutboxState[] = ['pending', 'inflight', 'sent', 'failed']

/** 反序列化时把脏字段收敛成合法值（历史队列可能来自老版本/被截断）。 */
function normalizeEntry(entry: Partial<OutboxEntry> & { rid: string; text: string; assistantId: string }): OutboxEntry {
  return {
    rid: entry.rid,
    assistantId: entry.assistantId,
    callId: typeof entry.callId === 'string' ? entry.callId : entry.rid,
    text: entry.text,
    msgId: typeof entry.msgId === 'string' ? entry.msgId : undefined,
    speaker: typeof entry.speaker === 'string' ? entry.speaker : undefined,
    files: Array.isArray(entry.files) ? entry.files : undefined,
    uploads: Array.isArray(entry.uploads) ? entry.uploads : undefined,
    createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    attempts: typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) ? entry.attempts : 0,
    state: OUTBOX_STATES.includes(entry.state as OutboxState) ? (entry.state as OutboxState) : 'pending',
    lastAttemptAt: typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : undefined,
    retryAfter: typeof entry.retryAfter === 'number' ? entry.retryAfter : undefined,
    error: typeof entry.error === 'string' ? entry.error : undefined,
  }
}

function patch(outbox: Outbox, key: string, update: (entry: OutboxEntry) => OutboxEntry): Outbox {
  let touched = false
  const entries = outbox.entries.map(entry => {
    if (!matches(entry, key)) return entry
    touched = true
    return update(entry)
  })
  return touched ? { ...outbox, entries } : outbox
}

/** 队列条目按 rid 或 msgId 寻址（chat/ack 可能只带其中一个）。 */
function matches(entry: OutboxEntry, key: string): boolean {
  if (!key) return false
  return entry.rid === key || entry.msgId === key
}
