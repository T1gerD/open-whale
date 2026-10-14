// 离线发送队列（纯逻辑）。
//
// 手机是网络断续的一侧：消息可能刚发出去就断线，而电脑端**没有**去重，
// 所以“重发”必须由这一层决定边界：
//  * 未确认的消息在重连后重发，但同一个 rid 只保留一条；
//  * 每条消息的重试次数有上限，超过就交给用户手动重试（避免断网时无限空转、耗电）；
//  * 断线时“飞行中”的条目退回 pending，否则它们会永远卡住。

export type OutboxState = 'pending' | 'inflight' | 'sent' | 'failed'

export interface OutboxFile {
  name: string
  mime: string
  dataBase64: string
}

export interface OutboxEntry {
  /** 幂等键：与 chat/send 的 rid/callId 相同。 */
  rid: string
  assistantId: string
  callId: string
  text: string
  files?: OutboxFile[]
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
  return {
    ...outbox,
    entries: [...outbox.entries, { ...entry, attempts: 0, state: 'pending' }].slice(-outbox.limit),
  }
}

export function markInflight(outbox: Outbox, rid: string, now: number): Outbox {
  return patch(outbox, rid, entry => ({
    ...entry,
    state: 'inflight',
    attempts: entry.attempts + 1,
    lastAttemptAt: now,
    retryAfter: undefined,
  }))
}

/** 收到 chat/ack：这条消息已经被电脑端接管，从队列里移除（历史在消息表里）。 */
export function markSent(outbox: Outbox, rid: string): Outbox {
  return { ...outbox, entries: outbox.entries.filter(entry => entry.rid !== rid) }
}

export function markFailed(outbox: Outbox, rid: string, error: string, retryAfter?: number): Outbox {
  return patch(outbox, rid, entry => ({ ...entry, state: 'failed', error, retryAfter }))
}

/** 断线：飞行中的条目退回 pending，这样重连后会被重发。 */
export function releaseInflight(outbox: Outbox): Outbox {
  return {
    ...outbox,
    entries: outbox.entries.map(entry =>
      entry.state === 'inflight' ? { ...entry, state: 'pending' as OutboxState } : entry,
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
  const maxAttempts = options.maxAttempts ?? 3
  return outbox.entries
    .filter(entry => entry.state === 'pending')
    .filter(entry => entry.attempts < maxAttempts)
    .filter(entry => entry.retryAfter === undefined || entry.retryAfter <= options.now)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 自动重发已放弃、但用户仍可手动重试的条目。 */
export function exhaustedEntries(outbox: Outbox, maxAttempts: number = 3): OutboxEntry[] {
  return outbox.entries.filter(entry => entry.state === 'failed' || entry.attempts >= maxAttempts)
}

/** 手动重试：清零计数并允许立即重发。 */
export function retryEntry(outbox: Outbox, rid: string): Outbox {
  return patch(outbox, rid, entry => ({ ...entry, state: 'pending', error: undefined, retryAfter: undefined }))
}

export function removeEntry(outbox: Outbox, rid: string): Outbox {
  return { ...outbox, entries: outbox.entries.filter(entry => entry.rid !== rid) }
}

export function getEntry(outbox: Outbox, rid: string): OutboxEntry | undefined {
  return outbox.entries.find(entry => entry.rid === rid)
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
    const entries = parsed.entries.filter(isEntry)
    return { entries, limit: limit ?? parsed.limit ?? DEFAULT_OUTBOX_LIMIT }
  } catch {
    // 队列损坏不该让 App 起不来：丢掉它，用户最多丢一条待发消息。
    return createOutbox(limit)
  }
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<OutboxEntry>
  return typeof entry.rid === 'string' && typeof entry.text === 'string' && typeof entry.assistantId === 'string'
}

function patch(outbox: Outbox, rid: string, update: (entry: OutboxEntry) => OutboxEntry): Outbox {
  let touched = false
  const entries = outbox.entries.map(entry => {
    if (entry.rid !== rid) return entry
    touched = true
    return update(entry)
  })
  return touched ? { ...outbox, entries } : outbox
}
