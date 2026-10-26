// App 级状态与业务编排（不依赖 React）。
//
// 分层：
//   UI（app/…）→ 这里（把连接、reducer、SQLite、文件服务粘起来）→ core/（纯逻辑）+ services/。
// 组件里**不允许**出现业务规则：发送、重传、接收文件、电源倒计时、上传进度都在这里。
//
// 分块数据不进 reducer 状态：文件字节留在下载 sink（边收边写盘）或上传客户端里，
// reducer 只管进度、状态与显示文本。

import {
  deleteAssistant as deleteAssistantRow,
  deleteMessage as deleteMessageRow,
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
import {
  endpointKind,
  endpointKindLabel,
  endpointLabel,
  normalizeConnectionMode,
  normalizeManualAddress,
} from '../core/endpoint.mts'
import { CAPABILITIES, DEFAULT_PORT, MAX_UPLOAD_ATTACHMENTS } from '../core/frames.mts'
import { mergeManualEndpoint, pickAssistantForEndpoint } from '../core/manual-connect.mts'
import {
  buildAssistantFromPairing,
  extractJsonObject,
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
  markUploaded,
  pendingCount,
  releaseInflight,
  resendableEntries,
  retryEntry,
  type Outbox,
  type OutboxEntry,
  type OutboxFile,
  type OutboxUploadRef,
} from '../core/outbox.mts'
import { validateQrText } from '../core/qr-image.mts'
import {
  emptyChatState,
  hydrateChat,
  isKnownServerFrame,
  reduceChat,
  type ChatEffect,
  type ChatEvent,
  type ChatMessage,
  type ChatState,
  type FileRef,
  type Transfer,
} from '../core/reducer.mts'
import { uploadFailureLabel, uploadGuard } from '../core/upload.mts'
import { planWake, type WakeSetting } from '../core/wake.mts'
import { pairingDeps, orderEndpoints } from '../protocol/runtime'
import type { ChatSendFile, HelloAckFrame, LinkSnapshot, ServerFrame } from '../protocol/types'

import { AssistantLink, type LinkIdentity } from '../services/connection'
import { generateDeviceKeypair, keypairFromSeed, newDeviceId, randomRequestId } from '../services/crypto'
import { readFileBase64 } from '../services/attachments'
import { probeAddress as probeAddressService, type AddressProbe } from '../services/manual-connect'
import { decodeQrFromImage, pickQrImageFromAlbum } from '../services/qr-image'
import { defaultDeviceName, loadIdentity, loadSeed, saveIdentity, saveSeed, type DeviceIdentity } from '../services/secure'
import { createDownloadSink, openWithSystem, writeDownloadedFile, type DownloadSink } from '../services/transfers'
import { UploadClient, classifyUploadError } from '../services/upload'
import { performWake } from '../services/wake'

export interface StoredAssistantRow extends AssistantRecord {
  wakeMac?: string
}

/** 在线成员（UI 的头像条）。 */
export interface ParticipantView {
  deviceId: string
  name: string
  online: boolean
  /** 是不是本机（头像条给“我”加描边）。 */
  isMe: boolean
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
  /** 协作模式是否开启。 */
  collaboration: boolean
  /** 会话内在线成员。 */
  participants: ParticipantView[]
  /** 未读消息数（进入聊天页调用 markRead 清零）。 */
  unread: number
  /** 每台电脑持久化的连接方式。 */
  connectionMode: string
  /** 当前线路的人类可读标签（例如「Tailscale」）。 */
  endpointLabel: string
}

export type Appearance = 'system' | 'light' | 'dark'

export interface AppSnapshot {
  ready: boolean
  assistants: AssistantView[]
  deviceId?: string
  deviceName?: string
  lastError?: string
  /** 连接策略（高级连接方式 / 内部测试模式）。 */
  connectionPolicy?: ConnectionPolicy
  /** 主题：跟随系统 / 浅色 / 深色。 */
  appearance: Appearance
}

export interface PairResult {
  ok: boolean
  assistantId?: string
  error?: string
  hint?: string
  /** 用户取消了相册选图等操作。 */
  cancelled?: boolean
}

export type { AddressProbe }

const OFFLINE_LINK: LinkSnapshot = { status: 'idle', online: false, attempt: 0, heartbeatMs: 25_000 }

const APPEARANCE_KEY = 'ui.appearance'

/** 一次发送的附件（UI 传 uri；老调用方可以传 dataBase64 内联）。 */
export interface OutgoingFile {
  name: string
  mime?: string
  size?: number
  uri?: string
  dataBase64?: string
}

/** 本地生成的附件 id（回声里保留，用来把上传进度挂到气泡上）。 */
function localUploadId(rid: string, index: number): string {
  return `upl_${rid}_${index}`
}

function sendKeyOf(text: string, files: OutgoingFile[]): string {
  const filesKey = files.map(file => `${file.name}:${file.size ?? 0}:${file.uri ?? ''}`).join('|')
  return `${text}\u0000${filesKey}`
}

function uploadRefsFor(entry: OutboxEntry): OutboxUploadRef[] {
  return entry.uploads ?? []
}

/** 每个助理一个：聊天状态 + 离线队列 + 文件组装缓冲。 */
class ChatController {
  readonly assistantId: string
  chat: ChatState
  outbox: Outbox = createOutbox()
  power: PowerState = idlePowerState()
  unread = 0

  private readonly store: AppStore
  private link: AssistantLink | undefined
  private uploader: UploadClient | undefined
  /** 下载流式写入器（fileId → sink）。 */
  private sinks = new Map<string, DownloadSink>()
  /** 每个文件的写入串行队列（保证分块按序落盘）。 */
  private sinkQueues = new Map<string, Promise<void>>()
  private pendingWrites = new Map<string, ChatMessage>()
  private persistedTransfers: Record<string, Transfer> = {}
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private sendChain: Promise<void> = Promise.resolve()
  private lastSend: { key: string; at: number; rid: string } | undefined
  private pumping = false
  private pumpRequested = false
  private disposed = false

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
    this.chat = hydrateChat(this.assistantId, messages, transfers, Date.now(), {
      selfDeviceId: this.store.deviceIdentity.deviceId,
    })
    // 会话元数据从助理记录恢复（游标用于重连补发）。
    const row = this.store.assistantRow(this.assistantId)
    this.chat = {
      ...this.chat,
      sessionId: row.sessionId,
      sessionEpoch: row.sessionEpoch,
      sessionCursor: typeof row.sessionCursor === 'number' ? row.sessionCursor : 0,
    }
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
    if (frame.t === 'chat/ack') {
      const key = frame.rid ?? frame.msgId
      if (key) {
        this.outbox = markOutboxSent(this.outbox, key)
        void saveOutbox(this.assistantId, this.outbox)
      }
    }
    if (frame.t === 'chat/error' && frame.callId && frame.retryable !== false) {
      // 电脑端说这次失败可以重试：交给用户在气泡上手动点，避免自动重放造成重复执行。
      this.outbox = markOutboxFailed(this.outbox, frame.callId, frame.message, Date.now() + 5_000)
      void saveOutbox(this.assistantId, this.outbox)
    }
    if (isUploadFrame(frame)) {
      this.uploader?.onFrame(frame)
    }
    this.dispatch(frame as ChatEvent)
  }

  /** 连接断开：把未确认消息退回队列，标记流式中断，停掉进行中的上传。 */
  onDisconnected(): void {
    this.uploader?.abortAll('网络已断开，上传中断')
    this.dispatch({ t: 'conn/disconnected', at: Date.now() })
    this.outbox = releaseInflight(this.outbox)
    void saveOutbox(this.assistantId, this.outbox)
  }

  onConnected(): void {
    this.dispatch({ t: 'conn/connected', at: Date.now() })
    this.pumpOutbox()
  }

  /** 会话切换（协作模式/纪元变化）：清空本地会话，等 session/state 快照。 */
  onSessionSwitch(info: { sessionId?: string; sessionEpoch?: number; reason?: string }): void {
    this.dispatch({
      t: 'session/reset',
      sessionId: info.sessionId,
      sessionEpoch: info.sessionEpoch,
      reason: info.reason,
      at: Date.now(),
    })
  }

  /** 进入聊天页：清未读。 */
  markRead(): void {
    if (this.unread === 0) return
    this.unread = 0
    this.store.notify()
  }

  /**
   * 发送一条消息（可带附件）。
   *
   * 防重入：
   *  * 同一段文本 + 同一批附件在 1 秒内重复调用会被合并（UI 双击发送不会产生两条消息）；
   *  * 发送流程用 Promise 串行化，避免两次 `await saveOutbox` 交错。
   */
  async send(input: { text?: string; files?: OutgoingFile[] }): Promise<void> {
    const text = typeof input.text === 'string' ? input.text : ''
    const files = Array.isArray(input.files) ? input.files.filter(file => file && typeof file === 'object') : []
    if (text.trim() === '' && files.length === 0) return
    const key = sendKeyOf(text, files)
    const now = Date.now()
    if (this.lastSend && this.lastSend.key === key && now - this.lastSend.at < 1000) {
      const previous = this.outbox.entries.find(entry => entry.rid === this.lastSend!.rid)
      if (previous && (previous.state === 'pending' || previous.state === 'inflight')) return
    }
    const run = this.sendChain.then(() => this.sendInternal(text, files))
    this.sendChain = run.catch(() => undefined)
    return run
  }

  private async sendInternal(text: string, files: OutgoingFile[]): Promise<void> {
    if (files.length > MAX_UPLOAD_ATTACHMENTS) {
      this.dispatch({
        t: 'chat/error',
        message: `一条消息最多 ${MAX_UPLOAD_ATTACHMENTS} 个附件`,
        at: Date.now(),
      })
      return
    }
    const rid = randomRequestId('msg')
    const at = Date.now()
    const refs: FileRef[] = []
    const outFiles: OutboxFile[] = []
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!
      const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0 ? Math.floor(file.size) : 0
      const guard = uploadGuard(size)
      if (!guard.ok) {
        this.dispatch({ t: 'chat/error', message: guard.message, at: Date.now() })
        return
      }
      const uploadId = file.uri ? localUploadId(rid, index) : undefined
      refs.push({
        fileId: uploadId ?? `up_${rid}_${index}`,
        name: file.name || '附件',
        size,
        mime: file.mime,
        uploadId,
        uploadStatus: uploadId ? 'uploading' : undefined,
        uploadedBytes: uploadId ? 0 : undefined,
      })
      outFiles.push({ name: file.name || '附件', mime: file.mime ?? '', size, uri: file.uri, dataBase64: file.dataBase64 })
    }
    this.dispatch({ t: 'user/send', rid, msgId: rid, text, files: refs.length > 0 ? refs : undefined, at })
    this.outbox = enqueue(this.outbox, {
      rid,
      msgId: rid,
      assistantId: this.assistantId,
      callId: rid,
      text,
      files: outFiles.length > 0 ? outFiles : undefined,
      createdAt: at,
    })
    this.lastSend = { key: sendKeyOf(text, files), at, rid }
    await saveOutbox(this.assistantId, this.outbox)
    this.pumpOutbox()
  }

  /** 用户在气泡上点“重试”（发送失败的本地消息：同一 rid 重发，不新增气泡）。 */
  async retry(rid: string): Promise<void> {
    this.outbox = retryEntry(this.outbox, rid)
    this.dispatch({ t: 'outbox/retry', rid, at: Date.now() })
    await saveOutbox(this.assistantId, this.outbox)
    this.pumpOutbox()
  }

  /** 长按用户消息「重新发送」：按消息 id 找到 rid 后重发。 */
  async resend(messageId: string): Promise<void> {
    const message = this.chat.messages.find(item => item.id === messageId)
    if (!message || message.kind !== 'user') return
    const rid = message.rid ?? message.msgId
    if (!rid) return
    const entry = this.outbox.entries.find(item => item.rid === rid || item.msgId === rid)
    if (entry) {
      await this.retry(rid)
      return
    }
    // 线上已经确认过的消息再“重发”：重新入队（电脑端按 msgId 判重，不会重复执行）。
    this.outbox = enqueue(this.outbox, {
      rid,
      msgId: rid,
      assistantId: this.assistantId,
      callId: rid,
      text: message.text,
      createdAt: Date.now(),
    })
    this.dispatch({ t: 'outbox/retry', rid, at: Date.now() })
    await saveOutbox(this.assistantId, this.outbox)
    this.pumpOutbox()
  }

  /** 长按用户消息「删除」：本地隐藏 + 清掉待发队列里的同一条。 */
  async remove(messageId: string): Promise<void> {
    const message = this.chat.messages.find(item => item.id === messageId)
    if (!message) return
    const rid = message.rid ?? message.msgId
    if (rid) {
      this.outbox = { ...this.outbox, entries: this.outbox.entries.filter(entry => entry.rid !== rid && entry.msgId !== rid) }
      await saveOutbox(this.assistantId, this.outbox)
    }
    this.dispatch({ t: 'message/remove', messageId, at: Date.now() })
    await deleteMessageRow(this.assistantId, messageId)
  }

  /**
   * 助手回合失败后的「重试」：用**新的 msgId** 重新提问。
   * 同 msgId 重发会被电脑端判重、不会产生新回答，所以这里必须是一条新消息。
   */
  async retryAssistant(callId: string): Promise<void> {
    const question = this.chat.messages.find(
      message => message.kind === 'user' && message.callId === callId && message.text.trim() !== '',
    ) ?? this.chat.messages
      .filter(message => message.kind === 'user' && message.text.trim() !== '')
      .slice(-1)[0]
    if (!question) return
    await this.send({ text: question.text })
  }

  /** 停止生成（有 callId 就精确取消，否则取消当前流式输出）。 */
  stop(): void {
    const streaming = this.chat.messages.filter(message => message.kind === 'assistant' && message.streaming)
    const callId = this.chat.typing?.callId ?? streaming[streaming.length - 1]?.callId
    if (callId) this.link?.cancelChat(callId)
    this.dispatch({ t: 'user/stop', callId, at: Date.now() })
  }

  /** 取消一个正在进行的附件上传。 */
  cancelUpload(uploadId: string): void {
    this.uploader?.cancel(uploadId)
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
    const row = this.store.assistantRow(this.assistantId)
    const deviceId = row.deviceId || this.store.deviceIdentity.deviceId
    return {
      assistant: row,
      link: this.link?.snapshot ?? OFFLINE_LINK,
      chat: this.chat,
      power: this.power,
      pendingMessages: pendingCount(this.outbox),
      activeTransfers: Object.values(this.chat.transfers).filter(
        transfer => transfer.status === 'downloading' || transfer.status === 'queued',
      ).length,
      collaboration: this.chat.collaboration,
      participants: this.chat.participants.map(participant => ({
        ...participant,
        isMe: deviceId !== undefined && participant.deviceId === deviceId,
      })),
      unread: this.unread,
      connectionMode: normalizeConnectionMode(row.connectionMode),
      endpointLabel: this.link?.snapshot.endpoint ? endpointLabel(this.link.snapshot.endpoint) : '未连接',
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.flushTimer = undefined
    this.cursorTimer = undefined
    void this.abortAllSinks('页面已销毁')
    this.uploader?.dispose()
    this.sinks.clear()
    this.sinkQueues.clear()
    this.pendingWrites.clear()
  }

  // ---------------------------------------------------------------------------
  // 发送队列（含分块上传）
  // ---------------------------------------------------------------------------

  private uploadClient(): UploadClient {
    if (!this.uploader) {
      this.uploader = new UploadClient({
        send: frame => this.link?.send(frame) ?? false,
      })
    }
    return this.uploader
  }

  /** 统一的重发出口：只在连接可用时发；附件先分块上传再发消息。 */
  private pumpOutbox(): void {
    void this.runPump()
  }

  private async runPump(): Promise<void> {
    if (this.disposed) return
    if (this.pumping) {
      this.pumpRequested = true
      return
    }
    this.pumping = true
    try {
      let rounds = 0
      do {
        this.pumpRequested = false
        rounds += 1
        if (rounds > 10) break
        // 一轮把当前所有可发条目都尝试一遍；上传是异步的，期间可能有新帧到达。
        for (;;) {
          const link = this.link
          if (!link || !link.isOnline || this.disposed) return
          const entries = resendableEntries(this.outbox, { now: Date.now(), maxAttempts: DEFAULT_MAX_ATTEMPTS })
          if (entries.length === 0) break
          let progressed = false
          for (const entry of entries) {
            if (this.disposed) return
            const files = await this.prepareFiles(entry)
            const latest = this.outbox.entries.find(item => item.rid === entry.rid)
            if (files === undefined) {
              // prepareFiles 失败时已经把条目标成 failed 并通知 UI；这一轮不再继续。
              if (!latest || latest.state === 'failed') break
              continue
            }
            const currentLink = this.link
            if (!currentLink || !currentLink.isOnline) return
            const sent = currentLink.sendChat({
              rid: entry.rid,
              msgId: entry.msgId ?? entry.rid,
              text: entry.text,
              speaker: entry.speaker,
              files: files.length > 0 ? files : undefined,
            })
            if (!sent) break
            this.outbox = markInflight(this.outbox, entry.rid, Date.now())
            progressed = true
          }
          await saveOutbox(this.assistantId, this.outbox)
          if (!progressed) break
        }
      } while (this.pumpRequested)
    } finally {
      this.pumping = false
    }
  }

  /**
   * 把一条待发消息的附件准备好：
   *  * 电脑端声明 upload-v1 → 分块上传，消息里只带 uploadId；
   *  * 否则退回内联 base64（仅 ≤ 8 MiB 的小文件）。
   * 返回空数组 = 这条消息没有附件；返回 undefined = 准备失败（条目已标 failed，UI 会提示重试）。
   */
  private async prepareFiles(entry: OutboxEntry): Promise<ChatSendFile[] | undefined> {
    const files = entry.files ?? []
    if (files.length === 0) return []
    const link = this.link
    const canUpload = link !== undefined && link.hasCapability(CAPABILITIES.UPLOAD)
    const completed = uploadRefsFor(entry)
    const refs: ChatSendFile[] = []
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!
      const size = typeof file.size === 'number' && file.size > 0 ? file.size : 0
      const uploaded = completed.find(ref => ref.index === index)
      if (uploaded) {
        refs.push({ uploadId: uploaded.uploadId, name: uploaded.name, mime: uploaded.mime, size: uploaded.size })
        continue
      }
      if (canUpload && file.uri) {
        try {
          const result = await this.uploadClient().upload(
            {
              uploadId: localUploadId(entry.rid, index),
              uri: file.uri,
              name: file.name,
              mime: file.mime,
              size,
            },
          )
          const ref: OutboxUploadRef = {
            index,
            uploadId: result.uploadId,
            name: result.name,
            size: result.size,
            mime: result.mime,
          }
          completed.push(ref)
          this.outbox = markUploaded(this.outbox, entry.rid, [ref])
          await saveOutbox(this.assistantId, this.outbox)
          refs.push({ uploadId: result.uploadId, name: result.name, mime: result.mime, size: result.size })
        } catch (error) {
          // 区分「网络断开（可重试）」与「电脑端拒绝/文件问题（改设置或换文件）」，
          // UI 依据 message.retryable 决定按钮文案，不做后台静默重传。
          const failure = classifyUploadError(error)
          const reason = `${uploadFailureLabel(failure.kind)}：${failure.message}`
          this.outbox = markOutboxFailed(
            this.outbox,
            entry.rid,
            reason,
            failure.retryable ? Date.now() + 5_000 : undefined,
          )
          await saveOutbox(this.assistantId, this.outbox)
          this.dispatch({
            t: 'outbox/failed',
            rid: entry.rid,
            reason,
            retryable: failure.retryable,
            at: Date.now(),
          })
          return undefined
        }
        continue
      }
      // 老电脑端：内联 base64。这里再拦一次大小，避免把隧道打爆。
      const inline = uploadGuardInline(size)
      if (!inline.ok) {
        this.outbox = markOutboxFailed(this.outbox, entry.rid, inline.message, undefined)
        await saveOutbox(this.assistantId, this.outbox)
        this.dispatch({ t: 'outbox/failed', rid: entry.rid, reason: inline.message, retryable: false, at: Date.now() })
        return undefined
      }
      let dataBase64 = file.dataBase64
      if (!dataBase64 && file.uri) {
        try {
          dataBase64 = await readFileBase64(file.uri)
        } catch (error) {
          const message = `读取附件失败：${(error as Error).message}`
          this.outbox = markOutboxFailed(this.outbox, entry.rid, message, undefined)
          this.dispatch({ t: 'outbox/failed', rid: entry.rid, reason: message, retryable: false, at: Date.now() })
          return undefined
        }
      }
      if (!dataBase64) {
        const message = '附件内容丢失，请重新选择文件'
        this.outbox = markOutboxFailed(this.outbox, entry.rid, message, undefined)
        this.dispatch({ t: 'outbox/failed', rid: entry.rid, reason: message, retryable: false, at: Date.now() })
        return undefined
      }
      refs.push({ dataBase64, name: file.name, mime: file.mime, size: file.size })
    }
    return refs
  }

  /** 统一的 reducer 出口：执行副作用、按需持久化、最后通知 UI。 */
  private dispatch(event: ChatEvent): void {
    const before = this.chat.messages
    const beforeTransfers = this.chat.transfers
    const beforeCursor = this.chat.sessionCursor
    const beforeIds = new Set(before.map(message => message.id))
    const result = reduceChat(this.chat, event, Date.now())
    this.chat = result.state
    this.runEffects(result.effects)
    this.persistMessageDiff(before, result.state.messages)
    this.persistTransferDiff(beforeTransfers, result.state.transfers)
    this.bumpUnread(beforeIds, result.state.messages)
    if (this.chat.sessionCursor !== beforeCursor) this.scheduleCursorPersist()
    this.store.notify()
  }

  private runEffects(effects: ChatEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'file-chunk': {
          let bytes: Uint8Array
          try {
            bytes = base64ToBytes(effect.dataBase64)
          } catch {
            // 坏的分块不该让整个下载“成功”：丢掉缓冲并把这条传输标失败。
            this.failSink(effect.fileId, '收到的分块不是合法 base64')
            continue
          }
          this.enqueueSinkWrite(effect.fileId, async () => {
            const sink = await this.ensureSink(effect.fileId)
            if (!sink) throw new Error('无法创建下载文件')
            await sink.write(bytes)
          })
          break
        }
        case 'file-complete':
          void this.finishTransfer(effect.fileId)
          break
        case 'file-abort':
          void this.abortSink(effect.fileId, '传输已中止')
          break
        case 'fetch-file':
          this.link?.fetchFile(effect.fileId)
          break
        case 'cancel-file':
          this.link?.cancelFile(effect.fileId)
          void this.abortSink(effect.fileId, '已取消下载')
          break
        case 'persist-cursor':
          if (effect.cursor > this.chat.sessionCursor) {
            // reducer 已经把游标写进 state；这里只保证一定落库。
            this.scheduleCursorPersist()
          }
          break
        default:
          break
      }
    }
  }

  private async ensureSink(fileId: string): Promise<DownloadSink | undefined> {
    const existing = this.sinks.get(fileId)
    if (existing) return existing
    const transfer = this.chat.transfers[fileId]
    const sink = await createDownloadSink({
      fileId,
      name: transfer?.name ?? fileId,
      size: transfer?.size ?? 0,
    })
    this.sinks.set(fileId, sink)
    return sink
  }

  private enqueueSinkWrite(fileId: string, task: () => Promise<void>): void {
    const previous = this.sinkQueues.get(fileId) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch(error => {
        this.failSink(fileId, (error as Error).message || '写入文件失败')
      })
    this.sinkQueues.set(fileId, next)
  }

  private failSink(fileId: string, reason: string): void {
    void this.abortSink(fileId, reason)
    this.dispatch({ t: 'transfer/failed', fileId, reason, at: Date.now() })
  }

  private async abortSink(fileId: string, _reason?: string): Promise<void> {
    const sink = this.sinks.get(fileId)
    this.sinks.delete(fileId)
    this.sinkQueues.delete(fileId)
    if (sink) {
      try {
        await sink.abort()
      } catch {
        // 半截文件删不掉不该阻塞状态更新。
      }
    }
  }

  private async abortAllSinks(reason: string): Promise<void> {
    for (const fileId of [...this.sinks.keys()]) await this.abortSink(fileId, reason)
  }

  private async finishTransfer(fileId: string): Promise<void> {
    try {
      await (this.sinkQueues.get(fileId) ?? Promise.resolve())
      const transfer = this.chat.transfers[fileId]
      if (!transfer) return
      let sink = this.sinks.get(fileId)
      if (!sink) {
        // 0 字节文件（没有分块）也要落一个空文件。
        const saved = await writeDownloadedFile(transfer.name, new Uint8Array(0))
        this.dispatch({ t: 'transfer/saved', fileId, path: saved.uri, at: Date.now() })
        return
      }
      this.sinks.delete(fileId)
      this.sinkQueues.delete(fileId)
      const saved = await sink.finish()
      this.dispatch({ t: 'transfer/saved', fileId, path: saved.uri, at: Date.now() })
    } catch (error) {
      await this.abortSink(fileId, (error as Error).message)
      this.dispatch({ t: 'transfer/failed', fileId, reason: (error as Error).message, at: Date.now() })
    }
  }

  /** 只写变化的行：delta 很频繁，整段历史重写会让 SQLite 成为瓶颈。 */
  private persistMessageDiff(before: ChatMessage[], after: ChatMessage[]): void {
    const previous = new Map(before.map(message => [message.id, message]))
    for (const message of after) {
      const old = previous.get(message.id)
      if (
        !old ||
        old.text !== message.text ||
        old.state !== message.state ||
        old.streaming !== message.streaming ||
        old.files !== message.files
      ) {
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

  /** 未读计数：新出现的助手消息 / 他人消息才 +1（流式增量不重复计数）。 */
  private bumpUnread(beforeIds: Set<string>, after: ChatMessage[]): void {
    let added = 0
    for (const message of after) {
      if (beforeIds.has(message.id)) continue
      if (message.kind === 'assistant' && message.fileOffer !== true) added += 1
      else if (message.kind === 'user' && message.mine === false) added += 1
    }
    if (added > 0) {
      this.unread += added
      this.store.setBadge(this.assistantId)
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

  /** 会话游标落库：合并 300ms 内的多次变化，避免每条事件写一次 SQLite。 */
  private scheduleCursorPersist(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined
      this.store.saveSessionMeta(this.assistantId, {
        sessionId: this.chat.sessionId,
        sessionEpoch: this.chat.sessionEpoch,
        sessionCursor: this.chat.sessionCursor,
      })
    }, 300)
  }
}

/** 内联附件的上限判断（老电脑端兼容路径）：≤ 8 MiB。 */
function uploadGuardInline(size: number): { ok: true } | { ok: false; message: string } {
  const limit = 8 * 1024 * 1024
  if (!Number.isFinite(size) || size < 0) return { ok: false, message: '无法读取这个文件的大小' }
  if (size > limit) {
    return {
      ok: false,
      message: '电脑端版本较旧，内联附件上限 8.0 MB：请升级电脑端插件以支持大文件分块上传',
    }
  }
  return { ok: true }
}

function isUploadFrame(frame: ServerFrame): boolean {
  return (
    frame.t === 'upload/ready' || frame.t === 'upload/progress' || frame.t === 'upload/done' || frame.t === 'upload/error'
  )
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
    appearance: 'system',
  }
  private readonly listeners = new Set<() => void>()
  private readonly rows = new Map<string, StoredAssistantRow>()
  private readonly controllers = new Map<string, ChatController>()
  private readonly links = new Map<string, AssistantLink>()
  private readonly lastStatuses = new Map<string, string>()
  private identity: DeviceIdentity | undefined
  private seed: Uint8Array | undefined
  private powerTicker: ReturnType<typeof setInterval> | undefined
  private badgeTimer: ReturnType<typeof setTimeout> | undefined
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
      // 先加载连接策略与外观：它们决定哪些地址可用 / 首屏主题，必须早于任何建连与渲染。
      await this.loadConnectionPolicy()
      await this.loadAppearance()
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
      // 已有绑定：直接恢复连接，**不需要用户再扫码**（重启后自动重连）。
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
        // v2.2.0 起局域网默认可用（不再藏在高级设置里）；老用户显式关过才尊重设置值。
        allowLan: lan === undefined || lan === null ? true : parsePolicyFlag(lan),
        // internalTestMode 必须一起传，否则 setConnectionPolicy 会把 USB 强制关掉。
        internalTestMode: parsePolicyFlag(test),
        allowUsb: parsePolicyFlag(usb),
      })
      this.snapshotValue = { ...this.snapshotValue, connectionPolicy: next }
    } catch {
      // 设置读不出来不该阻塞启动：局域网默认开、USB 关。
      setConnectionPolicy({ ...DEFAULT_CONNECTION_POLICY })
      this.snapshotValue = { ...this.snapshotValue, connectionPolicy: getConnectionPolicy() }
    }
  }

  private async loadAppearance(): Promise<void> {
    try {
      const value = await getSetting(APPEARANCE_KEY)
      const appearance: Appearance = value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
      this.snapshotValue = { ...this.snapshotValue, appearance }
    } catch {
      // 读不出来就跟随系统。
    }
  }

  /** 主题设置（设置页「外观」）。 */
  async setAppearance(mode: Appearance): Promise<void> {
    const appearance: Appearance = mode === 'light' || mode === 'dark' ? mode : 'system'
    await setSetting(APPEARANCE_KEY, appearance)
    this.notify({ appearance })
  }

  /**
   * 更新「高级连接方式」开关并持久化，然后立刻重连让它们生效。
   *
   * USB 是内部测试用的通道：只有 `internalTestMode` 打开时才允许开启，
   * 关掉内部测试模式会连带关闭 USB（约束在 connection-policy 里强制执行）。
   * `allowLan` 保留在 API 里兼容旧 UI，但 v2.2.0 起默认就是开启的。
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
  // 配对 / 相册扫码 / 手动连接
  // ---------------------------------------------------------------------------

  /**
   * 校验二维码并完成绑定握手。`rawPayload` 可以是对象，也可以是二维码原始文本
   * （相册扫码/手动粘贴都走这里）。
   */
  async pair(rawPayload: unknown): Promise<PairResult> {
    if (typeof rawPayload === 'string') return this.pairFromText(rawPayload)
    const validated = validatePairingQr(rawPayload, pairingDeps)
    if (!validated.ok) return { ok: false, error: validated.error }

    const identity = await this.ensureIdentity()
    const seed = this.seed
    if (!seed) return { ok: false, error: '设备密钥不可用，请重启应用后重试' }

    const payload = validated.payload as unknown as PairingPayload
    // 端点顺序按连接方式偏好排（auto = Tailscale > 局域网 > 隧道），二维码里的顺序只是参考。
    const ordered = orderEndpoints(validated.endpoints, { mode: payload.mode ?? 'auto' })
    const record = buildAssistantFromPairing({
      payload,
      endpoints: ordered.length > 0 ? ordered : validated.endpoints,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
    })
    // P0-6：同一台电脑重新绑定时，先销毁旧对象与旧地址，绝不复用旧连接。
    const previous = this.rows.get(record.id)
    if (previous) {
      this.links.get(record.id)?.stop('重新绑定')
      this.links.delete(record.id)
      this.controllers.get(record.id)?.dispose()
      this.controllers.delete(record.id)
      this.lastStatuses.delete(record.id)
    }
    this.rows.set(record.id, record)
    await upsertAssistant(record)
    await this.controller(record.id).load()
    this.notify()

    const link = this.link(record.id)
    if (!link) return { ok: false, error: '无法创建连接（缺少设备密钥）' }
    link.setPairSecret(payload.secret)

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

  /** 二维码文本 → 绑定（相册扫码、手动粘贴共用）。 */
  async pairFromText(text: string): Promise<PairResult> {
    const validation = validateQrText(text)
    if (!validation.ok) return { ok: false, error: validation.message, hint: validation.hint }
    if (!validation.fromJson) {
      return {
        ok: false,
        error: '这个二维码不是 Open Whale 的绑定二维码',
        hint: '请扫描电脑上 Open Whale 页面显示的绑定二维码；也可以用「手动连接」直接输入电脑地址。',
      }
    }
    return this.pair(validation.payload)
  }

  /** 相册选图 → 解码二维码 → 走与相机扫码完全相同的绑定流程。 */
  async pairFromAlbum(): Promise<PairResult> {
    const picked = await pickQrImageFromAlbum()
    if (!picked.ok) {
      return { ok: false, cancelled: picked.cancelled, error: picked.message, hint: picked.hint }
    }
    return this.pairFromImage(picked.uri)
  }

  /** 从指定图片解码二维码并绑定（UI 自己选图时用）。 */
  async pairFromImage(uri: string): Promise<PairResult> {
    const decoded = await decodeQrFromImage(uri)
    if (!decoded.ok) return { ok: false, error: decoded.message, hint: decoded.hint }
    return this.pairFromText(decoded.text)
  }

  /** 手动地址「测试连接」：GET /openwhale/health。 */
  async probeAddress(input: string): Promise<AddressProbe> {
    return probeAddressService(input)
  }

  /**
   * 手动连接：health 预检通过后把地址写入已绑定助理的 endpoints 并重连。
   * 未绑定的电脑没法只靠地址连接（还缺设备密钥与绑定关系），返回可操作提示。
   */
  async connectManually(input: string, assistantId?: string): Promise<PairResult> {
    const probe = await this.probeAddress(input)
    if (!probe.ok || !probe.address) {
      return { ok: false, error: probe.message, hint: probe.hint }
    }
    const target = pickAssistantForEndpoint([...this.rows.values()], probe.computerId, assistantId)
    if (!target) {
      return {
        ok: false,
        error: '这个地址上的电脑还没有绑定到本机',
        hint: '请先在电脑上生成绑定二维码并用「扫码 / 相册选图」完成绑定，之后就能直接手动输入地址。',
      }
    }
    if (target.computerId && probe.computerId && target.computerId !== probe.computerId) {
      return {
        ok: false,
        error: '这个地址连到的是另一台电脑',
        hint: '请确认端口/域名属于这台电脑；如果换了电脑，请重新扫码绑定。',
      }
    }
    const normalized = normalizeManualAddress(input)
    const endpoint = normalized.ok ? normalized.endpoint : probe.address
    const updated: StoredAssistantRow = {
      ...target,
      endpoints: mergeManualEndpoint(target.endpoints, endpoint),
      preferredEndpoint: endpoint,
    }
    this.rows.set(updated.id, updated)
    await upsertAssistant(updated)
    this.links.get(updated.id)?.setAssistant(updated)
    this.notify()
    this.reconnectNow(updated.id)
    return { ok: true, assistantId: updated.id }
  }

  /** 每台电脑的连接方式偏好（auto/lan/tailscale/tunnel），持久化后立刻重连。 */
  async setConnectionMode(assistantId: string, mode: string): Promise<void> {
    const row = this.rows.get(assistantId)
    if (!row) return
    const next = normalizeConnectionMode(mode)
    if (row.connectionMode === next) return
    const updated: StoredAssistantRow = { ...row, connectionMode: next }
    this.rows.set(assistantId, updated)
    await upsertAssistant(updated)
    this.links.get(assistantId)?.setAssistant(updated)
    this.notify()
    this.reconnectNow(assistantId)
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
          hint: '请确认二维码没有过期，并在电脑上重新生成后再扫。也可以改用「手动连接」输入地址。',
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

  /** 手机端切换协作模式（需要电脑声明 collab-v1）。 */
  async setCollaboration(assistantId: string, on: boolean): Promise<{ ok: boolean; error?: string; hint?: string }> {
    const link = this.links.get(assistantId)
    if (!link) return { ok: false, error: '还没有建立连接', hint: '请先连上电脑再切换协作模式。' }
    if (!link.isOnline) {
      return { ok: false, error: '当前离线，暂时无法切换协作模式', hint: '等连接恢复后再试。' }
    }
    if (!link.hasCapability(CAPABILITIES.COLLAB)) {
      return {
        ok: false,
        error: '电脑端版本较旧（v2.1.0），不支持在手机上切换协作模式',
        hint: '请在电脑上的 Open Whale 页面开启协作模式，或升级电脑端插件后重试。',
      }
    }
    const sent = link.setCollaboration(on)
    if (!sent) return { ok: false, error: '发送失败，连接可能已断开', hint: '点「重连」后再试。' }
    return { ok: true }
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

  /**
   * 我在电脑端的昵称：多人协作时作为消息前缀，存在设置 KV 里并推给电脑端。
   * `assistantId` 省略时应用到所有已绑定电脑（设置页的全局输入）。
   */
  async setMyNickname(assistantId: string | undefined, nickname: string): Promise<void> {
    const trimmed = nickname.trim().slice(0, 24)
    await setSetting('device.nickname', trimmed || undefined)
    const targets = assistantId ? [assistantId] : [...this.links.keys()]
    for (const id of targets) this.links.get(id)?.renameDevice(trimmed)
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
    this.links.get(assistantId)?.setAssistant(updated)
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

  /** 进入聊天页时清零未读（同步方法，不触发未读自增循环）。 */
  markRead(assistantId: string): void {
    this.controllers.get(assistantId)?.markRead()
  }

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
      connectionMode: 'auto',
      sessionCursor: 0,
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
    if (!snapshot?.endpoint) return '未连接'
    const label = endpointLabel(snapshot.endpoint)
    return `${label} · ${snapshot.endpoint}`
  }

  /** 给定网络类型的中文标签（UI 直接调用，避免各自翻译）。 */
  endpointKindLabel(kind: string | undefined): string {
    return endpointKindLabel(kind)
  }

  get deviceIdentity(): { deviceId?: string; deviceName?: string } {
    return { deviceId: this.identity?.deviceId, deviceName: this.identity?.deviceName }
  }

  /** 设置页的“诊断”：把某个助理的离线队列吐出来。 */
  debugOutbox(assistantId: string): string {
    return JSON.stringify(this.controller(assistantId).outbox, null, 2)
  }

  /** 未读自增后延迟合并一次通知（打字/流式时避免每帧重渲染整个列表页）。 */
  setBadge(_assistantId: string): void {
    if (this.badgeTimer) return
    this.badgeTimer = setTimeout(() => {
      this.badgeTimer = undefined
      this.notify()
    }, 150)
  }

  /** 会话游标持久化（ChatController 在游标前进 300ms 后调用）。 */
  saveSessionMeta(
    assistantId: string,
    meta: { sessionId?: string; sessionEpoch?: number; sessionCursor: number },
  ): void {
    const row = this.rows.get(assistantId)
    if (!row) return
    if (
      row.sessionId === meta.sessionId &&
      row.sessionEpoch === meta.sessionEpoch &&
      (row.sessionCursor ?? 0) === meta.sessionCursor
    ) {
      return
    }
    const updated: StoredAssistantRow = {
      ...row,
      sessionId: meta.sessionId,
      sessionEpoch: meta.sessionEpoch,
      sessionCursor: meta.sessionCursor,
    }
    this.rows.set(assistantId, updated)
    void upsertAssistant(updated)
    // 让下一次 hello 带上最新游标（断点续传），避免每次都退化成全量快照。
    this.links.get(assistantId)?.setSessionCursor(meta.sessionCursor, meta.sessionId)
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
    // 协作开关/参与者这类帧不改变消息，但 UI 要立刻看到状态变化。
    if (frame.t === 'collab/state') {
      const row = this.rows.get(assistantId)
      const epoch = typeof frame.sessionEpoch === 'number' && Number.isFinite(frame.sessionEpoch) ? frame.sessionEpoch : undefined
      if (row && epoch !== undefined && row.sessionEpoch !== undefined && epoch !== row.sessionEpoch) {
        // 纪元变了 = 会话已经切换（电脑端刚广播 collab/state，紧跟 session/state 快照）。
        this.controller(assistantId).onSessionSwitch({
          sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : row.sessionId,
          sessionEpoch: epoch,
          reason: frame.on ? '已加入协作会话，正在同步聊天记录…' : '已退出协作会话，正在同步聊天记录…',
        })
        const updated: StoredAssistantRow = {
          ...row,
          sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : row.sessionId,
          sessionEpoch: epoch,
          sessionCursor: 0,
        }
        this.rows.set(assistantId, updated)
        void upsertAssistant(updated)
      }
      this.notify()
      return
    }
    if (frame.t === 'session/participants') this.notify()
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
      // 不能在这里把整条记录回灌给 link：onStatus 早于 onHelloAck 触发，会用旧的
      // sessionCursor 覆盖掉刚解析出来的 ack.eventCursor（导致每次重连都退化成全量快照）。
      // link 的 endpoints/preferred 由 onHelloAck / setConnectionMode / connectManually 显式同步。
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
    const link = this.links.get(assistantId)
    if (row) {
      const previousSession = row.sessionId
      const previousEpoch = row.sessionEpoch
      const nextSession = typeof ack.sessionId === 'string' && ack.sessionId ? ack.sessionId : row.sessionId
      const nextEpoch = typeof ack.sessionEpoch === 'number' && Number.isFinite(ack.sessionEpoch) ? ack.sessionEpoch : row.sessionEpoch
      // 会话切换：sessionId 变了，或纪元前进了（协作模式开关）。
      const switched =
        previousSession !== undefined &&
        ((nextSession !== undefined && nextSession !== previousSession) ||
          (previousEpoch !== undefined && nextEpoch !== undefined && nextEpoch !== previousEpoch))
      const mergedEndpoints = Array.from(
        new Set([
          ...(link?.snapshot.endpoint ? [link.snapshot.endpoint] : []),
          ...(Array.isArray(ack.endpoints) ? ack.endpoints : []),
          ...(Array.isArray(ack.endpointList) ? ack.endpointList.map(item => item?.url).filter(Boolean) : []),
          ...row.endpoints,
        ]),
      ).filter((endpoint): endpoint is string => typeof endpoint === 'string' && endpoint !== '')
      const updated: StoredAssistantRow = {
        ...row,
        name: row.name || ack.computerName,
        online: true,
        // 展示插件版本（2.2.0），协议版本仍是 1.1.0，不要混。
        serverVersion: ack.serverVersion ?? ack.version ?? row.serverVersion,
        lastConnectedAt: new Date().toISOString(),
        endpoints: mergedEndpoints,
        sessionId: switched ? nextSession : (nextSession ?? row.sessionId),
        sessionEpoch: nextEpoch,
        sessionCursor: switched ? 0 : row.sessionCursor,
      }
      this.rows.set(assistantId, updated)
      void upsertAssistant(updated)
      link?.setAssistant(updated)
      if (switched) {
        this.controller(assistantId).onSessionSwitch({
          sessionId: nextSession,
          sessionEpoch: nextEpoch,
          reason: ack.collaboration === false
            ? '协作会话已切换回个人会话，正在同步聊天记录…'
            : '协作会话已切换，正在同步聊天记录…',
        })
      } else if (typeof ack.eventCursor === 'number') {
        // 同一会话重连：把电脑端的 head 记下来，下次 hello 的 cursor 直接用（快照/回放由电脑端决定）。
        this.saveSessionMeta(assistantId, {
          sessionId: updated.sessionId,
          sessionEpoch: updated.sessionEpoch,
          sessionCursor: Math.max(updated.sessionCursor ?? 0, 0),
        })
      }
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
