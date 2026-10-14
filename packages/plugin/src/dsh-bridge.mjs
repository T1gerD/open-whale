// The DSH-facing half of Open Whale.
//
// Responsibilities, in order of importance:
//  1. Give each paired phone its own durable DSH conversation (agent + session),
//     so the phone keeps one continuous chat and never collides with the
//     conversations the user has open on the desktop.
//  2. Turn DSH's event stream into the small vocabulary the phone speaks
//     (delta / done / tool / typing / error), and collect files it may fetch.
//  3. Inject the personal-assistant voice as a *scoped* prompt section on those
//     conversations only.
//
// It deliberately talks to DSH through the injected context instead of importing
// harness internals, so the same file can be exercised in tests with a fake ctx.
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { assistantVoiceSection, VOICE_SECTION_NAME, VOICE_SECTION_ORDER } from './voice.mjs'

/** Tools whose results are files rather than text. */
const FILE_TOOL_HINTS = ['write', 'image', 'docx', 'xlsx', 'pptx', 'pdf', 'export', 'render', 'download']

/**
 * @typedef {object} BridgeEvent
 * @property {'delta'|'done'|'tool'|'typing'|'error'} kind
 * @property {string} deviceId
 * @property {string} callId
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
    this.defaultCwd = options.defaultCwd ?? (() => process.cwd())
    this.createUserMessage = options.createUserMessage ?? null
    this.modelSelection = options.modelSelection ?? (() => undefined)
    /** deviceId → entry */
    this.entries = new Map()
    /** fileId → { name, size, mime, path, deviceId } */
    this.files = new Map()
    /** callId → { deviceId, text, toolCalls, startedAt } */
    this.calls = new Map()
    this.disposed = false
    this.subscriptions = []
  }

  /** Subscribe once to the session event feed and route it per device. */
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
    const disposals = [...this.entries.values()].map(entry => entry.handle?.dispose?.().catch(() => {}))
    this.entries.clear()
    this.calls.clear()
    this.files.clear()
    await Promise.all(disposals)
  }

  /** Session id used for a device. Deterministic via the state store. */
  sessionIdFor(deviceId) {
    return this.config.sessionIdFor(deviceId)
  }

  /**
   * Deliver one phone message into the device's conversation.
   * @param {object} input
   * @param {string} input.deviceId
   * @param {string} input.callId
   * @param {string} input.text
   * @param {Array<{name: string, mime?: string, dataBase64: string, path?: string}>} input.attachments
   */
  async send(input) {
    if (this.disposed) throw new Error('bridge 已关闭')
    const entry = await this.#ensureAgent(input.deviceId)
    if (!entry) throw new Error('无法创建会话')

    const text = this.#composeText(input)
    this.calls.set(input.callId, {
      deviceId: input.deviceId,
      callId: input.callId,
      text: '',
      toolCalls: new Set(),
      startedAt: Date.now(),
      assistantTexts: [],
    })
    this.emit({ kind: 'typing', deviceId: input.deviceId, callId: input.callId, active: true })

    const createUserMessage = this.createUserMessage ?? await loadCreateUserMessage()
    entry.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  }

  /** Abort the turn that owns this call, if it is still running. */
  cancel(callId) {
    const call = this.calls.get(callId)
    if (!call) return
    const entry = this.entries.get(call.deviceId)
    try {
      entry?.agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
      this.emit({ kind: 'error', deviceId: call.deviceId, callId, message: '已停止', retryable: false })
    } catch (error) {
      this.log(`bridge: cancel failed: ${/** @type {Error} */ (error).message}`)
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
      const lines = attachments.map(attachment => {
        const where = attachment.path ?? '(未落盘)'
        return `- ${attachment.name}${attachment.mime ? ` (${attachment.mime})` : ''}：${where}`
      })
      parts.push(`用户通过手机发来了 ${attachments.length} 个附件，已保存在电脑上：\n${lines.join('\n')}\n请按需读取这些文件。`)
    }
    return parts.join('\n\n') || '（用户发送了一条空消息）'
  }

  /**
   * Get or create the agent for a device.
   * @param {string} deviceId
   */
  async #ensureAgent(deviceId) {
    const existing = this.entries.get(deviceId)
    if (existing?.agent && this.ctx.agents.get(existing.sessionId)) return existing

    const sessionId = this.sessionIdFor(deviceId)
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

  /**
   * Route one durable session event to the phone that owns that session.
   * @param {any} session
   * @param {any} event
   */
  #onSessionEvent(session, event) {
    const deviceId = this.#deviceForSession(session)
    if (!deviceId) return
    const call = this.#currentCall(deviceId)
    if (!call) return

    switch (event.type) {
      case 'assistant/message':
      case 'assistant/attempt': {
        const text = extractAssistantText(event.data)
        if (!text) return
        // DSH commits the complete assistant message for the step; the phone
        // receives it as one delta. The transport stays streaming-shaped so a
        // future token-level feed needs no client change.
        const seq = call.assistantTexts.length
        call.assistantTexts.push(text)
        call.text = call.assistantTexts.join('\n\n')
        this.emit({ kind: 'delta', deviceId, callId: call.callId, seq, text })
        return
      }
      case 'tool/call': {
        const { callId: toolCallId, name } = event.data ?? {}
        if (!toolCallId) return
        call.toolCalls.add(toolCallId)
        this.emit({
          kind: 'tool',
          deviceId,
          callId: call.callId,
          phase: 'tool-start',
          toolCallId,
          tool: name,
          summary: summarizeToolCall(name, event.data?.arguments),
        })
        return
      }
      case 'tool/result': {
        const toolCallId = event.data?.callId ?? event.data?.toolCallId
        this.#collectFiles(deviceId, call, event.data)
        this.emit({
          kind: 'tool',
          deviceId,
          callId: call.callId,
          phase: 'tool-end',
          toolCallId,
          tool: event.data?.name,
          ok: event.data?.ok !== false,
        })
        return
      }
      case 'turn/end': {
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          this.emit({
            kind: 'error',
            deviceId,
            callId: call.callId,
            message: describeFailure(reason.error),
            retryable: true,
          })
          this.calls.delete(call.callId)
          return
        }
        this.emit({
          kind: 'done',
          deviceId,
          callId: call.callId,
          text: call.text || '（没有产生回复内容）',
          durationMs: Date.now() - call.startedAt,
        })
        this.calls.delete(call.callId)
        return
      }
      default:
        return
    }
  }

  /** @param {any} session */
  #deviceForSession(session) {
    const id = session?.id ?? session?.header?.id
    if (!id) return undefined
    for (const [deviceId, entry] of this.entries) {
      if (entry.sessionId === id) return deviceId
    }
    return undefined
  }

  /** The most recent call still awaiting completion for a device. */
  #currentCall(deviceId) {
    let latest
    for (const call of this.calls.values()) {
      if (call.deviceId !== deviceId) continue
      if (!latest || call.startedAt >= latest.startedAt) latest = call
    }
    return latest
  }

  /**
   * Register any files referenced by a tool result so the phone can fetch them.
   * @param {string} deviceId
   * @param {any} call
   * @param {any} data
   */
  #collectFiles(deviceId, call, data) {
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
        deviceId,
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
let createUserMessageFactory
async function loadCreateUserMessage() {
  if (!createUserMessageFactory) {
    const module = await import('@deepseek-ai/dsh-llm')
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
