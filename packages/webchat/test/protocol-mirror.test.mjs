// 协议镜像的「防漂移」测试。
//
// 网页版不能 import `packages/protocol`，所以自己抄了一份常量与校验逻辑。
// 这个测试把两边放在一起比对：常量 deepEqual、同一批载荷的校验结果 deepEqual、
// 同一批地址的排序结果 deepEqual。协议一改名/改行为，这里立刻变红。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as real from '../../protocol/src/index.mjs'
import * as mirror from '../lib/protocol.mjs'
import * as mirrorEndpoints from '../lib/endpoints.mjs'
import { parsePairingPayload as mirrorParsePairing } from '../lib/pairing.mjs'

/** 需要逐字一致的常量。 */
const CONSTANT_KEYS = [
  'PROTOCOL_VERSION',
  'CAPABILITIES',
  'ALL_CAPABILITIES',
  'CLIENT_FRAME',
  'SERVER_FRAME',
  'CONNECTION_MODE',
  'CONNECTION_MODES',
  'ENDPOINT_KIND',
  'ENDPOINT_KIND_CODE',
  'ENDPOINT_CODE_KIND',
  'POWER_REFUSAL',
  'ACTIVITY_KIND',
  'DEFAULT_PORT',
  'DEFAULT_HEARTBEAT_MS',
  'PAIR_SECRET_TTL_MS',
  'MAX_ASSISTANT_CHARS',
  'FILE_CHUNK_BYTES',
  'MAX_FILE_BYTES',
  'UPLOAD_CHUNK_BYTES',
  'MAX_UPLOAD_BYTES',
  'MAX_UPLOAD_ATTACHMENTS',
  'UPLOAD_IDLE_TIMEOUT_MS',
  'DEDUPE_TTL_MS',
  'DEDUPE_MAX_ENTRIES',
  'SESSION_EVENT_LOG_LIMIT',
  'SESSION_SNAPSHOT_LIMIT',
  'WEB_CLIENT_PATH',
  'DOWNLOAD_PATH',
]

test('lib/protocol.mjs 的常量与真实 protocol 逐项一致', () => {
  for (const key of CONSTANT_KEYS) {
    assert.ok(key in real, `真实 protocol 缺少导出 ${key}`)
    assert.deepEqual(mirror[key], real[key], `镜像常量 ${key} 与协议不一致`)
  }
})

test('签名字符串与真实 protocol 一致', () => {
  const cases = ['', 'abc', 'nonce-测试-123']
  for (const nonce of cases) {
    assert.equal(mirror.helloSignatureMessage(nonce), real.helloSignatureMessage(nonce))
    assert.equal(mirror.helloAckProofMessage(nonce, 'dev_1'), real.helloAckProofMessage(nonce, 'dev_1'))
  }
})

test('指纹格式化 / 截断行为与真实 protocol 一致', () => {
  const hex = 'deadBEEF00112233445566778899aabbccddeeff00112233'
  assert.equal(mirror.formatFingerprint(hex), real.formatFingerprint(hex))
  assert.equal(mirror.formatFingerprint(''), real.formatFingerprint(''))
  const long = 'x'.repeat(30_000)
  assert.deepEqual(mirror.clampAssistantText(long), real.clampAssistantText(long))
  assert.deepEqual(mirror.clampAssistantText('短文本'), real.clampAssistantText('短文本'))
})

/** 构造一份有效期合法的二维码载荷。 */
function validPayload(overrides = {}) {
  return {
    v: 1,
    p: 'openwhale',
    host: '我的电脑',
    id: 'cmp_abc123',
    fp: 'deadbeef00112233',
    pk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ',
    expires: '2099-01-01T00:00:00.000Z',
    endpoints: ['http://192.168.1.5:8787', 'https://abc.ts.net'],
    epk: ['l', 't'],
    web: 'http://192.168.1.5:8787/openwhale/app',
    mode: 'auto',
    ...overrides,
  }
}

const NOW = Date.parse('2026-10-26T00:00:00.000Z')

test('parsePairingPayload 在同一批用例上与真实 protocol 完全等价', () => {
  const cases = [
    validPayload(),
    validPayload({ mode: 'lan' }),
    validPayload({ mode: 'tailscale' }),
    validPayload({ mode: 'tunnel' }),
    validPayload({ epk: undefined, web: undefined, mode: undefined }),
    validPayload({ pk: undefined }),
    validPayload({ host: '' }),
    validPayload({ p: 'other' }),
    validPayload({ v: 2 }),
    validPayload({ endpoints: [] }),
    validPayload({ endpoints: [1, 2] }),
    validPayload({ epk: 'lt' }),
    validPayload({ epk: [1] }),
    validPayload({ web: '' }),
    validPayload({ mode: 'warp' }),
    validPayload({ expires: 'not-a-date' }),
    validPayload({ expires: '2026-10-25T23:59:59.000Z' }),
    validPayload({ secret: 42 }),
    validPayload({ pk: '' }),
    null,
    'string',
    42,
    {},
  ]
  for (const [index, value] of cases.entries()) {
    const mine = mirrorParsePairing(value, { now: NOW })
    const theirs = real.parsePairingPayload(value, { now: NOW })
    assert.deepEqual(mine, theirs, `第 ${index} 个用例结果不一致`)
  }
})

test('endpoint 分类与真实 protocol 一致', () => {
  const endpoints = [
    'http://100.64.0.1:8787',
    'http://100.127.255.254:8787',
    'http://100.63.0.1:8787',
    'http://100.128.0.1:8787',
    'https://macbook.tail1234.ts.net',
    'http://192.168.1.5:8787',
    'http://10.0.0.2:8787',
    'http://172.16.0.1:8787',
    'http://172.32.0.1:8787',
    'https://example.com',
    'http://example.com:8787',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
    'http://[fd7a:115c:a1e0::1]:8787',
    'ws://192.168.1.5:8787',
    'not a url',
    '',
  ]
  for (const endpoint of endpoints) {
    assert.equal(mirrorEndpoints.classifyEndpoint(endpoint), real.classifyEndpoint(endpoint), endpoint)
  }
  for (const host of ['100.64.1.2', '100.63.1.2', 'abc.ts.net', 'fd7a:115c:a1e0::1', '192.168.1.1', 'example.com', '']) {
    assert.equal(mirrorEndpoints.isTailscaleHost(host), real.isTailscaleHost(host), host)
  }
})

test('endpoint 排序与真实 protocol 一致', () => {
  const endpointSets = [
    ['https://tunnel.example.com', 'http://192.168.1.5:8787', 'http://100.101.2.3:8787'],
    ['http://192.168.1.5:8787', 'https://tunnel.example.com'],
    ['http://127.0.0.1:8787', 'http://192.168.1.5:8787'],
    ['http://100.101.2.3:8787', 'http://100.101.2.3:8787'],
    [],
  ]
  const optionSets = [
    {},
    { mode: 'auto' },
    { mode: 'lan' },
    { mode: 'tailscale' },
    { mode: 'tunnel' },
    { mode: 'auto', preferred: 'http://192.168.1.5:8787' },
    { mode: 'auto', allowLoopback: true },
    { mode: 'lan', preferred: 'https://tunnel.example.com' },
  ]
  for (const endpoints of endpointSets) {
    for (const options of optionSets) {
      const mine = mirrorEndpoints.orderEndpointCandidates(endpoints, options)
      const theirs = real.orderEndpointCandidates(endpoints, options)
      assert.deepEqual(mine, theirs, `${JSON.stringify(endpoints)} / ${JSON.stringify(options)}`)
      assert.deepEqual(
        mirrorEndpoints.orderEndpoints(endpoints, options),
        real.orderEndpoints(endpoints, options),
        `orderEndpoints ${JSON.stringify(options)}`,
      )
      assert.equal(
        mirrorEndpoints.pickEndpoint(endpoints, options.preferred, options),
        real.pickEndpoint(endpoints, options.preferred, options),
        `pickEndpoint ${JSON.stringify(options)}`,
      )
    }
  }
})

test('epk 编解码与真实 protocol 一致', () => {
  const endpoints = [
    'http://192.168.1.5:8787',
    'http://100.101.2.3:8787',
    'https://tunnel.example.com',
    'http://127.0.0.1:8787',
    'http://example.com:8787',
  ]
  assert.deepEqual(mirrorEndpoints.encodeEndpointKinds(endpoints), real.encodeEndpointKinds(endpoints))
  const epk = real.encodeEndpointKinds(endpoints)
  assert.deepEqual(mirrorEndpoints.parseEndpointKinds(endpoints, epk), real.parseEndpointKinds(endpoints, epk))
  // 缺项 / 非法项按 URL 兜底分类，两边一致。
  const brokenEpk = ['t']
  assert.deepEqual(
    mirrorEndpoints.parseEndpointKinds(endpoints, brokenEpk),
    real.parseEndpointKinds(endpoints, brokenEpk),
  )
})
