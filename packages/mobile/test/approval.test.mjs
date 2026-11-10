// 权限请求（approval，2.3.0）的纯逻辑与 reducer 队列行为。
//
// 这里的每一条都对应一个真实会咬人的场景：
//  * 同时两条 ask 到达时不能互相覆盖；
//  * 同一条 ask 重发（重连/重放）不能变成两张卡片；
//  * 电脑端到点把提示交回桌面后，手机上的卡片必须自己消失；
//  * 答复只允许 allowed-once / rejected，且只授权一次调用。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PENDING_APPROVALS,
  approvalAvailability,
  approvalReasonText,
  approvalRemainingMs,
  buildApprovalReplyFrame,
  enqueueApproval,
  formatApprovalCountdown,
  isExpired,
  normalizeApprovalAsk,
  pruneExpiredApprovals,
  resolveApproval,
} from '../src/core/approvals.mts'
import { CLIENT_FRAME } from '../src/core/frames.mts'
import { emptyChatState, reduceChat } from '../src/core/reducer.mts'

const ASSISTANT = 'cmp_abc123'

function run(events, state = emptyChatState(ASSISTANT), start = 1000) {
  let current = state
  let clock = start
  for (const event of events) {
    const result = reduceChat(current, event, clock)
    current = result.state
    clock += 1
  }
  return current
}

// ---------------------------------------------------------------------------
// 帧编码 / 归一化
// ---------------------------------------------------------------------------

test('approval/reply encodes the frozen frame and only accepts the two outcomes', () => {
  assert.deepEqual(buildApprovalReplyFrame('ap_1', 'allowed-once'), {
    t: 'approval/reply',
    approvalId: 'ap_1',
    outcome: 'allowed-once',
  })
  assert.deepEqual(buildApprovalReplyFrame('ap_1', 'rejected'), {
    t: 'approval/reply',
    approvalId: 'ap_1',
    outcome: 'rejected',
  })
  assert.equal(buildApprovalReplyFrame('ap_1', 'allowed-once').t, CLIENT_FRAME.APPROVAL_REPLY)
  // 契约：不在白名单里的 outcome 一律当 rejected，绝不发出第三个值
  assert.equal(buildApprovalReplyFrame('ap_1', 'allow-always').outcome, 'rejected')
  assert.equal(buildApprovalReplyFrame('', 'rejected'), undefined)
  assert.equal(buildApprovalReplyFrame(undefined, 'rejected'), undefined)
})

test('approval/ask is normalized, and an unanswerable ask is dropped', () => {
  const prompt = normalizeApprovalAsk(
    {
      approvalId: 'ap_1',
      toolName: 'bash',
      reason: 'run a shell command',
      displayReason: { en: 'Run a shell command', zh: '执行一条命令' },
      callId: 'call_1',
      expiresAt: '1700000000000',
    },
    500,
  )
  assert.equal(prompt.approvalId, 'ap_1')
  assert.equal(prompt.toolName, 'bash')
  assert.equal(prompt.callId, 'call_1')
  assert.equal(prompt.expiresAt, 1700000000000)
  assert.equal(prompt.receivedAt, 500)
  assert.equal(approvalReasonText(prompt), '执行一条命令')

  // 没有 approvalId：点「允许」也发不出正确回包，直接丢弃
  assert.equal(normalizeApprovalAsk({ toolName: 'bash' }), undefined)
  assert.equal(normalizeApprovalAsk(null), undefined)
  // 没有工具名时给一个通用名字，卡片仍然可读
  assert.equal(normalizeApprovalAsk({ approvalId: 'ap_2' }).toolName, '工具调用')
  // 只有 en 的本地化文案 / 只有机器原因
  assert.equal(approvalReasonText(normalizeApprovalAsk({ approvalId: 'a', displayReason: { en: 'Write a file' } })), 'Write a file')
  assert.equal(approvalReasonText(normalizeApprovalAsk({ approvalId: 'a', reason: 'write' })), 'write')
  assert.match(approvalReasonText(normalizeApprovalAsk({ approvalId: 'a' })), /需要你确认/)
})

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

test('two pending asks coexist and a resent ask updates instead of duplicating', () => {
  let list = []
  list = enqueueApproval(list, normalizeApprovalAsk({ approvalId: 'ap_1', toolName: 'bash', expiresAt: 10_000 }, 1))
  list = enqueueApproval(list, normalizeApprovalAsk({ approvalId: 'ap_2', toolName: 'write', expiresAt: 20_000 }, 2))
  assert.deepEqual(list.map(item => item.approvalId), ['ap_1', 'ap_2'])

  // 电脑端重发同一条（重连/重放）：更新，不新增
  list = enqueueApproval(list, normalizeApprovalAsk({ approvalId: 'ap_1', toolName: 'bash', expiresAt: 30_000 }, 3))
  assert.equal(list.length, 2)
  assert.equal(list[0].expiresAt, 30_000)
  assert.equal(list[0].receivedAt, 3)
})

test('the pending queue is bounded, dropping the oldest first', () => {
  let list = []
  for (let index = 0; index < MAX_PENDING_APPROVALS + 3; index += 1) {
    list = enqueueApproval(list, normalizeApprovalAsk({ approvalId: `ap_${index}`, toolName: 'bash' }, index))
  }
  assert.equal(list.length, MAX_PENDING_APPROVALS)
  assert.equal(list[list.length - 1].approvalId, `ap_${MAX_PENDING_APPROVALS + 2}`)
  assert.equal(list.some(item => item.approvalId === 'ap_0'), false)
})

test('resolving removes exactly one prompt and keeps the others', () => {
  const list = ['ap_1', 'ap_2', 'ap_3'].map(id => normalizeApprovalAsk({ approvalId: id, toolName: 'bash' }, 1))
  const next = resolveApproval(list, 'ap_2')
  assert.deepEqual(next.map(item => item.approvalId), ['ap_1', 'ap_3'])
  // 未知 id / 空 id 不改变数组引用（避免无意义的重渲染）
  assert.equal(resolveApproval(list, 'ap_9'), list)
  assert.equal(resolveApproval(list, ''), list)
  assert.deepEqual(resolveApproval([], 'ap_1'), [])
})

test('expiry pruning, remaining time and countdown text', () => {
  const list = ['ap_1', 'ap_2'].map(id => normalizeApprovalAsk({ approvalId: id, toolName: 'bash', expiresAt: 10_000 }, 1))
  const at5s = pruneExpiredApprovals(list, 5_000)
  assert.equal(at5s.length, 2)
  const at10s = pruneExpiredApprovals(list, 10_000)
  assert.deepEqual(at10s, [], '到点即过期，不等下一次帧')
  assert.equal(isExpired(list[0], 9_999), false)
  assert.equal(isExpired(list[0], 10_000), true)
  // 没有 expiresAt 的请求永不过期（坏数据也不能让卡片永远卡住流程 —— 它至少还能被回答）
  const noExpiry = normalizeApprovalAsk({ approvalId: 'ap_x', toolName: 'bash' }, 1)
  assert.equal(isExpired(noExpiry, 10 ** 9), false)
  assert.equal(approvalRemainingMs(list[0], 4_000), 6_000)
  assert.equal(approvalRemainingMs(list[0], 20_000), 0)
  assert.equal(approvalRemainingMs(noExpiry, 1), undefined)
  assert.equal(formatApprovalCountdown(42_000), '0:42')
  assert.equal(formatApprovalCountdown(60_000), '1:00')
  assert.equal(formatApprovalCountdown(0), '0:00')
  assert.equal(formatApprovalCountdown(undefined), '')
})

test('replying needs a live connection and the approval-v1 capability', () => {
  assert.equal(approvalAvailability(true, ['approval-v1']).ok, true)
  const offline = approvalAvailability(false, ['approval-v1'])
  assert.equal(offline.ok, false)
  assert.match(offline.hint, /电脑端/)
  const old = approvalAvailability(true, ['chat-echo-v1'])
  assert.equal(old.ok, false)
  assert.match(old.error, /版本较旧/)
  assert.equal(approvalAvailability(true, undefined).ok, false)
})

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

test('parallel approval asks queue up in the chat state without overwriting each other', () => {
  const state = run([
    { t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', reason: '执行命令', expiresAt: 60_000 },
    { t: 'approval/ask', approvalId: 'ap_2', toolName: 'write', reason: '写文件', expiresAt: 60_000 },
  ])
  assert.equal(state.approvals.length, 2)
  assert.deepEqual(
    state.approvals.map(item => item.approvalId),
    ['ap_1', 'ap_2'],
  )
  // ask 不往消息流里塞东西
  assert.equal(state.messages.length, 0)
})

test('approval/resolved dismisses only the answered card', () => {
  let state = run([
    { t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', expiresAt: 60_000 },
    { t: 'approval/ask', approvalId: 'ap_2', toolName: 'write', expiresAt: 60_000 },
  ])
  state = run([{ t: 'approval/resolved', approvalId: 'ap_1', outcome: 'allowed-once', source: 'phone' }], state)
  assert.deepEqual(
    state.approvals.map(item => item.approvalId),
    ['ap_2'],
  )
  // 重复的 resolved 是幂等的
  state = run([{ t: 'approval/resolved', approvalId: 'ap_1', outcome: 'allowed-once' }], state)
  assert.equal(state.approvals.length, 1)
})

test('an expired ask disappears on the local tick without waiting for a frame', () => {
  let state = run([{ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', expiresAt: 2_000 }], emptyChatState(ASSISTANT), 1_000)
  assert.equal(state.approvals.length, 1)
  // 电脑端到点会把提示交回桌面，之后不会再有帧：必须靠本地节拍清掉
  state = run([{ t: 'approval/tick' }], state, 5_000)
  assert.equal(state.approvals.length, 0)
})

test('disconnecting drops pending approvals (they can no longer be answered)', () => {
  const state = run([
    { t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', expiresAt: 60_000 },
    { t: 'conn/disconnected', reason: 'socket closed' },
  ])
  assert.equal(state.approvals.length, 0)
})

test('a malformed approval/ask never creates an unanswerable card', () => {
  const state = run([{ t: 'approval/ask', toolName: 'bash' }, { t: 'approval/ask', approvalId: '', toolName: 'bash' }])
  assert.equal(state.approvals.length, 0)
})
