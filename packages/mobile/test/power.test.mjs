// 远程电源：倒计时、取消、拒绝原因的展示语义。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { POWER_REFUSAL } from '../src/core/frames.mts'
import {
  actionAllowed,
  applyPowerState,
  buildPowerRequest,
  cancelCopy,
  clampDelaySeconds,
  confirmCopy,
  formatCountdown,
  idlePowerState,
  normalizeAllowedActions,
  refusalMessage,
  tickPower,
} from '../src/core/power.mts'

const T0 = Date.parse('2026-03-03T10:00:00.000Z')

test('power requests clamp the grace period into the range the computer accepts', () => {
  assert.equal(clampDelaySeconds(undefined), 30)
  assert.equal(clampDelaySeconds(1), 5)
  assert.equal(clampDelaySeconds(10_000), 600)
  assert.equal(clampDelaySeconds(45.4), 45)
  assert.deepEqual(buildPowerRequest('shutdown', 'r1'), { t: 'power/request', rid: 'r1', action: 'shutdown', delaySeconds: 30 })
  assert.deepEqual(buildPowerRequest('restart', 'r2', 9999), { t: 'power/request', rid: 'r2', action: 'restart', delaySeconds: 600 })
  // 取消不带延时（电脑端也不需要）
  assert.deepEqual(buildPowerRequest('cancel', 'r3'), { t: 'power/request', rid: 'r3', action: 'cancel' })
})

test('an accepted shutdown starts a local countdown the UI can render', () => {
  const state = applyPowerState(idlePowerState(), { t: 'power/state', rid: 'r1', action: 'shutdown', accepted: true, delaySeconds: 30, cancelToken: 'pw_1' }, T0)
  assert.equal(state.phase, 'pending')
  assert.equal(state.action, 'shutdown')
  assert.equal(state.remainingSeconds, 30)
  assert.equal(state.cancelToken, 'pw_1')
  assert.equal(formatCountdown(state.remainingSeconds), '30 秒')

  const later = tickPower(state, T0 + 25_000)
  assert.equal(later.remainingSeconds, 5)
  assert.equal(later.phase, 'pending')

  const done = tickPower(later, T0 + 31_000)
  assert.equal(done.phase, 'executed')
  assert.equal(done.remainingSeconds, 0)
  assert.match(done.message, /关机/)
})

test('the computer’s executeAt wins over our own arithmetic when present', () => {
  const state = applyPowerState(
    idlePowerState(),
    { t: 'power/state', rid: 'r1', action: 'restart', accepted: true, delaySeconds: 30, executeAt: new Date(T0 + 90_000).toISOString() },
    T0,
  )
  assert.equal(state.executeAt, T0 + 90_000)
  assert.equal(state.remainingSeconds, 90)
})

test('cancelling clears the pending state', () => {
  const pending = applyPowerState(idlePowerState(), { t: 'power/state', rid: 'r1', action: 'shutdown', accepted: true, delaySeconds: 60 }, T0)
  const cancelled = applyPowerState(pending, { t: 'power/state', rid: 'r2', action: 'cancel', accepted: true, message: '已取消关机' }, T0 + 1000)
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(formatCountdown(cancelled.remainingSeconds), '')
  assert.equal(cancelCopy('shutdown'), '取消关机')
  assert.equal(cancelCopy('restart'), '取消重启')
})

test('refusals become specific, actionable Chinese explanations', () => {
  const cases = [
    [POWER_REFUSAL.UNSUPPORTED_PLATFORM, /不支持/],
    [POWER_REFUSAL.NO_PRIVILEGE, /权限/],
    [POWER_REFUSAL.DISABLED_BY_POLICY, /禁止/],
    [POWER_REFUSAL.ALREADY_PENDING, /已经有一个/],
    [POWER_REFUSAL.FAILED, /执行失败/],
  ]
  for (const [reason, pattern] of cases) {
    const state = applyPowerState(idlePowerState(), { t: 'power/state', rid: 'r', action: 'shutdown', accepted: false, reason }, T0)
    assert.equal(state.phase, 'refused')
    assert.equal(state.reason, reason)
    assert.match(state.message, pattern)
  }
  // 电脑端给了自己的解释时优先展示（例如“已有一个重启计划”具体到时间）
  assert.equal(refusalMessage(POWER_REFUSAL.ALREADY_PENDING, '已有一个重启计划在 10:05 执行'), '已有一个重启计划在 10:05 执行')
  assert.equal(refusalMessage('unknown-code', undefined), '操作被拒绝')
})

test('an unrelated power/state update does not silently clear a countdown', () => {
  const pending = applyPowerState(idlePowerState(), { t: 'power/state', rid: 'r1', action: 'shutdown', accepted: true, delaySeconds: 30 }, T0)
  const unknown = applyPowerState(pending, { t: 'power/state', rid: 'r2', accepted: true, message: '电脑端提示' }, T0 + 1000)
  assert.equal(unknown.phase, 'pending')
  assert.equal(unknown.remainingSeconds, 30)
  assert.equal(unknown.message, '电脑端提示')
})

test('countdown formatting is human, not log-like', () => {
  assert.equal(formatCountdown(0), '0 秒')
  assert.equal(formatCountdown(45), '45 秒')
  assert.equal(formatCountdown(60), '1 分')
  assert.equal(formatCountdown(95), '1 分 35 秒')
  assert.equal(formatCountdown(undefined), '')
})

test('confirmation copy names the action, the delay and the escape hatch', () => {
  const copy = confirmCopy('shutdown', 30)
  assert.match(copy.title, /关机/)
  assert.match(copy.message, /30 秒/)
  assert.match(copy.message, /取消关机/)
  assert.match(copy.confirm, /30 秒后关机/)
  // 超出范围的值会先被收敛，文案不能出现 “9999 秒”
  assert.match(confirmCopy('restart', 9999).message, /10 分/)
})

test('the computer decides which actions are allowed', () => {
  assert.deepEqual(normalizeAllowedActions(undefined), ['shutdown', 'restart', 'cancel'])
  assert.deepEqual(normalizeAllowedActions(['cancel']), ['cancel'])
  assert.deepEqual(normalizeAllowedActions(['shutdown', 'cancel', 'bogus']), ['shutdown', 'cancel'])
  assert.deepEqual(normalizeAllowedActions([]), ['cancel'])
  assert.equal(actionAllowed(['cancel'], 'shutdown'), false)
  assert.equal(actionAllowed(['cancel'], 'cancel'), true)
  assert.equal(actionAllowed(undefined, 'restart'), true)
})
