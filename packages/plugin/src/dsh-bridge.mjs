// The DSH-facing half of Open Whale.
//
// Responsibilities, in order of importance:
//  1. 持有「一个 DSH 会话 ↔ 一个 agent」的映射：手机在会话列表里选中的会话
//     由这里 resume/复用，新设备首次绑定则由这里 create。设备到会话的绑定
//     归网关（`Gateway.deviceSession`），本文件只认 sessionId。
//  2. Turn DSH's event stream into the small vocabulary the phone speaks
//     (message / done / tool / typing / error), and collect files it may fetch.
//  3. 把 DSH 的审批请求（`approval/request` 瀑布）转发给已绑定的手机，并等它
//     作答；没有在线手机、超时或请求被中止时交回桌面 UI。
//  4. Inject the personal-assistant voice as a *scoped* prompt section on those
//     conversations only.
//
// It deliberately talks to DSH through the injected context instead of importing
// harness internals, so the same file can be exercised in tests with a fake ctx.
//
// v2.3.0 removes collaboration: a device always drives the DSH session it is
// bound to, and may list / select / create those sessions (`session/*`) and
// answer the computer's approval prompts (`approval/*`).
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  APPROVAL_TIMEOUT_MS,
  IdempotencyCache,
  QUESTION_LATE_WINDOW_MS,
  QUESTION_MAX_ITEMS,
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_TEXT,
  QUESTION_TIMED_TIMEOUT_MS,
  QUESTION_TIMEOUT_MS,
  SESSION_LIST_LIMIT,
  SESSION_SNAPSHOT_LIMIT,
  normalizeQuestionAnswers,
} from './protocol.mjs'
import { assistantVoiceSection, VOICE_SECTION_NAME, VOICE_SECTION_ORDER } from './voice.mjs'

/** Tools whose results are files rather than text. */
const FILE_TOOL_HINTS = ['write', 'image', 'docx', 'xlsx', 'pptx', 'pdf', 'export', 'render', 'download']

/**
 * @typedef {object} BridgeEvent
 * One event for the gateway to fan out. `sessionId` is the conversation the
 * event belongs to; the gateway broadcasts chat-level frames to every device
 * bound to that conversation and only the bridge knows which conversation DSH
 * just spoke in.
 * @property {'message'|'delta'|'done'|'tool'|'typing'|'error'|'approval-ask'|'approval-resolved'|'question-ask'|'question-resolved'} kind
 * @property {string} sessionId
 * @property {string} [deviceId]   The device whose turn produced the event.
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
   * @param {(sessionId: string) => string[]} [options.devicesInSession]
   *        Online phones bound to a session, supplied by the gateway. Used to
   *        decide whether an approval may be forwarded at all — registering the
   *        answerer is not the same as claiming: with no phone online the
   *        request must fall through to the desktop UI.
   * @param {number} [options.approvalTimeoutMs] Override the 60s forwarding timeout (tests).
   * @param {() => number} [options.now]
   * @param {(input: {content: Array<{type: string, text: string}>, source: {kind: string}}) => any} [options.createUserMessage]
   *        Injected so the bridge can be exercised without the harness present.
   *        In production it is `createUserMessage` from `@deepseek-ai/dsh-llm`,
   *        which attaches the required message `id`.
   * @param {(() => {provider?: string, model?: string, reasoningEffort?: string} | undefined)} [options.modelSelection]
   *        Resolves which provider/model a new phone conversation should use.
   *        Without one the harness assembles a prompt whose `{{model}}` variable
   *        has no value and the first message fails, so this is required in
   *        practice and only optional so tests can omit it.
   * @param {(deviceId?: string) => string} [options.newSessionId]
   *        How a brand new conversation id is minted. Production uses a random
   *        UUID (DSH's SessionId is just a branded string); tests pin it so the
   *        rest of their fixtures can keep naming conversations `ow-dev_x`.
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
    this.newSessionId = options.newSessionId ?? (() => randomUUID())
    this.devicesInSession = options.devicesInSession ?? (() => [])
    this.approvalTimeoutMs = Number.isFinite(options.approvalTimeoutMs)
      ? Math.max(0, Number(options.approvalTimeoutMs))
      : APPROVAL_TIMEOUT_MS
    // 结构化提问（ask_user_question / 计划审阅）的转发窗口。阻塞式 ask() 可以等久一点
    // （一张卡里可能有多题、选项和自定义输入）；askTimed() 必须比调用方自己的超时短，
    // 否则 DSH 已经把模型放行了，桌面拿到的却是一个已经过期的等待。
    this.questionTimeoutMs = Number.isFinite(options.questionTimeoutMs)
      ? Math.max(0, Number(options.questionTimeoutMs))
      : QUESTION_TIMEOUT_MS
    this.questionTimedTimeoutMs = Number.isFinite(options.questionTimedTimeoutMs)
      ? Math.max(0, Number(options.questionTimedTimeoutMs))
      : QUESTION_TIMED_TIMEOUT_MS
    this.questionLateWindowMs = Number.isFinite(options.questionLateWindowMs)
      ? Math.max(0, Number(options.questionLateWindowMs))
      : QUESTION_LATE_WINDOW_MS
    this.now = options.now ?? (() => Date.now())
    /** sessionId → {agent, handle}：一个会话一个 agent，绝不重复创建 */
    this.agents = new Map()
    /**
     * 被「接管」的 live agent → 它作用域上的转发者 disposer。
     *
     * 本插件 create/resume 的 agent 由 setup 注册转发者（作用域销毁时一起走）；
     * 但用户在手机会话列表里选中的可能是**桌面上已经在跑**的会话，它的
     * `setup` 早就跑完了。不补注册的话，这个会话里的审批/结构化提问永远不会
     * 转发到手机。用 WeakMap 保证同一个 agent 只注册一次，并在 release/dispose
     * 时解绑（agent 本身归桌面所有，不能替它 dispose）。
     * @type {WeakMap<any, {offs: Function[], sessionId: string}>}
     */
    this.adoptedAgents = new WeakMap()
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
    /** approvalId → 等待手机作答的请求 */
    this.approvals = new Map()
    /** questionId → 等待手机作答的结构化提问（前台等待期间） */
    this.questions = new Map()
    /** questionId → 前台等待超时后仍可补答的提问（DSH 的 askTimed/continued） */
    this.lateQuestions = new Map()
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
    // 有待作答的审批/提问时必须先结掉，否则那个工具调用会一直挂到超时。
    for (const approvalId of [...this.approvals.keys()]) this.#settleApproval(approvalId, 'cancelled')
    for (const questionId of [...this.questions.keys()]) this.#settleQuestion(questionId, 'cancelled')
    for (const questionId of [...this.lateQuestions.keys()]) this.#dropLateQuestion(questionId)
    const handlers = [...new Set([...this.agents.values()].map(entry => entry.handle))].filter(Boolean)
    const disposals = handlers.map(handle => handle.dispose().catch(() => {}))
    // 接管的 agent 归桌面所有：只解绑我们加的转发者，绝不 dispose 它。
    for (const entry of this.agents.values()) this.#detachAdopted(entry.agent)
    this.agents.clear()
    this.calls.clear()
    this.files.clear()
    this.seenCalls.clear()
    this.pendingCalls.clear()
    this.turnCalls.clear()
    await Promise.all(disposals)
  }

  /** 手机会话的实际工作目录（上传落盘、相对路径都以它为基准）。 */
  workingDirectory() {
    return this.#cwd()
  }

  // ---------------------------------------------------------------------------
  // 会话列表 / 选择 / 新建（v2.3.0）
  // ---------------------------------------------------------------------------

  /**
   * 手机端的会话选择器：列出电脑上的 DSH 会话。
   *
   * 只看根会话（`header.parentSession === undefined`），subagent 会话不给人选。
   * 标题走 `readTitleSnapshots()`，拿不到时用 cwd 最后一段或「新会话」；按
   * `createdAt` 倒序，截断到 `SESSION_LIST_LIMIT`。
   * @returns {Promise<{sessions: Array<object>, truncated: boolean}>}
   */
  async listSessions() {
    const query = this.#sessionQuery()
    if (typeof query?.listSessions !== 'function') {
      this.log('bridge: 会话查询服务不可用，会话列表为空')
      return { sessions: [], truncated: false }
    }
    let records
    try {
      records = await query.listSessions()
    } catch (error) {
      this.log(`bridge: 列出会话失败：${/** @type {Error} */ (error).message}`)
      return { sessions: [], truncated: false }
    }
    const roots = (Array.isArray(records) ? records : [])
      .filter(record => record?.header && record.header.parentSession === undefined)
      .sort((a, b) => (Number(b.header.createdAt) || 0) - (Number(a.header.createdAt) || 0))
    const truncated = roots.length > SESSION_LIST_LIMIT
    const limited = roots.slice(0, SESSION_LIST_LIMIT)

    const titles = await this.#titles(limited.map(record => record.header.id))
    const sessions = limited.map(record => {
      const header = record.header
      const live = record.live === true || Boolean(this.ctx.agents.get(header.id))
      return {
        id: header.id,
        title: titles.get(header.id) ?? this.#titleFallback(header),
        ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
        createdAt: Number(header.createdAt) || 0,
        live,
      }
    })
    return { sessions, truncated }
  }

  /**
   * 把某个设备绑定到一个已有会话（会话不存在时返回 `not-found`）。
   *
   * 已 live 的会话**绝不**再次 create/resume：直接复用现有 agent，否则同一个
   * sessionId 会撞上 "session already exists"。
   * @param {string} sessionId
   * @returns {Promise<{ok: true, sessionId: string, title?: string} | {ok: false, error: string, message: string}>}
   */
  async selectSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return { ok: false, error: 'not-found', message: '没有指定会话' }

    const live = this.ctx.agents.get(id)
    if (live) {
      const entry = this.agents.get(id)
      // 只有「本插件没为这个 agent 跑过 setup」时才需要补注册转发者；
      // 已在 map 里的 agent 是我们自己 create/resume 的，setup 已经注册过。
      const adopted = entry?.agent === live ? entry : this.#adoptLiveAgent(id, live)
      this.agents.set(id, adopted)
      return { ok: true, sessionId: id, ...(await this.#selectedTitle(id)) }
    }

    if (!(await this.#sessionExists(id))) {
      return { ok: false, error: 'not-found', message: '电脑上找不到这个会话' }
    }
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: this.#agentOptions(),
        setup: this.#setupFor(id),
      })
      if (!handle?.agent) throw new Error('resume 返回空 handle')
      this.agents.set(id, { agent: handle.agent, handle })
      this.log(`bridge: resumed conversation ${id}`)
      return { ok: true, sessionId: id, ...(await this.#selectedTitle(id)) }
    } catch (error) {
      this.log(`bridge: resume ${id} 失败：${/** @type {Error} */ (error).message}`)
      return {
        ok: false,
        error: 'resume-failed',
        message: `无法打开这个会话：${/** @type {Error} */ (error).message}`,
      }
    }
  }

  /**
   * 新建一个 DSH 会话并返回它的 id（等同 `session/create`）。
   * @returns {Promise<{ok: true, sessionId: string}>}
   */
  async createSession(deviceId) {
    const sessionId = String(this.newSessionId(deviceId) ?? '')
    if (sessionId === '') throw new Error('无法生成会话 id')
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.#cwd() },
      agentOptions: this.#agentOptions(),
      setup: this.#setupFor(sessionId),
    })
    this.agents.set(sessionId, { agent: handle.agent, handle })
    this.log(`bridge: created conversation ${sessionId}`)
    return { ok: true, sessionId }
  }

  /**
   * `session/state` 用的历史快照：来自 DSH 会话日志，而不仅是本进程收到的事件。
   * 读历史失败时降级为空数组（调用方会退回进程内日志），绝不抛。
   * @param {string} sessionId
   * @returns {Promise<Array<{id: string, kind: 'user'|'assistant', text: string, at: string}>>}
   */
  async historyMessages(sessionId) {
    const query = this.#sessionQuery()
    if (typeof query?.readSession !== 'function') return []
    let result
    try {
      result = await query.readSession(sessionId)
    } catch (error) {
      this.log(`bridge: 读取会话历史失败（降级为进程内日志）：${/** @type {Error} */ (error).message}`)
      return []
    }
    // 实际宿主返回 `{session, events}`（协议文档里写的是 `{header, events}`），
    // 两种形状都接受：header 只用于诊断，这里只需要事件。
    const events = Array.isArray(result?.events) ? result.events : []
    const messages = []
    for (const event of events) {
      const mapped = historyMessageOf(event)
      if (mapped) messages.push(mapped)
    }
    return messages.slice(-SESSION_SNAPSHOT_LIMIT)
  }

  // ---------------------------------------------------------------------------
  // 审批转发（v2.3.0）
  // ---------------------------------------------------------------------------

  /**
   * 手机对一条待答审批作答。
   * @param {{approvalId: string, deviceId?: string, outcome: string}} input
   * @returns {boolean} 是否真的结算了一条等待中的请求
   */
  answerApproval(input) {
    const approvalId = String(input?.approvalId ?? '')
    const entry = this.approvals.get(approvalId)
    if (!entry) return false
    const deviceId = typeof input?.deviceId === 'string' ? input.deviceId : ''
    // 只有被问过的那台手机能答，避免同会话的另一台设备抢答。
    if (deviceId !== '' && !entry.deviceIds.has(deviceId)) return false
    this.#settleApproval(approvalId, input?.outcome === 'allowed-once' ? 'allowed-once' : 'rejected')
    return true
  }

  /**
   * 一个 agent 的 setup：声音段落 + autoApproveTools 或手机审批转发。
   * @param {string} sessionId
   */
  #setupFor(sessionId) {
    /** @type {(agentCtx: any, agent: any) => void} */
    return (agentCtx, agent) => this.#setupAgent(agentCtx, agent, sessionId)
  }

  /**
   * 把一个 agent 的转发者注册到它自己的作用域上（幂等：同一个 agent 只注册一次）。
   * @param {any} agentCtx
   * @param {string} sessionId
   * @returns {Function[]} 解绑函数
   */
  #registerForwarders(agentCtx, sessionId) {
    /** @type {Function[]} */
    const offs = []
    if (!agentCtx || typeof agentCtx.on !== 'function') {
      this.log('bridge: agent 作用域不可用，审批/提问无法转发到手机')
      return offs
    }
    // 结构化提问（`ask_user_question` / 计划审阅）是独立于审批的一条 seam：
    // autoApproveTools 只影响「允许/拒绝」，不能让提问也被自动放行，否则模型
    // 会拿到一个空答案。所以这里总是注册转发者。
    offs.push(agentCtx.on(
      'user-questions/request',
      /** @type {(req: any, next: () => Promise<any>) => Promise<any>} */
      (req, next) => this.#onUserQuestion(sessionId, req, next),
      { prepend: true },
    ))
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
      offs.push(agentCtx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true }))
    } else {
      // 只对本插件创建/接管的 agent 注册（agentCtx 天然按 agent 隔离）。
      offs.push(agentCtx.on(
        'approval/request',
        /** @type {(req: any, next: () => Promise<any>) => Promise<any>} */
        (req, next) => this.#onApprovalRequest(sessionId, req, next),
        { prepend: true },
      ))
    }
    return offs
  }

  /**
   * @param {any} agentCtx
   * @param {any} _agent
   * @param {string} sessionId
   */
  #setupAgent(agentCtx, _agent, sessionId) {
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
    this.#registerForwarders(agentCtx, sessionId)
  }

  /**
   * 接管一个已经在跑的 live agent：进 map，并在它自己的作用域上补注册转发者。
   * @param {string} sessionId
   * @param {any} agent
   * @returns {{agent: any, handle: any}}
   */
  #adoptLiveAgent(sessionId, agent) {
    const entry = { agent, handle: this.agents.get(sessionId)?.handle ?? null }
    this.agents.set(sessionId, entry)
    this.#ensureAdoptedForwarders(sessionId, agent)
    return entry
  }

  /**
   * 给接管的 live agent 注册转发者（同一个 agent 只注册一次）。
   * @param {string} sessionId
   * @param {any} agent
   */
  #ensureAdoptedForwarders(sessionId, agent) {
    if (!agent || this.adoptedAgents.has(agent)) return
    const agentCtx = agent.ctx
    const offs = this.#registerForwarders(agentCtx, sessionId)
    if (offs.length === 0) return
    this.adoptedAgents.set(agent, { offs, sessionId })
    this.log(`bridge: adopted live agent ${sessionId} and registered approval/question forwarders`)
  }

  /** 解绑一个被接管 agent 上的转发者（agent 本身不 dispose）。 @param {any} agent */
  #detachAdopted(agent) {
    const record = agent ? this.adoptedAgents.get(agent) : undefined
    if (!record) return
    this.adoptedAgents.delete(agent)
    for (const off of record.offs) {
      try {
        off?.()
      } catch { /* 作用域可能已被 DSH 释放 */ }
    }
  }

  /**
   * 把一条审批请求转发给在线手机；没有手机、超时或请求被中止时交回桌面。
   * @param {string} sessionId
   * @param {any} req
   * @param {() => Promise<any>} next
   */
  async #onApprovalRequest(sessionId, req, next) {
    if (this.disposed) return next()
    const devices = this.#approvalDevices(sessionId)
    if (devices.length === 0) {
      // 没有手机在线：绝不冒领，把问题交回桌面 UI。
      return next()
    }
    const signal = req?.signal
    if (signal?.aborted) return next()

    const approvalId = randomUUID()
    // 手机在线时审批卡常驻：不挂本地超时（用户要求「卡片不设倒计时、常驻手机端」）。
    // 只有用户点「转到电脑」、设备全部断开或请求中止时才交回桌面。
    const expiresAt = this.now() + this.approvalTimeoutMs
    const decisionPromise = new Promise(resolve => {
      /** @type {any} */
      const entry = { resolve, sessionId, deviceIds: new Set(devices), timer: null, signal, onAbort: null }
      this.approvals.set(approvalId, entry)
      // 不设本地超时：卡片常驻到用户作答 / 转电脑 / 请求中止。
      if (signal && typeof signal.addEventListener === 'function') {
        entry.onAbort = () => this.#settleApproval(approvalId, 'aborted')
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    })
    this.emit({
      kind: 'approval-ask',
      sessionId,
      approvalId,
      toolName: String(req?.toolName ?? ''),
      ...(typeof req?.reason === 'string' && req.reason !== '' ? { reason: req.reason.slice(0, 500) } : {}),
      ...(isLocalizedText(req?.displayReason) ? { displayReason: req.displayReason } : {}),
      ...(typeof req?.callId === 'string' && req.callId !== '' ? { callId: req.callId } : {}),
      expiresAt,
    })

    const decision = await decisionPromise
    if (decision === 'delegate') {
      // 用户主动把这次审批转给电脑端：不代替桌面作答，直接 next() 交给桌面 UI。
      this.emit({ kind: 'approval-resolved', sessionId, approvalId, outcome: 'delegated', source: 'phone' })
      return next()
    }
    if (decision === 'allowed-once' || decision === 'rejected') {
      this.emit({ kind: 'approval-resolved', sessionId, approvalId, outcome: decision, source: 'phone' })
      return decision
    }
    // 超时 / 中止：给已经发出去的卡片补一条 resolved，手机据此关掉它。
    this.emit({
      kind: 'approval-resolved',
      sessionId,
      approvalId,
      outcome: 'cancelled',
      source: decision === 'timeout' ? 'timeout' : 'cancelled',
    })
    return next()
  }

  /**
   * 可以接收这条审批的手机。网关按「在线 + 绑定该会话 + 支持 approval-v1」过滤。
   * @param {string} sessionId
   * @returns {string[]}
   */
  #approvalDevices(sessionId) {
    try {
      const devices = this.devicesInSession(sessionId)
      return Array.isArray(devices) ? devices.filter(deviceId => typeof deviceId === 'string' && deviceId !== '') : []
    } catch (error) {
      this.log(`bridge: 查询在线手机失败：${/** @type {Error} */ (error).message}`)
      return []
    }
  }

  /** @param {string} approvalId @param {'allowed-once'|'rejected'|'timeout'|'aborted'|'cancelled'} outcome */
  #settleApproval(approvalId, outcome) {
    const entry = this.approvals.get(approvalId)
    if (!entry) return
    this.approvals.delete(approvalId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.onAbort && typeof entry.signal?.removeEventListener === 'function') {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(outcome)
  }

  // ---------------------------------------------------------------------------
  // 结构化提问转发（v3.0.0）
  // ---------------------------------------------------------------------------

  /**
   * 把一条 DSH 提问（`ask_user_question` / 计划审阅）转发给在线手机。
   *
   * 与审批同构：没有手机在线就 `next()` 交回桌面；超时也交回桌面，但
   * `askTimed()` 的问题在 DSH 里仍然可以补答，所以这里额外保留一段
   * 「迟到可答」窗口，手机晚到的答案会被 steer 进 agent。
   * @param {string} sessionId
   * @param {any} request
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async #onUserQuestion(sessionId, request, next) {
    if (this.disposed) return next()
    const devices = this.#approvalDevices(sessionId)
    if (devices.length === 0) return next()
    const signal = request?.signal
    if (signal?.aborted) return next()
    const items = this.#sanitizeQuestions(request?.questions)
    if (items.length === 0) return next()

    const questionId = randomUUID()
    // askTimed() 的调用方自带超时：我们必须更早把问题交回桌面，否则桌面拿到的是
    // 一个已经过期的等待（模型那时已经被放行）。阻塞式 ask() 没有这个约束。
    const timed = request?.wait?.timed === true
    const timeoutMs = timed ? this.questionTimedTimeoutMs : this.questionTimeoutMs
    const expiresAt = this.now() + timeoutMs
    const callId = typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined
    const agent = request?.agent
    const canAnswerLate = Boolean(callId && agent && timed)
    const outcomePromise = new Promise(resolve => {
      /** @type {any} */
      const entry = { resolve, sessionId, items, deviceIds: new Set(devices), timer: null, signal, onAbort: null }
      this.questions.set(questionId, entry)
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => this.#settleQuestion(questionId, 'timeout'), timeoutMs)
        entry.timer.unref?.()
      }
      if (signal && typeof signal.addEventListener === 'function') {
        entry.onAbort = () => this.#settleQuestion(questionId, 'aborted')
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    })
    this.emit({
      kind: 'question-ask',
      sessionId,
      questionId,
      items,
      ...(callId ? { callId } : {}),
      expiresAt,
      canAnswerLate,
    })

    const outcome = await outcomePromise
    if (Array.isArray(outcome)) {
      this.emit({ kind: 'question-resolved', sessionId, questionId, outcome: 'answered', source: 'phone' })
      return { answers: outcome }
    }
    // 超时/中止：前台等待结束。askTimed 的问题保留补答窗口，然后交回桌面。
    if (outcome === 'timeout' && canAnswerLate) {
      this.#keepLateQuestion(questionId, {
        sessionId,
        items,
        deviceIds: new Set(devices),
        agent,
        callId,
        expiresAt: this.now() + this.questionLateWindowMs,
      })
    }
    this.emit({
      kind: 'question-resolved',
      sessionId,
      questionId,
      outcome: outcome === 'timeout' ? 'timeout' : 'cancelled',
      source: outcome === 'timeout' ? 'timeout' : 'cancelled',
    })
    return next()
  }

  /**
   * 手机对一条待答提问作答。
   * @param {{questionId: string, deviceId?: string, answers: unknown}} input
   * @returns {boolean} 是否真的结算了一条请求
   */
  answerQuestion(input) {
    const questionId = String(input?.questionId ?? '')
    const deviceId = typeof input?.deviceId === 'string' ? input.deviceId : ''
    const pending = this.questions.get(questionId)
    if (pending) {
      if (deviceId !== '' && !pending.deviceIds.has(deviceId)) return false
      const answers = normalizeQuestionAnswers(pending.items, input?.answers)
      if (!answers) return false
      this.#settleQuestion(questionId, answers)
      return true
    }
    const late = this.lateQuestions.get(questionId)
    if (late) {
      if (deviceId !== '' && !late.deviceIds.has(deviceId)) return false
      const answers = normalizeQuestionAnswers(late.items, input?.answers)
      if (!answers) return false
      this.#dropLateQuestion(questionId)
      try {
        // DSH 的 continued question：答案作为 user 消息 steer 回该 call。
        const accepted = this.ctx.userQuestions?.answer?.(late.agent, late.callId, { answers })
        if (accepted === false) return false
      } catch (error) {
        this.log(`bridge: 补答提问失败：${/** @type {Error} */ (error).message}`)
        return false
      }
      this.emit({ kind: 'question-resolved', sessionId: late.sessionId, questionId, outcome: 'answered', source: 'phone-late' })
      return true
    }
    return false
  }

  /**
   * 清洗手机端会看到的题目：只保留形状合法的条目，并对数量/长度设上限，
   * 免得一条恶意或坏掉的帧把手机 UI 和 socket 撑爆。
   * @param {unknown} raw
   * @returns {Array<any>}
   */
  #sanitizeQuestions(raw) {
    const items = []
    for (const candidate of Array.isArray(raw) ? raw : []) {
      if (items.length >= QUESTION_MAX_ITEMS) break
      if (!candidate || typeof candidate !== 'object') continue
      const q = /** @type {Record<string, any>} */ (candidate)
      if (typeof q.id !== 'string' || q.id === '' || typeof q.question !== 'string') continue
      const item = {
        id: q.id.slice(0, 200),
        question: q.question.slice(0, QUESTION_MAX_TEXT),
      }
      if (typeof q.detail === 'string' && q.detail !== '') item.detail = q.detail.slice(0, QUESTION_MAX_TEXT)
      if (typeof q.header === 'string' && q.header !== '') item.header = q.header.slice(0, 200)
      if (Array.isArray(q.options)) {
        const options = q.options
          .filter(option => option && typeof option.label === 'string' && option.label !== '')
          .slice(0, QUESTION_MAX_OPTIONS)
          .map(option => ({
            label: option.label.slice(0, 200),
            ...(typeof option.description === 'string' && option.description !== ''
              ? { description: option.description.slice(0, 500) }
              : {}),
          }))
        if (options.length > 0) item.options = options
      }
      if (q.multiSelect === true) item.multiSelect = true
      if (q.intent && typeof q.intent === 'object' && q.intent.kind === 'plan-review' && typeof q.intent.approve === 'string') {
        item.intent = {
          kind: 'plan-review',
          approve: q.intent.approve.slice(0, 200),
          ...(typeof q.intent.callId === 'string' ? { callId: q.intent.callId } : {}),
        }
      }
      items.push(item)
    }
    return items
  }

  /** @param {string} questionId @param {'timeout'|'aborted'|'cancelled'|Array<any>} outcome */
  #settleQuestion(questionId, outcome) {
    const entry = this.questions.get(questionId)
    if (!entry) return
    this.questions.delete(questionId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.onAbort && typeof entry.signal?.removeEventListener === 'function') {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(outcome)
  }

  /**
   * 记录一个超时后仍可补答的问题（DSH 的 askTimed 语义）。
   * @param {string} questionId
   * @param {{sessionId: string, items: any[], deviceIds: Set<string>, agent: any, callId: string, expiresAt: number}} entry
   */
  #keepLateQuestion(questionId, entry) {
    const timer = setTimeout(() => this.#dropLateQuestion(questionId), Math.max(1, this.questionLateWindowMs))
    timer.unref?.()
    this.lateQuestions.set(questionId, { ...entry, timer })
  }

  /** @param {string} questionId */
  #dropLateQuestion(questionId) {
    const entry = this.lateQuestions.get(questionId)
    if (!entry) return
    this.lateQuestions.delete(questionId)
    if (entry.timer) clearTimeout(entry.timer)
  }

  /** @param {string} sessionId */
  async #selectedTitle(sessionId) {
    const titles = await this.#titles([sessionId])
    const title = titles.get(sessionId)
    return title ? { title } : {}
  }

  /** @param {string} sessionId @returns {Promise<boolean>} */
  async #sessionExists(sessionId) {
    const query = this.#sessionQuery()
    if (typeof query?.listSessions !== 'function') return true // 交给 resume 判断
    try {
      const records = await query.listSessions()
      return (Array.isArray(records) ? records : []).some(record => record?.header?.id === sessionId)
    } catch (error) {
      this.log(`bridge: 校验会话是否存在失败：${/** @type {Error} */ (error).message}`)
      return true
    }
  }

  /**
   * @param {string[]} sessionIds
   * @returns {Promise<Map<string, string>>} sessionId → 标题
   */
  async #titles(sessionIds) {
    /** @type {Map<string, string>} */
    const titles = new Map()
    const query = this.#sessionQuery()
    if (sessionIds.length === 0 || typeof query?.readTitleSnapshots !== 'function') return titles
    try {
      const snapshots = await query.readTitleSnapshots(sessionIds)
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const title = snapshot?.value?.title
        if (snapshot?.status === 'fulfilled' && typeof title === 'string' && title.trim() !== '') {
          titles.set(snapshot.sessionId, title.trim())
        }
      }
    } catch (error) {
      this.log(`bridge: 读取会话标题失败：${/** @type {Error} */ (error).message}`)
    }
    return titles
  }

  /** @param {any} header */
  #titleFallback(header) {
    const cwd = typeof header?.cwd === 'string' ? header.cwd.replace(/[\\/]+$/, '') : ''
    const last = cwd.split(/[\\/]/).pop()
    return last && last !== cwd ? last : '新会话'
  }

  /**
   * 读 `ctx.sessionQuery`：宿主用 `ctx.get()` 暴露可选服务（直接读属性在
   * Cordis 里会因未 inject 而抛），测试用的假 ctx 则直接挂属性。
   */
  #sessionQuery() {
    const ctx = this.ctx
    if (typeof ctx?.get === 'function') {
      try {
        const service = ctx.get('sessionQuery')
        if (service) return service
      } catch { /* 服务未提供 */ }
    }
    try {
      return ctx?.sessionQuery
    } catch {
      return undefined
    }
  }

  /**
   * Deliver one phone message into the conversation it is bound to.
   * @param {object} input
   * @param {string} input.deviceId
   * @param {string} input.sessionId 会话（网关持有 device → session 绑定）
   * @param {string} input.callId
   * @param {string} input.text
   * @param {Array<{name: string, mime?: string, size?: number, dataBase64?: string, path?: string, fileId?: string}>} input.attachments
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
    const sessionId = String(input.sessionId ?? '')
    if (sessionId === '') throw new Error('这条消息没有绑定会话')
    bridgeDiagnostic(`bridge: send 开始 session=${sessionId} device=${input.deviceId} callId=${input.callId} 文本长度=${input.text?.length ?? 0} 附件=${input.attachments?.length ?? 0}`)

    const entry = await this.#ensureAgent(sessionId)
    if (!entry) throw new Error('无法创建会话')
    bridgeDiagnostic(`bridge: 会话就绪 sessionId=${entry.sessionId}`)

    const text = this.#composeText(input)

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
    const entry = this.agents.get(call.sessionId)
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

  /**
   * 释放一个不再被任何设备绑定的会话（解绑/切换时调用）。
   *
   * 会话历史已持久化，下次 `resume()` 仍能恢复；不释放会让 agent 泄漏。
   * @param {string} sessionId
   */
  async releaseSession(sessionId) {
    const entry = this.agents.get(sessionId)
    if (!entry) return
    this.agents.delete(sessionId)
    // 接管的 live agent 归桌面所有：只摘掉我们加的转发者，不 dispose 它。
    this.#detachAdopted(entry.agent)
    for (const call of [...this.calls.values()]) {
      if (call.sessionId === sessionId) this.#retireCall(call)
    }
    for (const [fileId, record] of this.files) {
      if (record.sessionId === sessionId) this.files.delete(fileId)
    }
    if (entry.handle?.dispose) {
      try {
        await entry.handle.dispose()
      } catch (error) {
        this.log(`bridge: dispose failed for ${sessionId}: ${/** @type {Error} */ (error).message}`)
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
   * Get or create the agent for a session.
   * @param {string} sessionId
   */
  async #ensureAgent(sessionId) {
    const existing = this.agents.get(sessionId)
    if (existing?.agent && this.ctx.agents.get(sessionId)) return { sessionId, ...existing }

    const live = this.ctx.agents.get(sessionId)
    if (live) {
      // 会话可能是桌面上早就跑着的 agent：setup 已经跑完，必须在这里补注册
      // 审批/提问转发者，否则手机永远收不到这个会话的审批卡。
      const entry = this.agents.get(sessionId)?.agent === live
        ? this.agents.get(sessionId)
        : this.#adoptLiveAgent(sessionId, live)
      this.agents.set(sessionId, entry)
      return { sessionId, ...entry }
    }

    // 到这里说明：内存里没有活动 agent。但会话可能已经**持久化在磁盘上**
    // （DSH 重启后内存清空，会话文件仍在）。此时直接 `create()` 会撞名：
    //   session "ow-xxx" already exists
    // 这个问题曾导致手机消息全部投递失败，而现象只是「一直发送中」。
    //
    // 正确顺序是：
    //   ① 先 `resume()` 恢复磁盘上的既有会话（保留历史，且能接管上次中断的轮次）
    //   ② 只有确认磁盘上也没有时，才 `create()` 新建
    const setup = this.#setupFor(sessionId)
    const resumed = await this.#tryResumeAgent(sessionId, setup)
    if (resumed) {
      const entry = { agent: resumed.agent, handle: resumed.handle }
      this.agents.set(sessionId, entry)
      this.log(`bridge: resumed conversation ${sessionId}`)
      return { sessionId, ...entry }
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.#cwd() },
      agentOptions: this.#agentOptions(),
      setup,
    })
    const entry = { agent: handle.agent, handle }
    this.agents.set(sessionId, entry)
    this.log(`bridge: created conversation ${sessionId}`)
    return { sessionId, ...entry }
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
   * Route one durable session event. One event is reduced exactly once and
   * emitted as a session-scoped event; the gateway fans it out to the devices
   * bound to that session.
   * @param {any} session
   * @param {any} event
   */
  #onSessionEvent(session, event) {
    const sessionId = this.#sessionIdOf(session)
    if (!sessionId) return
    // 只有本插件创建/接管的会话才处理：桌面上的其它会话不能把内容推给手机。
    if (!this.agents.has(sessionId)) return

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
        sessionId: call.sessionId,
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

/** Text blocks of a user message's `content` array. */
/**
 * DSH 会把「runtime context」「skill catalog 变更」这类**内部注入**也写成
 * `user/message` 事件（role=user，但 `source.kind` 是 runtime-context /
 * system-prompt / skill-catalog 等）。它们如果原样进手机，就会变成一排蓝色
 * 的用户气泡——真机反馈「我这边出现了不是我发的消息」。
 *
 * 只放行真正由用户/客户端产生的消息；没有 source 的旧数据放行（兼容）。
 * 文本前缀检查是兜底：万一日志里没有 source 元数据。
 * @param {any} data
 * @returns {boolean}
 */
export function isInjectedUserMessage(data) {
  const kind = typeof data?.source?.kind === 'string' ? data.source.kind : ''
  if (kind !== '' && INJECTED_USER_SOURCES.has(kind)) return true
  if (typeof data?.role === 'string' && data.role !== 'user') return true
  const text = extractUserText(data)
  // 兜底（不依赖 source 元数据）：DSH 的运行时上下文 / 系统提醒还有几种固定开头，
  // 包括 "Time sampled while preparing turn N…" 这类按回合注入的时间信息。
  return (
    /^<system-reminder>/i.test(text)
    || /^Current runtime context[.:]/i.test(text)
    || /^Time sampled while preparing turn /i.test(text)
    || /^Browser time zone for this request:/i.test(text)
    || /^Elapsed since the preceding model-visible message:/i.test(text)
    || /^The available skill catalog changed/i.test(text)
  )
}

/** 这些 source.kind 是 harness 内部注入，不能当成用户消息展示。 */
const INJECTED_USER_SOURCES = new Set([
  'runtime-context',
  'system-prompt',
  'system',
  'system-reminder',
  'skill-catalog',
  'tool-registry',
  'agent-instructions',
  'hook',
  'maintenance',
  'context',
  'context-summary',
  'session-summary',
  'developer',
])

function extractUserText(data) {
  const blocks = data?.content
  if (!Array.isArray(blocks)) return typeof data?.text === 'string' ? data.text : ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * One event of a DSH session log → one snapshot bubble for `session/state`.
 *
 * Only the two user-visible event kinds are mapped. `assistant/attempt` is not
 * committed history (the loop may retry it), so it must not become a bubble.
 * @param {any} event
 * @returns {{id: string, kind: 'user'|'assistant', text: string, at: string} | undefined}
 */
export function historyMessageOf(event) {
  const type = event?.type
  let kind
  let text
  if (type === 'user/message') {
    // 内部注入（runtime context / skill catalog 等）不是用户消息，绝不能变成蓝色气泡。
    if (isInjectedUserMessage(event?.data)) return undefined
    kind = 'user'
    text = extractUserText(event?.data)
  } else if (type === 'assistant/message') {
    kind = 'assistant'
    text = extractAssistantText(event?.data)
  } else {
    return undefined
  }
  if (!text) return undefined
  return {
    id: `hist_${event?.seq ?? 'x'}`,
    kind,
    text,
    at: isoTimeOf(event?.time),
  }
}

/** @param {unknown} value */
function isoTimeOf(value) {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString()
}

/**
 * Is this a localized display string the phone can resolve (`{en, zh, ...}`)?
 * Kept strict so a non-serializable reason cannot leak into the frame.
 * @param {unknown} value
 */
export function isLocalizedText(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 32) return false
  return entries.every(([key, text]) => key.length <= 32 && typeof text === 'string' && text.length <= 500)
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
