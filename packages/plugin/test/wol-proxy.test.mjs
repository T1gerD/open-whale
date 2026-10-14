// Tests for packages/plugin/src/wol-proxy.mjs
//
// No magic packet is ever transmitted here: `WakeProxy` takes the send function as
// an option, and every wake in this file goes through a recording fake. The only
// real network touch is `sendWakeOnLan({dryRun: true})`, which builds the packet
// and skips the socket.
//
// Run with:  node packages/plugin/test/wol-proxy.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sendWakeOnLan } from '../src/power.mjs'
import {
  MAX_WAKE_TARGETS,
  WAKE_REASON,
  WAKE_TARGETS_KEY,
  WAKE_THROTTLE_MS,
  WakeProxy,
  describeWakeConfirmation,
  describeWakePreconditions,
  isIPv4,
  validateWakeTarget,
} from '../src/wol-proxy.mjs'

/** In-memory stand-in for the real StateStore preference API. */
function fakeStore(initial = {}) {
  const prefs = { ...initial }
  return {
    prefs,
    getPreference(key, fallback = undefined) {
      return Object.hasOwn(prefs, key) ? prefs[key] : fallback
    },
    setPreference(key, value) {
      prefs[key] = value
    },
  }
}

/**
 * A WakeProxy with a recording fake send and an injectable clock, so the throttle
 * can be tested without sleeping for three real seconds.
 */
function makeProxy(options = {}) {
  const clock = { value: 1_000_000 }
  /** @type {Array<{mac: string, address?: string, port?: number, label?: string}>} */
  const sent = []
  const store = options.store ?? fakeStore()
  let ids = 0
  const proxy = new WakeProxy({
    store,
    now: () => clock.value,
    newId: () => `wt_${++ids}`,
    wake: async input => {
      sent.push(input)
      if (options.fail) throw new Error(options.fail)
      return { ok: true, packetBytes: 102, address: input.address ?? '255.255.255.255', port: input.port ?? 9, mac: input.mac }
    },
    broadcasts: () => ['255.255.255.255', '192.168.1.255'],
    ...options.proxy,
  })
  return { proxy, store, sent, clock }
}

// ---------------------------------------------------------------------------
// validateWakeTarget
// ---------------------------------------------------------------------------

test('validateWakeTarget normalizes the MAC and defaults the port', () => {
  const result = validateWakeTarget({ label: '书房台式机', mac: 'aa-bb-cc-dd-ee-ff' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.normalized, { label: '书房台式机', mac: 'AA:BB:CC:DD:EE:FF', port: 9 })
})

test('validateWakeTarget accepts an optional broadcast address and port', () => {
  const result = validateWakeTarget({ id: 'wt_x', label: 'NAS', mac: 'AABBCCDDEEFF', address: '192.168.1.255', port: '7' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.normalized, { id: 'wt_x', label: 'NAS', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.255', port: 7 })
})

test('validateWakeTarget collects every problem instead of failing on the first', () => {
  const result = validateWakeTarget({ label: '   ', mac: 'nope', address: '192.168.1.999', port: 70_000 })
  assert.equal(result.ok, false)
  assert.equal(result.normalized, null)
  assert.equal(result.errors.length, 4)
  assert.match(result.errors.join(' | '), /MAC 地址无效/)
  assert.match(result.errors.join(' | '), /名称不能为空/)
  assert.match(result.errors.join(' | '), /IPv4/)
  assert.match(result.errors.join(' | '), /端口/)
})

test('validateWakeTarget rejects a hostname where an IPv4 address is required', () => {
  // A DNS name here would silently send the packet somewhere else entirely.
  assert.equal(validateWakeTarget({ label: 'x', mac: 'AA:BB:CC:DD:EE:FF', address: 'nas.local' }).ok, false)
  assert.equal(validateWakeTarget({ label: 'x', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.010' }).ok, false)
  assert.equal(validateWakeTarget({ label: 'x', mac: 'AA:BB:CC:DD:EE:FF', address: '' }).ok, true)
  assert.equal(validateWakeTarget().ok, false)
})

test('validateWakeTarget trims the label but never trims the MAC away', () => {
  const result = validateWakeTarget({ label: '  客厅机器  ', mac: '  AA:BB:CC:DD:EE:FF  ' })
  assert.equal(result.normalized.label, '客厅机器')
  assert.equal(result.normalized.mac, 'AA:BB:CC:DD:EE:FF')
})

test('validateWakeTarget bounds the label length', () => {
  assert.equal(validateWakeTarget({ label: 'a'.repeat(64), mac: 'AA:BB:CC:DD:EE:FF' }).ok, true)
  assert.equal(validateWakeTarget({ label: 'a'.repeat(65), mac: 'AA:BB:CC:DD:EE:FF' }).ok, false)
})

test('isIPv4 is strict about leading zeros, ranges, and arity', () => {
  assert.equal(isIPv4('0.0.0.0'), true)
  assert.equal(isIPv4('255.255.255.255'), true)
  assert.equal(isIPv4('192.168.1.1'), true)
  assert.equal(isIPv4('256.1.1.1'), false)
  assert.equal(isIPv4('192.168.1'), false)
  assert.equal(isIPv4('192.168.1.1.1'), false)
  assert.equal(isIPv4('192.168.1.01'), false)
  assert.equal(isIPv4('192.168.1.-1'), false)
  assert.equal(isIPv4(/** @type {any} */ (null)), false)
})

// ---------------------------------------------------------------------------
// register / unregister / list
// ---------------------------------------------------------------------------

test('register persists the target through the caller store, not to its own file', () => {
  const { proxy, store } = makeProxy()
  const added = proxy.register({ label: '书房台式机', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.255' })
  assert.equal(added.ok, true)
  assert.equal(added.target.id, 'wt_1')
  assert.equal(added.target.attempts, 0)
  assert.equal(added.target.lastResult, null)

  // The stored shape must be plain JSON: the plugin's state file is JSON.
  const persisted = store.prefs[WAKE_TARGETS_KEY]
  assert.equal(Array.isArray(persisted), true)
  assert.equal(persisted.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(persisted)), persisted)

  // A fresh proxy built on the same store sees the target again.
  const revived = new WakeProxy({ store, wake: async () => ({ ok: true }), broadcasts: () => [] })
  assert.deepEqual(revived.list().map(t => t.mac), ['AA:BB:CC:DD:EE:FF'])
})

test('register refuses an invalid target and adds nothing', () => {
  const { proxy, store } = makeProxy()
  const refused = proxy.register({ label: '', mac: 'zz' })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, WAKE_REASON.INVALID_MAC)
  assert.equal(proxy.list().length, 0)
  assert.equal(store.prefs[WAKE_TARGETS_KEY], undefined, 'a refused target must not be persisted')
})

test('register updates in place when the same id is reused', () => {
  const { proxy } = makeProxy()
  proxy.register({ id: 'wt_fixed', label: '旧名', mac: 'AA:BB:CC:DD:EE:FF' })
  proxy.register({ id: 'wt_fixed', label: '新名', mac: 'AA:BB:CC:DD:EE:FF' })
  assert.equal(proxy.list().length, 1)
  assert.equal(proxy.list()[0].label, '新名')
})

test('unregister removes the target and also clears its throttle entry', async () => {
  const { proxy, sent, clock } = makeProxy()
  proxy.register({ id: 'wt_a', label: 'A', mac: 'AA:BB:CC:DD:EE:FF' })
  assert.equal((await proxy.wake('wt_a')).ok, true)
  assert.equal((await proxy.wake('wt_a')).reason, WAKE_REASON.THROTTLED)

  const removed = proxy.unregister('wt_a')
  assert.equal(removed.ok, true)
  assert.equal(removed.removed.mac, 'AA:BB:CC:DD:EE:FF')
  assert.equal(proxy.list().length, 0)

  // Re-registering and waking immediately must work: the throttle was for the
  // previous registration, not a permanent ban on that MAC.
  proxy.register({ id: 'wt_b', label: 'B', mac: 'AA:BB:CC:DD:EE:FF' })
  clock.value += 1
  assert.equal((await proxy.wake('wt_b')).ok, true)
  assert.equal(sent.length, 2)

  assert.equal(proxy.unregister('does-not-exist').ok, false)
})

test('list returns copies, so callers cannot corrupt stored state', () => {
  const { proxy } = makeProxy()
  proxy.register({ id: 'wt_a', label: 'A', mac: 'AA:BB:CC:DD:EE:FF' })
  const listed = proxy.list()
  listed[0].label = 'tampered'
  listed[0].attempts = 99
  assert.equal(proxy.list()[0].label, 'A')
  assert.equal(proxy.list()[0].attempts, 0)
})

test('a target list that has grown past the cap is refused', () => {
  const { proxy } = makeProxy()
  for (let i = 0; i < MAX_WAKE_TARGETS; i++) {
    assert.equal(proxy.register({ label: `t${i}`, mac: `AA:BB:CC:DD:EE:${i.toString(16).padStart(2, '0')}` }).ok, true)
  }
  const refused = proxy.register({ label: 'one-too-many', mac: 'AA:BB:CC:DD:EE:FF' })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, WAKE_REASON.TOO_MANY_TARGETS)
  assert.equal(proxy.list().length, MAX_WAKE_TARGETS)
})

test('a hand-edited state file cannot smuggle an invalid target into the send path', () => {
  const store = fakeStore({
    [WAKE_TARGETS_KEY]: [
      { id: 'good', label: 'ok', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.255', port: 9 },
      { id: 'bad', label: 'junk', mac: 'not-a-mac' },
      { id: 'bad-address', label: 'junk2', mac: 'AA:BB:CC:DD:EE:01', address: 'evil.example.com' },
      'not even an object',
    ],
  })
  const proxy = new WakeProxy({ store, wake: async () => ({ ok: true }), broadcasts: () => [] })
  assert.deepEqual(proxy.list().map(t => t.id), ['good'])
})

// ---------------------------------------------------------------------------
// wake
// ---------------------------------------------------------------------------

test('wake of a registered target sends the packet and records the attempt', async () => {
  const { proxy, sent } = makeProxy()
  proxy.register({ id: 'wt_a', label: '桌面机', mac: 'aa-bb-cc-dd-ee-ff', address: '192.168.1.255' })
  const result = await proxy.wake('wt_a')
  assert.equal(result.ok, true)
  assert.equal(result.mac, 'AA:BB:CC:DD:EE:FF')
  assert.equal(result.address, '192.168.1.255')
  assert.equal(result.packetBytes, 102)
  assert.equal(result.targetId, 'wt_a')
  assert.equal(result.confirmable, false, 'a sent packet is never a confirmed boot')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].mac, 'AA:BB:CC:DD:EE:FF')

  const stored = proxy.get('wt_a')
  assert.equal(stored.attempts, 1)
  assert.equal(stored.lastResult.ok, true)
  assert.equal(typeof stored.lastAttemptAt, 'string')
})

test('wake refuses an unregistered id instead of inventing a target', async () => {
  const { proxy, sent } = makeProxy()
  const result = await proxy.wake('wt_missing')
  assert.equal(result.ok, false)
  assert.equal(result.reason, WAKE_REASON.UNKNOWN_TARGET)
  assert.equal(sent.length, 0)
})

test('wake accepts an ad-hoc MAC that was never registered', async () => {
  const { proxy, sent } = makeProxy()
  const result = await proxy.wake({ mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.0.255', port: 7 })
  assert.equal(result.ok, true)
  assert.equal(result.targetId, undefined)
  assert.deepEqual(sent, [{ mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.0.255', port: 7, label: '临时目标' }])
  assert.equal(proxy.list().length, 0, 'an ad-hoc wake must not create a stored target')
})

test('wake rejects an invalid ad-hoc MAC', async () => {
  const { proxy, sent } = makeProxy()
  const result = await proxy.wake({ mac: 'oops' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, WAKE_REASON.INVALID_MAC)
  assert.match(String(result.message), /MAC/)
  assert.equal(sent.length, 0)
})

test('a second wake of the same target within the throttle window is refused', async () => {
  const { proxy, sent, clock } = makeProxy()
  proxy.register({ id: 'wt_a', label: 'A', mac: 'AA:BB:CC:DD:EE:FF' })

  assert.equal((await proxy.wake('wt_a')).ok, true)
  clock.value += 1_000
  const throttled = await proxy.wake('wt_a')
  assert.equal(throttled.ok, false)
  assert.equal(throttled.reason, WAKE_REASON.THROTTLED)
  assert.equal(throttled.throttleRemainingMs, 2_000)
  assert.match(String(throttled.message), /2\.0 秒/)
  assert.equal(sent.length, 1, 'a throttled wake must not transmit')
  assert.equal(proxy.get('wt_a').attempts, 1, 'a throttled wake is not an attempt')
})

test('the throttle window is per target, and expires exactly at the boundary', async () => {
  const { proxy, sent, clock } = makeProxy()
  proxy.register({ id: 'wt_a', label: 'A', mac: 'AA:BB:CC:DD:EE:FF' })
  proxy.register({ id: 'wt_b', label: 'B', mac: 'AA:BB:CC:DD:EE:00' })

  assert.equal((await proxy.wake('wt_a')).ok, true)
  // A different target is unaffected by the first one's throttle.
  assert.equal((await proxy.wake('wt_b')).ok, true)
  assert.equal(sent.length, 2)

  clock.value += WAKE_THROTTLE_MS - 1
  assert.equal((await proxy.wake('wt_a')).reason, WAKE_REASON.THROTTLED)
  clock.value += 1
  assert.equal((await proxy.wake('wt_a')).ok, true, 'elapsed === throttleMs must be allowed')
  assert.equal(sent.length, 3)
})

test('two concurrent wakes of the same MAC cannot both transmit', async () => {
  const { proxy } = makeProxy()
  proxy.register({ id: 'wt_a', label: 'A', mac: 'AA:BB:CC:DD:EE:FF' })
  const [first, second] = await Promise.all([proxy.wake('wt_a'), proxy.wake('wt_a')])
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.reason, WAKE_REASON.THROTTLED)
})

test('a send failure is reported as a reason and recorded on the target', async () => {
  const { proxy } = makeProxy({ fail: 'EPERM' })
  proxy.register({ id: 'wt_a', label: 'A', mac: 'AA:BB:CC:DD:EE:FF' })
  const result = await proxy.wake('wt_a')
  assert.equal(result.ok, false)
  assert.equal(result.reason, WAKE_REASON.SEND_FAILED)
  assert.match(String(result.message), /EPERM/)
  assert.equal(result.confirmable, false)
  const stored = proxy.get('wt_a')
  assert.equal(stored.attempts, 1, 'a failed attempt still counts as an attempt')
  assert.equal(stored.lastResult.ok, false)
  assert.match(String(stored.lastResult.error), /EPERM/)
})

test('an unregistered target id wins over an ad-hoc MAC in the same request', async () => {
  const { proxy, sent } = makeProxy()
  const result = await proxy.wake({ id: 'wt_missing', mac: 'AA:BB:CC:DD:EE:FF' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, WAKE_REASON.UNKNOWN_TARGET)
  assert.equal(sent.length, 0, 'silently falling back to the ad-hoc MAC would hide a stale id')
})

test('the real sender builds a 102-byte packet in dry-run mode without touching the network', async () => {
  const result = await sendWakeOnLan({ mac: 'AA:BB:CC:DD:EE:FF', dryRun: true })
  assert.equal(result.packetBytes, 102)
  // And it can be plugged into the proxy as-is.
  const proxy = new WakeProxy({
    store: fakeStore(),
    wake: input => sendWakeOnLan({ ...input, dryRun: true }),
    broadcasts: () => ['255.255.255.255'],
  })
  const wake = await proxy.wake({ mac: 'AA:BB:CC:DD:EE:FF' })
  assert.equal(wake.ok, true)
  assert.equal(wake.packetBytes, 102)
})

test('a slow-growing throttle map is swept, not leaked', async () => {
  const { proxy, clock } = makeProxy()
  for (let i = 0; i < 5; i++) {
    await proxy.wake({ mac: `AA:BB:CC:DD:EE:0${i}` })
    clock.value += WAKE_THROTTLE_MS + 1
  }
  // The five earlier MACs are past the window; one more sweep (triggered by the
  // next wake) must drop them all, leaving only the current one.
  await proxy.wake({ mac: 'AA:BB:CC:DD:EE:99' })
  const remembered = [...proxy.recent.keys()]
  assert.deepEqual(remembered, ['AA:BB:CC:DD:EE:99'])
})

// ---------------------------------------------------------------------------
// probe + broadcasts
// ---------------------------------------------------------------------------

test('probe refuses to claim the machine is awake, and says why', () => {
  const { proxy } = makeProxy()
  const answer = proxy.probe('aa-bb-cc-dd-ee-ff')
  assert.equal(answer.canConfirm, false)
  assert.ok(answer.suggestions.length >= 2)
  // The MAC is normalized in the explanation so the user can tell which target.
  assert.match(answer.hint, /AA:BB:CC:DD:EE:FF/)
  const free = describeWakeConfirmation()
  assert.equal(free.canConfirm, false)
  assert.match(free.hint, /目标机/)
})

test('localBroadcasts is a pass-through of the NIC enumeration', () => {
  const { proxy } = makeProxy()
  assert.deepEqual(proxy.localBroadcasts(), ['255.255.255.255', '192.168.1.255'])
})

// ---------------------------------------------------------------------------
// describeWakePreconditions
// ---------------------------------------------------------------------------

test('the preconditions checklist is complete and machine-readable', () => {
  const items = describeWakePreconditions({ platform: 'win32' })
  assert.ok(items.length >= 8)
  const ids = items.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique')
  for (const item of items) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.title, 'string')
    assert.ok(item.title.length > 0)
    assert.equal(typeof item.detail, 'string')
    assert.ok(item.detail.length > 20)
    assert.equal(typeof item.critical, 'boolean')
    assert.ok(['official', 'vendor', 'community', 'unverified'].includes(item.source), `unexpected source ${item.source}`)
  }
  // The four things the user must actually do, per the research report.
  for (const id of [
    'disable-fast-startup',
    'bios-wake-on-magic-packet',
    'lan-proxy',
    'wired-ethernet',
    'same-broadcast-domain',
    'standby-power',
  ]) {
    assert.ok(ids.includes(id), `missing precondition: ${id}`)
  }
  assert.ok(items.filter(item => item.critical).length >= 4)
})

test('the fast-startup item states the official hybrid-shutdown constraint', () => {
  const items = describeWakePreconditions({ platform: 'win32' })
  const fastStartup = items.find(item => item.id === 'disable-fast-startup')
  assert.ok(fastStartup)
  assert.equal(fastStartup.critical, true)
  assert.match(fastStartup.detail, /快速启动/)
  assert.match(fastStartup.detail, /不受支持/)
  assert.match(String(fastStartup.verify), /HiberbootEnabled/)
})

test('the LAN proxy item explains that a powered-off computer cannot wake itself', () => {
  const items = describeWakePreconditions({ platform: 'win32' })
  const proxyItem = items.find(item => item.id === 'lan-proxy')
  assert.equal(proxyItem.critical, true)
  assert.match(proxyItem.detail, /没有任何进程在运行/)
  assert.match(proxyItem.detail, /二层广播|广播帧/)
  assert.match(proxyItem.detail, /Tailscale/)
})

test('the Windows-only entries stay out of the non-Windows checklist', () => {
  const items = describeWakePreconditions({ platform: 'linux' })
  const ids = items.map(item => item.id)
  assert.equal(ids.includes('disable-fast-startup'), false)
  assert.equal(ids.includes('bios-wake-on-magic-packet'), false)
  assert.equal(ids.includes('nic-advanced-property'), false)
  // The platform-independent physics still applies.
  assert.ok(ids.includes('lan-proxy'))
  assert.ok(ids.includes('standby-power'))
})

test('unverified firmware behaviour is labelled as unverified, never as a promise', () => {
  const items = describeWakePreconditions({ platform: 'win32' })
  const s5 = items.find(item => item.id === 'power-state-s5')
  assert.equal(s5.source, 'unverified')
  assert.equal(s5.critical, false)
  assert.match(s5.detail, /实机验证/)
})

test('the proxy cannot be constructed without a store', () => {
  assert.throws(() => new WakeProxy(/** @type {any} */ ({})), /StateStore/)
})

test('the default throttle constant matches the documented three seconds', () => {
  assert.equal(WAKE_THROTTLE_MS, 3_000)
  assert.equal(WAKE_TARGETS_KEY, 'wol.targets')
})
