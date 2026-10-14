// endpoint 解析、WebSocket URL 推导与重连地址阶梯。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  endpointLabel,
  endpointLadder,
  looksLocal,
  normalizeEndpoint,
  normalizeEndpoints,
  parseEndpoint,
  wsUrlFor,
  WS_PATH,
} from '../src/core/endpoint.mts'

test('wsUrlFor upgrades the scheme and appends the gateway path', () => {
  assert.equal(WS_PATH, '/openwhale/ws')
  assert.equal(wsUrlFor('https://quiet-whale.trycloudflare.com'), 'wss://quiet-whale.trycloudflare.com/openwhale/ws')
  assert.equal(wsUrlFor('http://192.168.1.20:8787'), 'ws://192.168.1.20:8787/openwhale/ws')
  assert.equal(wsUrlFor('http://192.168.1.20:8787/'), 'ws://192.168.1.20:8787/openwhale/ws')
  assert.equal(wsUrlFor('http://[::1]:8787'), 'ws://[::1]:8787/openwhale/ws')
})

test('wsUrlFor leaves an explicit websocket entry point alone', () => {
  assert.equal(wsUrlFor('wss://x.example.com/openwhale/ws'), 'wss://x.example.com/openwhale/ws')
  assert.equal(wsUrlFor('ws://x.example.com/custom'), 'ws://x.example.com/custom')
})

test('wsUrlFor keeps a reverse-proxy path prefix', () => {
  assert.equal(wsUrlFor('https://gateway.example.com/whale'), 'wss://gateway.example.com/whale/openwhale/ws')
})

test('wsUrlFor rejects everything that is not an http(s)/ws(s) url', () => {
  for (const value of ['', 'not a url', 'ftp://x/y', 'quiet-whale.trycloudflare.com', 42, null, undefined, 'https://']) {
    assert.equal(wsUrlFor(value), undefined, `expected reject: ${String(value)}`)
  }
})

test('parseEndpoint splits authority, port and IPv6 correctly', () => {
  assert.deepEqual(parseEndpoint('http://192.168.1.20:8787/x'), {
    scheme: 'http',
    host: '192.168.1.20',
    port: '8787',
    path: '/x',
    isSecure: false,
  })
  assert.equal(parseEndpoint('http://[fe80::1]:8787')?.host, '[fe80::1]')
  assert.equal(parseEndpoint('http://user:pass@host:1')?.host, 'host')
  assert.equal(parseEndpoint('http://host:99999'), undefined)
  assert.equal(parseEndpoint('http://'), undefined)
})

test('normalizeEndpoints drops junk, trailing slashes and duplicates', () => {
  assert.deepEqual(
    normalizeEndpoints(['https://a.example/', 'https://a.example', 'http://192.168.1.2:8787/', 17, 'nope', null]),
    ['https://a.example', 'http://192.168.1.2:8787'],
  )
  assert.deepEqual(normalizeEndpoints('https://a.example'), [])
  assert.equal(normalizeEndpoint('HTTPS://A.example/'), 'https://A.example')
})

test('the reconnect ladder puts the remembered endpoint first, then https', () => {
  const endpoints = ['http://192.168.1.20:8787', 'https://tunnel.example.com']
  assert.deepEqual(endpointLadder(endpoints, 'http://192.168.1.20:8787'), [
    'http://192.168.1.20:8787',
    'https://tunnel.example.com',
  ])
  // 刻意与 protocol 的 `pickEndpoint` 不同：那里要求 preferred 仍在列表里才用它，
  // 而重连阶梯会先试一次“上次成功的地址”——电脑端这次没通告局域网地址，不代表它失效了。
  // 失败后阶梯会继续走到下一个地址。
  assert.deepEqual(endpointLadder(endpoints, 'https://dead.example.com'), [
    'https://dead.example.com',
    'https://tunnel.example.com',
    'http://192.168.1.20:8787',
  ])
  // 阶梯不重复同一个地址（记住的地址如果也在通告列表里，只出现一次）
  assert.deepEqual(endpointLadder(endpoints, 'https://tunnel.example.com'), [
    'https://tunnel.example.com',
    'http://192.168.1.20:8787',
  ])
  assert.deepEqual(endpointLadder([], undefined), [])
  // 没有“上次成功地址”时与 protocol 的 pickEndpoint 一致：https 优先，其余按二维码顺序
  assert.deepEqual(endpointLadder(endpoints, undefined), ['https://tunnel.example.com', 'http://192.168.1.20:8787'])
})

test('endpointLabel and looksLocal describe the network position for the UI', () => {
  assert.equal(endpointLabel('https://a.trycloudflare.com'), '公网隧道')
  assert.equal(endpointLabel('http://192.168.1.5:8787'), '局域网')
  assert.equal(endpointLabel('garbage'), '地址无效')
  assert.equal(looksLocal('http://192.168.1.5:8787'), true)
  assert.equal(looksLocal('http://10.0.0.4:8787'), true)
  assert.equal(looksLocal('https://a.trycloudflare.com'), false)
})
