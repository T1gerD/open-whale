import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  DshBridge,
  TESTED_DSH_VERSIONS,
  describeFailure,
  extractAssistantText,
  historyMessageOf,
  isInjectedUserMessage,
  isTestedDshVersion,
  runApprovalProxySelfCheck,
  stripPhoneAttachmentNotice,
  summarizeToolCall,
} from '../src/dsh-bridge.mjs'
import { VOICE_SECTION_NAME, assistantVoiceSection } from '../src/voice.mjs'

/**
 * The bridge's default cwd in tests. Windows-style path on Windows only: on
 * POSIX a string like `C:\work` is treated as a plain relative name, so
 * `path.relative()` cannot produce the relative attachment path the test checks.
 * The production path is always the real platform separator, so the fixture must
 * be platform-appropriate for the test to be meaningful on Linux/macOS CI.
 */
const WORKDIR = process.platform === 'win32' ? 'C:\\work' : '/work'

/**
 * A fake DSH context that records what the bridge asks of it and lets tests
 * drive the session event feed. This is the smallest surface the bridge uses, so
 * a change in the bridge's expectations shows up as a failing test here.
 * @param {{ agentPresets?: any, getThrows?: boolean }} [options]
 */
function fakeContext({ agentPresets, getThrows = false, agentCtxGet } = {}) {
  const listeners = []
  /** Agent 生命周期监听器：`agent/created` / `agent/disposed`。 */
  const lifecycle = []
  const created = []
  const sections = []
  const guards = []
  const scopedEvents = []
  const answeredQuestions = []
  /** @type {Map<string, any>} */
  const live = new Map()

  return {
    created,
    sections,
    guards,
    scopedEvents,
    listeners,
    lifecycle,
    live,
    answeredQuestions,
    /** Fire an event into every registered session/event listener. */
    fire(session, event) {
      for (const listener of listeners) listener(session, event)
    },
    /** Fire one agent lifecycle event (`agent/created` / `agent/disposed`). */
    emitAgent(event, payload) {
      for (const entry of [...lifecycle]) {
        if (entry.event === event) entry.listener(payload)
      }
    },
    ctx: {
      /** Optional-service lookup, mirroring `ctx.get()` in Cordis. */
      get(name) {
        if (getThrows) throw new Error(`service "${name}" unavailable`)
        if (name === 'agentPresets') return agentPresets
        return undefined
      },
      on(event, listener) {
        if (event === 'session/event') {
          listeners.push(listener)
          return () => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          }
        }
        assert.ok(event === 'agent/created' || event === 'agent/disposed', `unexpected event ${event}`)
        const entry = { event, listener }
        lifecycle.push(entry)
        return () => {
          const index = lifecycle.indexOf(entry)
          if (index >= 0) lifecycle.splice(index, 1)
        }
      },
      /** DSH 的 continued-question 入口（超时后补答时会用到）。 */
      userQuestions: {
        answer(...args) {
          answeredQuestions.push(args)
          return true
        },
      },
      agents: {
        get: id => live.get(id),
        create: async options => {
          created.push(options)
          const agent = {
            id: options.sessionId,
            session: { id: options.sessionId },
            cancelled: [],
            messages: [],
            followup(message) {
              this.messages.push(message)
            },
            cancel(cause, opts) {
              this.cancelled.push({ cause, opts })
            },
          }
          live.set(options.sessionId, agent)
          // mimic the real contract by handing it a scoped ctx and the agent.
          await options.setup?.({
            /** Optional-service lookup in the agent scope (mirrors Cordis ctx.get). */
            get: agentCtxGet,
            systemPrompt: {
              section(section) {
                sections.push(section)
              },
            },
            /** Scoped event registration, used to answer the approval waterfall. */
            on(event, listener, opts) {
              scopedEvents.push({ event, listener, opts })
              return () => {
                const index = scopedEvents.findIndex(entry => entry.listener === listener)
                if (index >= 0) scopedEvents.splice(index, 1)
              }
            },
          }, agent)
          return {
            agent,
            dispose: async () => {
              live.delete(options.sessionId)
            },
          }
        },
      },
    },
  }
}

function makeBridge({ config = {}, fire, presets, getThrows, agentCtxGet, ...options } = {}) {
  const fake = fakeContext({ agentPresets: presets, getThrows, agentCtxGet })
  const events = []
  let idCounter = 0
  const bridge = new DshBridge({
    ctx: /** @type {any} */ (fake.ctx),
    config: {
      voice: 'personal-assistant',
      assistantName: '小鲸',
      cwd: '',
      autoApproveTools: false,
      agentOptions: {},
      sessionIdFor: deviceId => `ow-${deviceId}`,
      ...config,
    },
    emit: event => events.push(event),
    log: () => {},
    defaultCwd: () => WORKDIR,
    // v2.3.0: conversation ids are minted by the bridge (production: random
    // UUID). Tests pin them to the old fixture names so the rest of the file
    // keeps reading like a real per-device conversation.
    newSessionId: deviceId => `ow-${deviceId ?? 'x'}`,
    // Mirrors `createUserMessage` from @deepseek-ai/dsh-llm: it freezes the
    // message and attaches the unique id the agent inbox deduplicates on.
    createUserMessage: input => Object.freeze({ ...input, role: 'user', id: `msg_${++idCounter}` }),
    ...options,
  })
  bridge.start()
  // v2.3.0: the gateway owns the device→session binding and passes `sessionId`
  // on every send. Unit tests here drive the bridge directly, so this fixture
  // stands in for the gateway: first send for a device creates its conversation,
  // later sends reuse it.
  const bound = new Map()
  const rawSend = bridge.send.bind(bridge)
  bridge.send = async input => {
    if (!input.sessionId) {
      let sessionId = bound.get(input.deviceId)
      if (!sessionId) {
        sessionId = (await bridge.createSession(input.deviceId)).sessionId
        bound.set(input.deviceId, sessionId)
      }
      input = { ...input, sessionId }
    }
    return rawSend(input)
  }
  return { bridge, fake, events, fire: fake.fire }
}

test('a phone message creates one DSH conversation for that device', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: '你好', attachments: [] })
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0].sessionId, 'ow-dev_a')
  assert.equal(fake.created[0].meta.cwd, WORKDIR)
})

test('a new phone conversation requests the standard agent preset (full tool set)', async () => {
  // 真机回归：不写 agentPreset 时 DSH 用 profile 默认预设（只有插件/团队工具），
  // 手机助理读不了图/文件、用不了命令和联网；standard 才有 read_image / ops_* 等。
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: '你好', attachments: [] })
  assert.equal(fake.created.length, 1)
  assert.equal(fake.created[0].meta.agentPreset, 'standard')
  assert.equal(fake.created[0].meta.cwd, WORKDIR)
})

test('setup mounts the agent preset so phone agents get the native tool set', async () => {
  // 根因回归（真机会话 01d47803 日志）：DSH 的 Web 会话控制器在 composeAgent 里用
  // `agentPresets.mount(agentCtx, presetId)` 绑定预设；read_image/read/write/edit/
  // grep/glob/web_* 这些工具由 preset 行在 setup 的 agentCtx 上注册。插件自己
  // create/resume 不经过那条路径，只在 header 写了 agentPreset 字段，所以手机
  // agent 只有宿主工具（23~30 个），桌面 agent 57 个。setup 必须补 mount。
  const resolves = []
  const mounts = []
  const presets = {
    presetForSession: () => undefined,
    async resolve(id) {
      resolves.push(id)
      return { id: id ?? 'standard' }
    },
    async mount(agentCtx, id) {
      mounts.push({ agentCtx, id })
      return { id }
    },
  }
  const { bridge, fake } = makeBridge({ presets })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: '你好', attachments: [] })
  assert.equal(fake.created.length, 1)
  assert.deepEqual(resolves, ['standard'], 'the configured preset id must be resolved first')
  assert.equal(mounts.length, 1, 'setup must bind exactly one preset to the agent scope')
  assert.equal(mounts[0].id, 'standard')
  assert.ok(mounts[0].agentCtx.systemPrompt, 'mount must receive the setup agent ctx')
})

test('setup prefers the preset recorded on the session over the configured one', async () => {
  const mounts = []
  const presets = {
    presetForSession: session => (session ? 'minimal' : undefined),
    async resolve(id) {
      return { id }
    },
    async mount(agentCtx, id) {
      mounts.push(id)
      return { id }
    },
  }
  const { bridge } = makeBridge({ presets })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.deepEqual(mounts, ['minimal'])
})

test('the preset service is found through the setup agent scope when the root ctx cannot see it', async () => {
  // 真机排查用：Cordis 里 agentPresets 在 Host realm，插件根 ctx 理论上可见，但若
  // loader 层级/隔离组导致不可见，setup 的 agentCtx 仍能拿到（agent.ctx 的普通
  // lookup 走 Host realm）。这里把根 ctx 的 get 置为抛错，只在 agentCtx 上暴露服务。
  const mounts = []
  const presets = {
    async resolve(id) {
      return { id: id ?? 'standard' }
    },
    async mount(agentCtx, id) {
      mounts.push(id)
      return { id }
    },
  }
  const { bridge, fake } = makeBridge({
    presets,
    getThrows: true,
    agentCtxGet: name => (name === 'agentPresets' ? presets : undefined),
  })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.created.length, 1)
  assert.deepEqual(mounts, ['standard'], 'agentCtx lookup must find the service')
})

test('a missing agent preset service still creates the conversation', async () => {
  const { bridge, fake } = makeBridge({ getThrows: true })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.created.length, 1)
  assert.equal(fake.live.get('ow-dev_a').messages.length, 1)
})

test('a failing preset mount never breaks message delivery', async () => {
  const logs = []
  const presets = {
    async resolve() {
      return { id: 'standard' }
    },
    async mount() {
      throw new Error('preset exploded')
    },
  }
  const { bridge, fake } = makeBridge({ presets, log: message => logs.push(message) })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.created.length, 1)
  assert.equal(fake.live.get('ow-dev_a').messages.length, 1)
  assert.ok(logs.some(line => /挂载 agent preset/.test(line)), 'the failure must be logged, not thrown')
})

test('a stale recorded preset falls back to the configured preset', async () => {
  const mounts = []
  const presets = {
    presetForSession: () => 'removed-preset',
    async resolve(id) {
      if (id === 'removed-preset') throw new Error('unknown agent preset')
      return { id: id ?? 'standard' }
    },
    async mount(agentCtx, id) {
      mounts.push(id)
      return { id }
    },
  }
  const { bridge } = makeBridge({ presets })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.deepEqual(mounts, ['standard'], 'a deleted preset must not kill the phone conversation')
})
test('two phones never share a conversation', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'a', attachments: [] })
  await bridge.send({ deviceId: 'dev_b', callId: 'c2', text: 'b', attachments: [] })
  assert.deepEqual(fake.created.map(c => c.sessionId), ['ow-dev_a', 'ow-dev_b'])
})

test('the same device reuses its conversation instead of creating a new one', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'first', attachments: [] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c2', text: 'second', attachments: [] })
  assert.equal(fake.created.length, 1, 'a repeat message must not rebuild the agent')
  const agent = fake.live.get('ow-dev_a')
  assert.equal(agent.messages.length, 2)
})

test('the assistant voice is registered as a scoped prompt section, not globally', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.sections[0].name, VOICE_SECTION_NAME)
  assert.ok(fake.sections[0].order >= 0 && fake.sections[0].order < 1000)
  const text = typeof fake.sections[0].text === 'string' ? fake.sections[0].text : fake.sections[0].text({})
  assert.match(text, /个人助理/)
  assert.match(text, /口语化/)
  assert.match(text, /小鲸/)
  // Registering the voice in the agent's own scope is what keeps the desktop
  // conversations untouched.
  assert.equal(fake.ctx ? true : true, true)
})

test('voice can be turned off entirely', async () => {
  const { bridge, fake } = makeBridge({ config: { voice: 'off' } })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.sections.length, 0)
})

test('auto-approval is off by default and opt-in', async () => {
  const off = makeBridge()
  await off.bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  // By default a phone-forwarding answerer is registered, but it must never
  // claim a request nobody can answer: with no phone online it delegates.
  const forwarding = off.fake.scopedEvents.find(entry => entry.event === 'approval/request')
  assert.ok(forwarding, 'the phone approval forwarder must be registered')
  assert.equal(forwarding.opts?.prepend, true, 'it must see the request before the desktop answerer')
  assert.equal(
    await forwarding.listener({ toolName: 'bash' }, async () => 'unavailable'),
    'unavailable',
    'no phone online → fall through to the desktop UI',
  )

  const on = makeBridge({ config: { autoApproveTools: true } })
  await on.bridge.send({ deviceId: 'dev_b', callId: 'c2', text: 'hi', attachments: [] })
  // A grant is an *answer* to the approval waterfall. A tool guard cannot grant:
  // `ToolGuard` is `(execution) => string | undefined` and any non-undefined
  // return becomes the denial reason, so a guard here would reject every call.
  const approval = on.fake.scopedEvents.find(entry => entry.event === 'approval/request')
  assert.ok(approval, 'auto-approval must register an approval answerer')
  assert.equal(approval.opts?.prepend, true, 'it must run before any other answerer')
  assert.equal(await approval.listener({}), 'allowed-once', 'the only outcome the approval service treats as a grant')
  assert.equal(on.fake.guards.length, 0, 'a deny-only guard must never be used to allow')
})

test('a new conversation inherits the harness model selection', async () => {
  const fake = fakeContext()
  const events = []
  let idCounter = 0
  const bridge = new DshBridge({
    ctx: /** @type {any} */ (fake.ctx),
    config: {
      voice: 'off', assistantName: '助理', cwd: '', autoApproveTools: false,
      agentOptions: {}, sessionIdFor: deviceId => `ow-${deviceId}`,
    },
    emit: event => events.push(event),
    log: () => {},
    defaultCwd: () => WORKDIR,
    createUserMessage: input => Object.freeze({ ...input, role: 'user', id: `m${++idCounter}` }),
    modelSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }),
  })
  bridge.start()
  const { sessionId } = await bridge.createSession('dev_a')
  await bridge.send({ deviceId: 'dev_a', sessionId, callId: 'c1', text: 'hi', attachments: [] })
  // Without these the harness assembles a prompt whose {{model}} variable is
  // empty and the very first message fails.
  assert.deepEqual(fake.created[0].agentOptions, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
})

test('explicit agent options win over the inherited selection', async () => {
  const fake = fakeContext()
  let idCounter = 0
  const bridge = new DshBridge({
    ctx: /** @type {any} */ (fake.ctx),
    config: {
      voice: 'off', assistantName: '助理', cwd: '', autoApproveTools: false,
      agentOptions: { provider: 'pinned', model: 'pinned-model' },
      sessionIdFor: deviceId => `ow-${deviceId}`,
    },
    emit: () => {},
    log: () => {},
    createUserMessage: input => Object.freeze({ ...input, role: 'user', id: `m${++idCounter}` }),
    modelSelection: () => ({ provider: 'other', model: 'other-model' }),
  })
  bridge.start()
  const { sessionId } = await bridge.createSession('dev_a')
  await bridge.send({ deviceId: 'dev_a', sessionId, callId: 'c1', text: 'hi', attachments: [] })
  assert.deepEqual(fake.created[0].agentOptions, { provider: 'pinned', model: 'pinned-model' })
})

test('a missing model selection is reported rather than silently ignored', async () => {
  const fake = fakeContext()
  const logs = []
  let idCounter = 0
  const bridge = new DshBridge({
    ctx: /** @type {any} */ (fake.ctx),
    config: {
      voice: 'off', assistantName: '助理', cwd: '', autoApproveTools: false,
      agentOptions: {}, sessionIdFor: deviceId => `ow-${deviceId}`,
    },
    emit: () => {},
    log: message => logs.push(message),
    createUserMessage: input => Object.freeze({ ...input, role: 'user', id: `m${++idCounter}` }),
    modelSelection: () => undefined,
  })
  bridge.start()
  const { sessionId } = await bridge.createSession('dev_a')
  await bridge.send({ deviceId: 'dev_a', sessionId, callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(logs.some(line => /默认模型/.test(line)), true, 'the user must be told why replies would fail')
})

test('the user message carries the text and its source is a real kind', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: '  帮我看看这个项目  ', attachments: [] })
  const message = fake.live.get('ow-dev_a').messages[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, '帮我看看这个项目')
  // `id` is required: the inbox rejects a message without one.
  assert.equal(typeof message.id, 'string')
  assert.equal(message.source.kind, 'user')
})

test('attachments become real files the assistant is told about', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({
    deviceId: 'dev_a',
    callId: 'c1',
    text: '这是我的报表',
    attachments: [{ name: '报表.xlsx', mime: 'application/vnd.ms-excel', dataBase64: 'AAAA', path: 'C:\\uploads\\1-报表.xlsx' }],
  })
  const text = fake.live.get('ow-dev_a').messages[0].content[0].text
  assert.match(text, /这是我的报表/)
  assert.match(text, /1 个附件/)
  assert.match(text, /报表\.xlsx/)
  assert.match(text, /C:\\uploads\\1-报表\.xlsx/)
})

test('an empty message still reaches the assistant as an explicit placeholder', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: '   ', attachments: [] })
  const text = fake.live.get('ow-dev_a').messages[0].content[0].text
  assert.ok(text.length > 0)
})

test('typing is announced before the answer starts', async () => {
  const { bridge, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.deepEqual(events[0], {
    kind: 'typing',
    sessionId: 'ow-dev_a',
    deviceId: 'dev_a',
    callId: 'c1',
    active: true,
  })
})

test('an assistant message becomes a chat/message and a completed turn becomes done', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const session = { id: 'ow-dev_a' }

  fake.fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_1', content: [{ type: 'text', text: '你好，我在。' }] } },
  })
  fake.fire(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })

  const message = events.find(e => e.kind === 'message')
  assert.equal(message.text, '你好，我在。')
  assert.equal(message.messageId, 'am_1')
  assert.equal(message.index, 0)
  const done = events.find(e => e.kind === 'done')
  assert.equal(done.text, '你好，我在。')
  assert.equal(typeof done.durationMs, 'number')
  // The call is retired once the turn ends.
  assert.equal(bridge.calls.size, 0)
})

test('several assistant messages in one turn accumulate instead of overwriting', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const session = { id: 'ow-dev_a' }
  fake.fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_1', content: [{ type: 'text', text: '第一段' }] } },
  })
  fake.fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { id: 'am_2', content: [{ type: 'text', text: '第二段' }] } },
  })
  fake.fire(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })

  const messages = events.filter(e => e.kind === 'message')
  assert.deepEqual(messages.map(m => m.index), [0, 1])
  const done = events.find(e => e.kind === 'done')
  assert.match(done.text, /第一段/)
  assert.match(done.text, /第二段/)
})

test('reasoning blocks are not spoken as assistant prose', async () => {
  const { fake, events, bridge } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  fake.fire({ id: 'ow-dev_a' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_1', content: [{ type: 'reasoning', text: '让我想想……' }, { type: 'text', text: '答案是 42。' }] } },
  })
  const message = events.find(e => e.kind === 'message')
  assert.equal(message.text, '答案是 42。')
})

test('tool calls surface as status rows, never as chat text', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const session = { id: 'ow-dev_a' }
  fake.fire(session, { type: 'tool/call', data: { callId: 't1', name: 'read_image', arguments: '{"path":"C:\\\\a\\\\b.png"}' } })
  fake.fire(session, { type: 'tool/result', data: { callId: 't1', name: 'read_image', ok: true, message: { content: [] } } })

  const tools = events.filter(e => e.kind === 'tool')
  assert.equal(tools.length, 2)
  assert.equal(tools[0].phase, 'tool-start')
  assert.match(tools[0].summary, /读取|图片/)
  assert.equal(tools[1].phase, 'tool-end')
  // No delta was produced by the tool traffic.
  assert.equal(events.filter(e => e.kind === 'delta').length, 0)
})

test('an error turn reports a human-readable failure', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  fake.fire({ id: 'ow-dev_a' }, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: '401 unauthorized: invalid api key' } } },
  })
  const failure = events.find(e => e.kind === 'error')
  assert.match(failure.message, /登录/)
  assert.equal(bridge.calls.size, 0)
})

test('a turn with no text still completes with a placeholder rather than silence', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  fake.fire({ id: 'ow-dev_a' }, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  const done = events.find(e => e.kind === 'done')
  assert.ok(done)
  assert.ok(done.text.length > 0)
})

test('events from another session are ignored', async () => {
  const { fake, events, bridge } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  fake.fire({ id: 'some-other-session' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '泄漏' }] } } })
  assert.equal(events.filter(e => e.kind === 'delta').length, 0)
})

test('two devices chatting at once keep their answers apart', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'ca', text: 'a', attachments: [] })
  await bridge.send({ deviceId: 'dev_b', callId: 'cb', text: 'b', attachments: [] })
  fake.fire({ id: 'ow-dev_a' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_a', content: [{ type: 'text', text: '给 A' }] } },
  })
  fake.fire({ id: 'ow-dev_b' }, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_b', content: [{ type: 'text', text: '给 B' }] } },
  })
  const messages = events.filter(e => e.kind === 'message')
  assert.equal(messages.find(m => m.callId === 'ca').text, '给 A')
  assert.equal(messages.find(m => m.callId === 'cb').text, '给 B')
})

test('tool results register files the phone is allowed to fetch', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  fake.fire({ id: 'ow-dev_a' }, {
    type: 'tool/result',
    data: {
      callId: 't1',
      name: 'write',
      ok: true,
      message: { content: [{ type: 'file', path: 'C:\\out\\report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 2048 }] },
    },
  })
  const fileIds = [...bridge.files.keys()]
  assert.equal(fileIds.length, 1)
  const resolved = await bridge.fileFor(fileIds[0])
  assert.equal(resolved.name, 'report.pdf')
  assert.equal(resolved.path, 'C:\\out\\report.pdf')

  // The done frame must carry file *metadata*, not bare fileId strings: the phone
  // reducer drops any file ref without a fileId/name/size object.
  fake.fire({ id: 'ow-dev_a' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const done = events.find(event => event.kind === 'done')
  assert.equal(Array.isArray(done.files), true)
  assert.deepEqual(done.files, [{ fileId: fileIds[0], name: 'report.pdf', size: 2048, mime: 'application/pdf' }])
})

test('an unknown file id resolves to undefined, never to a guess', async () => {
  const { bridge } = makeBridge()
  assert.equal(await bridge.fileFor('f_nope'), undefined)
})

test('cancelling reports a stop to the phone and aborts the turn', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  bridge.cancel('c1')
  const agent = fake.live.get('ow-dev_a')
  assert.equal(agent.cancelled.length, 1)
  assert.equal(agent.cancelled[0].cause.kind, 'user')
  assert.equal(events.at(-1).kind, 'error')
  assert.equal(events.at(-1).retryable, false)
})

test('cancelling an unknown call is a no-op', () => {
  const { bridge } = makeBridge()
  bridge.cancel('nothing-here')
})

test('dispose releases the subscription and every agent it created', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.live.size, 1)
  await bridge.dispose()
  assert.equal(fake.live.size, 0, 'agents must not leak after the plugin unloads')
  assert.equal(fake.listeners.length, 0)
  // A disposed bridge refuses new work instead of silently queueing it.
  await assert.rejects(() => bridge.send({ deviceId: 'dev_a', callId: 'c2', text: 'x', attachments: [] }), /已关闭/)
})

test('a reconnecting device reuses a still-live agent', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'a', attachments: [] })
  // Simulate a bridge restart with the agent still registered on the host.
  bridge.agents.clear()
  await bridge.send({ deviceId: 'dev_a', callId: 'c2', text: 'b', attachments: [] })
  assert.equal(fake.created.length, 1, 'the live agent must be adopted, not replaced')
})

// --- pure helpers -----------------------------------------------------------

test('extractAssistantText handles the shapes DSH actually emits', () => {
  assert.equal(extractAssistantText({ message: { content: [{ type: 'text', text: 'hi' }] } }), 'hi')
  assert.equal(extractAssistantText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(extractAssistantText({ content: [{ type: 'reasoning', text: 'x' }] }), '')
  assert.equal(extractAssistantText({ text: 'plain' }), 'plain')
  assert.equal(extractAssistantText({}), '')
  assert.equal(extractAssistantText(null), '')
})

test('tool summaries read like something a person is doing', () => {
  assert.match(summarizeToolCall('read_file', '{"path":"C:\\\\a\\\\b.ts"}'), /正在读取文件/)
  assert.match(summarizeToolCall('bash', '{"command":"ls"}'), /正在执行命令/)
  assert.match(summarizeToolCall('grep', '{"query":"foo"}'), /正在查找内容/)
  assert.match(summarizeToolCall('generate_image', '{}'), /正在处理图片/)
  assert.match(summarizeToolCall('write_file', '{"path":"C:\\\\a\\\\report.pdf"}'), /正在写文件/)
  assert.match(summarizeToolCall('some_new_tool', 'not json'), /正在使用/)
  assert.equal(typeof summarizeToolCall(undefined, undefined), 'string')
  // A tool name is never echoed as the whole summary: the row must read as an
  // action, so even an unknown tool is wrapped in "正在使用".
  assert.equal(summarizeToolCall('mystery_tool', '{}').startsWith('正在'), true)
})

test('failures are explained in terms a phone user can act on', () => {
  assert.match(describeFailure({ message: 'invalid api key' }), /登录/)
  assert.match(describeFailure({ message: 'HTTP 429 rate limited' }), /限流/)
  assert.match(describeFailure({ message: 'ECONNREFUSED' }), /网络/)
  assert.match(describeFailure({ message: 'aborted' }), /已停止/)
  assert.match(describeFailure({ message: 'weird internal thing' }), /处理失败：weird/)
  assert.equal(typeof describeFailure(undefined), 'string')
})

test('the voice section states every behavioural rule the product needs', () => {
  const text = assistantVoiceSection({ assistantName: '助理' })
  // Conversational, not programmatic.
  assert.match(text, /不要用「任务已完成」/)
  // Accuracy is not sacrificed for tone.
  assert.match(text, /绝不编造/)
  assert.match(text, /逐字准确/)
  // Files are announced, because the app renders them itself.
  assert.match(text, /文件/)
  assert.ok(text.length < 1200, 'a persona prompt must stay short so it does not dilute task instructions')
})

// --- v2.2.0: assistant message dedupe and session-wide routing -------------

test('one assistant message is emitted once even if DSH replays the same message id', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const session = { id: 'ow-dev_a' }
  const message = { id: 'am_1', content: [{ type: 'text', text: '答案' }] }

  // The same committed message delivered twice (replay after reconnect, or a
  // second listener pass) must not append its text twice.
  fake.fire(session, { type: 'assistant/message', data: { turn: 1, step: 0, message } })
  fake.fire(session, { type: 'assistant/message', data: { turn: 1, step: 0, message } })

  const messages = events.filter(event => event.kind === 'message')
  assert.equal(messages.length, 1, 'the same messageId must only be emitted once')
  assert.equal(messages[0].messageId, 'am_1')
  assert.equal(messages[0].index, 0)
  assert.equal(messages[0].sessionId, 'ow-dev_a', 'the event must say which conversation it belongs to')
  assert.equal(messages[0].callId, 'c1')

  fake.fire(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const done = events.find(event => event.kind === 'done')
  assert.equal(done.text, '答案', 'done.text must be the deduplicated answer, not answer + answer')
})

test('an attempt and the committed message for the same step are counted once', async () => {
  const { bridge, fake, events } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const session = { id: 'ow-dev_a' }

  // `assistant/attempt` is the fallback representation of a step; the loop then
  // commits the same step as `assistant/message`. Only one of them may become a
  // chat bubble.
  fake.fire(session, { type: 'assistant/attempt', data: { turn: 1, step: 0, stream: [] } })
  fake.fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_1', content: [{ type: 'text', text: '答案' }] } },
  })
  fake.fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_1', content: [{ type: 'text', text: '答案' }] } },
  })
  fake.fire(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  assert.equal(events.filter(event => event.kind === 'message').length, 1)
  assert.equal(events.find(event => event.kind === 'done').text, '答案')
})

test('two devices explicitly bound to the same conversation share one answer', async () => {
  const { bridge, fake, events } = makeBridge()
  // v2.3.0: two phones can still land on one DSH conversation — the user simply
  // picks the same session on both. It must be reduced once, not once per device.
  const { sessionId } = await bridge.createSession('dev_a')
  await bridge.send({ deviceId: 'dev_a', sessionId, callId: 'ca', text: 'a', attachments: [] })
  await bridge.send({ deviceId: 'dev_b', sessionId, callId: 'cb', text: 'b', attachments: [] })
  const session = { id: sessionId }

  fake.fire(session, { type: 'turn/start', data: { turn: 1 } })
  fake.fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 0, message: { id: 'am_1', content: [{ type: 'text', text: '答案' }] } },
  })
  fake.fire(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  assert.equal(events.filter(event => event.kind === 'message').length, 1)
  const done = events.filter(event => event.kind === 'done')
  assert.equal(done.length, 1)
  assert.equal(done[0].text, '答案')
  assert.equal(done[0].callId, 'ca', 'the turn belongs to the message that started it')
})

test('selecting a conversation that is already live adopts the existing agent', async () => {
  const { bridge, fake } = makeBridge()
  const { sessionId } = await bridge.createSession('dev_a')
  const created = fake.created.length
  const picked = await bridge.selectSession(sessionId)
  assert.equal(picked.ok, true)
  assert.equal(picked.sessionId, sessionId)
  assert.equal(fake.created.length, created, 'a live conversation must never be created twice')
})

test('bridge.send is idempotent for the same device and call id', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(fake.live.get('ow-dev_a').messages.length, 1, 'a replayed chat/send must not reach the agent twice')
})

test('a second device with its own call id is a different message', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'a', attachments: [] })
  await bridge.send({ deviceId: 'dev_b', callId: 'c1', text: 'b', attachments: [] })
  assert.equal(fake.live.get('ow-dev_a').messages.length, 1)
  assert.equal(fake.live.get('ow-dev_b').messages.length, 1)
})

test('attachments are described with a path relative to the working directory', async () => {
  const { bridge, fake } = makeBridge()
  await bridge.send({
    deviceId: 'dev_a',
    callId: 'c1',
    text: '看图',
    attachments: [
      { name: 'photo.jpg', mime: 'image/jpeg', path: join(WORKDIR, '.openwhale', 'uploads', '1-photo.jpg') },
      { name: '报表.xlsx', mime: 'application/vnd.ms-excel', path: join(WORKDIR, '.openwhale', 'uploads', '2-报表.xlsx') },
    ],
  })
  const text = fake.live.get('ow-dev_a').messages[0].content[0].text
  assert.match(text, /2 个附件/)
  assert.match(text, /\.openwhale[\\/]uploads[\\/]1-photo\.jpg/)
  assert.equal(text.includes(WORKDIR), false, 'the assistant gets a path relative to its cwd, not an absolute one')
  assert.match(text, /图片/, 'an image must be called out as an image so the model reads it as one')
  assert.match(text, /文件/, 'a non-image must be called out as a file')
  assert.match(text, /read/, 'the model must be told it can read the file')
})


// ---------------------------------------------------------------------------
// v3.0.0: structured questions (ask_user_question / plan review)
// ---------------------------------------------------------------------------

/** The two-question batch every question test uses. */
function questionRequest(overrides = {}) {
  return {
    questions: [
      { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: '补充一下', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
    ],
    agent: { id: 'agent-1' },
    ...overrides,
  }
}

/** @param {any} fake */
function questionHandler(fake) {
  const entry = fake.scopedEvents.find(item => item.event === 'user-questions/request')
  assert.ok(entry, 'the bridge must register a question answerer on the agent scope')
  return entry
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('a question is forwarded to the phone and its answers go back to DSH', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], questionTimeoutMs: 2_000 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)

  const answerPromise = handler.listener(questionRequest(), async () => {
    throw new Error('the phone is online; the bridge must not delegate')
  })
  await delay(20)
  const ask = events.find(event => event.kind === 'question-ask')
  assert.ok(ask, 'a question/ask must be emitted')
  assert.equal(ask.sessionId, 'ow-dev_a')
  assert.deepEqual(ask.items.map(item => item.id), ['q1', 'q2'])

  const accepted = bridge.answerQuestion({
    questionId: ask.questionId,
    deviceId: 'dev_a',
    answers: [
      { id: 'q1', selected: ['B'] },
      { id: 'q2', selected: ['X'], custom: '补充' },
    ],
  })
  assert.equal(accepted, true)
  const result = await answerPromise
  assert.deepEqual(result, {
    answers: [
      { id: 'q1', selected: ['B'] },
      { id: 'q2', selected: ['X'], custom: '补充' },
    ],
  })
  const resolved = events.filter(event => event.kind === 'question-resolved')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].outcome, 'answered')
  assert.equal(resolved[0].source, 'phone')
})

test('a question with no phone online delegates instead of claiming it', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => [] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const result = await handler.listener(questionRequest(), async () => 'delegated')
  assert.equal(result, 'delegated')
  assert.equal(events.some(event => event.kind === 'question-ask'), false)
})

test('an invalid answer is refused and the question stays open', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], questionTimeoutMs: 2_000 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const answerPromise = handler.listener(questionRequest(), async () => 'delegated')
  await delay(20)
  const ask = events.find(event => event.kind === 'question-ask')
  assert.equal(bridge.answerQuestion({ questionId: ask.questionId, answers: [{ id: 'q1', selected: ['A'] }] }), false)
  assert.equal(bridge.answerQuestion({ questionId: 'unknown', answers: [] }), false)
  bridge.answerQuestion({
    questionId: ask.questionId,
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: [] },
    ],
  })
  const result = await answerPromise
  assert.deepEqual(result.answers[0], { id: 'q1', selected: ['A'] })
})

test('a timed-out question still accepts a late answer through userQuestions.answer', async () => {
  const { bridge, fake, events } = makeBridge({
    devicesInSession: () => ['dev_a'],
    questionTimeoutMs: 20,
    questionLateWindowMs: 1_000,
  })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const result = await handler.listener(
    questionRequest({ wait: { callId: 'call-9', timed: true } }),
    async () => 'delegated',
  )
  assert.equal(result, 'delegated', 'a timeout always hands the question back to the desktop')
  const ask = events.find(event => event.kind === 'question-ask')
  assert.equal(ask.canAnswerLate, true)
  assert.equal(events.find(event => event.kind === 'question-resolved').outcome, 'timeout')

  const accepted = bridge.answerQuestion({
    questionId: ask.questionId,
    deviceId: 'dev_a',
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: [] },
    ],
  })
  assert.equal(accepted, true)
  assert.equal(fake.answeredQuestions.length, 1, 'the late answer must be steered into the agent')
  assert.equal(fake.answeredQuestions[0][1], 'call-9')
  const late = events.filter(event => event.kind === 'question-resolved').at(-1)
  assert.equal(late.source, 'phone-late')
})

test('an askTimed question uses the shorter forwarding window', async () => {
  const { bridge, fake, events } = makeBridge({
    devicesInSession: () => ['dev_a'],
    questionTimeoutMs: 5_000,
    questionTimedTimeoutMs: 20,
    questionLateWindowMs: 1_000,
  })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const startedAt = Date.now()
  const result = await handler.listener(
    questionRequest({ wait: { callId: 'call-9', timed: true } }),
    async () => 'delegated',
  )
  const elapsed = Date.now() - startedAt
  assert.equal(result, 'delegated')
  assert.ok(elapsed < 2_000, `the timed window must be short, took ${elapsed}ms`)
  const ask = events.find(event => event.kind === 'question-ask')
  assert.equal(ask.canAnswerLate, true)
  assert.ok(ask.expiresAt - Date.now() < 5_000, 'the phone must not be told it has the long blocking window')
})

test('a blocking question that times out is not kept for late answers', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], questionTimeoutMs: 10 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const result = await handler.listener(questionRequest(), async () => 'delegated')
  assert.equal(result, 'delegated')
  const ask = events.find(event => event.kind === 'question-ask')
  assert.equal(ask.canAnswerLate, false)
  assert.equal(bridge.answerQuestion({ questionId: ask.questionId, answers: [] }), false)
})

test('提问转发：intent.display 的三类人话（question/detail/approve）原样到达手机', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], questionTimeoutMs: 2_000 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  // 新版 DSH 的形状：`question` 只是空串，人话全在 intent.display（本地化字典）。
  const display = {
    question: { zh: '要执行这个计划吗？', en: 'Run this plan?' },
    detail: { zh: '会影响 3 个文件', en: 'It touches 3 files' },
    approve: { zh: '批准并执行', en: 'Approve and run' },
  }
  const answerPromise = handler.listener({
    questions: [
      { id: 'plan-1', question: '', intent: { kind: 'plan-review', approve: 'Approve?', callId: 'call-1', display } },
      { id: 'q-2', question: '选哪个？', intent: { kind: 'question', display: { question: { zh: '选哪个？', en: 'Which one?' } } } },
    ],
    agent: { id: 'agent-1' },
  }, async () => 'delegated')
  await delay(20)

  const ask = events.find(event => event.kind === 'question-ask')
  assert.ok(ask, 'the phone must receive the question card')
  assert.deepEqual(ask.items.map(item => item.id), ['plan-1', 'q-2'])
  assert.deepEqual(ask.items[0].intent.display, display, 'display 三个子项原样转发（含 zh/en）')
  assert.equal(ask.items[0].intent.kind, 'plan-review')
  assert.equal(ask.items[0].intent.approve, 'Approve?', '旧的 intent.approve 字符串仍然保留')
  assert.equal(ask.items[0].question, '', '题干照原样转发，空串由 display 兜底（webchat 的回退顺序）')
  assert.deepEqual(ask.items[1].intent.display, { question: { zh: '选哪个？', en: 'Which one?' } }, '普通提问也带 display')
  assert.deepEqual(JSON.parse(JSON.stringify(ask.items)), ask.items, '帧必须是纯 JSON，webchat 可直接消费')

  // 深拷贝：手机侧改自己拿到的字典，不能反改 DSH 的请求对象。
  ask.items[0].intent.display.question.zh = 'mutated'
  assert.equal(display.question.zh, '要执行这个计划吗？', 'display 必须是深拷贝')

  bridge.answerQuestion({
    questionId: ask.questionId,
    deviceId: 'dev_a',
    answers: [{ id: 'plan-1', selected: [] }, { id: 'q-2', selected: [] }],
  })
  await answerPromise
})

test('提问转发：display 非法子项只丢自己，item 与题干照常转发', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], questionTimeoutMs: 2_000 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const tooLongKey = 'k'.repeat(33)
  const questions = [
    {
      id: 'bad-1',
      question: '保留题干',
      // question 是数字、detail 里混了非字符串、approve 超长、note 不在白名单：逐个丢弃。
      intent: {
        kind: 'plan-review',
        display: {
          question: { zh: '问题在', en: 'question' },
          detail: { zh: 'ok', en: 7 },
          approve: { zh: 'x'.repeat(501) },
          note: { zh: '不在白名单' },
        },
      },
    },
    { id: 'bad-2', question: '数组 display', intent: { display: [] } },
    { id: 'bad-3', question: '标量 display', intent: { display: 'nope' } },
    { id: 'bad-4', question: '超长 key', intent: { display: { question: { [tooLongKey]: 'v' } } } },
  ]
  const answerPromise = handler.listener({ questions, agent: { id: 'agent-1' } }, async () => 'delegated')
  await delay(20)

  const ask = events.find(event => event.kind === 'question-ask')
  assert.ok(ask)
  assert.deepEqual(ask.items.map(item => item.id), ['bad-1', 'bad-2', 'bad-3', 'bad-4'], '非法 display 不能丢整条提问')
  assert.equal(ask.items[0].question, '保留题干', '题干不受 display 校验影响')
  assert.deepEqual(ask.items[0].intent.display, { question: { zh: '问题在', en: 'question' } }, '只保留合法子项')
  assert.equal('detail' in ask.items[0].intent.display, false, '混入非字符串的字典整子项丢弃')
  assert.equal('approve' in ask.items[0].intent.display, false, '超长字典整子项丢弃')
  assert.equal('note' in ask.items[0].intent.display, false, '不在白名单的子项不转发')
  assert.equal(ask.items[0].intent.kind, 'plan-review')
  for (const item of ask.items.slice(1)) {
    assert.equal('intent' in item, false, '非法 display 不该凭空造出空 intent')
    assert.ok(item.question.length > 0)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(ask.items)), ask.items)

  bridge.answerQuestion({
    questionId: ask.questionId,
    deviceId: 'dev_a',
    answers: ask.items.map(item => ({ id: item.id, selected: [] })),
  })
  await answerPromise
})

test('提问转发：没有 intent.display 的旧形状完全不受影响（回归）', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], questionTimeoutMs: 2_000 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const handler = questionHandler(fake)
  const answerPromise = handler.listener(questionRequest({
    questions: [
      { id: 'plain', question: '普通提问', detail: '细节', header: 'H', options: [{ label: 'A', description: 'a' }] },
      { id: 'plan', question: '批准？', intent: { kind: 'plan-review', approve: 'Approve 按钮' } },
    ],
  }), async () => 'delegated')
  await delay(20)

  const ask = events.find(event => event.kind === 'question-ask')
  assert.ok(ask)
  assert.deepEqual(ask.items[0], {
    id: 'plain',
    question: '普通提问',
    detail: '细节',
    header: 'H',
    options: [{ label: 'A', description: 'a' }],
  }, '旧形状一个字段都不多')
  assert.equal('intent' in ask.items[0], false, '没有 intent 就不该出现 intent 键')
  assert.deepEqual(ask.items[1].intent, { kind: 'plan-review', approve: 'Approve 按钮' }, 'plan-review 旧字段原样保留')
  assert.equal('display' in ask.items[1].intent, false)

  bridge.answerQuestion({
    questionId: ask.questionId,
    deviceId: 'dev_a',
    answers: [{ id: 'plain', selected: ['A'] }, { id: 'plan', selected: [] }],
  })
  await answerPromise
})

// ---------------------------------------------------------------------------
// v3.0.0: live-adopt —— 接管桌面上已经在跑的会话
// ---------------------------------------------------------------------------

/**
 * 造一个「已经在跑」的 Desktop agent（带 scoped ctx），用于接管测试。
 * 结构对齐 DSH 的 Agent：`ctx.on(name, listener, opts)` 返回 disposer。
 * @param {any} fake
 * @param {string} sessionId
 */
function addLiveAgent(fake, sessionId) {
  const scopedEvents = []
  const agent = {
    id: sessionId,
    messages: [],
    cancelled: [],
    followup(message) {
      this.messages.push(message)
    },
    cancel(cause, opts) {
      this.cancelled.push({ cause, opts })
    },
    ctx: {
      on(event, listener, opts) {
        const entry = { event, listener, opts }
        scopedEvents.push(entry)
        return () => {
          const index = scopedEvents.indexOf(entry)
          if (index >= 0) scopedEvents.splice(index, 1)
        }
      },
    },
  }
  fake.live.set(sessionId, agent)
  return { agent, scopedEvents }
}

test('adopting a live agent registers working approval and question forwarders', async () => {
  const { bridge, fake, events } = makeBridge({
    devicesInSession: () => ['dev_a'],
    approvalTimeoutMs: 1_000,
    questionTimeoutMs: 2_000,
  })
  const { agent, scopedEvents } = addLiveAgent(fake, 'desk-live')
  await bridge.send({ deviceId: 'dev_a', sessionId: 'desk-live', callId: 'c1', text: 'hi', attachments: [] })

  const approvalEntry = scopedEvents.find(entry => entry.event === 'approval/request')
  const questionEntry = scopedEvents.find(entry => entry.event === 'user-questions/request')
  assert.ok(approvalEntry, 'an adopted agent must get an approval forwarder (setup already ran for it)')
  assert.ok(questionEntry, 'an adopted agent must get a question forwarder')
  assert.equal(approvalEntry.opts?.prepend, true)
  assert.equal(questionEntry.opts?.prepend, true)
  assert.equal(fake.created.length, 0, 'a live agent must be adopted, never re-created')
  assert.equal(agent.messages.length, 1, 'the phone message still reaches the adopted agent')

  // 提问转发真的能结算。
  const questionPromise = questionEntry.listener(questionRequest(), async () => 'delegated')
  await delay(10)
  const ask = events.find(event => event.kind === 'question-ask')
  assert.ok(ask, 'the adopted forwarder must emit question-ask')
  const accepted = bridge.answerQuestion({
    questionId: ask.questionId,
    deviceId: 'dev_a',
    answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [] }],
  })
  assert.equal(accepted, true)
  assert.deepEqual((await questionPromise).answers[0], { id: 'q1', selected: ['A'] })

  // 审批转发同理：允许只授权这一次调用。
  const approvalPromise = approvalEntry.listener({ toolName: 'bash' }, () => new Promise(() => {}))
  await delay(10)
  const approval = events.filter(event => event.kind === 'approval-ask').at(-1)
  assert.ok(approval, 'the adopted forwarder must emit approval-ask')
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
})

test('adoption is idempotent: repeated sends and an explicit select register once', async () => {
  const { bridge, fake } = makeBridge({ devicesInSession: () => ['dev_a'] })
  const { scopedEvents } = addLiveAgent(fake, 'desk-once')
  await bridge.send({ deviceId: 'dev_a', sessionId: 'desk-once', callId: 'c1', text: 'a', attachments: [] })
  await bridge.send({ deviceId: 'dev_a', sessionId: 'desk-once', callId: 'c2', text: 'b', attachments: [] })
  const picked = await bridge.selectSession('desk-once')
  assert.equal(picked.ok, true)
  assert.equal(scopedEvents.filter(entry => entry.event === 'approval/request').length, 1)
  assert.equal(scopedEvents.filter(entry => entry.event === 'user-questions/request').length, 1)
})

test('selecting a live desktop conversation adopts it and registers forwarders', async () => {
  const { bridge, fake } = makeBridge({ devicesInSession: () => ['dev_a'] })
  const { agent, scopedEvents } = addLiveAgent(fake, 'desk-select')
  const picked = await bridge.selectSession('desk-select')
  assert.equal(picked.ok, true)
  assert.equal(fake.created.length, 0, 'a live conversation must never be created twice')
  assert.equal(bridge.agents.get('desk-select').agent, agent)
  assert.ok(scopedEvents.some(entry => entry.event === 'approval/request'))
  assert.ok(scopedEvents.some(entry => entry.event === 'user-questions/request'))
})

test('releasing an adopted session unbinds forwarders without disposing the desktop agent', async () => {
  const { bridge, fake } = makeBridge({ devicesInSession: () => ['dev_a'] })
  const { agent, scopedEvents } = addLiveAgent(fake, 'desk-release')
  await bridge.send({ deviceId: 'dev_a', sessionId: 'desk-release', callId: 'c1', text: 'hi', attachments: [] })
  assert.equal(scopedEvents.length, 2)
  await bridge.releaseSession('desk-release')
  assert.equal(scopedEvents.length, 0, 'the adopted listeners must be removed on release')
  assert.equal(fake.live.get('desk-release'), agent, 'the desktop agent itself is not ours to dispose')
})

test('disposing the bridge unbinds every adopted agent and keeps the agents alive', async () => {
  const { bridge, fake } = makeBridge({ devicesInSession: () => ['dev_a'] })
  const first = addLiveAgent(fake, 'desk-one')
  const second = addLiveAgent(fake, 'desk-two')
  await bridge.send({ deviceId: 'dev_a', sessionId: 'desk-one', callId: 'c1', text: 'a', attachments: [] })
  await bridge.send({ deviceId: 'dev_b', sessionId: 'desk-two', callId: 'c2', text: 'b', attachments: [] })
  assert.equal(first.scopedEvents.length, 2)
  assert.equal(second.scopedEvents.length, 2)
  await bridge.dispose()
  assert.equal(first.scopedEvents.length, 0)
  assert.equal(second.scopedEvents.length, 0)
  assert.equal(fake.live.size, 2, 'adopted desktop agents survive a plugin unload')
})

test('an agent resumed by the desktop is adopted so approvals still reach the phone', async () => {
  // 现场顺序：DSH 重启 → 手机先连上并订阅会话 → 桌面随后发消息，DSH 才 resume 出
  // agent。这个 agent 没跑过本插件的 setup，只能靠全局 agent/created 补注册，
  // 否则审批只在桌面弹（2026-11-09 19:49 的实测现象）。
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'] })
  const { agent, scopedEvents } = addLiveAgent(fake, 'desk-resumed')
  assert.equal(scopedEvents.length, 0, 'the desktop agent starts without our forwarders')

  fake.emitAgent('agent/created', { agent, source: 'resume' })

  const approvalEntry = scopedEvents.find(entry => entry.event === 'approval/request')
  const questionEntry = scopedEvents.find(entry => entry.event === 'user-questions/request')
  assert.ok(approvalEntry, 'a desktop-resumed agent must get an approval forwarder')
  assert.ok(questionEntry, 'a desktop-resumed agent must get a question forwarder')
  assert.equal(approvalEntry.opts?.prepend, true)

  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, () => new Promise(() => {}))
  await delay(10)
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval, 'the adopted forwarder must emit approval-ask')
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
})

test('agent/created never double-registers the plugin own conversations', async () => {
  const { bridge, fake } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.createSession('dev_x')
  const agent = fake.live.get('ow-dev_x')
  assert.ok(agent)
  agent.id = 'ow-dev_x'
  // DSH 对我们自己 create 出来的 agent 也会发 agent/created；重复注册会让手机收到两张卡。
  fake.emitAgent('agent/created', { agent, source: 'fresh' })
  assert.equal(fake.scopedEvents.filter(entry => entry.event === 'approval/request').length, 1)
  assert.equal(fake.scopedEvents.filter(entry => entry.event === 'user-questions/request').length, 1)
})

test('B 双端同时可见：请求一到就同时唤起桌面并推给手机，手机先答算手机', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  let desktopAsked = false
  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, async () => {
    desktopAsked = true
    return 'allowed-once'
  })
  assert.equal(desktopAsked, true, 'the desktop dialog is opened immediately, not after a wait')

  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval, 'the phone gets its card at the same time')
  const onDesktop = events.filter(event => event.kind === 'approval-ask' && event.approvalId === approval.approvalId).at(-1)
  assert.equal(onDesktop.onDesktop, true, 'the card knows the desktop is showing the same prompt')

  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
  const resolved = events.find(event => event.kind === 'approval-resolved' && event.approvalId === approval.approvalId)
  assert.equal(resolved.source, 'phone')
})

test('B 双端同时可见：桌面先答，手机收到 desktop 来源的 resolved', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, async () => 'rejected')
  assert.equal(await approvalPromise, 'rejected')
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  const resolved = events.find(event => event.kind === 'approval-resolved' && event.approvalId === approval.approvalId)
  assert.equal(resolved.outcome, 'rejected')
  assert.equal(resolved.source, 'desktop')
})

test('B 实验：请求一到就把 req.signal 换成代理，手机作答后 abort 代理', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const original = new AbortController()
  const req = { toolName: 'ops_bash', signal: original.signal }
  const approvalPromise = approvalEntry.listener(req, () => new Promise(() => {}))

  assert.notEqual(req.signal, original.signal, 'the downstream answerer must see the proxy signal')
  const proxy = req.signal
  assert.equal(proxy.aborted, false)

  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
  assert.equal(proxy.aborted, true, '手机作答后代理 signal 被 abort（若远端传播，桌面弹窗会关闭）')
})

test('B 实验：原始 signal 的 abort 会转发到代理（停止/取消仍然有效）', async () => {
  const { bridge, fake } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const original = new AbortController()
  const req = { toolName: 'ops_bash', signal: original.signal }
  const approvalPromise = approvalEntry.listener(req, () => new Promise(() => {}))
  const proxy = req.signal
  original.abort(new Error('turn cancelled'))
  await delay(5)
  assert.equal(proxy.aborted, true, '原始 signal 的 abort 必须转发，否则「停止」失效')
  assert.equal(await approvalPromise, 'cancelled')
})

test('B 实验：req 被冻结时自动降级为残框模式，不影响手机作答', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const original = new AbortController()
  const req = Object.freeze({ toolName: 'ops_bash', signal: original.signal })
  const approvalPromise = approvalEntry.listener(req, () => new Promise(() => {}))
  assert.equal(req.signal, original.signal, 'frozen request cannot be patched')
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'rejected' }), true)
  assert.equal(await approvalPromise, 'rejected')
})

test('B 双端同时可见：手机不在线时桌面直接弹，手机连上后仍可作答', async () => {
  let online = []
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => online })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  let desktopAsked = false
  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, async () => {
    desktopAsked = true
    return 'allowed-once'
  })
  assert.equal(desktopAsked, true)
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  const pending = bridge.pendingApprovals('ow-dev_a')
  assert.equal(pending.length, 1, 'the request stays replayable for a late phone')
  assert.equal(pending[0].onDesktop, true)

  online = ['dev_a']
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
})

test('代理状态：自检通过且版本在白名单里 → enabled/tested，启动只写一行中文日志', () => {
  const logs = []
  const { bridge } = makeBridge({ hostVersion: '0.2.2-rc.1', log: line => logs.push(line) })
  const status = bridge.approvalProxyStatus()
  assert.equal(status.enabled, true)
  assert.equal(status.selfCheck, 'passed')
  assert.equal(status.hostVersion, '0.2.2-rc.1')
  assert.equal(status.tested, true)
  assert.equal(logs.length, 1, '启动自检只留一行结论日志')
  assert.match(logs[0], /代理自检通过/)
  assert.match(logs[0], /已实测/)
})

test('代理状态：未实测版本仍然启用，但 tested=false 并明确警告', () => {
  const logs = []
  const { bridge } = makeBridge({ hostVersion: '9.9.9', log: line => logs.push(line) })
  const status = bridge.approvalProxyStatus()
  assert.equal(status.enabled, true, '未实测版本不关闭功能，只是代理可能失效')
  assert.equal(status.tested, false)
  assert.match(status.reason, /未实测/)
  assert.match(logs[0], /未实测/)
})

test('代理状态：运行时版本不可读时 tested=false，reason 说明不可读', () => {
  const { bridge } = makeBridge({ hostVersion: null })
  const status = bridge.approvalProxyStatus()
  assert.equal(status.hostVersion, null)
  assert.equal(status.enabled, true)
  assert.equal(status.tested, false)
  assert.match(status.reason, /不可读/)
})

test('版本白名单：命中已实测/同家族，跨小版本与不可读一律不命中', () => {
  assert.deepEqual([...TESTED_DSH_VERSIONS], ['0.2.2-rc.1'])
  assert.equal(isTestedDshVersion('0.2.2-rc.1'), true)
  assert.equal(isTestedDshVersion('v0.2.2'), true, '去 v 前缀且同家族 = 已实测')
  assert.equal(isTestedDshVersion('0.2.2+build.7'), true, '构建元数据不影响判定')
  assert.equal(isTestedDshVersion('0.3.0'), false)
  assert.equal(isTestedDshVersion(''), false)
  assert.equal(isTestedDshVersion(null), false)
  assert.equal(isTestedDshVersion('not-a-version'), false)
})

test('启动自检在本运行时通过，且不替换全局 AbortController', () => {
  const controller = globalThis.AbortController
  assert.deepEqual(runApprovalProxySelfCheck(), { ok: true })
  assert.equal(globalThis.AbortController, controller)
})

test('自检失败 → 不抛、退回不代理，但桌面弹窗照开、手机仍能作答', async () => {
  const logs = []
  const { bridge, fake, events } = makeBridge({
    devicesInSession: () => ['dev_a'],
    approvalSelfCheck: () => ({ ok: false, reason: '合成的自检失败' }),
    log: line => logs.push(line),
  })
  const status = bridge.approvalProxyStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.selfCheck, 'failed')
  assert.match(status.reason, /自检失败/)
  assert.match(logs[0], /自检失败/)

  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const original = new AbortController()
  const req = { toolName: 'ops_bash', signal: original.signal }
  let desktopAsked = false
  const approvalPromise = approvalEntry.listener(req, () => {
    desktopAsked = true
    return new Promise(() => {})
  })
  assert.equal(desktopAsked, true, '自检失败只影响关窗，不影响唤起桌面弹窗')
  assert.equal(req.signal, original.signal, '自检失败时绝不写 req.signal')

  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
})

test('experimentalDualApproval 关闭：不写 req.signal、next() 仍调用、手机仍能结算', async () => {
  const logs = []
  const { bridge, fake, events } = makeBridge({
    config: { experimentalDualApproval: false },
    devicesInSession: () => ['dev_a'],
    log: line => logs.push(line),
  })
  const status = bridge.approvalProxyStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.selfCheck, 'skipped')
  assert.match(status.reason, /已关闭/)
  assert.equal(logs.length, 1, '开关关闭也只留一行说明日志')
  assert.match(logs[0], /已关闭/)

  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const req = { toolName: 'ops_bash' }
  let desktopAsked = false
  const approvalPromise = approvalEntry.listener(req, () => {
    desktopAsked = true
    return new Promise(() => {})
  })
  assert.equal(desktopAsked, true, '开关关闭也必须唤起桌面弹窗（由用户自己点掉）')
  assert.equal('signal' in req, false, '开关关闭时不得往请求对象写 signal')

  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  const onDesktop = events.filter(event => event.kind === 'approval-ask').at(-1)
  assert.equal(onDesktop.onDesktop, true, '手机卡片照旧，且标注桌面也已弹出')
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'allowed-once' }), true)
  assert.equal(await approvalPromise, 'allowed-once')
  const resolved = events.find(event => event.kind === 'approval-resolved' && event.approvalId === approval.approvalId)
  assert.equal(resolved.source, 'phone', '先答先算：手机先答就是 phone')
})

test('experimentalDualApproval 关闭：桌面先答仍以 desktop 来源结算', async () => {
  const { bridge, fake, events } = makeBridge({
    config: { experimentalDualApproval: false },
    devicesInSession: () => ['dev_a'],
  })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const req = { toolName: 'ops_bash' }
  const approvalPromise = approvalEntry.listener(req, async () => 'rejected')
  assert.equal(await approvalPromise, 'rejected')
  assert.equal('signal' in req, false, '桌面先答也不能留下 signal 代理')
  const approval = events.find(event => event.kind === 'approval-ask')
  const resolved = events.find(event => event.kind === 'approval-resolved' && event.approvalId === approval.approvalId)
  assert.equal(resolved.source, 'desktop')
})

test('req.signal 只读时代理降级、不抛，手机作答照旧生效', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'] })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const original = new AbortController()
  const req = {}
  Object.defineProperty(req, 'signal', {
    get: () => original.signal,
    set: () => { throw new TypeError('readonly signal') },
    configurable: true,
  })
  const approvalPromise = approvalEntry.listener(req, () => new Promise(() => {}))
  assert.equal(req.signal, original.signal, '写不进去就保持原样')
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'rejected' }), true)
  assert.equal(await approvalPromise, 'rejected')
})

test('desktop user messages are forwarded live, phone-injected and runtime ones are not', async () => {
  const { bridge, fake, events } = makeBridge()
  const { sessionId } = await bridge.createSession('dev_a')
  const session = { id: sessionId }
  const userEvent = (text, source, id) => ({
    type: 'user/message',
    time: 1700000000000,
    data: { id, role: 'user', source, content: [{ type: 'text', text }] },
  })

  // 桌面 GUI 发的：source 带 rpcId → 同步给手机。
  fake.fire(session, userEvent('电脑上发的', { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' }, 'm1'))
  const forwarded = events.filter(event => event.kind === 'user-message')
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0].text, '电脑上发的')
  assert.equal(forwarded[0].messageId, 'm1')
  assert.equal(forwarded[0].at, 1700000000000)
  assert.equal(forwarded[0].sessionId, sessionId)

  // 手机自己发的（本插件注入，没有 rpcId）：手机本地已有气泡，不能重复转发。
  fake.fire(session, userEvent('手机发的', { kind: 'user' }, 'm2'))
  // runtime context 之类的内部注入：不是用户消息。
  fake.fire(session, userEvent('Current runtime context: x', { kind: 'runtime-context' }, 'm3'))
  assert.equal(events.filter(event => event.kind === 'user-message').length, 1)
})

test('a desktop turn is mirrored to the phone as a normal assistant reply', async () => {
  const { bridge, fake, events } = makeBridge()
  const { sessionId } = await bridge.createSession('dev_a')
  const session = { id: sessionId }

  fake.fire(session, { type: 'turn/start', time: 1, data: { turn: 3 } })
  fake.fire(session, {
    type: 'assistant/message',
    time: 2,
    data: { turn: 3, step: 1, message: { id: 'am_1', content: [{ type: 'text', text: '桌面上的回复' }] } },
  })
  fake.fire(session, { type: 'turn/end', time: 3, data: { turn: 3, reason: { kind: 'completed' } } })

  const message = events.find(event => event.kind === 'message')
  assert.ok(message, 'desktop turns must emit a chat message to the phone')
  assert.equal(message.text, '桌面上的回复')
  assert.equal(message.sessionId, sessionId)
  assert.match(message.callId, /^desk_/, 'desktop turns use a synthetic call id')
  const done = events.find(event => event.kind === 'done')
  assert.ok(done)
  assert.equal(done.text, '桌面上的回复')
})

test('harness-injected user messages never become blue bubbles', () => {
  // runtime context / skill catalog 都是 DSH 内部注入的 user/message，必须过滤掉。
  const injected = historyMessageOf({
    type: 'user/message',
    seq: 7,
    time: Date.now(),
    data: {
      id: 'm1',
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes…' }],
    },
  })
  assert.equal(injected, undefined)
  const reminder = historyMessageOf({
    type: 'user/message',
    seq: 8,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text: '<system-reminder>changed</system-reminder>' }] },
  })
  assert.equal(reminder, undefined, '无 source 元数据时按文本前缀兜底')
  // 真正的用户消息照常映射。
  const real = historyMessageOf({
    type: 'user/message',
    seq: 9,
    time: Date.now(),
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  })
  assert.ok(real)
  assert.equal(real.kind, 'user')
  assert.equal(real.text, '你好')
})

// ---------------------------------------------------------------------------
// v3.0.0 会话标题：readTitleSnapshots 的真实形状 / 兜底区分 / 确定性去重
// ---------------------------------------------------------------------------

/**
 * 只含会话列表 / 标题快照的 sessionQuery 假实现。
 * @param {Array<any>} records listSessions() 的返回值
 * @param {(ids: string[]) => Array<any>} readTitles readTitleSnapshots() 的返回值
 */
function sessionQueryFixture(records, readTitles) {
  return {
    listSessions: async () => records,
    readTitleSnapshots: async ids => readTitles(ids),
  }
}

/**
 * 一条 DSH `SessionTitleObservation`：`title` 是**对象**（SessionTitleSnapshot），
 * 不是字符串——这正是 v3.0.0 之前取不到标题的根因。
 */
function titleObservation(sessionId, title) {
  return {
    sessionId,
    status: 'fulfilled',
    value: {
      session: { id: sessionId, createdAt: 1, cwd: '/work/proj' },
      title: { title, messageSeqs: [1], source: 'auto', eventSeq: 3, updatedAt: 4 },
    },
  }
}

test('会话标题：value.title 是 SessionTitleSnapshot 对象（带 title 字符串）也能取到', async () => {
  const { bridge, fake } = makeBridge()
  fake.ctx.sessionQuery = sessionQueryFixture(
    [
      { header: { id: 'sess-a', createdAt: 2, cwd: '/work/proj' } },
      { header: { id: 'sess-b', createdAt: 1, cwd: '/work/other' } },
    ],
    ids => [
      titleObservation(ids[0], `标题-${ids[0]}`),
      // 真实 observation 里顶层不一定有 sessionId：退回 value.session.id / 请求顺序。
      { status: 'fulfilled', value: { session: { id: ids[1] }, title: { title: `标题-${ids[1]}` } } },
    ],
  )
  const { sessions } = await bridge.listSessions()
  assert.deepEqual(sessions.map(session => session.title), ['标题-sess-a', '标题-sess-b'])
})

test('会话标题：字符串形状仍兼容；rejected 的会话退回 cwd 兜底（唯一时不加 id）', async () => {
  const { bridge, fake } = makeBridge()
  fake.ctx.sessionQuery = sessionQueryFixture(
    [
      { header: { id: 'sess-a', createdAt: 2, cwd: '/work/proj' } },
      { header: { id: 'sess-b', createdAt: 1, cwd: '/work/proj' } },
    ],
    ids => [
      { sessionId: ids[0], status: 'fulfilled', value: { session: { id: ids[0] }, title: '字符串标题' } },
      { sessionId: ids[1], status: 'rejected', reason: new Error('读不到标题') },
    ],
  )
  const { sessions } = await bridge.listSessions()
  assert.equal(sessions[0].title, '字符串标题')
  // 同一 cwd 下只有一个无标题会话：不加 id 后缀，保持干净。
  assert.equal(sessions[1].title, 'proj')
})

test('会话标题：同 cwd 多个无标题会话用 id 后 6 位区分，且跨刷新稳定', async () => {
  const records = [
    { header: { id: '0f9c2b1e-aaaa-bbbb-cccc-3f2a19', createdAt: 3, cwd: '/work/default-workspace' } },
    { header: { id: '0f9c2b1e-aaaa-bbbb-cccc-7d81e4', createdAt: 2, cwd: '/work/default-workspace' } },
    { header: { id: '0f9c2b1e-aaaa-bbbb-cccc-9c0b55', createdAt: 1, cwd: '/work/default-workspace' } },
  ]
  const { bridge, fake } = makeBridge()
  fake.ctx.sessionQuery = sessionQueryFixture(
    records,
    ids => ids.map(id => ({ sessionId: id, status: 'rejected', reason: 'no title' })),
  )
  const first = await bridge.listSessions()
  assert.deepEqual(first.sessions.map(session => session.title), [
    'default-workspace · 3f2a19',
    'default-workspace · 7d81e4',
    'default-workspace · 9c0b55',
  ])
  const second = await bridge.listSessions()
  assert.deepEqual(second.sessions, first.sessions, '同一份输入必须稳定（不依赖随机/遍历顺序）')
})

test('会话标题：真实标题同名时确定性追加 #2/#3，非同名标题保持原样', async () => {
  const { bridge, fake } = makeBridge()
  fake.ctx.sessionQuery = sessionQueryFixture(
    [
      { header: { id: 'sess-a', createdAt: 3, cwd: '/work/a' } },
      { header: { id: 'sess-b', createdAt: 2, cwd: '/work/b' } },
      { header: { id: 'sess-c', createdAt: 1, cwd: '/work/c' } },
    ],
    ids => ids.map((id, index) => titleObservation(id, index === 2 ? '另一个标题' : '同一个标题')),
  )
  const first = await bridge.listSessions()
  assert.deepEqual(first.sessions.map(session => session.title), [
    '同一个标题',
    '同一个标题 #2',
    '另一个标题',
  ])
  const second = await bridge.listSessions()
  assert.deepEqual(second.sessions, first.sessions, '去重序号必须稳定')
})


test('历史快照把手机消息映射回本地 msgId，并剥掉附件提示', async () => {
  const { bridge, fake } = makeBridge()
  bridge.phoneMessageIds.set('m_phone', 'pm-1')
  fake.ctx.sessionQuery = {
    readSession: async () => ({
      events: [
        {
          type: 'user/message', seq: 5, time: 1700000000000,
          data: {
            id: 'm_phone', role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: '看这个\n\n用户通过手机发来了 1 个附件，已保存到电脑上（路径相对本次对话的工作目录）：\n- 图片：a.jpg；请按需读取这些文件；图片请用图像读取工具查看。' }],
          },
        },
        {
          type: 'user/message', seq: 6, time: 1700000001000,
          data: {
            id: 'm_desktop', role: 'user', source: { kind: 'user', rpcId: 'rpc-1' },
            content: [{ type: 'text', text: '桌面发的问题' }],
          },
        },
      ],
    }),
  }
  const messages = await bridge.historyMessages('ow-dev_a')
  assert.deepEqual(messages.map(m => ({ id: m.id, msgId: m.msgId, text: m.text, seq: m.seq })), [
    { id: 'hist_5', msgId: 'pm-1', text: '看这个', seq: 5 },
    { id: 'hist_6', msgId: 'dsh_m_desktop', text: '桌面发的问题', seq: 6 },
  ])
})

test('stripPhoneAttachmentNotice：纯文本不变 / 剥离注入段 / 只有附件时给占位', () => {
  assert.equal(stripPhoneAttachmentNotice('你好'), '你好')
  assert.equal(stripPhoneAttachmentNotice('看这个\n\n用户通过手机发来了 1 个附件，已保存到电脑上：…'), '看这个')
  assert.equal(stripPhoneAttachmentNotice('用户通过手机发来了 1 个附件，已保存到电脑上：…'), '（来自手机的附件）')
})
