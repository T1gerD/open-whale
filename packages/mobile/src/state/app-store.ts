// App 级状态与业务编排（不依赖 React）。
//
// 分层：
//   UI（app/…）→ 这里（把连接、reducer、SQLite、文件服务粘起来）→ core/（纯逻辑）+ services/。
// 组件里**不允许**出现业务规则：发送、重发、接收文件、电源倒计时都在这里。
//
// 分块数据不进 reducer 状态：`Uint8Array` 不该出现在 React 状态树里，所以文件字节
// 留在 `sinkBuffers`，reducer 只管进度、状态与显示文本。

import {
  deleteAssistant as deleteAssistantRow,
  getSetting,
  listAssistants,
  loadMessages,
  loadOutbox,
  loadTransfers,
  renameAssistant as renameAssistantRow,
  saveMessage,
  saveMessages,
  saveOutbox,
  saveTransfer,
  setAssistantOnline,
  setSetting,
  upsertAssistant,
} from '../services/db'
import { base64ToBytes } from '../core/base64.mts'
import {
  CONNECTION_POLICY_KEYS,
  DEFAULT_CONNECTION_POLICY,
  formatPolicyFlag,
  getConnectionPolicy,
  parsePolicyFlag,
  setConnectionPolicy,
  type ConnectionPolicy,
} from '../core/connection-policy.mts'
import { endpointLabel } from '../core/endpoint.mts'
import {
  buildAssistantFromPairing,
  validatePairingQr,
  type AssistantRecord,
  type PairingPayload,
} from '../core/pairing.mts'
import {
  applyPowerState,
  idlePowerState,
  tickPower,
  type PowerAction,
  type PowerState,
} from '../core/power.mts'
import {
  createOutbox,
  deserializeOutbox,
  DEFAULT_MAX_ATTEMPTS,
  enqueue,
  markFailed as markOutboxFailed,
  markInflight,
  markSent as markOutboxSent,
  pendingCount,
  releaseInflight,
  resendableEntries,
  retryEntry,
  type Outbox,
} from '../core/outbox.mts'
import {
  emptyChatState,
  hydrateChat,
  isKnownServerFrame,
  reduceChat,
  type ChatEffect,
  type ChatEvent,
  type ChatMessage,
  type ChatState,
  type Transfer,
} from '../core/reducer.mts'
import { planWake, type WakeSetting } from '../core/wake.mts'
import { pairingDeps } from '../protocol/runtime'
import type { HelloAckFrame, LinkSnapshot, ServerFrame } from '../protocol/types'

import { AssistantLink, type LinkIdentity } from '../services/connection'
import { generateDeviceKeypair, keypairFromSeed, newDeviceId, randomRequestId } from '../services/crypto'
import { defaultDeviceName, loadIdentity, loadSeed, saveIdentity, saveSeed, type DeviceIdentity } from '../services/secure'
import { openWithSystem, writeDownloadedFile } from '../services/transfers'
import { performWake } from '../services/wake'

export interface StoredAssistantRow extends AssistantRecord {
  wakeMac?: string
}

export interface AssistantView {
  assistant: StoredAssistantRow
  link: LinkSnapshot
  chat: ChatState
  power: PowerState
  /** 未确认（待发/失败）的消息条数，列表页用来提示。 */
  pendingMessages: number
  /** 正在下载的文件数。 */
  activeTransfers: number
}

export interface AppSnapshot {
  ready: boolean
  assistants: AssistantView[]
  deviceId?: string
  deviceName?: string
  lastError?: string
  /** 连接策略（高级连接方式 / 内部测试模式）。 */
  connectionPolicy?: ConnectionPolicy
}

export interface PairResult {
  ok: boolean
  assistantId?: string
  error?: string
  hint?: string
}

const OFFLINE_LINK: LinkSnapshot = { status: 'idle', online: false, attempt: 0, heartbeatMs: 25_000 }

/** 每个助理一个：聊天状态 + 离线队列 + 文件组装缓冲。 */
class ChatController {
  readonly assistantId: string
  chat: ChatState
  outbox: Outbox = createOutbox()
  power: PowerState = idlePowerState()

  private readonly store: AppStore
  private link: AssistantLink | undefined
  /** fileId → 已到达的分块（按 seq 顺序 push）。 */
  private sinkBuffers = new Map<string, Uint8Array[]>()
  private pendingWrites = new Map<string, ChatMessage>()
  private persistedTransfers: Record<string, Transfer> = {}
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(store: AppStore, assistantId: string) {
    this.store = store
    this.assistantId = assistantId
    this.chat = emptyChatState(assistantId)
  }

  attach(link: AssistantLink | undefined): void {
    this.link = link
  }

  async load(): Promise<void> {
    const [messages, transfers, outbox] = await Promise.all([
      loadMessages(this.assistantId),
      loadTransfers(this.assistantId),
      loadOutbox(this.assistantId),
    ])
    this.chat = hydrateChat(this.assistantId, messages, transfers, Date.now())
    this.persistedTransfers = { ...this.chat.transfers }
    // 重启后“飞行中”的条目必须退回 pending，否则它们永远不会被重发。
    this.outbox = releaseInflight(outbox)
    await saveOutbox(this.assistantId, this.outbox)
  }

  /**
   * 处理一帧聊天/文件帧。
   * ack 与 error 会影响离线队列（队列不在 reducer 里），所以先在这里同步。
   */
  onFrame(frame: ServerFrame): void {
    if (!isKnownServerFrame(frame)) return
    if (frame.t === 'chat/ack' && frame.rid) {
      this.outbox = markOutboxSent(this.outbox, frame.rid)
      void saveOutbox(this.assistantId, this.outbox)
    }
    if (frame.t === 'chat/error' && frame.callId && frame.retryable !== false) {
      // 电脑端说这次失败可以重试：交给用户在气泡上手动点，避免自动重放造成重复执行。
      this.outbox = markOutboxFailed(this.outbox, frame.callId, frame.message, Date.now() + 5_000)
      void saveOutbox(this.assistantId, this.outbox)
    }
    this.dispatch(frame as ChatEvent)
  }

  /** 连接断开：把未确认消息退回队列，标记流式中断。 */
  onDisconnected(): void {
    this.dispatch({ t: 'conn/disconnected', at: Date.now() })
    this.outbox = releaseInflight(this.outbox)
    void saveOutbox(this.assistantId, this.outbox)
  }

  onConnected(): void {
    this.dispatch({ t: 'conn/connected', at: Date.now() })
    this.flushOutbox()
  }

  /** 发送一条消息（可带小附件）。业务规则在这里，不在组件里。 */
  async send(input: {
    text: string
    files?: Array<{ name: string; mime: string; dataBase64: string; size: number }>
  }): Promise<void> {
    const rid = randomRequestId('msg')
    const at = Date.now()
    const meta = (input.files ?? []).map(file => ({
      fileId: `up_${rid}_${file.name}`,
      name: file.name,
      size: file.size,
      mime: file.mime,
    }))
    this.dispatch({ t: 'user/send', rid, text: input.text, files: meta.length > 0 ? meta : undefined, at })
    this.outbox = enqueue(this.outbox, {
      rid,
      assistantId: this.assistantId,
      callId: rid,
      text: input.text,
      files: input.files?.map(file => ({ name: file.name, mime: file.mime, dataBase64: file.dataBase64 })),
      createdAt: at,
    })
    await saveOutbox(this.assistantId, this.outbox)
    this.flushOutbox()
  }

  /** 用户在气泡上点“重试”。 */
  async retry(rid: string): Promise<void> {
    this.outbox = retryEntry(this.outbox, rid)
    this.dispatch({ t: 'outbox/retry', rid, at: Date.now() })
    await saveOutbox(this.assistantId, this.outbox)
    this.flushOutbox()
  }

  requestFile(fileId: string): void {
    this.dispatch({ t: 'transfer/request', fileId, at: Date.now() })
  }

  cancelFile(fileId: string): void {
    this.dispatch({ t: 'transfer/cancel', fileId, at: Date.now() })
  }

  /** 点击文件卡片：已落盘就直接打开，否则先请求下载。 */
  async openFile(fileId: string): Promise<void> {
    const transfer = this.chat.transfers[fileId]
    if (!transfer) return
    if (!transfer.localPath) {
      this.requestFile(fileId)
      return
    }
    await openWithSystem(transfer.localPath, transfer.name, transfer.mime)
  }

  snapshot(): AssistantView {
    return {
      assistant: this.store.assistantRow(this.assistantId),
      link: this.link?.snapshot ?? OFFLINE_LINK,
      chat: this.chat,
      power: this.power,
      pendingMessages: pendingCount(this.outbox),
      activeTransfers: Object.values(this.chat.transfers).filter(
        transfer => transfer.status === 'downloading' || transfer.status === 'queued',
      ).length,
    }
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.sinkBuffers.clear()
    this.pendingWrites.clear()
  }

  // ---------------------------------------------------------------------------

  /** 统一的重发出口：只在连接可用时发，发的顺序就是入队顺序。 */
  private flushOutbox(): void {
    const link = this.link
    if (!link || !link.isOnline) return
    const entries = resendableEntries(this.outbox, { now: Date.now(), maxAttempts: DEFAULT_MAX_ATTEMPTS })
    for (const entry of entries) {
      const sent = link.sendChat({ rid: entry.rid, text: entry.text, files: entry.files })
      if (!sent) break
      this.outbox = markInflight(this.outbox, entry.rid, Date.now())
    }
    if (entries.length > 0) void saveOutbox(this.assistantId, this.outbox)
  }

  /** 统一的 reducer 出口：执行副作用、按需持久化、最后通知 UI。 */
  private dispatch(event: ChatEvent): void {
    const before = this.chat.messages
    const beforeTransfers = this.chat.transfers
    const result = reduceChat(this.chat, event, Date.now())
    this.chat = result.state
    this.runEffects(result.effects)
    this.persistMessageDiff(before, result.state.messages)
    this.persistTransferDiff(beforeTransfers, result.state.transfers)
    this.store.notify()
  }

  private runEffects(effects: ChatEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'file-chunk': {
          const buffer = this.sinkBuffers.get(effect.fileId) ?? []
          try {
            buffer.push(base64ToBytes(effect.dataBase64))
          } catch {
            // 坏的分块不该让整个下载“成功”：丢掉缓冲并把这条传输标失败。
            this.sinkBuffers.delete(effect.fileId)
            this.dispatch({ t: 'transfer/failed', fileId: effect.fileId, reason: '收到的分块不是合法 base64', at: Date.now() })
            return
          }
          this.sinkBuffers.set(effect.fileId, buffer)
          break
        }
        case 'file-complete':
          void this.finishTransfer(effect.fileId)
          break
        case 'file-abort':
          this.sinkBuffers.delete(effect.fileId)
          break
        case 'fetch-file':
          this.link?.fetchFile(effect.fileId)
          break
        case 'cancel-file':
          this.link?.cancelFile(effect.fileId)
          this.sinkBuffers.delete(effect.fileId)
          break
        default:
          break
      }
    }
  }

  private async finishTransfer(fileId: string): Promise<void> {
    const parts = this.sinkBuffers.get(fileId) ?? []
    const transfer = this.chat.transfers[fileId]
    this.sinkBuffers.delete(fileId)
    if (!transfer) return
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    try {
      const saved = await writeDownloadedFile(transfer.name, bytes)
      this.dispatch({ t: 'transfer/saved', fileId, path: saved.uri, at: Date.now() })
    } catch (error) {
      this.dispatch({ t: 'transfer/failed', fileId, reason: (error as Error).message, at: Date.now() })
    }
  }

  /** 只写变化的行：delta 很频繁，整段历史重写会让 SQLite 成为瓶颈。 */
  private persistMessageDiff(before: ChatMessage[], after: ChatMessage[]): void {
    const previous = new Map(before.map(message => [message.id, message]))
    for (const message of after) {
      const old = previous.get(message.id)
      if (!old || old.text !== message.text || old.state !== message.state || old.streaming !== message.streaming) {
        this.queueMessageWrite(message, message.streaming !== true)
      }
    }
  }

  private persistTransferDiff(before: Record<string, Transfer>, after: Record<string, Transfer>): void {
    for (const [fileId, transfer] of Object.entries(after)) {
      const old = before[fileId]
      if (old && old.status === transfer.status && old.receivedBytes === transfer.receivedBytes && old.localPath === transfer.localPath) {
        continue
      }
      this.persistedTransfers[fileId] = transfer
      void saveTransfer(this.assistantId, transfer)
    }
  }

  private queueMessageWrite(message: ChatMessage, immediate: boolean): void {
    this.pendingWrites.set(message.id, message)
    if (immediate) {
      void this.flushWrites()
      return
    }
    if (!this.flushTimer) {
      // 流式增量攒 400ms 再写一次：兼顾“进程被杀也不丢太多”与写放大。
      this.flushTimer = setTimeout(() => void this.flushWrites(), 400)
    }
  }

  private async flushWrites(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (this.pendingWrites.size === 0) return
    const messages = [...this.pendingWrites.values()]
    this.pendingWrites.clear()
    if (messages.length === 1) await saveMessage(this.assistantId, messages[0] as ChatMessage)
    else await saveMessages(this.assistantId, messages)
  }
}

/**
 * 全局状态容器。
 * 订阅者（React）只看到不可变的 `AppSnapshot`；每次变化替换快照对象。
 */
export class AppStore {
  private snapshotValue: AppSnapshot = {
    ready: false,
    assistants: [],
    connectionPolicy: { ...DEFAULT_CONNECTION_POLICY },
  }
  private readonly listeners = new Set<() => void>()
  private readonly rows = new Map<string, StoredAssistantRow>()
  private readonly controllers = new Map<string, ChatController>()
  private readonly links = new Map<string, AssistantLink>()
  private readonly lastStatuses = new Map<string, string>()
  private identity: DeviceIdentity | undefined
  private seed: Uint8Array | undefined
  private powerTicker: ReturnType<typeof setInterval> | undefined
  private pairWaiter:
    | { assistantId: string; resolve: (result: PairResult) => void; timer: ReturnType<typeof setTimeout> }
    | undefined

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): AppSnapshot => this.snapshotValue

  /** 启动：读取设备身份与助理列表，然后按需建连。 */
  async init(): Promise<void> {
    try {
      // 先加载连接策略：它决定哪些地址类型可用，必须早于任何建连。
      await this.loadConnectionPolicy()
      const identity = await loadIdentity()
      if (identity) {
        this.identity = identity
        this.seed = await loadSeed(identity.deviceId)
      }
      const rows = await listAssistants()
      for (const row of rows) this.rows.set(row.id, row)
      for (const id of this.rows.keys()) {
        await this.controller(id).load()
      }
      this.notify({ ready: true })
      // 已有绑定：直接恢复连接，**不需要用户再扫码**。
      for (const id of this.rows.keys()) this.connect(id)
    } catch (error) {
      this.notify({ ready: true, lastError: `初始化失败：${(error as Error).message}` })
    }
  }

  /** 从设置 KV 读取连接策略并写进内存策略（建连前调用）。 */
  private async loadConnectionPolicy(): Promise<void> {
    try {
      const [lan, usb, test] = await Promise.all([
        getSetting(CONNECTION_POLICY_KEYS.allowLan),
        getSetting(CONNECTION_POLICY_KEYS.allowUsb),
        getSetting(CONNECTION_POLICY_KEYS.internalTestMode),
      ])
      const next = setConnectionPolicy({
        allowLan: parsePolicyFlag(lan),
        // internalTestMode 必须一起传，否则 setConnectionPolicy 会把 USB 强制关掉。
        internalTestMode: parsePolicyFlag(test),
        allowUsb: parsePolicyFlag(usb),
      })
      this.snapshotValue = { ...this.snapshotValue, connectionPolicy: next }
    } catch {
      // 设置读不出来不该阻塞启动：退回默认（只用公网隧道）。
      setConnectionPolicy({ ...DEFAULT_CONNECTION_POLICY })
      this.snapshotValue = { ...this.snapshotValue, connectionPolicy: getConnectionPolicy() }
    }
  }

  /**
   * 更新「高级连接方式」开关并持久化，然后立刻重连让它们生效。
   *
   * USB 是内部测试用的通道：只有 `internalTestMode` 打开时才允许开启，
   * 关掉内部测试模式会连带关闭 USB（约束在 connection-policy 里强制执行）。
   */
  async updateConnectionPolicy(patch: Partial<ConnectionPolicy>): Promise<ConnectionPolicy> {
    const next = setConnectionPolicy(patch)
    await Promise.all([
      setSetting(CONNECTION_POLICY_KEYS.allowLan, formatPolicyFlag(next.allowLan)),
      setSetting(CONNECTION_POLICY_KEYS.allowUsb, formatPolicyFlag(next.allowUsb)),
      setSetting(CONNECTION_POLICY_KEYS.internalTestMode, formatPolicyFlag(next.internalTestMode)),
    ])
    this.notify({ connectionPolicy: next })
    // 策略变了就重建连接：新允许的地址要立刻尝试，新禁止的地址要立刻失效。
    for (const id of this.rows.keys()) this.reconnectNow(id)
    return next
  }

  // ---------------------------------------------------------------------------
  // 配对
  // ---------------------------------------------------------------------------

  /** 校验二维码并完成绑定握手。 */
  async pair(rawPayload: unknown): Promise<PairResult> {
    const validated = validatePairingQr(rawPayload, pairingDeps)
    if (!validated.ok) return { ok: false, error: validated.error }

    const identity = await this.ensureIdentity()
    const seed = this.seed
    if (!seed) return { ok: false, error: '设备密钥不可用，请重启应用后重试' }

    const record = buildAssistantFromPairing({
      payload: validated.payload as unknown as PairingPayload,
      endpoints: validated.endpoints,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
    })
    this.rows.set(record.id, record)
    await upsertAssistant(record)
    await this.controller(record.id).load()
    this.notify()

    const link = this.link(record.id)
    if (!link) return { ok: false, error: '无法创建连接（缺少设备密钥）' }
    link.setPairSecret(validated.payload.secret)

    const result = await this.waitForPairing(record.id)
    if (result.ok) {
      link.setPairSecret(undefined)
      await upsertAssistant(this.assistantRow(record.id))
    }
    // 失败时**保留**本地记录：电脑端可能已经把 deviceId 记成已绑定，
    // 直接删掉本地记录会让用户只能去电脑上解绑后再来。UI 会把错误和下一步说清楚。
    this.notify()
    return result
  }

  private waitForPairing(assistantId: string): Promise<PairResult> {
    return new Promise<PairResult>(resolve => {
      if (this.pairWaiter) {
        clearTimeout(this.pairWaiter.timer)
        this.pairWaiter.resolve({ ok: false, error: '有另一个绑定流程正在进行' })
      }
      const timer = setTimeout(() => {
        this.pairWaiter = undefined
        resolve({
          ok: false,
          error: '绑定超时：电脑端没有接受本次绑定',
          hint: '请确认二维码没有过期，并在电脑上重新生成后再扫。',
        })
      }, 30_000)
      this.pairWaiter = { assistantId, resolve, timer }
      this.link(assistantId)?.start()
    })
  }

  private settlePairing(assistantId: string, result: PairResult): void {
    const waiter = this.pairWaiter
    if (!waiter || waiter.assistantId !== assistantId) return
    clearTimeout(waiter.timer)
    this.pairWaiter = undefined
    waiter.resolve(result)
  }

  // ---------------------------------------------------------------------------
  // 连接
  // ---------------------------------------------------------------------------

  connect(assistantId: string): void {
    const link = this.link(assistantId)
    if (!link) return
    const status = link.snapshot.status
    if (status === 'online' || status === 'connecting' || status === 'handshaking') return
    link.start()
  }

  disconnect(assistantId: string): void {
    this.links.get(assistantId)?.stop()
  }

  reconnectNow(assistantId: string): void {
    this.links.get(assistantId)?.retryNow()
  }

  reconnectAll(): void {
    for (const id of this.rows.keys()) this.reconnectNow(id)
  }

  // ---------------------------------------------------------------------------
  // 助理管理
  // ---------------------------------------------------------------------------

  async rename(assistantId: string, name: string): Promise<void> {
    const trimmed = name.trim().slice(0, 60)
    if (!trimmed) return
    const row = this.rows.get(assistantId)
    if (!row) return
    const updated: StoredAssistantRow = { ...row, name: trimmed }
    this.rows.set(assistantId, updated)
    // 备注是本地功能：先本地生效，再尽力同步给电脑端，失败静默降级。
    await renameAssistantRow(assistantId, trimmed)
    this.notify()
    this.links.get(assistantId)?.renameAssistant(trimmed)
  }

  /** 我在电脑端的昵称：多人协作时作为消息前缀，存在设置 KV 里并推给电脑端。 */
  async setMyNickname(assistantId: string, nickname: string): Promise<void> {
    const trimmed = nickname.trim().slice(0, 24)
    await setSetting('device.nickname', trimmed || undefined)
    this.links.get(assistantId)?.renameDevice(trimmed)
  }

  /** 读取本机保存的昵称（为空表示用设备默认名）。 */
  async getMyNickname(): Promise<string> {
    return (await getSetting('device.nickname')) ?? ''
  }

  async setWakeSetting(assistantId: string, setting: WakeSetting): Promise<void> {
    const row = this.rows.get(assistantId)
    if (!row) return
    const updated: StoredAssistantRow = { ...row, wakeProxyUrl: setting.url, wakeMac: setting.mac }
    this.rows.set(assistantId, updated)
    await upsertAssistant(updated)
    this.notify()
  }

  /**
   * 本地解绑；`forgetRemote` 为真时同时通知电脑端。
   *
   * 注意：电脑端的 `device/forget` 必须走 WebSocket。手机此刻没连上时这一步必然失败，
   * 而本地记录已经删了 —— 于是形成「手机已解绑、电脑仍占着」的死锁：电脑端不再出二维码，
   * 手机端也没有可重试的对象。所以这里把是否通知成功如实返回，让 UI 明确提示用户
   * 「电脑端未解除，请到电脑的配对页面手动解除」，而不是假装全部成功。
   */
  async remove(assistantId: string, forgetRemote = true): Promise<{ remoteNotified: boolean }> {
    const link = this.links.get(assistantId)
    let remoteNotified = true
    if (forgetRemote) {
      // 未建立连接时 forgetDevice() 返回 false；抛错也同样视为未通知。
      try {
        remoteNotified = link?.forgetDevice() ?? false
      } catch {
        remoteNotified = false
      }
    }
    link?.stop()
    this.links.delete(assistantId)
    this.controllers.get(assistantId)?.dispose()
    this.controllers.delete(assistantId)
    this.lastStatuses.delete(assistantId)
    this.rows.delete(assistantId)
    await deleteAssistantRow(assistantId)
    this.notify()
    return { remoteNotified }
  }

  /** 唤醒：没有配置唤醒代理时返回引导文案，绝不发假帧。 */
  async wake(assistantId: string): Promise<{ ok: boolean; message: string; guidance?: string[] }> {
    const row = this.rows.get(assistantId)
    if (!row) return { ok: false, message: '助理不存在' }
    const plan = planWake({ url: row.wakeProxyUrl, mac: row.wakeMac }, { computerId: row.computerId, name: row.name })
    if (!plan.ok) return { ok: false, message: plan.message, guidance: plan.guidance }
    return performWake({ url: row.wakeProxyUrl, mac: row.wakeMac }, { computerId: row.computerId, name: row.name })
  }

  // ---------------------------------------------------------------------------
  // 电源
  // ---------------------------------------------------------------------------

  requestPower(assistantId: string, action: PowerAction, delaySeconds?: number): { sent: boolean; error?: string } {
    const link = this.links.get(assistantId)
    if (!link) return { sent: false, error: '还没有建立连接' }
    const allowed = this.assistantRow(assistantId).powerAllowed
    if (action !== 'cancel' && !allowed.includes(action)) return { sent: false, error: '电脑端已禁止这个操作' }
    const result = link.requestPower(action, delaySeconds)
    if (!result.sent) return { sent: false, error: '连接已断开，请先重连' }
    // 本地先进入 pending，等电脑端的 power/state 确认或纠正。
    const controller = this.controller(assistantId)
    controller.power = applyPowerState(
      controller.power,
      { t: 'power/state', rid: result.rid, action, accepted: true, delaySeconds },
      Date.now(),
    )
    this.ensurePowerTicker()
    this.notify()
    return { sent: true }
  }

  // ---------------------------------------------------------------------------
  // 供 UI 使用
  // ---------------------------------------------------------------------------

  assistantRow(assistantId: string): StoredAssistantRow {
    const row = this.rows.get(assistantId)
    if (row) return row
    // 理论上不该发生（视图只来自 rows）；给个占位对象避免 UI 崩掉。
    return {
      id: assistantId,
      computerId: assistantId,
      name: '未知电脑',
      fingerprint: '',
      endpoints: [],
      deviceId: this.identity?.deviceId ?? '',
      deviceName: this.identity?.deviceName ?? defaultDeviceName(),
      pairedAt: new Date(0).toISOString(),
      online: false,
      powerAllowed: ['cancel'],
    }
  }

  controller(assistantId: string): ChatController {
    let controller = this.controllers.get(assistantId)
    if (!controller) {
      controller = new ChatController(this, assistantId)
      this.controllers.set(assistantId, controller)
    }
    return controller
  }

  link(assistantId: string): AssistantLink | undefined {
    const existing = this.links.get(assistantId)
    if (existing) return existing
    const row = this.rows.get(assistantId)
    if (!row) return undefined
    const seed = this.seed
    if (!seed) return undefined
    const identity: LinkIdentity = {
      deviceId: row.deviceId || this.identity?.deviceId || '',
      deviceName: row.deviceName || this.identity?.deviceName || defaultDeviceName(),
      seed,
      publicKeySpki: keypairFromSeed(seed).publicKeySpki,
    }
    const link = new AssistantLink({
      assistant: row,
      identity,
      onFrame: frame => this.onFrame(assistantId, frame),
      onStatus: snapshot => this.onStatus(assistantId, snapshot),
      onHelloAck: (ack, pairing) => this.onHelloAck(assistantId, ack, pairing),
      log: message => {
        if (__DEV__) console.log(message)
      },
    })
    this.links.set(assistantId, link)
    this.controller(assistantId).attach(link)
    return link
  }

  /** 地址标签（设置页展示“当前走的是隧道还是局域网”）。 */
  endpointLabelFor(assistantId: string): string {
    const snapshot = this.links.get(assistantId)?.snapshot
    return snapshot?.endpoint ? endpointLabel(snapshot.endpoint) : '未连接'
  }

  get deviceIdentity(): { deviceId?: string; deviceName?: string } {
    return { deviceId: this.identity?.deviceId, deviceName: this.identity?.deviceName }
  }

  /** 设置页的“诊断”：把某个助理的离线队列吐出来。 */
  debugOutbox(assistantId: string): string {
    return JSON.stringify(this.controller(assistantId).outbox, null, 2)
  }

  notify(patch: Partial<AppSnapshot> = {}): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      ...patch,
      assistants: [...this.rows.keys()].map(id => this.controller(id).snapshot()),
    }
    for (const listener of this.listeners) listener()
    this.ensurePowerTicker()
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private onFrame(assistantId: string, frame: ServerFrame): void {
    if (frame.t === 'assistants') {
      const row = this.rows.get(assistantId)
      if (row && Array.isArray(frame.power?.allowed)) {
        const updated: StoredAssistantRow = { ...row, powerAllowed: frame.power.allowed }
        this.rows.set(assistantId, updated)
        void upsertAssistant(updated)
      }
      if (frame.unbound) {
        // 电脑端把这个设备解绑了：本地也必须清掉，否则每次连接都会被拒。
        void this.remove(assistantId, false)
        return
      }
      this.notify()
      return
    }
    if (frame.t === 'power/state') {
      const controller = this.controller(assistantId)
      controller.power = applyPowerState(controller.power, frame, Date.now())
      this.ensurePowerTicker()
      this.notify()
      return
    }
    this.controller(assistantId).onFrame(frame)
  }

  private onStatus(assistantId: string, snapshot: LinkSnapshot): void {
    const row = this.rows.get(assistantId)
    if (row) {
      const updated: StoredAssistantRow = {
        ...row,
        online: snapshot.online,
        preferredEndpoint: snapshot.endpoint ?? row.preferredEndpoint,
        lastConnectedAt: snapshot.connectedAt ? new Date(snapshot.connectedAt).toISOString() : row.lastConnectedAt,
      }
      this.rows.set(assistantId, updated)
      void setAssistantOnline(assistantId, snapshot.online, updated.lastConnectedAt)
      if (snapshot.online) void upsertAssistant(updated)
    }

    // 只在“从在线/握手中掉下来”的那一刻通知一次，避免每次重试都刷一遍聊天状态。
    const previous = this.lastStatuses.get(assistantId)
    this.lastStatuses.set(assistantId, snapshot.status)
    if (snapshot.status === 'reconnecting' && (previous === 'online' || previous === 'handshaking')) {
      this.controller(assistantId).onDisconnected()
    }
    if (snapshot.status === 'online') this.controller(assistantId).onConnected()
    if (snapshot.status === 'failed') {
      this.settlePairing(assistantId, { ok: false, error: snapshot.lastError ?? '连接失败', hint: snapshot.hint })
    }
    this.notify()
  }

  private onHelloAck(assistantId: string, ack: HelloAckFrame, pairing: boolean): void {
    const row = this.rows.get(assistantId)
    if (row) {
      const updated: StoredAssistantRow = {
        ...row,
        name: row.name || ack.computerName,
        online: true,
        serverVersion: ack.version ?? row.serverVersion,
        lastConnectedAt: new Date().toISOString(),
      }
      this.rows.set(assistantId, updated)
      void upsertAssistant(updated)
    }
    this.controller(assistantId).onConnected()
    this.settlePairing(assistantId, { ok: true, assistantId })
    this.notify()
    if (pairing && __DEV__) console.log(`[pair] ${assistantId} 绑定成功`)
  }

  /** 有倒计时在跑时每秒刷新一次文案；没有就停掉定时器（省电）。 */
  private ensurePowerTicker(): void {
    const anyPending = [...this.controllers.values()].some(controller => controller.power.phase === 'pending')
    if (anyPending && !this.powerTicker) {
      this.powerTicker = setInterval(() => {
        let changed = false
        for (const controller of this.controllers.values()) {
          if (controller.power.phase !== 'pending') continue
          const next = tickPower(controller.power, Date.now())
          if (next !== controller.power) {
            controller.power = next
            changed = true
          }
        }
        if (changed) this.notify()
      }, 1000)
    }
    if (!anyPending && this.powerTicker) {
      clearInterval(this.powerTicker)
      this.powerTicker = undefined
    }
  }

  private async ensureIdentity(): Promise<DeviceIdentity> {
    if (this.identity && this.seed) return this.identity
    const existing = await loadIdentity()
    if (existing) {
      const seed = await loadSeed(existing.deviceId)
      if (seed) {
        this.identity = existing
        this.seed = seed
        return existing
      }
    }
    // 首次启动：生成设备密钥，私钥只进 SecureStore。
    const keypair = generateDeviceKeypair()
    const identity: DeviceIdentity = {
      deviceId: newDeviceId(),
      deviceName: defaultDeviceName(),
      createdAt: new Date().toISOString(),
    }
    await saveSeed(identity.deviceId, keypair.seed)
    await saveIdentity(identity)
    this.identity = identity
    this.seed = keypair.seed
    return identity
  }
}

/** 新建一个空的离线队列（测试与重置用）。 */
export function emptyOutbox(): Outbox {
  return createOutbox()
}

/** 把 outbox 文本还原成对象（设置页诊断用）。 */
export function parseOutboxDebug(text: string): Outbox {
  return deserializeOutbox(text)
}

export type { ChatState, Transfer }
