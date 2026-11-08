// 输入区右侧按钮的决策（发送 / 停止）——真机反馈过「生成中只能停，不能排队」，
// 这里把判断钉死：生成中 + 空输入才是停止，其余一律发送。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { composerAction } from '../src/core/composer.mts'

test('generating with an empty input shows the stop button', () => {
  assert.deepEqual(composerAction({ streaming: true }), { showStop: true, sendDisabled: true })
})

test('generating with text shows send so the message can queue', () => {
  assert.deepEqual(composerAction({ streaming: true, hasText: true }), { showStop: false, sendDisabled: false })
  // 附件同理：有附件时发送键可用（排队）。
  assert.deepEqual(composerAction({ streaming: true, hasAttachments: true }), { showStop: false, sendDisabled: false })
})

test('idle with text sends; idle and empty is disabled', () => {
  assert.deepEqual(composerAction({ streaming: false, hasText: true }), { showStop: false, sendDisabled: false })
  assert.equal(composerAction({ streaming: false }).sendDisabled, true)
})

test('no session or an in-flight send keeps the send button disabled', () => {
  assert.equal(composerAction({ hasSession: false, hasText: true }).sendDisabled, true)
  assert.equal(composerAction({ sending: true, hasText: true }).sendDisabled, true)
})
