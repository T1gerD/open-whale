// 与一台电脑的 WebSocket 连接：握手、心跳、退避重连、地址轮换。
//
// 这里只做“传输与生命周期”，业务判定全部下沉到 core/ 的纯逻辑：
//  * 握手是否成功 → `interpretHelloAck`；
//  * 重连等待多久 → `nextBackoffMs`；
//  * 地址顺序 → `endpointLadder`；
//  * 握手错误文案 → `handshakeErrorHint`。
// 这样才能在电脑上（无 Android SDK）把最关键的行为测掉。

import { AppState, type AppStateStatus } from 'react-native'

import { isRetryAllowed, nextBackoffMs } from '../core/backoff.mts'
import { getConnectionPolicy } from '../core/connection-policy.mts'
import { endpointLadder, wsUrlFor } from '../core/endpoint.mts'
import { buildHelloFrame, handshakeErrorHint, helloSignatureMessage, interpretHelloAck } from '../core/pairing.mts'
import type { AssistantRecord } from '../core/pairing.mts'
import { buildPowerRequest, type PowerAction } from '../core/power.mts'
import type { ClientFrame, HelloAckFrame, LinkSnapshot, LinkStatus, ServerFrame } from '../protocol/types'

import { randomNonce, randomRequestId, signMessage } from './crypto'

export interface LinkIdentity {
  deviceId: string
  deviceName: string
  /** 32 字节 Ed25519 seed。 */
  seed: Uint8Array
  /** base64url 的 SPKI DER 公钥（由 seed 派生一次，握手时直接用）。 */
  publicKeySpki: string
}

export interface AssistantLinkOptions {
  assistant: AssistantRecord
  identity: LinkIdentity
  /** 首次绑定用的一次性密钥；握手成功后由调用方清掉。 */
  pairSecret?: string
  onFrame(frame: ServerFrame): void
  onStatus(snapshot: LinkSnapshot): void
  /** 握手通过（paided=true 表示这是首次绑定成功的一刻）。 */
  onHelloAck?(ack: HelloAckFrame, pairing: boolean): void
  log?(message: string): void
  maxAttempts?: number
  /** 便于测试注入 AppState；默认用 react-native 的。 */
  appState?: { currentState: AppStateStatus; addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void } }
}

/** 电脑端等 hello 的上限是 10s，本地留一点余量让它的 error 帧先到。 */
const HANDSHAKE_TIMEOUT_MS = 12_000

/**
 * 同一个地址连续失败多少次之后才允许换下一个。
 *
 * 取 3 而不是 1：网络抖动或电脑刚重启时，一次失败不代表地址不可用；
 * 而立刻轮换会让「唯一可用地址」和「完全不可达地址」交替出现，
 * 连接永远无法稳定（见 open() 里的说明）。
 */
const ENDPOINT_SWITCH_AFTER = 3

/** 这些错误重试也没用：密钥不对、电脑端已绑定别的手机等必须人工介入。 */
const FATAL_ERROR_CODES = new Set([
  'bad-signature',
  'already-paired',
  'pairing-rejected',
  'bad-device-id',
  'bad-device-key',
  'not-authenticated',
])

function isOpen(socket: WebSocket | undefined): socket is WebSocket {
  // RN 的 WebSocket 有 readyState；1 === OPEN
  return socket !== undefined && socket.readyState === 1
}

export class AssistantLink {
  private readonly options: AssistantLinkOptions
  private assistant: AssistantRecord
  private identity: LinkIdentity
  private pairSecret: string | undefined

  private socket: WebSocket | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private appStateSubscription: { remove(): void } | undefined

  private stopped = true
  private authenticated = false
  private attempt = 0
  private cursor = 0
  private heartbeatMs = 25_000
  private lastActivityAt = 0
  private endpoint: string | undefined
  private lastError: string | undefined
  private hint: string | undefined
  private fatal = false
  private snapshotValue: LinkSnapshot

  constructor(options: AssistantLinkOptions) {
    this.options = options
    this.assistant = options.assistant
    this.identity = options.identity
    this.pairSecret = options.pairSecret
    this.snapshotValue = {
      status: 'idle',
      attempt: 0,
      online: false,
      heartbeatMs: this.heartbeatMs,
    }
  }

  get snapshot(): LinkSnapshot {
    return this.snapshotValue
  }

  get isOnline(): boolean {
    return this.snapshotValue.status === 'online'
  }

  setAssistant(assistant: AssistantRecord): void {
    this.assistant = assistant
  }

  setPairSecret(secret: string | undefined): void {
    this.pairSecret = secret
  }

  start(): void {
    this.stopped = false
    this.fatal = false
    this.attempt = 0
    this.cursor = 0
    this.attachAppState()
    this.open()
  }

  stop(reason = '已断开'): void {
    this.stopped = true
    this.detachAppState()
    this.clearTimers()
    const socket = this.socket
    this.socket = undefined
    this.authenticated = false
    if (socket) {
      try {
        socket.close(1000, reason)
      } catch {
        // 已经关掉的 socket 再关一次不该抛
      }
    }
    this.setStatus({ status: 'idle', online: false, endpoint: this.endpoint })
  }

  /** App 回到前台或用户点“重连”：立刻重试，不等退避。 */
  retryNow(): void {
    if (this.stopped) {
      this.start()
      return
    }
    this.fatal = false
    this.hint = undefined
    this.attempt = 0
    this.clearTimers()
    this.open()
  }

  send(frame: ClientFrame): boolean {
    if (!isOpen(this.socket)) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.log(`send failed: ${(error as Error).message}`)
      return false
    }
  }

  sendChat(input: { rid: string; text: string; files?: Array<{ name: string; mime: string; dataBase64: string }> }): boolean {
    return this.send({
      t: 'chat/send',
      rid: input.rid,
      // 电脑端取的是 callId，回落到 rid；两个都发，两边实现都不吃亏。
      callId: input.rid,
      text: input.text,
      files: input.files,
    })
  }

  cancelChat(callId: string): boolean {
    return this.send({ t: 'chat/cancel', callId })
  }

  fetchFile(fileId: string): boolean {
    return this.send({ t: 'file/fetch', fileId })
  }

  cancelFile(fileId: string): boolean {
    return this.send({ t: 'file/cancel', fileId })
  }

  renameAssistant(label: string): boolean {
    return this.send({ t: 'assistant/rename', label })
  }

  /** 设置「我在这台电脑上的昵称」，电脑端用它做多人协作的消息前缀。 */
  renameDevice(label: string): boolean {
    return this.send({ t: 'device/rename', label })
  }

  requestPower(action: PowerAction, delaySeconds?: number, rid = randomRequestId('pw')): { sent: boolean; rid: string } {
    const frame = buildPowerRequest(action, rid, delaySeconds)
    return { sent: this.send(frame), rid }
  }

  forgetDevice(): boolean {
    return this.send({ t: 'device/forget', deviceId: this.identity.deviceId })
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private open(): void {
    if (this.stopped) return
    this.clearSocket()
    // 常规连接只走公网隧道；局域网与 USB 通道由设置里的「高级连接方式」显式开启。
    const policy = getConnectionPolicy()
    const ladder = endpointLadder(this.assistant.endpoints, this.assistant.preferredEndpoint, {
      allowLan: policy.allowLan,
      allowUsb: policy.allowUsb,
    })
    if (ladder.length === 0) {
      // 打开全部开关后还有地址 → 说明只是被「高级连接方式」挡住了，给可操作的提示。
      const availableIfAdvancedOn =
        endpointLadder(this.assistant.endpoints, undefined, { allowLan: true, allowUsb: true }).length > 0
      this.fail(
        '没有可用的连接地址。常规连接需要公网隧道（https）；' +
          (availableIfAdvancedOn
            ? '当前只有局域网/USB 地址，请到「设置 → 高级连接方式」里开启对应开关。'
            : '请重新扫描电脑上的二维码。'),
      )
      return
    }
    /**
     * 「粘住」策略：优先一直用上次成功的地址，只有它连续失败到阈值才换下一个。
     *
     * 旧实现是 `ladder[this.cursor % ladder.length]` 无条件轮换，问题很致命：
     * 在「局域网不可达、只有 USB 回环可用」的网络里（校园网/宿舍网客户端隔离），
     * 轮到可用地址时刚握上手，cursor 就前进了，下一次又被切到不可达的地址，
     * 连接被拆掉、退避、再轮回——手机端永远停在「正在连接」，
     * 连 hello 认证帧都发不出去，消息全部积压在待发队列里。
     *
     * 现在的规则：
     *   - 有 preferredEndpoint 且**仍在允许的阶梯里**、失败次数未达阈值 → 一直用它；
     *   - 否则 cursor 前进，尝试下一个地址；
     *   - 一旦某个地址握手成功，onHelloAck 会把它写成 preferredEndpoint 并清零计数。
     *
     * 注意 `ladder.includes` 这一步不能省：关掉 USB 开关后，
     * preferredEndpoint 可能还停在 `http://127.0.0.1:19387` 上，必须让它失效。
     */
    const sticky = this.assistant.preferredEndpoint
    let endpoint: string
    if (sticky && ladder.includes(sticky) && this.attempt < ENDPOINT_SWITCH_AFTER) {
      endpoint = sticky
    } else {
      endpoint = ladder[this.cursor % ladder.length] as string
      this.cursor += 1
    }
    const url = wsUrlFor(endpoint)
    if (!url) {
      this.lastError = `地址格式不正确：${endpoint}`
      this.nextAttempt()
      return
    }
    this.endpoint = endpoint
    this.setStatus({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      online: false,
      endpoint,
      attempt: this.attempt,
      lastError: this.lastError,
    })

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.lastError = `无法建立连接：${(error as Error).message}`
      this.nextAttempt()
      return
    }
    this.socket = socket
    socket.onopen = () => this.onOpen()
    socket.onmessage = (event: { data: unknown }) => this.onMessage(event.data)
    socket.onerror = () => {
      // onerror 之后通常紧跟 onclose，这里只记原因，避免重复调度重连。
      this.lastError = this.lastError ?? '连接出错'
    }
    socket.onclose = () => this.onClose(socket)
  }

  private onOpen(): void {
    this.authenticated = false
    this.setStatus({ status: 'handshaking', online: false, endpoint: this.endpoint, attempt: this.attempt })
    const nonce = randomNonce()
    const pairing = this.pairSecret !== undefined
    try {
      const frame = buildHelloFrame({
        deviceId: this.identity.deviceId,
        deviceName: this.identity.deviceName,
        devicePublicKey: this.identity.publicKeySpki,
        nonce,
        pairSecret: this.pairSecret,
        // 只有已绑定设备才需要证明“我持有这把私钥”。
        signature: pairing ? undefined : signMessage(this.identity.seed, helloSignatureMessage(nonce)),
      })
      this.send(frame)
    } catch (error) {
      this.fail(`握手数据有误：${(error as Error).message}`)
      return
    }
    this.handshakeTimer = setTimeout(() => {
      this.lastError = '电脑端没有响应握手，请检查手机和电脑是否在同一网络'
      this.closeSocket()
      this.nextAttempt()
    }, HANDSHAKE_TIMEOUT_MS)
  }

  private onMessage(data: unknown): void {
    this.lastActivityAt = Date.now()
    let frame: ServerFrame & { code?: string; message?: string }
    try {
      frame = JSON.parse(String(data)) as ServerFrame
    } catch {
      this.log('收到无法解析的帧，已忽略')
      return
    }
    if (!frame || typeof frame.t !== 'string') return

    if (frame.t === 'hello/ack') {
      this.onHelloAck(frame as HelloAckFrame)
      return
    }
    if (frame.t === 'error') {
      const code = typeof frame.code === 'string' ? frame.code : 'error'
      const hint = handshakeErrorHint(code, frame.message)
      if (!this.authenticated) {
        if (FATAL_ERROR_CODES.has(code)) {
          this.fail(hint)
          return
        }
        // 非致命（例如暂时握手顺序问题）：记录下来，继续按退避重试。
        this.lastError = hint
        this.closeSocket()
        this.nextAttempt()
        return
      }
      this.options.onFrame(frame)
      return
    }
    if (!this.authenticated) {
      // 认证前的其他帧一律不信任（协议要求拒绝没有 hello 的流量）。
      this.log(`握手前收到 ${frame.t}，已忽略`)
      return
    }
    this.options.onFrame(frame)
  }

  private onHelloAck(ack: HelloAckFrame): void {
    const pairing = this.pairSecret !== undefined
    const outcome = interpretHelloAck(
      ack,
      {
        computerId: this.assistant.computerId,
        fingerprint: this.assistant.fingerprint,
        pairing,
      },
      Date.now(),
    )
    if (!outcome.ok) {
      // 指纹不一致属于安全问题：不重试，直接把话说明白。
      this.fail(outcome.message)
      return
    }
    this.clearHandshakeTimer()
    this.authenticated = true
    this.attempt = 0
    this.hint = undefined
    this.lastError = undefined
    this.heartbeatMs = outcome.heartbeatMs
    this.lastActivityAt = Date.now()
    if (this.endpoint) this.assistant = { ...this.assistant, preferredEndpoint: this.endpoint }
    if (outcome.endpoints.length > 0) {
      /**
       * 电脑端通告的地址与本地库取并集：隧道域名可能变了，也可能新增了局域网地址。
       *
       * 但**当前这个已经握手成功的地址必须留在首位**。旧实现是
       * `[...outcome.endpoints, ...this.assistant.endpoints]`，让电脑端通告的顺序说了算；
       * 于是刚用 USB 回环连上，电脑端一回 `hello/ack`，
       * `http://10.17.134.19:8787` 这种不可达的局域网地址又被排到最前面，
       * 下一轮重连立刻被切走——这正是「连上就掉、永远发不出 hello」的直接原因。
       */
      const connected = this.endpoint
      const merged = Array.from(
        new Set([...(connected ? [connected] : []), ...outcome.endpoints, ...this.assistant.endpoints]),
      )
      this.assistant = { ...this.assistant, endpoints: merged }
    }
    this.setStatus({
      status: 'online',
      online: true,
      endpoint: this.endpoint,
      attempt: 0,
      serverVersion: ack.version,
      connectedAt: Date.now(),
      heartbeatMs: this.heartbeatMs,
    })
    this.startHeartbeat(this.heartbeatMs)
    this.options.onHelloAck?.(ack, pairing)
  }

  private onClose(socket?: WebSocket): void {
    /**
     * 只处理"当前这条" socket 的关闭。
     *
     * 传进来的 socket 已经不是 `this.socket`，说明它是一条被替换掉的旧连接，
     * 它的关闭事件属于我们自己主动关闭的副作用，**不能再调度重连**——
     * 否则会和当前连接形成互相踢的死循环（详见 closeSocket 的注释）。
     */
    if (socket && socket !== this.socket) return
    this.clearHandshakeTimer()
    this.clearHeartbeat()
    const wasAuthenticated = this.authenticated
    this.authenticated = false
    this.socket = undefined
    if (this.stopped) return
    if (wasAuthenticated) {
      this.lastError = this.lastError ?? '连接已断开'
      this.setStatus({ status: 'reconnecting', online: false, endpoint: this.endpoint, attempt: this.attempt, lastError: this.lastError })
    }
    this.nextAttempt()
  }

  private nextAttempt(): void {
    if (this.stopped || this.fatal) return
    const attempt = this.attempt
    this.attempt += 1
    if (!isRetryAllowed(attempt, this.options.maxAttempts ?? 12)) {
      this.setStatus({
        status: 'failed',
        online: false,
        endpoint: this.endpoint,
        attempt: this.attempt,
        lastError: this.lastError,
        hint: '自动重连已停止。请检查网络后点“重连”，或在电脑上重新生成二维码。',
      })
      return
    }
    const delay = nextBackoffMs(attempt)
    this.setStatus({
      status: 'reconnecting',
      online: false,
      endpoint: this.endpoint,
      attempt: this.attempt,
      lastError: this.lastError,
    })
    this.log(`将在 ${Math.round(delay / 1000)}s 后重连（第 ${attempt + 1} 次）`)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  private fail(message: string, hint?: string): void {
    this.fatal = true
    this.hint = hint
    this.clearTimers()
    this.closeSocket()
    this.setStatus({
      status: 'failed',
      online: false,
      endpoint: this.endpoint,
      attempt: this.attempt,
      lastError: message,
      fatal: true,
      hint: hint ?? '需要在电脑上解除绑定后重新扫描二维码。',
    })
  }

  private startHeartbeat(ms: number): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!isOpen(this.socket)) return
      // 电脑端静默超过 2.5 个心跳周期（协议说 3x 视为失联）就主动重连，
      // 否则半死的 TCP 连接会一直假装在线。
      if (Date.now() - this.lastActivityAt > ms * 2.5) {
        this.lastError = '心跳超时'
        this.log('心跳超时，主动重连')
        this.closeSocket()
        this.nextAttempt()
        return
      }
      this.send({ t: 'ping' })
    }, ms)
  }

  private attachAppState(): void {
    const appState = this.options.appState ?? AppState
    this.appStateSubscription = appState.addEventListener('change', next => {
      // 回到前台立刻重试：退避计时器在后台可能已经被系统节流甚至冻结。
      if (next === 'active' && !this.isOnline) this.retryNow()
    })
  }

  private detachAppState(): void {
    this.appStateSubscription?.remove()
    this.appStateSubscription = undefined
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    /**
     * 关键：**先把所有回调摘掉，再 close()**。
     *
     * 踩过的坑：以前只把 `this.socket` 置空就 close，而 `socket.onclose` 仍指向
     * `this.onClose()`。RN 的 WebSocket 关闭是异步的，于是这里刚关掉旧连接、
     * 那边 `onclose` 迟到触发 → `onClose()` → `nextAttempt()` → 又开一条新连接。
     *
     * 更糟的是电脑端（gateway.mjs）在收到新连接认证后会主动踢掉旧连接
     * （`previous.close(1000, 'replaced by a newer connection')`），
     * 于是两条 socket 互相踢：新连接的 onclose 又触发重连，
     * 表现为**每 1 秒重连一次、界面永远在「正在连接」**。
     *
     * 摘掉回调后，我们自己发起的关闭不会再被当成"意外断线"。
     */
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(4000, 'client reconnect')
    } catch {
      // ignore
    }
  }

  private clearSocket(): void {
    this.clearHandshakeTimer()
    this.clearHeartbeat()
    this.clearReconnect()
    this.closeSocket()
  }

  private clearTimers(): void {
    this.clearHandshakeTimer()
    this.clearHeartbeat()
    this.clearReconnect()
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private setStatus(patch: Partial<LinkSnapshot> & { status: LinkStatus }): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      online: patch.status === 'online',
      attempt: this.attempt,
      heartbeatMs: this.heartbeatMs,
      ...patch,
    }
    this.options.onStatus(this.snapshotValue)
  }

  private log(message: string): void {
    this.options.log?.(`[link ${this.assistant.id}] ${message}`)
  }
}
