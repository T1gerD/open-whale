// 同步层（快照 generation + 重放缓冲）与「正文只增不退」的回归测试。
//
// 这些用例对应真机上最难复现的三类症状：
//   · 点发送后气泡延迟出现 / 先出现又消失；
//   · 工具行出来了但正文空白，或回复整体被吞；
//   · 回复完成后被一份晚到的快照回滚（62 → 60）。
//
// 修法不是再加一层兜底，而是给「会话列表」一个全序：同步期间实时帧进 buffer，
// 快照落地后按到达顺序重放；比已知水位更旧的快照直接丢弃。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ChatModel, MESSAGE_STATUS, assistantMessageId, userMessageId } from '../lib/messages.mjs'

const NOW = Date.parse('2026-11-12T10:00:00.000Z')

/** @returns {ChatModel} */
function makeModel() {
  const model = new ChatModel()
  model.setDeviceId('dev_a')
  return model
}

/** 一条快照帧（head 是插件事件日志水位）。 */
function snapshotFrame({ sessionId = 'sess_1', sessionEpoch = 0, head = 0, messages = [], activeCall } = {}) {
  return {
    t: 'session/state',
    sessionId,
    sessionEpoch,
    head,
    snapshot: { messages, ...(activeCall ? { activeCall } : {}) },
  }
}

/**
 * 回放日志：断言「消息数单调、assistant 正文不回退、done 非空、无重复 id」。
 * 这就是把 openwhale.log 里的快照 + 事件序列喂给模型的等价物。
 * @param {ChatModel} model
 * @returns {(label: string) => void}
 */
function assertInvariants(model) {
  let previousCount = 0
  /** @type {Map<string, string>} */
  const assistantText = new Map()
  return label => {
    const ids = new Set()
    for (const message of model.messages) {
      assert.equal(ids.has(message.id), false, `${label}: 出现重复消息 id ${message.id}`)
      ids.add(message.id)
      if (message.kind !== 'assistant') continue
      const before = assistantText.get(message.id)
      if (before !== undefined) {
        assert.ok(
          String(message.text ?? '').length >= before.length,
          `${label}: assistant 正文回退（${before.length} → ${String(message.text ?? '').length}）`,
        )
      }
      assistantText.set(message.id, String(message.text ?? ''))
      if (message.status === MESSAGE_STATUS.DONE) {
        assert.ok(String(message.text ?? '').trim() !== '', `${label}: 收尾的 assistant 消息正文为空`)
      }
    }
    assert.ok(model.messages.length >= previousCount, `${label}: 消息数减少（${previousCount} → ${model.messages.length}）`)
    previousCount = model.messages.length
  }
}

test('同步期间的实时帧先进 buffer，快照落地后按到达顺序重放', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  model.cursor = 10
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_b', text: '早先的问题', at: '2026-11-12T09:59:00.000Z', seq: 10 })

  const generation = model.beginSync({ reason: 'reconnect' })
  assert.equal(model.isSyncing, true)

  // 快照还在路上：这两帧不能直接改列表。
  model.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_a', text: '刚发的问题', at: '2026-11-12T10:00:01.000Z', seq: 11 })
  model.applyFrame({ t: 'chat/message', callId: 'c2', messageId: 'a1', index: 0, text: '正在回答', seq: 12 })
  assert.equal(model.messages.length, 1, '同步期间到达的帧不能直接进列表')
  assert.equal(model.syncBuffer.length, 2)

  const snapshot = snapshotFrame({
    head: 10,
    messages: [{ id: 'hist_10', kind: 'user', text: '早先的问题', seq: 10, at: '2026-11-12T09:59:00.000Z' }],
  })
  const result = model.applyFrame(snapshot)
  assert.equal(result.changed, true)
  assert.equal(model.isSyncing, false, '快照落地后必须回到 ready')
  assert.deepEqual(
    model.messages.map(message => message.text),
    ['早先的问题', '刚发的问题', '正在回答'],
    'buffer 必须按到达顺序重放',
  )
  assert.equal(model.messages[1].status, MESSAGE_STATUS.SENT)
  assert.equal(model.messages[2].status, MESSAGE_STATUS.STREAMING)
  assert.equal(model.cursor, 12, 'cursor 必须推进到重放后的最大 seq')
  assert.equal(model.endSync(generation), false, '已经结束的同步不能再次结束')
})

test('旧 generation 的快照直接丢弃（多标签同时同步不会互相覆盖）', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  model.beginSync({ reason: 'snapshot', rid: 'snap-1' })
  model.beginSync({ reason: 'snapshot', rid: 'snap-2' })
  model.applyFrame({ t: 'chat/message', callId: 'c9', messageId: 'a1', index: 0, text: '新帧', seq: 3 })

  const stale = model.applyFrame({ ...snapshotFrame({ head: 3, messages: [] }), rid: 'snap-1' })
  assert.equal(stale.stale, true)
  assert.equal(model.messages.length, 0, '旧代快照不能改列表')
  assert.equal(model.isSyncing, true, '当前这一代还在等快照')

  const fresh = model.applyFrame({ ...snapshotFrame({ head: 2, messages: [] }), rid: 'snap-2' })
  assert.equal(fresh.changed, true)
  assert.equal(model.isSyncing, false)
  assert.deepEqual(model.messages.map(message => message.text), ['新帧'], '实时帧在快照之后重放')
})

test('已有底座时，比已知水位更旧的快照不能把回复回滚（62 → 60）', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  // 页面加载时先落一份底座（水位 60）。真机上这份底座一定存在：它是首屏的历史。
  model.applyFrame(snapshotFrame({
    head: 60,
    messages: [{ id: 'hist_60', kind: 'user', msgId: 'm60', text: '问题', seq: 60, at: '2026-11-12T09:00:00.000Z' }],
  }))
  assert.equal(model.cursor, 60)
  // 本地已经有 60..62 的实时帧（其中 62 是一条完整回复）。
  model.applyFrame({ t: 'chat/echo', msgId: 'm60', deviceId: 'dev_a', text: '问题', at: '2026-11-12T09:00:00.000Z', seq: 60 })
  model.applyFrame({ t: 'chat/message', callId: 'c61', messageId: 'a1', index: 0, text: '回答', seq: 61 })
  model.applyFrame({ t: 'chat/done', callId: 'c61', text: '完整回答', seq: 62 })
  assert.equal(model.messages.length, 2, 'echo 回来不能变成两条同文本气泡')
  const before = model.messages.map(message => `${message.id}:${message.text}`)

  const late = model.applyFrame({
    ...snapshotFrame({
      head: 60,
      messages: [{ id: 'hist_60', kind: 'user', msgId: 'm60', text: '问题', seq: 60, at: '2026-11-12T09:00:00.000Z' }],
    }),
  })
  assert.equal(late.stale, true)
  assert.deepEqual(model.messages.map(message => `${message.id}:${message.text}`), before, '晚到的旧快照不能改列表')
  assert.equal(model.messages.at(-1).text, '完整回答')
})

test('还没有底座时，head 落后于实时帧的快照也必须接收（否则历史全丢）', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  // 冷启动只收到一帧实时消息（水 5），快照来得更早（水位 3），但它带着全部历史。
  model.applyFrame({ t: 'chat/echo', msgId: 'm5', deviceId: 'dev_a', text: '刚发的问题', at: '2026-11-12T10:00:00.000Z', seq: 5 })
  const result = model.applyFrame(snapshotFrame({
    head: 3,
    messages: [
      { id: 'hist_1', kind: 'user', text: '很早的问题', seq: 1, at: '2026-11-12T09:00:00.000Z' },
      { id: 'hist_3', kind: 'assistant', text: '很早的回答', seq: 3, at: '2026-11-12T09:00:05.000Z' },
    ],
  }))
  assert.equal(result.stale, undefined, '没有底座时不能把快照当成回退丢掉')
  assert.deepEqual(
    model.messages.map(message => message.text),
    ['很早的问题', '很早的回答', '刚发的问题'],
    '历史来自快照，比 head 新的实时消息接在后面',
  )
  assert.equal(model.cursor, 5, 'cursor 不能被旧快照拉回去')
})

test('回放日志：消息数单调、正文不回退、done 非空、无重复 id', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  const check = assertInvariants(model)

  // 1. 首次快照：两条历史。
  model.applyFrame(snapshotFrame({
    head: 20,
    messages: [
      { id: 'hist_18', kind: 'user', msgId: 'm18', text: '早上好', seq: 18, at: '2026-11-12T08:00:00.000Z' },
      { id: 'hist_20', kind: 'assistant', text: '早上好，有什么要做的？', seq: 20, at: '2026-11-12T08:00:02.000Z' },
    ],
  }))
  check('首份快照')
  const baseline = model.messages.length
  assert.equal(baseline, 2)

  // 2. 用户发消息（乐观上屏）→ ack → echo。
  model.addLocalUserMessage({ msgId: 'm21', text: '看下这个报错', at: '2026-11-12T09:00:00.000Z' })
  check('乐观消息')
  model.applyFrame({ t: 'chat/ack', rid: 'm21', callId: 'c21' })
  model.applyFrame({ t: 'chat/echo', msgId: 'm21', deviceId: 'dev_a', text: '看下这个报错', at: '2026-11-12T09:00:00.000Z', seq: 21 })
  check('echo 落位')

  // 3. 一轮流式回答：空占位 → delta → done。
  model.applyFrame({ t: 'chat/message', callId: 'c21', messageId: 'a1', index: 0, text: '', seq: 22 })
  model.applyFrame({ t: 'chat/delta', callId: 'c21', seq: 23, text: '先看一下' })
  model.applyFrame({ t: 'chat/delta', callId: 'c21', seq: 24, text: '日志。' })
  model.applyFrame({ t: 'chat/tool', callId: 'c21', toolCallId: 't1', tool: 'read_file', phase: 'tool-start' })
  model.applyFrame({ t: 'chat/tool', callId: 'c21', toolCallId: 't1', tool: 'read_file', phase: 'tool-end', ok: true, summary: '读了 1 个文件' })
  model.applyFrame({ t: 'chat/done', callId: 'c21', text: '先看一下日志。问题在空快照覆盖。', seq: 25 })
  check('流式收尾')
  const answer = model.messages.find(message => message.kind === 'assistant' && message.callId === 'c21')
  assert.equal(answer.status, MESSAGE_STATUS.DONE)
  assert.equal(answer.text, '先看一下日志。问题在空快照覆盖。')
  assert.equal(answer.tools.length, 1, '工具流要挂在同一条气泡上')

  // 4. 重连：先进入 syncing，期间又来了一帧；随后快照（水位落后于那帧）。
  model.beginSync({ reason: 'reconnect' })
  model.applyFrame({ t: 'chat/echo', msgId: 'm26', deviceId: 'dev_b', text: '桌面上补一句', at: '2026-11-12T09:05:00.000Z', seq: 26 })
  check('同步中')
  model.applyFrame(snapshotFrame({
    head: 25,
    messages: [
      { id: 'hist_18', kind: 'user', msgId: 'm18', text: '早上好', seq: 18, at: '2026-11-12T08:00:00.000Z' },
      { id: 'hist_20', kind: 'assistant', text: '早上好，有什么要做的？', seq: 20, at: '2026-11-12T08:00:02.000Z' },
      { id: 'hist_21', kind: 'user', msgId: 'm21', text: '看下这个报错', seq: 21, at: '2026-11-12T09:00:00.000Z' },
      { id: 'hist_25', kind: 'assistant', text: '先看一下日志。问题在空快照覆盖。', seq: 25, at: '2026-11-12T09:01:00.000Z' },
    ],
  }))
  check('快照 + 重放')
  assert.deepEqual(
    model.messages.map(message => message.text),
    ['早上好', '早上好，有什么要做的？', '看下这个报错', '先看一下日志。问题在空快照覆盖。', '桌面上补一句'],
    '快照里的历史 + 同步期间的新帧，顺序必须与事件日志一致',
  )
  assert.equal(model.messages.filter(message => message.text === '看下这个报错').length, 1, '同一条用户消息不能出现两遍')
  assert.equal(model.messages.at(-1).id, userMessageId('m26'))

  // 5. 再来一份完全相同的快照：幂等。
  model.applyFrame(snapshotFrame({
    head: 25,
    messages: [
      { id: 'hist_18', kind: 'user', msgId: 'm18', text: '早上好', seq: 18, at: '2026-11-12T08:00:00.000Z' },
      { id: 'hist_20', kind: 'assistant', text: '早上好，有什么要做的？', seq: 20, at: '2026-11-12T08:00:02.000Z' },
      { id: 'hist_21', kind: 'user', msgId: 'm21', text: '看下这个报错', seq: 21, at: '2026-11-12T09:00:00.000Z' },
      { id: 'hist_25', kind: 'assistant', text: '先看一下日志。问题在空快照覆盖。', seq: 25, at: '2026-11-12T09:01:00.000Z' },
    ],
  }))
  check('重复快照')
  assert.equal(model.messages.length, 5, '重复快照不能翻倍，也不能丢掉比 head 更新的那条')
})

test('空 chat/message 占位不吞后续 chat/delta', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  // 只有「这一轮开始了」的占位，没有正文。
  model.applyFrame({ t: 'chat/message', callId: 'c30', messageId: 'p1', index: 0, text: '', seq: 30 })
  assert.equal(model.messages.length, 1)
  assert.equal(model.messages[0].text, '')
  model.applyFrame({ t: 'chat/delta', callId: 'c30', seq: 31, text: '正文' })
  model.applyFrame({ t: 'chat/delta', callId: 'c30', seq: 32, text: '来了' })
  assert.equal(model.messages[0].text, '正文来了', '空占位不能登记成「已收到全文」')
  model.applyFrame({ t: 'chat/done', callId: 'c30', text: '正文来了', seq: 33 })
  assert.equal(model.messages[0].status, MESSAGE_STATUS.DONE)
  assert.equal(model.messages[0].text, '正文来了')
})

test('快照先标 DONE 时，迟到的正文可以补入（只增不退）', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  // 快照把这条回答标成 DONE 且正文为空（工具已结束、正文还没落库）。
  model.applyFrame(snapshotFrame({
    head: 40,
    messages: [{ id: 'hist_40', kind: 'assistant', callId: 'c40', text: '', seq: 40, at: '2026-11-12T10:00:00.000Z' }],
  }))
  const message = model.messages[0]
  assert.equal(message.status, MESSAGE_STATUS.DONE)
  assert.equal(message.text, '')

  model.applyFrame({ t: 'chat/message', callId: 'c40', messageId: 'a1', index: 0, text: '迟到的正文', seq: 41 })
  assert.equal(message.text, '迟到的正文', 'DONE 不能挡住迟到的正文')
  assert.equal(message.status, MESSAGE_STATUS.DONE)
  assert.equal(model.messages.length, 1, '不能多出一条重复的助手消息')
  assert.equal(model.messages[0].id, assistantMessageId('c40'))

  // 更短的正文不能把已有正文改短。
  model.applyFrame({ t: 'chat/message', callId: 'c40', messageId: 'a1', index: 0, text: '短文', seq: 42 })
  assert.equal(message.text, '迟到的正文')
})

test('快照重置后，未确认的本地消息仍然在，且不会重复', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  model.addLocalUserMessage({ msgId: 'm50', text: '这条还在队列里', at: '2026-11-12T10:00:00.000Z' })
  model.beginSync({ reason: 'snapshot' })
  model.applyFrame(snapshotFrame({
    head: 49,
    messages: [{ id: 'hist_49', kind: 'user', msgId: 'm49', text: '历史消息', seq: 49, at: '2026-11-12T09:59:00.000Z' }],
  }))
  assert.deepEqual(model.messages.map(message => message.text), ['历史消息', '这条还在队列里'])
  assert.equal(model.messages[1].optimistic, true)

  // 送去重：echo 回来（同一 msgId）只更新那一条。
  model.applyFrame({ t: 'chat/echo', msgId: 'm50', deviceId: 'dev_a', text: '这条还在队列里', at: '2026-11-12T10:00:00.000Z', seq: 50 })
  assert.equal(model.messages.length, 2)
  assert.equal(model.messages[1].optimistic, false)
})

test('同步超时兜底：endSync 之后实时帧不再被缓冲', () => {  const model = makeModel()
  model.sessionId = 'sess_1'
  const generation = model.beginSync({ reason: 'hello' })
  model.applyFrame({ t: 'chat/echo', msgId: 'm60', deviceId: 'dev_b', text: '缓冲里', at: '2026-11-12T10:00:00.000Z', seq: 1 })
  assert.equal(model.messages.length, 0)
  assert.equal(model.endSync(generation), true)
  assert.deepEqual(model.messages.map(message => message.text), ['缓冲里'])
  model.applyFrame({ t: 'chat/echo', msgId: 'm61', deviceId: 'dev_b', text: '直接进', at: '2026-11-12T10:00:01.000Z', seq: 2 })
  assert.equal(model.messages.length, 2, 'ready 之后不再缓冲')
})

test('比快照更新的本地消息钉在快照之后（两套序号不能混着比大小）', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  // 实时帧：插件事件日志序号（小）。
  model.applyFrame({ t: 'chat/echo', msgId: 'm60', deviceId: 'dev_a', text: '刚发的', at: '2026-11-12T10:00:00.000Z', seq: 60 })
  // 快照历史：DSH 事件序号（大得多），水位 59 落后于那条实时帧。
  model.applyFrame(snapshotFrame({
    head: 59,
    messages: [
      { id: 'hist_4800', kind: 'user', text: '很早的问题', seq: 4800, at: '2026-11-12T09:00:00.000Z' },
      { id: 'hist_4802', kind: 'assistant', text: '很早的回答', seq: 4802, at: '2026-11-12T09:00:05.000Z' },
    ],
  }))
  assert.deepEqual(
    model.messages.map(message => message.text),
    ['很早的问题', '很早的回答', '刚发的'],
    'seq 60 < 4800，但那条消息比快照新，必须排在最后而不是跳到最前',
  )
  assert.equal(model.messages.at(-1).tail, true)
})

test('有底座之后发出的提问（乐观 → echo）排在历史之后、回答之前', () => {
  const model = makeModel()
  model.sessionId = 'sess_1'
  // 底座：`head` 是插件事件日志水位（很小）；历史消息的 seq 是 DSH 事件序号（很大）。
  model.applyFrame(snapshotFrame({
    head: 4,
    messages: [
      { id: 'hist_4800', kind: 'user', msgId: 'm0', text: '很早的问题', seq: 4800, at: '2026-11-12T09:00:00.000Z' },
      { id: 'hist_4802', kind: 'assistant', text: '很早的回答', seq: 4802, at: '2026-11-12T09:00:05.000Z' },
    ],
  }))
  // 现在发一条：乐观上屏 → ack → echo（seq 是插件事件日志序号，很小）。
  model.addLocalUserMessage({ msgId: 'm1', text: '新的问题', at: '2026-11-12T10:00:00.000Z' })
  model.applyFrame({ t: 'chat/ack', rid: 'm1', callId: 'c1' })
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_a', text: '新的问题', at: '2026-11-12T10:00:00.000Z', seq: 5 })
  assert.equal(model.cursor, 5, 'cursor 是日志水位，跟着 echo 走而不是跟着历史 seq')
  assert.deepEqual(
    model.messages.map(message => message.text),
    ['很早的问题', '很早的回答', '新的问题'],
    'echo 落位后不能因为 seq 5 < 4800 就跳到最前面',
  )
  assert.equal(model.messages.at(-1).tail, true)

  // 回答回来（助手帧不带 at，接收时刻可能比提问的 at 更早）。
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '新的回答', seq: 6 })
  model.applyFrame({ t: 'chat/done', callId: 'c1', text: '新的回答', seq: 7 })
  assert.deepEqual(
    model.messages.map(message => message.text),
    ['很早的问题', '很早的回答', '新的问题', '新的回答'],
    '回答必须排在提问之后，不能按接收时刻排到前面',
  )
})
