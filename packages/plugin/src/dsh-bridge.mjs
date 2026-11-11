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
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  APPROVAL_REPLY_OUTCOMES,
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


/** 交回桌面的审批保留多久，用于重连时给手机补一条 resolved（清掉点不动的卡片）。 */
const RECENT_RESOLUTION_TTL_MS = 3 * 60_000

/** 每个会话最多保留多少条最近的审批结果。 */
const RECENT_RESOLUTION_LIMIT = 20

/** 会话标题展示上限（字符）：超长标题在手机列表/标签里截断，避免撑破界面。 */
const SESSION_TITLE_MAX_LENGTH = 80

/**
 * 已实测「signal 代理能关掉桌面弹窗」的 DSH 版本白名单。
 *
 * 手机作答后自动关闭桌面原生弹窗，靠的是把审批请求的 `req.signal` 换成我们自己的
 * `AbortController` 代理（见 `#installSignalProxy`）。这依赖 DSH 内部实现：
 * `ui-approval` 的 `PendingApproval` 只在自己被作答或 `request.signal` abort 时关闭。
 * 升级后可能一变就失效，所以：
 *  - 启动时跑一次本地自检（`runApprovalProxySelfCheck`），失败就整场退回「不代理」；
 *  - 自检通过但版本不在本表里时**仍然启用**，只记一条「未实测，代理可能失效」的
 *    警告日志，并在 `bridge.approvalProxyStatus()` 里体现 `tested:false`。
 *
 * 维护规则：升级 DSH 后跑一次双端审批冒烟（手机先答 → 桌面弹窗自动消失），通过了
 * 才把新版本加进来。当前值来自 2026-11-10 实测的桌面版 `0.2.2-rc.1`（updater 的
 * `pending/update-info.json` 与 profile 里同批 `@deepseek-ai/*` 依赖都是 0.2.2-rc.1）。
 * 同一 `x.y.z` 家族的预发布/正式版共用同一份 `ui-approval` 实现，所以家族匹配
 * （`0.2.2` 与 `0.2.2-rc.1`）也算已实测；跨小版本不算。
 */
export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.2-rc.1'])

/** 去掉 `v` 前缀与构建元数据（`+sha`），便于比较。 */
function stripVersionNoise(version) {
  return String(version).trim().replace(/^v/i, '').split('+')[0]
}

/**
 * 把一个版本号归一化成 `x.y.z[-预发布]`，认不出来返回 `null`。
 * 不用正则里的数字类，避免转义问题：按 `-` 和 `.` 手工切。
 * @param {unknown} version
 * @returns {string | null}
 */
export function normalizeDshVersion(version) {
  if (typeof version !== 'string') return null
  const text = stripVersionNoise(version)
  const dash = text.indexOf('-')
  const core = dash >= 0 ? text.slice(0, dash) : text
  const parts = core.split('.')
  if (parts.length !== 3) return null
  if (!parts.every(part => part !== '' && [...part].every(digit => digit >= '0' && digit <= '9'))) return null
  const prerelease = dash >= 0 ? text.slice(dash + 1) : ''
  if (prerelease !== '' && !/^[0-9A-Za-z.-]+$/.test(prerelease)) return null
  return text
}

/**
 * 这个 DSH 版本是否在已实测白名单里（含同 `x.y.z` 家族）。
 * 版本不可读（`null`）一律算未实测。
 * @param {unknown} version
 * @returns {boolean}
 */
export function isTestedDshVersion(version) {
  const normalized = normalizeDshVersion(version)
  if (!normalized) return false
  if (TESTED_DSH_VERSIONS.includes(normalized)) return true
  const family = normalized.split('-')[0]
  return TESTED_DSH_VERSIONS.some(tested => stripVersionNoise(tested).split('-')[0] === family)
}

/**
 * 读宿主 DSH 版本，读不到返回 `null`（不抛）。
 *
 * 依次尝试：显式覆盖（`OPENWHALE_DSH_VERSION` 环境变量）→ 宿主上下文里可能暴露的
 * version → 宿主包清单（Electron 里 `app.asar` 内的 package.json 可以当普通文件读）
 * → 桌面版根 package.json。任何一步失败都继续下一步：版本只用于「已实测」判定，
 * 读不到不影响功能，只是 `approvalProxyStatus()` 里标成未实测。
 * @param {any} [ctx]
 * @returns {string | null}
 */
export function readHostDshVersion(ctx) {
  const fromEnv = process.env?.OPENWHALE_DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  // 宿主上下文暴露的位置随版本变化，逐个探；服务不存在/未声明时 get() 会抛，吞掉继续。
  const probes = [
    () => ctx?.get?.('app')?.version,
    () => ctx?.app?.version,
    () => ctx?.get?.('dsh')?.version,
    () => ctx?.dsh?.version,
  ]
  for (const probe of probes) {
    try {
      const value = probe()
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch { /* 该 seam 不存在：继续 */ }
  }
  const manifests = []
  for (const root of HOST_MODULE_ROOTS) {
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']) {
      manifests.push(join(root, ...name.split('/'), 'package.json'))
    }
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    manifests.push(join(process.resourcesPath, 'app.asar', 'package.json'))
    manifests.push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
  }
  for (const manifest of manifests) {
    try {
      const version = JSON.parse(readFileSync(manifest, 'utf8'))?.version
      if (typeof version === 'string' && version.trim() !== '') return version.trim()
    } catch { /* 文件不存在或不是 JSON：继续 */ }
  }
  return null
}

/**
 * signal 代理的启动自检：**本地可验证、无副作用**。
 *
 * 用合成的 `AbortController` 走一遍真实的转发链，证明这个 JS 运行时里：
 *  1. `AbortSignal` 支持 `addEventListener`；
 *  2. 原始 signal 的 abort 能转发到代理 signal（「停止/取消」仍然有效）；
 *  3. 代理 signal 能写进一个普通对象的 `signal` 属性（审批请求就是这个形状）；
 *  4. 代理 signal 自己 abort 后 `aborted` 可读（手机作答关弹窗走这条）。
 *
 * 只说运行时这一侧的事：它无法证明 DSH 审批服务会把下游 answerer 眼里 signal 的
 * abort 传回前端弹窗——那需要真实双端审批冒烟，所以另有版本白名单兜底。
 * 全程只新建对象、不碰 ctx 与全局状态，失败也返回结果而不是抛。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function runApprovalProxySelfCheck() {
  try {
    if (typeof AbortController !== 'function') return { ok: false, reason: '运行时没有 AbortController' }
    const original = new AbortController()
    const proxy = new AbortController()
    if (!original.signal || typeof original.signal.addEventListener !== 'function') {
      return { ok: false, reason: 'AbortSignal 不支持 addEventListener' }
    }
    if (!proxy.signal || typeof proxy.signal.addEventListener !== 'function') {
      return { ok: false, reason: '代理 AbortSignal 缺少 addEventListener' }
    }
    let forwarded = false
    original.signal.addEventListener('abort', () => {
      forwarded = true
      proxy.abort(original.signal.reason)
    }, { once: true })
    if (original.signal.aborted) return { ok: false, reason: '新建的 signal 已经是 aborted' }
    original.abort(new Error('openwhale-selfcheck'))
    if (!forwarded) return { ok: false, reason: '原始 signal 的 abort 没有触发转发' }
    if (!proxy.signal.aborted) return { ok: false, reason: 'abort 没有转发到代理 signal' }
    const syntheticRequest = {}
    syntheticRequest.signal = proxy.signal
    if (syntheticRequest.signal !== proxy.signal) {
      return { ok: false, reason: '代理 signal 写不进请求对象的 signal 属性' }
    }
    const answered = new AbortController()
    answered.abort(new Error('answered-on-phone'))
    if (!answered.signal.aborted) return { ok: false, reason: '代理 signal 的 abort 不可读' }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `自检抛错：${/** @type {Error} */ (error)?.message ?? String(error)}` }
  }
}

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
    /**
     * 新建手机会话时写入 SessionHeader 的 agent preset。
     *
     * 不写的话 DSH 会用 profile 的默认预设：那个预设只有插件/团队类工具，
     * 没有 read_image / read / write / edit / grep / ops_* / web_*。真机上表现为
     * DSH 重启后手机助理「读图工具掉线」、读不了文件、用不了命令和联网。桌面 GUI
     * 创建会话时用的就是 standard（主会话实测 57 个工具）。
     * @type {string}
     */
    this.agentPreset = typeof options.agentPreset === 'string' && options.agentPreset !== ''
      ? options.agentPreset
      : 'standard'
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
    /**
     * 本插件自己 create/resume 的 agent（`setup` 已在这上面注册过转发者）。
     *
     * 它们同样会触发全局 `agent/created`，必须跳过，否则同一个 agent 上会挂两套
     * 转发者：一份审批请求会给手机推两张卡、答复也只能结算其中一张。
     * @type {WeakSet<any>}
     */
    this.ownedAgents = new WeakSet()
    /** fileId → { name, size, mime, path, deviceId } */
    this.files = new Map()
    /** `${deviceId}\u0000${callId}` → 进行中的回合 */
    this.calls = new Map()
    /** 已受理过的 (deviceId, callId)：网关幂等表之后的第二道防线。 */
    this.seenCalls = new IdempotencyCache()
    /**
     * 手机注入的 DSH 消息 id → 手机端 msgId。
     *
     * 会话历史快照（`session/state`）是从 DSH 日志重建的，同一条手机消息在日志里
     * 的 id 与手机本地气泡的 `usr_<msgId>` 不同——不映射就会出现「同一句消息在
     * 手机上出现两遍」：本地乐观气泡一条、快照重建一条（后者还带着附件提示原文）。
     * 有界 Map：手机消息只在「最近可能重连」的窗口内需要，超过上限丢最旧的。
     * @type {Map<string, string>}
     */
    this.phoneMessageIds = new Map()
    /** sessionId → 已投递给 DSH、还没等到 turn/start 的回合队列 */
    this.pendingCalls = new Map()
    /** `${sessionId}:${turn}` → 该轮次属于哪个手机消息 */
    this.turnCalls = new Map()
    /** approvalId → 等待手机作答的请求 */
    this.approvals = new Map()
    /** sessionId → 最近结束的审批 [{approvalId, outcome, source, at}]，重连时补 resolved。 */
    this.recentResolutionLog = new Map()
    /** questionId → 等待手机作答的结构化提问（前台等待期间） */
    this.questions = new Map()
    /** questionId → 前台等待超时后仍可补答的提问（DSH 的 askTimed/continued） */
    this.lateQuestions = new Map()
    this.disposed = false
    // 审批 signal 代理的启动自检 + 版本判定（只跑一次；结论进日志与 health）。
    // 配置关闭或自检失败都只降级为「不代理」，不影响手机卡片与「先答先算」，也绝不抛。
    this.#initApprovalProxy(options)
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
    // 桌面自己恢复/新建的 agent 不会经过本插件的 `setup`（DSH 重启后手机先连上、
    // 桌面上那条会话随后才 resume，就属于这种次序）。只靠 selectSession/send 时
    // 补注册会漏掉它：审批只在桌面弹、手机毫无反应。全局 `agent/created` 让任何
    // 变成 live 的会话都补上转发者——真正要不要转发仍由 `devicesInSession` 决定。
    this.subscriptions.push(this.ctx.on('agent/created', payload => {
      this.#onAgentCreated(payload?.agent)
    }))
    this.subscriptions.push(this.ctx.on('agent/disposed', payload => {
      this.#onAgentDisposed(payload?.agent)
    }))
  }

  /**
   * 一个 agent 变成 live（新建 / resume / clear / compaction 都算）。
   *
   * `agent/created` 是 serial 事件，监听器抛错会让整个会话创建失败，所以这里
   * 任何异常都吞掉并记日志。
   * @param {any} agent
   */
  #onAgentCreated(agent) {
    try {
      if (!agent) return
      const sessionId = typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '') return
      // 本插件 setup 已经注册过；重复注册会给手机推两张卡。
      if (this.ownedAgents.has(agent)) return
      if (this.adoptedAgents.has(agent)) return
      if (!agent.ctx || typeof agent.ctx.on !== 'function') return
      this.#adoptLiveAgent(sessionId, agent)
      this.log(`bridge: agent/created 接管 ${sessionId}，已补注册审批/提问转发者`)
    } catch (error) {
      this.log(`bridge: agent/created 接管失败：${/** @type {Error} */ (error).message}`)
    }
  }

  /**
   * agent 从注册表移除：解绑我们加的转发者，清掉不是本插件创建的 entry。
   * @param {any} agent
   */
  #onAgentDisposed(agent) {
    try {
      if (!agent) return
      this.#detachAdopted(agent)
      for (const [sessionId, entry] of this.agents) {
        if (entry?.agent === agent && !entry.handle) this.agents.delete(sessionId)
      }
    } catch (error) {
      this.log(`bridge: agent/disposed 清理失败：${/** @type {Error} */ (error).message}`)
    }
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
    // 没有真实标题的会话按 cwd 兜底：同一个 cwd 下有多个时全部补 id 后缀，
    // 否则手机列表里一排「default-workspace」无法区分（用户实测反馈）。
    const fallbackCounts = new Map()
    for (const record of limited) {
      if (titles.has(record.header.id)) continue
      const key = this.#titleFallbackBase(record.header)
      fallbackCounts.set(key, (fallbackCounts.get(key) ?? 0) + 1)
    }
    const sessions = limited.map(record => {
      const header = record.header
      const live = record.live === true || Boolean(this.ctx.agents.get(header.id))
      const realTitle = titles.get(header.id)
      const fallback = this.#titleFallbackBase(header)
      return {
        id: header.id,
        title: realTitle
          ?? this.#titleFallback(header, { distinct: (fallbackCounts.get(fallback) ?? 0) > 1 }),
        ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
        createdAt: Number(header.createdAt) || 0,
        live,
      }
    })
    // 真实标题也可能撞名（DSH 自动标题是内容摘要）：确定性去重，后出现的加 #2/#3。
    return { sessions: this.#dedupeSessionTitles(sessions), truncated }
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
      // agentPreset 决定会话的工具集/提示词组合：standard 才有读图/文件/命令/联网工具。
      meta: { cwd: this.#cwd(), agentPreset: this.agentPreset },
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
   * @returns {Promise<Array<{id: string, kind: 'user'|'assistant', text: string, at: string, msgId?: string, seq?: number}>>}
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
      if (!mapped) continue
      if (mapped.kind === 'user') {
        const messageId = typeof event?.data?.id === 'string' ? event.data.id : ''
        const phoneMsgId = messageId !== '' ? this.phoneMessageIds.get(messageId) : undefined
        if (phoneMsgId !== undefined) {
          // 手机自己发的：映射回本地气泡 id，并去掉插件注入的附件提示（只该给模型看）。
          mapped.msgId = phoneMsgId
        } else if (messageId !== '' && typeof event?.data?.source?.rpcId === 'string' && event.data.source.rpcId !== '') {
          // 桌面 GUI 消息：手机实时收到的是 chat/echo（msgId=dsh_<id>），历史用同一个 id 才能去重。
          mapped.msgId = `dsh_${messageId}`
        }
        mapped.text = stripPhoneAttachmentNotice(mapped.text)
      }
      messages.push(mapped)
    }
    return messages.slice(-SESSION_SNAPSHOT_LIMIT)
  }

  // ---------------------------------------------------------------------------
  // 审批转发（v2.3.0）
  // ---------------------------------------------------------------------------

  /**
   * 审批 signal 代理的启动自检 + 版本判定（构造函数里只跑一次）。
   *
   * 结果放在 `this.approvalProxy`：
   *  - `enabled`：本进程是否真的会去写 `req.signal`。配置关闭或自检失败时是 `false`，
   *    此时 `#installSignalProxy` 直接返回，`req.signal` 一个字节都不改；
   *  - `selfCheck`：`'passed'` / `'failed'` / `'skipped'`（配置关闭时跳过自检）；
   *  - `hostVersion`：探测到的 DSH 版本，读不到是 `null`；
   *  - `tested`：版本是否在 `TESTED_DSH_VERSIONS` 里（未实测仍启用，只是可能失效）；
   *  - `reason`：一句中文结论，直接进日志与 health。
   * 自检失败/探测失败/日志本身失败都不抛：审批降级为「桌面留框」，手机卡片与
   * 「先答先算」不受影响。
   * @param {any} options
   */
  #initApprovalProxy(options) {
    const status = {
      enabled: false,
      selfCheck: 'failed',
      hostVersion: null,
      tested: false,
      reason: '代理状态未初始化',
    }
    try {
      const configured = this.config?.experimentalDualApproval !== false
      const forced = options != null && Object.prototype.hasOwnProperty.call(options, 'hostVersion')
      const hostVersion = forced ? options.hostVersion : readHostDshVersion(this.ctx)
      // 配置关闭时连自检都不跑（自检只是为了判断「能不能安全地写 req.signal」）。
      const check = !configured
        ? null
        : (typeof options?.approvalSelfCheck === 'function'
          ? options.approvalSelfCheck()
          : runApprovalProxySelfCheck())
      status.hostVersion = typeof hostVersion === 'string' && hostVersion.trim() !== '' ? hostVersion.trim() : null
      status.tested = isTestedDshVersion(status.hostVersion)
      if (!configured) {
        status.selfCheck = 'skipped'
        status.enabled = false
        status.reason = 'experimentalDualApproval 已关闭：不做 signal 代理，桌面弹窗需用户自己点掉'
        this.log('approval: 实验性双端审批已关闭（experimentalDualApproval=false）→ 不做 signal 代理，桌面弹窗需手动点掉；手机卡片与「先答先算」仍然生效')
      } else if (check?.ok !== true) {
        status.selfCheck = 'failed'
        status.enabled = false
        status.reason = `代理自检失败：${check?.reason ?? '未知原因'}`
        this.log(`approval: 代理自检失败（${check?.reason ?? '未知原因'}）→ 自动退回「不代理」模式：手机仍可作答，桌面弹窗需手动点掉`)
      } else {
        status.selfCheck = 'passed'
        status.enabled = true
        if (status.tested) {
          status.reason = `已实测版本 ${status.hostVersion}，signal 代理可用`
          this.log(`approval: 代理自检通过（AbortController 转发链可用）；DSH ${status.hostVersion} 已实测 → 手机作答会关闭桌面弹窗`)
        } else if (status.hostVersion) {
          status.reason = `未实测版本 ${status.hostVersion}，代理可能失效`
          this.log(`approval: 代理自检通过，但 DSH ${status.hostVersion} 未实测，代理可能失效（建议跑一次双端审批冒烟：手机先答 → 看桌面弹窗是否关闭）`)
        } else {
          status.reason = '运行时 DSH 版本不可读，无法确认是否已实测，代理可能失效'
          this.log('approval: 代理自检通过，但运行时 DSH 版本不可读，无法确认是否已实测，代理可能失效（代理仍启用）')
        }
      }
    } catch (error) {
      status.enabled = false
      status.selfCheck = 'failed'
      status.reason = `代理自检异常：${/** @type {Error} */ (error)?.message ?? String(error)}`
      try {
        this.log(`approval: ${status.reason} → 自动退回「不代理」模式`)
      } catch { /* 日志本身失败也不能影响插件 */ }
    }
    this.approvalProxy = status
  }

  /**
   * 审批 signal 代理的当前状态（health 用；JSON 安全，不暴露内部对象）。
   * @returns {{enabled: boolean, selfCheck: string, hostVersion: string | null, tested: boolean, reason: string}}
   */
  approvalProxyStatus() {
    const state = this.approvalProxy ?? {}
    return {
      enabled: state.enabled === true,
      selfCheck: typeof state.selfCheck === 'string' ? state.selfCheck : 'failed',
      hostVersion: typeof state.hostVersion === 'string' ? state.hostVersion : null,
      tested: state.tested === true,
      reason: typeof state.reason === 'string' ? state.reason : '代理状态未初始化',
    }
  }

  /**
   * 手机对一条待答审批作答（B 版：桌面与手机同时可答，谁先答算谁）。
   * @param {{approvalId: string, deviceId?: string, outcome: string}} input
   * @returns {boolean} 是否真的结算了一条等待中的请求
   */
  answerApproval(input) {
    const approvalId = String(input?.approvalId ?? '')
    const entry = this.approvals.get(approvalId)
    if (!entry) return false
    const deviceId = typeof input?.deviceId === 'string' ? input.deviceId : ''
    // 只有被问过的那台手机能答，避免同会话的另一台设备抢答。
    if (deviceId !== '' && !entry.deviceIds.has(deviceId)) {
      // 请求到达时手机不在线：桌面已经在等，手机连上后仍可作答（双端可答）。
      const online = this.#approvalDevices(entry.sessionId)
      if (!online.includes(deviceId)) return false
    }
    const outcome = APPROVAL_REPLY_OUTCOMES.includes(/** @type {any} */ (input?.outcome))
      ? /** @type {string} */ (input.outcome)
      : 'rejected'
    if (outcome === 'delegate') {
      // 手机主动转电脑：立刻交给桌面，请求继续挂着等桌面结果。
      if (!entry.desktop) {
        this.log(`approval: ${approvalId} 手机选择转到电脑`)
        this.#transferToDesktop(entry)
      }
      return true
    }
    // B 版实验：转桌面后手机仍可作答（双端同时可答）。
    const proxy = entry.proxyController
    this.#settleApproval(approvalId, outcome, 'phone')
    this.log(`approval: ${approvalId} 手机答复 → ${outcome}${entry.desktop ? '（桌面已弹窗）' : ''}`)
    // 双端实验：用代理 signal 的 abort 把桌面原生弹窗收掉（若 hack 生效）。
    if (proxy && entry.hackActive) {
      try {
        proxy.abort(new Error('answered on phone'))
        this.log(`approval: ${approvalId} 已 abort signal 代理，通知桌面关闭弹窗`)
      } catch (error) {
        this.log(`approval: ${approvalId} abort signal 代理失败：${/** @type {Error} */ (error).message}`)
      }
    }
    return true
  }

  /**
   * 一个 agent 的 setup 工厂：声音段落 + 审批/提问转发 + agent preset 工具集。
   * @param {string} sessionId
   */
  #setupFor(sessionId) {
    /** @type {(agentCtx: any, agent: any) => Promise<void>} */
    return (agentCtx, agent) => this.#setupAgent(agentCtx, agent, sessionId)
  }

  /**
   * 读 `ctx.agentPresets`（DSH 的 agent preset 注册表，宿主可选服务）。
   *
   * 与 `#sessionQuery` 同一套兼容策略：Cordis 里必须用 `ctx.get()`（直接读属性会
   * 因未 inject 而抛），测试用的假 ctx 则可以直接挂属性。
   * @returns {any}
   */
  #agentPresetService() {
    const ctx = this.ctx
    if (typeof ctx?.get === 'function') {
      try {
        const service = ctx.get('agentPresets')
        if (service) return service
      } catch { /* 服务未提供 */ }
    }
    try {
      return ctx?.agentPresets
    } catch {
      return undefined
    }
  }

  /**
   * 把会话的 agent preset 挂到 setup 的 agent 作用域上。
   *
   * 根因（真机会话 `01d47803…` 日志）：DSH 的 Web 会话控制器在 create/resume 时
   * 会用 `agentPresets.mount(agentCtx, presetId)` 绑定 preset
   * （`@deepseek-ai/dsh-api-session-controller` 的 `composeAgent`）；read_image /
   * read / write / edit / grep / glob / web_* / todo 这些工具是 preset 行
   * （`@deepseek-ai/dsh-tool-fs` 等的 `apply()`）在**该 agent 作用域**里注册的，
   * 不是宿主全局工具。插件自己走 `ctx.agents.create/resume` 不经过那条路径，
   * 只在 SessionHeader 里写了 `agentPreset` 字段，所以手机 agent 只有宿主工具
   * （实测 23~30 个）而不是桌面 GUI 的 57 个。
   *
   * `mount()` 的入参就是 setup 回调里的 `agentCtx`（DSH 文档：绑定"未发布的
   * agent"要用 setup 的 ctx），所以这里复用同一个公开 API：新建会话当场生效，
   * 旧会话（header 里没记录 preset 的）在下次 resume 时也会补上。
   *
   * 任何失败都只记日志、绝不阻断 agent 创建：preset 服务不可用/定义缺失时，
   * 手机端退化为宿主默认工具集（当前行为），不会让发消息整个失败。
   * @param {any} agentCtx setup 回调给的 agent 作用域
   * @param {any} agent 该 agent（用来读会话里已记录的 preset）
   * @returns {Promise<boolean>} 是否成功绑定
   */
  async #mountAgentPreset(agentCtx, agent) {
    const presets = this.#agentPresetService()
    if (!presets || typeof presets.mount !== 'function' || !agentCtx) {
      // 真机排查用：出现这行说明宿主没暴露 preset 服务（或当前 profile 没装
      // agent-preset 注册表），此时手机 agent 只能拿到宿主全局工具。
      this.log('bridge: agentPresets 服务不可用，跳过 agent preset 挂载（工具集退化为宿主全局）')
      return false
    }
    let wanted = this.agentPreset
    try {
      const recorded = typeof presets.presetForSession === 'function' && agent?.session
        ? presets.presetForSession(agent.session)
        : undefined
      if (typeof recorded === 'string' && recorded !== '') wanted = recorded
    } catch { /* 投影读取失败时退回配置值 */ }
    try {
      const resolved = typeof presets.resolve === 'function'
        ? await presets.resolve(wanted)
        : { id: wanted }
      const id = typeof resolved?.id === 'string' && resolved.id !== '' ? resolved.id : wanted
      await presets.mount(agentCtx, id)
      this.log(`bridge: mounted agent preset ${id} for ${agent?.id ?? 'new agent'}`)
      return true
    } catch (error) {
      this.log(`bridge: 挂载 agent preset ${wanted} 失败：${/** @type {Error} */ (error)?.message ?? error}`)
    }
    // 会话里记录的 preset 可能已被删除（profile 改过）：退回本插件配置的 preset 再试一次。
    if (wanted !== this.agentPreset) {
      try {
        const fallback = typeof presets.resolve === 'function'
          ? await presets.resolve(undefined)
          : { id: undefined }
        await presets.mount(agentCtx, typeof fallback?.id === 'string' ? fallback.id : undefined)
        this.log(`bridge: mounted fallback agent preset ${fallback?.id ?? '(default)'}`)
        return true
      } catch (fallbackError) {
        this.log(`bridge: 兜底 preset 也挂载失败：${/** @type {Error} */ (fallbackError)?.message ?? fallbackError}`)
      }
    }
    return false
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
   * 一个 agent 的 setup：声音段落 + 审批/提问转发 + agent preset 工具集。
   * @param {any} agentCtx
   * @param {any} _agent
   * @param {string} sessionId
   */
  async #setupAgent(agentCtx, _agent, sessionId) {
    // 标记「本插件创建/恢复」的 agent：`agent/created` 监听器据此跳过补注册。
    if (_agent) this.ownedAgents.add(_agent)
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
    // DSH 的 Web 会话在 composeAgent 里把 preset 绑到 setup 的 agentCtx 上；
    // 插件自己 create/resume 不经过那条路径，必须在这里补一次，否则 preset 里的
    // tool-fs/tool-web/... 工具（含 read_image）不会注册到这个 agent。
    await this.#mountAgentPreset(agentCtx, _agent)
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
   * B 版：双端同时可见、同时可答。
   *
   * 请求一到达就同时推给手机并发起桌面原生弹窗（`next()`），两边都能作答；
   * 谁先答算谁。不做 120 秒转交、不做转桌面提醒、不做自动拒绝。
   * @param {string} sessionId
   * @param {any} req
   * @param {() => Promise<any>} next
   */
  async #onApprovalRequest(sessionId, req, next) {
    if (this.disposed) return next()
    const signal = req?.signal
    if (signal?.aborted) return next()
    const devices = this.#approvalDevices(sessionId)

    const approvalId = randomUUID()
    const payload = {
      kind: 'approval-ask',
      sessionId,
      approvalId,
      toolName: String(req?.toolName ?? ''),
      ...(typeof req?.reason === 'string' && req.reason !== '' ? { reason: req.reason.slice(0, 500) } : {}),
      ...(isLocalizedText(req?.displayReason) ? { displayReason: req.displayReason } : {}),
      ...(typeof req?.callId === 'string' && req.callId !== '' ? { callId: req.callId } : {}),
    }
    /** @type {any} */
    let entry
    const decisionPromise = new Promise(resolve => {
      entry = {
        approvalId,
        resolve,
        sessionId,
        deviceIds: new Set(devices),
        payload,
        signal,
        req,
        onAbort: null,
        next,
        proxyController: null,
        proxyForwardAbort: null,
        hackActive: false,
        desktop: false,
        desktopAnswer: null,
      }
      this.approvals.set(approvalId, entry)
      if (signal && typeof signal.addEventListener === 'function') {
        entry.onAbort = () => this.#settleApproval(approvalId, 'cancelled', 'cancelled')
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    })
    this.emit(payload)
    this.log(`approval: 请求 ${approvalId} session=${sessionId} 设备=${devices.join(',') || '（无）'} 工具=${payload.toolName}`)

    // 双端同时可见：立刻唤起桌面弹窗（手机卡片保持可作答）。
    this.#transferToDesktop(entry)

    const decision = await decisionPromise
    const outcome = decision?.outcome ?? 'cancelled'
    const by = decision?.by ?? 'cancelled'
    if (outcome === 'allowed-once' || outcome === 'rejected') {
      this.emit({ kind: 'approval-resolved', sessionId, approvalId, outcome, source: by })
      this.log(`approval: ${approvalId} 结束 ${outcome}（来源 ${by}）`)
      return outcome
    }
    this.log(`approval: ${approvalId} 结束（${outcome}，来源 ${by}）`)
    this.emit({ kind: 'approval-resolved', sessionId, approvalId, outcome: 'cancelled', source: by })
    return outcome === 'unavailable' ? 'unavailable' : 'cancelled'
  }

  /**
   * 让桌面原生弹窗也显示这条审批（手机卡片保持可作答，双端同时可见）。
   * @param {any} entry
   */
  #transferToDesktop(entry) {
    if (!entry || entry.desktop) return
    entry.desktop = true
    entry.payload.onDesktop = true
    this.emit({ ...entry.payload })
    this.log(`approval: ${entry.approvalId} 已同时交给桌面端（双端可答）`)

    // 装 signal 代理：手机作答时 abort 它，桌面原生弹窗就收掉了。是否真的动手由
    // 启动自检 + experimentalDualApproval 决定——关闭或自检失败时 req.signal
    // 一个字节都不改，桌面弹窗留给用户自己点掉（手机卡片与「先答先算」不受影响）。
    this.#installSignalProxy(entry)

    let answer
    try {
      answer = Promise.resolve(entry.next())
    } catch (error) {
      answer = Promise.reject(error)
    }
    entry.desktopAnswer = answer
    answer.then(raw => {
      if (!this.approvals.has(entry.approvalId)) return
      const outcome = raw === 'allowed-once' || raw === 'rejected'
        ? raw
        : raw === 'unavailable' ? 'unavailable' : 'cancelled'
      this.#settleApproval(entry.approvalId, outcome, 'desktop')
    }).catch(() => {
      if (!this.approvals.has(entry.approvalId)) return
      this.#settleApproval(entry.approvalId, 'unavailable', 'desktop')
    })
  }

  /**
   * 给一条审批请求装 signal 代理（手机作答时关掉桌面原生弹窗）。
   *
   * **只在启动自检通过且 `experimentalDualApproval` 未关闭时才动手**：否则直接返回，
   * `req.signal` 保持原样（一个字节都不写），桌面弹窗由用户自己点掉——手机卡片与
   * 「先答先算」都不受影响。这样 DSH 升级把 hack 弄失效时，最坏结果只是「桌面留框」。
   * 写不进去的请求（冻结对象、只读属性）也只降级不抛，手机作答照旧生效。
   * @param {any} entry
   */
  #installSignalProxy(entry) {
    if (!entry) return
    // 开关关闭 / 自检失败：绝不写 req.signal。
    if (this.approvalProxy?.enabled !== true) return
    const req = entry.req
    if (!req || typeof req !== 'object') {
      this.log(`approval: ${entry.approvalId} 审批请求不可写，装不了 signal 代理（桌面弹窗需手动关闭）`)
      return
    }
    try {
      const controller = new AbortController()
      const original = entry.signal
      // 原始 signal 的 abort（停止/取消）必须转发到代理上，否则「停止」不再关弹窗。
      // 注意：绝不能 abort 原始 signal——审批服务在 decide() 里已经拿它做了取消竞争。
      if (original && typeof original.addEventListener === 'function') {
        entry.proxyForwardAbort = () => controller.abort(original.reason)
        original.addEventListener('abort', entry.proxyForwardAbort, { once: true })
        if (original.aborted) controller.abort(original.reason)
      }
      req.signal = controller.signal
      entry.proxyController = controller
      entry.hackActive = req.signal === controller.signal
      this.log(
        entry.hackActive
          ? `approval: ${entry.approvalId} signal 代理已启用（手机作答将关闭桌面弹窗）`
          : `approval: ${entry.approvalId} signal 代理不可用（req.signal 不可写），退回残框模式`,
      )
    } catch (error) {
      // 代理装不上只是「桌面留框」，手机作答仍然有效：绝不把异常抛给审批瀑布。
      entry.proxyController = null
      entry.hackActive = false
      this.log(`approval: ${entry.approvalId} signal 代理失败，退回残框模式：${/** @type {Error} */ (error).message}`)
    }
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

  /**
   * @param {string} approvalId
   * @param {string} outcome
   * @param {string} [by] `phone` / `desktop` / `expired` / `cancelled`
   */
  #settleApproval(approvalId, outcome, by = 'phone') {
    const entry = this.approvals.get(approvalId)
    if (!entry) return
    this.approvals.delete(approvalId)
    // 原始 signal 中止（停止/取消）时要把 abort 转发给代理 signal，桌面弹窗才会关。
    // 监听器的执行顺序不保证，所以在这里显式补一次。
    if (entry.proxyController && entry.signal?.aborted && !entry.proxyController.signal.aborted) {
      try {
        entry.proxyController.abort(entry.signal.reason)
      } catch { /* 代理已不可用 */ }
    }
    if (entry.onAbort && typeof entry.signal?.removeEventListener === 'function') {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    if (entry.proxyForwardAbort && typeof entry.signal?.removeEventListener === 'function') {
      entry.signal.removeEventListener('abort', entry.proxyForwardAbort)
      entry.proxyForwardAbort = null
    }
    entry.resolve({ outcome, by })
  }

  /**
   * 某个会话里还在等答复的审批（网关在连接/刷新/切回标签时重发，卡片不会凭空消失）。
   * @param {string} sessionId
   * @returns {Array<object>}
   */
  pendingApprovals(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id === '') return []
    const pending = []
    for (const entry of this.approvals.values()) {
      if (entry.sessionId === id && entry.payload) pending.push(entry.payload)
    }
    return pending
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
      // 新版 DSH 把「人话」放在 `intent.display`（本地化字典：question/detail/approve），
      // 而计划审阅/新版提问的 `question` 可能只是一个空串：不把 display 转发出去，手机
      // 卡片就只剩「需要你的回答」+选项，题干永远不显示（用户 #4 的服务端根因）。
      // 形状与 webchat 的 `questionDisplayOf(candidate.intent)` 对齐：`intent.display`。
      if (q.intent && typeof q.intent === 'object' && !Array.isArray(q.intent)) {
        const source = /** @type {Record<string, any>} */ (q.intent)
        /** @type {Record<string, any>} */
        const intent = {}
        // `kind` 决定卡片类型（plan-review / 普通提问 / approval intent 都保留）。
        if (typeof source.kind === 'string' && source.kind !== '') intent.kind = source.kind.slice(0, 64)
        // 旧的 `intent.approve` 字符串保留：webchat 仍把它当按批准文案的回退来源。
        if (typeof source.approve === 'string') intent.approve = source.approve.slice(0, 200)
        if (typeof source.callId === 'string') intent.callId = source.callId
        const display = sanitizeQuestionDisplay(source.display)
        if (display) intent.display = display
        // 一个字段都没有时不要凭空造 `intent: {}`（旧行为是整块不发）。
        if (Object.keys(intent).length > 0) item.intent = intent
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
    // 原始 signal 中止（停止/取消）时要把 abort 转发给代理 signal，桌面弹窗才会关。
    // 监听器的执行顺序不保证，所以在这里显式补一次。
    if (entry.proxyController && entry.signal?.aborted && !entry.proxyController.signal.aborted) {
      try {
        entry.proxyController.abort(entry.signal.reason)
      } catch { /* 代理已不可用 */ }
    }
    if (entry.onAbort && typeof entry.signal?.removeEventListener === 'function') {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    if (entry.proxyForwardAbort && typeof entry.signal?.removeEventListener === 'function') {
      entry.signal.removeEventListener('abort', entry.proxyForwardAbort)
      entry.proxyForwardAbort = null
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
   * 读会话标题。
   *
   * DSH 的 `readTitleSnapshots()` 返回 `SessionTitleObservationResult[]`：
   *   {sessionId, status:'fulfilled', value:{session: SessionHeader, title?: SessionTitleSnapshot}}
   * 其中 `SessionTitleSnapshot` 是**对象**（`SessionTitleEventData` 的子类，含
   * `title: string`、`messageSeqs`、`source`、`eventSeq`、`updatedAt`），不是
   * 字符串。v3.0.0 之前把 `value.title` 当字符串判定，标题永远取不到，同一 cwd
   * 的会话于是全退回 `default-workspace`（用户报「会话名仍未区分」）。这里同时
   * 兼容字符串与对象两种形状，并对 rejected / 缺字段 / 空白标题做校验。
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
      const results = Array.isArray(snapshots) ? snapshots : []
      for (let index = 0; index < results.length; index += 1) {
        const snapshot = results[index]
        if (!snapshot || snapshot.status !== 'fulfilled') continue
        // 宿主返回的 sessionId 优先；形状再变就退回请求顺序（readTitleSnapshots
        // 按入参 ids 返回数组）。
        const sessionId = this.#snapshotSessionId(snapshot) ?? sessionIds[index]
        const title = this.#snapshotTitle(snapshot.value)
        if (typeof sessionId === 'string' && sessionId !== '' && title !== undefined) {
          titles.set(sessionId, title)
        }
      }
    } catch (error) {
      this.log(`bridge: 读取会话标题失败：${/** @type {Error} */ (error).message}`)
    }
    return titles
  }

  /**
   * 从一条 observation 里取 sessionId（兼容 value.session.id 与顶层 sessionId）。
   * @param {any} snapshot
   * @returns {string | undefined}
   */
  #snapshotSessionId(snapshot) {
    const candidates = [
      snapshot?.sessionId,
      snapshot?.value?.session?.id,
      snapshot?.value?.session?.sessionId,
      snapshot?.value?.sessionId,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return undefined
  }

  /**
   * 从一个 title observation 的 value 里取标题文本。
   *
   * 真实形状是 `{session, title: SessionTitleSnapshot}`（`title.title` 才是
   * 字符串）；旧代码/旧宿主也可能直接给字符串。兜底再看 header 上的 title
   * 字段，最后做 trim / 空白折叠 / 截断。
   * @param {any} value
   * @returns {string | undefined}
   */
  #snapshotTitle(value) {
    const candidates = [
      value?.title?.title,   // SessionTitleSnapshot: {title: string, ...}
      value?.title,          // 字符串标题（旧形状），或对象本身
      value?.session?.title, // 兜底：SessionHeader 上的 title（宿主以后可能加）
      typeof value === 'string' ? value : undefined,
    ]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const title = this.#clampTitle(candidate)
      if (title !== '') return title
    }
    return undefined
  }

  /** 标题展示用：trim、折叠连续空白、超长截断。 @param {string} title @returns {string} */
  #clampTitle(title) {
    const normalized = title.replace(/\s+/g, ' ').trim()
    return normalized.length > SESSION_TITLE_MAX_LENGTH
      ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH - 1)}…`
      : normalized
  }

  /**
   * 无标题时的兜底展示名：cwd 最后一段（或「新会话」）。
   * @param {any} header
   * @returns {string}
   */
  #titleFallbackBase(header) {
    const cwd = typeof header?.cwd === 'string' ? header.cwd.replace(/[\\/]+$/, '') : ''
    const last = cwd.split(/[\\/]/).pop()
    return last && last !== cwd ? last : '新会话'
  }

  /**
   * 无标题时的兜底展示名。
   *
   * DSH 标题是 log-backed 的（session/title 事件），刚建的会话可能真的还没有
   * 标题；同一工作目录下多个无标题会话都退回 cwd 末段时，手机上是一排一样的
   * 「default-workspace」（用户实测）。此时追加 session id 后 6 位，保证任何
   * 时刻都能区分，且跨刷新稳定（id 不变，后缀不变）。
   * @param {any} header
   * @param {{distinct?: boolean}} [options] distinct=true 时追加 id 后缀
   * @returns {string}
   */
  #titleFallback(header, options = {}) {
    const base = this.#titleFallbackBase(header)
    const suffix = shortSessionIdSuffix(header?.id)
    return options.distinct === true && suffix !== '' ? `${base} · ${suffix}` : base
  }

  /**
   * 会话标题确定性去重：完全同名的第 2、3 个追加 `#2`、`#3`。
   *
   * 只用「打开顺序」（listSessions 已按 createdAt 倒序）决定序号，不依赖
   * 随机数或 Map/Set 遍历顺序；同一份输入多次调用结果一致。返回新数组、不改
   * 入参，避免调用方复用时被污染。
   * @param {Array<{id: string, title: string}>} sessions
   * @returns {Array<any>}
   */
  #dedupeSessionTitles(sessions) {
    const used = new Set()
    const nextIndex = new Map()
    return sessions.map(session => {
      let title = session.title
      if (used.has(title)) {
        let index = nextIndex.get(title) ?? 1
        let candidate = title
        do {
          index += 1
          candidate = `${title} #${index}`
        } while (used.has(candidate))
        nextIndex.set(title, index)
        title = candidate
      }
      used.add(title)
      return title === session.title ? session : { ...session, title }
    })
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
    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    entry.agent.followup(userMessage)
    // 记住「手机注入的 DSH 消息 id → 手机端 msgId」：历史快照里同一条消息必须映射回
    // 手机本地气泡的 id（usr_<msgId>），否则重连/切标签后会多出一条重复气泡
    // （真机反馈：同一句「看这个」在手机上出现两遍，第二遍还带着附件提示原文）。
    this.#rememberPhoneMessage(userMessage?.id, input.callId)
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

  /**
   * 记住一条手机注入消息的 DSH 消息 id → 手机端 msgId（有界，最多 500 条）。
   * @param {unknown} dshMessageId
   * @param {unknown} phoneMsgId
   */
  #rememberPhoneMessage(dshMessageId, phoneMsgId) {
    if (typeof dshMessageId !== 'string' || dshMessageId === '') return
    if (typeof phoneMsgId !== 'string' || phoneMsgId === '') return
    this.phoneMessageIds.set(dshMessageId, phoneMsgId)
    // Map 保持插入顺序；超过上限删最旧的。
    while (this.phoneMessageIds.size > 500) {
      const oldest = this.phoneMessageIds.keys().next().value
      if (oldest === undefined) break
      this.phoneMessageIds.delete(oldest)
    }
  }

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
      case 'user/message':
        return this.#onUserMessage(sessionId, event)
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

  /**
   * 桌面端（DSH GUI）发起的用户消息：实时同步给手机。
   *
   * 只转发 `source.kind === 'user'` 且带 `rpcId` 的——那是桌面 UI 输入框发起的；
   * 本插件自己 `followup()` 注入的手机消息没有 `rpcId`（手机本地已经有气泡），
   * runtime-context 之类的内部注入也由 `isInjectedUserMessage` 挡掉。
   * @param {string} sessionId
   * @param {any} event
   */
  #onUserMessage(sessionId, event) {
    const data = event?.data
    if (isInjectedUserMessage(data)) return
    const messageId = typeof data?.id === 'string' ? data.id : ''
    // 手机自己注入的消息即使被宿主打上 rpcId，也绝不能再回显给手机（会多一条重复气泡）。
    if (messageId !== '' && this.phoneMessageIds.has(messageId)) return
    const source = data?.source
    if (!source || source.kind !== 'user') return
    if (typeof source.rpcId !== 'string' || source.rpcId === '') return
    const text = extractUserText(data)
    if (text === '') return
    const at = Number(event?.time)
    this.emit({
      kind: 'user-message',
      sessionId,
      ...(messageId !== '' ? { messageId } : {}),
      text,
      at: Number.isFinite(at) ? at : this.now(),
    })
  }

  /** @param {string} sessionId @param {any} event */
  #onTurnStart(sessionId, event) {
    const queue = this.pendingCalls.get(sessionId)
    const call = queue?.shift()
    if (!call) {
      // 桌面端发起的回合：手机也要能实时看到回复，给它建一个虚拟 call。
      this.#ensureDesktopCall(sessionId, event?.data?.turn)
      return
    }
    call.turn = event?.data?.turn
    if (call.turn !== undefined) this.turnCalls.set(`${sessionId}:${call.turn}`, call)
  }

  /**
   * 桌面回合的虚拟 call：没有手机消息来源，但 assistant/tool/done 事件要有一个
   * callId 才能在手机上渲染成一条回复。
   * @param {string} sessionId
   * @param {number|undefined} turn
   * @returns {any | undefined}
   */
  #ensureDesktopCall(sessionId, turn) {
    if (turn === undefined || turn === null) return undefined
    const key = `${sessionId}:${turn}`
    const existing = this.turnCalls.get(key)
    if (existing) return existing
    const call = {
      callKey: `desk:${key}`,
      deviceId: '',
      callId: `desk_${turn}`,
      sessionId,
      text: '',
      messages: new Map(),
      messageOrder: [],
      seenSteps: new Set(),
      toolCalls: new Set(),
      startedAt: this.now(),
      files: undefined,
      turn,
      desktop: true,
    }
    this.calls.set(call.callKey, call)
    this.turnCalls.set(key, call)
    bridgeDiagnostic(`bridge: 桌面回合 ${key} 建立虚拟 call，开始同步给手机`)
    this.emit({ kind: 'typing', sessionId, deviceId: '', callId: call.callId, active: true })
    return call
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
      // turn/start 漏了但队列里还有手机消息：先补给这条消息，别误建桌面 call。
      const queue = this.pendingCalls.get(sessionId)
      const queued = queue?.[0]
      if (queued) {
        queue.shift()
        queued.turn = data.turn
        this.turnCalls.set(`${sessionId}:${data.turn}`, queued)
        return queued
      }
      // 桌面端的回合：补虚拟 call，否则回复永远同步不到手机。
      const desktop = this.#ensureDesktopCall(sessionId, data.turn)
      if (desktop) return desktop
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
    // 显式 seq：客户端对「有 msgId 的历史消息」用本地气泡 id 去重后，仍需要 seq 排序。
    ...(Number.isFinite(Number(event?.seq)) ? { seq: Number(event.seq) } : {}),
  }
}

/**
 * 去掉插件注入的附件提示段，只留下用户真正输入的文字。
 *
 * 手机消息进入 DSH 日志时会被拼上「用户通过手机发来了 N 个附件…」一段；模型需要它，
 * 但历史快照显示给手机时不能照搬（真机上表现为第二个重复气泡里出现一长串路径）。
 * 提示段总在最后；用户没写文字时给一个简短占位。
 * @param {unknown} text
 * @returns {string}
 */
export function stripPhoneAttachmentNotice(text) {
  const raw = String(text ?? '')
  const marker = '用户通过手机发来了 '
  const index = raw.indexOf(marker)
  if (index === -1) return raw
  const kept = raw.slice(0, index).trim()
  return kept !== '' ? kept : '（来自手机的附件）'
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

/** `intent.display` 里允许转发的人话字段（与 webchat 的 `questionDisplayOf` 一一对应）。 */
const QUESTION_DISPLAY_FIELDS = ['question', 'detail', 'approve']

/**
 * 深拷贝一份合法的本地化字典；非法（数组/数字/嵌套非字符串/超长）返回 `undefined`。
 *
 * 只复制字符串值，用 `Object.fromEntries`（定义自有属性）避免把 `__proto__` 之类
 * 的键写进原型，结果一定是 JSON 安全的普通对象。
 * @param {unknown} value
 * @returns {Record<string, string> | undefined}
 */
function copyLocalizedText(value) {
  if (!isLocalizedText(value)) return undefined
  return Object.fromEntries(Object.entries(/** @type {Record<string, string>} */ (value)))
}

/**
 * 校验并深拷贝 `intent.display`：`question` / `detail` / `approve` 逐个校验，
 * 非法或缺失的子项只丢自己——不丢整条提问，也不丢 display 里的其它子项。
 * @param {unknown} display
 * @returns {Record<string, Record<string, string>> | undefined}
 */
function sanitizeQuestionDisplay(display) {
  if (!display || typeof display !== 'object' || Array.isArray(display)) return undefined
  const source = /** @type {Record<string, unknown>} */ (display)
  /** @type {Record<string, Record<string, string>>} */
  const forwarded = {}
  for (const field of QUESTION_DISPLAY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue
    const text = copyLocalizedText(source[field])
    if (text) forwarded[field] = text
  }
  return Object.keys(forwarded).length > 0 ? forwarded : undefined
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
 * session id 的短后缀（取末 6 位），用于无标题会话的兜底区分。
 *
 * DSH 的 SessionId 是 UUID；测试里也可能是短 id。只保留字母数字（去掉了
 * 连字符/下划线等分隔符），不足 6 位时原样返回，空则返回 ''。
 * @param {unknown} sessionId
 * @returns {string}
 */
function shortSessionIdSuffix(sessionId) {
  if (typeof sessionId !== 'string') return ''
  const compact = sessionId.replace(/[^A-Za-z0-9]/g, '')
  return compact.length <= 6 ? compact : compact.slice(-6)
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
