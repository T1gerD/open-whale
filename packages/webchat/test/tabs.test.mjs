// 会话标签 store 测试（v2.4.0 协议 1.3.0）。
//
// 这里覆盖契约 §3 的每一条规则：
//  * 帧按 `sessionId` 路由，没有 sessionId 的旧帧进当前会话；
//  * 非当前标签收到消息累加未读，切回清零；typing 来自 chat/typing，done/error 清掉；
//  * `session/watch` 的订阅列表 = 标签减当前标签，最多 8 个；
//  * 后台 `session/state`（active:false / 带 rid）不改变当前标签，只补那个标签；
//  * 标签开关 / 切换 / 恢复 / 清理 + 持久化形状；
//  * 审批跟着标签走，不互相覆盖。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChatTabsModel, TAB_LIMIT, buildSnapshotFrame, buildWatchFrame } from '../lib/messages.mjs'

const NOW = Date.parse('2026-10-30T12:00:00.000Z')

/** @param {{tabLimit?: number}} [options] */
function makeStore(options = {}) {
  const store = new ChatTabsModel({ myDeviceId: 'dev_a', ...options })
  return store
}

/** 一条当前会话的快照。 */
function stateFrame(sessionId, messages = [], extra = {}) {
  return {
    t: 'session/state',
    sessionId,
    sessionEpoch: 1,
    head: 1,
    snapshot: { messages },
    ...extra,
  }
}

test('第一个 session/state 自动开标签并激活；没有 sessionId 的旧帧进当前标签', () => {
  const store = makeStore()
  const result = store.applyFrame(
    stateFrame('sess_a', [{ id: 'usr_m1', kind: 'user', text: 'A 的历史', at: '2026-10-30T11:00:00.000Z' }]),
    { now: NOW },
  )
  assert.equal(result.opened, true)
  assert.equal(result.needsWatch, true)
  assert.deepEqual(store.tabs, ['sess_a'])
  assert.equal(store.activeSessionId, 'sess_a')
  assert.equal(store.messages.length, 1)

  // 老电脑端（v1.2.0）的帧没有 sessionId：必须进当前会话。
  store.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_a', text: '旧格式', at: '2026-10-30T11:01:00.000Z', seq: 2 })
  assert.equal(store.messages.length, 2)
  assert.equal(store.chatFor('sess_a').sessionId, 'sess_a')})

test('后台标签收到消息累加未读，切回清零；当前标签不累计', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  // 后台会话的快照：auto 开标签但不抢焦点。
  const opened = store.applyFrame(stateFrame('sess_b', [], { active: false }), { now: NOW })
  assert.equal(opened.opened, true)
  assert.deepEqual(store.tabs, ['sess_a', 'sess_b'])
  assert.equal(store.activeSessionId, 'sess_a')

  store.applyFrame(
    { t: 'chat/echo', sessionId: 'sess_b', msgId: 'm2', deviceId: 'dev_b', text: 'B 里的一句', at: '2026-10-30T11:02:00.000Z', seq: 3 },
    { now: NOW },
  )
  store.applyFrame(
    { t: 'chat/message', sessionId: 'sess_b', callId: 'c2', messageId: 'a2', index: 0, text: 'B 的回答', seq: 4 },
    { now: NOW },
  )
  // 当前标签自己的消息不算未读。
  store.applyFrame(
    { t: 'chat/echo', sessionId: 'sess_a', msgId: 'm3', deviceId: 'dev_a', text: 'A 的', at: '2026-10-30T11:03:00.000Z', seq: 5 },
    { now: NOW },
  )
  assert.equal(store.unreadFor('sess_b'), 2)
  assert.equal(store.unreadFor('sess_a'), 0)

  const switched = store.activateTab('sess_b')
  assert.equal(switched.changed, true)
  assert.equal(store.activeSessionId, 'sess_b')
  assert.equal(store.unreadFor('sess_b'), 0)
  assert.deepEqual(store.messages.map(message => message.text), ['B 里的一句', 'B 的回答'])
  assert.equal(store.unreadFor('sess_a'), 0)
})

test('typing / live：chat/typing 点亮运行点，done 熄掉；live 来自会话列表', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  store.applyFrame(stateFrame('sess_b', [], { active: false }), { now: NOW })

  store.applyFrame({ t: 'chat/typing', sessionId: 'sess_b', callId: 'c1', active: true }, { now: NOW })
  assert.equal(store.typingFor('sess_b'), true)
  assert.equal(store.liveFor('sess_b'), true)
  assert.equal(store.typingFor('sess_a'), false)

  store.applyFrame({ t: 'chat/done', sessionId: 'sess_b', callId: 'c1', text: '写完了', seq: 9 }, { now: NOW })
  assert.equal(store.typingFor('sess_b'), false)
  // 会话列表里的 live 也能让标签显示「运行中」。
  store.applyFrame({
    t: 'sessions',
    current: 'sess_a',
    sessions: [
      { id: 'sess_a', title: 'A', createdAt: 1 },
      { id: 'sess_b', title: 'B', createdAt: 2, live: true },
    ],
  })
  assert.equal(store.liveFor('sess_b'), true)
  assert.equal(store.liveFor('sess_a'), false)
})

test('session/watch 列表 = 标签减当前标签，按打开顺序，最多 8 个', () => {
  const store = makeStore({ tabLimit: TAB_LIMIT })
  for (let index = 0; index < TAB_LIMIT; index += 1) {
    store.openTab(`s${index}`, { activate: index === 0 })
  }
  assert.equal(store.tabs.length, TAB_LIMIT)
  const watch = store.watchList()
  assert.equal(watch.length, TAB_LIMIT - 1)
  assert.deepEqual(watch, store.tabs.filter(id => id !== store.activeSessionId))
  assert.ok(watch.length <= 8)

  // 切换当前标签后，watch 列表随之变化（当前标签被排除）。
  store.activateTab('s2')
  assert.equal(store.watchList().includes('s2'), false)
  assert.equal(store.watchList().includes('s0'), true)

  // 超过上限：第 10 个标签不允许打开，避免订阅不到的“死标签”。
  const over = store.openTab('overflow')
  assert.equal(over.ok, false)
  assert.equal(over.reason, 'limit')
})

test('session/snapshot 的后台状态只补那个标签，不改变当前绑定；rid 原样匹配', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a', [{ id: 'usr_m1', kind: 'user', text: 'A', at: '2026-10-30T11:00:00.000Z' }]), { now: NOW })
  store.openTab('sess_b', { activate: false })
  const result = store.applyFrame(
    {
      t: 'session/state',
      rid: 'snap_1',
      active: false,
      sessionId: 'sess_b',
      sessionEpoch: 1,
      head: 5,
      snapshot: { messages: [{ id: 'usr_m9', kind: 'user', text: 'B 的历史', at: '2026-10-30T11:30:00.000Z' }] },
    },
    { now: NOW },
  )
  assert.equal(result.sessionChanged, true)
  assert.equal(store.activeSessionId, 'sess_a')
  assert.deepEqual(store.messages.map(message => message.text), ['A'])
  assert.deepEqual(store.chatFor('sess_b').messages.map(message => message.text), ['B 的历史'])
  assert.equal(store.chatFor('sess_b').cursor, 5)
  assert.equal(store.sessionsCurrent, 'sess_a', '后台快照不能改绑定')
})

test('sessions：归一化 / 标题同步 / 清理已不存在的标签 / 截断时保守不清理', () => {
  const store = makeStore()
  store.restoreTabs({ tabs: ['gone', 'kept'], activeSessionId: 'gone' })
  assert.deepEqual(store.tabs, ['gone', 'kept'])

  const result = store.applyFrame({
    t: 'sessions',
    current: 'kept',
    sessions: [
      { id: 'kept', title: '保留的', createdAt: 1 },
      { id: 'kept', title: '重复条目', createdAt: 9 },
      { title: '没有 id' },
    ],
  })
  assert.deepEqual(result.dropped, ['gone'])
  assert.deepEqual(store.tabs, ['kept'])
  assert.equal(store.activeSessionId, 'kept', '当前标签被丢掉时要切到相邻标签')
  assert.equal(store.titleFor('kept'), '保留的')
  assert.equal(store.chatFor('kept')?.sessionTitle, '保留的')

  // 列表被截断时无法判断“不存在”，不能丢标签。
  store.restoreTabs({ tabs: ['kept', 'maybe-old'], activeSessionId: 'kept' })
  const truncated = store.applyFrame({
    t: 'sessions',
    current: 'kept',
    truncated: true,
    sessions: [{ id: 'kept', title: '保留的', createdAt: 1 }],
  })
  assert.deepEqual(truncated.dropped, [])
  assert.deepEqual(store.tabs, ['kept', 'maybe-old'])
})

test('session/selected：成功把会话补进标签（不抢焦点），失败记录原因', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  const ok = store.applyFrame(
    { t: 'session/selected', rid: 'r1', ok: true, sessionId: 'sess_b', title: '新会话 B', sessionEpoch: 2 },
    { now: NOW },
  )
  assert.equal(ok.opened, true)
  assert.equal(store.activeSessionId, 'sess_a')
  assert.deepEqual(store.tabs, ['sess_a', 'sess_b'])
  assert.equal(store.titleFor('sess_b'), '新会话 B')
  assert.equal(store.sessionsCurrent, 'sess_b')

  const failed = store.applyFrame(
    { t: 'session/selected', rid: 'r2', ok: false, sessionId: 'sess_x', error: 'not-found', message: '不存在' },
    { now: NOW },
  )
  assert.equal(failed.selection.ok, false)
  assert.equal(failed.selection.error, 'not-found')
  assert.equal(store.tabs.includes('sess_x'), false)
})

test('审批跟着标签走：两个标签各自排队、按 sessionId 出队、角标可查', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  store.applyFrame(stateFrame('sess_b', [], { active: false }), { now: NOW })

  store.applyFrame({ t: 'approval/ask', sessionId: 'sess_a', approvalId: 'ap_a', toolName: 'bash' }, { now: NOW })
  store.applyFrame({ t: 'approval/ask', sessionId: 'sess_b', approvalId: 'ap_b1', toolName: 'write' }, { now: NOW })
  store.applyFrame({ t: 'approval/ask', sessionId: 'sess_b', approvalId: 'ap_b2', toolName: 'read' }, { now: NOW })

  assert.equal(store.approvals.length, 1, '当前标签只看到自己的审批')
  assert.equal(store.approvals[0].approvalId, 'ap_a')
  assert.equal(store.chatFor('sess_b').approvals.length, 2)
  assert.equal(store.hasApprovalIn('sess_a'), true)
  assert.equal(store.hasApprovalIn('sess_b'), true)

  // approvalId 是全局的：在任意标签里都能找到并作答。
  assert.equal(store.findApproval('ap_b2').sessionId, 'sess_b')
  assert.equal(store.markApprovalReplied('ap_b2', 'rejected'), true)
  assert.equal(store.findApproval('ap_b2').approval.replied, true)

  store.applyFrame({ t: 'approval/resolved', sessionId: 'sess_b', approvalId: 'ap_b1', outcome: 'allowed-once', source: 'phone' }, { now: NOW })
  assert.deepEqual(store.chatFor('sess_b').approvals.map(item => item.approvalId), ['ap_b2'])
  assert.equal(store.hasApprovalIn('sess_a'), true)
  assert.equal(store.chatFor('sess_b').approvals[0].approvalId, 'ap_b2')
})

test('标签开关：关闭当前标签切相邻；关闭别的标签不影响当前；删除对应会话缓存', () => {
  const store = makeStore()
  store.restoreTabs({ tabs: ['a', 'b', 'c'], activeSessionId: 'b' })
  const closed = store.closeTab('b')
  assert.equal(closed.changed, true)
  assert.equal(closed.activeSessionId, 'c')
  assert.deepEqual(store.tabs, ['a', 'c'])
  assert.equal(store.chatFor('b'), undefined)
  assert.equal(store.unreadFor('b'), 0)

  // 关闭非当前标签：当前标签不变。
  store.activateTab('a')
  const other = store.closeTab('c')
  assert.equal(other.activeSessionId, 'a')
  assert.deepEqual(store.tabs, ['a'])

  // 关闭最后一个标签：没有当前会话。
  store.closeTab('a')
  assert.deepEqual(store.tabs, [])
  assert.equal(store.activeSessionId, '')
  assert.equal(store.messages.length, 0)
})

test('持久化：快照形状 / 恢复标签 / 恢复当前会话内容（sessionId 不符就丢弃）', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a', [{ id: 'usr_m1', kind: 'user', text: 'A 的', at: '2026-10-30T11:00:00.000Z' }]), { now: NOW })
  store.openTab('sess_b', { activate: false })
  assert.deepEqual(store.snapshotTabs(), {
    version: 1,
    tabs: ['sess_a', 'sess_b'],
    activeSessionId: 'sess_a',
    closedSessions: [],
  })

  const restored = makeStore()
  const info = restored.restoreTabs(store.snapshotTabs())
  assert.equal(info.restored, 2)
  assert.equal(restored.activeSessionId, 'sess_a')
  assert.deepEqual(restored.tabs, ['sess_a', 'sess_b'])
  assert.equal(restored.messages.length, 0, '标签恢复只是空壳，内容要靠缓存或快照')

  const savedChat = store.snapshotActiveChat({ limit: 10 })
  assert.equal(restored.restoreActiveChat(savedChat), true)
  assert.equal(restored.messages.length, 1)
  // 会话对不上（缓存是 A，当前是 B）时不能把 A 的消息塞进 B。
  restored.activateTab('sess_b')
  assert.equal(restored.restoreActiveChat(savedChat), false)
  assert.equal(restored.messages.length, 0)
})

test('本地消息按标签插入，切标签后仍能按 msgId 找到并标为已发送', () => {
  const store = makeStore()
  store.restoreTabs({ tabs: ['a', 'b'], activeSessionId: 'a' })
  const added = store.addLocalUserMessage({ msgId: 'm10', text: '发给 A' }, 'a')
  assert.equal(added.sessionId, 'a')
  assert.equal(store.messages.length, 1)

  store.activateTab('b')
  assert.equal(store.messages.length, 0, 'B 不该看到 A 的消息')
  const found = store.findUserMessage('m10')
  assert.equal(found.sessionId, 'a')
  assert.equal(found.message.text, '发给 A')
  // chat/ack 可能切标签后才到：按 msgId 落到真正持有它的会话。
  assert.equal(store.markUserMessageSent('m10'), true)
  assert.equal(store.chatFor('a').byId.get('usr_m10').status, 'sent')
  assert.equal(store.resetUserMessageForRetry('m10'), true)
  assert.equal(store.chatFor('a').byId.get('usr_m10').status, 'pending')
  assert.equal(store.markUserMessageSent('nope'), false)
})

test('恢复时重复 / 非法 / 超量的标签 id 会被过滤', () => {
  const store = makeStore()
  const info = store.restoreTabs({
    tabs: ['a', 'a', '', 42, 'b', ...Array.from({ length: 20 }, (_v, index) => `x${index}`)],
    activeSessionId: 'missing',
  })
  assert.equal(info.restored, TAB_LIMIT)
  assert.deepEqual(store.tabs.slice(0, 2), ['a', 'b'])
  assert.equal(store.activeSessionId, 'a', 'active 不在列表里时退到第一个标签')
  assert.equal(new Set(store.tabs).size, store.tabs.length)
})

test('后台快照没有 activeCall 时会清掉过期的「正在输入」', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  store.applyFrame(stateFrame('sess_b', [], { active: false }), { now: NOW })
  store.applyFrame({ t: 'chat/typing', sessionId: 'sess_b', callId: 'c1', active: true }, { now: NOW })
  assert.equal(store.typingFor('sess_b'), true)
  store.applyFrame(stateFrame('sess_b', [], { active: false }), { now: NOW })
  assert.equal(store.typingFor('sess_b'), false, '快照里没有在跑的一轮，运行点要熄掉')
})

test('session/watch / session/snapshot 帧的形状与上限', () => {
  assert.deepEqual(buildWatchFrame(['a', 'b']), { t: 'session/watch', sessionIds: ['a', 'b'] })
  // 过滤非法值、去重、截断到 8（协议 SESSION_WATCH_LIMIT）。
  const many = Array.from({ length: 20 }, (_v, index) => `s${index}`)
  const frame = buildWatchFrame([...many, 's0', 42, '', '  '])
  assert.equal(frame.sessionIds.length, 8)
  assert.deepEqual(frame.sessionIds, many.slice(0, 8))
  assert.deepEqual(buildWatchFrame(undefined), { t: 'session/watch', sessionIds: [] })
  assert.deepEqual(buildWatchFrame([]), { t: 'session/watch', sessionIds: [] })
  // 空列表 = 退订（电脑端整体替换订阅集）。
  assert.deepEqual(buildWatchFrame(null).sessionIds, [])

  assert.deepEqual(buildSnapshotFrame('rid_1', 'sess_a'), {
    t: 'session/snapshot',
    rid: 'rid_1',
    sessionId: 'sess_a',
  })
})

test('关掉的标签不会被在途帧弹回来，用户主动再打开才回来', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  store.openTab('sess_b', { activate: false })
  store.closeTab('sess_b')
  assert.deepEqual(store.tabs, ['sess_a'])

  // 电脑端还没收到 watch/select 的中间态：B 的帧还在路上。
  const result = store.applyFrame(
    { t: 'chat/echo', sessionId: 'sess_b', msgId: 'm1', deviceId: 'dev_b', text: '在途帧', at: '2026-10-30T11:10:00.000Z', seq: 9 },
    { now: NOW },
  )
  assert.equal(result.opened, false, '刚关掉的标签不能被一帧消息重新打开')
  assert.deepEqual(store.tabs, ['sess_a'])
  assert.equal(store.messages.length, 0)

  // 用户从「全部会话」主动打开：允许（并解除“刚关掉”）。
  const opened = store.openTab('sess_b', { activate: true })
  assert.equal(opened.ok, true)
  assert.deepEqual(store.tabs, ['sess_a', 'sess_b'])
  assert.equal(store.activeSessionId, 'sess_b')
})

test('未知会话的后台消息会自动开标签但不抢当前标签', () => {
  const store = makeStore()
  store.applyFrame(stateFrame('sess_a'), { now: NOW })
  const result = store.applyFrame(
    { t: 'chat/echo', sessionId: 'sess_new', msgId: 'm1', deviceId: 'dev_b', text: '别的会话', at: '2026-10-30T11:05:00.000Z', seq: 7 },
    { now: NOW },
  )
  assert.equal(result.opened, true)
  assert.equal(store.activeSessionId, 'sess_a')
  assert.deepEqual(store.tabs, ['sess_a', 'sess_new'])
  assert.equal(store.unreadFor('sess_new'), 1)
})

test('关掉的会话在刷新后也不再复活（墓碑随标签一起持久化）', () => {
  const store = makeStore()
  store.openTab('sess_a')
  store.openTab('sess_b')
  store.closeTab('sess_a')
  const saved = store.snapshotTabs()
  assert.deepEqual(saved.closedSessions, ['sess_a'])

  // 刷新：从 localStorage 恢复（旧数据没有 closedSessions 时按空处理）。
  const restored = makeStore()
  restored.restoreTabs(saved)
  assert.deepEqual(restored.tabs, ['sess_b'])
  // 电脑端重启后仍把旧绑定（sess_a）的快照推回来，不能再自动开标签。
  restored.applyFrame(stateFrame('sess_a'))
  assert.deepEqual(restored.tabs, ['sess_b'], '已关闭的会话不能被绑定快照弹回来')
  // 用户主动打开时才解除墓碑。
  restored.openTab('sess_a', { activate: false })
  assert.deepEqual(restored.tabs, ['sess_b', 'sess_a'])
})

test('草稿会话换成真实 id：原地替换并保留聊天缓存与当前标签', () => {
  const store = makeStore()
  store.openTab('draft:new1', { activate: true })
  const chat = store.chatFor('draft:new1')
  const result = store.replaceSessionId('draft:new1', 'sess_real')
  assert.equal(result.ok, true)
  assert.deepEqual(store.tabs, ['sess_real'])
  assert.equal(store.activeSessionId, 'sess_real')
  assert.equal(store.chatFor('sess_real'), chat, '聊天缓存要搬到真实 id')
})

test('草稿换成真实 id：真实标签已存在时合并，不留两个标签', () => {
  const store = makeStore()
  store.openTab('sess_real', { activate: false })
  store.openTab('draft:new1', { activate: true })
  const result = store.replaceSessionId('draft:new1', 'sess_real')
  assert.equal(result.ok, true)
  assert.deepEqual(store.tabs, ['sess_real'])
  assert.equal(store.activeSessionId, 'sess_real')
})

test('会话状态：在线绿点 / 运行中转圈 / 等待审批黄点（优先级）', () => {
  const store = makeStore()
  store.openTab('sess_a')
  store.openTab('sess_b')
  store.applyFrame({
    t: 'sessions',
    sessions: [
      { id: 'sess_a', title: 'A', live: true },
      { id: 'sess_b', title: 'B', live: true },
    ],
  }, { now: NOW })
  assert.equal(store.statusFor('sess_a'), 'online', 'live 且空闲 = 绿点')

  // 运行中：本地 typing（优先于在线）
  store.applyFrame({ t: 'chat/typing', sessionId: 'sess_b', callId: 'c1', active: true }, { now: NOW })
  assert.equal(store.statusFor('sess_b'), 'running')

  // 等待审批：优先于运行中/在线
  store.applyFrame({ t: 'approval/ask', sessionId: 'sess_a', approvalId: 'ap_a', toolName: 'bash' }, { now: NOW })
  assert.equal(store.statusFor('sess_a'), 'approval')
  store.applyFrame({ t: 'approval/resolved', sessionId: 'sess_a', approvalId: 'ap_a', outcome: 'allowed-once', source: 'phone' }, { now: NOW })
  assert.equal(store.statusFor('sess_a'), 'online', '审批处理完回到在线')

  // 结构化提问同样算等待用户处理
  store.applyFrame({
    t: 'question/ask',
    sessionId: 'sess_b',
    questionId: 'q1',
    items: [{ id: 'i1', question: '选哪个？', options: [{ label: 'A' }] }],
    expiresAt: NOW + 60_000,
  }, { now: NOW })
  assert.equal(store.statusFor('sess_b'), 'approval')

  // 没有 live、也没有在跑的会话：不显示指示器
  store.closeTab('sess_a')
  assert.equal(store.statusFor('sess_missing'), 'idle')
})
