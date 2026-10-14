// 唤醒（远程开机）：只做引导与可选的唤醒代理，不伪造协议帧。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { expandWakeUrl, isValidWakeUrl, planWake, wakeGuidance } from '../src/core/wake.mts'

test('wake urls must be plain http(s) endpoints', () => {
  assert.equal(isValidWakeUrl('http://192.168.1.9:8787/wake'), true)
  assert.equal(isValidWakeUrl('https://wol.example.com/wake'), true)
  assert.equal(isValidWakeUrl('udp://192.168.1.9'), false)
  assert.equal(isValidWakeUrl('192.168.1.9/wake'), false)
  assert.equal(isValidWakeUrl(''), false)
  assert.equal(isValidWakeUrl(undefined), false)
})

test('placeholders are filled and never left half-expanded', () => {
  assert.equal(
    expandWakeUrl('http://wol.local/wake?id={computerId}&mac={mac}', { computerId: 'cmp_1', mac: 'AA:BB' }),
    'http://wol.local/wake?id=cmp_1&mac=AA%3ABB',
  )
  // 没填 MAC 时替换成空串，请求里不会留下 {mac}
  assert.equal(expandWakeUrl('http://wol.local/wake?mac={mac}', {}), 'http://wol.local/wake?mac=')
  assert.match(expandWakeUrl('http://wol.local/{name}', { name: '书房 电脑' }), /%20/)
  // {id} 是 {computerId} 的别名（电脑端的 WakeTarget 用 id 命名）
  assert.equal(expandWakeUrl('http://wol.local/wake?id={id}', { computerId: 'cmp_1' }), 'http://wol.local/wake?id=cmp_1')
})

test('without a wake proxy the app explains the physical constraint instead of faking a button', () => {
  const plan = planWake({}, { computerId: 'cmp_1', name: '书房电脑' })
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'unconfigured')
  assert.match(plan.message, /无法把电脑叫醒/)
  // 引导必须提到“同一局域网”这一物理限制，以及要配 MAC / 常开设备
  assert.ok(plan.guidance.some(line => line.includes('同一局域网')))
  assert.ok(plan.guidance.some(line => line.includes('MAC')))
  assert.ok(plan.guidance.some(line => line.includes('常开')))
})

test('a configured proxy yields a plain HTTP GET and honest expectations', () => {
  const plan = planWake({ url: 'http://wol.local/wake?id={computerId}', mac: 'AA:BB:CC:DD:EE:FF' }, { computerId: 'cmp_1', name: '书房电脑' })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.request, { url: 'http://wol.local/wake?id=cmp_1', method: 'GET' })
  assert.match(plan.note, /唤醒代理/)
})

test('a template that needs the MAC warns when the MAC is missing', () => {
  const plan = planWake({ url: 'http://wol.local/wake?mac={mac}' }, { computerId: 'cmp_1', name: 'x' })
  assert.equal(plan.ok, true)
  assert.match(plan.note, /还没填 MAC/)
  assert.ok(wakeGuidance({}).length >= 3)
})
