// 竞速连接记账器（纯逻辑）：Lead 复现的「两条都 ack 然后被电脑端踢一条」不会死循环。
//
// 这个测试用假 race server 的事件序列驱动纯状态机（connection.ts 的 socket 层只是
// 把这些事件转进来；RN 的 WebSocket/AppState 在 node --test 里不可用，所以把判定
// 逻辑单独抽出来测，等价于假 server 的行为断言）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nextBackoffMs } from '../src/core/backoff.mts'
import {
  MAX_RAPID_FLAPS,
  RAPID_FLAP_MS,
  RaceTracker,
  isReplacedClose,
} from '../src/core/race-state.mts'

const A = 'http://100.88.1.2:8787'
const B = 'http://192.168.1.20:8787'

/** 假 race server：两条候选都 ack，客户端选中先 ack 的那条，随后服务端踢掉它。 */
function raceRound() {
  const tracker = new RaceTracker()
  const round = tracker.beginRound([A, B])
  assert.equal(round.attempts.length, 2)
  return { tracker, round, first: round.attempts[0], second: round.attempts[1] }
}

test('both candidates may ack; only the first one wins and the other is a loser', () => {
  const { tracker, round, first, second } = raceRound()
  assert.equal(tracker.markAck(round.generation, first.id), 'won')
  // 第二个即使也收到 ack 也不能覆盖
  assert.equal(tracker.markAck(round.generation, second.id), 'lost')
  assert.equal(tracker.isWinner(round.generation, first.id), true)
  assert.equal(tracker.isWinner(round.generation, second.id), false)
  // 落选者 socket 关闭：忽略，不触发重连
  const loserClose = tracker.resolveClose(round.generation, second.id, { code: 1000, reason: 'replaced by a newer connection' }, 1_000)
  assert.equal(loserClose.kind, 'loser')
})

test('old rounds are stale: a late ack/close from a previous race cannot win or reconnect', () => {
  const { tracker, round, first } = raceRound()
  // 用户点了重连：新一轮开始，上一轮的 attempt 全部作废
  const next = tracker.beginRound([A, B])
  assert.notEqual(next.generation, round.generation)
  assert.equal(tracker.markAck(round.generation, first.id), 'stale')
  assert.equal(tracker.resolveClose(round.generation, first.id, { code: 1006 }, 2_000).kind, 'stale')
  assert.equal(tracker.isWinner(round.generation, first.id), false)
  // 新轮次可以正常选出胜者
  assert.equal(tracker.markAck(next.generation, next.attempts[0].id), 'won')
})

test('a stable connection that drops after the flap window reconnects normally', () => {
  const { tracker, round, first } = raceRound()
  tracker.markAck(round.generation, first.id)
  const t0 = 10_000
  assert.equal(tracker.adopt(round.generation, first.id, t0), true)
  const decision = tracker.resolveClose(round.generation, first.id, { code: 1006, reason: 'network lost' }, t0 + RAPID_FLAP_MS + 1)
  assert.equal(decision.kind, 'reconnect')
  assert.equal(decision.backoffAttempt, 0)
  assert.equal(tracker.flapCount, 0)
})

test('replaced immediately after connecting backs off instead of reconnecting every second', () => {
  const { tracker, round, first } = raceRound()
  tracker.markAck(round.generation, first.id)
  const t0 = 10_000
  tracker.adopt(round.generation, first.id, t0)
  // 服务端「同 device 新连接踢旧连接」：胜出连接 300ms 后被 replaced
  const decision = tracker.resolveClose(
    round.generation,
    first.id,
    { code: 1000, reason: 'replaced by a newer connection' },
    t0 + 300,
  )
  assert.equal(decision.kind, 'flap')
  assert.equal(decision.flapCount, 1)
  assert.match(decision.lastError, /替换/)
  assert.match(decision.hint, /另一台设备|重新扫码/)
  // 退避指数不是 0：第一次抖动就用 2s，而不是 1s 一圈
  assert.equal(decision.backoffAttempt, 1)
  assert.ok(nextBackoffMs(decision.backoffAttempt) >= 1_500)
})

test('repeated rapid kicks grow the backoff and eventually stop with actionable copy', () => {
  const { tracker, round, first } = raceRound()
  let generation = round.generation
  let attemptId = first.id
  const delays = []
  const started = 10_000
  for (let i = 0; i < MAX_RAPID_FLAPS; i++) {
    // 每轮重新竞速：先 ack、adopt，然后 200ms 就被踢
    const next = tracker.beginRound([A, B])
    generation = next.generation
    attemptId = next.attempts[0].id
    tracker.markAck(generation, attemptId)
    tracker.adopt(generation, attemptId, started + i * 1_000)
    const decision = tracker.resolveClose(
      generation,
      attemptId,
      { code: 1000, reason: 'replaced by a newer connection' },
      started + i * 1_000 + 200,
    )
    if (i < MAX_RAPID_FLAPS - 1) {
      assert.equal(decision.kind, 'flap', `第 ${i + 1} 次抖动应该退避而不是 fail`)
      delays.push(decision.backoffAttempt)
    } else {
      // 达到上限：停止自动重连，给可操作文案（不是无限循环）
      assert.equal(decision.kind, 'fail')
      assert.match(decision.hint, /关闭其他正在使用同一绑定的|重新扫码/)
      assert.match(decision.lastError, /替换/)
    }
  }
  // 退避指数严格递增 2s→4s→8s→16s，避免 1 秒死循环
  assert.deepEqual(delays, [1, 2, 3, 4])
  for (let i = 1; i < delays.length; i++) assert.ok(nextBackoffMs(delays[i]) > nextBackoffMs(delays[i - 1]))
})

test('a rapid kick that is not marked replaced is still treated as a flap', () => {
  const { tracker, round, first } = raceRound()
  tracker.markAck(round.generation, first.id)
  tracker.adopt(round.generation, first.id, 5_000)
  const decision = tracker.resolveClose(round.generation, first.id, { code: 1006 }, 5_000 + 100)
  assert.equal(decision.kind, 'flap')
  assert.match(decision.lastError, /刚建立就断开/)
})

test('isReplacedClose recognises the gateway phrasing without false positives', () => {
  assert.equal(isReplacedClose({ reason: 'replaced by a newer connection' }), true)
  assert.equal(isReplacedClose({ code: 1000, reason: 'Server shutting down' }), false)
  assert.equal(isReplacedClose({}), false)
})
