// WebSocket 连接管理：多地址竞速 + 指数退避重连 + 心跳。
//
// 设计约束（来自 v2.2.0 的用户问题）：
//   * 隧道地址经常比局域网/Tailscale 慢一个数量级，**不能**依次等超时，
//     必须并发竞速前两个候选（协议 §7.1）；
//   * 手机浏览器切后台/换网络很常见，重连要指数退避且给出可操作文案；
//   * 认证失败（配对过期、签名不合法）重试没有意义，必须停下来让用户重新扫码，
//     否则会把电脑端的 NonceReplayGuard 刷爆。
//
// 这一层不碰 DOM：WebSocket、定时器、随机数全部可注入，`test/connection.test.mjs`
// 用假 socket + 假定时器驱动竞速、换址、心跳和致命错误。

import { DEFAULT_HEARTBEAT_MS, SERVER_FRAME } from './protocol.mjs'
import { buildWebSocketUrl } from './endpoints.mjs'

/** 连接状态。 */
export const CONNECTION_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  ONLINE: 'online',
  RECONNECTING: 'reconnecting',
  REJECTED: 'rejected',
  STOPPED: 'stopped',
})

/** 重连退避参数。 */
export const BACKOFF = Object.freeze({
  baseMs: 1000,
  factor: 1.8,
  maxMs: 15_000,
})

/** 握手超时：一个候选地址从 open 到 hello/ack 的最长时间。 */
export const HELLO_TIMEOUT_MS = 12_000

/**
 * 竞速确认窗口（毫秒）。同一 deviceId 并发 hello 时，服务端可能把先 ack 的那条
 * 当作「旧连接」关掉；等一个短暂的确认窗口再定 winner，就能把「被顶掉」翻译成
 * 「换另一条已 ack 的候选」，而不是整轮重连死循环。
 */
export const SETTLE_MS = 400

/**
 * 判断 close 事件是不是「被同 deviceId 的新连接替换」。
 * 服务端 gateway 用 `close(1000, 'replaced by a newer connection')`；不同版本措辞
 * 可能变化，所以同时看 reason 关键字与常见 code。
 * @param {{code?: number, reason?: string} | undefined} info
 * @returns {boolean}
 */
export function isReplacedClose(info) {
  const reason = String(info?.reason ?? '').toLowerCase()
  return /replac|newer connection|taken over|supersed|kicked|顶掉|替换/.test(reason)
}

/** 客户端 app 层心跳（协议 ping/pong；服务端在 hello/ack 里给 heartbeatMs）。 */
export const DEFAULT_APP_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS

/** WebSocket readyState。 */
const WS_CONNECTING = 0
const WS_OPEN = 1

/**
 * 计算第 attempt 次重连的等待时间（含 ±20% 抖动，避免多设备同步重连）。
 * @param {number} attempt 1 起
 * @param {{baseMs?: number, factor?: number, maxMs?: number, random?: () => number}} [options]
 * @returns {number}
 */
export function reconnectDelay(attempt, options = {}) {
  const base = options.baseMs ?? BACKOFF.baseMs
  const factor = options.factor ?? BACKOFF.factor
  const max = options.maxMs ?? BACKOFF.maxMs
  const random = options.random ?? Math.random
  const raw = Math.min(max, Math.round(base * Math.pow(factor, Math.max(0, attempt - 1))))
  const jitter = 0.8 + random() * 0.4
  return Math.max(250, Math.round(raw * jitter))
}

/**
 * 生成给用户看的连接状态文案（含可操作建议）。
 * @param {object} status
 * @returns {{title: string, detail: string, action?: string}}
 */
export function describeStatus(status) {
  const state = status?.state ?? CONNECTION_STATE.IDLE
  switch (state) {
    case CONNECTION_STATE.CONNECTING:
      return { title: '正在连接电脑…', detail: status.url ? `尝试 ${status.url}` : '正在选择最快地址' }
    case CONNECTION_STATE.ONLINE:
      return {
        title: '已连接',
        detail: status.url ? `${status.kindLabel ?? ''} ${status.url}`.trim() : '连接正常',
      }
    case CONNECTION_STATE.RECONNECTING: {
      if (status.replaced === true) {
        return {
          title: '连接被新打开的设备/窗口替换',
          detail: '另一个窗口或另一台设备用同一身份连上了这台电脑。为避免两边互相顶掉，已停止自动重连；点「重试」可抢回连接。',
          action: 'retry',
        }
      }
      const attempted = Array.isArray(status.failedUrls) && status.failedUrls.length > 0
        ? `；已尝试 ${status.failedUrls.join('、')}`
        : ''
      return {
        title: status.attempt > 0 ? `连接断开，${Math.ceil((status.delayMs ?? 0) / 1000)} 秒后重试` : '正在重新连接…',
        detail: `${status.reason ? `${status.reason}。` : ''}换连接方式或重新扫码通常能解决${attempted}`,
        action: 'retry',
      }
    }
    case CONNECTION_STATE.REJECTED:
      return {
        title: '连接被电脑拒绝',
        detail: status.reason ?? '请确认电脑端插件正在运行，并重新扫码绑定。',
        action: 'rebind',
      }
    case CONNECTION_STATE.STOPPED:
      return { title: '已断开', detail: '连接已手动关闭' }
    default:
      return { title: '未连接', detail: status?.reason ?? '等待连接' }
  }
}

/**
 * 一个连接管理器实例管理「一台电脑」的一条逻辑连接。
 *
 * 事件回调（都由调用方注入，便于测试）：
 *  - onStatus(status)：状态变化（连接中/在线/重连/被拒）
 *  - onFrame(frame)：已认证连接上的每一帧
 *  - onOnline(ack, context)：握手成功
 *  - onOffline(info)：连接断开
 */
export class ConnectionManager {
  /**
   * @param {object} options
   * @param {new (url: string) => any} options.WebSocketImpl
   * @param {Array<{url: string, kind: string}>} options.candidates
   * @param {(context: {url: string, kind: string}) => object} options.buildHello 每次 open 都调用；必须生成新 nonce
   * @param {(ack: object, context: {hello: object, url: string, kind: string}) => {ok: boolean, verified?: boolean, warning?: string, reason?: string}} [options.verifyAck]
   * @param {(frame: object) => void} [options.onFrame]
   * @param {(status: object) => void} [options.onStatus]
   * @param {(ack: object, context: object) => void} [options.onOnline]
   * @param {(info: object) => void} [options.onOffline]
   * @param {() => number} [options.now]
   * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
   * @param {(id: any) => void} [options.clearTimeout]
   * @param {number} [options.helloTimeoutMs]
   * @param {number} [options.raceSize]
   * @param {number} [options.settleMs] 竞速确认窗口（默认 SETTLE_MS；0 = 立即确认）
   * @param {number} [options.maxBackoffMs]
   * @param {() => number} [options.random]
   */
  constructor(options) {
    this.WebSocketImpl = options.WebSocketImpl
    this.candidates = (options.candidates ?? []).slice()
    this.buildHello = options.buildHello
    this.verifyAck = options.verifyAck ?? (() => ({ ok: true, verified: false }))
    this.onFrame = options.onFrame ?? (() => {})
    this.onStatus = options.onStatus ?? (() => {})
    this.onOnline = options.onOnline ?? (() => {})
    this.onOffline = options.onOffline ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.setTimeoutImpl = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutImpl = options.clearTimeout ?? (id => clearTimeout(id))
    this.random = options.random ?? Math.random
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    this.raceSize = Math.max(1, options.raceSize ?? 2)
    this.maxBackoffMs = options.maxBackoffMs ?? BACKOFF.maxMs
    /**
     * 竞速「确认窗口」：第一个 hello/ack 到手后再等这么久，看它会不会被服务端
     * 以「replaced」关掉（同一 deviceId 的并发 hello 里，服务端最后处理的那条才是
     * 当前会话）。窗口内被顶掉就立刻改用另一条已 ack 的 socket，而不是整轮重试。
     * 0 = 收到第一个 ack 立即确认（测试用）。
     */
    this.settleMs = Math.max(0, options.settleMs ?? SETTLE_MS)
    /** 连接周期序号：旧周期迟到的回调一律忽略，避免「换代后旧 socket 又改状态」。 */
    this.cycle = 0
    this.state = CONNECTION_STATE.IDLE
    /** 第几次重连（0 = 首次连接）。 */
    this.attempt = 0
    /** 下一批候选的起始下标。 */
    this.index = 0
    /** @type {Array<{url: string, reason: string, at: number}>} */
    this.failures = []
    /** @type {any} 当前认证成功的 socket 上下文 */
    this.current = null
    /** @type {Set<any>} 本轮竞速里的所有 socket */
    this.live = new Set()
    /** @type {Array<{id: any}>} 尚未触发的定时器。 */
    this.timers = []
    this.heartbeatMs = DEFAULT_APP_HEARTBEAT_MS
    this.watchdogTimer = null
    this.reconnectTimer = null
    this.lastInboundAt = 0
    this.stopped = true
    /** @type {object} 最近一次状态。 */
    this.lastStatus = { state: CONNECTION_STATE.IDLE }
  }

  /** 更新候选地址（例如 hello/ack 带回 endpointList 或用户手动加了地址）。 */
  setCandidates(candidates) {
    this.candidates = (Array.isArray(candidates) ? candidates : []).slice()
  }

  get online() {
    return this.state === CONNECTION_STATE.ONLINE && this.current !== null
  }

  /** 当前连接使用的地址。 */
  get connectedUrl() {
    return this.current?.url
  }

  /** 当前连接使用的地址类型。 */
  get connectedKind() {
    return this.current?.kind
  }

  /** 开始连接（重复调用幂等）。 */
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.index = 0
    this.failures = []
    this.#connectCycle()
  }

  /** 停止连接并关闭所有 socket（页面卸载/解绑时调用）。 */
  stop(reason = '手动断开') {
    this.stopped = true
    this.cycle += 1 // 旧周期的迟到回调全部作废
    this.#clearTimers()
    this.#closeAll()
    this.current = null
    this.state = CONNECTION_STATE.STOPPED
    this.#emitStatus({ state: CONNECTION_STATE.STOPPED, reason })
  }

  /**
   * 发送一帧；返回 false 表示当前没连上（调用方负责进离线队列）。
   * @param {object} frame
   * @returns {boolean}
   */
  send(frame) {
    const context = this.current
    if (!context) return false
    const socket = context.socket
    if (!socket || this.#readyState(socket) !== WS_OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  /**
   * 主动重连（设置页「重新连接」按钮 / 从后台恢复时调用）。
   * @param {boolean} [resetAttempts]
   */
  reconnect(resetAttempts = true) {
    if (this.stopped) {
      this.start()
      return
    }
    this.#clearTimers()
    // 先摘掉 current，再关 socket：否则 onClosed 会把它当成「在线连接掉线」→ 触发
    // #handleDrop 的自动重连，和本方法自己的重连叠在一起（一次重连变两次）。
    this.current = null
    this.#closeAll()
    this.cycle += 1
    this.index = 0
    if (resetAttempts) {
      this.attempt = 0
      this.failures = []
    } else {
      this.attempt += 1
    }
    this.state = CONNECTION_STATE.RECONNECTING
    this.#connectCycle()
  }

  /** 当前状态的可读文案。 */
  statusText() {
    return describeStatus(this.lastStatus)
  }

  /** 记录入站活动（心跳看门狗用；应用层收到帧时也可调用）。 */
  noteInbound() {
    this.lastInboundAt = this.now()
  }

  // ---------------------------------------------------------------------------
  // 内部：连接周期
  // ---------------------------------------------------------------------------

  /**
   * 从 index 起点取一批候选并发竞速；全部失败后换下一批，整轮失败后退避重连。
   *
   * 竞速确认（2.2.0 修复）：同一 deviceId 的两条 socket 会同时 hello，电脑端若只
   * 允许一条会话，就会把先连上的那条以「replaced」踢掉。所以：
   *   1. 第一个 hello/ack 只记为「候选 winner」，不立刻关掉另一条；
   *   2. 等 `settleMs` 确认窗口；窗口内若 winner 被 replaced 关掉，就改用另一条
   *      已 ack 的 socket（或等它 ack 后立刻用它），**不**触发整轮重试；
   *   3. 窗口结束/另一条被关闭后，才#accept，并只关闭落选 socket；
   *   4. 每个候选都带周期号，旧周期的迟到 close/ack 一律忽略。
   */
  #connectCycle() {
    if (this.stopped) return
    if (this.candidates.length === 0) {
      this.state = CONNECTION_STATE.RECONNECTING
      this.#emitStatus({
        state: CONNECTION_STATE.RECONNECTING,
        reason: '没有可用地址。请重新扫码，或在设置里手动添加电脑地址（例如 192.168.1.5:8787）。',
        noEndpoints: true,
      })
      return
    }
    const cycle = (this.cycle += 1)
    const batch = this.candidates.slice(this.index, this.index + this.raceSize)
    this.state = this.attempt === 0 && this.failures.length === 0 ? CONNECTION_STATE.CONNECTING : CONNECTION_STATE.RECONNECTING
    this.#emitStatus({
      state: this.state,
      url: batch[0]?.url,
      kind: batch[0]?.kind,
      attempt: this.attempt,
      candidates: batch,
      racing: batch.length > 1,
    })

    let outcome = 'pending' // pending | online | rejected | failed
    let settled = false
    /** 还没出结论的 socket 数（未 ack 也未失败）。 */
    let remaining = batch.length
    /** 已收到 hello/ack、仍在等确认窗口的 socket。 */
    const acked = []
    /** @type {Array<{url: string, reason: string}>} */
    const batchFailures = []
    /** @type {{id: any} | undefined} */
    let settleTimer

    /** 确认 winner：只在还没有 winner 时生效。 */
    const finalize = context => {
      if (settled || outcome !== 'pending') {
        this.#closeContext(context)
        return
      }
      settled = true
      outcome = 'online'
      if (settleTimer) {
        this.#cancelTimer(settleTimer)
        settleTimer = undefined
      }
      this.#accept(context, context.ack)
    }

    /** 整批失败：换下一批，或进入退避。 */
    const concludeFailure = () => {
      if (outcome !== 'pending') return
      outcome = 'failed'
      this.index += batch.length
      for (const failure of batchFailures) {
        if (!failure?.url) continue
        this.failures.push({ ...failure, at: this.now() })
        if (this.failures.length > 8) this.failures.shift()
      }
      if (this.index >= this.candidates.length) {
        this.index = 0
        this.#scheduleReconnect()
        return
      }
      this.#connectCycle()
    }

    /** 还有在等 ack 的 socket 时先等；全都出结论了再判断。 */
    const concludeIfIdle = () => {
      if (outcome !== 'pending') return
      if (acked.length > 0) {
        // 单候选（首次绑定）或关闭了确认窗口：直接用它。
        if (this.settleMs <= 0 || batch.length === 1) finalize(acked[0])
        return
      }
      if (remaining === 0) concludeFailure()
    }

    for (const candidate of batch) {
      const context = this.#openCandidate(candidate, {
        onAck: ctx => {
          if (cycle !== this.cycle) {
            this.#closeContext(ctx)
            return
          }
          if (settled || outcome !== 'pending') {
            this.#closeContext(ctx)
            return
          }
          ctx.raceState = 'acked'
          acked.push(ctx)
          if (this.settleMs > 0 && batch.length > 1) {
            // 多候选竞速：等一个确认窗口，看这条会不会被服务端以 replaced 顶掉。
            if (!settleTimer) {
              settleTimer = this.#schedule(() => {
                settleTimer = undefined
                if (settled || outcome !== 'pending') return
                if (acked.length > 0) finalize(acked[0])
                else concludeFailure()
              }, this.settleMs)
            }
          } else {
            finalize(ctx)
          }
          concludeIfIdle()
        },
        onFailure: (reason, fatal, ctx) => {
          if (cycle !== this.cycle) return
          if (ctx?.raceState === 'acked' || ctx?.raceState === 'failed') return
          if (ctx) ctx.raceState = 'failed'
          remaining -= 1
          batchFailures.push({ url: candidate.url, reason })
          if (fatal) {
            if (outcome === 'pending') {
              outcome = 'rejected'
              settled = true
              this.#reject(reason)
            }
            return
          }
          concludeIfIdle()
        },
        onClosed: (ctx, info) => {
          if (cycle !== this.cycle) return
          // 已定 winner：只有当前活跃那条的 close 有意义；落选者 close 直接忽略。
          if (settled) {
            if (this.current && this.current.socket === ctx.socket) {
              this.#handleDrop(info?.reason || '连接已断开', { replaced: info?.replaced === true })
            }
            return
          }
          if (ctx.raceState !== 'acked') return
          // 确认窗口内 winner 候选被服务端顶掉：改用另一条已 ack 的候选。
          ctx.raceState = 'closed'
          remaining -= 1
          const index = acked.indexOf(ctx)
          if (index >= 0) acked.splice(index, 1)
          if (settleTimer) {
            this.#cancelTimer(settleTimer)
            settleTimer = undefined
          }
          if (acked.length > 0) finalize(acked[0])
          else concludeIfIdle()
        },
      })
    }
  }

  /**
   * 打开一个候选地址并发送 hello。
   * @param {{url: string, kind: string}} candidate
   * @param {{onAck: (context: any) => void, onFailure: (reason: string, fatal: boolean, context?: any) => void, onClosed: (context: any, info: {code: number, reason: string, replaced: boolean}) => void}} hooks
   * @returns {any | undefined} socket 上下文（构造失败时为 undefined）
   */
  #openCandidate(candidate, hooks) {
    const url = buildWebSocketUrl(candidate.url)
    if (!url) {
      hooks.onFailure('地址格式不合法', false)
      return
    }
    /** @type {any} */
    const context = {
      url: candidate.url,
      kind: candidate.kind,
      wsUrl: url,
      socket: null,
      hello: null,
      acked: false,
      verified: false,
      warning: undefined,
      timer: undefined,
      hooks,
    }
    /** 防止 error + close + timeout 三重触发失败。 */
    let failed = false

    /** @param {string} reason @param {boolean} fatal */
    const fail = (reason, fatal = false) => {
      if (failed || context.acked) return
      failed = true
      this.#cancelTimer(context.timer)
      context.timer = undefined
      hooks.onFailure(reason, fatal, context)
      this.#closeContext(context)
    }

    let socket
    try {
      socket = new this.WebSocketImpl(url)
    } catch (error) {
      fail(`无法创建连接：${/** @type {Error} */ (error).message}`, false)
      return
    }
    context.socket = socket
    this.live.add(context)
    context.timer = this.#schedule(() => {
      if (!context.acked) fail('握手超时', false)
    }, this.helloTimeoutMs)

    socket.onopen = () => {
      if (context.acked || failed) return
      try {
        const hello = this.buildHello({ url: candidate.url, kind: candidate.kind })
        context.hello = hello
        socket.send(JSON.stringify(hello))
      } catch (error) {
        fail(`生成握手失败：${/** @type {Error} */ (error).message}`, false)
      }
    }
    socket.onmessage = event => {
      const frame = this.#parseFrame(event)
      if (!frame) return
      this.noteInbound()
      if (!context.acked) {
        if (frame.t === SERVER_FRAME.HELLO_ACK) {
          const verdict = this.verifyAck(frame, { hello: context.hello, url: candidate.url, kind: candidate.kind })
          if (!verdict?.ok) {
            fail(verdict?.reason ?? '电脑身份校验失败', true)
            return
          }
          this.#cancelTimer(context.timer)
          context.timer = undefined
          context.acked = true
          context.ack = frame
          context.verified = verdict?.verified === true
          context.warning = verdict?.warning
          context.raceState = 'pending'
          hooks.onAck(context)
          return
        }
        if (frame.t === SERVER_FRAME.ERROR) {
          // 握手阶段电脑主动回 error：配对过期/签名不合法/设备过多。
          // 这些重试没用，直接停下来让用户处理。
          fail(String(frame.message ?? '握手被拒绝'), true)
          return
        }
        // 握手前其它帧一律忽略（老服务端不会这么发）。
        return
      }
      this.onFrame(frame)
    }
    socket.onerror = () => {
      if (!context.acked) fail('网络错误', false)
    }
    socket.onclose = event => {
      const code = Number.isFinite(event?.code) ? event.code : 0
      const rawReason = typeof event?.reason === 'string' ? event.reason : ''
      const reasonText = rawReason !== '' ? `（${rawReason}）` : ''
      if (!context.acked) {
        fail(`连接被关闭 ${code}${reasonText}`, false)
        return
      }
      hooks.onClosed(context, { code, reason: rawReason, replaced: isReplacedClose({ code, reason: rawReason }) })
    }
    return context
  }

  /**
   * 握手成功：关掉竞速里其它 socket，开始心跳，切 ONLINE。
   * @param {any} context
   * @param {object} ack
   */
  #accept(context, ack) {
    this.current = context
    this.attempt = 0
    this.index = 0
    this.failures = []
    // 成功的地址排到第一位，下次重连先试它（协议：上次成功 > Tailscale > ...）。
    const successful = { url: context.url, kind: context.kind }
    this.candidates = [successful, ...this.candidates.filter(item => item.url !== context.url)]
    for (const other of [...this.live]) {
      if (other !== context) this.#closeContext(other)
    }
    this.live = new Set([context])
    this.lastInboundAt = this.now()
    this.state = CONNECTION_STATE.ONLINE
    this.heartbeatMs = Number.isFinite(Number(ack?.heartbeatMs)) && Number(ack.heartbeatMs) > 0
      ? Number(ack.heartbeatMs)
      : DEFAULT_APP_HEARTBEAT_MS
    this.#startHeartbeat()
    this.#emitStatus({
      state: CONNECTION_STATE.ONLINE,
      url: context.url,
      kind: context.kind,
      verified: context.verified === true,
      warning: context.warning,
      ack,
    })
    this.onOnline(ack, { url: context.url, kind: context.kind, verified: context.verified === true })
  }

  /** 致命错误：停止重试，让人看到原因。 */
  #reject(reason) {
    this.cycle += 1
    this.#clearTimers()
    this.#closeAll()
    this.current = null
    this.state = CONNECTION_STATE.REJECTED
    this.lastInboundAt = 0
    this.#emitStatus({ state: CONNECTION_STATE.REJECTED, reason })
  }

  /**
   * 已认证连接断开。
   * @param {string} reason
   * @param {{replaced?: boolean}} [options] replaced=true 表示被同一 deviceId 的新连接顶掉
   */
  #handleDrop(reason, options = {}) {
    if (this.stopped) return
    const context = this.current
    this.#stopHeartbeat()
    this.current = null
    this.cycle += 1 // 让旧周期的迟到回调全部作废
    if (context) this.#closeContext(context)
    if (options.replaced === true) {
      this.#handleReplaced(reason)
      return
    }
    this.state = CONNECTION_STATE.RECONNECTING
    this.onOffline({ reason })
    this.#scheduleReconnect([{ url: context?.url ?? '', reason }])
  }

  /**
   * 连接被「同一设备的新连接」替换。
   *
   * 为什么**不**自动重连：两个窗口/两台页面用同一个 deviceId 时，服务端会不断踢掉
   * 旧连接；自动重连会让两边互相顶掉，形成每秒循环。这里停下来，把决定权交给用户
   * （点「重试」抢回连接，或关掉另一个窗口）。
   * @param {string} reason
   */
  #handleReplaced(reason) {
    this.live.clear()
    this.lastInboundAt = 0
    this.state = CONNECTION_STATE.RECONNECTING
    this.onOffline({ reason, replaced: true })
    this.#emitStatus({
      state: CONNECTION_STATE.RECONNECTING,
      reason,
      replaced: true,
      manual: true,
      action: 'retry',
      attempt: 0,
    })
  }

  /** 安排下一次重连（指数退避）。 */
  #scheduleReconnect() {
    if (this.stopped) return
    this.attempt += 1
    const delayMs = Math.min(this.maxBackoffMs, reconnectDelay(this.attempt, { random: this.random }))
    const failedUrls = [...new Set(this.failures.slice(-3).map(item => item.url).filter(Boolean))]
    this.state = CONNECTION_STATE.RECONNECTING
    this.#emitStatus({
      state: CONNECTION_STATE.RECONNECTING,
      attempt: this.attempt,
      delayMs,
      reason: this.failures[this.failures.length - 1]?.reason,
      failedUrls,
      action: 'retry',
    })
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      this.#connectCycle()
    }, delayMs)
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    const interval = Math.max(5000, Math.floor(this.heartbeatMs))
    const tick = () => {
      this.watchdogTimer = null
      if (this.stopped || !this.current) return
      const idle = this.now() - this.lastInboundAt
      // 3 个心跳周期没有任何入站帧 → 认为连接已死（半开 socket 在移动网络里很常见）。
      if (idle > interval * 3) {
        this.#handleDrop('连接超时（长时间没有收到电脑响应）')
        return
      }
      this.send({ t: 'ping' })
      this.watchdogTimer = this.setTimeoutImpl(tick, interval)
    }
    this.watchdogTimer = this.setTimeoutImpl(tick, interval)
  }

  #stopHeartbeat() {
    if (this.watchdogTimer !== null) {
      this.clearTimeoutImpl(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：定时器 / socket 工具
  // ---------------------------------------------------------------------------

  /** @param {() => void} fn @param {number} ms */
  #schedule(fn, ms) {
    const entry = { id: undefined }
    this.timers.push(entry)
    entry.id = this.setTimeoutImpl(() => {
      this.timers = this.timers.filter(item => item !== entry)
      fn()
    }, ms)
    return entry
  }

  /** @param {{id: any} | undefined} entry */
  #cancelTimer(entry) {
    if (!entry) return
    this.timers = this.timers.filter(item => item !== entry)
    if (entry.id !== undefined) this.clearTimeoutImpl(entry.id)
  }

  #clearTimers() {
    for (const entry of this.timers) {
      if (entry.id !== undefined) this.clearTimeoutImpl(entry.id)
    }
    this.timers = []
    if (this.reconnectTimer !== null) {
      this.clearTimeoutImpl(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.#stopHeartbeat()
  }

  #closeAll() {
    for (const context of [...this.live]) this.#closeContext(context)
    this.live.clear()
  }

  /** @param {any} context */
  #closeContext(context) {
    if (!context) return
    if (context.timer) {
      this.#cancelTimer(context.timer)
      context.timer = undefined
    }
    this.live.delete(context)
    this.#closeSocket(context.socket)
  }

  /** @param {any} socket */
  #closeSocket(socket) {
    if (!socket) return
    try {
      const state = this.#readyState(socket)
      if (state === WS_CONNECTING || state === WS_OPEN) socket.close(1000, 'client closing')
    } catch {
      /* 已经关了就算了 */
    }
  }

  /** @param {any} socket */
  #readyState(socket) {
    const value = socket?.readyState
    if (typeof value === 'number') return value
    return WS_OPEN
  }

  /** @param {any} event */
  #parseFrame(event) {
    const data = typeof event === 'string' ? event : event?.data
    if (typeof data !== 'string') return undefined
    try {
      return JSON.parse(data)
    } catch {
      return undefined
    }
  }

  /** @param {object} status */
  #emitStatus(status) {
    this.lastStatus = { ...status, at: this.now() }
    this.onStatus(this.lastStatus)
  }
}
