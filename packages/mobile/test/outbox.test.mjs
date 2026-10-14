// 离线队列：重发、去重与放弃边界。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createOutbox,
  deserializeOutbox,
  enqueue,
  exhaustedEntries,
  getEntry,
  markFailed,
  markInflight,
  markSent,
  outboxSize,
  pendingCount,
  pruneOutbox,
  releaseInflight,
  resendableEntries,
  retryEntry,
  serializeOutbox,
} from '../src/core/outbox.mts'

function entry(rid, createdAt = 0) {
  return { rid, assistantId: 'cmp_1', callId: rid, text: `消息 ${rid}`, createdAt }
}

test('enqueue keeps one entry per rid (a double tap is not two messages)', () => {
  let outbox = createOutbox()
  outbox = enqueue(outbox, entry('r1'))
  outbox = enqueue(outbox, entry('r1', 5))
  assert.equal(outboxSize(outbox), 1)
  assert.equal(getEntry(outbox, 'r1').createdAt, 5)
  // 重复入队不能把重试次数清零，否则会无限重发
  outbox = markInflight(outbox, 'r1', 100)
  outbox = enqueue(outbox, entry('r1', 6))
  assert.equal(getEntry(outbox, 'r1').attempts, 1)
})

test('an ack removes the entry, a failure keeps it for retry', () => {
  let outbox = enqueue(createOutbox(), entry('r1'))
  outbox = markInflight(outbox, 'r1', 100)
  outbox = markSent(outbox, 'r1')
  assert.equal(outboxSize(outbox), 0)

  outbox = enqueue(outbox, entry('r2'))
  outbox = markInflight(outbox, 'r2', 100)
  outbox = markFailed(outbox, 'r2', '断线', 500)
  assert.equal(getEntry(outbox, 'r2').state, 'failed')
  assert.equal(getEntry(outbox, 'r2').error, '断线')
})

test('disconnect releases in-flight entries so they get resent', () => {
  let outbox = createOutbox()
  outbox = enqueue(outbox, entry('r1', 1))
  outbox = enqueue(outbox, entry('r2', 2))
  outbox = markInflight(outbox, 'r1', 100)
  outbox = markInflight(outbox, 'r2', 100)
  assert.deepEqual(resendableEntries(outbox, { now: 101 }).map(item => item.rid), [])
  outbox = releaseInflight(outbox)
  assert.deepEqual(resendableEntries(outbox, { now: 101 }).map(item => item.rid), ['r1', 'r2'])
  assert.equal(pendingCount(outbox), 2)
})

test('resend order follows enqueue order and respects backoff and attempt caps', () => {
  let outbox = createOutbox()
  outbox = enqueue(outbox, entry('r2', 20))
  outbox = enqueue(outbox, entry('r1', 10))
  outbox = enqueue(outbox, entry('r3', 30))
  outbox = markInflight(outbox, 'r3', 40)
  outbox = markFailed(outbox, 'r3', '失败', 10_000)
  assert.deepEqual(resendableEntries(outbox, { now: 50 }).map(item => item.rid), ['r1', 'r2'])
  // 退避时间没到之前不重发
  outbox = releaseInflight(outbox)
  assert.deepEqual(resendableEntries(outbox, { now: 50 }).map(item => item.rid), ['r1', 'r2'])

  // 达到自动重发上限后自动发不再尝试，但用户仍能手动重试
  let capped = enqueue(createOutbox(), entry('r9'))
  for (let i = 0; i < 3; i++) capped = markInflight(capped, 'r9', i)
  capped = releaseInflight(capped)
  assert.deepEqual(resendableEntries(capped, { now: 100, maxAttempts: 3 }), [])
  assert.deepEqual(exhaustedEntries(capped, 3).map(item => item.rid), ['r9'])
  capped = retryEntry(capped, 'r9')
  assert.equal(getEntry(capped, 'r9').state, 'pending')
  assert.equal(getEntry(capped, 'r9').error, undefined)
  assert.deepEqual(resendableEntries(capped, { now: 100, maxAttempts: 3 }).map(item => item.rid), [])
})

test('pruning never drops a message that still has to be sent', () => {
  let outbox = createOutbox(2)
  outbox = enqueue(outbox, entry('sent1', 1))
  outbox = markSent(outbox, 'sent1')
  // markSent 会移除条目，这里手工造一个“已发送但还在表里”的状态，模拟异常退出
  outbox = { ...outbox, entries: [{ ...entry('ghost', 2), state: 'sent', attempts: 1 }, ...outbox.entries] }
  outbox = enqueue(outbox, entry('pending1', 3))
  outbox = enqueue(outbox, entry('pending2', 4))
  const pruned = pruneOutbox(outbox)
  assert.equal(pruned.entries.some(item => item.rid === 'ghost'), false)
  assert.equal(pruned.entries.some(item => item.rid === 'pending1'), true)
  assert.equal(pruned.entries.some(item => item.rid === 'pending2'), true)
})

test('the queue survives a JSON round-trip and garbage fails safe', () => {
  let outbox = enqueue(createOutbox(), entry('r1'))
  outbox = markInflight(outbox, 'r1', 10)
  const restored = deserializeOutbox(serializeOutbox(outbox))
  // `undefined` 字段在 JSON 里会消失，所以按 JSON 归一化后的形状比较
  assert.deepEqual(JSON.parse(serializeOutbox(restored)), JSON.parse(serializeOutbox(outbox)))
  assert.equal(outboxSize(deserializeOutbox('not json')), 0)
  assert.equal(outboxSize(deserializeOutbox(null)), 0)
  assert.equal(outboxSize(deserializeOutbox('{"entries":[{"nope":1}]}')), 0)
})
