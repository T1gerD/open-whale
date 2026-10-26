// 会话合并（帧去重 / 增量合并 / 快照覆盖 / 事件回放）测试。
//
// 这是 v2.2.0 缺陷密度最高的一层：四条历史 bug 都落在这里——
//   同一条消息投递两次（幂等 / usr_ 去重）、协作模式回复重复拼接（msg_ upsert）、
//   多设备看不到别人消息（chat/echo）、重连丢消息（session/state + events）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ChatModel,
  MESSAGE_STATUS,
  assistantMessageId,
  fileMessageId,
  normalizeAttachment,
  userMessageId,
} from '../lib/messages.mjs'

const NOW = Date.parse('2026-10-26T12:00:00.000Z')

/** 新建一个绑定到 dev_a 的模型。 */
function makeModel() {
  const model = new ChatModel()
  model.setDeviceId('dev_a')
  return model
}

test('本地用户消息 + chat/echo 回显不会产生第二条气泡', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm1', text: '你好', at: '2026-10-26T11:59:00.000Z' })
  assert.equal(model.messages.length, 1)
  assert.equal(model.messages[0].id, userMessageId('m1'))
  assert.equal(model.messages[0].status, MESSAGE_STATUS.PENDING)

  const result = model.applyFrame({
    t: 'chat/echo',
    msgId: 'm1',
    deviceId: 'dev_a',
    text: '你好',
    at: '2026-10-26T12:00:01.000Z',
    seq: 1,
  })
  assert.equal(result.changed, true)
  assert.equal(model.messages.length, 1, 'echo 必须按 usr_<msgId> 合并，而不是新增')
  assert.equal(model.messages[0].status, MESSAGE_STATUS.SENT)
  assert.equal(model.messages[0].at, '2026-10-26T12:00:01.000Z')
  assert.equal(model.messages[0].mine, true)
  assert.equal(model.cursor, 1)
})

test('别人发来的 chat/echo 追加成带昵称的用户气泡', () => {
  const model = makeModel()
  model.applyFrame({
    t: 'chat/echo',
    msgId: 'm2',
    deviceId: 'dev_b',
    speaker: '小王',
    text: '帮我看下这个报错',
    at: '2026-10-26T12:00:02.000Z',
    files: [{ fileId: 'f1', name: 'error.png', size: 1024, mime: 'image/png' }],
    seq: 2,
  })
  assert.equal(model.messages.length, 1)
  const message = model.messages[0]
  assert.equal(message.speaker, '小王')
  assert.equal(message.mine, false)
  assert.equal(message.files[0].fileId, 'f1')
})

test('同一条 chat/echo 重复投递只算一次（回放幂等）', () => {
  const model = makeModel()
  const frame = { t: 'chat/echo', msgId: 'm3', deviceId: 'dev_b', text: '重复', at: '2026-10-26T12:00:03.000Z', seq: 3 }
  model.applyFrame(frame)
  const second = model.applyFrame(frame)
  assert.equal(model.messages.length, 1)
  assert.equal(second.handled, true)
})

test('chat/ack 把本地消息标为已发送，重复 ack 幂等', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm4', text: '在吗' })
  model.applyFrame({ t: 'chat/ack', rid: 'm4', callId: 'c4' })
  assert.equal(model.messages[0].status, MESSAGE_STATUS.SENT)
  const again = model.applyFrame({ t: 'chat/ack', rid: 'm4', callId: 'c4', duplicate: true })
  assert.equal(again.handled, true)
  assert.equal(model.messages.length, 1)
})

test('chat/message 按 messageId upsert，多段回答只拼一次', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '第一段', seq: 1 })
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '第一段', seq: 2 })
  assert.equal(model.messages.length, 1, '同一 messageId 重复推送不能再插一条')
  assert.equal(model.messages[0].text, '第一段')
  assert.equal(model.messages[0].id, assistantMessageId('c1'))
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a2', index: 1, text: '第二段', seq: 3 })
  assert.equal(model.messages.length, 1)
  assert.equal(model.messages[0].text, '第一段\n\n第二段')
  assert.equal(model.messages[0].status, MESSAGE_STATUS.STREAMING)
})

test('chat/message 是全量替换（同 messageId 文本变了就用新文本）', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/message', callId: 'c2', messageId: 'a1', index: 0, text: '旧的', seq: 1 })
  model.applyFrame({ t: 'chat/message', callId: 'c2', messageId: 'a1', index: 0, text: '新的全文', seq: 2 })
  assert.equal(model.messages[0].text, '新的全文')
})

test('chat/done 是权威全文：覆盖 delta / message 拼接结果', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/delta', callId: 'c3', seq: 1, text: '流式' })
  model.applyFrame({ t: 'chat/delta', callId: 'c3', seq: 2, text: '片段' })
  assert.equal(model.messages[0].text, '流式片段')
  model.applyFrame({ t: 'chat/done', callId: 'c3', text: '完整答案', files: [{ fileId: 'f9', name: 'a.txt', size: 5 }] })
  assert.equal(model.messages[0].text, '完整答案')
  assert.equal(model.messages[0].status, MESSAGE_STATUS.DONE)
  assert.equal(model.messages[0].files[0].fileId, 'f9')
  assert.equal(model.activeCallId, undefined)
  // 迟到的 message/delta 不能把已完成的消息改回生成中。
  model.applyFrame({ t: 'chat/message', callId: 'c3', messageId: 'late', index: 9, text: '迟到', seq: 99 })
  model.applyFrame({ t: 'chat/delta', callId: 'c3', seq: 100, text: '迟到' })
  assert.equal(model.messages[0].text, '完整答案')
  assert.equal(model.messages[0].status, MESSAGE_STATUS.DONE)
})

test('chat/message 能力存在时，delta 不重复拼文本', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/message', callId: 'c4', messageId: 'a1', index: 0, text: '全文', seq: 1 })
  model.applyFrame({ t: 'chat/delta', callId: 'c4', seq: 2, text: '重复片段' })
  assert.equal(model.messages[0].text, '全文')
})

test('delta 按 seq 去重（重连回放不会重复追加）', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/delta', callId: 'c5', seq: 5, text: 'AB' })
  model.applyFrame({ t: 'chat/delta', callId: 'c5', seq: 5, text: 'AB' })
  model.applyFrame({ t: 'chat/delta', callId: 'c5', seq: 4, text: 'XX' })
  assert.equal(model.messages[0].text, 'AB')
  model.applyFrame({ t: 'chat/delta', callId: 'c5', seq: 6, text: 'CD' })
  assert.equal(model.messages[0].text, 'ABCD')
})

test('chat/typing 只影响输入指示器，不创建空气泡', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/typing', callId: 'c6', active: true })
  assert.equal(model.isTyping, true)
  assert.equal(model.messages.length, 0)
  model.applyFrame({ t: 'chat/typing', callId: 'c6', active: false })
  assert.equal(model.isTyping, false)
})

test('chat/tool 按 toolCallId 更新同一条活动行', () => {
  const model = makeModel()
  model.applyFrame({
    t: 'chat/tool',
    callId: 'c7',
    phase: 'tool-start',
    toolCallId: 't1',
    tool: 'read',
    summary: '读取文件',
  })
  model.applyFrame({
    t: 'chat/tool',
    callId: 'c7',
    phase: 'tool-end',
    toolCallId: 't1',
    tool: 'read',
    summary: '读取文件',
    ok: true,
  })
  assert.equal(model.messages.length, 1)
  assert.equal(model.messages[0].tools.length, 1)
  assert.equal(model.messages[0].tools[0].phase, 'tool-end')
  assert.equal(model.messages[0].tools[0].ok, true)
})

test('chat/error 把气泡标错并记录可展示的错误', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/message', callId: 'c8', messageId: 'a1', index: 0, text: '一半', seq: 1 })
  model.applyFrame({ t: 'chat/error', callId: 'c8', message: '模型超时', retryable: true })
  assert.equal(model.messages[0].status, MESSAGE_STATUS.ERROR)
  assert.equal(model.lastError.message, '模型超时')
})

test('session/state 幂等覆盖：重复快照不会翻倍', () => {
  const model = makeModel()
  const snapshot = {
    t: 'session/state',
    sessionId: 'sess_1',
    sessionEpoch: 1,
    head: 42,
    collaboration: true,
    snapshot: {
      messages: [
        { id: 'usr_m1', kind: 'user', text: '你好', at: '2026-10-26T11:00:00.000Z', msgId: 'm1' },
        { id: 'msg_c1', kind: 'assistant', text: '你好呀', at: '2026-10-26T11:00:01.000Z', callId: 'c1' },
      ],
      activeCall: { callId: 'c9', text: '正在写', typing: true },
    },
  }
  const first = model.applyFrame(snapshot)
  assert.equal(first.changed, true)
  assert.equal(first.sessionChanged, true)
  assert.equal(model.messages.length, 3)
  assert.equal(model.cursor, 42)
  assert.equal(model.sessionId, 'sess_1')
  assert.equal(model.sessionEpoch, 1)
  assert.equal(model.collaboration, true)
  assert.equal(model.messages[2].status, MESSAGE_STATUS.STREAMING)
  assert.equal(model.isTyping, true)

  model.applyFrame(snapshot)
  assert.equal(model.messages.length, 3, '同一份快照应用两次必须还是 3 条')

  model.applyFrame({ t: 'chat/done', callId: 'c9', text: '写完了', seq: 43 })
  assert.equal(model.messages[2].status, MESSAGE_STATUS.DONE)
  assert.equal(model.messages[2].text, '写完了')
})

test('session/state 缺少 id 时按 msgId / callId 推导稳定 id', () => {
  const model = makeModel()
  model.applyFrame({
    t: 'session/state',
    sessionId: 'sess_1',
    sessionEpoch: 0,
    head: 3,
    collaboration: false,
    snapshot: {
      messages: [
        { kind: 'user', msgId: 'm10', text: '甲', at: '2026-10-26T11:00:00.000Z' },
        { kind: 'assistant', callId: 'c10', text: '乙', at: '2026-10-26T11:00:01.000Z' },
      ],
    },
  })
  assert.deepEqual(model.messages.map(item => item.id), ['usr_m10', 'msg_c10'])
})

test('session/events 只回放 cursor 之后的事件，并把 head 记为新 cursor', () => {
  const model = makeModel()
  model.cursor = 10
  const frame = {
    t: 'session/events',
    sessionId: 'sess_1',
    from: 10,
    head: 14,
    sessionEpoch: 1,
    events: [
      { t: 'chat/echo', msgId: 'm20', deviceId: 'dev_b', speaker: '小王', text: '刚才说的', at: '2026-10-26T12:00:00.000Z', seq: 11 },
      { t: 'chat/echo', msgId: 'm20', deviceId: 'dev_b', speaker: '小王', text: '刚才说的', at: '2026-10-26T12:00:00.000Z', seq: 11 },
      { t: 'chat/message', callId: 'c20', messageId: 'a1', index: 0, text: '回答', seq: 12 },
      { t: 'chat/done', callId: 'c20', text: '最终回答', seq: 13 },
      { t: 'file/offered', fileId: 'f20', name: '报告.pdf', size: 2048, mime: 'application/pdf', seq: 14 },
    ],
  }
  model.applyFrame(frame)
  assert.equal(model.cursor, 14)
  assert.deepEqual(model.messages.map(item => item.kind), ['user', 'assistant', 'file'])
  assert.equal(model.messages[1].text, '最终回答')
  // 再应用一次同样的回放：一条都不应该新增。
  const before = model.messages.length
  model.applyFrame(frame)
  assert.equal(model.messages.length, before)
})

test('collab/state 切换会话 epoch 时清空本地消息并提示需要同步', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_a', text: '旧会话', at: '2026-10-26T11:00:00.000Z', seq: 1 })
  assert.equal(model.messages.length, 1)
  const result = model.applyFrame({ t: 'collab/state', on: true, sessionId: 'sess_shared', sessionEpoch: 2 })
  assert.equal(result.needsSync, true)
  assert.equal(result.sessionChanged, true)
  assert.equal(model.messages.length, 0)
  assert.equal(model.sessionId, 'sess_shared')
  assert.equal(model.collaboration, true)
  // 同一 epoch 的重复广播不应再清空。
  model.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_a', text: '新会话', at: '2026-10-26T11:00:02.000Z', seq: 2 })
  const again = model.applyFrame({ t: 'collab/state', on: true, sessionId: 'sess_shared', sessionEpoch: 2 })
  assert.equal(again.sessionChanged, false)
  assert.equal(model.messages.length, 1)
})

test('session/participants 提供协作头像条数据', () => {
  const model = makeModel()
  model.applyFrame({
    t: 'session/participants',
    sessionId: 'sess_1',
    collaboration: true,
    participants: [
      { deviceId: 'dev_a', name: '我', online: true },
      { deviceId: 'dev_b', name: '小王', online: false },
      { bad: true },
    ],
  })
  assert.equal(model.collaboration, true)
  assert.equal(model.participants.length, 2)
  assert.equal(model.participants[0].self, true)
  assert.equal(model.participants[1].online, false)
})

test('file/offered 生成文件卡片，重复推送只更新不新增', () => {
  const model = makeModel()
  model.applyFrame({ t: 'file/offered', fileId: 'f1', name: 'a.png', size: 100, mime: 'image/png', url: '/x', seq: 1 })
  assert.equal(model.messages.length, 1)
  assert.equal(model.messages[0].id, fileMessageId('f1'))
  assert.equal(model.messages[0].kind, 'file')
  model.applyFrame({ t: 'file/offered', fileId: 'f1', name: 'a.png', size: 100, url: '/y', seq: 2 })
  assert.equal(model.messages.length, 1)
  assert.equal(model.files.get('f1').url, '/y')
})

test('未知帧一律忽略（协议只增不改）', () => {
  const model = makeModel()
  const result = model.applyFrame({ t: 'future/frame', payload: 1 })
  assert.equal(result.handled, false)
  assert.equal(model.messages.length, 0)
  assert.equal(model.applyFrame({ nonsense: true }).handled, false)
  assert.equal(model.applyFrame(null).handled, false)
})

test('error 帧记录在模型上供 UI 显示横幅', () => {
  const model = makeModel()
  model.applyFrame({ t: 'error', code: 'bad-frame', message: '帧缺少 t 字段' })
  assert.equal(model.lastError.code, 'bad-frame')
  assert.match(model.lastError.message, /帧缺少/)
})

test('localStorage 快照往返：消息 / cursor / 会话 / 待发状态', () => {
  const model = makeModel()
  model.applyFrame({ t: 'session/state', sessionId: 'sess_9', sessionEpoch: 3, head: 7, collaboration: true, snapshot: { messages: [
    { id: 'usr_m1', kind: 'user', text: '你好', at: '2026-10-26T11:00:00.000Z' },
  ] } })
  model.addLocalUserMessage({ msgId: 'm2', text: '还没发出去' })
  const saved = model.snapshotForStorage({ limit: 50 })
  assert.equal(saved.cursor, 7)
  assert.equal(saved.sessionId, 'sess_9')
  assert.equal(saved.sessionEpoch, 3)
  assert.equal(saved.messages.length, 2)
  assert.equal(saved.messages[1].status, MESSAGE_STATUS.ERROR, '待发状态落盘时要降级成失败，刷新后由离线队列重发')

  const restored = makeModel()
  assert.equal(restored.restoreFromStorage(saved), true)
  assert.equal(restored.messages.length, 2)
  assert.equal(restored.cursor, 7)
  assert.equal(restored.sessionId, 'sess_9')
  assert.equal(restored.sessionEpoch, 3)
  assert.equal(restored.collaboration, true)
  assert.equal(restored.restoreFromStorage({}), false)
  assert.equal(restored.restoreFromStorage({ messages: 'nope' }), false)
})

test('渲染顺序保持追加 / 快照给定顺序（不做时间重排）', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm1', text: '甲', at: '2026-10-26T12:00:00.000Z' })
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '乙', seq: 1 })
  model.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_b', text: '丙', at: '2026-10-26T11:00:00.000Z', seq: 2 })
  assert.deepEqual(model.messages.filter(item => item.kind !== 'assistant').map(item => item.text), ['甲', '丙'])
})

test('消息上限会裁掉最旧的消息（手机内存有限）', () => {
  const model = new ChatModel({ limit: 20 })
  for (let index = 0; index < 40; index += 1) {
    model.applyFrame({
      t: 'chat/echo',
      msgId: `m${index}`,
      deviceId: 'dev_b',
      text: `第 ${index} 条`,
      at: new Date(NOW + index * 1000).toISOString(),
      seq: index + 1,
    })
  }
  assert.ok(model.messages.length <= 20)
  assert.equal(model.messages[model.messages.length - 1].text, '第 39 条')
})

test('normalizeAttachment 归一化 inline / upload / 下载三种来源', () => {
  assert.deepEqual(normalizeAttachment({ name: 'a.png', size: 10, mime: 'image/png', uploadId: 'up_1' }), {
    name: 'a.png',
    size: 10,
    mime: 'image/png',
    uploadId: 'up_1',
  })
  assert.deepEqual(normalizeAttachment({ name: 'b.txt', size: 3, fileId: 'f1', url: '/openwhale/download?token=x' }), {
    name: 'b.txt',
    size: 3,
    mime: '',
    fileId: 'f1',
    url: '/openwhale/download?token=x',
  })
  assert.equal(normalizeAttachment(null), undefined)
  assert.equal(normalizeAttachment({}).name, '附件')
})

test('markUserMessageFailed / resetUserMessageForRetry 支持重发', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm1', text: '发不出去' })
  model.markUserMessageFailed('m1', '连接已断开')
  assert.equal(model.messages[0].status, MESSAGE_STATUS.ERROR)
  assert.equal(model.messages[0].error, '连接已断开')
  model.resetUserMessageForRetry('m1')
  assert.equal(model.messages[0].status, MESSAGE_STATUS.PENDING)
  assert.equal(model.messages[0].error, undefined)
  // 重发沿用同一个 msgId：再收到 echo 仍然只有一条。
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_a', text: '发不出去', at: '2026-10-26T12:00:00.000Z', seq: 1 })
  assert.equal(model.messages.length, 1)
})
