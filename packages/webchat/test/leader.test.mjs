// 跨标签选主测试：假 Web Locks / 假 BroadcastChannel / 假定时器驱动。
//
// 验收线（对应 task-5）：
//   1. 第一个页面成为 leader；
//   2. 第二个页面待命，且一条 WebSocket 都不建立（用「只有 leader 角色才加进
//      connected 集合」模拟 app.js 的 applyLeaderConnection）；
//   3. leader 关闭后 follower 接管（Web Locks 授权 / BroadcastChannel bye + 心跳超时）；
//   4. 没有 Web Locks 时回退到 BroadcastChannel；两者都没有时按单例 solo 直连；
//   5. dispose 释放锁、关闭通道、清空所有定时器，且可重复调用。
//
// 另外钉住两个容易回归的点：
//   * 两个标签同时宣主时，靠「since 更早者优先」收敛，不会长期双 leader；
//   * bye 只认当前 peer（避免无关标签的 bye 把 follower 提前推成 leader）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LEADER_CHANNEL_NAME,
  LEADER_LOCK_NAME,
  LEADER_MESSAGE_VERSION,
  LEADER_ROLE,
  LEADER_STRATEGY,
  LEADER_TIMING,
  LeaderElector,
  createTabId,
} from '../lib/leader.mjs'

/** 手动推进的时钟（和 connection.test.mjs 同款语义）。 */
function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId
      nextId += 1
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      let guard = 0
      for (;;) {
        let next
        for (const [id, timer] of timers) {
          if (timer.at <= target && (next === undefined || timer.at < next.timer.at)) next = { id, timer }
        }
        if (!next) break
        timers.delete(next.id)
        now = next.timer.at
        next.timer.fn()
        guard += 1
        if (guard > 5000) throw new Error('定时器没有收敛（可能死循环）')
      }
      now = target
    },
    pending() {
      return timers.size
    },
  }
}

/** 等一轮宏任务：Web Locks 的交接在真实浏览器里是异步任务。 */
function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

/** @returns {Error} */
function abortError() {
  const error = new Error('The lock request was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * 假 Web Locks：与规范一致的队列语义。
 *  - 没人持锁时立即授予（callback 同步执行）；
 *  - 有人持锁时排队；持锁者 callback 返回的 promise settle 后才授予下一个；
 *  - signal 只取消「排队中」的请求，已拿到的锁不受 abort 影响。
 */
class FakeLocks {
  constructor() {
    this.held = null
    this.waiting = []
    this.requests = []
  }

  request(name, options, callback) {
    assert.equal(name, LEADER_LOCK_NAME, '锁名必须和 app/lib 约定一致')
    return new Promise((resolve, reject) => {
      const entry = { options, callback, resolve, reject, granted: false, aborted: false }
      this.requests.push(entry)
      const signal = options?.signal
      if (signal) {
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener('abort', () => {
          if (entry.granted) return
          entry.aborted = true
          this.waiting = this.waiting.filter(item => item !== entry)
          reject(abortError())
        })
      }
      this.waiting.push(entry)
      this.#drain()
    })
  }

  #drain() {
    if (this.held) return
    const entry = this.waiting.shift()
    if (!entry) return
    entry.granted = true
    this.held = entry
    let result
    try {
      result = entry.callback()
    } catch (error) {
      entry.callbackError = error
      result = undefined
    }
    Promise.resolve(result).then(
      () => this.#release(entry, undefined),
      error => this.#release(entry, error),
    )
  }

  #release(entry, error) {
    if (this.held === entry) this.held = null
    if (error) entry.reject(error)
    else entry.resolve(undefined)
    this.#drain()
  }
}

/** 假 BroadcastChannel：同名的其它实例同步收到消息（比真实 API 更确定，便于测试）。 */
class FakeChannel {
  static instances = []

  static reset() {
    FakeChannel.instances = []
  }

  constructor(name) {
    this.name = name
    this.closed = false
    this.onmessage = null
    this.posted = []
    FakeChannel.instances.push(this)
  }

  postMessage(data) {
    if (this.closed) return
    const copy = structuredClone(data)
    this.posted.push(copy)
    for (const other of FakeChannel.instances) {
      if (other === this || other.closed || other.name !== this.name) continue
      other.onmessage?.({ data: structuredClone(copy) })
    }
  }

  close() {
    this.closed = true
  }
}

/**
 * 建一个测试用选举器。
 * @param {ReturnType<typeof createClock>} clock
 * @param {object} [options]
 */
function createElector(clock, options = {}) {
  const changes = []
  const errors = []
  const elector = new LeaderElector({
    locks: 'locks' in options ? options.locks : undefined,
    channel: 'channel' in options ? options.channel : undefined,
    tabId: options.tabId ?? 'tab-a',
    now: clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: id => clock.clearTimeout(id),
    random: options.random ?? (() => 0.5),
    onChange: (role, detail) => {
      changes.push({ role, detail })
      options.onChange?.(role, detail)
    },
    onError: error => errors.push(error),
  })
  return { elector, changes, errors }
}

/**
 * 模拟 app.js：只有 leader/solo 才「建连接」。
 * @param {Set<string>} connected
 * @param {string} id
 */
function trackConnection(connected, id) {
  return role => {
    if (role === LEADER_ROLE.LEADER || role === LEADER_ROLE.SOLO) connected.add(id)
    else connected.delete(id)
  }
}

test('Web Locks：首个标签成为 leader，第二个标签待命且不建连接', async () => {
  const clock = createClock()
  const locks = new FakeLocks()
  const connected = new Set()

  const a = createElector(clock, { locks, tabId: 'tab-a', onChange: trackConnection(connected, 'a') })
  const b = createElector(clock, { locks, tabId: 'tab-b', onChange: trackConnection(connected, 'b') })

  a.elector.start()
  assert.equal(a.elector.strategy, LEADER_STRATEGY.LOCKS)
  assert.equal(a.elector.role, LEADER_ROLE.LEADER)
  assert.equal(a.elector.isLeader, true)
  assert.deepEqual([...connected], ['a'])

  b.elector.start()
  assert.equal(b.elector.role, LEADER_ROLE.ELECTING, '锁还在 A 手里，B 先排队')
  clock.advance(LEADER_TIMING.startupGraceMs)
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER, '短时间没拿到锁 = 其它标签在连接')
  assert.equal(b.elector.isLeader, false)
  assert.deepEqual([...connected], ['a'], '待命标签绝不能建连接')

  // A 关页：锁释放，浏览器把锁交给排队中的 B —— 接管不需要人为干预。
  a.elector.dispose()
  assert.equal(a.elector.role, LEADER_ROLE.IDLE)
  await flush()
  assert.equal(b.elector.role, LEADER_ROLE.LEADER, 'leader 关闭后 follower 必须能接管')
  assert.deepEqual([...connected], ['b'])
  assert.equal(clock.pending(), 0, 'locks 策略不靠心跳定时器')

  // 幂等：重复 dispose 不出错、不残留。
  b.elector.dispose()
  b.elector.dispose()
  await flush()
  assert.equal(b.elector.role, LEADER_ROLE.IDLE)
  assert.equal(clock.pending(), 0)
  assert.equal(locks.held, null, '最后一个标签退出后锁必须已经释放')
  assert.equal(locks.waiting.length, 0)
})

test('BroadcastChannel：第二个标签听到 leader beacon 后待命，多个心跳周期内不抢连接', () => {
  FakeChannel.reset()
  const clock = createClock()
  const connected = new Set()

  const a = createElector(clock, { channel: FakeChannel, tabId: 'tab-a', onChange: trackConnection(connected, 'a') })
  const b = createElector(clock, { channel: FakeChannel, tabId: 'tab-b', onChange: trackConnection(connected, 'b') })

  a.elector.start()
  assert.equal(a.elector.strategy, LEADER_STRATEGY.CHANNEL, '没有 Web Locks 时走通道心跳')
  assert.equal(a.elector.role, LEADER_ROLE.ELECTING)
  clock.advance(LEADER_TIMING.startupGraceMs)
  assert.equal(a.elector.role, LEADER_ROLE.LEADER)
  assert.deepEqual([...connected], ['a'])

  b.elector.start()
  // probe 发出后 A 立即回 beacon，B 不必等自己的 startupGrace。
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)
  assert.deepEqual([...connected], ['a'])

  for (let index = 0; index < 5; index += 1) {
    clock.advance(LEADER_TIMING.heartbeatMs)
    assert.equal(a.elector.role, LEADER_ROLE.LEADER)
    assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)
  }
  assert.deepEqual([...connected], ['a'], '5 个心跳周期里始终只有一条连接')

  // leader 主动关页会广播 bye：follower 在 handover + jitter 后接管。
  a.elector.dispose()
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER, 'bye 之后不能立即抢，先给对方一个抖动的交接窗口')
  clock.advance(LEADER_TIMING.handoverMs + Math.floor(0.5 * LEADER_TIMING.takeoverJitterMs) - 1)
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)
  clock.advance(1)
  assert.equal(b.elector.role, LEADER_ROLE.LEADER)
  assert.deepEqual([...connected], ['b'])

  b.elector.dispose()
  assert.equal(clock.pending(), 0, 'dispose 必须清空所有定时器')
  assert.equal(FakeChannel.instances.every(channel => channel.closed), true, '通道必须关闭')
})

test('BroadcastChannel：leader 被强杀（没有 bye）时 follower 超时接管', () => {
  FakeChannel.reset()
  const clock = createClock()
  const connected = new Set()

  const a = createElector(clock, { channel: FakeChannel, tabId: 'tab-a', onChange: trackConnection(connected, 'a') })
  const b = createElector(clock, { channel: FakeChannel, tabId: 'tab-b', onChange: trackConnection(connected, 'b') })

  a.elector.start()
  clock.advance(LEADER_TIMING.startupGraceMs)
  b.elector.start()
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)

  // 模拟进程被杀/页面崩溃：来不及广播 bye。
  a.elector.dispose({ announce: false })
  clock.advance(LEADER_TIMING.staleMs - 1)
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER, '还没超过 staleMs 不能抢')
  clock.advance(1 + Math.floor(0.5 * LEADER_TIMING.takeoverJitterMs))
  assert.equal(b.elector.role, LEADER_ROLE.LEADER, 'staleMs 后必须接管，避免整个浏览器断线')
  assert.deepEqual([...connected], ['b'])

  b.elector.dispose()
  assert.equal(clock.pending(), 0)
})

test('follower 回到前台时 recheck 可跳过抖动立即接管', () => {
  FakeChannel.reset()
  const clock = createClock()
  const a = createElector(clock, { channel: FakeChannel, tabId: 'tab-a' })
  const b = createElector(clock, { channel: FakeChannel, tabId: 'tab-b' })

  a.elector.start()
  clock.advance(LEADER_TIMING.startupGraceMs)
  b.elector.start()
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)

  a.elector.dispose({ announce: false })
  assert.equal(b.elector.recheck(), false, '还没到 staleMs 时 recheck 不能抢')
  clock.advance(LEADER_TIMING.staleMs)
  // 距 staleMs 只差接管抖动：recheck 应该直接宣主，不等定时器。
  assert.equal(b.elector.recheck(), true)
  assert.equal(b.elector.role, LEADER_ROLE.LEADER)

  b.elector.dispose()
  assert.equal(clock.pending(), 0)
})

test('Web Locks 请求抛错时回退到 BroadcastChannel', () => {
  FakeChannel.reset()
  const clock = createClock()
  const brokenLocks = {
    request() {
      throw new Error('SecurityError: locks is not available in this context')
    },
  }
  const a = createElector(clock, { locks: brokenLocks, channel: FakeChannel, tabId: 'tab-a' })
  a.elector.start()
  assert.equal(a.elector.strategy, LEADER_STRATEGY.CHANNEL)
  assert.equal(a.errors.length, 1, '降级要上报一次原因（app.js 打到 console）')
  clock.advance(LEADER_TIMING.startupGraceMs)
  assert.equal(a.elector.role, LEADER_ROLE.LEADER)
  a.elector.dispose()
  assert.equal(clock.pending(), 0)
})

test('没有 Web Locks 也没有 BroadcastChannel：solo 直连（保持现状）', () => {
  const clock = createClock()
  const a = createElector(clock, { tabId: 'tab-a' })
  a.elector.start()
  assert.equal(a.elector.strategy, LEADER_STRATEGY.SOLO)
  assert.equal(a.elector.role, LEADER_ROLE.SOLO)
  assert.equal(a.elector.isLeader, true, '两个 API 都没有时不能把页面变成永久待命')
  assert.deepEqual(a.changes.map(item => item.role), [LEADER_ROLE.SOLO])
  assert.equal(clock.pending(), 0)
  a.elector.dispose()
  assert.equal(a.elector.role, LEADER_ROLE.IDLE)
  assert.equal(clock.pending(), 0)
})

test('两个标签同时宣主：靠启动资历收敛，最终只有一个 leader', () => {
  FakeChannel.reset()
  const clock = createClock()
  const connected = new Set()

  const a = createElector(clock, { channel: FakeChannel, tabId: 'tab-a', onChange: trackConnection(connected, 'a') })
  const b = createElector(clock, { channel: FakeChannel, tabId: 'tab-b', onChange: trackConnection(connected, 'b') })

  a.elector.start()
  clock.advance(LEADER_TIMING.startupGraceMs)
  assert.equal(a.elector.role, LEADER_ROLE.LEADER)

  // 模拟 A 在后台被节流：不回应 B 的 probe，让 B 也以为没有 leader。
  const aHandler = a.elector.channel.onmessage
  a.elector.channel.onmessage = null
  b.elector.start()
  clock.advance(LEADER_TIMING.startupGraceMs)
  assert.equal(b.elector.role, LEADER_ROLE.LEADER, 'B 收不到 beacon 时允许先宣主（不能永远等）')

  // 通道恢复，下一次心跳互见：启动更早的 A 胜出，B 自动降级。
  a.elector.channel.onmessage = aHandler
  clock.advance(LEADER_TIMING.heartbeatMs)
  assert.equal(a.elector.role, LEADER_ROLE.LEADER)
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER, '资历更老的 leader 必须胜出，避免双连接')
  assert.deepEqual([...connected], ['a'])

  for (let index = 0; index < 4; index += 1) {
    clock.advance(LEADER_TIMING.heartbeatMs)
    assert.equal(a.elector.role, LEADER_ROLE.LEADER)
    assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)
  }
  assert.deepEqual([...connected], ['a'])

  a.elector.dispose()
  b.elector.dispose()
  assert.equal(clock.pending(), 0)
})

test('无关标签的 bye 不能让 follower 提前接管', () => {
  FakeChannel.reset()
  const clock = createClock()
  const a = createElector(clock, { channel: FakeChannel, tabId: 'tab-a' })
  const b = createElector(clock, { channel: FakeChannel, tabId: 'tab-b' })

  a.elector.start()
  clock.advance(LEADER_TIMING.startupGraceMs)
  b.elector.start()
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER)

  // 第三个标签（不在选主里）发 bye：B 不认识它，不能当成 leader 走了。
  const stranger = new FakeChannel(LEADER_CHANNEL_NAME)
  stranger.postMessage({
    v: LEADER_MESSAGE_VERSION,
    kind: 'bye',
    tabId: 'tab-stranger',
    since: 0,
    at: clock.now(),
  })
  clock.advance(LEADER_TIMING.handoverMs + LEADER_TIMING.takeoverJitterMs)
  assert.equal(b.elector.role, LEADER_ROLE.FOLLOWER, '只有当前 leader 的 bye 才触发交接')
  assert.equal(a.elector.role, LEADER_ROLE.LEADER)

  stranger.close()
  a.elector.dispose()
  b.elector.dispose()
  assert.equal(clock.pending(), 0)
})

test('start 幂等，dispose 清空定时器与通道（不泄漏）', () => {
  FakeChannel.reset()
  const clock = createClock()
  const a = createElector(clock, { channel: FakeChannel, tabId: 'tab-a' })
  a.elector.start()
  a.elector.start()
  assert.equal(FakeChannel.instances.length, 1, '重复 start 不能建第二个通道')
  assert.equal(clock.pending(), 1, '只有 startupGrace 一个定时器')

  clock.advance(LEADER_TIMING.startupGraceMs)
  clock.advance(LEADER_TIMING.heartbeatMs * 2)
  assert.ok(clock.pending() >= 1, 'leader 应有心跳定时器')
  assert.ok(a.elector.pendingTimers >= 1)

  const channel = a.elector.channel
  a.elector.dispose()
  assert.equal(channel.closed, true)
  assert.equal(clock.pending(), 0, 'dispose 后不能残留任何定时器')
  assert.equal(a.elector.pendingTimers, 0)
  assert.equal(a.elector.role, LEADER_ROLE.IDLE)

  a.elector.dispose()
  assert.equal(clock.pending(), 0)
})

test('createTabId 生成非空且互不相同的 id', () => {
  const first = createTabId()
  const second = createTabId()
  assert.equal(typeof first, 'string')
  assert.ok(first.length > 0)
  assert.notEqual(first, second)
})
