// 多端同步 reducer：chat/echo、chat/message、session/state、session/events、
// participants、collab/state、file/offered、upload/*、幂等 ack。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyChatState,
  fileOfferMessageId,
  hydrateChat,
  reduceChat,
  userMessageId,
} from '../src/core/reducer.mts'

const ASSISTANT = 'cmp_abc123'
const SELF = 'dev_self_123456789012'

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

test('a message from another device appears as a user bubble with its sender', () => {
  let state = run([{ t: 'state/identity', deviceId: SELF, at: 999 }])
  state = run(
    [
      {
        t: 'chat/echo',
        msgId: 'msg_remote_1',
        deviceId: 'dev_other_123456789012',
        speaker: '小王的手机',
        text: '大家看一下这个报错',
        at: '2026-10-26T10:00:00.000Z',
        seq: 1,
      },
    ],
    state,
  )
  assert.equal(state.messages.length, 1)
  const message = state.messages[0]
  assert.equal(message.id, userMessageId('msg_remote_1'))
  assert.equal(message.kind, 'user')
  assert.equal(message.mine, false)
  assert.equal(message.sender.deviceId, 'dev_other_123456789012')
  assert.equal(message.sender.name, '小王的手机')
  assert.equal(message.state, 'sent')
  assert.equal(state.sessionCursor, 1)
})

test('the echo of my own message merges into the local bubble instead of duplicating it', () => {
  let state = run([{ t: 'state/identity', deviceId: SELF, at: 999 }])
  state = run(
    [
      { t: 'user/send', rid: 'msg_own_1', msgId: 'msg_own_1', text: '帮我看看', at: 1000 },
      {
        t: 'chat/echo',
        msgId: 'msg_own_1',
        rid: 'msg_own_1',
        callId: 'call_1',
        deviceId: SELF,
        text: '帮我看看',
        seq: 2,
        at: '2026-10-26T10:00:01.000Z',
      },
    ],
    state,
  )
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].id, userMessageId('msg_own_1'))
  assert.equal(state.messages[0].state, 'sent')
  assert.equal(state.messages[0].callId, 'call_1')
  assert.equal(state.messages[0].mine, true)
})

test('chat/message upserts assistant text by messageId (replace, never append)', () => {
  const state = run([
    { t: 'chat/message', callId: 'c1', messageId: 'asst_1', index: 0, text: '第一段' },
    // 同一 messageId 的更新：全文替换
    { t: 'chat/message', callId: 'c1', messageId: 'asst_1', index: 0, text: '第一段（更新）' },
    // 重复投递同一帧：不会产生第二条消息
    { t: 'chat/message', callId: 'c1', messageId: 'asst_1', index: 0, text: '第一段（更新）' },
    { t: 'chat/done', callId: 'c1', text: '第一段（更新）' },
  ])
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].text, '第一段（更新）')
  assert.equal(state.messages[0].streaming, false)
})

test('multi-message turns keep their structure, and a duplicated done collapses to one bubble', () => {
  const structured = run([
    { t: 'chat/message', callId: 'c1', messageId: 'asst_1', index: 0, text: 'A' },
    { t: 'chat/message', callId: 'c1', messageId: 'asst_2', index: 1, text: 'B' },
    { t: 'chat/done', callId: 'c1', text: 'A\n\nB' },
  ])
  assert.equal(structured.messages.length, 2)
  assert.deepEqual(
    structured.messages.map(message => message.text),
    ['A', 'B'],
  )

  // 电脑端 v2.1.0 的重复拼接（同一段文本被 push N 次）：done 与本地拼装都是 T\n\nT，
  // 但语义上只有一个回答 —— 收敛成一条，并且只保留一份文本。
  const duplicated = run([
    { t: 'chat/message', callId: 'c2', messageId: 'asst_1', index: 0, text: 'T' },
    { t: 'chat/message', callId: 'c2', messageId: 'asst_2', index: 1, text: 'T' },
    { t: 'chat/done', callId: 'c2', text: 'T\n\nT' },
  ])
  assert.equal(duplicated.messages.length, 1)
  assert.equal(duplicated.messages[0].text, 'T')
})

test('session/state replaces the conversation on a session switch', () => {
  let state = run([
    { t: 'user/send', rid: 'r1', text: '旧会话里的消息', at: 10 },
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '旧回答' },
  ])
  state = run(
    [
      {
        t: 'session/state',
        sessionId: 'sess_2',
        sessionEpoch: 2,
        head: 42,
        collaboration: true,
        reset: true,
        snapshot: {
          messages: [
            { id: 'usr_old_1', kind: 'user', text: '之前的提问', at: '2026-10-26T09:00:00.000Z', msgId: 'old_1' },
            {
              id: 'msg_old_1',
              kind: 'assistant',
              text: '之前的回答',
              at: '2026-10-26T09:00:01.000Z',
              callId: 'call_old',
              messageId: 'asst_old',
            },
          ],
          activeCall: { callId: 'call_new', text: '正在生成', typing: true },
        },
      },
    ],
    state,
  )
  assert.equal(state.sessionId, 'sess_2')
  assert.equal(state.sessionEpoch, 2)
  assert.equal(state.collaboration, true)
  assert.equal(state.sessionCursor, 42)
  // 快照里的两条历史 + 进行中回合补出来的一条 streaming 消息
  assert.equal(state.messages.length, 3)
  assert.equal(state.messages[0].text, '之前的提问')
  assert.equal(state.messages[1].text, '之前的回答')
  assert.equal(state.messages[2].text, '正在生成')
  assert.equal(state.messages[2].streaming, true)
  assert.deepEqual(state.typing, { callId: 'call_new', active: true })
  assert.equal(state.callIndex.call_old, 'msg_old_1')
})

test('session/state is idempotent and drops empty assistant placeholder bubbles', () => {
  const snapshot = {
    t: 'session/state',
    sessionId: 'sess_1',
    sessionEpoch: 1,
    head: 10,
    collaboration: false,
    snapshot: {
      messages: [{ id: 'usr_a', kind: 'user', text: '问题', at: '2026-10-26T09:00:00.000Z', msgId: 'a' }],
    },
  }
  let state = run([
    // v2.1.0 跨设备 callId 错乱留下的空助手气泡
    { t: 'chat/delta', callId: 'ghost_call', seq: 1, text: '' },
    snapshot,
    snapshot,
  ])
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].id, 'usr_a')
  // 旧会话的本地消息在快照里保留（本地还没发出去的 pending 消息不能丢）
  let withPending = run(
    [
      { t: 'user/send', rid: 'local_pending', text: '还在队列里的消息', at: 10 },
      snapshot,
    ],
    emptyChatState(ASSISTANT),
  )
  assert.equal(withPending.messages.some(message => message.id === userMessageId('local_pending')), true)
})

test('session/events replays by seq and skips events already applied', () => {
  let state = run([{ t: 'state/identity', deviceId: SELF, at: 999 }])
  // 已经应用到 seq=2（重连前的游标）
  state = run([{ t: 'chat/echo', msgId: 'm2', deviceId: SELF, text: '2', seq: 2 }], state)
  assert.equal(state.sessionCursor, 2)
  state = run(
    [
      {
        t: 'session/events',
        sessionId: 'sess_1',
        from: 2,
        head: 4,
        events: [
          { t: 'chat/echo', msgId: 'm4', deviceId: SELF, text: '4', seq: 4 },
          { t: 'chat/echo', msgId: 'm3', deviceId: SELF, text: '3', seq: 3 },
          // 游标之内的重复事件必须丢弃
          { t: 'chat/echo', msgId: 'm2', deviceId: SELF, text: '2', seq: 2 },
        ],
      },
    ],
    state,
  )
  assert.equal(state.messages.length, 3)
  assert.deepEqual(
    state.messages.map(message => message.text),
    ['2', '3', '4'],
  )
  assert.equal(state.sessionCursor, 4)
})

test('participants and collaboration state drive the presence UI', () => {
  let state = run([
    {
      t: 'session/participants',
      sessionId: 'sess_1',
      collaboration: true,
      participants: [
        { deviceId: 'dev_a', name: '手机 A', online: true },
        { deviceId: 'dev_b', name: '手机 B', online: false },
        { deviceId: 'dev_a', name: '重复的 A', online: true },
      ],
    },
  ])
  assert.equal(state.collaboration, true)
  assert.deepEqual(state.participants, [
    { deviceId: 'dev_a', name: '手机 A', online: true },
    { deviceId: 'dev_b', name: '手机 B', online: false },
  ])

  state = run([{ t: 'collab/state', on: false, sessionId: 'sess_1', sessionEpoch: 1 }], state)
  assert.equal(state.collaboration, false)
  assert.equal(state.messages[state.messages.length - 1].kind, 'system')
  assert.match(state.messages[state.messages.length - 1].text, /关闭协作模式/)
})

test('file/offered becomes a download card without touching the transcript', () => {
  const state = run([
    {
      t: 'file/offered',
      fileId: 'file_1',
      name: '构建报告.pdf',
      size: 2048,
      mime: 'application/pdf',
      seq: 7,
    },
    // 重复推送同一文件：更新卡片，不新增消息
    { t: 'file/offered', fileId: 'file_1', name: '构建报告.pdf', size: 2048, mime: 'application/pdf', seq: 8 },
  ])
  assert.equal(state.transfers.file_1.status, 'offered')
  const card = state.messages.find(message => message.id === fileOfferMessageId('file_1'))
  assert.ok(card)
  assert.equal(card.files[0].fileId, 'file_1')
  assert.equal(state.messages.filter(message => message.files && message.files.length > 0).length, 1)
})

test('upload progress frames update the attachment chip on the user bubble', () => {
  let state = run([
    {
      t: 'user/send',
      rid: 'msg_1',
      msgId: 'msg_1',
      text: '看一下这张图',
      at: 1000,
      files: [{ fileId: 'upl_msg_1_0', name: 'photo.jpg', size: 1024, mime: 'image/jpeg', uploadId: 'upl_msg_1_0', uploadStatus: 'uploading', uploadedBytes: 0 }],
    },
    { t: 'upload/ready', uploadId: 'upl_msg_1_0', chunkBytes: 512, maxBytes: 1024 * 1024 },
    { t: 'upload/progress', uploadId: 'upl_msg_1_0', nextSeq: 1, received: 512 },
  ])
  assert.equal(state.uploads.upl_msg_1_0.phase, 'uploading')
  assert.equal(state.messages[0].files[0].uploadStatus, 'uploading')
  state = run([{ t: 'upload/done', uploadId: 'upl_msg_1_0', fileId: 'file_9', name: 'photo.jpg', size: 1024 }], state)
  assert.equal(state.uploads.upl_msg_1_0.phase, 'done')
  assert.equal(state.messages[0].files[0].uploadStatus, 'done')
  assert.equal(state.messages[0].files[0].uploadedBytes, 1024)
  state = run([{ t: 'upload/error', uploadId: 'upl_msg_1_0', code: 'disk', message: '磁盘满了' }], state)
  assert.equal(state.messages[0].files[0].uploadStatus, 'failed')
})

test('a duplicate ack still marks the message sent without creating a second bubble', () => {
  const state = run([
    { t: 'user/send', rid: 'msg_dup', text: '只发一次', at: 1000 },
    { t: 'chat/ack', rid: 'msg_dup', msgId: 'msg_dup', callId: 'call_x', duplicate: true },
    { t: 'chat/ack', rid: 'msg_dup', msgId: 'msg_dup', callId: 'call_x', duplicate: true },
  ])
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].state, 'sent')
  assert.equal(state.messages[0].callId, 'call_x')
})

test('a failed send carries retryable so the UI can pick retry vs change-settings', () => {
  // 网络断开：可重试
  let state = run([
    { t: 'user/send', rid: 'msg_net', text: '发图片', at: 1000 },
    { t: 'outbox/failed', rid: 'msg_net', reason: '网络断开：上传中断', retryable: true, at: 1001 },
  ])
  assert.equal(state.messages[0].state, 'failed')
  assert.equal(state.messages[0].retryable, true)

  // 电脑端拒绝：不可重试，用户要改设置/换文件
  state = run([
    { t: 'user/send', rid: 'msg_srv', text: '发图片', at: 2000 },
    { t: 'outbox/failed', rid: 'msg_srv', reason: '电脑端拒绝：磁盘空间不足', retryable: false, at: 2001 },
  ])
  assert.equal(state.messages[0].retryable, false)
  // 手动重试后清空错误与 retryable
  state = run([{ t: 'outbox/retry', rid: 'msg_srv', at: 3000 }], state)
  assert.equal(state.messages[0].retryable, undefined)
  assert.equal(state.messages[0].error, undefined)
})

test('stopping generation and removing a local message work', () => {
  let state = run([
    { t: 'chat/delta', callId: 'c1', seq: 0, text: '正在回答' },
  ])
  state = run([{ t: 'user/stop', callId: 'c1', at: 2000 }], state)
  assert.equal(state.messages[0].streaming, false)
  assert.equal(state.messages[0].interrupted, true)
  assert.equal(state.messages[state.messages.length - 1].kind, 'system')

  state = run([{ t: 'message/remove', messageId: state.messages[0].id, at: 3000 }], state)
  assert.equal(state.messages.some(message => message.id === 'msg_c1'), false)
})

test('hydrate restores ownership so peers messages render on the correct side', () => {
  const state = hydrateChat(
    ASSISTANT,
    [
      { id: 'usr_remote', kind: 'user', text: '别人的消息', at: 1, rid: 'remote', state: 'sent', deviceId: 'dev_other', sender: { deviceId: 'dev_other', name: 'B' } },
      { id: 'usr_local', kind: 'user', text: '我的消息', at: 2, rid: 'local', state: 'sent' },
    ],
    [],
    100,
    { selfDeviceId: 'dev_other' },
  )
  assert.equal(state.messages[0].mine, true)
  assert.equal(state.messages[1].mine, true, 'legacy local messages default to mine')
})

test('a snapshot aggregated bubble replaces local per-message bubbles of the same turn', () => {
  // 本地（chat-message-v1 路径）：同一 callId 下两条逐 message 气泡
  let state = run([
    { t: 'user/send', rid: 'u1', msgId: 'u1', text: '问题', at: 1000 },
    { t: 'chat/message', callId: 'c1', messageId: 'asst_1', index: 0, text: '第一段' },
    { t: 'chat/message', callId: 'c1', messageId: 'asst_2', index: 1, text: '第二段' },
    { t: 'chat/done', callId: 'c1', text: '第一段\n\n第二段' },
  ])
  assert.equal(state.messages.filter(message => message.kind === 'assistant').length, 2)

  // 离线超过事件日志窗口后重连：电脑端给的是「每回合一条聚合气泡」（id=msg_<callId>）
  state = run(
    [
      {
        t: 'session/state',
        sessionId: 'sess_1',
        sessionEpoch: 1,
        head: 500,
        collaboration: false,
        snapshot: {
          messages: [
            { id: 'usr_u1', kind: 'user', text: '问题', at: '2026-10-26T09:00:00.000Z', msgId: 'u1', callId: 'c1' },
            { id: 'msg_c1', kind: 'assistant', text: '第一段\n\n第二段', at: '2026-10-26T09:00:01.000Z', callId: 'c1' },
          ],
        },
      },
    ],
    state,
  )
  // 同一 callId 的逐 message 气泡被聚合气泡覆盖，不会出现重复回答
  assert.equal(state.messages.filter(message => message.kind === 'assistant').length, 1)
  assert.equal(state.messages.find(message => message.kind === 'assistant').text, '第一段\n\n第二段')
})
