// 会话标签页容器（2.4.0 的核心纯逻辑）。
//
// 为什么要有这一层：`ChatState` 是**一个会话**的完整状态（消息、游标、审批、上传），
// 而 v2.4.0 要让多个会话同时活着。于是把 ChatState 原样放进一个容器：
//
//   tabs: string[]                    已打开的标签，顺序 = 打开顺序（稳定，不按活跃度重排）
//   activeSessionId: string           当前显示的标签（'' = 还没有会话的占位状态）
//   chats: Record<sessionId, ChatState>  每个标签自己的消息/游标/审批
//   activity: Record<sessionId, {typing, unread, lastAt}>  标签条要画的东西
//
// 三条规则都在这里，且都能在电脑上（没有 Expo、没有设备）测掉：
//  1. **帧路由**：带 `sessionId` 的帧进 `chats[sessionId]`；没有的回落到活跃会话。
//     只有"需要知道文件在哪条对话里"的 file/* 帧例外，它们按 fileId 反查归属。
//  2. **未读/运行**：非当前标签收到 `chat/echo`/`chat/message` 未读 +1；`chat/typing`
//     置 typing=true，`chat/done`/`chat/error` 置 false；切过去时未读清零。
//  3. **持久化**：只存 `{tabs, activeSessionId}`（消息按 session_id 分别落库），
//     `session/list` 里已经消失的 id 打开时丢弃并给出提示，绝不静默留一个死标签。
//
// 这一层不做 I/O：发 `session/watch`、发 `session/snapshot`、写 SQLite 全在服务层。

import { SESSION_WATCH_LIMIT } from './frames.mts'
import { emptyChatState, reduceChat, type ChatEffect, type ChatEvent, type ChatState } from './reducer.mts'
import { normalizeSessionsFrame, type SessionListState } from './sessions.mts'

/** 一个标签的活动摘要（标签条直接渲染它）。 */
export interface SessionActivity {
  /** 电脑端正在回答（chat/typing 且还没有 done/error）。 */
  typing: boolean
  /** 这个标签不是当前标签期间收到的用户/助手消息条数。 */
  unread: number
  /** 最近一次收到该会话事件的时间（ms）。 */
  lastAt: number
}

/** 多会话容器。字段与 `docs/v2.4.0/CONTRACT.md` §3 一致。 */
export interface TabsState {
  assistantId: string
  tabs: string[]
  activeSessionId: string
  chats: Record<string, ChatState>
  activity: Record<string, SessionActivity>
  /** 电脑端会话列表（「全部会话」面板的数据源，也是丢弃死标签的依据）。 */
  sessionList?: SessionListState
  /** 恢复时发现已经不在电脑上的标签 id（UI 给一句提示后清掉）。 */
  droppedTabs: string[]
}

/** 标签条上的一行（UI 只读它，不自己算未读/运行状态）。 */
export interface TabView {
  id: string
  title: string
  active: boolean
  unread: number
  typing: boolean
  /** 电脑端此刻有 agent 在跑（来自 session/list 的 live）。 */
  live: boolean
  /** 这个标签里排队的审批数量（非当前标签也要在标签条上可见）。 */
  approvals: number
  lastAt: number
}

/** 本地事件：用户对标签条的操作。没有网络副作用，全部同步完成。 */
export type TabsEvent =
  | { t: 'tabs/open'; sessionId: string; at?: number }
  | { t: 'tabs/activate'; sessionId: string; at?: number }
  | { t: 'tabs/close'; sessionId: string; at?: number }
  | { t: 'tabs/restore'; tabs?: unknown; activeSessionId?: unknown; fallbackSessionId?: unknown; at?: number }
  | { t: 'tabs/prune'; available: string[]; at?: number }
  | { t: 'tabs/adopt'; sessionId: string; at?: number }
  | { t: 'tabs/notice-clear'; at?: number }
  | { t: 'tabs/tick'; at?: number }

export type TabsInput = ChatEvent | TabsEvent

/** 容器 reducer 的副作用：每条都带上"属于哪个会话"，服务层据此落库/写盘。 */
export type TabsEffect = ChatEffect & { sessionId: string }

export interface TabsReduceResult {
  state: TabsState
  effects: TabsEffect[]
  /** 这次事件实际改动的会话 id（服务层只对它们做消息/传输持久化）。 */
  touched: string[]
  /** 事件被路由到的会话 id（没有可路由目标时 undefined）。 */
  target?: string
  /** 活跃标签是否发生了变化（服务层据此发 session/select + session/watch）。 */
  activeChanged: boolean
}

/** 没有会话时的占位 key：保留 v2.3.0 的"单会话"行为直到拿到第一个 sessionId。 */
export const PLACEHOLDER_SESSION = ''

const NO_ACTIVITY: SessionActivity = { typing: false, unread: 0, lastAt: 0 }

export function emptyTabs(assistantId: string): TabsState {
  const chat = emptyChatState(assistantId)
  return {
    assistantId,
    tabs: [],
    activeSessionId: PLACEHOLDER_SESSION,
    chats: { [PLACEHOLDER_SESSION]: chat },
    activity: { [PLACEHOLDER_SESSION]: { ...NO_ACTIVITY } },
    sessionList: undefined,
    droppedTabs: [],
  }
}

/** 当前标签的 ChatState（永远有值：没有会话时返回占位那个）。 */
export function activeChat(state: TabsState): ChatState {
  return state.chats[state.activeSessionId] ?? Object.values(state.chats)[0] ?? emptyChatState(state.assistantId)
}

export function chatOf(state: TabsState, sessionId: string | undefined): ChatState | undefined {
  if (sessionId === undefined) return undefined
  return state.chats[sessionId]
}

export function activityOf(state: TabsState, sessionId: string | undefined): SessionActivity {
  if (sessionId === undefined) return NO_ACTIVITY
  return state.activity[sessionId] ?? NO_ACTIVITY
}

/** 所有标签的未读总和（助理列表页角标用）。 */
export function totalUnread(state: TabsState): number {
  let sum = 0
  for (const [id, activity] of Object.entries(state.activity)) {
    if (id === state.activeSessionId) continue
    sum += activity.unread
  }
  return sum
}

/** 除活跃会话外，需要 `session/watch` 的会话 id（已截断到协议上限）。 */
export function watchSessionIds(state: TabsState, limit: number = SESSION_WATCH_LIMIT): string[] {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SESSION_WATCH_LIMIT
  return state.tabs.filter(id => id !== state.activeSessionId && id !== PLACEHOLDER_SESSION).slice(0, max)
}

/** 标签标题：优先电脑端会话列表里的标题，退回本地缓存的标题，最后才用 id。 */
export function tabTitle(state: TabsState, sessionId: string): string {
  const fromList = state.sessionList?.sessions.find(session => session.id === sessionId)?.title
  if (fromList) return fromList
  const cached = state.chats[sessionId]?.sessionId === sessionId ? state.chats[sessionId]?.title : undefined
  if (typeof cached === 'string' && cached.trim() !== '') return cached.trim()
  return sessionId === PLACEHOLDER_SESSION ? '新会话' : sessionId.slice(0, 8)
}

/** 标签条的渲染模型（顺序 = 打开顺序）。 */
export function tabStripModel(state: TabsState): TabView[] {
  return state.tabs.map(id => {
    const activity = activityOf(state, id)
    const chat = state.chats[id]
    const listed = state.sessionList?.sessions.find(session => session.id === id)
    return {
      id,
      title: tabTitle(state, id),
      active: id === state.activeSessionId,
      unread: id === state.activeSessionId ? 0 : activity.unread,
      typing: activity.typing,
      live: listed?.live === true,
      approvals: chat?.approvals.length ?? 0,
      lastAt: activity.lastAt,
    }
  })
}

/** 其它标签里排队的待办总数（审批 + 提问；当前标签自己的卡片会直接显示，不算进来）。 */
export function pendingApprovalsElsewhere(state: TabsState): number {
  let sum = 0
  for (const [id, chat] of Object.entries(state.chats)) {
    if (id === state.activeSessionId) continue
    sum += (chat?.approvals.length ?? 0) + (chat?.questions.length ?? 0)
  }
  return sum
}

/** 某个审批属于哪个标签（回答时要把 resolved 送进对的会话）。 */
export function sessionOfApproval(state: TabsState, approvalId: string): string | undefined {
  for (const [id, chat] of Object.entries(state.chats)) {
    if (chat?.approvals.some(prompt => prompt.approvalId === approvalId)) return id
  }
  return undefined
}

/** 某个提问属于哪个标签（回答时要把 resolved 送进对的会话）。 */
export function sessionOfQuestion(state: TabsState, questionId: string): string | undefined {
  for (const [id, chat] of Object.entries(state.chats)) {
    if (chat?.questions.some(prompt => prompt.questionId === questionId)) return id
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 标签操作（纯函数）
// ---------------------------------------------------------------------------

/** 打开一个标签（已存在就原样返回，不激活）。 */
export function openTab(state: TabsState, sessionId: unknown, at: number = Date.now()): TabsState {
  const id = normalizeId(sessionId)
  if (!id) return state
  if (state.tabs.includes(id)) return state
  return {
    ...state,
    tabs: [...state.tabs, id],
    chats: { ...state.chats, [id]: state.chats[id] ?? chatFor(state, id) },
    activity: { ...state.activity, [id]: state.activity[id] ?? { ...NO_ACTIVITY, lastAt: at } },
  }
}

/** 切换标签：本地已有消息先渲染，未读清零由这里保证。 */
export function activateTab(state: TabsState, sessionId: unknown, at: number = Date.now()): TabsState {
  const id = normalizeId(sessionId)
  if (!id) return state
  // 占位标签第一次拿到真实会话 id：把它"改名"成真实 id，消息不丢。
  const renamed = state.activeSessionId === PLACEHOLDER_SESSION && !state.chats[id] ? adoptSession(state, id, at) : state
  const opened = renamed.tabs.includes(id) ? renamed : openTab(renamed, id, at)
  if (opened.activeSessionId === id) {
    return clearUnread(opened, id)
  }
  const cleared = clearUnread(opened, id)
  return { ...cleared, activeSessionId: id }
}

/** 关闭标签：只关本地标签；关的是当前标签就切到相邻的（优先左边）。 */
export function closeTab(state: TabsState, sessionId: unknown, at: number = Date.now()): TabsState {
  const id = normalizeId(sessionId)
  if (!id) return state
  const index = state.tabs.indexOf(id)
  if (index < 0) return state
  const tabs = state.tabs.filter(item => item !== id)
  const chats = { ...state.chats }
  const activity = { ...state.activity }
  delete chats[id]
  delete activity[id]
  let activeSessionId = state.activeSessionId
  if (activeSessionId === id) {
    // 相邻规则：先看左边，再看右边；都没有就回到占位状态。
    activeSessionId = tabs[Math.max(0, index - 1)] ?? PLACEHOLDER_SESSION
    if (activeSessionId === PLACEHOLDER_SESSION) {
      chats[PLACEHOLDER_SESSION] = chats[PLACEHOLDER_SESSION] ?? emptyChatState(state.assistantId)
      activity[PLACEHOLDER_SESSION] = activity[PLACEHOLDER_SESSION] ?? { ...NO_ACTIVITY, lastAt: at }
    }
  }
  const next: TabsState = { ...state, tabs, chats, activity, activeSessionId }
  return activeSessionId === PLACEHOLDER_SESSION ? next : clearUnread(next, activeSessionId)
}

/**
 * 从持久化数据恢复（启动时调用）。
 * `fallbackSessionId` 是助理记录里的绑定会话（v2.3.0 的数据没有 tabs 列）：
 * 老用户升级上来时它保证"当前会话"还在，而不是打开一个空标签条。
 */
export function restoreTabs(
  assistantId: string,
  meta: { tabs?: unknown; activeSessionId?: unknown } | undefined,
  fallbackSessionId?: string,
): TabsState {
  const wanted = sanitizeIdList(meta?.tabs)
  const fallback = normalizeId(fallbackSessionId)
  const tabs = wanted.length > 0 ? wanted : fallback ? [fallback] : []
  const preferred = normalizeId(meta?.activeSessionId)
  const active = preferred && tabs.includes(preferred) ? preferred : fallback && tabs.includes(fallback) ? fallback : tabs[0] ?? PLACEHOLDER_SESSION
  let state: TabsState = {
    ...emptyTabs(assistantId),
    tabs,
    activeSessionId: active,
    chats: {},
    activity: {},
  }
  for (const id of tabs) {
    state = {
      ...state,
      chats: { ...state.chats, [id]: chatFor(state, id) },
      activity: { ...state.activity, [id]: { ...NO_ACTIVITY } },
    }
  }
  if (!state.chats[PLACEHOLDER_SESSION]) {
    state = {
      ...state,
      chats: { ...state.chats, [PLACEHOLDER_SESSION]: emptyChatState(assistantId) },
      activity: { ...state.activity, [PLACEHOLDER_SESSION]: { ...NO_ACTIVITY } },
    }
  }
  if (active !== PLACEHOLDER_SESSION && !state.chats[active]) {
    state = { ...state, chats: { ...state.chats, [active]: chatFor(state, active) }, activity: { ...state.activity, [active]: { ...NO_ACTIVITY } } }
  }
  return state
}

/** 丢掉 `session/list` 里已经不存在的标签（应用重启后电脑上的会话被删了）。 */
export function pruneTabs(state: TabsState, available: readonly unknown[], at: number = Date.now()): TabsState {
  const keep = new Set<string>()
  for (const raw of available) {
    const id = normalizeId(raw)
    if (id) keep.add(id)
  }
  if (keep.size === 0) return state
  const dropped = state.tabs.filter(id => id !== PLACEHOLDER_SESSION && !keep.has(id))
  if (dropped.length === 0) return state
  let next = state
  for (const id of dropped) next = closeTab(next, id, at)
  return { ...next, droppedTabs: unique([...state.droppedTabs, ...dropped]) }
}

export function dismissTabsNotice(state: TabsState): TabsState {
  return state.droppedTabs.length === 0 ? state : { ...state, droppedTabs: [] }
}

/** 把占位标签换成真实会话 id（第一次拿到 sessionId 时调用）。 */
export function adoptSession(state: TabsState, sessionId: unknown, at: number = Date.now()): TabsState {
  const id = normalizeId(sessionId)
  if (!id) return state
  if (state.tabs.includes(id)) {
    return { ...state, activeSessionId: state.activeSessionId === PLACEHOLDER_SESSION ? id : state.activeSessionId }
  }
  const placeholderChat = state.chats[PLACEHOLDER_SESSION]
  const chats = { ...state.chats }
  const activity = { ...state.activity }
  if (placeholderChat && placeholderChat.messages.length > 0 && !state.tabs.includes(id)) {
    chats[id] = { ...placeholderChat, sessionId: id }
    delete chats[PLACEHOLDER_SESSION]
    activity[id] = activity[PLACEHOLDER_SESSION] ?? { ...NO_ACTIVITY }
    delete activity[PLACEHOLDER_SESSION]
  } else {
    chats[id] = chatFor(state, id)
    activity[id] = { ...NO_ACTIVITY, lastAt: at }
  }
  const tabs = state.tabs.filter(item => item !== PLACEHOLDER_SESSION)
  return {
    ...state,
    tabs: [...tabs, id],
    activeSessionId: state.activeSessionId === PLACEHOLDER_SESSION ? id : state.activeSessionId,
    chats,
    activity,
  }
}

// ---------------------------------------------------------------------------
// 路由：一条事件 → 一个会话的 ChatState
// ---------------------------------------------------------------------------

/**
 * 容器 reducer。
 *
 * 与 `reduceChat` 的关系：单个会话的语义**完全**交给 reducer，这里只负责
 * "这条事件属于哪个标签"以及"标签条上的未读/运行要不要变"。
 */
export function routeEvent(state: TabsState, event: TabsInput, now: number = Date.now()): TabsReduceResult {
  const at = eventAt(event, now)
  switch (event.t) {
    case 'tabs/open': {
      const next = openTab(state, event.sessionId, at)
      return done(state, next, [], { activeChanged: false })
    }
    case 'tabs/activate': {
      const next = activateTab(state, event.sessionId, at)
      return done(state, next, [], { activeChanged: next.activeSessionId !== state.activeSessionId })
    }
    case 'tabs/close': {
      const next = closeTab(state, event.sessionId, at)
      return done(state, next, [], { activeChanged: next.activeSessionId !== state.activeSessionId })
    }
    case 'tabs/adopt': {
      const next = adoptSession(state, event.sessionId, at)
      return done(state, next, [], { activeChanged: next.activeSessionId !== state.activeSessionId })
    }
    case 'tabs/restore': {
      const next = restoreTabs(state.assistantId, { tabs: event.tabs, activeSessionId: event.activeSessionId }, normalizeId(event.fallbackSessionId))
      return done(state, next, [], { activeChanged: next.activeSessionId !== state.activeSessionId })
    }
    case 'tabs/prune': {
      const next = pruneTabs(state, event.available, at)
      return done(state, next, [], { activeChanged: next.activeSessionId !== state.activeSessionId })
    }
    case 'tabs/notice-clear':
      return done(state, dismissTabsNotice(state), [], { activeChanged: false })
    case 'tabs/tick':
      return tickApprovals(state, at)
    case 'sessions': {
      // 列表与标签条是两份数据：列表只影响标题/运行状态，以及"哪些标签已经不存在"。
      const list = normalizeSessionsFrame(event, at)
      if (!list) return done(state, state, [], { activeChanged: false })
      const withList: TabsState = { ...state, sessionList: list }
      const pruned = pruneTabs(withList, list.sessions.map(session => session.id), at)
      return done(state, pruned, [], { activeChanged: pruned.activeSessionId !== state.activeSessionId })
    }
    case 'session/selected': {
      if (event.ok === false) {
        // 失败要如实说清楚：交给 reducer 在**当前**标签里留一条系统提示（不跟着
        // 失败帧里的 sessionId 走，否则错误可能被路由到一个不存在的标签而丢掉）。
        return routeChatEvent(state, event as ChatEvent, at, state.activeSessionId)
      }
      const id = normalizeId(event.sessionId)
      if (!id) return done(state, state, [], { activeChanged: false })
      const next = activateTab(state, id, at)
      return done(state, next, [], { activeChanged: next.activeSessionId !== state.activeSessionId })
    }
    case 'conn/disconnected':
      // 断线影响的是**所有**标签：后台标签里还在流的回答同样中断、审批卡同样失效。
      return applyToAllChats(state, event as ChatEvent, at)
    default:
      return routeChatEvent(state, event as ChatEvent, at)
  }
}

/** 把一条本地事件应用到每个标签（断线这种"全局"事件用）。 */
function applyToAllChats(state: TabsState, event: ChatEvent, at: number): TabsReduceResult {
  let chats = state.chats
  const touched: string[] = []
  for (const [id, chat] of Object.entries(state.chats)) {
    if (!chat) continue
    const reduced = reduceChat(chat, event, at)
    if (reduced.state === chat) continue
    chats = { ...chats, [id]: reduced.state }
    touched.push(id)
  }
  if (touched.length === 0) return done(state, state, [], { activeChanged: false })
  return done(state, { ...state, chats }, [], { activeChanged: false, touched })
}

function routeChatEvent(state: TabsState, event: ChatEvent, at: number, forced?: string): TabsReduceResult {
  const resolved = forced !== undefined ? { id: forced, adopt: false, activate: false } : resolveTarget(state, event)
  if (!resolved) return done(state, state, [], { activeChanged: false })
  const base = resolved.activate
    ? activateTab(state, resolved.id, at)
    : resolved.adopt
      ? adoptSession(state, resolved.id, at)
      : state
  const target = resolved.id
  const before = base.chats[target] ?? chatFor(base, target)
  const reduced = reduceChat(before, event, at)
  const after = reduced.state

  const active = base.activeSessionId
  let next: TabsState = {
    ...base,
    chats: { ...base.chats, [target]: after },
    activity: { ...base.activity, [target]: nextActivity(base.activity[target], event, target === active, at) },
  }
  // 第一次拿到的会话 id 要补进标签条（否则会出现"有消息但没有标签"的幽灵会话）。
  if (!next.tabs.includes(target) && target !== PLACEHOLDER_SESSION) next = openTab(next, target, at)
  const touched = after !== before ? [target] : []
  const effects = reduced.effects.map(effect => ({ ...effect, sessionId: target }))
  return done(state, next, effects, {
    activeChanged: next.activeSessionId !== state.activeSessionId,
    target,
    touched,
  })
}

/**
 * 帧路由的核心规则。
 *
 * 1. 有 `sessionId`：属于那个标签；已在标签条里就进去，是当前会话就进当前标签，
 *    还不认识但当前是占位状态（或这是一份"绑定快照"）就认领它。
 * 2. 没有 `sessionId`（旧电脑端的帧）：进当前标签。
 * 3. `file/*` 例外：文件可能属于后台标签（切走前发起的下载），按 fileId 反查归属，
 *    否则进度会被写进错误的会话，甚至被判成"missing-meta"而中止。
 *
 * `active:true` 的快照表示"电脑端现在绑定的是这个会话"。**已经打开的标签不因此切走**：
 * 重连时电脑端会先按 hello 里的旧绑定推一份快照，若照它切标签，用户刚点开的标签会
 * 在重连瞬间被拽回去（契约要求"刷新/重连后当前会话都还在"）。只有这台手机还没有
 * 任何标签（首次绑定）或这个会话根本没打开过时，才认领并显示它。
 */
function resolveTarget(
  state: TabsState,
  event: ChatEvent,
): { id: string; adopt: boolean; activate: boolean } | undefined {
  const explicit = normalizeId((event as { sessionId?: unknown }).sessionId)
  if (explicit) {
    // 绑定快照（session/state 且 active !== false）说明电脑端把我们切到了这个会话。
    const binding = event.t === 'session/state' && (event as { active?: unknown }).active === true
    if (explicit === state.activeSessionId) return { id: explicit, adopt: false, activate: false }
    if (state.chats[explicit]) return { id: explicit, adopt: false, activate: false }
    if (state.activeSessionId === PLACEHOLDER_SESSION) return { id: explicit, adopt: true, activate: true }
    if (binding) return { id: explicit, adopt: true, activate: true }
    return undefined
  }
  const owner = fileOwner(state, event)
  if (owner !== undefined) return { id: owner, adopt: false, activate: false }
  return { id: state.activeSessionId, adopt: false, activate: false }
}

/** 文件/传输事件归属：哪个标签认识这个 fileId，就进哪个。 */
function fileOwner(state: TabsState, event: ChatEvent): string | undefined {
  // `file/*` 是电脑端推来的，`transfer/*` 是本地服务层落盘后的状态回写：
  // 两者都必须回到"当初发起这次传输"的标签，否则下载完成后那条卡片会永远停在
  // "下载中"（事件被写进了另一个会话，reducer 找不到对应的 transfer）。
  if (!event.t.startsWith('file/') && !event.t.startsWith('transfer/')) return undefined
  const fileId = (event as { fileId?: unknown }).fileId
  if (typeof fileId !== 'string' || fileId === '') return undefined
  for (const id of state.tabs) {
    const chat = state.chats[id]
    if (!chat) continue
    if (chat.transfers[fileId]) return id
    if (chat.messages.some(message => (message.files ?? []).some(file => file.fileId === fileId))) return id
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 未读 / 运行状态
// ---------------------------------------------------------------------------

function nextActivity(previous: SessionActivity | undefined, event: ChatEvent, isActive: boolean, at: number): SessionActivity {
  const base: SessionActivity = previous ?? NO_ACTIVITY
  let { typing, unread } = base
  switch (event.t) {
    case 'chat/typing':
      typing = event.active !== false
      break
    case 'chat/done':
    case 'chat/error':
      typing = false
      break
    case 'chat/echo':
    case 'chat/message':
      // 契约 §3：非当前标签收到用户/助手消息时未读 +1；当前标签不计。
      if (!isActive) unread += 1
      break
    case 'session/state': {
      const activeCall = event.snapshot?.activeCall
      typing = Boolean(
        activeCall && activeCall.typing === true && typeof activeCall.callId === 'string' && activeCall.callId !== '',
      )
      // 快照是权威状态：当前标签不需要未读角标。
      if (isActive) unread = 0
      break
    }
    default:
      break
  }
  return { typing, unread, lastAt: at }
}

function clearUnread(state: TabsState, sessionId: string): TabsState {
  const activity = state.activity[sessionId]
  if (!activity || activity.unread === 0) return state
  return { ...state, activity: { ...state.activity, [sessionId]: { ...activity, unread: 0 } } }
}

/** 每秒节拍：所有标签里的审批都要按过期时间撤掉（不只是当前标签）。 */
function tickApprovals(state: TabsState, at: number): TabsReduceResult {
  let chats = state.chats
  const touched: string[] = []
  for (const [id, chat] of Object.entries(state.chats)) {
    if (!chat) continue
    let next = chat
    // 审批与提问各有自己的过期规则：审批到点就撤，提问要看 canAnswerLate。
    if (next.approvals.length > 0) next = reduceChat(next, { t: 'approval/tick', at }, at).state
    if (next.questions.length > 0) next = reduceChat(next, { t: 'question/tick', at }, at).state
    if (next === chat) continue
    chats = { ...chats, [id]: next }
    touched.push(id)
  }
  if (touched.length === 0) return done(state, state, [], { activeChanged: false })
  return done(state, { ...state, chats }, [], { activeChanged: false, touched })
}

// ---------------------------------------------------------------------------
// 持久化（只存 tabs + activeSessionId，消息按 session_id 单独落库）
// ---------------------------------------------------------------------------

export interface TabsMeta {
  tabs: string[]
  activeSessionId: string
}

export function tabsMeta(state: TabsState): TabsMeta {
  return {
    tabs: state.tabs.filter(id => id !== PLACEHOLDER_SESSION),
    activeSessionId: state.activeSessionId === PLACEHOLDER_SESSION ? '' : state.activeSessionId,
  }
}

/**
 * 解析数据库里存的标签元数据。坏数据一律降级成"没有标签"，
 * 绝不能因为一行坏 JSON 让聊天页打不开。
 */
export function parseTabsMeta(value: unknown): TabsMeta {
  let raw: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return { tabs: [], activeSessionId: '' }
    try {
      raw = JSON.parse(value)
    } catch {
      return { tabs: [], activeSessionId: '' }
    }
  }
  if (!raw || typeof raw !== 'object') return { tabs: [], activeSessionId: '' }
  const record = raw as { tabs?: unknown; activeSessionId?: unknown }
  const tabs = sanitizeIdList(record.tabs)
  const active = normalizeId(record.activeSessionId)
  return { tabs, activeSessionId: active && tabs.includes(active) ? active : tabs[0] ?? '' }
}

export function serializeTabsMeta(state: TabsState): string {
  return JSON.stringify(tabsMeta(state))
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 新标签的初始 ChatState：会话 id 先写进去，快照到达前 UI 也知道自己是谁。 */
function chatFor(state: TabsState, sessionId: string): ChatState {
  const chat = emptyChatState(state.assistantId)
  if (sessionId === PLACEHOLDER_SESSION) return chat
  return { ...chat, sessionId }
}

function done(
  previous: TabsState,
  state: TabsState,
  effects: TabsEffect[],
  extra: { activeChanged: boolean; target?: string; touched?: string[] },
): TabsReduceResult {
  if (state === previous && effects.length === 0) {
    return { state, effects, touched: extra.touched ?? [], target: extra.target, activeChanged: extra.activeChanged }
  }
  return {
    state,
    effects,
    touched: extra.touched ?? [],
    target: extra.target,
    activeChanged: extra.activeChanged,
  }
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    const id = normalizeId(raw)
    if (!id || id === PLACEHOLDER_SESSION || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function eventAt(event: { at?: number | string }, fallback: number): number {
  const at = (event as { at?: unknown }).at
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (typeof at === 'string') {
    const parsed = Date.parse(at)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}
