// 连接管理测试：用假 WebSocket + 假定时器驱动竞速、换址、退避、心跳、致命错误。
//
// 这里断言的是「多地址竞速」这条协议要求真的生效：两个候选同时连，谁先完成
// hello/ack 用谁，另一个立刻关掉；失败按地址阶梯换；认证失败不重试。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONNECTION_STATE,
  ConnectionManager,
  HELLO_TIMEOUT_MS,
  SETTLE_MS,
  isReplacedClose,
  reconnectDelay,
  describeStatus,
} from '../lib/connection.mjs'

/** 假 WebSocket：记录发出去的帧，暴露 open/close/收帧 三个模拟入口。 */
class FakeSocket {
  static instances = []

  static reset() {
    FakeSocket.instances = []
  }

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closed = false
    this.closeCode = undefined
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    FakeSocket.instances.push(this)
  }

  send(text) {
    this.sent.push(JSON.parse(text))
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.closed = true
    this.closeCode = code
    this.onclose?.({ code, reason })
  }

  /** 模拟服务端接受连接。 */
  open() {
    this.readyState = 1
    this.onopen?.()
  }

  /** 模拟服务端推帧。 */
  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** 模拟网络断开。 */
  fail(code = 1006) {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.closed = true
    this.onclose?.({ code, reason: '' })
  }

  framesOf(type) {
    return this.sent.filter(frame => frame.t === type)
  }
}

/** 手动推进的时钟。 */
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

const TAILSCALE = { url: 'http://100.101.2.3:8787', kind: 'tailscale' }
const LAN = { url: 'http://192.168.1.5:8787', kind: 'lan' }
const TUNNEL = { url: 'https://tunnel.example.com', kind: 'tunnel' }

function createManager(clock, overrides = {}) {
  const statuses = []
  const online = []
  const offline = []
  const frames = []
  const hellos = []
  const manager = new ConnectionManager({
    WebSocketImpl: overrides.WebSocketImpl ?? FakeSocket,
    candidates: overrides.candidates ?? [TAILSCALE, LAN, TUNNEL],
    buildHello: overrides.buildHello ?? (context => {
      const hello = { t: 'hello', nonce: `nonce-${hellos.length + 1}`, url: context.url }
      hellos.push(hello)
      return hello
    }),
    verifyAck: overrides.verifyAck ?? (() => ({ ok: true, verified: true })),
    onFrame: frame => (overrides.onFrame ?? (value => frames.push(value)))(frame),
    onStatus: status => statuses.push(status),
    onOnline: (ack, context) => online.push({ ack, context }),
    onOffline: info => offline.push(info),
    now: clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: id => clock.clearTimeout(id),
    random: () => 0.5,
    helloTimeoutMs: overrides.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    // 老用例按「收到 ack 立即确认」跑；竞速确认窗口的用例单独传 settleMs。
    settleMs: overrides.settleMs ?? 0,
  })
  manager.raceSize = overrides.raceSize ?? 2
  manager.maxBackoffMs = overrides.maxBackoffMs ?? 15_000
  return { manager, statuses, online, offline, frames, hellos }
}

test('竞速：两个候选同时连，先完成 hello/ack 的获胜，另一个立即关闭', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, statuses, online, hellos } = createManager(clock)
  manager.start()

  assert.equal(FakeSocket.instances.length, 2, '前两个候选要并发竞速')
  const [first, second] = FakeSocket.instances
  assert.equal(first.url, 'ws://100.101.2.3:8787/openwhale/ws')
  assert.equal(second.url, 'ws://192.168.1.5:8787/openwhale/ws')

  first.open()
  second.open()
  assert.equal(hellos.length, 2)
  assert.notEqual(hellos[0].nonce, hellos[1].nonce, '每个 socket 的 hello nonce 必须不同（防 replay guard 拒绝）')

  second.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000, capabilities: [] })
  assert.equal(manager.online, true)
  assert.equal(manager.connectedUrl, LAN.url)
  assert.equal(manager.connectedKind, 'lan')
  assert.equal(first.closed, true, '落败的竞速 socket 要立刻关闭')
  assert.equal(online.length, 1)
  assert.equal(online[0].context.url, LAN.url)
  assert.equal(statuses[statuses.length - 1].state, CONNECTION_STATE.ONLINE)

  // 成功的地址下次排第一（Tailscale 让位给上次成功的局域网）。
  assert.equal(manager.candidates[0].url, LAN.url)
})

test('一个候选先失败，另一个竞速成功（不进入退避）', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, online } = createManager(clock, { candidates: [TAILSCALE, LAN] })
  manager.start()
  const [first, second] = FakeSocket.instances
  first.open()
  second.open()
  first.fail(1006)
  second.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.online, true)
  assert.equal(manager.connectedUrl, LAN.url)
  assert.equal(online.length, 1)
  assert.equal(clock.pending() >= 1, true, '在线后应有心跳定时器')
})

test('地址阶梯：前两个都失败后立刻换下一个候选', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [TAILSCALE, LAN, TUNNEL] })
  manager.start()
  assert.equal(FakeSocket.instances.length, 2)
  FakeSocket.instances[0].open()
  FakeSocket.instances[1].open()
  FakeSocket.instances[0].fail()
  FakeSocket.instances[1].fail()
  assert.equal(FakeSocket.instances.length, 3, '第三个候选应该马上被尝试，而不是先退避')
  assert.equal(FakeSocket.instances[2].url, 'wss://tunnel.example.com/openwhale/ws')
  FakeSocket.instances[2].open()
  FakeSocket.instances[2].receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.online, true)
  assert.equal(manager.connectedUrl, TUNNEL.url)
})

test('全部候选失败 → 指数退避，到点后重试', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, statuses } = createManager(clock, { candidates: [TAILSCALE, LAN] })
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[1].open()
  FakeSocket.instances[0].fail()
  FakeSocket.instances[1].fail()

  const retryStatus = statuses[statuses.length - 1]
  assert.equal(retryStatus.state, CONNECTION_STATE.RECONNECTING)
  assert.equal(retryStatus.attempt, 1)
  assert.equal(retryStatus.delayMs, 1000, 'random=0.5 时第一次退避 = 1000ms')
  assert.deepEqual(retryStatus.failedUrls, [TAILSCALE.url, LAN.url])
  const before = FakeSocket.instances.length
  clock.advance(999)
  assert.equal(FakeSocket.instances.length, before, '没到点不能重连')
  clock.advance(1)
  assert.equal(FakeSocket.instances.length, before + 2, '到点后重新并发竞速')
})

test('重连退避时间单调增长且有上限', () => {
  assert.equal(reconnectDelay(1, { random: () => 0.5 }), 1000)
  assert.ok(reconnectDelay(2, { random: () => 0.5 }) > reconnectDelay(1, { random: () => 0.5 }))
  assert.ok(reconnectDelay(3, { random: () => 0.5 }) > reconnectDelay(2, { random: () => 0.5 }))
  assert.equal(reconnectDelay(50, { random: () => 0.5 }), 15_000)
  assert.ok(reconnectDelay(1, { random: () => 0 }) >= 800)
  assert.ok(reconnectDelay(1, { random: () => 1 }) <= 1200)
})

test('握手阶段 error 帧是致命错误：停止重试并给出原因', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, statuses } = createManager(clock)
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[1].open()
  FakeSocket.instances[0].receive({ t: 'error', code: 'pairing-rejected', message: '该二维码已被使用过，请重新生成' })
  const last = statuses[statuses.length - 1]
  assert.equal(last.state, CONNECTION_STATE.REJECTED)
  assert.match(last.reason, /二维码已被使用/)
  assert.equal(clock.pending(), 0, '认证失败不能留重连定时器（会把 replay guard 刷爆）')
  assert.equal(manager.online, false)
})

test('hello/ack 身份校验失败（verifyAck 返回 ok:false）同样致命', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, statuses } = createManager(clock, {
    verifyAck: () => ({ ok: false, verified: false, reason: '电脑身份校验失败（可能是中间人），已拒绝连接' }),
  })
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[0].receive({ t: 'hello/ack', nonce: 'x', proof: 'bad' })
  const last = statuses[statuses.length - 1]
  assert.equal(last.state, CONNECTION_STATE.REJECTED)
  assert.match(last.reason, /中间人/)
})

test('在线后断线 → 进入重连并自动连接', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, offline } = createManager(clock, { candidates: [LAN] })
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[0].receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.online, true)
  const socketsBefore = FakeSocket.instances.length
  FakeSocket.instances[0].fail()
  assert.equal(manager.online, false)
  assert.equal(offline.length, 1)
  clock.advance(1000)
  assert.equal(FakeSocket.instances.length, socketsBefore + 1)
})

test('心跳：到点发 ping，长时间无入站帧判定连接已死', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, offline } = createManager(clock, { candidates: [LAN] })
  manager.start()
  const socket = FakeSocket.instances[0]
  socket.open()
  socket.receive({ t: 'hello/ack', paired: true, heartbeatMs: 20_000 })
  clock.advance(20_000)
  assert.equal(socket.framesOf('ping').length, 1, '一个心跳周期后要发 ping')
  socket.receive({ t: 'pong' })
  clock.advance(20_000)
  assert.equal(socket.framesOf('ping').length, 2)
  // 之后不再有入站帧：3 个周期后看门狗收掉连接。
  clock.advance(60_001)
  assert.equal(offline.length >= 1, true)
  assert.equal(manager.online, false)
})

test('send() 离线返回 false、在线真的写入 socket', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [LAN] })
  manager.start()
  assert.equal(manager.send({ t: 'ping' }), false)
  FakeSocket.instances[0].open()
  FakeSocket.instances[0].receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.send({ t: 'chat/send', rid: 'r1' }), true)
  assert.deepEqual(FakeSocket.instances[0].sent.filter(frame => frame.t === 'chat/send'), [{ t: 'chat/send', rid: 'r1' }])
  FakeSocket.instances[0].fail()
  assert.equal(manager.send({ t: 'ping' }), false, '断线后发送必须失败，让上层进离线队列')
})

test('stop() 关闭全部 socket 且不再重连', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, statuses } = createManager(clock, { candidates: [LAN] })
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[0].receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  manager.stop()
  assert.equal(FakeSocket.instances[0].closed, true)
  assert.equal(manager.online, false)
  assert.equal(statuses[statuses.length - 1].state, CONNECTION_STATE.STOPPED)
  const before = FakeSocket.instances.length
  clock.advance(60_000)
  assert.equal(FakeSocket.instances.length, before)
})

test('reconnect() 主动重连（设置页按钮）', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [LAN] })
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[0].receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  manager.reconnect()
  assert.equal(FakeSocket.instances.length, 2)
  assert.equal(FakeSocket.instances[0].closed, true)
})

test('没有候选地址时给出可操作状态，不崩溃', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, statuses } = createManager(clock, { candidates: [] })
  manager.start()
  assert.equal(FakeSocket.instances.length, 0)
  const last = statuses[statuses.length - 1]
  assert.equal(last.state, CONNECTION_STATE.RECONNECTING)
  assert.equal(last.noEndpoints, true)
  assert.match(last.reason, /重新扫码|手动添加/)
})

test('setCandidates 之后重连使用新地址（hello/ack 的 endpointList 会走这条路）', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [LAN] })
  manager.start()
  FakeSocket.instances[0].open()
  FakeSocket.instances[0].receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  manager.setCandidates([{ url: 'http://10.0.0.9:8787', kind: 'lan' }])
  manager.reconnect()
  assert.equal(FakeSocket.instances[1].url, 'ws://10.0.0.9:8787/openwhale/ws')
})

test('握手超时后候选失败（不会永久挂在 connecting）', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [LAN], helloTimeoutMs: 1000 })
  manager.start()
  FakeSocket.instances[0].open()
  assert.equal(manager.online, false)
  clock.advance(1000)
  assert.equal(manager.state, CONNECTION_STATE.RECONNECTING)
  assert.equal(FakeSocket.instances[0].closed, true)
})

test('describeStatus 把状态翻成可操作中文文案', () => {
  assert.match(describeStatus({ state: CONNECTION_STATE.CONNECTING, url: 'ws://x' }).title, /正在连接/)
  assert.equal(describeStatus({ state: CONNECTION_STATE.ONLINE, url: 'ws://x' }).title, '已连接')
  const reconnecting = describeStatus({
    state: CONNECTION_STATE.RECONNECTING,
    attempt: 2,
    delayMs: 3000,
    reason: '握手超时',
    failedUrls: ['a', 'b'],
  })
  assert.match(reconnecting.title, /3 秒后重试/)
  assert.match(reconnecting.detail, /换连接方式|重新扫码/)
  const rejected = describeStatus({ state: CONNECTION_STATE.REJECTED, reason: '配对已过期' })
  assert.equal(rejected.action, 'rebind')
  assert.match(rejected.detail, /配对已过期/)
  const replaced = describeStatus({ state: CONNECTION_STATE.RECONNECTING, replaced: true, reason: 'replaced' })
  assert.match(replaced.title, /替换/)
  assert.match(replaced.detail, /重试|窗口/)
  assert.equal(replaced.action, 'retry')
  assert.equal(describeStatus({ state: CONNECTION_STATE.STOPPED }).title, '已断开')
  assert.equal(describeStatus({}).title, '未连接')
})

// ---------------------------------------------------------------------------
// 竞速确认窗口 / 「被新连接替换」死循环回归测试
//
// 背景（真实联调 bug）：同一 deviceId 的两条 socket 并发 hello，电脑端只允许一条
// 会话时会把先连上的以「replaced」踢掉。旧实现把「winner 被踢」当成普通掉线，
// 于是重新竞速 → 两条又互相顶掉 → 每秒循环，永远不 online。
// ---------------------------------------------------------------------------

test('isReplacedClose 识别各种「被替换」措辞', () => {
  assert.equal(isReplacedClose({ code: 1000, reason: 'replaced by a newer connection' }), true)
  assert.equal(isReplacedClose({ code: 1000, reason: 'Replaced' }), true)
  assert.equal(isReplacedClose({ code: 1001, reason: 'server shutting down' }), false)
  assert.equal(isReplacedClose({ code: 1006, reason: '' }), false)
  assert.equal(isReplacedClose(undefined), false)
})

test(`竞速确认窗口：两个候选都 ack 时等 ${SETTLE_MS}ms 再定 winner（默认 400ms）`, () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, online } = createManager(clock, { candidates: [TAILSCALE, LAN], settleMs: 300 })
  manager.start()
  const [first, second] = FakeSocket.instances
  first.open()
  second.open()
  first.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  second.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  // 窗口内不确认：给「被 replaced 顶掉」留出纠正时间。
  assert.equal(manager.online, false)
  assert.equal(online.length, 0)
  clock.advance(299)
  assert.equal(manager.online, false)
  clock.advance(1)
  assert.equal(manager.online, true)
  assert.equal(manager.connectedUrl, TAILSCALE.url, '都活着时用第一个 ack 的候选')
  assert.equal(second.closed, true, '确认后关闭落选 socket')
  assert.equal(online.length, 1)
})

test('确认窗口内 winner 被 replaced：改用另一条已 ack 的候选，不触发重连', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, online, offline, statuses } = createManager(clock, {
    candidates: [TAILSCALE, LAN],
    settleMs: 300,
  })
  manager.start()
  const [first, second] = FakeSocket.instances
  first.open()
  second.open()
  first.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  second.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  // 服务端最后处理的是 second 的 hello → 把 first 顶掉（真实 gateway 行为）。
  first.close(1000, 'replaced by a newer connection')
  assert.equal(manager.online, true, '应该立刻改用另一条已 ack 的 socket')
  assert.equal(manager.connectedUrl, LAN.url)
  assert.equal(online.length, 1)
  assert.equal(offline.length, 0, '这是竞速内的正常让位，不算掉线')
  assert.equal(manager.state, CONNECTION_STATE.ONLINE)
  const socketCount = FakeSocket.instances.length
  clock.advance(60_000)
  assert.equal(FakeSocket.instances.length, socketCount, '不能因为一次让位就开新一轮连接')
  assert.equal(statuses[statuses.length - 1].state, CONNECTION_STATE.ONLINE)
})

test('确认窗口内 winner 被 replaced 且另一条还没 ack：等它 ack 后用，不重连', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, online } = createManager(clock, { candidates: [TAILSCALE, LAN], settleMs: 300 })
  manager.start()
  const [first, second] = FakeSocket.instances
  first.open()
  second.open()
  first.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  // first 被顶掉时 second 的 ack 还在路上。
  first.close(1000, 'replaced by a newer connection')
  assert.equal(manager.online, false)
  second.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  clock.advance(300)
  assert.equal(manager.online, true)
  assert.equal(manager.connectedUrl, LAN.url)
  assert.equal(online.length, 1)
})

test('已在线后收到 replaced close：不自动重连，状态标记 replaced 等待用户重试', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager, offline, statuses } = createManager(clock, { candidates: [LAN], settleMs: 0 })
  manager.start()
  const socket = FakeSocket.instances[0]
  socket.open()
  socket.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.online, true)

  socket.close(1000, 'replaced by a newer connection')
  assert.equal(manager.online, false)
  assert.equal(offline.length, 1)
  assert.equal(offline[0].replaced, true)
  const last = statuses[statuses.length - 1]
  assert.equal(last.state, CONNECTION_STATE.RECONNECTING)
  assert.equal(last.replaced, true)
  assert.equal(last.manual, true)
  assert.equal(clock.pending(), 0, '不能留自动重连定时器（否则两窗口互相顶掉死循环）')
  const count = FakeSocket.instances.length
  clock.advance(60_000)
  assert.equal(FakeSocket.instances.length, count, '不应自动创建新连接')
})

test('落选 socket 之后的 close 被忽略（不影响在线状态）', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [TAILSCALE, LAN], settleMs: 0 })
  manager.start()
  const [first, second] = FakeSocket.instances
  first.open()
  second.open()
  first.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(second.closed, true)
  // 模拟落选者的 close 事件晚到（FakeSocket.close 已触发过；再手动触发一次也不会崩）。
  second.onclose?.({ code: 1000, reason: 'client closing' })
  assert.equal(manager.online, true)
  assert.equal(manager.state, CONNECTION_STATE.ONLINE)
})

test('旧周期迟到的 ack 不会顶掉新周期的在线连接', () => {
  FakeSocket.reset()
  const clock = createClock()
  const { manager } = createManager(clock, { candidates: [LAN], settleMs: 0 })
  manager.start()
  const stale = FakeSocket.instances[0]
  stale.open()
  stale.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.online, true)

  manager.reconnect()
  assert.equal(FakeSocket.instances.length, 2)
  const fresh = FakeSocket.instances[1]
  // 旧 socket 迟到的 hello/ack（真实网络里 close 与 message 可能交错）。
  stale.onmessage?.({ data: JSON.stringify({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 }) })
  assert.equal(manager.online, false, '新周期还没 ack，不能被旧周期的 ack 影响')
  fresh.open()
  fresh.receive({ t: 'hello/ack', paired: true, heartbeatMs: 25_000 })
  assert.equal(manager.online, true)
  assert.equal(manager.current.socket, fresh, '当前活跃 socket 必须是新周期的')
})
