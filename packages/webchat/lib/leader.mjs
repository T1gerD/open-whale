// 跨标签单连接选主：同一浏览器（同一 origin）只允许一个标签持有 WebSocket。
//
// 真机问题（v3.0.x）：手机网页版同一 deviceId 会同时开多个页面/标签，每个页面各连
// 一条 WS，服务端不停用新连接顶掉旧连接 —— 日志里全是「未收到 CLOSE 帧」，峰值
// 26 次/分。根因不在服务端，而在网页版缺少「同一浏览器只连一条」的跨标签协调。
//
// 三级策略（从强到弱）：
//   1. Web Locks：`navigator.locks.request('openwhale-leader', {mode:'exclusive'})`
//      持锁到页面关闭；锁是浏览器保证独占的，队列里的下一个标签在 leader 关页/崩溃
//      后由浏览器自动授予，接管是幂等的。桌面 Chrome/Safari 走这条。
//   2. BroadcastChannel 心跳：老 WebView（百度/HarmonyOS 等常见）没有 Web Locks。
//      leader 每 heartbeatMs 广播一次 beacon；follower 超过 staleMs 没听到任何
//      beacon 就接管。两个 follower 同时发现 leader 消失时用「资历」收敛：启动更早
//      （since 更小）的标签获胜，同毫秒用 tabId 兜底，落败方收到 beacon 自动降级，
//      保证不会长期出现两个 leader。
//   3. 两者都不可用：solo —— 单标签直连，和加选主之前的行为一致（不会更糟）。
//
// 这一层不碰 DOM、不碰 WebSocket：锁管理器、BroadcastChannel 构造器、定时器、时钟、
// 随机数全部可注入，`test/leader.test.mjs` 用假锁/假通道/假时钟覆盖全部状态迁移。
//
// 状态机：
//   idle ──start()──> electing ──拿到锁/没有别的标签──> leader
//                        │                                 │
//                        └──听到其它标签的 beacon──> follower ──leader 消失──> leader
//   leader ──发现资历更老的 leader──> follower（收敛，避免双 leader）
//   任意状态 ──dispose()──> idle（释放锁 / 广播 bye / 清空所有定时器）
//   无锁无通道 ──start()──> solo（isLeader=true）

/** 标签在选主中的角色。 */
export const LEADER_ROLE = Object.freeze({
  IDLE: 'idle',
  ELECTING: 'electing',
  LEADER: 'leader',
  FOLLOWER: 'follower',
  SOLO: 'solo',
})

/** 本标签实际使用的协调方式（诊断用：手机 WebView 上会出现在 console 里）。 */
export const LEADER_STRATEGY = Object.freeze({
  LOCKS: 'locks',
  CHANNEL: 'channel',
  SOLO: 'solo',
})

/** Web Locks 的锁名 / BroadcastChannel 的频道名（同 origin 内共享）。 */
export const LEADER_LOCK_NAME = 'openwhale-leader'
export const LEADER_CHANNEL_NAME = 'openwhale-leader'

/** 通道消息版本：格式变化时递增，旧版本标签直接忽略。 */
export const LEADER_MESSAGE_VERSION = 1

/**
 * 默认时序（毫秒）。
 *  - heartbeatMs：leader 广播 beacon 的间隔；
 *  - staleMs：follower 多久没听到 beacon 就认为 leader 已消失（约 3 个心跳）；
 *  - startupGraceMs：新标签先听一小段再宣主，降低「两个新页面同时启动」的碰撞；
 *  - handoverMs / takeoverJitterMs：收到 bye / 发现 leader 消失后的接管延迟与抖动，
 *    避免两个 follower 同一毫秒一起接管。
 */
export const LEADER_TIMING = Object.freeze({
  heartbeatMs: 1500,
  staleMs: 4500,
  startupGraceMs: 250,
  handoverMs: 150,
  takeoverJitterMs: 250,
})

/**
 * 生成页面标签的唯一 id（用于同毫秒启动时的稳定排序）。
 * 浏览器没有 randomUUID 时退回时间戳 + 随机串；测试可注入固定值。
 * @returns {string}
 */
export function createTabId() {
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj?.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID()
    } catch {
      /* 某些 WebView 里 randomUUID 会抛错，继续走兜底 */
    }
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 单次选举器。一个页面一个，页面存活期间不换。 */
export class LeaderElector {
  /**
   * @param {object} [options]
   * @param {{request: Function}} [options.locks] navigator.locks（可注入假实现）
   * @param {new (name: string) => any} [options.channel] BroadcastChannel 构造器
   * @param {string} [options.tabId] 本标签 id（默认随机生成）
   * @param {() => number} [options.now]
   * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
   * @param {(id: any) => void} [options.clearTimeout]
   * @param {() => number} [options.random]
   * @param {(role: string, detail: {strategy: string, tabId: string, reason: string}) => void} [options.onChange]
   * @param {(error: any) => void} [options.onError]
   * @param {number} [options.heartbeatMs]
   * @param {number} [options.staleMs]
   * @param {number} [options.startupGraceMs]
   * @param {number} [options.handoverMs]
   * @param {number} [options.takeoverJitterMs]
   */
  constructor(options = {}) {
    this.locks = options.locks
    this.ChannelImpl = options.channel
    this.tabId = options.tabId ?? createTabId()
    this.now = options.now ?? (() => Date.now())
    this.setTimeoutImpl = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutImpl = options.clearTimeout ?? (id => clearTimeout(id))
    this.random = options.random ?? Math.random
    this.onChange = options.onChange ?? (() => {})
    this.onError = options.onError ?? (() => {})

    this.heartbeatMs = Math.max(100, Number(options.heartbeatMs) || LEADER_TIMING.heartbeatMs)
    // 至少要大于两个心跳，否则一次心跳抖动就会被误判成 leader 消失。
    this.staleMs = Math.max(this.heartbeatMs * 2, Number(options.staleMs) || LEADER_TIMING.staleMs)
    this.startupGraceMs = Math.max(0, Number.isFinite(Number(options.startupGraceMs))
      ? Number(options.startupGraceMs)
      : LEADER_TIMING.startupGraceMs)
    this.handoverMs = Math.max(0, Number.isFinite(Number(options.handoverMs))
      ? Number(options.handoverMs)
      : LEADER_TIMING.handoverMs)
    this.takeoverJitterMs = Math.max(0, Number.isFinite(Number(options.takeoverJitterMs))
      ? Number(options.takeoverJitterMs)
      : LEADER_TIMING.takeoverJitterMs)

    /** 选举资历：越早 start() 的标签 since 越小。 */
    this.since = this.now()
    /** @type {string} */
    this.role = LEADER_ROLE.IDLE
    /** @type {string | undefined} */
    this.strategy = undefined
    /** @type {string} */
    this.reason = 'constructed'
    this.started = false
    this.disposed = false

    /** @type {Set<{id: any}>} 尚未触发的定时器（dispose 必须清空）。 */
    this.timers = new Set()
    this.startupTimer = null
    this.heartbeatTimer = null
    this.takeoverTimer = null

    /** Web Locks：排队中的请求可以通过 abort 取消；持锁时用 release 函数放锁。 */
    this.abortController = null
    this.releaseLockResolve = null

    /** BroadcastChannel 实例与最近一次听到 leader beacon 的时间。 */
    this.channel = null
    this.lastPeerAt = 0
    this.peerTabId = ''
  }

  /** leader（含无法协调时的 solo）才允许创建 WebSocket。 */
  get isLeader() {
    return this.role === LEADER_ROLE.LEADER || this.role === LEADER_ROLE.SOLO
  }

  /** 待命 follower（UI 显示「已在其它标签连接」）。 */
  get isFollower() {
    return this.role === LEADER_ROLE.FOLLOWER
  }

  /** 定时器数量（测试断言 dispose 不泄漏）。 */
  get pendingTimers() {
    return this.timers.size
  }

  /**
   * 开始选举（幂等；重复调用不会创建第二个通道/锁请求）。
   * @returns {this}
   */
  start() {
    if (this.disposed || this.started) return this
    this.started = true
    this.since = this.now()
    if (typeof this.locks?.request === 'function') {
      this.#startLocks()
      return this
    }
    if (typeof this.ChannelImpl === 'function') {
      this.#startChannel()
      return this
    }
    this.strategy = LEADER_STRATEGY.SOLO
    this.#setRole(LEADER_ROLE.SOLO, 'no-coordination')
    return this
  }

  /**
   * 从后台回到前台时由 app 调用：follower 如果已经错过 leader 的 beacon（后台定时器
   * 被手机浏览器节流），立刻接管，不用再等下一次定时器。
   * @returns {boolean} 是否因此成为 leader
   */
  recheck() {
    if (this.disposed || this.strategy !== LEADER_STRATEGY.CHANNEL) return false
    if (this.role !== LEADER_ROLE.FOLLOWER) return false
    if (this.now() - this.lastPeerAt < this.staleMs) return false
    this.#promote('recheck-stale')
    return true
  }

  /**
   * 释放选主、清空全部定时器、关闭通道（幂等）。
   * 页面卸载/隐藏时调用：Web Locks 立刻释放，BroadcastChannel 广播 bye，
   * follower 因此能马上接管，而不是等 staleMs。
   * @param {{announce?: boolean, reason?: string}} [options] announce=false 仅用于测试模拟「进程被杀」
   */
  dispose(options = {}) {
    if (this.disposed) return
    this.disposed = true
    const announce = options.announce !== false
    const wasLeader = this.isLeader
    this.#clearTimers()

    if (this.strategy === LEADER_STRATEGY.LOCKS) {
      const resolve = this.releaseLockResolve
      this.releaseLockResolve = null
      try {
        resolve?.()
      } catch (error) {
        this.#report(error)
      }
      try {
        this.abortController?.abort()
      } catch (error) {
        this.#report(error)
      }
      this.abortController = null
    }

    if (this.channel) {
      // 先广播 bye 再 close：follower 收到后走 handoverMs 快速接管。
      if (announce && wasLeader) this.#post('bye')
      try {
        this.channel.close()
      } catch (error) {
        this.#report(error)
      }
      this.channel = null
    }

    this.#setRole(LEADER_ROLE.IDLE, options.reason ?? 'disposed')
  }

  // ---------------------------------------------------------------------------
  // 内部：Web Locks
  // ---------------------------------------------------------------------------

  /** 优先策略：独占锁。拿到锁 = leader；排队期间先按 electing 展示，稍后转 follower。 */
  #startLocks() {
    this.strategy = LEADER_STRATEGY.LOCKS
    this.#setRole(LEADER_ROLE.ELECTING, 'lock-request')
    // 锁请求是异步的：短时间内没拿到，说明其它标签正持有 → UI 先显示待命。
    this.startupTimer = this.#schedule(() => {
      this.startupTimer = null
      if (this.disposed || this.role !== LEADER_ROLE.ELECTING) return
      this.#setRole(LEADER_ROLE.FOLLOWER, 'lock-wait')
    }, this.startupGraceMs)

    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    this.abortController = controller
    const requestOptions = { mode: 'exclusive' }
    if (controller) requestOptions.signal = controller.signal

    let request
    try {
      request = this.locks.request(LEADER_LOCK_NAME, requestOptions, () => {
        // 已经降级到通道/放弃选举时迟到的授权：立刻放手，不要让两个策略同时生效。
        if (this.disposed || this.strategy !== LEADER_STRATEGY.LOCKS) return undefined
        this.#cancelTimer(this.startupTimer)
        this.startupTimer = null
        this.#setRole(LEADER_ROLE.LEADER, 'lock-granted')
        // 持锁到 dispose：返回的 promise 不 resolve，锁就一直归本标签。
        return new Promise(resolve => {
          this.releaseLockResolve = resolve
        })
      })
    } catch (error) {
      this.#fallbackFromLocks(error)
      return
    }
    Promise.resolve(request).catch(error => {
      if (this.disposed || error?.name === 'AbortError') return
      this.#fallbackFromLocks(error)
    })
  }

  /**
   * Web Locks 请求失败（老浏览器只实现了部分 API / 隐私模式拒绝）：退到通道心跳；
   * 通道也没有就 solo，至少保持单标签可用。
   * @param {any} error
   */
  #fallbackFromLocks(error) {
    if (this.disposed) return
    if (this.strategy === LEADER_STRATEGY.CHANNEL || this.strategy === LEADER_STRATEGY.SOLO) return
    this.#report(error)
    this.#cancelTimer(this.startupTimer)
    this.startupTimer = null
    // 取消还在排队的锁请求；已授予的锁会在 callback 的守卫里立刻放手。
    try {
      this.abortController?.abort()
    } catch {
      /* 取消失败不影响降级 */
    }
    this.abortController = null
    if (typeof this.ChannelImpl === 'function') {
      this.#startChannel()
      return
    }
    this.strategy = LEADER_STRATEGY.SOLO
    this.#setRole(LEADER_ROLE.SOLO, 'locks-unavailable')
  }

  // ---------------------------------------------------------------------------
  // 内部：BroadcastChannel 心跳
  // ---------------------------------------------------------------------------

  #startChannel() {
    this.strategy = LEADER_STRATEGY.CHANNEL
    try {
      this.channel = new this.ChannelImpl(LEADER_CHANNEL_NAME)
    } catch (error) {
      this.#report(error)
      this.strategy = LEADER_STRATEGY.SOLO
      this.#setRole(LEADER_ROLE.SOLO, 'channel-unavailable')
      return
    }
    this.channel.onmessage = event => this.#onChannelMessage(event?.data)
    this.#setRole(LEADER_ROLE.ELECTING, 'channel-listen')
    // 先挂定时器再 probe：已有 leader 的 beacon 可以取消这次「无主宣主」。
    this.startupTimer = this.#schedule(() => {
      this.startupTimer = null
      if (this.disposed || this.role !== LEADER_ROLE.ELECTING) return
      this.#promote('no-peer')
    }, this.startupGraceMs)
    // 告诉已有 leader「新标签来了」，让它立刻回一个 beacon，缩短判定时间。
    this.#post('probe')
  }

  /** @param {any} data */
  #onChannelMessage(data) {
    if (this.disposed) return
    if (!data || typeof data !== 'object') return
    if (data.v !== LEADER_MESSAGE_VERSION) return
    if (typeof data.tabId !== 'string' || data.tabId === this.tabId) return
    const kind = data.kind

    if (kind === 'probe') {
      // 新标签在问「有没有 leader」：leader 立刻回 beacon（Electing/follower 不回）。
      if (this.isLeader) this.#post('beacon')
      return
    }
    if (kind === 'bye') {
      if (this.role === LEADER_ROLE.LEADER) return
      if (data.tabId !== this.peerTabId) return
      this.peerTabId = ''
      this.#scheduleTakeover(this.handoverMs + this.#jitter())
      return
    }
    if (kind !== 'beacon') return

    this.lastPeerAt = this.now()
    this.peerTabId = data.tabId
    const peerSince = Number.isFinite(Number(data.since)) ? Number(data.since) : Number.POSITIVE_INFINITY

    if (this.role === LEADER_ROLE.LEADER) {
      if (peerSince < this.since || (peerSince === this.since && data.tabId < this.tabId)) {
        // 对方启动更早：主动降级，避免两个 leader 长期并存。
        this.#demote('older-peer')
      } else {
        // 我是更老的 leader：立刻重播 beacon，让对方在下一个步骤就降级。
        this.#post('beacon')
      }
      return
    }

    this.#cancelTimer(this.startupTimer)
    this.startupTimer = null
    this.#setRole(LEADER_ROLE.FOLLOWER, 'peer-beacon')
    this.#scheduleTakeover(this.staleMs + this.#jitter())
  }

  /** 成为 leader 并开始心跳（通道策略才需要心跳；solo 不广播）。 */
  #promote(reason) {
    if (this.disposed) return
    this.#cancelTimer(this.startupTimer)
    this.startupTimer = null
    this.#cancelTimer(this.takeoverTimer)
    this.takeoverTimer = null
    this.#setRole(LEADER_ROLE.LEADER, reason)
    if (this.channel) this.#post('beacon')
    this.#scheduleHeartbeat()
  }

  #scheduleHeartbeat() {
    this.#cancelTimer(this.heartbeatTimer)
    this.heartbeatTimer = this.#schedule(() => {
      this.heartbeatTimer = null
      if (this.disposed || this.role !== LEADER_ROLE.LEADER) return
      this.#post('beacon')
      this.#scheduleHeartbeat()
    }, this.heartbeatMs)
  }

  /** 从 leader 降级为 follower（发现资历更老的 leader）。 */
  #demote(reason) {
    this.#cancelTimer(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.lastPeerAt = this.now()
    this.#setRole(LEADER_ROLE.FOLLOWER, reason)
    this.#scheduleTakeover(this.staleMs + this.#jitter())
  }

  /**
   * 安排一次接管检查：延迟到了还是 follower 且没有新 beacon，就宣主。
   * @param {number} delayMs
   */
  #scheduleTakeover(delayMs) {
    this.#cancelTimer(this.takeoverTimer)
    this.takeoverTimer = this.#schedule(() => {
      this.takeoverTimer = null
      if (this.disposed || this.role !== LEADER_ROLE.FOLLOWER) return
      this.#promote('peer-gone')
    }, delayMs)
  }

  /** @param {string} kind @param {string} [extraKey] */
  #post(kind) {
    if (!this.channel) return
    try {
      this.channel.postMessage({
        v: LEADER_MESSAGE_VERSION,
        kind,
        tabId: this.tabId,
        since: this.since,
        at: this.now(),
      })
    } catch (error) {
      this.#report(error)
    }
  }

  /** @returns {number} 0..takeoverJitterMs 的随机抖动 */
  #jitter() {
    if (this.takeoverJitterMs <= 0) return 0
    const value = Number(this.random())
    const normalized = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
    return Math.floor(normalized * this.takeoverJitterMs)
  }

  // ---------------------------------------------------------------------------
  // 内部：角色 / 定时器 / 错误
  // ---------------------------------------------------------------------------

  /**
   * @param {string} role
   * @param {string} reason
   */
  #setRole(role, reason) {
    const changed = this.role !== role
    this.role = role
    this.reason = reason
    if (!changed) return
    try {
      this.onChange(role, { strategy: this.strategy, tabId: this.tabId, reason })
    } catch (error) {
      this.#report(error)
    }
  }

  /** @param {() => void} fn @param {number} ms */
  #schedule(fn, ms) {
    const entry = { id: undefined }
    this.timers.add(entry)
    entry.id = this.setTimeoutImpl(() => {
      this.timers.delete(entry)
      fn()
    }, ms)
    return entry
  }

  /** @param {{id: any} | null} entry */
  #cancelTimer(entry) {
    if (!entry) return
    this.timers.delete(entry)
    if (entry.id !== undefined) this.clearTimeoutImpl(entry.id)
  }

  #clearTimers() {
    for (const entry of [...this.timers]) {
      this.timers.delete(entry)
      if (entry.id !== undefined) this.clearTimeoutImpl(entry.id)
    }
    this.startupTimer = null
    this.heartbeatTimer = null
    this.takeoverTimer = null
  }

  /** @param {any} error */
  #report(error) {
    try {
      this.onError(error)
    } catch {
      /* 诊断回调自己出错不能影响选主 */
    }
  }
}
