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
  approvalAvailability,
  type ApprovalOutcome,
  type ApprovalPrompt,
} from '../core/approvals.mts'
import {
  buildQuestionReply,
  questionAvailability,
  type QuestionDraft,
  type QuestionPrompt,
} from '../core/questions.mts'
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
  exhaustedEntries,
  expireInflight,
  markFailed as markOutboxFailed,
  markInflight,
  markSent as markOutboxSent,
  markUploaded,
  pendingCount,
  releaseInflight,
  resendableEntries,
  rotateEntryIds,
  type Outbox,
  type OutboxEntry,
  type OutboxFile,
  type OutboxUploadRef,
} from '../core/outbox.mts'
import { validateQrText } from '../core/qr-image.mts'
import {
  hydrateChat,
  isKnownServerFrame,
  type ChatEffect,
  type ChatEvent,
  type ChatMessage,
  type ChatState,
  type FileRef,
  type Transfer,
} from '../core/reducer.mts'
import { sessionAvailability, type SessionListState } from '../core/sessions.mts'
import {
  PLACEHOLDER_SESSION,
  activeChat,
  emptyTabs,
  parseTabsMeta,
  pendingApprovalsElsewhere,
  restoreTabs,
  routeEvent,
  sessionOfApproval,
  sessionOfQuestion,
  tabStripModel,
  tabsMeta,
  totalUnread,
  watchSessionIds,
  type TabView,
  type TabsInput,
  type TabsState,
} from '../core/tabs.mts'
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
  /** 已打开的会话标签（打开顺序，2.4.0 持久化）。 */
  tabs?: string[]
  /** 当前显示的标签（= 这台手机绑定的会话）。 */
  activeSessionId?: string
}

export interface AssistantView {
  assistant: StoredAssistantRow
  link: LinkSnapshot
  /** 当前标签的聊天状态（v2.4.0 起一个助理可以有多个会话标签）。 */
  chat: ChatState
  power: PowerState
  /** 未确认（待发/失败）的消息条数，列表页用来提示。 */
  pendingMessages: number
  /** 正在下载的文件数。 */
  activeTransfers: number
  /** 电脑上会话列表（「全部会话」面板的数据源；没拉过就是 undefined）。 */
  sessions: SessionListState | undefined
  /** 等待手机回答的 DSH 权限请求（多条并存，不会互相覆盖）。 */
  approvals: ApprovalPrompt[]
  /** 等待手机回答的结构化提问（3.0.0，与审批并列排队）。 */
  questions: QuestionPrompt[]
  /** 未读消息数（进入聊天页调用 markRead 清零）。 */
  unread: number
  /** 每台电脑持久化的连接方式。 */
  connectionMode: string
  /** 当前线路的人类可读标签（例如「Tailscale」）。 */
  endpointLabel: string
  /** 标签页容器（tabs / activeSessionId / chats / activity）。 */
  tabs: TabsState
  /** 标签条的渲染模型（顺序 = 打开顺序）。 */
  tabViews: TabView[]
  /** 电脑端是否声明了 `session-tabs-v1`；没有就退回 v2.3.0 单会话行为。 */
  tabsSupported: boolean
  /** 其它标签里排队的审批总数（标签条上的角标）。 */
  otherApprovals: number
  /** 恢复时被丢弃的标签提示（已经不在电脑上的会话）。 */
  tabsNotice?: string
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

/** 每个助理一个：多会话标签容器 + 离线队列 + 文件组装缓冲。 */
class ChatController {
  readonly assistantId: string
  /** 多会话容器；`chat` 是它的只读视图（当前标签）。 */
  tabs: TabsState
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
  private pendingWrites = new Map<string, { message: ChatMessage; sessionId: string }>()
  private persistedTransfers: Record<string, Transfer> = {}
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private tabsTimer: ReturnType<typeof setTimeout> | undefined
  /** 每秒检查「发出去了但一直没 ack」的条目（见 core/outbox.mts 的 expireInflight）。 */
  private ackTimer: ReturnType<typeof setInterval> | undefined
  private persistedTabs = ''
  /** 上次自动拉会话列表的时间（重连风暴时的节流）。 */
  private lastListRequestAt = 0
  private sendChain: Promise<void> = Promise.resolve()
  private lastSend: { key: string; at: number; rid: string } | undefined
  private pumping = false
  private pumpRequested = false
  private disposed = false

  constructor(store: AppStore, assistantId: string) {
    this.store = store
    this.assistantId = assistantId
    this.tabs = emptyTabs(assistantId)
  }

  /** 当前标签的聊天状态。 */
  get chat(): ChatState {
    return activeChat(this.tabs)
  }

  attach(link: AssistantLink | undefined): void {
    this.link = link
  }

  /**
   * 从 SQLite 恢复：标签（v2.4.0 持久化）、每个标签自己的消息、传输与离线队列。
   *
   * 消息按 `session_id` 分开读；升级前的老库没有这一列，那些行的
   * `session_id IS NULL`，只归给当前绑定的会话（否则升级后同一批历史会出现在
   * 每一个标签里）。
   */
  async load(): Promise<void> {
    const row = this.store.assistantRow(this.assistantId)
    const transfers = await loadTransfers(this.assistantId)
    const outbox = await loadOutbox(this.assistantId)
    const meta = parseTabsMeta(JSON.stringify({ tabs: row.tabs, activeSessionId: row.activeSessionId }))
    let state = restoreTabs(this.assistantId, meta, row.sessionId)
    const now = Date.now()
    // 还没有任何会话（首次绑定/还没连过）时，历史消息属于占位标签。
    const targets = state.tabs.length > 0 ? state.tabs : [PLACEHOLDER_SESSION]

    for (const id of targets) {
      const placeholder = id === PLACEHOLDER_SESSION
      // 升级前的老库没有 session_id：那些历史只归给当前绑定的会话，不能出现在每个标签里。
      const legacy = !placeholder && id === state.activeSessionId
      const messages = await loadMessages(this.assistantId, placeholder ? undefined : id, 400, legacy)
      let chat = hydrateChat(this.assistantId, messages, transfers, now)
      chat = { ...chat, sessionId: placeholder ? row.sessionId : id }
      if (id === state.activeSessionId) {
        // 游标/纪元只对当前绑定的会话有意义（hello 带的就是它）。
        chat = {
          ...chat,
          sessionEpoch: row.sessionEpoch,
          sessionCursor: typeof row.sessionCursor === 'number' ? row.sessionCursor : 0,
        }
      }
      state = { ...state, chats: { ...state.chats, [id]: chat } }
    }
    this.tabs = state
    this.persistedTabs = JSON.stringify(tabsMeta(this.tabs))
    this.persistedTransfers = { ...allTransfers(this.tabs) }
    // 重启后“飞行中”的条目必须退回 pending，否则它们永远不会被重发。
    this.outbox = releaseInflight(outbox)
    // 反复重启/断线也可能把自动重试次数耗光：这些条目要显式标成「用尽」。
    this.markExhausted()
    await saveOutbox(this.assistantId, this.outbox)
    // 老库（2.3.0）没有 tabs 列：把默认标签立刻落盘，下次启动就是完整的了。
    this.persistedTabs = ''
    this.persistTabs(true)
    this.ensureAckTicker()
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

  /**
   * 连接断开：把未确认消息退回队列，标记流式中断，停掉进行中的上传。
   * 容器会把 `conn/disconnected` 应用到**每一个**标签：切走的会话里还在流的回答
   * 同样要标成"可能不完整"，审批卡也同样失效。
   */
  onDisconnected(): void {
    this.uploader?.abortAll('网络已断开，上传中断')
    this.dispatch({ t: 'conn/disconnected', at: Date.now() })
    this.outbox = releaseInflight(this.outbox)
    this.markExhausted()
    void saveOutbox(this.assistantId, this.outbox)
    this.ensureAckTicker()
  }

  /**
   * 把「自动重发次数已经用尽」的条目标成 failed 并通知 UI。
   *
   * 两条路径会走到这里：断线 releaseInflight（每次断线算一次未确认发送）和启动时
   * 的 releaseInflight。以前这些条目只会被 `resendableEntries` 过滤掉、永远不会再
   * 发，也不会告诉用户 —— 表现就是「这条消息就那样消失了」。现在它们在气泡上显示
   * 「重试用尽」，用户可以手动重新发送（换新的 msgId）。
   */
  private markExhausted(): void {
    const due = exhaustedEntries(this.outbox, DEFAULT_MAX_ATTEMPTS).filter(entry => entry.state !== 'failed')
    if (due.length === 0) return
    const at = Date.now()
    for (const entry of due) {
      const reason = `已连续 ${DEFAULT_MAX_ATTEMPTS} 次发送都没有被电脑端确认，自动重试已用尽`
      this.outbox = markOutboxFailed(this.outbox, entry.rid, reason, undefined)
      this.dispatch({
        t: 'outbox/failed',
        rid: entry.rid,
        reason,
        retryable: true,
        exhausted: true,
        attempts: entry.attempts,
        at,
      })
    }
  }

  onConnected(): void {
    this.dispatch({ t: 'conn/connected', at: Date.now() })
    this.pumpOutbox()
    // 电脑端不记得上一次的订阅：重连后必须重新发一次 session/watch（契约 §2）。
    this.syncWatch()
  }

  /**
   * 电脑端把绑定会话切走了（桌面端换了一个会话，或 hello/ack 里 sessionId/纪元变了）。
   * 标签页模式下不要清空整个页面：激活对应标签，只重新拉它自己的快照。
   */
  onSessionSwitch(info: { sessionId?: string; sessionEpoch?: number; reason?: string }): void {
    const at = Date.now()
    const hasId = typeof info.sessionId === 'string' && info.sessionId !== ''
    if (hasId) {
      // 激活会走 syncTabFrames：session/select + session/snapshot 都已发出。
      this.dispatch({ t: 'tabs/activate', sessionId: info.sessionId as string, at })
    }
    this.dispatch({
      t: 'session/reset',
      sessionId: info.sessionId,
      sessionEpoch: info.sessionEpoch,
      reason: info.reason,
      at,
    })
    // 只有纪元变了（没给 sessionId）时才需要自己补一次快照；否则上面已经发过了。
    if (!hasId && this.link?.isOnline) {
      const id = this.tabs.activeSessionId
      if (id) this.link.requestSessionSnapshot(id)
    }
  }

  /**
   * 本地每秒节拍：权限请求过期后必须自己消失。
   * 电脑端到点会把提示交回桌面，之后不会再有任何帧告诉手机“这条已经不用答了”。
   * v2.4.0 要**所有**标签都扫一遍，否则切走后那条卡会一直挂在那里。
   */
  tickApprovals(): void {
    const any = Object.values(this.tabs.chats).some(
      chat => (chat?.approvals.length ?? 0) > 0 || (chat?.questions.length ?? 0) > 0,
    )
    if (!any) return
    this.dispatch({ t: 'tabs/tick', at: Date.now() })
  }

  /** 是否有任何一个标签在等审批/提问（AppStore 用它决定要不要起每秒节拍）。 */
  hasApprovals(): boolean {
    return Object.values(this.tabs.chats).some(
      chat => (chat?.approvals.length ?? 0) > 0 || (chat?.questions.length ?? 0) > 0,
    )
  }

  /**
   * 手机已经作答：本地先撤掉卡片。
   * 电脑端通常也会推 `approval/resolved`，但那一条不保证会到（超时/换连接都可能丢），
   * 等它才撤会让用户对着一个已经答过的按钮发呆。reducer 里 resolved 是幂等的。
   */
  ackApproval(approvalId: string, outcome: 'allowed-once' | 'rejected'): void {
    // 审批卡可能属于任何一个标签：把 resolved 送进它真正的会话，别误删别的标签的卡。
    const owner = sessionOfApproval(this.tabs, approvalId)
    this.dispatch({
      t: 'approval/resolved',
      sessionId: owner,
      approvalId,
      outcome,
      source: 'phone',
      at: Date.now(),
    })
  }

  /** 手机已经答完一条提问：本地先撤掉卡片（resolved 幂等，电脑端还会再推一次）。 */
  ackQuestion(questionId: string): void {
    const owner = sessionOfQuestion(this.tabs, questionId)
    this.dispatch({
      t: 'question/resolved',
      sessionId: owner,
      questionId,
      outcome: 'answered',
      source: 'phone',
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

  /**
   * 「重新发送」——必须是**新的 msgId**。
   *
   * 电脑端按 `(deviceId, msgId)` 去重，用旧 msgId 重发会被判成重放、只回一个
   * duplicate ack：按钮看起来动了，电脑端其实什么都没执行。所以：
   *  * 队列里还有这条消息（没 ack 过）→ 就地换一个新 msgId，气泡复用；
   *  * 已经确认过 / 不在队列里 → 当作一条新消息再发一次（新 rid + 新 msgId）。
   *
   * 自动重发（ack 超时、断线 release）**不走这里**：那些路径沿用原 msgId，
   * 靠电脑端的幂等表防止「其实已送达、只是回执丢了」的消息被注入两次。
   */
  async resend(messageId: string): Promise<void> {
    const message = this.chat.messages.find(item => item.id === messageId)
    if (!message || message.kind !== 'user') return
    const rid = message.rid ?? message.msgId
    const entry = rid
      ? this.outbox.entries.find(item => item.rid === rid || item.msgId === rid)
      : undefined
    if (entry) {
      this.outbox = rotateEntryIds(this.outbox, entry.rid, { msgId: randomRequestId('msg'), rid: entry.rid })
      // 本地气泡按 rid 找回（id = usr_<rid>），于是同一条气泡回到「发送中」。
      this.dispatch({ t: 'outbox/retry', rid: entry.rid, at: Date.now() })
      await saveOutbox(this.assistantId, this.outbox)
      this.ensureAckTicker()
      this.pumpOutbox()
      return
    }
    // 已经 ack 过：再发一次就是一条全新的消息，不能复用旧 msgId。
    const text = message.text.trim()
    if (text === '') return
    await this.send({ text })
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
    const transfer = this.transferOf(fileId)
    if (!transfer) return
    if (!transfer.localPath) {
      this.requestFile(fileId)
      return
    }
    await openWithSystem(transfer.localPath, transfer.name, transfer.mime)
  }

  snapshot(): AssistantView {
    const row = this.store.assistantRow(this.assistantId)
    const supportsTabs = this.link?.hasCapability(CAPABILITIES.SESSION_TABS) === true
    const transfers = allTransfers(this.tabs)
    return {
      assistant: row,
      link: this.link?.snapshot ?? OFFLINE_LINK,
      chat: this.chat,
      power: this.power,
      pendingMessages: pendingCount(this.outbox),
      activeTransfers: Object.values(transfers).filter(
        transfer => transfer.status === 'downloading' || transfer.status === 'queued',
      ).length,
      sessions: this.tabs.sessionList,
      approvals: this.chat.approvals,
      questions: this.chat.questions,
      // 未读 = 当前标签的助理级未读 + 后台标签的未读（activity 只在非当前标签累加）。
      unread: this.unread + totalUnread(this.tabs),
      connectionMode: normalizeConnectionMode(row.connectionMode),
      endpointLabel: this.link?.snapshot.endpoint ? endpointLabel(this.link.snapshot.endpoint) : '未连接',
      tabs: this.tabs,
      tabViews: tabStripModel(this.tabs),
      tabsSupported: supportsTabs,
      otherApprovals: pendingApprovalsElsewhere(this.tabs),
      tabsNotice:
        this.tabs.droppedTabs.length > 0
          ? `${this.tabs.droppedTabs.length} 个会话已经不在电脑上，相关标签已关闭。`
          : undefined,
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    if (this.tabsTimer) clearTimeout(this.tabsTimer)
    if (this.ackTimer) clearInterval(this.ackTimer)
    this.flushTimer = undefined
    this.cursorTimer = undefined
    this.tabsTimer = undefined
    this.ackTimer = undefined
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

  /**
   * ack 超时节拍。
   *
   * 只在这些情况下需要它：还有 `inflight`（已发出、等回执）或带 `retryAfter`
   * 的待重发条目。没有就停掉，避免常驻定时器耗电。
   */
  private ensureAckTicker(): void {
    const needs = this.outbox.entries.some(
      entry =>
        entry.state === 'inflight' ||
        (entry.state === 'pending' && typeof entry.retryAfter === 'number' && entry.retryAfter > Date.now()),
    )
    if (needs && !this.ackTimer) {
      this.ackTimer = setInterval(() => this.checkAckTimeouts(), 1_000)
    }
    if (!needs && this.ackTimer) {
      clearInterval(this.ackTimer)
      this.ackTimer = undefined
    }
  }

  /**
   * 检查「发出去了但一直没有 chat/ack」的条目。
   *
   * 半死连接（TCP 还在、帧已经被丢掉）不会触发 onclose，于是 inflight 会永远留着，
   * UI 上就是一条永远「发送中…」的消息。这里按 ACK_TIMEOUT_MS 兜底：
   * 有配额 → 退回 pending 自动重发（同一 msgId，电脑端幂等表会挡住重复注入）；
   * 没配额 → 标失败并标记「重试用尽」，交给用户手动「重新发送」（换新 msgId）。
   */
  private checkAckTimeouts(): void {
    if (this.disposed) return
    const now = Date.now()
    const result = expireInflight(this.outbox, { now, maxAttempts: DEFAULT_MAX_ATTEMPTS })
    if (result.outbox !== this.outbox) {
      this.outbox = result.outbox
      void saveOutbox(this.assistantId, this.outbox)
      for (const entry of result.exhausted) {
        this.dispatch({
          t: 'outbox/failed',
          rid: entry.rid,
          reason: entry.error ?? '发送失败',
          retryable: true,
          exhausted: true,
          attempts: entry.attempts,
          at: now,
        })
      }
      if (result.exhausted.length === 0) this.store.notify()
    }
    // 退避到点的条目在这里补一次 pump（ack 超时路径不经过 runPump，否则会一直等着）。
    if (resendableEntries(this.outbox, { now, maxAttempts: DEFAULT_MAX_ATTEMPTS }).length > 0) {
      this.pumpOutbox()
    }
    this.ensureAckTicker()
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
            // 用户可能在上传期间点了「重新发送」（换过 msgId）：以队列里最新的幂等键为准。
            const sent = currentLink.sendChat({
              rid: entry.rid,
              msgId: latest?.msgId ?? entry.msgId ?? entry.rid,
              text: entry.text,
              files: files.length > 0 ? files : undefined,
            })
            if (!sent) break
            this.outbox = markInflight(this.outbox, entry.rid, Date.now())
            this.ensureAckTicker()
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

  /**
   * 统一的 reducer 出口。
   *
   * 事件先经过标签容器路由（`routeEvent`）——决定它属于哪个会话、标签条上的
   * 未读/运行怎么变——再对**那个会话**的 ChatState 跑 reducer。所以切走的会话
   * 收到的流式输出会进它自己的标签，不会污染当前会话。
   */
  private dispatch(event: TabsInput): void {
    const at = Date.now()
    const beforeChats = this.tabs.chats
    const beforeActive = this.tabs.activeSessionId
    const beforePersistedTabs = JSON.stringify(tabsMeta(this.tabs))
    const beforeCursor = this.chat.sessionCursor
    const result = routeEvent(this.tabs, event, at)
    this.tabs = result.state
    this.runEffects(result.effects)

    for (const id of result.touched) {
      const before = beforeChats[id]
      const after = this.tabs.chats[id]
      if (!after) continue
      this.persistMessageDiff(before?.messages ?? [], after.messages, id)
      this.persistTransferDiff(before?.transfers ?? {}, after.transfers)
    }
    // 未读角标（助理列表页）：新出现的助手回复计入当前标签；后台标签由 activity 计。
    if (result.target !== undefined && result.target === this.tabs.activeSessionId) {
      const target = this.tabs.chats[result.target]
      if (target) {
        const beforeIds = new Set((beforeChats[result.target]?.messages ?? []).map(message => message.id))
        this.bumpUnread(beforeIds, target.messages)
      }
    }
    if (this.chat.sessionCursor !== beforeCursor) this.scheduleCursorPersist()
    const afterPersistedTabs = JSON.stringify(tabsMeta(this.tabs))
    const tabsChanged = afterPersistedTabs !== beforePersistedTabs
    if (result.activeChanged) {
      // 切换标签：select + snapshot + 重新订阅其余标签。
      this.onActiveTabChanged()
    } else if (tabsChanged || beforeActive !== this.tabs.activeSessionId) {
      // 只是打开/关闭/丢弃了标签：绑定会话没变，但后台订阅集合变了。
      this.syncTabFrames(false)
    }
    if (tabsChanged) this.persistTabs()
    this.store.notify()
    // 消息状态可能刚变成 failed/exhausted：ack 节拍要不要继续跑由队列状态决定。
    this.ensureAckTicker()
  }

  // ---------------------------------------------------------------------------
  // 标签页（2.4.0）
  // ---------------------------------------------------------------------------

  /** 切到某个标签：本地缓存立即渲染，然后补一次快照（电脑端不重发历史）。 */
  activate(sessionId: string): void {
    if (!sessionId || sessionId === this.tabs.activeSessionId) return
    this.dispatch({ t: 'tabs/activate', sessionId, at: Date.now() })
  }

  /** 打开一个标签（不切换；已经在标签条里就只是激活）。 */
  open(sessionId: string): void {
    if (!sessionId) return
    this.dispatch({ t: 'tabs/open', sessionId, at: Date.now() })
    this.activate(sessionId)
  }

  /** 关闭标签：只关本地；关的是当前标签就切到相邻的并把它绑给电脑端。 */
  close(sessionId: string): void {
    if (!sessionId) return
    this.dispatch({ t: 'tabs/close', sessionId, at: Date.now() })
  }

  dismissTabsNotice(): void {
    this.dispatch({ t: 'tabs/notice-clear', at: Date.now() })
  }

  /**
   * 活跃标签变化后的三件事：
   *  1. `session/select`：让接下来的 `chat/send` 发往这个会话（电脑端不会释放旧会话的 agent）；
   *  2. `session/snapshot`：只要状态，不重放历史，切过去是瞬时的；
   *  3. `session/watch`：重新算"哪些标签要继续在后台收事件"。
   * 电脑端没有 `session-tabs-v1` 时只发 select（v2.3.0 行为）。
   */
  private onActiveTabChanged(): void {
    this.syncTabFrames(true)
  }

  private syncTabFrames(activated: boolean): void {
    const link = this.link
    if (!link || !link.isOnline) return
    const supported = link.hasCapability(CAPABILITIES.SESSION_TABS)
    if (supported) link.sendSessionWatch(watchSessionIds(this.tabs))
    const active = this.tabs.activeSessionId
    if (!active || active === PLACEHOLDER_SESSION) return
    if (activated) {
      link.selectSession(active)
      if (supported) link.requestSessionSnapshot(active)
      // 绑定会话变了：下一次 hello 要带新的 sessionId + 游标 0。
      this.store.saveSessionMeta(this.assistantId, {
        sessionId: active,
        sessionEpoch: this.chat.sessionEpoch,
        sessionCursor: 0,
      })
    }
  }

  /** 连接建立后补发一次 `session/watch`（电脑端不记得上次的订阅）。 */
  syncWatch(): void {
    const link = this.link
    if (!link || !link.isOnline) return
    const active = this.tabs.activeSessionId
    // 离线时用户可能切过标签：hello 带上去的还是旧绑定。这里补一次 session/select，
    // 否则重连后 `chat/send` 会发到上一个会话里去。
    if (active && active !== PLACEHOLDER_SESSION && link.snapshot.sessionId !== undefined && active !== link.snapshot.sessionId) {
      link.selectSession(active)
      this.store.saveSessionMeta(this.assistantId, {
        sessionId: active,
        sessionEpoch: this.chat.sessionEpoch,
        sessionCursor: 0,
      })
      if (link.hasCapability(CAPABILITIES.SESSION_TABS)) link.requestSessionSnapshot(active)
    }
    // 恢复出来的标签要有标题和 live 状态，而且"电脑上已经删掉的会话"必须能被发现：
    // 每次连接最多拉一次列表（重连风暴时不至于把 socket 刷满）。
    const now = Date.now()
    if (this.tabs.tabs.length > 0 && now - this.lastListRequestAt > 5_000 && link.hasCapability(CAPABILITIES.SESSIONS)) {
      this.lastListRequestAt = now
      link.requestSessionList()
    }
    if (!link.hasCapability(CAPABILITIES.SESSION_TABS)) return
    link.sendSessionWatch(watchSessionIds(this.tabs))
  }

  /** 当前显示在哪个标签（store 的 UI 方法用它）。 */
  get activeSessionId(): string {
    return this.tabs.activeSessionId
  }

  get tabViews(): TabView[] {
    return tabStripModel(this.tabs)
  }

  /** 标签（tabs + activeSessionId）落库，300ms 合并一次。 */
  private persistTabs(immediate = false): void {
    const snapshot = JSON.stringify(tabsMeta(this.tabs))
    if (snapshot === this.persistedTabs) return
    if (!immediate && this.tabsTimer) {
      clearTimeout(this.tabsTimer)
      this.tabsTimer = setTimeout(() => {
        this.tabsTimer = undefined
        this.persistTabs(true)
      }, 300)
      return
    }
    this.persistedTabs = snapshot
    this.store.saveTabsMeta(this.assistantId, JSON.parse(snapshot) as { tabs: string[]; activeSessionId: string })
  }

  private runEffects(effects: Array<ChatEffect & { sessionId?: string }>): void {
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
          // 只有当前绑定会话的游标才有意义（hello 带的是它），后台标签的快照不写库。
          if (effect.sessionId === undefined || effect.sessionId === this.tabs.activeSessionId) {
            if (effect.cursor >= this.chat.sessionCursor && effect.cursor > 0) {
              // reducer 已经把游标写进 state；这里只保证一定落库。
              this.scheduleCursorPersist()
            }
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
    const transfer = this.transferOf(fileId)
    const sink = await createDownloadSink({
      fileId,
      name: transfer?.name ?? fileId,
      size: transfer?.size ?? 0,
    })
    this.sinks.set(fileId, sink)
    return sink
  }

  /** 文件属于哪个标签：传输可能是在别的标签里发起的（切走后下载不该断）。 */
  private transferOf(fileId: string): Transfer | undefined {
    for (const chat of Object.values(this.tabs.chats)) {
      const transfer = chat?.transfers[fileId]
      if (transfer) return transfer
    }
    return undefined
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
      const transfer = this.transferOf(fileId)
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
  private persistMessageDiff(before: ChatMessage[], after: ChatMessage[], sessionId: string): void {
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
        this.queueMessageWrite(message, message.streaming !== true, sessionId)
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

  /** 未读计数：新出现的助手消息才 +1（流式增量不重复计数）。 */
  private bumpUnread(beforeIds: Set<string>, after: ChatMessage[]): void {
    let added = 0
    for (const message of after) {
      if (beforeIds.has(message.id)) continue
      // v2.3.0 起每台手机只驱动自己的会话，用户消息永远是本机发的：只算助手回复。
      if (message.kind === 'assistant' && message.fileOffer !== true) added += 1
    }
    if (added > 0) {
      this.unread += added
      this.store.setBadge(this.assistantId)
    }
  }

  private queueMessageWrite(message: ChatMessage, immediate: boolean, sessionId: string): void {
    this.pendingWrites.set(message.id, { message, sessionId })
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
    const pending = [...this.pendingWrites.values()]
    this.pendingWrites.clear()
    // 一条 SQL 只带一个 session_id：不同标签的消息分开批量写。
    const bySession = new Map<string, ChatMessage[]>()
    for (const entry of pending) {
      const bucket = bySession.get(entry.sessionId)
      if (bucket) bucket.push(entry.message)
      else bySession.set(entry.sessionId, [entry.message])
    }
    for (const [sessionId, messages] of bySession) {
      const key = sessionId === PLACEHOLDER_SESSION ? undefined : sessionId
      if (messages.length === 1) await saveMessage(this.assistantId, key, messages[0] as ChatMessage)
      else await saveMessages(this.assistantId, key, messages)
    }
  }

  /** 会话游标落库：合并 300ms 内的多次变化，避免每条事件写一次 SQLite。 */
  private scheduleCursorPersist(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined
      const active = this.tabs.activeSessionId
      this.store.saveSessionMeta(this.assistantId, {
        sessionId: active === PLACEHOLDER_SESSION ? this.chat.sessionId : active,
        sessionEpoch: this.chat.sessionEpoch,
        sessionCursor: this.chat.sessionCursor,
      })
    }, 300)
  }
}

/** 所有标签的传输表合并成一份（下载计数、文件卡片查找用）。 */
function allTransfers(tabs: TabsState): Record<string, Transfer> {
  const out: Record<string, Transfer> = {}
  for (const chat of Object.values(tabs.chats)) {
    if (!chat) continue
    for (const [fileId, transfer] of Object.entries(chat.transfers)) out[fileId] = transfer
  }
  return out
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
  /** 权限请求的每秒节拍（倒计时 + 过期后自动撤卡片）。 */
  private approvalTicker: ReturnType<typeof setInterval> | undefined
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

  /**
   * 打开会话列表：离线或电脑端不支持 `sessions-v1` 时**不**发帧，直接给可操作提示。
   * 返回的 ok 只表示“请求已发出”，列表本身通过 `sessions` 帧异步回来。
   */
  async listSessions(assistantId: string): Promise<{ ok: boolean; error?: string; hint?: string }> {
    const link = this.links.get(assistantId)
    const gate = sessionAvailability(link?.isOnline === true, link?.capabilityList)
    if (!gate.ok) return { ok: false, error: gate.error, hint: gate.hint }
    if (!link) return { ok: false, error: '还没有建立连接', hint: '请先连上电脑。' }
    const sent = link.requestSessionList()
    if (!sent) return { ok: false, error: '发送失败，连接可能已断开', hint: '点「重连」后再试。' }
    return { ok: true }
  }

  /** 选中一个会话：电脑端会回 `session/selected` + 一份 `session/state` 快照。 */
  async selectSession(assistantId: string, sessionId: string): Promise<{ ok: boolean; error?: string; hint?: string }> {
    if (!sessionId) return { ok: false, error: '这个会话没有 id，无法打开', hint: '刷新列表后再选一次。' }
    const link = this.links.get(assistantId)
    const gate = sessionAvailability(link?.isOnline === true, link?.capabilityList)
    if (!gate.ok) return { ok: false, error: gate.error, hint: gate.hint }
    if (!link) return { ok: false, error: '还没有建立连接', hint: '请先连上电脑。' }
    const sent = link.selectSession(sessionId)
    if (!sent) return { ok: false, error: '发送失败，连接可能已断开', hint: '点「重连」后再试。' }
    return { ok: true }
  }

  /** 新建会话并绑定这台手机。 */
  async createSession(assistantId: string): Promise<{ ok: boolean; error?: string; hint?: string }> {
    const link = this.links.get(assistantId)
    const gate = sessionAvailability(link?.isOnline === true, link?.capabilityList)
    if (!gate.ok) return { ok: false, error: gate.error, hint: gate.hint }
    if (!link) return { ok: false, error: '还没有建立连接', hint: '请先连上电脑。' }
    const sent = link.createSession()
    if (!sent) return { ok: false, error: '发送失败，连接可能已断开', hint: '点「重连」后再试。' }
    return { ok: true }
  }

  // ---------------------------------------------------------------------------
  // 会话标签页（2.4.0）
  // ---------------------------------------------------------------------------

  /** 点标签：即时切换（本地缓存先渲染），随后补快照。 */
  activateTab(assistantId: string, sessionId: string): void {
    this.controller(assistantId).activate(sessionId)
  }

  /** 从「全部会话」里打开一个会话作为标签；已经打开过就是切换。 */
  openSessionTab(assistantId: string, sessionId: string): void {
    this.controller(assistantId).open(sessionId)
  }

  /** 关闭标签（只关本地；当前标签被关时切到相邻的并重新绑定）。 */
  closeTab(assistantId: string, sessionId: string): void {
    this.controller(assistantId).close(sessionId)
  }

  /** 关掉「有会话已经不在电脑上」的提示。 */
  dismissTabsNotice(assistantId: string): void {
    this.controller(assistantId).dismissTabsNotice()
  }

  /**
   * 标签的持久化出口（ChatController 在 tabs/activeSessionId 变化 300ms 后调用）。
   * 只写本地偏好，不碰连接/游标字段——那些有自己的写入路径。
   */
  saveTabsMeta(assistantId: string, meta: { tabs: string[]; activeSessionId: string }): void {
    const row = this.rows.get(assistantId)
    if (!row) return
    const sameTabs = JSON.stringify(row.tabs ?? []) === JSON.stringify(meta.tabs)
    if (sameTabs && (row.activeSessionId ?? '') === meta.activeSessionId) return
    const updated: StoredAssistantRow = { ...row, tabs: meta.tabs, activeSessionId: meta.activeSessionId }
    this.rows.set(assistantId, updated)
    void upsertAssistant(updated)
  }

  /**
   * 回答一条权限请求。
   *
   * 手机端**不发假帧**：离线或电脑端没有 `approval-v1` 时直接拒绝并说明原因
   * （电脑端到点会把提示交回桌面，用户仍能在电脑上处理）。
   */
  replyApproval(
    assistantId: string,
    approvalId: string,
    outcome: ApprovalOutcome,
  ): { sent: boolean; error?: string; hint?: string } {
    const link = this.links.get(assistantId)
    const gate = approvalAvailability(link?.isOnline === true, link?.capabilityList)
    if (!gate.ok) return { sent: false, error: gate.error, hint: gate.hint }
    if (!link) return { sent: false, error: '还没有建立连接' }
    const sent = link.replyApproval(approvalId, outcome)
    if (!sent) return { sent: false, error: '发送失败，连接可能已断开', hint: '点「重连」后再试。' }
    // 发出去了就立刻撤卡片（乐观更新；resolved 帧到达时是幂等的）。
    this.controller(assistantId).ackApproval(approvalId, outcome)
    this.notify()
    return { sent: true }
  }

  /**
   * 回答一条结构化提问（3.0.0）。
   *
   * 与审批一样**不发假帧**：离线或电脑端没有 `questions-v1` 时直接拒绝并说明原因。
   * 草稿 → 回包的拼装与校验都在 `core/questions.mts`，这里只负责路由和乐观撤卡。
   */
  answerQuestion(
    assistantId: string,
    questionId: string,
    draft: QuestionDraft,
  ): { sent: boolean; error?: string; hint?: string } {
    const link = this.links.get(assistantId)
    const gate = questionAvailability(link?.isOnline === true, link?.capabilityList)
    if (!gate.ok) return { sent: false, error: gate.error, hint: gate.hint }
    if (!link) return { sent: false, error: '还没有建立连接' }
    const owner = sessionOfQuestion(this.tabs, questionId)
    const prompt: QuestionPrompt | undefined = owner
      ? this.tabs.chats[owner]?.questions.find(item => item.questionId === questionId)
      : undefined
    if (!prompt) return { sent: false, error: '这个问题已经失效了', hint: '等电脑重新发起，或直接在电脑上回答。' }
    const frame = buildQuestionReply(prompt, draft)
    if (!frame) return { sent: false, error: '答案不完整', hint: '每个问题都要有答案（跳过也要显式提交）。' }
    if (!link.replyQuestion(frame)) return { sent: false, error: '发送失败，连接可能已断开', hint: '点「重连」后再试。' }
    this.controller(assistantId).ackQuestion(questionId)
    this.notify()
    return { sent: true }
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
    this.ensureApprovalTicker()
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
    // 会话选择器：列表到手就通知 UI；选中成功要把“上次的会话”落盘（重启后恢复）。
    if (frame.t === 'sessions') {
      this.controller(assistantId).onFrame(frame)
      this.notify()
      return
    }
    if (frame.t === 'session/selected') {
      this.controller(assistantId).onFrame(frame)
      if (frame.ok !== false) {
        const row = this.rows.get(assistantId)
        const sessionId = typeof frame.sessionId === 'string' && frame.sessionId ? frame.sessionId : row?.sessionId
        const sessionEpoch = typeof frame.sessionEpoch === 'number' && Number.isFinite(frame.sessionEpoch)
          ? frame.sessionEpoch
          : row?.sessionEpoch
        if (row) {
          const updated: StoredAssistantRow = { ...row, sessionId, sessionEpoch, sessionCursor: 0 }
          this.rows.set(assistantId, updated)
          void upsertAssistant(updated)
        }
        // 下一次 hello 带上新会话 + 游标 0（让电脑端重新给快照）。
        this.links.get(assistantId)?.setSessionCursor(0, sessionId)
      }
      this.notify()
      return
    }
    // 权限请求：ask 要给用户看见（并启动倒计时节拍），resolved 要撤掉卡片。
    if (
      frame.t === 'approval/ask' ||
      frame.t === 'approval/resolved' ||
      frame.t === 'question/ask' ||
      frame.t === 'question/resolved'
    ) {
      this.controller(assistantId).onFrame(frame)
      this.ensureApprovalTicker()
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
      // 会话切换：sessionId 变了，或纪元前进了（电脑端换了绑定会话）。
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
        // 展示插件版本（2.3.0），协议版本现在是 1.2.0，两者不要混。
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
          reason: '会话已在电脑端切换，正在同步聊天记录…',
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

  /**
   * 权限请求的每秒节拍。
   *
   * 有两个作用，缺一不可：
   *  1. 卡片上的倒计时（`0:42`）每秒要走动；
   *  2. 到点后必须**自己消失**——电脑端超时会把提示交回桌面，不会再发帧告诉手机。
   * 没有待答请求就停掉定时器，不空转耗电。
   */
  private ensureApprovalTicker(): void {
    // 注意：后台标签里的审批同样有倒计时，同样会过期，不能只看当前标签。
    const anyPending = [...this.controllers.values()].some(controller => controller.hasApprovals())
    if (anyPending && !this.approvalTicker) {
      this.approvalTicker = setInterval(() => {
        for (const controller of this.controllers.values()) controller.tickApprovals()
      }, 1000)
    }
    if (!anyPending && this.approvalTicker) {
      clearInterval(this.approvalTicker)
      this.approvalTicker = undefined
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
