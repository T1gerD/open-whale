// localStorage 持久化测试：坏数据不能让页面崩，绑定记录缺字段就当没绑定。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStorage, normalizeBinding, normalizeOutbox, normalizeSettings, parseStored } from '../lib/storage.mjs'

/** 内存版 Storage。 */
function createMemoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size
    },
  }
}

/** 模拟配额满 / 隐私模式的 Storage。 */
const brokenStorage = {
  getItem() {
    throw new Error('denied')
  },
  setItem() {
    throw new Error('quota')
  },
  removeItem() {
    throw new Error('denied')
  },
}

test('parseStored 对坏 JSON 返回 undefined 而不是抛错', () => {
  assert.equal(parseStored('{"a":1}').a, 1)
  assert.equal(parseStored('{bad'), undefined)
  assert.equal(parseStored(''), undefined)
  assert.equal(parseStored(null), undefined)
})

test('settings 规整：非法连接方式回到 auto，手动地址限 8 条', () => {
  assert.deepEqual(normalizeSettings(undefined), {
    mode: 'auto',
    preferredEndpoint: '',
    manualEndpoints: [],
    deviceName: '',
    standaloneHintDismissed: false,
    seenInstallHint: false,
    theme: 'auto',
  })
  const settings = normalizeSettings({
    mode: 'warp',
    manualEndpoints: ['http://a:1', 'not-a-url', 'http://b:2', ...Array.from({ length: 10 }, (_v, i) => `http://c${i}:1`)],
    deviceName: 'x'.repeat(40),
  })
  assert.equal(settings.mode, 'auto')
  assert.ok(settings.manualEndpoints.length <= 8)
  assert.equal(settings.manualEndpoints.includes('not-a-url'), false)
  assert.equal(settings.deviceName.length, 24)
  assert.equal(normalizeSettings({ mode: 'tailscale' }).mode, 'tailscale')
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark')
  assert.equal(normalizeSettings({ theme: 'neon' }).theme, 'auto')
})

test('binding 校验：缺关键字段 → undefined（避免半绑定状态）', () => {
  const good = {
    computerId: 'cmp_1',
    computerName: '电脑',
    fingerprint: 'deadbeef',
    deviceId: 'web_123',
    secretKeyB64: 'c2VjcmV0',
    publicKeySpkiB64: 'cGs',
    endpoints: [{ url: 'http://192.168.1.5:8787', kind: 'lan' }],
  }
  const normalized = normalizeBinding(good)
  assert.equal(normalized.computerId, 'cmp_1')
  assert.equal(normalized.mode, 'auto')
  assert.deepEqual(normalized.endpoints, [{ url: 'http://192.168.1.5:8787', kind: 'lan' }])
  assert.equal(normalizeBinding({ ...good, secretKeyB64: '' }), undefined)
  assert.equal(normalizeBinding(null), undefined)
  assert.equal(normalizeBinding({ ...good, endpoints: 'nope' }).endpoints.length, 0)
})

test('outbox 规整：最多 20 条，过滤非法条目', () => {
  const outbox = normalizeOutbox([
    { msgId: 'm1', text: '一' },
    { msgId: 42, text: '坏' },
    { text: '缺 id' },
    ...Array.from({ length: 30 }, (_v, index) => ({ msgId: `m${index + 2}`, text: `第 ${index}` })),
  ])
  assert.equal(outbox.length, 20)
  assert.equal(outbox[0].msgId, 'm1')
  assert.equal(normalizeOutbox(undefined).length, 0)
})

test('createStorage：绑定 / 设置 / 会话 / outbox 完整往返', () => {
  const storage = createStorage(createMemoryStorage())
  assert.equal(storage.loadBinding(), undefined)

  const binding = {
    computerId: 'cmp_1',
    computerName: '电脑',
    fingerprint: 'deadbeef',
    deviceId: 'web_123',
    secretKeyB64: 'c2VjcmV0',
    publicKeySpkiB64: 'cGs',
    endpoints: [],
  }
  assert.equal(storage.saveBinding(binding), true)
  assert.equal(storage.loadBinding().computerId, 'cmp_1')

  const settings = storage.saveSettings({ mode: 'lan', preferredEndpoint: 'http://a:1' })
  assert.equal(settings.mode, 'lan')
  assert.equal(storage.loadSettings().preferredEndpoint, 'http://a:1')
  const merged = storage.saveSettings({ deviceName: '小明' })
  assert.equal(merged.mode, 'lan', 'saveSettings 是合并而不是覆盖')

  storage.saveConversation('web_123', { cursor: 9, messages: [] })
  assert.equal(storage.loadConversation('web_123').cursor, 9)
  storage.clearConversation('web_123')
  assert.equal(storage.loadConversation('web_123'), undefined)

  storage.saveOutbox('web_123', [{ msgId: 'm1', text: '待发' }])
  assert.equal(storage.loadOutbox('web_123')[0].msgId, 'm1')
  storage.clearOutbox('web_123')
  assert.deepEqual(storage.loadOutbox('web_123'), [])

  storage.clearBinding()
  assert.equal(storage.loadBinding(), undefined)
})

test('createStorage：存储不可用时退化为内存，不抛错', () => {
  const storage = createStorage(brokenStorage)
  assert.equal(storage.available, true, '对象存在就算「有」，但每次读写失败')
  const settings = storage.saveSettings({ mode: 'tunnel' })
  assert.equal(settings.mode, 'tunnel')
  assert.equal(storage.loadSettings().mode, 'tunnel', '本页内仍能读到（内存兜底）')
  assert.equal(storage.saveBinding({}), false, '写失败返回 false，但不抛错')
})

test('createStorage：没有 localStorage 时也能工作（SSR / 隐私模式极端情况）', () => {
  const storage = createStorage(undefined)
  assert.equal(storage.available, false)
  assert.equal(storage.loadSettings().mode, 'auto')
  assert.equal(storage.setRaw('x', '1'), false)
  assert.equal(storage.getRaw('x'), '1')
})
