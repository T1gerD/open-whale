// 会话选择器（2.3.0）的纯逻辑与 reducer 行为。
//
// 覆盖三件事，也是这条链路最容易坏的地方：
//  1. 帧编码（session/list|select|create 的字段必须和冻结协议一字不差）；
//  2. `sessions` 帧的清洗（坏行丢弃、重复 id 去重、current 标记、截断提示）；
//  3. `session/selected` + 紧随其后的 `session/state` 必须**整页替换**消息。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionCreateFrame,
  buildSessionListFrame,
  buildSessionSelectFrame,
  cwdTail,
  normalizeSessionSummary,
  normalizeSessionsFrame,
  relativeSessionTime,
  sessionAvailability,
  sessionSubtitle,
  sessionTitleOf,
} from '../src/core/sessions.mts'
import { CLIENT_FRAME, SESSION_LIST_LIMIT } from '../src/core/frames.mts'
import { emptyChatState, reduceChat, userMessageId } from '../src/core/reducer.mts'

const ASSISTANT = 'cmp_abc123'

function run(events, state = emptyChatState(ASSISTANT), start = 1000) {
  let current = state
  let clock = start
  const effects = []
  for (const event of events) {
    const result = reduceChat(current, event, clock)
    current = result.state
    effects.push(...result.effects)
    clock += 1
  }
  return { state: current, effects }
}

// ---------------------------------------------------------------------------
// 帧编码
// ---------------------------------------------------------------------------

test('session/list|select|create encode exactly the frozen frame shapes', () => {
  assert.deepEqual(buildSessionListFrame('rid_1'), { t: 'session/list', rid: 'rid_1' })
  assert.deepEqual(buildSessionSelectFrame('rid_2', 'sess_9'), { t: 'session/select', rid: 'rid_2', sessionId: 'sess_9' })
  assert.deepEqual(buildSessionCreateFrame('rid_3'), { t: 'session/create', rid: 'rid_3' })
  // 帧名必须来自镜像常量，而不是另抄一遍字符串
  assert.equal(buildSessionListFrame('r').t, CLIENT_FRAME.SESSION_LIST)
  assert.equal(buildSessionSelectFrame('r', 's').t, CLIENT_FRAME.SESSION_SELECT)
  assert.equal(buildSessionCreateFrame('r').t, CLIENT_FRAME.SESSION_CREATE)
})

test('session/select refuses an empty session id instead of sending a useless frame', () => {
  assert.equal(buildSessionSelectFrame('rid', ''), undefined)
  assert.equal(buildSessionSelectFrame('rid', '   '), undefined)
  assert.equal(buildSessionSelectFrame('rid', undefined), undefined)
  // 两端空白会被裁掉，避免电脑端按 id 精确匹配时 miss
  assert.equal(buildSessionSelectFrame('rid', ' sess_1 ').sessionId, 'sess_1')
})

// ---------------------------------------------------------------------------
// 列表清洗
// ---------------------------------------------------------------------------

test('sessions frame is sanitized: bad rows dropped, duplicate ids removed, current marked', () => {
  const list = normalizeSessionsFrame(
    {
      current: 'sess_b',
      truncated: true,
      sessions: [
        { id: 'sess_a', title: '重构 reducer', createdAt: 1000, updatedAt: 2000, live: true, cwd: 'C:\\work\\openwhale' },
        { id: 'sess_b', title: '   ', createdAt: '1700000000000' },
        { id: 'sess_a', title: '重复行', createdAt: 1 },
        { title: '没有 id 的行' },
        null,
        { id: '', title: '空 id' },
      ],
    },
    5000,
  )
  assert.ok(list)
  assert.equal(list.current, 'sess_b')
  assert.equal(list.truncated, true)
  assert.equal(list.fetchedAt, 5000)
  assert.deepEqual(list.sessions.map(item => item.id), ['sess_a', 'sess_b'])
  assert.equal(list.sessions[0].title, '重构 reducer')
  assert.equal(list.sessions[0].live, true)
  assert.equal(list.sessions[0].cwd, 'C:\\work\\openwhale')
  // 空白标题回落到「新会话」；字符串时间戳被接受
  assert.equal(list.sessions[1].title, '新会话')
  assert.equal(list.sessions[1].createdAt, 1700000000000)
  assert.equal(list.sessions[1].current, true)
  assert.equal(list.sessions[0].current, undefined)
})

test('an unusable sessions frame keeps the previous list (undefined) instead of clearing it', () => {
  assert.equal(normalizeSessionsFrame({ sessions: 'nope' }), undefined)
  assert.equal(normalizeSessionsFrame({}), undefined)
  assert.equal(normalizeSessionsFrame(null), undefined)
  // 空数组是合法结果：电脑上真的一个会话都没有
  const empty = normalizeSessionsFrame({ sessions: [] }, 1)
  assert.deepEqual(empty.sessions, [])
  assert.equal(empty.current, undefined)
})

test('the session list is capped at the protocol limit', () => {
  const sessions = Array.from({ length: SESSION_LIST_LIMIT + 5 }, (_, index) => ({
    id: `sess_${index}`,
    title: `会话 ${index}`,
    createdAt: index,
  }))
  const list = normalizeSessionsFrame({ sessions }, 1)
  assert.equal(list.sessions.length, SESSION_LIST_LIMIT)
})

test('normalizeSessionSummary keeps only usable fields', () => {
  assert.equal(normalizeSessionSummary({ id: 'a', title: 'x', createdAt: 1, live: 'yes' }).live, false)
  assert.equal(normalizeSessionSummary({ id: 'a', createdAt: 1 }).live, false)
  assert.equal(normalizeSessionSummary({ id: 'a', createdAt: 1 }).updatedAt, undefined)
  assert.equal(normalizeSessionSummary({ id: 'a', createdAt: 1, updatedAt: 'bad' }).updatedAt, undefined)
})

// ---------------------------------------------------------------------------
// 展示文案
// ---------------------------------------------------------------------------

test('relative session time covers just-now, minutes, today, yesterday and older', () => {
  const now = new Date(2026, 9, 30, 15, 30, 0).getTime()
  assert.equal(relativeSessionTime(now - 20_000, now), '刚刚')
  assert.equal(relativeSessionTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(relativeSessionTime(new Date(2026, 9, 30, 9, 5, 0).getTime(), now), '今天 09:05')
  assert.equal(relativeSessionTime(new Date(2026, 9, 29, 22, 0, 0).getTime(), now), '昨天 22:00')
  assert.equal(relativeSessionTime(new Date(2026, 8, 1, 8, 0, 0).getTime(), now), '9 月 1 日')
  assert.equal(relativeSessionTime(new Date(2025, 0, 2, 8, 0, 0).getTime(), now), '2025 年 1 月 2 日')
  assert.equal(relativeSessionTime(undefined, now), '')
  assert.equal(relativeSessionTime(0, now), '')
})

test('session subtitle and title fall back gracefully', () => {
  const session = { id: 's', title: '标题', createdAt: 1000, updatedAt: 2000, live: false, cwd: 'C:\\work\\demo' }
  assert.equal(cwdTail('C:\\work\\demo'), 'demo')
  assert.equal(cwdTail('/home/me/project/'), 'project')
  assert.equal(cwdTail(undefined), '')
  assert.match(sessionSubtitle(session, 2000), /刚刚 · demo/)
  assert.equal(sessionTitleOf({ current: 's', sessions: [session], truncated: false, fetchedAt: 1 }, undefined), '标题')
  assert.equal(sessionTitleOf(undefined, 's'), undefined)
  assert.equal(sessionTitleOf({ current: 'other', sessions: [session], truncated: false, fetchedAt: 1 }, 'other'), undefined)
})

// ---------------------------------------------------------------------------
// 可用性
// ---------------------------------------------------------------------------

test('session picker degrades with an actionable hint when offline or unsupported', () => {
  const offline = sessionAvailability(false, ['sessions-v1'])
  assert.equal(offline.ok, false)
  assert.match(offline.error, /离线/)
  const old = sessionAvailability(true, ['chat-echo-v1'])
  assert.equal(old.ok, false)
  assert.match(old.error, /版本较旧/)
  assert.equal(sessionAvailability(true, ['sessions-v1']).ok, true)
  // 老电脑端没有 capabilities 字段
  assert.equal(sessionAvailability(true, undefined).ok, false)
})

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

const SESSIONS_FRAME = {
  t: 'sessions',
  current: 'sess_old',
  sessions: [
    { id: 'sess_old', title: '旧会话', createdAt: 1000, live: false },
    { id: 'sess_new', title: '新会话', createdAt: 2000, live: true },
  ],
  truncated: false,
}

test('the sessions frame lands in state and does not touch the transcript', () => {
  const { state } = run([{ t: 'chat/delta', callId: 'c1', seq: 0, text: '旧回答' }, SESSIONS_FRAME])
  assert.equal(state.sessionList.sessions.length, 2)
  assert.equal(state.sessionList.current, 'sess_old')
  assert.equal(state.messages.length, 1)
  assert.equal(state.sessionList.sessions[1].live, true)

  // 坏帧不覆盖已有列表
  const { state: after } = run([{ t: 'sessions', sessions: 'broken' }], state)
  assert.equal(after.sessionList.sessions.length, 2)
})

test('session/selected clears the page and the following snapshot replaces every message', () => {
  let { state } = run([
    { t: 'user/send', rid: 'old_pending', text: '旧会话里还没发出去的消息', at: 10 },
    { t: 'chat/delta', callId: 'c_old', seq: 0, text: '旧回答' },
    { t: 'approval/ask', approvalId: 'ap_old', toolName: 'bash', expiresAt: 99_999 },
  ])
  assert.equal(state.messages.length, 2)

  const selected = run([{ t: 'session/selected', ok: true, sessionId: 'sess_new', title: '新会话', sessionEpoch: 4 }], state)
  state = selected.state
  // 旧消息清空，只剩一条「正在打开」的系统提示
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].kind, 'system')
  assert.match(state.messages[0].text, /新会话/)
  assert.equal(state.sessionId, 'sess_new')
  assert.equal(state.sessionEpoch, 4)
  assert.equal(state.approvals.length, 0, '旧会话的权限请求必须一起清掉')
  assert.equal(state.resetOnNextSnapshot, true)
  assert.deepEqual(selected.effects, [{ kind: 'persist-cursor', cursor: 0 }])

  const snapshot = {
    t: 'session/state',
    sessionId: 'sess_new',
    title: '新会话',
    sessionEpoch: 4,
    head: 7,
    snapshot: {
      messages: [
        { id: 'usr_n1', kind: 'user', text: '新会话的问题', at: '2026-10-26T09:00:00.000Z', msgId: 'n1' },
        { id: 'msg_n1', kind: 'assistant', text: '新会话的回答', at: '2026-10-26T09:00:01.000Z', callId: 'c_new' },
      ],
    },
  }
  const after = run([snapshot], state).state
  assert.deepEqual(
    after.messages.map(message => message.text),
    ['新会话的问题', '新会话的回答'],
  )
  // 整页替换：旧会话的 pending 消息与系统提示都不会留下来
  assert.equal(after.messages.some(message => message.id === userMessageId('old_pending')), false)
  assert.equal(after.resetOnNextSnapshot, false)
  assert.equal(after.sessionCursor, 7)
})

test('a failed session/selected leaves the transcript alone and explains why', () => {
  let { state } = run([{ t: 'chat/delta', callId: 'c1', seq: 0, text: '还在看的内容' }])
  state = run(
    [{ t: 'session/selected', ok: false, error: 'not-found', message: '电脑上找不到这个会话了' }],
    state,
  ).state
  assert.equal(state.messages[0].text, '还在看的内容')
  const last = state.messages[state.messages.length - 1]
  assert.equal(last.kind, 'system')
  assert.match(last.text, /电脑上找不到这个会话了/)
  assert.equal(state.resetOnNextSnapshot, false)
})

test('a session/state that was not caused by the picker still merges (reconnect path)', () => {
  const { state } = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '本地已有' },
    {
      t: 'session/state',
      sessionId: 'sess_1',
      sessionEpoch: 1,
      head: 3,
      snapshot: { messages: [{ id: 'usr_1', kind: 'user', text: '问题', at: '2026-10-26T09:00:00.000Z', msgId: 'u1' }] },
    },
  ])
  // 不是 picker 触发的快照：本地内容按老逻辑合并保留
  assert.equal(state.messages.length, 2)
  assert.equal(state.sessionList, undefined)
})
