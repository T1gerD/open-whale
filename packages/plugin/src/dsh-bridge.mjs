// The DSH-facing half of Open Whale.
//
// Responsibilities, in order of importance:
//  1. Give each paired phone its own durable DSH conversation (agent + session),
//     so the phone keeps one continuous chat and never collides with the
//     conversations the user has open on the desktop.
//  2. Turn DSH's event stream into the small vocabulary the phone speaks
//     (message / done / tool / typing / error), and collect files it may fetch.
//  3. Inject the personal-assistant voice as a *scoped* prompt section on those
//     conversations only.
//
// It deliberately talks to DSH through the injected context instead of importing
// harness internals, so the same file can be exercised in tests with a fake ctx.
//
// v2.2.0 fixes two reported defects here:
//  · 助手回复重复拼接：一条 `assistant/message` 只归约一次（按 DSH 的 messageId
//    去重），而不是按会话里的设备循环累加；`assistant/attempt` 与 message 对
//    同一 (turn, step) 只算一次。
//  · 多端不同步：事件带 `sessionId`，由网关广播给会话内所有设备；设备在 hello
//    认证后即 `attachDevice()`，不必先发言才能收到推送。
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { IdempotencyCache } from './protocol.mjs'
import { assistantVoiceSection, VOICE_SECTION_NAME, VOICE_SECTION_ORDER } from './voice.mjs'

/** Tools whose results are files rather than text. */
const FILE_TOOL_HINTS = ['write', 'image', 'docx', 'xlsx', 'pptx', 'pdf', 'export', 'render', 'download']

/**
 * @typedef {object} BridgeEvent
 * One event for the gateway to fan out. `sessionId` is the conversation the
 * event belongs to; the gateway broadcasts chat-level frames to every device in
 * that conversation (v2.2.0 multi-device sync) and only the bridge knows which
 * conversation DSH just spoke in.
 * @property {'message'|'delta'|'done'|'tool'|'typing'|'error'} kind
 * @property {string} sessionId
 * @property {string} deviceId   The device whose turn produced the event.
 * @property {string} callId
 * @property {string} [messageId] Stable DSH assistant message id (`kind:'message'`).
 * @property {number} [index]    Position of the message inside the turn.
 * @property {string} [text]
 */

/**
 * Manages the phone ↔ DSH conversation mapping.
 */
export class DshBridge {
  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {any} options.config          Validated plugin config.
   * @param {(event: BridgeEvent) => void} options.emit
   * @param {(message: string) => void} [options.log]
   * @param {() => string} [options.defaultCwd]
   * @param {(input: {content: Array<{type: string, text: string}>, source: {kind: string}}) => any} [options.createUserMessage]
   *        Injected so the bridge can be exercised without the harness present.
   *        In production it is `createUserMessage` from `@deepseek-ai/dsh-llm`,
   *        which attaches the required message `id`.
   * @param {(() => {provider?: string, model?: string, reasoningEffort?: string} | undefined)} [options.modelSelection]
   *        Resolves which provider/model a new phone conversation should use.
   *        Without one the harness assembles a prompt whose `{{model}}` variable
   *        has no value and the first message fails, so this is required in
   *        practice and only optional so tests can omit it.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.emitRaw = options.emit
    this.log = options.log ?? (() => {})
    // 让模块级的宿主模块解析也走同一条日志，方便排错。
    setBridgeDiagnostic(this.log)
    this.defaultCwd = options.defaultCwd ?? (() => process.cwd())
    this.createUserMessage = options.createUserMessage ?? null
    this.modelSelection = options.modelSelection ?? (() => undefined)
    /** deviceId → entry */
    this.entries = new Map()
    /** sessionId → entry（协作模式下多台设备共用同一个会话） */
    this.bySession = new Map()
    /** fileId → { name, size, mime, path, deviceId } */
    this.files = new Map()
    /** `${deviceId}\u0000${callId}` → 进行中的回合 */
    this.calls = new Map()
    /** 已受理过的 (deviceId, callId)：网关幂等表之后的第二道防线。 */
    this.seenCalls = new IdempotencyCache()
    /** sessionId → 已投递给 DSH、还没等到 turn/start 的回合队列 */
    this.pendingCalls = new Map()
    /** `${sessionId}:${turn}` → 该轮次属于哪个手机消息 */
    this.turnCalls = new Map()
    this.disposed = false
    this.subscriptions = []
  }

  /** Subscribe once to the session event feed. */
  start() {
    const off = this.ctx.on('session/event', (session, event) => {
      try {
        this.#onSessionEvent(session, event)
      } catch (error) {
        this.log(`bridge: event handling failed: ${/** @type {Error} */ (error).message}`)
      }
    })
    this.subscriptions.push(off)
  }

  /** Release registrations and dispose every agent this bridge created. */
  async dispose() {
    this.disposed = true
    for (const off of this.subscriptions) {
      try {
        off?.()
      } catch { /* already unwound */ }
    }
    this.subscriptions = []
    const handlers = [...new Set([...this.entries.values()].map(entry => entry.handle))].filter(Boolean)
    const disposals = handlers.map(handle => handle.dispose().catch(() => {}))
    this.entries.clear()
    this.bySession.clear()
    this.calls.clear()
    this.files.clear()
    this.seenCalls.clear()
    this.pendingCalls.clear()
    this.turnCalls.clear()
    await Promise.all(disposals)
  }

  /** Session id used for a device. Deterministic via the state store. */
  sessionIdFor(deviceId) {
    return this.config.sessionIdFor(deviceId)
  }

  /**
   * 登记一台设备的会话归属，**不必等它先发消息**。
   *
   * v2.1.0 只在 `send()` 里创建 entries，于是刚配对、还没说过话的手机收不到
   * 同会话的任何推送（多端不同步投诉的一半原因）。网关在 hello 认证成功后
   * 就调用这里，让广播与在线成员列表立刻完整。
   * @param {string} deviceId
   */
  attachDevice(deviceId) {
    const sessionId = this.sessionIdFor(deviceId)
    const entry = this.entries.get(deviceId) ?? { sessionId, agent: null, handle: null }
    entry.sessionId = sessionId
    this.entries.set(deviceId, entry)
    this.bySession.set(sessionId, entry)
  }

  /** 手机会话的实际工作目录（上传落盘、相对路径都以它为基准）。 */
  workingDirectory() {
    return this.#cwd()
  }

  /**
   * 协作模式切换后重建 device → session 映射。
   *
   * 旧的会话 agent 会被释放（会话历史已持久化，下次用到时 `resume()` 恢复），
   * 否则两台手机在共享/独立会话之间切换时会一直挂在旧会话上，消息投递到错误
   * 的地方。调用方随后对每台已认证设备重新 `attachDevice()`。
   */
  async resetSessionMapping() {
    const handles = [...new Set([...this.entries.values()].map(entry => entry.handle).filter(Boolean))]
    this.entries.clear()
    this.bySession.clear()
    this.calls.clear()
    this.pendingCalls.clear()
    this.turnCalls.clear()
    await Promise.all(handles.map(handle => handle.dispose?.().catch?.(() => {})))
  }

  /**
   * Deliver one phone message into the device's conversation.
   * @param {object} input
   * @param {string} input.deviceId
   * @param {string} input.callId
   * @param {string} input.text
   * @param {Array<{name: string, mime?: string, size?: number, dataBase64?: string, path?: string, fileId?: string}>} input.attachments
   * @param {string} [input.speaker] 协作模式下的发言人显示名。
   */
  async send(input) {
    if (this.disposed) throw new Error('bridge 已关闭')
    const callKey = `${input.deviceId}\u0000${input.callId}`
    // 第二道防线：网关已经做了 (deviceId, msgId) 幂等，但网关重启/竞态下仍可能
    // 把同一帧再送一次；重复投递会让 DSH 多跑一轮、AI 多回一条。
    if (this.seenCalls.has(callKey) || this.calls.has(callKey)) {
      this.log(`bridge: 忽略重复投递 device=${input.deviceId} callId=${input.callId}`)
      return
    }
    bridgeDiagnostic(`bridge: send 开始 device=${input.deviceId} callId=${input.callId} 文本长度=${input.text?.length ?? 0} 附件=${input.attachments?.length ?? 0}`)

    const entry = await this.#ensureAgent(input.deviceId)
    if (!entry) throw new Error('无法创建会话')
    bridgeDiagnostic(`bridge: 会话就绪 sessionId=${entry.sessionId}`)

    let text = this.#composeText(input)
    const collaboration = this.config.isCollaboration ? this.config.isCollaboration() : this.config.collaboration === true
    if (collaboration && input.speaker) {
      // DSH 会话里没有「发言人」概念，用文本前缀把身份带进去，
      // 这样电脑端和 GPT 侧都能看出多人协作里是谁在说话。
      text = `[${input.speaker}] ${text}`
    }

    const call = {
      callKey,
      deviceId: input.deviceId,
      callId: input.callId,
      sessionId: entry.sessionId,
      text: '',
      messages: new Map(),
      messageOrder: [],
      seenSteps: new Set(),
      toolCalls: new Set(),
      startedAt: Date.now(),
      files: undefined,
      turn: undefined,
    }
    this.calls.set(callKey, call)
    this.#pending(entry.sessionId).push(call)
    this.emit({ kind: 'typing', sessionId: entry.sessionId, deviceId: input.deviceId, callId: input.callId, active: true })

    const createUserMessage = this.createUserMessage ?? await loadCreateUserMessage()
    bridgeDiagnostic('bridge: createUserMessage 已就绪，准备 followup')
    entry.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    // 只有 followup 真正提交后才记住，这样投递失败时网关可以释放占位重试。
    this.seenCalls.remember(callKey, true)
    bridgeDiagnostic(`bridge: followup 已提交 callId=${input.callId}`)
  }

  /** Abort the turn that owns this call, if it is still running. */
  cancel(callId, deviceId) {
    const call = this.#findCall(callId, deviceId)
    if (!call) return
    const entry = this.entries.get(call.deviceId)
    try {
      entry?.agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
      this.emit({
        kind: 'error',
        sessionId: call.sessionId,
        deviceId: call.deviceId,
        callId,
        message: '已停止',
        retryable: false,
      })
    } catch (error) {
      this.log(`bridge: cancel failed: ${/** @type {Error} */ (error).message}`)
    } finally {
      this.#retireCall(call)
    }
  }

  /**
   * Resolve a collectable file. Only files that were actually produced during a
   * phone conversation are exposed: the phone must never be able to ask for an
   * arbitrary path on the computer.
   * @param {string} fileId
   */
  async fileFor(fileId) {
    const record = this.files.get(fileId)
    if (!record) return undefined
    return { name: record.name, mime: record.mime, path: record.path }
  }

  /** Forget per-device conversation state (called when the phone unbinds). */
  async forgetDevice(deviceId) {
    const entry = this.entries.get(deviceId)
    this.entries.delete(deviceId)
    for (const [sessionId, mapped] of this.bySession) {
      if (mapped === entry) this.bySession.delete(sessionId)
    }
    for (const call of [...this.calls.values()]) {
      if (call.deviceId === deviceId) this.#retireCall(call)
    }
    for (const [fileId, record] of this.files) {
      if (record.deviceId === deviceId) this.files.delete(fileId)
    }
    if (entry?.handle?.dispose) {
      try {
        await entry.handle.dispose()
      } catch (error) {
        this.log(`bridge: dispose failed for ${deviceId}: ${/** @type {Error} */ (error).message}`)
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** @param {object} input */
  #composeText(input) {
    const parts = []
    if (input.text?.trim()) parts.push(input.text.trim())
    const attachments = input.attachments ?? []
    if (attachments.length > 0) {
      const cwd = this.#cwd()
      const lines = attachments.map(attachment => this.#describeAttachment(attachment, cwd))
      // 路径必须是相对 cwd 的：DSH 的文件沙箱以会话工作目录为根，绝对路径既
      // 容易被权限策略拒绝，也不利于模型理解「这是你工作区里的文件」。
      parts.push(
        `用户通过手机发来了 ${attachments.length} 个附件，已保存到电脑上（路径相对本次对话的工作目录）：\n${lines.join('\n')}\n请按需读取这些文件；图片请用图像读取工具查看。`,
      )
    }
    return parts.join('\n\n') || '（用户发送了一条空消息）'
  }

  /**
   * @param {{name: string, mime?: string, path?: string}} attachment
   * @param {string} cwd
   * @returns {string}
   */
  #describeAttachment(attachment, cwd) {
    const name = String(attachment.name ?? '文件')
    const mime = attachment.mime ? `（${attachment.mime}）` : ''
    const where = this.#displayPath(attachment.path, cwd)
    // 图片单独点名：模型的 read 工具对图片与普通文件的处理方式不同，
    // 不标注时经常出现「模型不知道这是张图」而只回一句概述。
    const isImage = /^image\//i.test(String(attachment.mime ?? ''))
      || /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(name)
    if (isImage) {
      return `- 图片：${name}${mime}，路径：${where}；这是图片文件，可用 read / 图像工具查看。`
    }
    return `- 文件：${name}${mime}，路径：${where}；可用 read 工具读取。`
  }

  /**
   * @param {string|undefined} path
   * @param {string} cwd
   * @returns {string}
   */
  #displayPath(path, cwd) {
    if (!path) return '(未落盘)'
    try {
      const rel = relative(cwd, path)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
    } catch { /* 跨盘符等情况退回绝对路径 */ }
    return path
  }

  /**
   * Get or create the agent for a device.
   * @param {string} deviceId
   */
  async #ensureAgent(deviceId) {
    const existing = this.entries.get(deviceId)
    if (existing?.agent && this.ctx.agents.get(existing.sessionId)) return existing

    const sessionId = existing?.sessionId ?? this.sessionIdFor(deviceId)

    // 协作模式：另一个设备已经为这个会话建过 agent，直接挂上去。
    // 没有这一步，两台手机同时发言会走到 create() 并撞名
    // （session "ow-xxx" already exists），正是 10-19 那个 bug 的形态。
    const sharedEntry = this.bySession.get(sessionId)
    if (sharedEntry?.agent && this.ctx.agents.get(sharedEntry.sessionId)) {
      const entry = { sessionId, agent: sharedEntry.agent, handle: null }
      this.entries.set(deviceId, entry)
      this.bySession.set(sessionId, entry)
      return entry
    }

    const live = this.ctx.agents.get(sessionId)

    /** @type {(agentCtx: any, agent: any) => void} */
    const setup = (agentCtx) => {
      // The voice is registered in the agent's own scope: it applies to this
      // conversation and disappears with it, so the desktop conversations the
      // user has open keep their normal, technical register.
      if (this.config.voice !== 'off') {
        agentCtx.systemPrompt.section({
          name: VOICE_SECTION_NAME,
          order: VOICE_SECTION_ORDER,
          text: assistantVoiceSection({ assistantName: this.config.assistantName }),
        })
      }
      if (this.config.autoApproveTools) {
        // Approval is granted by *answering* the approval waterfall, never by a
        // guard. `ctx.tools.guard()` is deny-only: its declared type is
        // `(execution) => string | undefined` and `guardReason()` turns any
        // non-undefined return into the denial reason, so returning
        // `{kind:'allow'}` from a guard denies every tool call with
        // "Error: [object Object]" (measured on a real dsh instance).
        // `{prepend:true}` makes this answerer run before any other and return
        // its grant without chaining; `'allowed-once'` is the only outcome the
        // approval service treats as a grant.
        agentCtx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true })
      }
    }

    if (live) {
      const entry = { sessionId, agent: live, handle: null }
      this.entries.set(deviceId, entry)
      this.bySession.set(sessionId, entry)
      return entry
    }

    // 到这里说明：内存里没有活动 agent。但会话可能已经**持久化在磁盘上**
    // （DSH 重启后内存清空，会话文件仍在）。此时直接 `create()` 会撞名：
    //   session "ow-xxx" already exists
    // 这个问题曾导致手机消息全部投递失败，而现象只是「一直发送中」。
    //
    // 正确顺序是：
    //   ① 先 `resume()` 恢复磁盘上的既有会话（保留历史，且能接管上次中断的轮次）
    //   ② 只有确认磁盘上也没有时，才 `create()` 新建
    const resumed = await this.#tryResumeAgent(sessionId, setup)
    if (resumed) {
      const entry = { sessionId, agent: resumed.agent, handle: resumed.handle }
      this.entries.set(deviceId, entry)
      this.bySession.set(sessionId, entry)
      this.log(`bridge: resumed conversation ${sessionId} for device ${deviceId}`)
      return entry
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.#cwd() },
      agentOptions: this.#agentOptions(),
      setup,
    })
    const entry = { sessionId, agent: handle.agent, handle }
    this.entries.set(deviceId, entry)
    this.log(`bridge: created conversation ${sessionId} for device ${deviceId}`)
    return entry
  }

  /**
   * 尝试恢复一个已持久化的会话。
   *
   * `ctx.agents.resume()` 用 `resumeSessionId` 定位磁盘会话（注意字段名与
   * `create()` 的 `sessionId` 不同），并从会话 header 恢复 meta/cwd，因此
   * 这里不需要传 `meta`。会话不存在或持久化层未启用时它会 reject，此时
   * 返回 null 交给调用方走新建分支。
   *
   * @param {string} sessionId
   * @param {(agentCtx: any, agent: any) => void} setup
   * @returns {Promise<{ agent: any, handle: any } | null>}
   */
  async #tryResumeAgent(sessionId, setup) {
    if (typeof this.ctx.agents?.resume !== 'function') {
      bridgeDiagnostic('bridge: agents.resume 不可用，跳过恢复')
      return null
    }
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.#agentOptions(),
        setup,
      })
      if (!handle?.agent) {
        bridgeDiagnostic('bridge: resume 返回空 handle，转为新建')
        return null
      }
      return { agent: handle.agent, handle }
    } catch (error) {
      // 会话不存在属于正常情况（首次使用），只能降级为 debug 级别提示。
      bridgeDiagnostic(`bridge: resume 未成功（将尝试新建）：${/** @type {Error} */ (error).message}`)
      return null
    }
  }

  /**
   * Which provider/model a phone conversation runs on.
   *
   * An explicit configuration wins; otherwise the harness's current default
   * selection is used, which is what the desktop sessions use too. Leaving this
   * empty is not a cosmetic problem: the assembled system prompt interpolates
   * `{{model}}`, and a missing value makes the harness throw before the first
   * model call — the phone would see "处理失败" on every message.
   * @returns {{provider?: string, model?: string, reasoningEffort?: string}}
   */
  #agentOptions() {
    const configured = this.config.agentOptions ?? {}
    if (configured.provider || configured.model) return configured
    const selected = this.modelSelection()
    if (!selected) {
      this.log('bridge: 未能确定默认模型，手机会话可能无法回复（请在 DSH 设置里选择默认模型）')
      return configured
    }
    return {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
    }
  }

  #cwd() {
    const configured = this.config.cwd
    if (configured && isAbsolute(configured)) return configured
    if (configured) return resolve(process.cwd(), configured)
    return this.defaultCwd()
  }

  // ---------------------------------------------------------------------------
  // DSH session events → bridge events
  // ---------------------------------------------------------------------------

  /**
   * Route one durable session event.
   *
   * v2.1.0 looped over every device in the session and dispatched the *same*
   * event into a per-device mutating call, which pushed the same assistant text
   * N times and produced `done.text === 'T\n\nT'`. v2.2.0 reduces the event
   * exactly once and emits a single session-scoped event for the gateway to
   * broadcast.
   * @param {any} session
   * @param {any} event
   */
  #onSessionEvent(session, event) {
    const sessionId = this.#sessionIdOf(session)
    if (!sessionId) return
    // 只有本插件拥有的会话才处理：桌面上的其它会话不能把内容推给手机。
    if (this.#devicesForSession(session).length === 0) return

    switch (event?.type) {
      case 'turn/start':
        return this.#onTurnStart(sessionId, event)
      case 'assistant/message':
        return this.#onAssistantMessage(sessionId, event)
      case 'assistant/attempt':
        return this.#onAssistantAttempt(sessionId, event)
      case 'tool/call':
        return this.#onToolCall(sessionId, event)
      case 'tool/result':
        return this.#onToolResult(sessionId, event)
      case 'turn/end':
        return this.#onTurnEnd(sessionId, event)
      default:
        return undefined
    }
  }

  /** @param {string} sessionId @param {any} event */
  #onTurnStart(sessionId, event) {
    const queue = this.pendingCalls.get(sessionId)
    const call = queue?.shift()
    if (!call) return
    call.turn = event?.data?.turn
    if (call.turn !== undefined) this.turnCalls.set(`${sessionId}:${call.turn}`, call)
  }

  /** @param {string} sessionId @param {any} event */
  #onAssistantMessage(sessionId, event) {
    const data = event?.data ?? {}
    const call = this.#callForTurn(sessionId, data)
    if (!call) return
    const text = extractAssistantText(data)
    if (!text) return
    const messageId = String(data?.message?.id ?? `msg_${data?.turn ?? 0}_${data?.step ?? 0}`)
    // 同一条已提交消息被重放时只算一次（断线重连/重复监听都会发生）。
    if (call.messages.has(messageId)) return
    this.#recordAssistantText(call, { sessionId, messageId, text })
    if (data.step !== undefined) call.seenSteps.add(`${data.turn}:${data.step}`)
  }

  /** @param {string} sessionId @param {any} event */
  #onAssistantAttempt(sessionId, event) {
    const data = event?.data ?? {}
    const call = this.#callForTurn(sessionId, data)
    if (!call) return
    const stepKey = `${data?.turn}:${data?.step}`
    // 同一 (turn, step) 的 attempt 与 message 只能出一个气泡。
    if (call.seenSteps.has(stepKey)) return
    const text = extractAssistantText(data) || extractAttemptStreamText(data?.stream)
    if (!text) {
      // 本版 DSH 的 attempt 只有 stream 没有 message，没有可用文本：标记该 step
      // 已归约，等后面的 assistant/message 出正文。
      call.seenSteps.add(stepKey)
      return
    }
    const messageId = String(data?.message?.id ?? `attempt_${data?.turn ?? 0}_${data?.step ?? 0}`)
    if (call.messages.has(messageId)) return
    this.#recordAssistantText(call, { sessionId, messageId, text })
    call.seenSteps.add(stepKey)
  }

  /**
   * @param {any} call
   * @param {{sessionId: string, messageId: string, text: string}} input
   */
  #recordAssistantText(call, input) {
    const index = call.messageOrder.length
    call.messages.set(input.messageId, { index, text: input.text })
    call.messageOrder.push(input.messageId)
    call.text = call.messageOrder.map(id => call.messages.get(id).text).join('\n\n')
    this.emit({
      kind: 'message',
      sessionId: input.sessionId,
      deviceId: call.deviceId,
      callId: call.callId,
      messageId: input.messageId,
      index,
      text: input.text,
    })
  }

  /** @param {string} sessionId @param {any} event */
  #onToolCall(sessionId, event) {
    const data = event?.data ?? {}
    const call = this.#callForTurn(sessionId, data)
    if (!call) return
    const toolCallId = data?.callId
    if (!toolCallId) return
    call.toolCalls.add(toolCallId)
    this.emit({
      kind: 'tool',
      sessionId,
      deviceId: call.deviceId,
      callId: call.callId,
      phase: 'tool-start',
      toolCallId,
      tool: data?.name,
      summary: summarizeToolCall(data?.name, data?.arguments),
    })
  }

  /** @param {string} sessionId @param {any} event */
  #onToolResult(sessionId, event) {
    const data = event?.data ?? {}
    const call = this.#callForTurn(sessionId, data)
    if (!call) return
    this.#collectFiles(call, data)
    this.emit({
      kind: 'tool',
      sessionId,
      deviceId: call.deviceId,
      callId: call.callId,
      phase: 'tool-end',
      toolCallId: data?.callId ?? data?.toolCallId ?? data?.message?.toolCallId,
      tool: data?.name ?? data?.message?.name,
      ok: data?.message?.isError !== true && data?.ok !== false,
    })
  }

  /** @param {string} sessionId @param {any} event */
  #onTurnEnd(sessionId, event) {
    const data = event?.data ?? {}
    const mapped = data?.turn !== undefined ? this.turnCalls.get(`${sessionId}:${data.turn}`) : undefined
    const call = mapped ?? this.#callForTurn(sessionId, data)
    if (!call) return
    const reason = data?.reason
    if (reason?.kind === 'error') {
      this.emit({
        kind: 'error',
        sessionId,
        deviceId: call.deviceId,
        callId: call.callId,
        message: describeFailure(reason.error),
        retryable: true,
      })
      this.#retireCall(call)
      return
    }
    // done.text 只由去重后的消息拼接，绝不再把同一段文本追加多次。
    // files 必须是**元信息对象**（手机端 reducer 的 normalizeFileRef 只认带 fileId
    // 的对象，裸 fileId 字符串会被整条丢弃，助手产出的文件就不会出现在聊天里）。
    this.emit({
      kind: 'done',
      sessionId,
      deviceId: call.deviceId,
      callId: call.callId,
      text: call.text || '（没有产生回复内容）',
      durationMs: Date.now() - call.startedAt,
      files: this.#fileRefs(call.files),
    })
    this.#retireCall(call)
  }

  /**
   * Which call an event belongs to. DSH commits `turn` on every surface event;
   * `turn/start` binds a turn to the phone message that started it. The fallback
   * keeps a single-device session working even when a turn/start was missed
   * (e.g. the agent was resumed mid-turn).
   * @param {string} sessionId
   * @param {any} data
   */
  #callForTurn(sessionId, data) {
    if (data?.turn !== undefined) {
      const mapped = this.turnCalls.get(`${sessionId}:${data.turn}`)
      if (mapped) return mapped
    }
    let latest
    for (const call of this.calls.values()) {
      if (call.sessionId !== sessionId) continue
      if (!latest || call.startedAt >= latest.startedAt) latest = call
    }
    return latest
  }

  /** @param {string} sessionId @returns {any[]} */
  #pending(sessionId) {
    let queue = this.pendingCalls.get(sessionId)
    if (!queue) {
      queue = []
      this.pendingCalls.set(sessionId, queue)
    }
    return queue
  }

  /** @param {string} callId @param {string} [deviceId] */
  #findCall(callId, deviceId) {
    for (const call of this.calls.values()) {
      if (call.callId !== callId) continue
      if (deviceId && call.deviceId !== deviceId) continue
      return call
    }
    return undefined
  }

  /** Drop every trace of a finished call so it cannot be matched again. @param {any} call */
  #retireCall(call) {
    this.calls.delete(call.callKey)
    const queue = this.pendingCalls.get(call.sessionId)
    if (queue) {
      const index = queue.indexOf(call)
      if (index >= 0) queue.splice(index, 1)
    }
    if (call.turn !== undefined) this.turnCalls.delete(`${call.sessionId}:${call.turn}`)
  }

  /** @param {any} session */
  #sessionIdOf(session) {
    return session?.id ?? session?.header?.id ?? ''
  }

  /** @param {any} session */
  #devicesForSession(session) {
    const id = this.#sessionIdOf(session)
    if (!id) return []
    const devices = []
    for (const [deviceId, entry] of this.entries) {
      if (entry.sessionId === id) devices.push(deviceId)
    }
    return devices
  }

  /**
   * fileId 列表 → 手机端渲染文件卡片所需的元信息数组。
   * @param {string[] | undefined} fileIds
   * @returns {Array<{fileId: string, name: string, size: number, mime?: string}> | undefined}
   */
  #fileRefs(fileIds) {
    if (!Array.isArray(fileIds) || fileIds.length === 0) return undefined
    return fileIds.map(fileId => {
      const record = this.files.get(fileId)
      return {
        fileId,
        name: record?.name ?? fileId,
        size: typeof record?.size === 'number' ? record.size : 0,
        ...(record?.mime ? { mime: record.mime } : {}),
      }
    })
  }

  /**
   * Register any files referenced by a tool result so the phone can fetch them.
   * @param {any} call
   * @param {any} data
   */
  #collectFiles(call, data) {
    const blocks = data?.message?.content ?? data?.content ?? []
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block?.type !== 'file' || !block.path) continue
      const path = block.path
      const fileId = `f_${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
      this.files.set(fileId, {
        name: block.name ?? path.split(/[\\/]/).pop() ?? 'file',
        mime: block.mime,
        size: block.size,
        path,
        deviceId: call.deviceId,
      })
      call.files = call.files ?? []
      if (!call.files.includes(fileId)) call.files.push(fileId)
    }
  }

  /** @param {BridgeEvent & Record<string, unknown>} event */
  emit(event) {
    try {
      this.emitRaw(event)
    } catch (error) {
      this.log(`bridge: emit failed: ${/** @type {Error} */ (error).message}`)
    }
  }
}

/**
 * Load the harness message factory on first use.
 *
 * Deferred and cached because the harness is only resolvable from inside a DSH
 * process, not from a plain test run — and because a missing harness must produce
 * one clear error at the point of use rather than breaking the module import.
 * The returned factory attaches the message `id` that the agent inbox requires.
 * @returns {Promise<(input: {content: Array<{type: string, text: string}>, source: {kind: string}}) => any>}
 */
/**
 * 解析宿主提供的 `@deepseek-ai/*` 包。
 *
 * 顺序很关键：**先按宿主 asar 的直接路径导入，最后才退回裸 `import()`**。
 *
 * 裸 `import()` 是按**本模块自身所在的位置**解析的。本插件以 `link:` 方式安装时
 * （`profiles/<profile>/node_modules/dsh-openwhale` 是指向仓库的符号链接），Node 会
 * 把它解析成仓库的真实路径，而宿主的包只存在于 `app.asar` 里。实测：
 *  - 旧写法（只做裸导入）→ 抛 `Cannot find package '@deepseek-ai/dsh-llm'`，
 *    手机端每条消息都收到「处理失败」；
 *  - 先裸导入、失败再回退 → 裸导入这一步本身会**挂住不返回**（既不 resolve 也不
 *    reject），`await` 永不结束，于是连回退都走不到，手机端只显示「正在输入…」。
 *
 * 宿主进程是 Electron（`D:\AI\DeepSeek Harness.exe` 加载 `app.asar` 内的入口），
 * 对 asar 内的路径可以像普通文件一样 `import`，实测可直接拿到 `createUserMessage`。
 */
const HOST_MODULE_ROOTS = (() => {
  const roots = []
  const push = r => {
    if (r && !roots.includes(r)) roots.push(r)
  }
  if (process.env.OPENWHALE_DSH_ROOT) push(process.env.OPENWHALE_DSH_ROOT)
  const resources = process.resourcesPath
  if (resources) {
    push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  if (process.execPath) {
    const dir = dirname(process.execPath)
    push(join(dir, 'resources', 'app.asar', 'dsh', 'node_modules'))
    push(join(dir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  return roots
})()

let createUserMessageFactory

async function importHostModule(name) {
  const tried = []
  // 1) 宿主 asar 直接路径（确定且不依赖模块解析规则）
  for (const root of HOST_MODULE_ROOTS) {
    for (const entry of ['lib/index.js', 'index.js']) {
      const file = join(root, ...name.split('/'), entry)
      try {
        const mod = await import(pathToFileURL(file).href)
        if (mod) return mod
      } catch (error) {
        tried.push(`${file} → ${/** @type {Error} */ (error).message}`)
      }
    }
  }
  // 2) 最后才是裸导入（tarball 安装、或宿主已把自身路径暴露出来时可行）
  try {
    return await import(name)
  } catch (error) {
    tried.push(`bare ${name} → ${/** @type {Error} */ (error).message}`)
  }
  throw new Error(`${name} 无法解析。已尝试：\n  ${tried.join('\n  ') || '（没有任何候选路径）'}`)
}

/**
 * 解析宿主模块时的诊断输出。
 *
 * 这一段曾经"静默失败"过两次，每次都只能靠手机端的现象反推，代价很大：
 *  1. 裸导入抛 `Cannot find package` → 手机收到「处理失败」；
 *  2. 改成"先裸导入再回退"后，裸导入这一步**挂住不返回**，手机只显示「正在输入…」。
 * 所以这里把每次解析的结果写进插件日志，并给整个加载过程加超时——宁可报错，
 * 也不要让用户对着一个永远转圈的「正在输入…」。
 */
let bridgeDiagnostic = () => {}
/** 由 bridge 实例注入日志函数，便于在模块级函数里输出诊断。 */
export function setBridgeDiagnostic(fn) {
  if (typeof fn === 'function') bridgeDiagnostic = fn
}

/** 加载宿主模块的超时时间：超过就明确报错，不再无限等待。 */
const HOST_MODULE_TIMEOUT_MS = 10_000

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未返回（疑似挂起）`)), ms),
    ),
  ])
}

async function loadCreateUserMessage() {
  if (!createUserMessageFactory) {
    let module
    try {
      module = await withTimeout(
        importHostModule('@deepseek-ai/dsh-llm'),
        HOST_MODULE_TIMEOUT_MS,
        'importHostModule(@deepseek-ai/dsh-llm)',
      )
    } catch (error) {
      const message = /** @type {Error} */ (error).message
      bridgeDiagnostic(`bridge: 加载 @deepseek-ai/dsh-llm 失败：${message}`)
      throw error
    }
    const resolved = typeof module.createUserMessage === 'function'
    bridgeDiagnostic(
      `bridge: 已加载 @deepseek-ai/dsh-llm（createUserMessage ${resolved ? '可用' : '不可用'}）`,
    )
    if (!resolved) throw new Error('@deepseek-ai/dsh-llm 里没有 createUserMessage')
    createUserMessageFactory = module.createUserMessage
  }
  return createUserMessageFactory
}

/**
 * Pull the assistant's text out of whatever shape the event carries.
 * @param {any} data
 * @returns {string}
 */
export function extractAssistantText(data) {
  const message = data?.message ?? data
  const blocks = message?.content
  if (!Array.isArray(blocks)) {
    return typeof data?.text === 'string' ? data.text : ''
  }
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Best-effort text extraction from an `assistant/attempt` stream.
 *
 * In the DSH build we target, an attempt carries only stream records and no
 * committed message, so this usually returns `''`; it exists so a future build
 * that puts text chunks in the stream still reaches the phone exactly once.
 * @param {any} stream
 * @returns {string}
 */
export function extractAttemptStreamText(stream) {
  if (!Array.isArray(stream)) return ''
  return stream
    .map(record => {
      if (typeof record === 'string') return record
      if (typeof record?.text === 'string') return record.text
      if (typeof record?.chunk === 'string') return record.chunk
      if (typeof record?.delta?.text === 'string') return record.delta.text
      return ''
    })
    .join('')
}

/**
 * Short, human phrase for a running tool call. The phone shows these as status
 * rows, so they must read as "what it is doing", not as a function name.
 * @param {string|undefined} name
 * @param {unknown} argsJson
 */
export function summarizeToolCall(name, argsJson) {
  const tool = String(name ?? '工具')
  let detail = ''
  try {
    const args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : argsJson
    detail = args?.path ?? args?.file_path ?? args?.query ?? args?.command ?? ''
  } catch { /* arguments are not always JSON */ }
  const short = detail ? `：${String(detail).split(/[\\/]/).pop()?.slice(0, 40)}` : ''
  if (/read/i.test(tool)) return `正在读取文件${short}`
  if (/write|edit/i.test(tool)) return `正在写文件${short}`
  if (/bash|pwsh|shell|cmd/i.test(tool)) return '正在执行命令'
  if (/search|grep|glob/i.test(tool)) return '正在查找内容'
  if (/image/i.test(tool)) return '正在处理图片'
  if (FILE_TOOL_HINTS.some(hint => tool.toLowerCase().includes(hint))) return `正在生成文件${short}`
  return `正在使用${tool}`
}

/**
 * Turn a DSH failure into something a phone user can act on.
 * @param {any} error
 */
export function describeFailure(error) {
  const message = error?.message ?? String(error ?? '未知错误')
  if (/prompt variable .* has no value/i.test(message)) {
    return '电脑上的默认模型没有配置好（提示词缺少模型信息）。请在电脑的 DSH 设置里选择默认模型，或在本插件的 agentOptions 中指定 provider 与 model。'
  }
  if (/sign.?in|credential|api key|unauthor/i.test(message)) {
    return '电脑上的 DSH 登录已失效，请在电脑上重新登录后重试。'
  }
  if (/rate|429|quota/i.test(message)) return '模型服务暂时限流，请稍后再试。'
  if (/network|ENOTFOUND|ECONN|timeout/i.test(message)) return '网络连接失败，请检查电脑是否在线。'
  if (/abort|cancel/i.test(message)) return '已停止。'
  return `处理失败：${message.slice(0, 300)}`
}

export { mkdir, dirname, join }
