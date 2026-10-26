// 绑定载荷解析测试：URL `#p=`、粘贴 JSON、裸 base64url 三条入口都要能通。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toBase64Url, utf8Encode } from '../lib/bytes.mjs'
import {
  bindingFromPayload,
  buildWebBindingUrl,
  candidatesForBinding,
  decodePayloadParam,
  describeBinding,
  deviceNameFromUserAgent,
  healthUrl,
  parsePairingInput,
  parsePairingPayload,
} from '../lib/pairing.mjs'

const NOW = Date.parse('2026-10-26T00:00:00.000Z')

function payload(overrides = {}) {
  return {
    v: 1,
    p: 'openwhale',
    host: '我的电脑',
    id: 'cmp_abc123',
    fp: 'deadbeef00112233',
    pk: 'cGs',
    secret: 'c2VjcmV0',
    expires: '2099-01-01T00:00:00.000Z',
    endpoints: ['http://192.168.1.5:8787', 'https://mac.ts.net'],
    epk: ['l', 't'],
    web: 'http://192.168.1.5:8787/openwhale/app',
    mode: 'auto',
    ...overrides,
  }
}

function encodePayload(value) {
  return toBase64Url(utf8Encode(JSON.stringify(value)))
}

test('从插件页面式 URL（#p=）解析绑定载荷', () => {
  const data = payload()
  const url = `http://192.168.1.5:8787/openwhale/app#p=${encodePayload(data)}`
  const result = parsePairingInput(url, { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'url')
  assert.equal(result.payload.id, data.id)
  assert.deepEqual(result.payload.endpoints, data.endpoints)
})

test('URL 里 percent-encoded 的 payload 也能解析', () => {
  const encoded = encodeURIComponent(encodePayload(payload()))
  const result = parsePairingInput(`#p=${encoded}`, { now: NOW })
  assert.equal(result.ok, true)
})

test('粘贴 JSON 解析', () => {
  const result = parsePairingInput(JSON.stringify(payload()), { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'json')
})

test('裸 base64url 解析', () => {
  const result = parsePairingInput(encodePayload(payload()), { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'base64url')
})

test('已经是对象时直接校验', () => {
  const result = parsePairingInput(payload(), { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'object')
})

test('明确拒绝各种坏输入', () => {
  const cases = [
    ['', '绑定内容为空'],
    ['   ', '绑定内容为空'],
    ['not json', '绑定内容既不是 JSON，也不是有效的绑定链接'],
    ['{bad json', '绑定内容不是合法 JSON'],
    ['#p=%%%%', '绑定二维码内容无法解码（base64url 不完整）'],
    [`http://192.168.1.5:8787/openwhale/app`, '链接里没有找到绑定参数（#p=…）'],
    [JSON.stringify(payload({ p: 'nope' })), '这不是 Open Whale 的绑定二维码'],
    [JSON.stringify(payload({ v: 2 })), '不支持的二维码版本：2'],
    [JSON.stringify(payload({ host: '' })), '二维码缺少字段：host'],
    [JSON.stringify(payload({ endpoints: [] })), '二维码缺少可用地址'],
    [JSON.stringify(payload({ epk: 'lt' })), '二维码字段 epk 格式不合法'],
    [JSON.stringify(payload({ web: '' })), '二维码字段 web 格式不合法'],
    [JSON.stringify(payload({ mode: 'warp' })), '未知的连接方式：warp'],
    [JSON.stringify(payload({ expires: 'nope' })), '二维码过期时间格式错误'],
  ]
  for (const [input, expected] of cases) {
    const result = parsePairingInput(input, { now: NOW })
    assert.equal(result.ok, false, String(input))
    assert.equal(result.error, expected, String(input))
  }
  assert.equal(parsePairingInput(null).ok, false)
  assert.equal(parsePairingInput(42).ok, false)
  assert.equal(parsePairingInput(undefined).ok, false)
})

test('过期时间必须在未来（等于当前时刻也不行）', () => {
  const expiresAt = new Date(NOW).toISOString()
  const result = parsePairingPayload(payload({ expires: expiresAt }), { now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.error, '二维码已过期，请在电脑上重新生成')
  const later = parsePairingPayload(payload({ expires: new Date(NOW + 1000).toISOString() }), { now: NOW })
  assert.equal(later.ok, true)
})

test('decodePayloadParam 支持 full URL 片段以外的一切输入形态', () => {
  const encoded = encodePayload(payload())
  assert.equal(decodePayloadParam(`#p=${encoded}`).ok, true)
  assert.equal(decodePayloadParam(`?p=${encoded}`).ok, true)
  assert.equal(decodePayloadParam(encoded).ok, true)
  assert.equal(decodePayloadParam('p=').ok, false)
  assert.equal(decodePayloadParam('').ok, false)
})

test('buildWebBindingUrl 生成的链接能被自己解析（插件二维码格式闭环）', () => {
  const url = buildWebBindingUrl('http://192.168.1.5:8787', payload())
  assert.match(url, /^http:\/\/192\.168\.1\.5:8787\/openwhale\/app#p=[A-Za-z0-9_-]+$/)
  const parsed = parsePairingInput(url, { now: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.payload.id, 'cmp_abc123')
  assert.throws(() => buildWebBindingUrl('nonsense', payload()), /baseUrl/)
})

test('bindingFromPayload 不保存一次性 secret，保留电脑信息与网络类型', () => {
  const binding = bindingFromPayload(payload(), { now: NOW })
  assert.equal(binding.computerId, 'cmp_abc123')
  assert.equal(binding.computerName, '我的电脑')
  assert.equal(binding.computerPublicKey, 'cGs')
  assert.equal(binding.mode, 'auto')
  assert.equal(binding.pairedAt, new Date(NOW).toISOString())
  assert.equal(JSON.stringify(binding).includes('c2VjcmV0'), false, '绑定记录不能包含配对 secret')
  assert.deepEqual(binding.endpoints, [
    { url: 'http://192.168.1.5:8787', kind: 'lan' },
    { url: 'https://mac.ts.net', kind: 'tailscale' },
  ])
  assert.equal(describeBinding(binding), '我的电脑 · 指纹 00112233')
})

test('candidatesForBinding 按连接方式过滤并让上次成功地址优先', () => {
  const binding = bindingFromPayload(payload(), { now: NOW })
  const candidates = candidatesForBinding(binding, { mode: 'auto', preferred: 'https://mac.ts.net' })
  assert.deepEqual(candidates.map(item => item.url), ['https://mac.ts.net', 'http://192.168.1.5:8787'])
  const lanOnly = candidatesForBinding(binding, { mode: 'lan' })
  assert.deepEqual(lanOnly.map(item => item.url), ['http://192.168.1.5:8787'])
  const tailscaleOnly = candidatesForBinding(binding, { mode: 'tailscale' })
  assert.deepEqual(tailscaleOnly.map(item => item.url), ['https://mac.ts.net'])
  const tunnelOnly = candidatesForBinding(binding, { mode: 'tunnel' })
  assert.deepEqual(tunnelOnly, [], '该设备没有隧道地址时，列表必须为空，让 UI 给出可操作提示')
  const withManual = candidatesForBinding(binding, {
    mode: 'auto',
    manualEndpoints: ['http://10.0.0.9:8787', 'http://10.0.0.9:8787'],
  })
  assert.equal(new Set(withManual.map(item => item.url)).size, withManual.length, '手动地址要按 URL 去重')
  assert.ok(withManual.some(item => item.url === 'http://10.0.0.9:8787'))
})

test('healthUrl 用于手动地址预检', () => {
  assert.equal(healthUrl('http://192.168.1.5:8787'), 'http://192.168.1.5:8787/openwhale/health')
  assert.equal(healthUrl('https://abc.ts.net/'), 'https://abc.ts.net/openwhale/health')
  assert.equal(healthUrl('nonsense'), undefined)
})

test('deviceNameFromUserAgent 覆盖鸿蒙 / iOS / Android / 桌面', () => {
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Phone; HarmonyOS 5.0)'), '网页版 · 鸿蒙')
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), '网页版 · iPhone')
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), '网页版 · iPad')
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel)'), '网页版 · Android')
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), '网页版 · Mac')
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '网页版 · Windows')
  assert.equal(deviceNameFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)'), '网页版 · Linux')
  assert.equal(deviceNameFromUserAgent(''), '网页版 · 浏览器')
})
