// 会话合并（帧去重 / 增量合并 / 快照覆盖 / 事件回放）测试。
//
// 这是网页版缺陷密度最高的一层：四条历史 bug 都落在这里——
//   同一条消息投递两次（幂等 / usr_ 去重）、协作模式回复重复拼接（msg_ upsert）、
//   多设备看不到别人消息（chat/echo）、重连丢消息（session/state + events）。
// v2.3.0 删掉协作后，这一层还负责会话切换（sessions / session/selected / session/state）
// 与审批队列（approval/ask 排队、approval/resolved 出队）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ChatModel,
  ChatTabsModel,
  MESSAGE_STATUS,
  composerAction,
  isInjectedHistoryText,
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
  // echo 的 at 是网关「收到（补发）消息的时刻」，不能覆盖本地原始发送时刻——否则
  // 一条离线补发的消息会被墙钟排序推到所有回复之后（真机 bug）。
  assert.equal(model.messages[0].at, '2026-10-26T11:59:00.000Z')
  assert.equal(model.messages[0].seq, 1, 'seq 才是权威次序')
  assert.equal(model.messages[0].optimistic, false, '拿到 seq 就不再是乐观消息')
  assert.equal(model.messages[0].mine, true)
  assert.equal(model.cursor, 1)
})

test('同一身份另一个窗口的 chat/echo 合并成一条用户气泡（不再有昵称前缀）', () => {
  const model = makeModel()
  model.applyFrame({
    t: 'chat/echo',
    msgId: 'm2',
    deviceId: 'dev_a',
    text: '帮我看下这个报错',
    at: '2026-10-26T12:00:02.000Z',
    files: [{ fileId: 'f1', name: 'error.png', size: 1024, mime: 'image/png' }],
    seq: 2,
  })
  assert.equal(model.messages.length, 1)
  const message = model.messages[0]
  assert.equal(message.speaker, undefined, '协作删除后不再保存/渲染 speaker')
  assert.equal(message.mine, true)
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
    title: '修一下构建',
    sessionEpoch: 1,
    head: 42,
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
  assert.equal(model.sessionTitle, '修一下构建')
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

test('审批：多条 approval/ask 排队，不会互相覆盖', () => {
  const model = makeModel()
  const expiresAt = NOW + 60_000
  const first = model.applyFrame({
    t: 'approval/ask',
    approvalId: 'ap_1',
    toolName: 'bash',
    reason: '执行命令',
    displayReason: { en: 'run a command', zh: '执行命令' },
    callId: 'c1',
    expiresAt,
  })
  assert.equal(first.changed, true)
  assert.equal(first.approval.approvalId, 'ap_1')
  assert.equal(first.approval.displayReason, '执行命令')
  assert.equal(first.approval.expiresAt, expiresAt)
  assert.equal(first.approval.replied, false)
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_2', toolName: 'write', reason: '写文件' })
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_3', toolName: 'read' })
  assert.deepEqual(model.approvals.map(item => item.approvalId), ['ap_1', 'ap_2', 'ap_3'], '必须按到达顺序排队')
  assert.equal(model.hasPendingApprovals, true)
  // 同一个 approvalId 重发（电脑端重连回放）只更新，不插新卡。
  const again = model.applyFrame({ t: 'approval/ask', approvalId: 'ap_2', toolName: 'write', reason: '写文件（更新）' })
  assert.equal(again.changed, true)
  assert.equal(model.approvals.length, 3)
  assert.equal(model.approvalsById.get('ap_2').reason, '写文件（更新）')
  // 缺 approvalId 的脏帧直接忽略。
  assert.equal(model.applyFrame({ t: 'approval/ask', toolName: 'bash' }).changed, false)
  assert.equal(model.approvals.length, 3)
})

test('审批：resolved 只移除对应那条，且不影响已回复标记', () => {
  const model = makeModel()
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash' })
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_2', toolName: 'write' })
  assert.equal(model.markApprovalReplied('ap_1', 'allowed-once'), true)
  assert.equal(model.approvalsById.get('ap_1').replied, true)
  assert.equal(model.markApprovalReplied('ap_1', 'rejected'), false, '已经答过就不能再答')

  const resolved = model.applyFrame({ t: 'approval/resolved', approvalId: 'ap_1', outcome: 'allowed-once', source: 'phone' })
  assert.equal(resolved.changed, true)
  assert.deepEqual(resolved.resolved, { approvalId: 'ap_1', outcome: 'allowed-once', source: 'phone' })
  assert.deepEqual(model.approvals.map(item => item.approvalId), ['ap_2'])

  // 重复 / 迟到 / 陌生的 resolved 都是无害的。
  assert.equal(model.applyFrame({ t: 'approval/resolved', approvalId: 'ap_1', outcome: 'allowed-once' }).changed, false)
  assert.equal(model.applyFrame({ t: 'approval/resolved', approvalId: 'nope', outcome: 'cancelled' }).changed, false)
  assert.deepEqual(model.approvals.map(item => item.approvalId), ['ap_2'])
})

test('审批：电脑端重发同一个 approvalId 会清掉本地「已答复」（上次答复可能没送达）', () => {
  const model = makeModel()
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', reason: '写文件' })
  assert.equal(model.markApprovalReplied('ap_1', 'delegate'), true)

  const again = model.applyFrame({ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', reason: '写文件' })
  assert.equal(model.approvals.length, 1, '重发仍是一张卡，不插新卡')
  assert.equal(again.approval.replied, false, '电脑端还在等答复，必须让用户能重新点')
  assert.equal(again.approval.repliedOutcome, undefined)
  assert.equal(model.markApprovalReplied('ap_1', 'allowed-once'), true, '重新点一次要能发出去')
})

test('审批：转到电脑端的卡片保留 onDesktop / 自动拒绝时间', () => {
  const model = makeModel()
  model.applyFrame({ t: 'session/state', sessionId: 'sess_a', sessionEpoch: 1, head: 1, snapshot: { messages: [] } })
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', reason: 'x' })
  assert.equal(model.approvals[0].onDesktop, undefined)

  model.applyFrame({
    t: 'approval/ask',
    approvalId: 'ap_1',
    toolName: 'bash',
    reason: 'x',
    onDesktop: true,
  })
  assert.equal(model.approvals.length, 1, '重发只更新同一张卡')
  assert.equal(model.approvals[0].onDesktop, true)
})

test('审批：切会话不再清空待答审批（切回来还要能答）', () => {
  const model = makeModel()
  model.applyFrame({ t: 'session/state', sessionId: 'sess_a', sessionEpoch: 1, head: 1, snapshot: { messages: [] } })
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash', expiresAt: Date.now() + 60_000 })
  model.applyFrame({ t: 'session/state', sessionId: 'sess_b', sessionEpoch: 2, head: 0, snapshot: { messages: [] } })
  // 审批按 approvalId 路由回对的会话，切走/切回都不能丢（真机反馈的「审核消失」）。
  assert.equal(model.approvals.length, 1)
  assert.equal(model.approvalsById.get('ap_1')?.approvalId, 'ap_1')
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

test('localStorage 快照往返：消息 / cursor / 会话标题 / 待发状态', () => {
  const model = makeModel()
  model.applyFrame({ t: 'session/state', sessionId: 'sess_9', title: '修构建', sessionEpoch: 3, head: 7, snapshot: { messages: [
    { id: 'usr_m1', kind: 'user', text: '你好', at: '2026-10-26T11:00:00.000Z' },
  ] } })
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_1', toolName: 'bash' })
  model.addLocalUserMessage({ msgId: 'm2', text: '还没发出去' })
  const saved = model.snapshotForStorage({ limit: 50 })
  assert.equal(saved.cursor, 7)
  assert.equal(saved.sessionId, 'sess_9')
  assert.equal(saved.sessionEpoch, 3)
  assert.equal(saved.sessionTitle, '修构建')
  assert.equal(saved.messages.length, 2)
  assert.equal(saved.messages[1].status, MESSAGE_STATUS.ERROR, '待发状态落盘时要降级成失败，刷新后由离线队列重发')
  assert.equal('approvals' in saved, false, '审批是有时效的请求，不落盘')

  const restored = makeModel()
  assert.equal(restored.restoreFromStorage(saved), true)
  assert.equal(restored.messages.length, 2)
  assert.equal(restored.cursor, 7)
  assert.equal(restored.sessionId, 'sess_9')
  assert.equal(restored.sessionEpoch, 3)
  assert.equal(restored.sessionTitle, '修构建')
  assert.equal(restored.approvals.length, 0)
  assert.equal(restored.restoreFromStorage({}), false)
  assert.equal(restored.restoreFromStorage({ messages: 'nope' }), false)
})

test('消息按时间排序（与电脑端一致，不回放顺序错乱）', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm1', text: '甲', at: '2026-10-26T12:00:00.000Z' })
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '乙', seq: 1 })
  // 回放来的一条更早的消息（11:00）应排在「甲」前面，而不是被追加到最后。
  model.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_b', text: '丙', at: '2026-10-26T11:00:00.000Z', seq: 2 })
  assert.deepEqual(model.messages.filter(item => item.kind !== 'assistant').map(item => item.text), ['丙', '甲'])
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


test('duplicate tab titles get a #序号 so new sessions are distinguishable', () => {
  const tabs = new ChatTabsModel()
  tabs.openTab('ow-a')
  tabs.openTab('ow-b')
  tabs.openTab('ow-c')
  const titles = [...tabs.tabDisplayTitles().values()]
  assert.deepEqual(titles, ['会话 #1', '会话 #2', '会话 #3'])
})

test('a unique tab title is left untouched', () => {
  const tabs = new ChatTabsModel()
  tabs.openTab('ow-a')
  tabs.openTab('ow-b')
  tabs.chats.get('ow-a').sessionTitle = '优化 open-whale'
  const titles = tabs.tabDisplayTitles()
  assert.equal(titles.get('ow-a'), '优化 open-whale')
  assert.equal(titles.get('ow-b'), '会话')
})

test('the composer is a stop button only while generating with an empty input', () => {
  // 生成中 + 空输入 → 停止
  assert.deepEqual(composerAction({ streaming: true, hasText: false, hasAttachments: false }), {
    showStop: true,
    sendDisabled: true,
  })
  // 生成中 + 有文字 → 发送（电脑端排队）
  assert.deepEqual(composerAction({ streaming: true, hasText: true, hasAttachments: false }), {
    showStop: false,
    sendDisabled: false,
  })
  // 空闲 → 发送
  assert.deepEqual(composerAction({ streaming: false, hasText: true }), { showStop: false, sendDisabled: false })
  // 没有会话 / 正在发送 / 空输入空闲 → 发送键禁用
  assert.equal(composerAction({ hasSession: false }).sendDisabled, true)
  assert.equal(composerAction({ sending: true, hasText: true }).sendDisabled, true)
  assert.equal(composerAction({ streaming: false }).sendDisabled, true)
})


test('a pending approval survives switching session/epoch', () => {
  const model = makeModel()
  model.applyFrame({ t: 'approval/ask', approvalId: 'ap_keep', toolName: 'bash', expiresAt: Date.now() + 60_000 }, NOW)
  assert.equal(model.approvals.length, 1)
  // 切会话/新 epoch 的快照不能把待答审批清掉（真机反馈「切会话审批消失」）。
  model.applyFrame({ t: 'session/state', sessionId: 's2', sessionEpoch: 2, snapshot: { messages: [] } }, NOW + 1000)
  assert.equal(model.approvals.length, 1)
  assert.equal(model.approvalsById.get('ap_keep')?.approvalId, 'ap_keep')
})

test('pendingApprovals aggregates approvals across tabs', () => {
  const tabs = new ChatTabsModel()
  tabs.openTab('a')
  tabs.openTab('b')
  tabs.chats.get('a').applyFrame({ t: 'approval/ask', approvalId: 'ap_a', toolName: 'bash', expiresAt: NOW + 60_000 }, NOW)
  const pending = tabs.pendingApprovals()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sessionId, 'a')
  assert.equal(pending[0].approval.approvalId, 'ap_a')
})


test('injected runtime-context bubbles are dropped from cached history', () => {
  const model = makeModel()
  model.restoreFromStorage({
    messages: [
      { id: 'u1', kind: 'user', text: 'Time sampled while preparing turn 51, step 1: 2026-11-09T19:35:37+08:00', at: new Date(NOW).toISOString() },
      { id: 'u2', kind: 'user', text: '<system-reminder>catalog changed</system-reminder>', at: new Date(NOW).toISOString() },
      { id: 'u3', kind: 'user', text: '排队消息未成功', at: new Date(NOW).toISOString() },
    ],
  })
  // 旧缓存里的内部注入不再恢复；真实用户消息保留。
  assert.deepEqual(model.messages.map(message => message.text), ['排队消息未成功'])
  assert.equal(isInjectedHistoryText('<system-reminder>x</system-reminder>'), true)
  assert.equal(isInjectedHistoryText('Current runtime context: none.'), true)
  assert.equal(isInjectedHistoryText('你好'), false)
})


test('snapshot messages are sorted by time so the phone matches the desktop', () => {
  const model = makeModel()
  const t0 = Date.parse('2026-11-09T11:40:00.000Z')
  model.applyFrame({
    t: 'session/state',
    sessionId: 's1',
    sessionEpoch: 1,
    snapshot: {
      messages: [
        { id: 'a1', kind: 'assistant', text: '回复', at: new Date(t0 + 2000).toISOString() },
        { id: 'u1', kind: 'user', text: '提问', at: new Date(t0).toISOString() },
        { id: 'a2', kind: 'assistant', text: '再回复', at: new Date(t0 + 5000).toISOString() },
      ],
    },
  }, t0 + 6000)
  assert.deepEqual(model.messages.map(message => message.text), ['提问', '回复', '再回复'])
})

// ---------------------------------------------------------------------------
// v3.0.x：排序键改成「seq 优先」（真机反馈：手机顺序与电脑端不一致）
//
// 根因：网关给 chat/echo 的 `at` 是**它收到（补发）消息的时刻**，不是原始发送时刻；
// 助手帧根本没有 at，手机只能拿接收时刻。所以墙钟排序在「离线/重连/补发」场景必错，
// 而每条被记录的事件都有会话内单调的 seq。下面这组测试锁死这个契约。
// ---------------------------------------------------------------------------

const SENT_AT = '2026-11-09T11:40:00.000Z'

test('a seq arriving late never jumps past messages that have no seq', () => {
  const model = makeModel()
  // 旧形状快照：id 不是 hist_<seq>，任何消息都没有 seq（老缓存 / 老电脑端）。
  model.applyFrame({
    t: 'session/state',
    sessionId: 's',
    sessionEpoch: 1,
    head: 42,
    snapshot: {
      messages: [
        { id: 'usr_m1', kind: 'user', text: '问', at: '2026-11-09T11:00:00.000Z' },
        { id: 'msg_c1', kind: 'assistant', text: '答', at: '2026-11-09T11:00:01.000Z' },
      ],
    },
  })
  // 正在生成的气泡先以「没有 seq」的形状出现（chat/tool、chat/error 不进事件日志）。
  model.applyFrame({ t: 'chat/tool', callId: 'c9', toolCallId: 't1', tool: 'bash', phase: 'tool-start' })
  assert.deepEqual(model.messages.map(message => message.text), ['问', '答', ''])
  // 它随后拿到 seq 43：不能因为「有 seq 了」就整条跳到历史前面。整表退回 at 排序。
  model.applyFrame({ t: 'chat/done', callId: 'c9', text: '新答', seq: 43 })
  assert.deepEqual(model.messages.map(message => message.text), ['问', '答', '新答'])
  assert.deepEqual(model.messages.map(message => message.seq), [undefined, undefined, 43])
})

test('a late echo (reconnect / outbox resend) never moves my bubble after its replies', () => {
  const model = makeModel()
  model.addLocalUserMessage({
    msgId: 'm_late',
    text: '现在一万token要多少钱',
    at: SENT_AT,
    files: [{ name: 'a.png', size: 10 }, { name: 'b.png', size: 20 }],
  })
  // 手机断线期间电脑已经答完这一轮：重连后按接收时刻当 at 回放进来。
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '回答', seq: 7 }, {
    now: Date.parse('2026-11-09T12:00:00.000Z'),
  })
  model.applyFrame({ t: 'chat/done', callId: 'c1', text: '回答', seq: 8 }, {
    now: Date.parse('2026-11-09T12:00:01.000Z'),
  })
  // outbox 补发的 echo 迟到：at 是网关收到补发的时刻（比回复还晚），seq 仍是原来的 6。
  model.applyFrame({
    t: 'chat/echo',
    msgId: 'm_late',
    deviceId: 'dev_a',
    text: '现在一万token要多少钱',
    at: '2026-11-09T12:20:00.000Z',
    seq: 6,
    files: [{ name: 'a.png', size: 10 }, { name: 'b.png', size: 20 }],
  })
  // 之后又来一条消息会触发重排（这正是旧实现把气泡甩到后面去的时机）。
  model.applyFrame({ t: 'chat/echo', msgId: 'm_after', deviceId: 'dev_b', text: '再说一句', at: '2026-11-09T12:21:00.000Z', seq: 9 })
  assert.deepEqual(model.messages.map(message => message.kind), ['user', 'assistant', 'user'])
  assert.equal(model.messages[0].text, '现在一万token要多少钱')
  assert.equal(model.messages[0].at, SENT_AT, '本地发送时刻不能被迟到的 at 覆盖')
  assert.equal(model.messages[0].seq, 6)
  assert.equal(model.messages[0].files.length, 2, '两张附件跟着气泡一起落位')
})

test('a re-broadcast echo with a newer seq does not push the bubble down', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_a', text: '问', at: '2026-11-09T12:00:00.000Z', seq: 2 })
  model.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_b', text: '答', at: '2026-11-09T12:01:00.000Z', seq: 5 })
  // 电脑端重发/重连回放可能带一个更新的 seq：只认第一次落位的位置。
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_a', text: '问', at: '2026-11-09T12:30:00.000Z', seq: 9 })
  assert.deepEqual(model.messages.map(message => message.text), ['问', '答'])
  assert.equal(model.messages[0].seq, 2)
  assert.equal(model.messages[0].at, '2026-11-09T12:00:00.000Z')
})

test('assistant frames carry no at: they sort by seq even when they arrive out of order', () => {
  const model = makeModel()
  // 第二轮（seq 5）先到，第一轮（seq 3）后到：接收时刻与真实顺序相反。
  model.applyFrame({ t: 'chat/message', callId: 'c2', messageId: 'b1', index: 0, text: '第二轮', seq: 5 }, { now: 1000 })
  model.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '第一轮', seq: 3 }, { now: 2000 })
  model.applyFrame({ t: 'chat/done', callId: 'c1', text: '第一轮', seq: 4 }, { now: 2001 })
  assert.deepEqual(model.messages.map(message => message.text), ['第一轮', '第二轮'])
  assert.equal(model.messages[0].seq, 3, '取这一轮第一次出现的 seq 作为落位点')
})

test('identical wall-clock at still orders by seq', () => {
  const model = makeModel()
  const at = '2026-11-09T12:00:00.000Z'
  model.applyFrame({ t: 'chat/echo', msgId: 'm9', deviceId: 'dev_b', text: '后', at, seq: 9 })
  model.applyFrame({ t: 'chat/echo', msgId: 'm3', deviceId: 'dev_b', text: '前', at, seq: 3 })
  assert.deepEqual(model.messages.map(message => message.text), ['前', '后'])
})

test('a snapshot rebuilt from hist_<seq> keeps the live order', () => {
  const live = makeModel()
  live.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_a', text: '问', at: '2026-11-09T12:00:00.000Z', seq: 1 })
  live.applyFrame({ t: 'chat/message', callId: 'c1', messageId: 'a1', index: 0, text: '答', seq: 2 })
  live.applyFrame({ t: 'chat/done', callId: 'c1', text: '答', seq: 3 })
  const liveOrder = live.messages.map(message => message.text)
  assert.deepEqual(liveOrder, ['问', '答'])

  const rebuilt = makeModel()
  rebuilt.applyFrame({
    t: 'session/state',
    sessionId: 's1',
    sessionEpoch: 1,
    head: 3,
    snapshot: {
      messages: [
        // 故意「时间倒挂」：只有 hist_<seq> 能纠正回来。
        { id: 'hist_3', kind: 'assistant', text: '答', at: '2026-11-09T11:00:00.000Z' },
        { id: 'hist_1', kind: 'user', text: '问', at: '2026-11-09T12:00:00.000Z' },
      ],
    },
  })
  assert.deepEqual(rebuilt.messages.map(message => message.text), liveOrder)
  assert.deepEqual(rebuilt.messages.map(message => message.seq), [1, 3])
})

test('a snapshot keeps my unconfirmed messages and an ack without seq keeps them last', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/echo', msgId: 'm1', deviceId: 'dev_b', text: '旧消息', at: '2026-11-09T11:00:00.000Z', seq: 1 })
  model.addLocalUserMessage({ msgId: 'm2', text: '刚发的', at: '2026-11-09T12:00:00.000Z' })
  // ack 不带 seq：它仍然是「没被网关确认位置」的乐观消息。
  model.applyFrame({ t: 'chat/ack', rid: 'm2', callId: 'c2' })
  assert.deepEqual(model.messages.map(message => message.text), ['旧消息', '刚发的'])
  assert.equal(model.messages[1].status, MESSAGE_STATUS.SENT)
  assert.equal(model.messages[1].optimistic, true)

  // 重连快照先到：本地还没确认的消息不能丢（真机「我先发的消息消失了」）。
  model.applyFrame({
    t: 'session/state',
    sessionId: 's1',
    sessionEpoch: 1,
    head: 1,
    snapshot: { messages: [{ id: 'hist_1', kind: 'user', text: '旧消息', at: '2026-11-09T11:00:00.000Z' }] },
  })
  assert.deepEqual(model.messages.map(message => message.text), ['旧消息', '刚发的'])
  assert.equal(model.messages[1].optimistic, true)

  // echo 带着 seq 回来后才落位（这里正好排在后面）。
  model.applyFrame({ t: 'chat/echo', msgId: 'm2', deviceId: 'dev_a', text: '刚发的', at: '2026-11-09T12:30:00.000Z', seq: 2 })
  assert.deepEqual(model.messages.map(message => message.text), ['旧消息', '刚发的'])
  assert.equal(model.messages[1].optimistic, false)
  assert.equal(model.messages[1].seq, 2)
  assert.equal(model.messages[1].at, '2026-11-09T12:00:00.000Z')
})

test('a snapshot drops my unconfirmed copy when history already has that message', () => {
  const model = makeModel()
  // 消息其实送到了，但手机没收到 echo（事件日志也轮转掉了那条）：快照历史里有它。
  model.addLocalUserMessage({ msgId: 'm_dup', text: '这条其实送到了', at: '2026-11-09T11:00:00.000Z' })
  model.applyFrame({
    t: 'session/state',
    sessionId: 's1',
    sessionEpoch: 1,
    head: 500,
    snapshot: { messages: [{ id: 'hist_499', kind: 'user', text: '这条其实送到了', at: '2026-11-09T11:00:01.000Z' }] },
  })
  assert.equal(model.messages.length, 1, '同内容不能出现两条气泡')
  // 2026-11-10：优先保留本地气泡 id（附件卡 / mine 标记 / 干净文本都在本地），
  // 快照只负责把 seq 与权威状态补上，不再是快照 id 覆盖本地。
  assert.equal(model.messages[0].id, userMessageId('m_dup'))
  assert.equal(model.messages[0].optimistic, undefined)
})

test('the limit still trims the oldest messages after the seq switch', () => {
  const model = new ChatModel({ limit: 20 })
  // 先来一条没有 seq 的乐观消息（层级 2），它会一直待在最后。
  model.addLocalUserMessage({ msgId: 'pending', text: '排队中', at: '2026-11-09T10:00:00.000Z' })
  for (let index = 0; index < 40; index += 1) {
    model.applyFrame({
      t: 'chat/echo',
      msgId: `m${index}`,
      deviceId: 'dev_b',
      text: `第 ${index} 条`,
      at: new Date(Date.parse('2026-11-09T11:00:00.000Z') + index * 1000).toISOString(),
      seq: index + 1,
    })
  }
  assert.ok(model.messages.length <= 20)
  assert.equal(model.messages.at(-1).text, '排队中', '乐观消息永远在最后')
  assert.equal(model.messages.at(-2).text, '第 39 条', '裁剪仍然从最旧（seq 最小）那头开始')
})

test('快照重连不会把手机自己的消息显示成两条（msgId 合并本地气泡）', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm1', text: '看这个', at: '2026-10-26T11:58:00.000Z' })
  const local = model.messages[0]
  local.files = [{ name: 'image.jpg', size: 260, mime: 'image/jpeg' }]
  model.applyFrame({
    t: 'session/state',
    sessionId: model.sessionId ?? 'sess_1',
    sessionEpoch: 0,
    head: 10,
    snapshot: {
      messages: [
        { id: 'hist_9', kind: 'user', msgId: 'm1', text: '看这个', at: '2026-10-26T11:58:00.000Z', seq: 9 },
        { id: 'hist_10', kind: 'assistant', text: '收到', at: '2026-10-26T11:58:05.000Z', seq: 10 },
      ],
    },
  })
  assert.equal(model.messages.length, 2, '本地气泡与历史同一条消息必须合并，而不是插两条')
  assert.equal(model.messages[0].id, userMessageId('m1'))
  assert.equal(model.messages[0].text, '看这个')
  assert.deepEqual(model.messages[0].files, local.files, '附件卡不能因为快照合并而丢掉')
  assert.equal(model.messages[0].mine, true)
})

test('快照文本若仍带注入的附件提示，合并时保留本地干净文本', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm2', text: '看这个', at: '2026-10-26T11:58:00.000Z' })
  model.applyFrame({
    t: 'session/state',
    sessionId: 'sess_1',
    sessionEpoch: 0,
    head: 3,
    snapshot: {
      messages: [
        { id: 'hist_2', kind: 'user', msgId: 'm2', text: '看这个\n\n用户通过手机发来了 1 个附件，已保存到电脑上：…', at: '2026-10-26T11:58:00.000Z', seq: 2 },
      ],
    },
  })
  assert.equal(model.messages.length, 1)
  assert.equal(model.messages[0].text, '看这个')
})

test('桌面消息的实时 echo 与历史快照用同一 id（dsh_<id>）合并', () => {
  const model = makeModel()
  model.applyFrame({ t: 'chat/echo', msgId: 'dsh_m2', text: '桌面发的问题', at: '2026-10-26T11:58:00.000Z', deviceId: 'dev_x' })
  assert.equal(model.messages.length, 1)
  model.applyFrame({
    t: 'session/state',
    sessionId: 'sess_1',
    sessionEpoch: 0,
    head: 4,
    snapshot: {
      messages: [
        { id: 'hist_3', kind: 'user', msgId: 'dsh_m2', text: '桌面发的问题', at: '2026-10-26T11:58:00.000Z', seq: 3 },
      ],
    },
  })
  assert.equal(model.messages.length, 1, '同一条桌面消息不能因为快照多一条')
  assert.equal(model.messages[0].id, userMessageId('dsh_m2'))
})

test('老服务端快照没有 msgId 时，同文本本地气泡也不会重复（兜底去重）', () => {
  const model = makeModel()
  model.addLocalUserMessage({ msgId: 'm3', text: '看这个', at: new Date().toISOString() })
  model.applyFrame({
    t: 'session/state',
    sessionId: 'sess_1',
    sessionEpoch: 0,
    head: 5,
    snapshot: {
      messages: [
        { id: 'hist_4', kind: 'user', text: '看这个\n\n用户通过手机发来了 1 个附件，已保存到电脑上：…', at: new Date().toISOString(), seq: 4 },
      ],
    },
  })
  assert.equal(model.messages.length, 1, '老服务端快照也要能按文本兜底合并')
  assert.equal(model.messages[0].id, userMessageId('m3'))
  assert.equal(model.messages[0].text, '看这个', '注入的附件提示必须剥掉')
})
