// 聊天 reducer：delta 聚合（乱序/重复）、done 权威覆盖、tool 活动行、
// 文件流、断线恢复与状态恢复。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_FILE_BYTES } from '../src/core/frames.mts'
import {
  assistantMessageId,
  deserializeChatState,
  emptyChatState,
  hydrateChat,
  isKnownServerFrame,
  reduceChat,
  serializeChatState,
  streamingCallIds,
  unconfirmedMessages,
  userMessageId,
} from '../src/core/reducer.mts'
import { chunkOf } from './helpers.mjs'

const ASSISTANT = 'cmp_abc123'

/** 依次应用事件，时间戳自动递增（同一毫秒会让“后到”的判定变得含糊）。 */
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

function runWithEffects(events, state = emptyChatState(ASSISTANT), start = 1000) {
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

function last(state) {
  return state.messages[state.messages.length - 1]
}

test('streaming deltas concatenate in order', () => {
  const state = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '你好' },
    { t: 'chat/delta', callId: 'c1', seq: 1, text: '，我是' },
    { t: 'chat/delta', callId: 'c1', seq: 2, text: '你的助理' },
  ])
  assert.equal(state.messages.length, 1)
  assert.equal(last(state).text, '你好，我是你的助理')
  assert.equal(last(state).streaming, true)
  assert.equal(last(state).deltaSeq, 2)
  assert.equal(state.callIndex.c1, assistantMessageId('c1'))
})

test('a repeated delta is dropped instead of appended twice', () => {
  const state = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: 'A' },
    { t: 'chat/delta', callId: 'c1', seq: 0, text: 'A' },
    { t: 'chat/delta', callId: 'c1', seq: 0, text: 'B' },
  ])
  assert.equal(last(state).text, 'A')
  assert.equal(last(state).deltaSeq, 0)
  assert.equal(state.gapCount, 0)
})

test('out-of-order deltas are buffered and flushed once the gap closes', () => {
  const state = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: 'a' },
    { t: 'chat/delta', callId: 'c1', seq: 2, text: 'c' },
    { t: 'chat/delta', callId: 'c1', seq: 1, text: 'b' },
    { t: 'chat/delta', callId: 'c1', seq: 3, text: 'd' },
  ])
  // 缺口期间文本会短暂停在 'a'，补齐后一次性变成 'abcd'
  assert.equal(last(state).text, 'abcd')
  assert.equal(last(state).deltaSeq, 3)
  assert.equal(last(state).deltaGaps, 1)
  assert.equal(state.gapCount, 1)
  assert.deepEqual(state.deltaBuffers.c1, {})
})

test('deltas arriving for a call never seen before create exactly one message', () => {
  const state = run([{ t: 'chat/delta', callId: 'c9', seq: 0, text: 'x' }])
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].kind, 'assistant')
  assert.equal(state.messages[0].id, 'msg_c9')
})

test('chat/done is authoritative and replaces whatever deltas produced', () => {
  const { state } = runWithEffects([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '残缺' },
    { t: 'chat/delta', callId: 'c1', seq: 1, text: '的内容' },
    { t: 'chat/done', callId: 'c1', text: '完整的回答', truncated: true, durationMs: 1234 },
    // done 之后迟到的增量必须被忽略，否则会污染权威文本
    { t: 'chat/delta', callId: 'c1', seq: 2, text: '（不该出现）' },
  ])
  assert.equal(last(state).text, '完整的回答')
  assert.equal(last(state).streaming, false)
  assert.equal(last(state).truncated, true)
  assert.equal(last(state).durationMs, 1234)
  assert.equal(last(state).deltaGaps, undefined)
})

test('tool frames become small activity rows and never touch assistant text', () => {
  const state = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '好的' },
    { t: 'chat/tool', callId: 'c1', phase: 'tool-start', toolCallId: 'tc1', tool: 'read_file', summary: '正在读取文件…' },
    // 同一个工具的同一次调用重复上报：只更新，不新增
    { t: 'chat/tool', callId: 'c1', phase: 'tool-start', toolCallId: 'tc1', tool: 'read_file', summary: '正在读取文件…' },
    { t: 'chat/tool', callId: 'c1', phase: 'tool-end', toolCallId: 'tc1', tool: 'read_file', ok: true },
    { t: 'chat/delta', callId: 'c1', seq: 1, text: '看完了' },
  ])
  const message = last(state)
  assert.equal(message.text, '好的看完了')
  assert.equal(message.activity.length, 2)
  assert.equal(message.activity[0].phase, 'tool-start')
  assert.equal(message.activity[0].summary, '正在读取文件…')
  assert.equal(message.activity[1].phase, 'tool-end')
  assert.equal(message.activity[1].ok, true)
  // 活动行的文本绝不能混进正文
  assert.equal(message.text.includes('正在读取文件'), false)
})

test('typing indicator tracks the call and clears on done', () => {
  let state = run([{ t: 'chat/typing', callId: 'c1', active: true }])
  assert.deepEqual(state.typing, { callId: 'c1', active: true })
  state = run([{ t: 'chat/done', callId: 'c1', text: '好了' }], state)
  assert.equal(state.typing, null)
  // 没有 active 字段时按“正在输入”处理
  state = run([{ t: 'chat/typing', callId: 'c2' }], state)
  assert.deepEqual(state.typing, { callId: 'c2', active: true })
})

test('disconnect marks in-flight answers as interrupted but keeps them streamable', () => {
  let state = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '正在' },
    { t: 'conn/disconnected', reason: 'socket closed' },
  ])
  assert.equal(last(state).interrupted, true)
  assert.equal(last(state).streaming, true)
  assert.equal(state.typing, null)
  // 重连后同一次回答继续推 delta：中断标记要被清掉
  state = run([{ t: 'chat/delta', callId: 'c1', seq: 1, text: '继续' }], state)
  assert.equal(last(state).text, '正在继续')
  assert.equal(last(state).interrupted, false)
})

test('user messages are idempotent by rid and follow the ack lifecycle', () => {
  let state = run([
    { t: 'user/send', rid: 'r1', text: '帮我看下构建失败的原因', at: 10, files: [{ fileId: 'up1', name: 'log.txt', size: 12 }] },
    // 同一条消息被重发（离线队列）时不能变成两条气泡
    { t: 'user/send', rid: 'r1', text: '帮我看下构建失败的原因', at: 11 },
  ])
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].id, userMessageId('r1'))
  assert.equal(state.messages[0].files.length, 1)
  assert.equal(state.messages[0].state, 'pending')

  state = run([{ t: 'chat/ack', rid: 'r1', callId: 'c1' }], state)
  assert.equal(state.messages[0].state, 'sent')
  assert.equal(state.messages[0].callId, 'c1')
})

test('failed sends can be retried and remembered as failed', () => {
  let state = run([{ t: 'user/send', rid: 'r1', text: 'hi', at: 1 }])
  state = run([{ t: 'outbox/failed', rid: 'r1', reason: '手机没有网络' }], state)
  assert.equal(state.messages[0].state, 'failed')
  assert.equal(state.messages[0].error, '手机没有网络')
  assert.equal(unconfirmedMessages(state).length, 1)
  state = run([{ t: 'outbox/retry', rid: 'r1' }], state)
  assert.equal(state.messages[0].state, 'pending')
  assert.equal(state.messages[0].attempts, 1)
})

test('a cancelled request is visible in the timeline', () => {
  const state = run([
    { t: 'user/send', rid: 'r1', text: 'hi', at: 1 },
    { t: 'chat/ack', rid: 'r1', cancelled: true },
  ])
  assert.equal(last(state).kind, 'system')
  assert.match(last(state).text, /已取消/)
})

test('chat errors attach to the answer when a callId is known, otherwise become a system line', () => {
  const attached = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '部分' },
    { t: 'chat/error', callId: 'c1', message: '模型调用失败', retryable: true },
  ])
  assert.equal(last(attached).error, '模型调用失败')
  assert.equal(last(attached).streaming, false)
  assert.equal(last(attached).text, '部分')

  const detached = run([{ t: 'chat/error', message: '电脑端内部错误' }])
  assert.equal(detached.messages.length, 1)
  assert.equal(detached.messages[0].kind, 'system')
  assert.equal(detached.messages[0].level, 'error')
})

test('unknown frames are ignored without disturbing state', () => {
  const state = run([{ t: 'chat/delta', callId: 'c1', seq: 0, text: 'A' }])
  const result = reduceChat(state, { t: 'some/future-frame', payload: 1 }, 5000)
  assert.equal(result.state, state)
  assert.deepEqual(result.effects, [])
  assert.equal(isKnownServerFrame({ t: 'chat/delta' }), true)
  assert.equal(isKnownServerFrame({ t: 'some/future-frame' }), false)
  assert.equal(isKnownServerFrame(null), false)
})

test('the receiving side of a file: offered → requested → downloading → done', () => {
  const file = { fileId: 'f1', name: '构建报告.pdf', size: 6, mime: 'application/pdf' }
  let { state, effects } = runWithEffects([{ t: 'chat/done', callId: 'c1', text: '报告给你', files: [file] }])
  assert.equal(state.transfers.f1.status, 'offered')
  assert.equal(state.transfers.f1.name, '构建报告.pdf')

  ;({ state, effects } = runWithEffects([{ t: 'transfer/request', fileId: 'f1' }], state))
  assert.equal(state.transfers.f1.status, 'queued')
  assert.deepEqual(effects, [{ kind: 'fetch-file', fileId: 'f1' }])

  ;({ state, effects } = runWithEffects([{ t: 'file/meta', fileId: 'f1', name: '构建报告.pdf', size: 6, mime: 'application/pdf' }], state))
  assert.equal(state.transfers.f1.status, 'downloading')

  ;({ state, effects } = runWithEffects([{ t: 'file/chunk', fileId: 'f1', seq: 0, dataBase64: chunkOf(6) }], state))
  assert.equal(state.transfers.f1.receivedBytes, 6)
  assert.equal(state.transfers.f1.nextSeq, 1)
  assert.equal(effects.length, 1)
  assert.equal(effects[0].kind, 'file-chunk')

  // 重复分块：丢弃，不计数也不写盘
  const beforeBytes = state.transfers.f1.receivedBytes
  ;({ state, effects } = runWithEffects([{ t: 'file/chunk', fileId: 'f1', seq: 0, dataBase64: chunkOf(6) }], state))
  assert.deepEqual(effects, [])
  assert.equal(state.transfers.f1.receivedBytes, beforeBytes)

  ;({ state, effects } = runWithEffects([{ t: 'file/end', fileId: 'f1' }], state))
  assert.equal(state.transfers.f1.status, 'done')
  assert.deepEqual(effects, [{ kind: 'file-complete', fileId: 'f1' }])
})

test('a chunk gap aborts the transfer instead of producing a corrupt file', () => {
  const { state, effects } = runWithEffects([
    { t: 'file/meta', fileId: 'f2', name: 'a.zip', size: 10 },
    { t: 'file/chunk', fileId: 'f2', seq: 1, dataBase64: chunkOf(4) },
  ])
  assert.equal(state.transfers.f2.status, 'failed')
  assert.match(state.transfers.f2.error, /序号跳变/)
  assert.equal(effects[0].kind, 'file-abort')
})

test('an incomplete transfer is reported as failed, not silently saved', () => {
  const { state, effects } = runWithEffects([
    { t: 'file/meta', fileId: 'f3', name: 'big.bin', size: 100 },
    { t: 'file/chunk', fileId: 'f3', seq: 0, dataBase64: chunkOf(6) },
    { t: 'file/end', fileId: 'f3' },
  ])
  assert.equal(state.transfers.f3.status, 'failed')
  assert.match(state.transfers.f3.error, /不完整/)
  assert.equal(effects[effects.length - 1].kind, 'file-abort')
})

test('files beyond the protocol limit are refused before any bytes are copied', () => {
  const { state, effects } = runWithEffects([
    { t: 'file/meta', fileId: 'f4', name: 'huge.iso', size: MAX_FILE_BYTES + 1 },
  ])
  assert.equal(state.transfers.f4.status, 'too-large')
  assert.deepEqual(effects, [{ kind: 'file-abort', fileId: 'f4', reason: 'too-large' }])
  // 超大文件不允许再进入下载流程
  const retry = runWithEffects([{ t: 'transfer/request', fileId: 'f4' }], state)
  assert.deepEqual(retry.effects, [])
})

test('chunks without metadata and server-side errors abort cleanly', () => {
  const orphan = runWithEffects([{ t: 'file/chunk', fileId: 'nope', seq: 0, dataBase64: chunkOf(3) }])
  assert.deepEqual(orphan.effects, [{ kind: 'file-abort', fileId: 'nope', reason: 'missing-meta' }])

  const errored = runWithEffects([
    { t: 'file/meta', fileId: 'f5', name: 'x.txt', size: 9 },
    { t: 'file/error', fileId: 'f5', code: 'unreadable', message: '无法读取文件' },
  ])
  assert.equal(errored.state.transfers.f5.status, 'failed')
  assert.equal(errored.state.transfers.f5.error, '无法读取文件')
})

test('downloads can be cancelled and the cancel is propagated as an effect', () => {
  const { state, effects } = runWithEffects([
    { t: 'file/meta', fileId: 'f6', name: 'x.txt', size: 30 },
    { t: 'transfer/cancel', fileId: 'f6' },
  ])
  assert.equal(state.transfers.f6.status, 'cancelled')
  assert.deepEqual(effects, [{ kind: 'cancel-file', fileId: 'f6' }])
})

test('a saved path is recorded so the file card can open it', () => {
  const state = run([
    { t: 'file/meta', fileId: 'f7', name: 'x.txt', size: 4 },
    { t: 'file/chunk', fileId: 'f7', seq: 0, dataBase64: chunkOf(4) },
    { t: 'file/end', fileId: 'f7' },
    { t: 'transfer/saved', fileId: 'f7', path: 'file:///data/user/0/dev.openwhale/files/downloads/x.txt' },
  ])
  assert.equal(state.transfers.f7.localPath, 'file:///data/user/0/dev.openwhale/files/downloads/x.txt')
  assert.equal(state.transfers.f7.status, 'done')
})

test('reload restores the sequence position so deltas are not duplicated after a restart', () => {
  const persisted = [
    { id: 'usr_r1', kind: 'user', text: '在吗', at: 1, rid: 'r1', state: 'sent' },
    { id: 'msg_c1', kind: 'assistant', text: '在，', at: 2, callId: 'c1', streaming: true, deltaSeq: 5 },
  ]
  const persistedTransfers = [
    { fileId: 'f1', name: 'x', size: 10, status: 'downloading', receivedBytes: 4, nextSeq: 1, chunks: 1, updatedAt: 1 },
  ]
  let state = hydrateChat(ASSISTANT, persisted, persistedTransfers, 100)

  assert.equal(state.callIndex.c1, 'msg_c1')
  assert.equal(state.lastSeq.c1, 5)
  assert.equal(state.messages[1].interrupted, true)
  // 重启后不可能继续未完成的下载：标失败，用户可重新点下载
  assert.equal(state.transfers.f1.status, 'failed')
  assert.equal(streamingCallIds(state).length, 1)

  // 续上：seq 6 是新的，seq 3 是旧的要被丢弃
  state = run([{ t: 'chat/delta', callId: 'c1', seq: 6, text: '好' }], state, 200)
  assert.equal(state.messages[1].text, '在，好')
  state = run([{ t: 'chat/delta', callId: 'c1', seq: 3, text: '（不该出现）' }], state, 210)
  assert.equal(state.messages[1].text, '在，好')

  // 断线/重启后的状态必须能安全地 JSON 往返
  const restored = deserializeChatState(serializeChatState(state), ASSISTANT, 300)
  assert.equal(restored.messages.length, 2)
  assert.equal(restored.lastSeq.c1, 6)
  assert.equal(restored.messages[1].text, '在，好')
})

test('hydrate sorts by time and ignores unusable records', () => {
  const state = hydrateChat(
    ASSISTANT,
    [
      { id: 'b', kind: 'assistant', text: '后', at: 20, callId: 'c2' },
      { id: 'a', kind: 'user', text: '先', at: 10, rid: 'r1' },
      null,
    ],
    [],
    0,
  )
  assert.deepEqual(
    state.messages.map(message => message.id),
    ['a', 'b'],
  )
})

test('deserializing garbage yields an empty state instead of throwing', () => {
  const state = deserializeChatState('{not json', ASSISTANT)
  assert.equal(state.messages.length, 0)
  assert.equal(state.assistantId, ASSISTANT)
})
