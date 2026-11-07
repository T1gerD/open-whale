// 连接候选池：只增不减的老毛病（去重 / 上限 / preferred / 长期失效 / https 不被降级）。
//
// 这些用例都来自真实故障：隧道域名每次都变，库里的老地址越堆越多，重连时先撞一串
// 必然失败的地址；本地存过一条 http 变体时又把 https 的隧道地址降级成明文。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENDPOINT_FAILURE_LIMIT,
  ENDPOINT_POOL_LIMIT,
  mergeEndpointCandidates,
} from '../src/core/endpoint.mts'

test('duplicates are removed and the preferred endpoint stays first', () => {
  const merged = mergeEndpointCandidates({
    preferred: 'http://192.168.1.9:8787',
    discovered: ['http://192.168.1.9:8787/', 'https://quiet-whale.trycloudflare.com'],
    current: ['http://192.168.1.9:8787', 'http://192.168.1.20:8787'],
  })
  assert.equal(merged[0], 'http://192.168.1.9:8787')
  assert.deepEqual(merged, [
    'http://192.168.1.9:8787',
    'https://quiet-whale.trycloudflare.com',
    'http://192.168.1.20:8787',
  ])
})

test('the pool is capped so a reconnect never walks a growing list of dead addresses', () => {
  const discovered = Array.from({ length: ENDPOINT_POOL_LIMIT + 6 }, (_, index) => `http://192.168.1.${index + 10}:8787`)
  const merged = mergeEndpointCandidates({ preferred: discovered[0], discovered, current: [] })
  assert.equal(merged.length, ENDPOINT_POOL_LIMIT)
  assert.equal(merged[0], discovered[0])
})

test('long-term failed endpoints are dropped, but never the preferred one', () => {
  const merged = mergeEndpointCandidates({
    preferred: 'http://192.168.1.9:8787',
    discovered: ['http://192.168.1.20:8787', 'http://192.168.1.30:8787'],
    current: ['http://192.168.1.40:8787'],
    failed: ['http://192.168.1.20:8787', 'http://192.168.1.9:8787'],
  })
  assert.equal(merged.includes('http://192.168.1.20:8787'), false)
  assert.equal(merged.includes('http://192.168.1.9:8787'), true, '当前连接不能被失败计数丢掉')
  assert.equal(merged.includes('http://192.168.1.30:8787'), true)
  assert.equal(merged.includes('http://192.168.1.40:8787'), true)
})

test('a tunnel https endpoint is never downgraded to http for the same host', () => {
  // 本地存过 http 变体（老版本/手填），电脑端这次给的是 https 隧道
  const upgraded = mergeEndpointCandidates({
    preferred: undefined,
    discovered: ['https://quiet-whale.trycloudflare.com'],
    current: ['http://quiet-whale.trycloudflare.com'],
  })
  assert.deepEqual(upgraded, ['https://quiet-whale.trycloudflare.com'])

  // 反过来：http 后出现也绝不能把已经有的 https 顶掉
  const kept = mergeEndpointCandidates({
    preferred: undefined,
    discovered: ['http://quiet-whale.trycloudflare.com'],
    current: ['https://quiet-whale.trycloudflare.com'],
  })
  assert.deepEqual(kept, ['https://quiet-whale.trycloudflare.com'])
})

test('the just-connected preferred endpoint wins over a secure variant of the same host', () => {
  // 当前就是通过 http 连上的（例如 Tailscale 上没开 https）：合并不该把入口换掉
  const merged = mergeEndpointCandidates({
    preferred: 'http://100.88.1.2:8787',
    discovered: ['https://100.88.1.2:8787'],
    current: [],
  })
  assert.equal(merged[0], 'http://100.88.1.2:8787')
})

test('bad values and empty input degrade to an empty or clean list', () => {
  assert.deepEqual(mergeEndpointCandidates({}), [])
  assert.deepEqual(mergeEndpointCandidates({ current: 'nope', discovered: null, preferred: 42 }), [])
  assert.deepEqual(
    mergeEndpointCandidates({ discovered: ['not-a-url', 'ws://192.168.1.5:8787', '', null] }),
    ['ws://192.168.1.5:8787'],
  )
})

test('the failure threshold is a small, documented constant', () => {
  assert.equal(ENDPOINT_FAILURE_LIMIT, 3)
  assert.equal(ENDPOINT_POOL_LIMIT, 8)
})
