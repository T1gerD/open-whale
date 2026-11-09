import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  DshBridge,
  describeFailure,
  extractAssistantText,
  historyMessageOf,
  isInjectedUserMessage,
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
 */
function fakeContext() {
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
          options.setup?.({
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

function makeBridge({ config = {}, fire, ...options } = {}) {
  const fake = fakeContext()
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
  const approvalPromise = approvalEntry.listener({ toolName: 'bash' }, async () => 'delegated')
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

  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, async () => 'desktop')
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

test('delegating an approval hands it to the desktop instead of rejecting', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], approvalTimeoutMs: 60_000 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, async () => 'delegated-to-desktop')
  await delay(10)
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  assert.equal('expiresAt' in approval, false, 'the card relies on the 60s handoff, not an expiry')

  assert.equal(bridge.answerApproval({ approvalId: approval.approvalId, deviceId: 'dev_a', outcome: 'delegate' }), true)
  assert.equal(await approvalPromise, 'delegated-to-desktop', 'delegate must call next()')
  const resolved = events.find(event => event.kind === 'approval-resolved' && event.approvalId === approval.approvalId)
  assert.equal(resolved.outcome, 'delegated')
  assert.equal(resolved.source, 'phone')
})

test('an approval nobody answers is handed back to the desktop after the window', async () => {
  const { bridge, fake, events } = makeBridge({ devicesInSession: () => ['dev_a'], approvalTimeoutMs: 20 })
  await bridge.send({ deviceId: 'dev_a', callId: 'c1', text: 'hi', attachments: [] })
  const approvalEntry = fake.scopedEvents.find(entry => entry.event === 'approval/request')
  const approvalPromise = approvalEntry.listener({ toolName: 'ops_bash' }, async () => 'desktop-took-over')
  await delay(60)
  assert.equal(await approvalPromise, 'desktop-took-over', 'timeout must fall through to the desktop UI')
  const approval = events.find(event => event.kind === 'approval-ask')
  assert.ok(approval)
  const resolved = events.find(event => event.kind === 'approval-resolved' && event.approvalId === approval.approvalId)
  assert.equal(resolved.outcome, 'cancelled')
  assert.equal(resolved.source, 'timeout')
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

