// 竞速连接规划与失败文案（纯逻辑）。
//
// 覆盖 PROTOCOL-V2 §7：并发竞速前两个候选、上次成功地址优先、连续失败给可操作文案。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENDPOINT_SWITCH_AFTER,
  RACE_CANDIDATES,
  createRetryState,
  describeTriedEndpoint,
  failureReport,
  onRaceFailed,
  onRaceWon,
  planRace,
} from '../src/core/connection-plan.mts'

const LADDER = ['http://100.88.1.2:8787', 'http://192.168.1.20:8787', 'https://a.trycloudflare.com']

test('a fresh plan races the first two candidates only', () => {
  const plan = planRace(LADDER, createRetryState())
  assert.equal(RACE_CANDIDATES, 2)
  assert.deepEqual(plan.endpoints, [LADDER[0], LADDER[1]])
  assert.deepEqual(plan.state.tried, [LADDER[0], LADDER[1]])
  assert.equal(plan.state.cursor, 2)
})

test('the remembered endpoint is raced first while failures stay below the threshold', () => {
  let state = createRetryState(LADDER[1])
  let plan = planRace(LADDER, state)
  assert.equal(plan.endpoints[0], LADDER[1])
  assert.equal(plan.endpoints.length, 2)
  state = onRaceFailed(plan.state, plan.endpoints)
  assert.equal(state.failures, 1)
  plan = planRace(LADDER, state)
  assert.equal(plan.endpoints[0], LADDER[1], 'still sticky on the second failure')
})

test('after the switch threshold the ladder rotates instead of sticking', () => {
  let state = createRetryState(LADDER[0])
  for (let i = 0; i < ENDPOINT_SWITCH_AFTER; i++) {
    const plan = planRace(LADDER, state)
    state = onRaceFailed(plan.state, plan.endpoints)
  }
  const rotated = planRace(LADDER, state)
  assert.notEqual(rotated.endpoints[0], LADDER[0], 'should have moved off the dead preferred endpoint')
  assert.ok(rotated.endpoints.length <= 2)
})

test('a single-address ladder still works, and an empty ladder yields no candidates', () => {
  const single = planRace([LADDER[0]], createRetryState())
  assert.deepEqual(single.endpoints, [LADDER[0]])
  const empty = planRace([], createRetryState())
  assert.deepEqual(empty.endpoints, [])
})

test('winning resets failures and remembers the working address', () => {
  let state = createRetryState()
  const plan = planRace(LADDER, state)
  state = onRaceFailed(plan.state, plan.endpoints)
  state = onRaceFailed(state, plan.endpoints)
  assert.equal(state.failures, 2)
  state = onRaceWon(state, LADDER[1])
  assert.deepEqual(state, { preferred: LADDER[1], failures: 0, cursor: 0, tried: [] })
})

test('failure copy lists what was tried and suggests concrete next steps', () => {
  let state = createRetryState()
  const plan = planRace(LADDER, state)
  state = onRaceFailed(plan.state, plan.endpoints)
  state = onRaceFailed(state, plan.endpoints)
  const report = failureReport(state, { mode: 'auto', maxAttempts: 12 })
  assert.match(report.message, /连续 2 次连接失败/)
  assert.match(report.message, /100\.88\.1\.2:8787/)
  assert.match(report.message, /Tailscale/)
  assert.match(report.hint, /重新扫描电脑上的二维码/)
  assert.match(report.hint, /手动输入电脑地址/)
  assert.deepEqual(report.triedEndpoints, [LADDER[0], LADDER[1]])
})

test('mode-specific failure copy explains why the mode cannot work', () => {
  const state = onRaceFailed(createRetryState(), ['http://100.88.1.2:8787'])
  assert.match(failureReport(state, { mode: 'tailscale' }).hint, /tailnet/)
  assert.match(failureReport(state, { mode: 'lan' }).hint, /Wi-Fi/)
  assert.match(failureReport(state, { mode: 'tunnel' }).hint, /隧道/)
})

test('describeTriedEndpoint adds the network kind so users understand the address', () => {
  assert.match(describeTriedEndpoint('http://100.88.1.2:8787'), /Tailscale/)
  assert.match(describeTriedEndpoint('http://192.168.1.20:8787'), /局域网/)
  assert.match(describeTriedEndpoint('https://a.trycloudflare.com'), /公网隧道/)
})
