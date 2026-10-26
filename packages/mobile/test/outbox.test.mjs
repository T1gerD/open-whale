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
  markUploaded,
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
  // attempts 的语义是「有过几次**未获确认**的发送」：只有在条目退回 pending 时
  // 才累加（写进 socket 但没等到 ack 的也算一次），所以这里仍是 0。
  outbox = enqueue(outbox, entry('r1', 6))
  assert.equal(getEntry(outbox, 'r1').attempts, 0)
  // 断线让飞行中的条目退回 pending，这一次才算作了用掉一次机会。
  outbox = releaseInflight(outbox)
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
  // 每轮「飞行中 → 断线退回」才算一次尝试，所以 3 轮之后 attempts = 3。
  let capped = enqueue(createOutbox(), entry('r9'))
  for (let i = 0; i < 3; i++) {
    capped = markInflight(capped, 'r9', i)
    capped = releaseInflight(capped)
  }
  assert.equal(getEntry(capped, 'r9').attempts, 3)
  assert.deepEqual(resendableEntries(capped, { now: 100, maxAttempts: 3 }), [])
  assert.deepEqual(exhaustedEntries(capped, 3).map(item => item.rid), ['r9'])
  capped = retryEntry(capped, 'r9')
  assert.equal(getEntry(capped, 'r9').state, 'pending')
  assert.equal(getEntry(capped, 'r9').error, undefined)
  // 手动重试是**用户的明确意图**，所以它会把计数真正清零、重新给满配额；
  // 与「自动重发达到上限就放弃」并不矛盾：自动放弃是为了不无限刷，
  // 手动重试是用户主动要求再试一次。
  assert.equal(getEntry(capped, 'r9').attempts, 0)
  assert.deepEqual(resendableEntries(capped, { now: 100, maxAttempts: 3 }).map(item => item.rid), ['r9'])
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

test('entries are addressable by msgId as well as rid (chat/ack may only carry one)', () => {
  let outbox = enqueue(createOutbox(), { ...entry('r1'), msgId: 'm1' })
  outbox = markInflight(outbox, 'm1', 100)
  assert.equal(getEntry(outbox, 'm1').state, 'inflight')
  outbox = markSent(outbox, 'm1')
  assert.equal(outboxSize(outbox), 0)
})

test('uploaded attachments are remembered so a retry does not upload twice', () => {
  let outbox = enqueue(createOutbox(), {
    ...entry('r1'),
    files: [{ name: 'photo.jpg', mime: 'image/jpeg', size: 2048, uri: 'file:///tmp/photo.jpg' }],
  })
  outbox = markUploaded(outbox, 'r1', [{ index: 0, uploadId: 'upl_1', name: 'photo.jpg', size: 2048, mime: 'image/jpeg' }])
  // 重复记录同一个 uploadId 不会产生两条
  outbox = markUploaded(outbox, 'r1', [{ index: 0, uploadId: 'upl_1', name: 'photo.jpg', size: 2048, mime: 'image/jpeg' }])
  assert.deepEqual(getEntry(outbox, 'r1').uploads, [
    { index: 0, uploadId: 'upl_1', name: 'photo.jpg', size: 2048, mime: 'image/jpeg' },
  ])
  const restored = deserializeOutbox(serializeOutbox(outbox))
  assert.equal(restored.entries[0].files[0].uri, 'file:///tmp/photo.jpg')
  assert.equal(restored.entries[0].uploads[0].uploadId, 'upl_1')
})

test('legacy inline attachments and unknown states are normalised on restore', () => {
  const raw = JSON.stringify({
    entries: [
      {
        rid: 'r_old',
        assistantId: 'cmp_1',
        text: '老消息',
        files: [{ name: 'a.txt', mime: 'text/plain', dataBase64: 'QUFB' }],
        state: 'weird-state',
        attempts: 'nope',
      },
    ],
  })
  const outbox = deserializeOutbox(raw)
  assert.equal(outbox.entries.length, 1)
  assert.equal(outbox.entries[0].state, 'pending')
  assert.equal(outbox.entries[0].attempts, 0)
  assert.equal(outbox.entries[0].files[0].dataBase64, 'QUFB')
})
