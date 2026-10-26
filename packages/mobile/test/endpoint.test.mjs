// endpoint 解析、网络类型分类、连接候选排序、手动地址规范化。
//
// v2.2.0 起分类/排序委托给 `packages/protocol`（唯一权威），这里验证手机端
// 叠加上去的语义：上次成功优先、显式连接方式过滤、USB 仅内部测试、手动输入规范化。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONNECTION_MODE,
  DEFAULT_PORT,
  connectionModeLabel,
  endpointKind,
  endpointKindLabel,
  endpointLabel,
  endpointLadder,
  healthUrlFor,
  httpUrlFor,
  isEndpointPermitted,
  isTailscaleEndpoint,
  looksLocal,
  missingModeHint,
  normalizeConnectionMode,
  normalizeEndpoint,
  normalizeEndpoints,
  normalizeManualAddress,
  parseEndpoint,
  wsUrlFor,
  WS_PATH,
} from '../src/core/endpoint.mts'

const TAILSCALE = 'http://100.88.1.2:8787'
const LAN = 'http://192.168.1.20:8787'
const TUNNEL = 'https://quiet-whale.trycloudflare.com'
const USB = 'http://127.0.0.1:8787'

test('wsUrlFor upgrades the scheme and appends the gateway path', () => {
  assert.equal(WS_PATH, '/openwhale/ws')
  assert.equal(wsUrlFor(TUNNEL), 'wss://quiet-whale.trycloudflare.com/openwhale/ws')
  assert.equal(wsUrlFor(LAN), 'ws://192.168.1.20:8787/openwhale/ws')
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

test('Tailscale is its own network kind, not a LAN address', () => {
  // 这是 v2.1.0 的核心缺陷：100.64.0.0/10 不在私有网段判断里，被当成公网 https 之外的东西。
  assert.equal(endpointKind('http://100.64.0.5:8787'), 'tailscale')
  assert.equal(endpointKind('http://100.127.255.254:8787'), 'tailscale')
  assert.equal(endpointKind('http://[fd7a:115c:a1e0::1]:8787'), 'tailscale')
  assert.equal(endpointKind('https://desktop.tail1a2b3c.ts.net'), 'tailscale')
  assert.equal(isTailscaleEndpoint('http://100.88.1.2:8787'), true)
  assert.equal(isTailscaleEndpoint('http://192.168.1.2:8787'), false)
  assert.equal(endpointKind(LAN), 'lan')
  assert.equal(endpointKind('http://10.0.0.4:8787'), 'lan')
  assert.equal(endpointKind(TUNNEL), 'tunnel')
  assert.equal(endpointKind(USB), 'loopback')
  assert.equal(endpointKind('http://8.8.8.8:8787'), 'unknown')
})

test('auto ordering is Tailscale > LAN > tunnel (https no longer wins)', () => {
  const endpoints = [TUNNEL, LAN, TAILSCALE, USB]
  assert.deepEqual(endpointLadder(endpoints, undefined), [TAILSCALE, LAN, TUNNEL])
  // 记住上次成功的地址：它先试一次，其余仍按协议顺序
  assert.deepEqual(endpointLadder(endpoints, TUNNEL), [TUNNEL, TAILSCALE, LAN])
  assert.deepEqual(endpointLadder(endpoints, LAN), [LAN, TAILSCALE, TUNNEL])
})

test('USB loopback is only allowed in internal test mode and always last', () => {
  const endpoints = [USB, TAILSCALE]
  assert.deepEqual(endpointLadder(endpoints, undefined), [TAILSCALE])
  assert.deepEqual(endpointLadder(endpoints, USB, { allowUsb: true }), [USB, TAILSCALE])
  // 关掉测试模式后，记住的 USB 地址也不能再被优先使用
  assert.deepEqual(endpointLadder(endpoints, USB, { allowUsb: false }), [TAILSCALE])
})

test('explicit connection modes keep only their own kind of address', () => {
  const endpoints = [TUNNEL, LAN, TAILSCALE]
  assert.deepEqual(endpointLadder(endpoints, undefined, { mode: CONNECTION_MODE.LAN }), [LAN])
  assert.deepEqual(endpointLadder(endpoints, undefined, { mode: CONNECTION_MODE.TAILSCALE }), [TAILSCALE])
  assert.deepEqual(endpointLadder(endpoints, undefined, { mode: CONNECTION_MODE.TUNNEL }), [TUNNEL])
  assert.deepEqual(endpointLadder([TUNNEL], undefined, { mode: CONNECTION_MODE.TAILSCALE }), [])
  assert.equal(isEndpointPermitted(LAN, { mode: CONNECTION_MODE.TAILSCALE }), false)
  assert.equal(isEndpointPermitted(TUNNEL, {}), true)
  assert.equal(isEndpointPermitted(USB, {}), false)
  assert.equal(isEndpointPermitted(USB, { allowUsb: true }), true)
})

test('missingModeHint explains what to do when an explicit mode has no address', () => {
  assert.equal(missingModeHint(CONNECTION_MODE.AUTO, [TUNNEL]), undefined)
  assert.equal(missingModeHint(CONNECTION_MODE.TAILSCALE, [TAILSCALE]), undefined)
  const tailscale = missingModeHint(CONNECTION_MODE.TAILSCALE, [TUNNEL, LAN])
  assert.match(tailscale, /Tailscale/)
  assert.match(tailscale, /tailnet/)
  const lan = missingModeHint(CONNECTION_MODE.LAN, [TUNNEL])
  assert.match(lan, /Wi-Fi/)
  const tunnel = missingModeHint(CONNECTION_MODE.TUNNEL, [LAN])
  assert.match(tunnel, /重新生成二维码/)
})

test('endpoint labels tell the user which line is in use', () => {
  assert.equal(endpointKindLabel('tailscale'), 'Tailscale')
  assert.equal(endpointKindLabel('lan'), '局域网')
  assert.equal(endpointKindLabel('tunnel'), '公网隧道')
  assert.equal(endpointKindLabel('loopback'), 'USB 调试通道')
  assert.equal(endpointKindLabel('mystery'), '未知网络')
  assert.equal(endpointLabel(TUNNEL), '公网隧道')
  assert.equal(endpointLabel(LAN), '局域网')
  assert.equal(endpointLabel(TAILSCALE), 'Tailscale')
  assert.equal(endpointLabel('garbage'), '地址无效')
  assert.equal(connectionModeLabel('auto'), '自动')
  assert.equal(connectionModeLabel('tailscale'), 'Tailscale')
  assert.equal(connectionModeLabel('nope'), '自动')
  assert.equal(normalizeConnectionMode('lan'), 'lan')
  assert.equal(normalizeConnectionMode('bogus'), 'auto')
  assert.equal(looksLocal(LAN), true)
  assert.equal(looksLocal(TAILSCALE), false)
  assert.equal(looksLocal(TUNNEL), false)
})

test('hand-typed addresses are normalised into a usable endpoint', () => {
  const cases = [
    ['192.168.1.5:8787', `http://192.168.1.5:8787`],
    ['192.168.1.5', `http://192.168.1.5:${DEFAULT_PORT}`],
    ['  192.168.1.5:8787/  ', 'http://192.168.1.5:8787'],
    ['http://192.168.1.5:8787/', 'http://192.168.1.5:8787'],
    ['https://desk.tail1a2b3c.ts.net', 'https://desk.tail1a2b3c.ts.net'],
    ['ws://192.168.1.5:8787/openwhale/ws', 'http://192.168.1.5:8787'],
    ['wss://desk.tail1a2b3c.ts.net/openwhale/ws', 'https://desk.tail1a2b3c.ts.net'],
    ['192.168.1.5:8787/whale', 'http://192.168.1.5:8787/whale'],
    ['[fd7a:115c:a1e0::1]:8787', 'http://[fd7a:115c:a1e0::1]:8787'],
    ['fd7a:115c:a1e0::1', 'http://[fd7a:115c:a1e0::1]:8787'],
  ]
  for (const [input, expected] of cases) {
    const result = normalizeManualAddress(input)
    assert.equal(result.ok, true, `expected ok: ${input}`)
    assert.equal(result.endpoint, expected, input)
  }
  // 分类结果与地址本身一致（UI 的「测试连接」会显示它）
  const tailscale = normalizeManualAddress('100.88.1.2:8787')
  assert.equal(tailscale.ok, true)
  assert.equal(tailscale.kind, 'tailscale')
  assert.equal(tailscale.label, 'Tailscale')
})

test('hand-typed addresses reject junk with actionable copy', () => {
  for (const input of ['', '   ', 'not a host', 'http://', 'https://host:99999', 42, null]) {
    const result = normalizeManualAddress(input)
    assert.equal(result.ok, false, `expected reject: ${String(input)}`)
    assert.ok(result.message.length > 0)
  }
  assert.match(normalizeManualAddress('').message, /请输入电脑地址/)
})

test('health preflight URL is derived from any endpoint shape', () => {
  assert.equal(httpUrlFor('http://192.168.1.5:8787/'), 'http://192.168.1.5:8787')
  assert.equal(httpUrlFor(TUNNEL), TUNNEL)
  assert.equal(httpUrlFor('wss://desk.tail1a2b3c.ts.net/openwhale/ws'), 'https://desk.tail1a2b3c.ts.net/openwhale/ws')
  assert.equal(httpUrlFor('ws://host:1/whale'), 'http://host:1/whale')
  assert.equal(healthUrlFor('http://192.168.1.5:8787'), 'http://192.168.1.5:8787/openwhale/health')
  assert.equal(healthUrlFor('https://a.example/whale/'), 'https://a.example/whale/openwhale/health')
  assert.equal(healthUrlFor('garbage'), undefined)
})
