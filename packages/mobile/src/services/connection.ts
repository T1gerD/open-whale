// 与一台电脑的 WebSocket 连接：握手、竞速、心跳、退避重连、地址轮换。
//
// 这里只做“传输与生命周期”，业务判定全部下沉到 core/ 的纯逻辑：
//  * 握手是否成功 → `interpretHelloAck`；
//  * 重连等待多久 → `nextBackoffMs`；
//  * 地址阶梯 → `endpointLadder`（内部委托协议的排序规则）；
//  * 这一轮试哪两个地址、失败文案 → `planRace` / `failureReport`。
// 这样才能在电脑上（无 Android SDK）把最关键的行为测掉。
//
// v2.2.0 的连接策略：
//  1. 每次建连**并发竞速前两个候选**，谁先完成 hello/ack 用谁，另一个立即关闭；
//  2. 上次成功的地址优先（连续失败 3 轮后才轮换）；
//  3. hello 带上 capabilities / cursor / sessionId，电脑端据此回放会话事件；
//  4. 连续失败到上限时给出可操作文案（已尝试地址 + 换连接方式/重新扫码/手动输入）。

import { AppState, type AppStateStatus } from 'react-native'

import { isRetryAllowed, nextBackoffMs } from '../core/backoff.mts'
import { failureReport, onRaceFailed, onRaceWon, planRace, createRetryState, type RetryState } from '../core/connection-plan.mts'
import { getConnectionPolicy } from '../core/connection-policy.mts'
import { endpointKind, endpointLadder, missingModeHint, wsUrlFor } from '../core/endpoint.mts'
import { ALL_CAPABILITIES } from '../core/frames.mts'
import { buildHelloFrame, handshakeErrorHint, helloSignatureMessage, interpretHelloAck } from '../core/pairing.mts'
import type { AssistantRecord } from '../core/pairing.mts'
import { buildPowerRequest, type PowerAction } from '../core/power.mts'
import { RaceTracker, type CloseInfo, type CloseVerdict } from '../core/race-state.mts'
import type { ChatSendFile, ClientFrame, HelloAckFrame, LinkSnapshot, LinkStatus, ServerFrame } from '../protocol/types'

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
  /** 握手通过（pairing=true 表示这是首次绑定成功的一刻）。 */
  onHelloAck?(ack: HelloAckFrame, pairing: boolean): void
  log?(message: string): void
  maxAttempts?: number
  /** 便于测试注入 AppState；默认用 react-native 的。 */
  appState?: { currentState: AppStateStatus; addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void } }
  /** 竞速并发数（默认 2，协议要求前两个候选）。 */
  raceCandidates?: number
}

/** 电脑端等 hello 的上限是 10s，本地留一点余量让它的 error 帧先到。 */
const HANDSHAKE_TIMEOUT_MS = 12_000

/** 这些错误重试也没用：密钥不对、电脑端已绑定别的手机等必须人工介入。 */
const FATAL_ERROR_CODES = new Set([
  'bad-signature',
  'already-paired',
  'pairing-rejected',
  'bad-device-id',
  'bad-device-key',
  'not-authenticated',
])

function readyStateOpen(socket: WebSocket | undefined): socket is WebSocket {
  // RN 的 WebSocket 有 readyState；1 === OPEN
  return socket !== undefined && socket.readyState === 1
}

/** 一轮竞速里的单个候选地址。 */
interface RaceAttempt {
  /** 本轮内的唯一 id（close/error 回调靠它判断是不是当前胜出者）。 */
  id: number
  endpoint: string
  url: string
  socket: WebSocket
  timer: ReturnType<typeof setTimeout> | undefined
  phase: 'connecting' | 'handshaking' | 'failed'
  /** 该候选自己的 lastError（只用于日志/失败文案）。 */
  error?: string
  /** 握手判定只认这条连接回来的 ack。 */
  ack: HelloAckFrame | undefined
  outcome: ReturnType<typeof interpretHelloAck> | undefined
}

export class AssistantLink {
  private readonly options: AssistantLinkOptions
  private assistant: AssistantRecord
  private identity: LinkIdentity
  private pairSecret: string | undefined

  private socket: WebSocket | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private roundTimer: ReturnType<typeof setTimeout> | undefined
  private appStateSubscription: { remove(): void } | undefined

  private stopped = true
  private authenticated = false
  private attempt = 0
  /** 会话游标：hello 带上去做断点续传。 */
  private cursor = 0
  private sessionId: string | undefined
  private heartbeatMs = 25_000
  private lastActivityAt = 0
  private endpoint: string | undefined
  private lastError: string | undefined
  private hint: string | undefined
  private fatal = false
  private capabilities: string[] = []
  private retryState: RetryState = createRetryState()
  /**
   * 竞速记账器：'谁先 ack 算赢' / '旧轮次与落选者的迟到 close 一律忽略' /
   * '刚连上就被电脑端踢掉时用抖动退避而不是 1s 死循环'。纯逻辑，见 core/race-state.mts。
   */
  private readonly race = new RaceTracker()
  private generation = 0
  private raceAttempts: RaceAttempt[] = []
  private winner: RaceAttempt | undefined
  private snapshotValue: LinkSnapshot

  constructor(options: AssistantLinkOptions) {
    this.options = options
    this.assistant = options.assistant
    this.identity = options.identity
    this.pairSecret = options.pairSecret
    this.cursor = options.assistant.sessionCursor ?? 0
    this.sessionId = options.assistant.sessionId
    this.retryState = createRetryState(options.assistant.preferredEndpoint)
    this.snapshotValue = {
      status: 'idle',
      attempt: 0,
      online: false,
      heartbeatMs: this.heartbeatMs,
      capabilities: [],
    }
  }

  get snapshot(): LinkSnapshot {
    return this.snapshotValue
  }

  get isOnline(): boolean {
    return this.snapshotValue.status === 'online'
  }

  /** 电脑端声明的能力（hello/ack 后）。 */
  hasCapability(capability: string): boolean {
    return this.capabilities.includes(capability)
  }

  get capabilityList(): string[] {
    return this.capabilities
  }

  setAssistant(assistant: AssistantRecord): void {
    this.assistant = assistant
    // 电脑端/设置改过 endpoint 或会话信息时同步，下一次 hello 直接用新值。
    this.cursor = assistant.sessionCursor ?? this.cursor
    this.sessionId = assistant.sessionId ?? this.sessionId
    this.retryState = { ...this.retryState, preferred: assistant.preferredEndpoint }
    if (this.stopped) this.snapshotValue = { ...this.snapshotValue, capabilities: this.capabilities }
  }

  setPairSecret(secret: string | undefined): void {
    this.pairSecret = secret
  }

  /** 会话游标前进后同步给 link，下一次 hello 带上的就是最新 cursor（断点续传）。 */
  setSessionCursor(cursor: number, sessionId?: string): void {
    if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0) this.cursor = Math.floor(cursor)
    if (typeof sessionId === 'string' && sessionId !== '') this.sessionId = sessionId
  }

  /** 手动改过 endpoints 后立刻用新列表重连。 */
  start(): void {
    this.stopped = false
    this.fatal = false
    this.attempt = 0
    this.retryState = createRetryState(this.assistant.preferredEndpoint)
    this.attachAppState()
    this.open()
  }

  stop(reason = '已断开'): void {
    this.stopped = true
    this.detachAppState()
    this.clearTimers()
    this.closeRace()
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
    this.closeRace()
    this.open()
  }

  send(frame: ClientFrame): boolean {
    if (!readyStateOpen(this.socket)) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.log(`send failed: ${(error as Error).message}`)
      return false
    }
  }

  sendChat(input: {
    rid: string
    msgId?: string
    text: string
    speaker?: string
    files?: ChatSendFile[]
  }): boolean {
    return this.send({
      t: 'chat/send',
      rid: input.rid,
      // msgId = rid（幂等键）；老电脑端缺省回落到 rid/callId，两个都发最稳。
      msgId: input.msgId ?? input.rid,
      callId: input.rid,
      text: input.text,
      speaker: input.speaker,
      files: input.files,
    })
  }

  /** 请求补发会话事件（cursor=0 表示要快照）。 */
  sendSessionSync(cursor?: number): boolean {
    return this.send({ t: 'session/sync', cursor: cursor ?? this.cursor })
  }

  setCollaboration(on: boolean, rid = randomRequestId('collab')): boolean {
    return this.send({ t: 'collab/set', rid, on })
  }

  sendUploadStart(input: { uploadId: string; name: string; size: number; mime?: string }): boolean {
    return this.send({ t: 'upload/start', uploadId: input.uploadId, name: input.name, size: input.size, mime: input.mime })
  }

  sendUploadChunk(input: { uploadId: string; seq: number; dataBase64: string }): boolean {
    return this.send({ t: 'upload/chunk', uploadId: input.uploadId, seq: input.seq, dataBase64: input.dataBase64 })
  }

  sendUploadEnd(uploadId: string): boolean {
    return this.send({ t: 'upload/end', uploadId })
  }

  sendUploadCancel(uploadId: string): boolean {
    return this.send({ t: 'upload/cancel', uploadId })
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
  // 建连（竞速）
  // ---------------------------------------------------------------------------

  private open(): void {
    if (this.stopped) return
    this.clearRoundTimer()
    this.closeRace()
    const policy = getConnectionPolicy()
    const mode = this.assistant.connectionMode
    const ladder = endpointLadder(this.assistant.endpoints, this.assistant.preferredEndpoint, {
      mode,
      allowUsb: policy.allowUsb,
    })
    if (ladder.length === 0) {
      // 显式连接方式下没有对应类型的地址：给可操作提示，而不是让用户干等。
      const modeHint = missingModeHint(mode, this.assistant.endpoints)
      this.fail(
        modeHint ?? '没有可用的连接地址，请在电脑端重新生成二维码，或在设置里手动输入电脑地址。',
        '可以换一种连接方式、重新扫码，或手动输入电脑地址。',
      )
      return
    }
    const plan = planRace(ladder, this.retryState, { candidates: this.options.raceCandidates ?? 2 })
    this.retryState = plan.state
    if (plan.endpoints.length === 0) {
      this.nextAttempt()
      return
    }
    // 开新一轮：generation 变化后，上一轮所有 socket 的迟到事件都会被 race tracker 判 stale。
    const round = this.race.beginRound(plan.endpoints)
    const generation = round.generation
    this.generation = generation
    this.setStatus({
      status: this.attempt === 0 ? 'connecting' : 'reconnecting',
      online: false,
      endpoint: plan.endpoints[0],
      attempt: this.attempt,
      lastError: this.lastError,
      triedEndpoints: this.retryState.tried,
    })
    // 一轮竞速的安全网：最长等一轮握手超时 + 2s；到点还没赢家就整轮判失败。
    this.roundTimer = setTimeout(() => {
      if (this.stopped || generation !== this.generation || this.winner) return
      this.log('竞速轮超时')
      for (const attempt of this.raceAttempts) attempt.error = attempt.error ?? '握手超时'
      this.failRound()
    }, HANDSHAKE_TIMEOUT_MS + 2_000)
    for (const meta of round.attempts) this.startAttempt(meta.endpoint, generation, meta.id)
  }

  private startAttempt(endpoint: string, generation: number, attemptId: number): void {
    const url = wsUrlFor(endpoint)
    if (!url) {
      this.log(`地址格式不正确：${endpoint}`)
      this.registerFailedAttempt(endpoint, attemptId, '地址格式不正确')
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.log(`无法建立连接：${(error as Error).message}`)
      this.registerFailedAttempt(endpoint, attemptId, `无法建立连接：${(error as Error).message}`)
      return
    }
    const attempt: RaceAttempt = {
      id: attemptId,
      endpoint,
      url,
      socket,
      timer: undefined,
      phase: 'connecting',
      error: undefined,
      ack: undefined,
      outcome: undefined,
    }
    this.raceAttempts.push(attempt)
    attempt.timer = setTimeout(() => {
      if (this.winner === attempt || !this.race.isCurrent(generation)) return
      attempt.error = '握手超时'
      this.closeAttempt(attempt)
      this.maybeFailRound()
    }, HANDSHAKE_TIMEOUT_MS)
    socket.onopen = () => this.onAttemptOpen(attempt, generation)
    socket.onmessage = (event: { data: unknown }) => this.onAttemptMessage(attempt, generation, event?.data)
    socket.onerror = () => {
      // onerror 之后通常紧跟 onclose，这里只记原因，避免重复调度重连。
      attempt.error = attempt.error ?? '连接出错'
    }
    socket.onclose = (event?: CloseInfo) => this.onAttemptClose(attempt, generation, event ?? {})
  }

  /** 某个候选在建立 socket 之前就失败了（地址非法/构造函数抛错）：登记成失败候选。 */
  private registerFailedAttempt(endpoint: string, attemptId: number, reason: string): void {
    const attempt: RaceAttempt = {
      id: attemptId,
      endpoint,
      url: '',
      // 没有 socket：closeAttempt/closeSocketQuiet 都能容忍 undefined。
      socket: undefined as unknown as WebSocket,
      timer: undefined,
      phase: 'failed',
      error: reason,
      ack: undefined,
      outcome: undefined,
    }
    this.raceAttempts.push(attempt)
    this.maybeFailRound()
  }

  private onAttemptOpen(attempt: RaceAttempt, generation: number): void {
    if (this.stopped || !this.race.isCurrent(generation) || this.winner) {
      this.closeAttempt(attempt)
      return
    }
    attempt.phase = 'handshaking'
    this.setStatus({ status: 'handshaking', online: false, endpoint: attempt.endpoint, attempt: this.attempt })
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
        // v2.2.0：能力 + 游标 + 会话，电脑端据此决定回放/快照与是否发新帧。
        capabilities: [...ALL_CAPABILITIES],
        cursor: this.cursor,
        sessionId: this.sessionId,
      })
      this.sendOn(attempt.socket, frame)
    } catch (error) {
      attempt.error = `握手数据有误：${(error as Error).message}`
      this.closeAttempt(attempt)
      this.maybeFailRound()
    }
  }

  private onAttemptMessage(attempt: RaceAttempt, generation: number, data: unknown): void {
    this.lastActivityAt = Date.now()
    // 旧轮次 / 已被替换掉的 socket 的迟到帧一律丢弃（竞速期会有两条同时活跃）。
    if (!this.race.isCurrent(generation)) return
    let frame: ServerFrame & { code?: string; message?: string }
    try {
      frame = JSON.parse(String(data)) as ServerFrame & { code?: string; message?: string }
    } catch {
      this.log('收到无法解析的帧，已忽略')
      return
    }
    if (!frame || typeof frame.t !== 'string') return

    if (frame.t === 'hello/ack') {
      this.onAttemptAck(attempt, frame as HelloAckFrame)
      return
    }
    if (this.winner === attempt && this.authenticated) {
      // 已经赢了：后面的业务帧直接交给 store。
      this.options.onFrame(frame)
      return
    }
    if (frame.t === 'error') {
      const code = typeof frame.code === 'string' ? frame.code : 'error'
      const hint = handshakeErrorHint(code, frame.message)
      if (FATAL_ERROR_CODES.has(code)) {
        this.fail(hint)
        return
      }
      attempt.error = hint
      this.closeAttempt(attempt)
      this.maybeFailRound()
      return
    }
    // 认证前的其他帧一律不信任（协议要求拒绝没有 hello 的流量）。
    this.log(`握手前收到 ${frame.t}，已忽略`)
  }

  private onAttemptAck(attempt: RaceAttempt, ack: HelloAckFrame): void {
    // 竞速判定在纯逻辑里：同一轮只有第一个通过校验的 ack 能赢；
    // 落选者即使晚到 ack（甚至服务端也把它认证了）也不能覆盖当前胜出连接。
    const verdict = this.race.markAck(this.generation, attempt.id)
    if (verdict !== 'won') {
      this.closeAttempt(attempt)
      return
    }
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
    this.adoptWinner(attempt, ack, outcome, pairing)
  }

  /** 握手成功：关掉其它候选，正式接管这条连接。 */
  private adoptWinner(
    attempt: RaceAttempt,
    ack: HelloAckFrame,
    outcome: Extract<ReturnType<typeof interpretHelloAck>, { ok: true }>,
    pairing: boolean,
  ): void {
    this.winner = attempt
    this.race.adopt(this.generation, attempt.id, Date.now())
    this.clearRoundTimer()
    for (const other of this.raceAttempts) if (other !== attempt) this.closeAttempt(other)
    this.closeAttemptTimer(attempt)
    this.authenticated = true
    this.socket = attempt.socket
    this.endpoint = attempt.endpoint
    this.attempt = 0
    this.hint = undefined
    this.lastError = undefined
    this.heartbeatMs = outcome.heartbeatMs
    this.lastActivityAt = Date.now()
    this.capabilities = outcome.capabilities
    this.retryState = onRaceWon(this.retryState, attempt.endpoint)
    if (outcome.sessionId) this.sessionId = outcome.sessionId
    this.cursor = outcome.eventCursor ?? this.cursor
    if (this.endpoint) this.assistant = { ...this.assistant, preferredEndpoint: this.endpoint }
    if (outcome.endpoints.length > 0) {
      /**
       * 电脑端通告的地址与本地库取并集：隧道域名可能变了，也可能新增了局域网地址。
       * 但**当前这个已经握手成功的地址必须留在首位**——否则下一轮重连又被切到
       * 不可达的地址（v2.1.0 的「连上就掉」根因之一）。
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
      endpointKind: this.endpoint ? endpointKind(this.endpoint) : undefined,
      attempt: 0,
      // 展示的是插件版本（serverVersion），不是协议版本（version=1.1.0）。
      serverVersion: ack.serverVersion ?? ack.version,
      connectedAt: Date.now(),
      heartbeatMs: this.heartbeatMs,
      triedEndpoints: [],
      capabilities: this.capabilities,
      sessionId: outcome.sessionId ?? this.sessionId,
      sessionEpoch: outcome.sessionEpoch,
      eventCursor: outcome.eventCursor,
      collaboration: outcome.collaboration,
      serverConnectionMode: outcome.connectionMode,
      lastError: undefined,
      fatal: false,
      hint: undefined,
    })
    this.startHeartbeat(this.heartbeatMs)
    this.options.onHelloAck?.(ack, pairing)
  }

  /**
   * 任意候选 socket 关闭。所有判定交给 pure logic（core/race-state.mts）：
   *  - 旧轮次/落选者：忽略（落选者在本轮还没定胜负时记失败，触发整轮失败）；
   *  - 胜出者：区分「正常掉线」(reconnect)、「刚连上就断/被电脑端替换」(flap 退避)、
   *    以及抖动到上限的 fail（给可操作文案，不再 1 秒一轮空转）。
   */
  private onAttemptClose(attempt: RaceAttempt, generation: number, close: CloseInfo): void {
    if (this.stopped) return
    const decision = this.race.resolveClose(generation, attempt.id, close, Date.now(), this.lastError)
    if (decision.kind === 'stale') {
      this.log(`忽略旧轮次连接关闭（${attempt.endpoint}）`)
      return
    }
    if (decision.kind === 'loser') {
      if (this.race.isCurrent(generation) && attempt.phase !== 'failed') {
        attempt.phase = 'failed'
        attempt.error = attempt.error ?? '连接关闭'
        this.maybeFailRound()
      }
      return
    }
    // 胜出者断开（先清掉引用，避免后续回调重复处理）。
    this.clearHeartbeat()
    this.authenticated = false
    this.socket = undefined
    this.winner = undefined
    this.raceAttempts = []
    if (decision.kind === 'reconnect') {
      this.lastError = decision.lastError
      this.setStatus({
        status: 'reconnecting',
        online: false,
        endpoint: attempt.endpoint,
        attempt: this.attempt,
        lastError: this.lastError,
        capabilities: this.capabilities,
      })
      this.nextAttempt()
      return
    }
    if (decision.kind === 'flap') {
      this.lastError = decision.lastError
      this.log(`连接抖动第 ${decision.flapCount} 次，退避 ${decision.backoffAttempt} 档`)
      this.setStatus({
        status: 'reconnecting',
        online: false,
        endpoint: attempt.endpoint,
        attempt: decision.backoffAttempt,
        lastError: decision.lastError,
        hint: decision.hint,
        capabilities: this.capabilities,
      })
      // 用抖动次数当退避指数：2s→4s→8s→16s，避免 1 秒重连死循环。
      this.nextAttempt(decision.backoffAttempt)
      return
    }
    // decision.kind === 'fail'：连续抖动到上限，停止自动重连并给可操作文案。
    this.fail(decision.lastError, decision.hint)
  }

  /** 所有候选都失败：记一轮失败，进入退避。 */
  private failRound(): void {
    if (this.stopped || this.winner) return
    const endpoints = this.raceAttempts.map(attempt => attempt.endpoint)
    const firstError = this.raceAttempts.find(attempt => attempt.error)?.error
    this.closeRace()
    this.retryState = onRaceFailed(this.retryState, endpoints)
    if (firstError) this.lastError = firstError
    this.nextAttempt()
  }

  /** 还有候选没结束就继续等；都失败了才整轮失败。 */
  private maybeFailRound(): void {
    if (this.stopped || this.winner) return
    if (this.raceAttempts.every(attempt => attempt.phase === 'failed')) this.failRound()
  }

  /**
   * 安排下一次重连。
   * @param baseAttempt 覆盖退避指数（刚连上就被替换的抖动场景传 flap 次数）；
   *                    不传就按普通连续失败次数递增。
   */
  private nextAttempt(baseAttempt?: number): void {
    if (this.stopped || this.fatal) return
    const attempt = baseAttempt !== undefined ? Math.max(0, Math.floor(baseAttempt)) : this.attempt
    this.attempt = attempt + 1
    const maxAttempts = this.options.maxAttempts ?? 12
    if (!isRetryAllowed(attempt, maxAttempts)) {
      const report = failureReport(this.retryState, {
        mode: this.assistant.connectionMode,
        maxAttempts,
      })
      this.setStatus({
        status: 'failed',
        online: false,
        endpoint: this.endpoint,
        attempt: this.attempt,
        lastError: report.message,
        hint: report.hint,
        triedEndpoints: report.triedEndpoints,
        capabilities: this.capabilities,
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
      triedEndpoints: this.retryState.tried,
      capabilities: this.capabilities,
    })
    this.log(`将在 ${Math.round(delay / 1000)}s 后重连（第 ${attempt + 1} 次）`)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  private fail(message: string, hint?: string): void {
    this.fatal = true
    this.hint = hint
    this.clearTimers()
    this.closeRace()
    const socket = this.socket
    this.socket = undefined
    this.authenticated = false
    if (socket) this.closeSocketQuiet(socket)
    this.setStatus({
      status: 'failed',
      online: false,
      endpoint: this.endpoint,
      attempt: this.attempt,
      lastError: message,
      fatal: true,
      hint: hint ?? '需要在电脑上解除绑定后重新扫描二维码。',
      triedEndpoints: this.retryState.tried,
      capabilities: this.capabilities,
    })
  }

  private startHeartbeat(ms: number): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!readyStateOpen(this.socket)) return
      // 电脑端静默超过 2.5 个心跳周期（协议说 3x 视为失联）就主动重连，
      // 否则半死的 TCP 连接会一直假装在线。
      if (Date.now() - this.lastActivityAt > ms * 2.5) {
        this.lastError = '心跳超时'
        this.log('心跳超时，主动重连')
        this.dropCurrentSocket()
        this.nextAttempt()
        return
      }
      this.send({ t: 'ping' })
    }, ms)
  }

  /** 心跳超时：主动关掉当前连接并进入重连（不能走 onWinnerClosed，那条路径已没 socket）。 */
  private dropCurrentSocket(): void {
    const socket = this.socket
    this.socket = undefined
    this.authenticated = false
    this.winner = undefined
    this.clearHeartbeat()
    if (socket) this.closeSocketQuiet(socket)
    this.setStatus({
      status: 'reconnecting',
      online: false,
      endpoint: this.endpoint,
      attempt: this.attempt,
      lastError: this.lastError,
    })
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

  // ---------------------------------------------------------------------------
  // socket 生命周期
  // ---------------------------------------------------------------------------

  private sendOn(socket: WebSocket, frame: ClientFrame): boolean {
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  /** 关闭一个竞速候选（摘回调 → close，避免 onclose 再调度重连）。 */
  private closeAttempt(attempt: RaceAttempt): void {
    this.closeAttemptTimer(attempt)
    if (attempt.phase !== 'failed') attempt.phase = 'failed'
    this.closeSocketQuiet(attempt.socket)
  }

  private closeAttemptTimer(attempt: RaceAttempt): void {
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.timer = undefined
  }

  private closeRace(): void {
    for (const attempt of this.raceAttempts) this.closeAttempt(attempt)
    this.raceAttempts = []
    this.winner = undefined
    this.clearRoundTimer()
  }

  /**
   * 关键：**先把所有回调摘掉，再 close()**。
   *
   * 踩过的坑：RN 的 WebSocket 关闭是异步的，只把 `this.socket` 置空就 close 的话，
   * 迟到的 `onclose` 会再调度一次重连；而电脑端在收到新连接认证后会主动踢掉旧连接
   * （`replaced by a newer connection`），于是两条 socket 互相踢、每 1 秒重连一次。
   * 摘掉回调后，我们自己发起的关闭不会再被当成"意外断线"。
   */
  private closeSocketQuiet(socket: WebSocket | undefined): void {
    if (!socket) return
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

  private clearTimers(): void {
    this.clearHeartbeat()
    this.clearReconnect()
    this.clearRoundTimer()
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private clearRoundTimer(): void {
    if (this.roundTimer) clearTimeout(this.roundTimer)
    this.roundTimer = undefined
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
      capabilities: this.capabilities,
      ...patch,
    }
    this.options.onStatus(this.snapshotValue)
  }

  private log(message: string): void {
    this.options.log?.(`[link ${this.assistant.id}] ${message}`)
  }
}
