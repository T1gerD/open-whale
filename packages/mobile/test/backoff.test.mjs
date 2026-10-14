// 重连退避：序列、封顶与抖动边界。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { backoffSequence, isRetryAllowed, nextBackoffMs } from '../src/core/backoff.mts'

test('the sequence doubles up to the 30s ceiling', () => {
  assert.deepEqual(backoffSequence(8, { jitter: 0 }), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('jitter stays inside ±20% and never exceeds the ceiling', () => {
  const high = backoffSequence(7, { random: () => 1 })
  const low = backoffSequence(7, { random: () => 0 })
  const middle = backoffSequence(7, { random: () => 0.5 })
  assert.deepEqual(low, [800, 1600, 3200, 6400, 12800, 24000, 24000])
  assert.deepEqual(high, [1200, 2400, 4800, 9600, 19200, 30000, 30000])
  assert.deepEqual(middle, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  for (const value of [...high, ...low]) {
    assert.ok(value <= 30_000, `超过上限：${value}`)
    assert.ok(value >= 1)
  }
})

test('the base case is 1s and clamps oversized inputs to the ceiling', () => {
  assert.equal(nextBackoffMs(0, { jitter: 0 }), 1000)
  assert.equal(nextBackoffMs(1, { baseMs: 30_000, maxMs: 30_000, jitter: 0 }), 30_000)
  assert.equal(nextBackoffMs(99, { jitter: 0 }), 30_000)
  // 负数/非整数一律当作第 0 次
  assert.equal(nextBackoffMs(-3, { jitter: 0 }), 1000)
  assert.equal(nextBackoffMs(1.7, { jitter: 0 }), 2000)
})

test('the ladder is non-decreasing for a fixed random source', () => {
  const sequence = backoffSequence(10, { random: () => 0.5 })
  for (let i = 1; i < sequence.length; i++) {
    assert.ok(sequence[i] >= sequence[i - 1], `第 ${i} 次比上一次短`)
  }
})

test('automatic retries stop after the attempt cap', () => {
  assert.equal(isRetryAllowed(0), true)
  assert.equal(isRetryAllowed(11), true)
  assert.equal(isRetryAllowed(12), false)
  assert.equal(isRetryAllowed(3, 3), false)
})
