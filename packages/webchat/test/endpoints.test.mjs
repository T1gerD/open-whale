// 地址分类 / 排序 / 竞速选路测试。
//
// v2.2.0 的核心修复就在这一层：auto 必须是 Tailscale → 局域网 → 隧道，
// https 不再天然排第一，loopback 默认不可用。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildWebSocketUrl,
  classifyEndpoint,
  encodeEndpointKinds,
  isTailscaleHost,
  mergeEndpointSources,
  normalizeManualEndpoint,
  orderCandidates,
  orderEndpointCandidates,
  orderEndpoints,
  raceSet,
  summarizeCandidates,
} from '../lib/endpoints.mjs'

test('Tailscale 三种形态都能识别（含 CGNAT 边界）', () => {
  assert.equal(isTailscaleHost('100.64.0.1'), true)
  assert.equal(isTailscaleHost('100.101.2.3'), true)
  assert.equal(isTailscaleHost('100.127.255.254'), true)
  assert.equal(isTailscaleHost('100.63.255.254'), false)
  assert.equal(isTailscaleHost('100.128.0.1'), false)
  assert.equal(isTailscaleHost('macbook.tail1234.ts.net'), true)
  assert.equal(isTailscaleHost('MACBOOK.TS.NET'), true)
  assert.equal(isTailscaleHost('fd7a:115c:a1e0::1'), true)
  assert.equal(isTailscaleHost('[fd7a:115c:a1e0::1]'), true)
  assert.equal(isTailscaleHost('fd7a:115c:a1e1::1'), false)
  assert.equal(isTailscaleHost('192.168.1.5'), false)
  assert.equal(isTailscaleHost(''), false)
})

test('classifyEndpoint 覆盖所有网络类型', () => {
  assert.equal(classifyEndpoint('http://192.168.1.5:8787'), 'lan')
  assert.equal(classifyEndpoint('http://10.0.0.3:8787'), 'lan')
  assert.equal(classifyEndpoint('http://172.16.5.4:8787'), 'lan')
  assert.equal(classifyEndpoint('http://172.32.5.4:8787'), 'unknown')
  assert.equal(classifyEndpoint('http://100.101.2.3:8787'), 'tailscale')
  assert.equal(classifyEndpoint('https://mac.ts.net'), 'tailscale')
  assert.equal(classifyEndpoint('https://tunnel.example.com'), 'tunnel')
  assert.equal(classifyEndpoint('http://localhost:8787'), 'loopback')
  assert.equal(classifyEndpoint('http://127.0.0.1:8787'), 'loopback')
  assert.equal(classifyEndpoint('http://[::1]:8787'), 'loopback')
  assert.equal(classifyEndpoint('http://example.com:8787'), 'unknown')
  assert.equal(classifyEndpoint('nonsense'), 'unknown')
  assert.equal(classifyEndpoint(''), 'unknown')
})

test('auto 排序：Tailscale > 局域网 > 隧道 > 未知', () => {
  const endpoints = [
    'https://tunnel.example.com',
    'http://example.com:8787',
    'http://192.168.1.5:8787',
    'http://100.101.2.3:8787',
  ]
  assert.deepEqual(orderEndpointCandidates(endpoints).map(item => item.url), [
    'http://100.101.2.3:8787',
    'http://192.168.1.5:8787',
    'https://tunnel.example.com',
    'http://example.com:8787',
  ])
  // 「https 永远第一」的旧行为必须已经不存在。
  assert.notEqual(orderEndpointCandidates(endpoints)[0].url, 'https://tunnel.example.com')
})

test('上次成功的地址排第一（即使它不是首选网络类型）', () => {
  const endpoints = ['http://100.101.2.3:8787', 'http://192.168.1.5:8787', 'https://tunnel.example.com']
  const ordered = orderEndpointCandidates(endpoints, { preferred: 'https://tunnel.example.com' })
  assert.equal(ordered[0].url, 'https://tunnel.example.com')
  assert.deepEqual(ordered.slice(1).map(item => item.url), ['http://100.101.2.3:8787', 'http://192.168.1.5:8787'])
})

test('显式连接方式只保留该类型的地址', () => {
  const endpoints = ['http://100.101.2.3:8787', 'http://192.168.1.5:8787', 'https://tunnel.example.com']
  assert.deepEqual(orderEndpoints(endpoints, { mode: 'lan' }), ['http://192.168.1.5:8787'])
  assert.deepEqual(orderEndpoints(endpoints, { mode: 'tailscale' }), ['http://100.101.2.3:8787'])
  assert.deepEqual(orderEndpoints(endpoints, { mode: 'tunnel' }), ['https://tunnel.example.com'])
  // 该模式没有地址 → 空列表（UI 必须给可操作提示，不能静默失败）。
  assert.deepEqual(orderEndpoints(['http://192.168.1.5:8787'], { mode: 'tailscale' }), [])
})

test('loopback 默认排除，显式允许时永远最后', () => {
  const endpoints = ['http://100.101.2.3:8787', 'http://127.0.0.1:8787', 'http://192.168.1.5:8787']
  assert.deepEqual(orderEndpoints(endpoints).includes('http://127.0.0.1:8787'), false)
  const allowed = orderEndpointCandidates(endpoints, { allowLoopback: true })
  assert.equal(allowed[allowed.length - 1].url, 'http://127.0.0.1:8787')
})

test('去重 + 非字符串忽略 + 稳定排序', () => {
  const endpoints = ['http://192.168.1.5:8787', 'http://192.168.1.5:8787', 'http://10.0.0.2:8787', 42, null, '  ']
  assert.deepEqual(orderEndpoints(endpoints), ['http://192.168.1.5:8787', 'http://10.0.0.2:8787'])
  assert.deepEqual(orderEndpoints(undefined), [])
  assert.deepEqual(orderEndpoints('not-an-array'), [])
})

test('orderCandidates 优先使用二维码声明的 epk 类型', () => {
  // 声明成隧道地址的 https 主机：不能因为 https 就排到局域网之后（类型优先规则不变，
  // 但至少要按声明归类，而不是被 URL 猜测改写）。
  const candidates = [
    { url: 'https://custom.example.com', kind: 'tunnel' },
    { url: 'http://192.168.1.5:8787', kind: 'lan' },
    { url: 'http://100.101.2.3:8787', kind: 'tailscale' },
    { url: 'http://weird-host:8787', kind: 'lan' },
  ]
  assert.deepEqual(orderCandidates(candidates, { mode: 'auto' }).map(item => item.kind), [
    'tailscale',
    'lan',
    'lan',
    'tunnel',
  ])
  const declaredOnly = orderCandidates([{ url: 'https://example.com', kind: 'tailscale' }], { mode: 'tailscale' })
  assert.equal(declaredOnly.length, 1)
})

test('mergeEndpointSources：hello/ack 的 endpointList 覆盖二维码 epk', () => {
  const merged = mergeEndpointSources(
    {
      endpoints: ['http://192.168.1.5:8787', 'https://foo.example.com'],
      epk: ['l', 'c'],
    },
    [
      { url: 'https://foo.example.com', kind: 'tailscale' },
      { url: 'http://100.101.2.3:8787', kind: 'tailscale' },
    ],
  )
  assert.deepEqual(merged, [
    { url: 'http://192.168.1.5:8787', kind: 'lan' },
    { url: 'https://foo.example.com', kind: 'tailscale' },
    { url: 'http://100.101.2.3:8787', kind: 'tailscale' },
  ])
  assert.deepEqual(mergeEndpointSources({}, []), [])
})

test('raceSet 只取前两个候选（并发竞速）', () => {
  const ordered = [
    { url: 'http://100.101.2.3:8787', kind: 'tailscale' },
    { url: 'http://192.168.1.5:8787', kind: 'lan' },
    { url: 'https://tunnel.example.com', kind: 'tunnel' },
  ]
  assert.deepEqual(raceSet(ordered).map(item => item.url), [
    'http://100.101.2.3:8787',
    'http://192.168.1.5:8787',
  ])
  assert.equal(raceSet(ordered, 1).length, 1)
  assert.deepEqual(raceSet([]), [])
})

test('buildWebSocketUrl：http→ws、https→wss，路径丢弃', () => {
  assert.equal(buildWebSocketUrl('http://192.168.1.5:8787'), 'ws://192.168.1.5:8787/openwhale/ws')
  assert.equal(buildWebSocketUrl('https://abc.ts.net/'), 'wss://abc.ts.net/openwhale/ws')
  assert.equal(buildWebSocketUrl('ws://10.0.0.2:8787'), 'ws://10.0.0.2:8787/openwhale/ws')
  assert.equal(buildWebSocketUrl('http://192.168.1.5:8787/some/path?x=1'), 'ws://192.168.1.5:8787/openwhale/ws')
  assert.equal(buildWebSocketUrl('nonsense'), undefined)
})

test('normalizeManualEndpoint：host:port / http / https / 默认端口', () => {
  assert.deepEqual(normalizeManualEndpoint('192.168.1.5:8787'), { ok: true, url: 'http://192.168.1.5:8787' })
  assert.deepEqual(normalizeManualEndpoint('192.168.1.5'), { ok: true, url: 'http://192.168.1.5:8787' })
  assert.deepEqual(normalizeManualEndpoint('http://192.168.1.5:8787/'), { ok: true, url: 'http://192.168.1.5:8787' })
  assert.deepEqual(normalizeManualEndpoint('https://abc.ts.net'), { ok: true, url: 'https://abc.ts.net' })
  assert.deepEqual(normalizeManualEndpoint('100.101.2.3:8787'), { ok: true, url: 'http://100.101.2.3:8787' })
  assert.equal(normalizeManualEndpoint('').ok, false)
  assert.equal(normalizeManualEndpoint('has space:8787').ok, false)
  assert.equal(normalizeManualEndpoint('ftp://x').ok, false)
})

test('summarizeCandidates 给状态胶囊提供一行摘要', () => {
  assert.equal(summarizeCandidates([]), '没有可用地址')
  assert.equal(
    summarizeCandidates([
      { url: 'http://100.101.2.3:8787', kind: 'tailscale' },
      { url: 'http://192.168.1.5:8787', kind: 'lan' },
      { url: 'http://192.168.1.6:8787', kind: 'lan' },
    ]),
    'Tailscale×1 · 局域网×2',
  )
})

test('encodeEndpointKinds 输出单字母、与类型一一对应', () => {
  assert.deepEqual(
    encodeEndpointKinds([
      'http://192.168.1.5:8787',
      'http://100.101.2.3:8787',
      'https://tunnel.example.com',
      'http://127.0.0.1:8787',
      'http://example.com:8787',
    ]),
    ['l', 't', 'c', 'u', 'x'],
  )
})
