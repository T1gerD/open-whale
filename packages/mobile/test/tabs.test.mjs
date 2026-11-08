// 会话标签页（2.4.0）的纯逻辑：帧路由、未读/运行状态、标签持久化、watch 帧构造、
// 后台快照、审批归属。
//
// 这些用例对应契约 `docs/v2.4.0/CONTRACT.md` §3 的每一条规则；它们能在没有 Expo、
// 没有设备的机器上跑，是因为容器的全部判断都在 src/core/tabs.mts 里。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SESSION_WATCH_LIMIT } from '../src/core/frames.mts'
import { buildSessionSnapshotFrame, buildSessionWatchFrame } from '../src/core/sessions.mts'
import {
  PLACEHOLDER_SESSION,
  activateTab,
  activeChat,
  closeTab,
  emptyTabs,
  parseTabsMeta,
  pendingApprovalsElsewhere,
  pruneTabs,
  restoreTabs,
  routeEvent,
  serializeTabsMeta,
  sessionOfApproval,
  tabStripModel,
  tabTitle,
  tabsMeta,
  totalUnread,
  watchSessionIds,
} from '../src/core/tabs.mts'

const ASSISTANT = 'cmp_tabs'

/** 打开一组标签并激活其中一个（模拟启动时恢复用户上次的标签条）。 */
function start(tabs = [], active) {
  let state = emptyTabs(ASSISTANT)
  for (const id of tabs) state = routeEvent(state, { t: 'tabs/open', sessionId: id, at: 1000 }).state
  if (active) state = routeEvent(state, { t: 'tabs/activate', sessionId: active, at: 1000 }).state
  return state
}

/** 依次应用事件，时间戳自动递增（同一毫秒会让"后到"的判定变得含糊）。 */
function apply(state, events, clock = 2000) {
  let current = state
  let at = clock
  for (const event of events) {
    current = routeEvent(current, { ...event, at: event.at ?? at }, at).state
    at += 10
  }
  return current
}

function messagesOf(state, sessionId) {
  return state.chats[sessionId]?.messages ?? []
}

test('frames are routed to their own tab and never leak into the active one', () => {
  const initial = start(['a', 'b'], 'a')
  const state = apply(initial, [
    { t: 'chat/echo', sessionId: 'b', msgId: 'm1', text: '你好', deviceId: 'dev' },
    { t: 'chat/message', sessionId: 'b', callId: 'c1', messageId: 'x1', text: '正在回答' },
  ])
  assert.equal(state.activeSessionId, 'a')
  assert.equal(messagesOf(state, 'a').length, 0)
  assert.equal(messagesOf(state, 'b').length, 2)
  // 未读：切走的标签 +1（echo）/ +1（message）。
  assert.equal(state.activity.b.unread, 2)
  assert.equal(state.activity.a.unread, 0)
})

test('legacy frames without sessionId fall back to the active tab', () => {
  const initial = start(['a', 'b'], 'b')
  const state = apply(initial, [
    { t: 'chat/echo', msgId: 'm1', text: '老电脑端', deviceId: 'dev' },
    { t: 'chat/message', callId: 'c1', messageId: 'x1', text: '回答' },
  ])
  assert.equal(messagesOf(state, 'b').length, 2)
  assert.equal(messagesOf(state, 'a').length, 0)
})

test('typing follows chat/typing → chat/done and unread clears on activation', () => {
  const initial = start(['a', 'b'], 'a')
  const typing = apply(initial, [
    { t: 'chat/typing', sessionId: 'b', callId: 'c1', active: true },
  ])
  assert.equal(typing.activity.b.typing, true)
  assert.equal(typing.activity.a.typing, false)

  const done = apply(typing, [{ t: 'chat/message', sessionId: 'b', callId: 'c1', messageId: 'x1', text: 'ok' }, { t: 'chat/done', sessionId: 'b', callId: 'c1', text: 'ok' }])
  assert.equal(done.activity.b.typing, false)
  assert.equal(done.activity.b.unread, 1)
  assert.equal(totalUnread(done), 1)

  const switched = apply(done, [{ t: 'tabs/activate', sessionId: 'b' }])
  assert.equal(switched.activeSessionId, 'b')
  assert.equal(switched.activity.b.unread, 0)
  assert.equal(switched.activity.b.typing, false)
  // 切过去之后再来的消息不再累计未读（用户正看着它）。
  const live = apply(switched, [{ t: 'chat/message', sessionId: 'b', callId: 'c2', messageId: 'x2', text: '继续' }])
  assert.equal(live.activity.b.unread, 0)
})

test('a background snapshot fills only that tab and keeps the active one intact', () => {
  const initial = apply(start(['a', 'b'], 'a'), [
    { t: 'chat/message', sessionId: 'a', callId: 'cA', messageId: 'xA', text: 'A 的回答' },
  ])
  const afterSnapshot = routeEvent(
    initial,
    {
      t: 'session/state',
      rid: 'snap_1',
      sessionId: 'b',
      active: false,
      sessionEpoch: 3,
      head: 7,
      title: 'B 会话',
      snapshot: { messages: [{ id: 'usr_m9', kind: 'user', text: 'B 的历史', at: '2026-01-01T00:00:00.000Z' }] },
    },
    5000,
  ).state
  assert.equal(afterSnapshot.activeSessionId, 'a')
  assert.equal(afterSnapshot.chats.a.messages.length, 1)
  assert.equal(afterSnapshot.chats.a.messages[0].text, 'A 的回答')
  assert.equal(afterSnapshot.chats.b.messages.length, 1)
  assert.equal(afterSnapshot.chats.b.messages[0].text, 'B 的历史')
  assert.equal(afterSnapshot.chats.b.title, 'B 会话')
  assert.equal(afterSnapshot.chats.b.sessionCursor, 7)
  assert.equal(tabTitle(afterSnapshot, 'b'), 'B 会话')
})

test('session/selected switches to an existing tab without wiping its cache', () => {
  const initial = apply(start(['a', 'b'], 'a'), [
    { t: 'chat/message', sessionId: 'b', callId: 'cB', messageId: 'xB', text: 'B 已有内容' },
  ])
  const selected = apply(initial, [{ t: 'session/selected', ok: true, sessionId: 'b', sessionEpoch: 4 }])
  assert.equal(selected.activeSessionId, 'b')
  assert.equal(messagesOf(selected, 'b').length, 1)
  assert.deepEqual(selected.tabs, ['a', 'b'])
})

test('a binding snapshot adopts the first real session id (placeholder migration)', () => {
  const initial = emptyTabs(ASSISTANT)
  assert.equal(initial.activeSessionId, PLACEHOLDER_SESSION)
  const adopted = routeEvent(
    initial,
    {
      t: 'session/state',
      sessionId: 'first',
      active: true,
      sessionEpoch: 1,
      head: 0,
      snapshot: { messages: [] },
    },
    1000,
  ).state
  assert.deepEqual(adopted.tabs, ['first'])
  assert.equal(adopted.activeSessionId, 'first')
})

test('a binding snapshot for an already open tab does not yank the user off their tab', () => {
  const initial = start(['a', 'b'], 'a')
  // 重连时电脑端会先按 hello 里的旧绑定推一份快照：用户刚点开的标签不能被拽走。
  const state = routeEvent(
    initial,
    { t: 'session/state', sessionId: 'b', active: true, sessionEpoch: 5, head: 0, snapshot: { messages: [] } },
    6000,
  ).state
  assert.equal(state.activeSessionId, 'a')
  // 但如果这个会话根本没打开过，说明电脑端把它绑给了这台手机：认领并显示它。
  const unknown = routeEvent(
    initial,
    { t: 'session/state', sessionId: 'fresh', active: true, sessionEpoch: 6, head: 0, title: '新绑定的会话', snapshot: { messages: [] } },
    6100,
  ).state
  assert.equal(unknown.activeSessionId, 'fresh')
  assert.deepEqual(unknown.tabs, ['a', 'b', 'fresh'])
})

test('closing the active tab picks the neighbour and drops its cache', () => {
  const three = start(['a', 'b', 'c'], 'b')
  const closed = closeTab(three, 'b')
  assert.deepEqual(closed.tabs, ['a', 'c'])
  assert.equal(closed.activeSessionId, 'a')
  assert.equal(closed.chats.b, undefined)

  const middle = start(['a', 'b', 'c'], 'a')
  // 最左边没有左邻居：切到右边的 b。
  assert.equal(closeTab(middle, 'a').activeSessionId, 'b')
  const last = closeTab(start(['only'], 'only'), 'only')
  assert.deepEqual(last.tabs, [])
  assert.equal(last.activeSessionId, PLACEHOLDER_SESSION)
})

test('tabs persist as {tabs, activeSessionId} and survive a bad row', () => {
  const state = start(['a', 'b', 'c'], 'b')
  const meta = tabsMeta(state)
  assert.deepEqual(meta, { tabs: ['a', 'b', 'c'], activeSessionId: 'b' })
  assert.deepEqual(parseTabsMeta(serializeTabsMeta(state)), meta)
  // 坏 JSON / 缺字段一律降级成空标签，绝不让聊天页打不开。
  assert.deepEqual(parseTabsMeta('{oops'), { tabs: [], activeSessionId: '' })
  assert.deepEqual(parseTabsMeta(undefined), { tabs: [], activeSessionId: '' })
  // active 不在 tabs 里：退回第一个。
  assert.deepEqual(parseTabsMeta(JSON.stringify({ tabs: ['a', 'b'], activeSessionId: 'zzz' })), {
    tabs: ['a', 'b'],
    activeSessionId: 'a',
  })
  // v2.3.0 老用户没有 tabs 列：用绑定会话兜底，不要打开一个空标签条。
  const restored = restoreTabs(ASSISTANT, { tabs: [], activeSessionId: '' }, 'bound')
  assert.deepEqual(restored.tabs, ['bound'])
  assert.equal(restored.activeSessionId, 'bound')
})

test('session/list prunes tabs that no longer exist on the computer', () => {
  const state = start(['a', 'gone'], 'gone')
  const pruned = routeEvent(
    state,
    { t: 'sessions', current: 'a', sessions: [{ id: 'a', title: '会话 A', createdAt: 1, live: false }] },
    9000,
  ).state
  assert.deepEqual(pruned.tabs, ['a'])
  assert.equal(pruned.activeSessionId, 'a')
  assert.deepEqual(pruned.droppedTabs, ['gone'])
  assert.equal(tabTitle(pruned, 'a'), '会话 A')
  // 空列表不当作"全部被删"：电脑端可能只是还没读到（保留标签）。
  assert.deepEqual(pruneTabs(start(['a', 'b'], 'a'), []).tabs, ['a', 'b'])
})

test('watch ids are the open tabs minus the active one, capped at the protocol limit', () => {
  const ids = Array.from({ length: SESSION_WATCH_LIMIT + 3 }, (_, index) => `s${index}`)
  const state = start(ids, 's0')
  const watch = watchSessionIds(state)
  assert.equal(watch.length, SESSION_WATCH_LIMIT)
  assert.equal(watch.includes('s0'), false)
  assert.deepEqual(watchSessionIds(state, 2), ['s1', 's2'])

  const frame = buildSessionWatchFrame(['a', 'a', '', 'b', ...ids])
  assert.equal(frame.t, 'session/watch')
  // 去重 + 去掉空串，然后截断到协议上限（多出来的电脑端也会忽略）。
  assert.deepEqual(frame.sessionIds.slice(0, 2), ['a', 'b'])
  assert.equal(frame.sessionIds.length, SESSION_WATCH_LIMIT)
  // 空数组是合法的（= 取消全部后台订阅），但超长必须截断到上限。
  assert.deepEqual(buildSessionWatchFrame([]).sessionIds, [])
  assert.equal(buildSessionWatchFrame(ids).sessionIds.length, SESSION_WATCH_LIMIT)
})

test('snapshot requests carry the requested session id and a rid', () => {
  const frame = buildSessionSnapshotFrame('snap_7', 'sess-42')
  assert.deepEqual(frame, { t: 'session/snapshot', rid: 'snap_7', sessionId: 'sess-42' })
  assert.equal(buildSessionSnapshotFrame('r', ''), undefined)
})

test('approvals belong to their own tab and are found for replies', () => {
  const initial = start(['a', 'b'], 'a')
  const state = apply(initial, [
    { t: 'approval/ask', sessionId: 'b', approvalId: 'ap_b', toolName: 'bash', expiresAt: Date.now() + 60_000 },
    { t: 'approval/ask', sessionId: 'a', approvalId: 'ap_a', toolName: 'write', expiresAt: Date.now() + 60_000 },
  ])
  assert.equal(state.chats.b.approvals.length, 1)
  assert.equal(state.chats.a.approvals.length, 1)
  assert.equal(sessionOfApproval(state, 'ap_b'), 'b')
  assert.equal(sessionOfApproval(state, 'ap_a'), 'a')
  assert.equal(pendingApprovalsElsewhere(state), 1)
  // 回答 b 的那条只撤 b 的卡。
  const resolved = apply(state, [{ t: 'approval/resolved', sessionId: 'b', approvalId: 'ap_b', outcome: 'allowed-once' }])
  assert.equal(resolved.chats.b.approvals.length, 0)
  assert.equal(resolved.chats.a.approvals.length, 1)
  const model = tabStripModel(resolved)
  assert.equal(model.find(tab => tab.id === 'a').approvals, 1)
})

test('the approval tick prunes expired cards in background tabs too', () => {
  const initial = start(['a', 'b'], 'a')
  const asked = apply(initial, [
    { t: 'approval/ask', sessionId: 'b', approvalId: 'ap_old', toolName: 'bash', expiresAt: 1000 },
  ])
  assert.equal(asked.chats.b.approvals.length, 1)
  const ticked = routeEvent(asked, { t: 'tabs/tick', at: 60_000 }).state
  assert.equal(ticked.chats.b.approvals.length, 0)
})

test('file frames follow the tab that owns the file, not the active tab', () => {
  const initial = start(['a', 'b'], 'a')
  const withFile = apply(initial, [
    {
      t: 'chat/done',
      sessionId: 'b',
      callId: 'cB',
      text: '给你一个文件',
      files: [{ fileId: 'f1', name: '报告.pdf', size: 10 }],
    },
  ])
  assert.ok(withFile.chats.b.transfers.f1)
  const meta = apply(withFile, [{ t: 'file/meta', fileId: 'f1', name: '报告.pdf', size: 10 }])
  assert.equal(meta.chats.b.transfers.f1.status, 'downloading')
  assert.equal(meta.chats.a.transfers.f1, undefined)
  const chunk = apply(meta, [{ t: 'file/chunk', fileId: 'f1', seq: 0, dataBase64: 'QUFB' }])
  assert.equal(chunk.chats.b.transfers.f1.receivedBytes, 3)
  assert.equal(chunk.chats.a.transfers.f1, undefined)
  // 落盘完成的状态回写也必须回到 b：写进 a 的话 b 的卡片会永远停在"下载中"。
  const saved = apply(chunk, [{ t: 'transfer/saved', fileId: 'f1', path: 'file:///tmp/report.pdf' }])
  assert.equal(saved.chats.b.transfers.f1.status, 'done')
  assert.equal(saved.chats.b.transfers.f1.localPath, 'file:///tmp/report.pdf')
  assert.equal(saved.chats.a.transfers.f1, undefined)
})

test('a disconnect marks streaming answers in every tab as interrupted', () => {
  const initial = apply(start(['a', 'b'], 'a'), [
    { t: 'chat/delta', sessionId: 'a', callId: 'cA', seq: 0, text: '半句' },
    { t: 'chat/delta', sessionId: 'b', callId: 'cB', seq: 0, text: '另外半句' },
  ])
  assert.equal(initial.chats.a.typing, null)
  const disconnected = routeEvent(initial, { t: 'conn/disconnected', at: 9000 }).state
  assert.equal(disconnected.chats.a.messages[0].interrupted, true)
  assert.equal(disconnected.chats.b.messages[0].interrupted, true)
})

test('the active chat view follows the active tab', () => {
  const state = apply(start(['a', 'b'], 'a'), [
    { t: 'chat/message', sessionId: 'b', callId: 'cB', messageId: 'xB', text: 'B 内容' },
  ])
  assert.equal(activeChat(state).messages.length, 0)
  const switched = activateTab(state, 'b', 7000)
  assert.equal(activeChat(switched).messages.length, 1)
  const model = tabStripModel(switched)
  assert.deepEqual(model.map(tab => [tab.id, tab.active]), [
    ['a', false],
    ['b', true],
  ])
})


test('tabs with the same title get #序号 so new sessions are distinguishable', () => {
  const state = start(['sess_aaaa1111', 'sess_bbbb2222', 'sess_cccc3333'], 'sess_aaaa1111')
  const listed = {
    ...state,
    sessionList: {
      sessions: [
        { id: 'sess_aaaa1111', title: '新会话', live: false, cwd: '' },
        { id: 'sess_bbbb2222', title: '新会话', live: false, cwd: '' },
        { id: 'sess_cccc3333', title: '新会话', live: false, cwd: '' },
      ],
    },
  }
  assert.deepEqual(tabStripModel(listed).map(tab => tab.title), ['新会话 #1', '新会话 #2', '新会话 #3'])
  // 有独立标题的标签不受影响。
  const titled = {
    ...listed,
    sessionList: { sessions: [{ id: 'sess_aaaa1111', title: '优化 open-whale', live: false, cwd: '' }] },
  }
  assert.equal(tabStripModel(titled).find(tab => tab.id === 'sess_aaaa1111').title, '优化 open-whale')
})
