// The plugin entry's pure helpers.
//
// `resolveModelSelection` exists because of a concrete production failure: a new
// phone conversation created without a model makes the harness fail during prompt
// assembly ("prompt variable \"{{model}}\" has no value"), so *every* message from
// the phone returns that internal error. These tests pin the resolution order and
// the profile-file reader that stands in when the default-model service is absent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, DEFAULT_CONFIG, readProfileDefaultModel, resolveModelSelection } from '../src/index.mjs'

/**
 * A fake ctx exposing only what the resolver looks at.
 *
 * `agentDefaultModel` is read through `ctx.get(name)` rather than as a plain
 * property: the plugin only declares `agents` in `inject`, and reading an
 * undeclared service as a property throws in Cordis. `get()` is the documented
 * way to read an optional service, so the fake mirrors that.
 */
function fakeCtx({ service, agents } = {}) {
  const services = {}
  if (service) services.agentDefaultModel = service
  if (agents) services.agents = { list: () => agents }
  return {
    ...(service ? { agentDefaultModel: service } : {}),
    ...(agents ? { agents: { list: () => agents } } : {}),
    get: name => services[name],
  }
}

/**
 * Isolated profile reader. Without this the resolver would inspect the real
 * DSH_HOME of whatever machine runs the suite, making results machine-dependent.
 */
const noProfile = () => undefined

/** Build a fake DSH_HOME with one profile writing the given YAML. */
function withProfile(yaml, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'openwhale-home-'))
  const profileDir = join(home, 'profiles', options.profile ?? 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, options.file ?? 'cordis.patch.yml'), yaml)
  return home
}

test('the plugin ships a default config even without schemastery', () => {
  assert.equal(DEFAULT_CONFIG.tunnelMode, 'off')
  assert.equal(DEFAULT_CONFIG.autoApproveTools, false)
  assert.equal(DEFAULT_CONFIG.allowRemoteShutdown, true)
  assert.equal(DEFAULT_CONFIG.voice, 'personal-assistant')
  // `Config` is `undefined` when schemastery cannot be resolved (a `link:`
  // install resolves this import against the checkout, which has no
  // schemastery). It must never be `null`: DSH's settings page guards with
  // `schema !== void 0 && 'toJSON' in schema`, so `null` throws a TypeError and
  // the desktop window never finishes starting.
  assert.ok(Config === undefined || typeof Config === 'object')
  assert.notEqual(Config, null)
})

test('the harness default-model service wins over everything else', () => {
  const logs = []
  const selection = resolveModelSelection(
    fakeCtx({
      service: { currentSelection: () => ({ provider: 'svc', model: 'svc-model', reasoningEffort: 'high' }) },
      agents: [{ options: { provider: 'sess', model: 'sess-model' } }],
    }),
    message => logs.push(message),
    { provider: 'cfg', model: 'cfg-model' },
    noProfile,
  )
  assert.deepEqual(selection, { provider: 'svc', model: 'svc-model', reasoningEffort: 'high' })
})

test('a service that throws is reported and then bypassed', () => {
  const logs = []
  const selection = resolveModelSelection(
    fakeCtx({ service: { currentSelection: () => { throw new Error('boom') } }, agents: [{ options: { provider: 'a', model: 'b' } }] }),
    message => logs.push(message),
    {},
    noProfile,
  )
  assert.deepEqual(selection, { provider: 'a', model: 'b' })
  assert.equal(logs.some(line => /boom/.test(line)), true)
})

test('a service that reports an incomplete selection is ignored', () => {
  const selection = resolveModelSelection(
    fakeCtx({ service: { currentSelection: () => ({ provider: 'only-provider' }) }, agents: [{ options: { provider: 'a', model: 'b' } }] }),
    () => {},
    {},
    noProfile,
  )
  assert.deepEqual(selection, { provider: 'a', model: 'b' })
})

test('a live session header is used when the service and profile are silent', () => {
  const selection = resolveModelSelection(
    fakeCtx({ agents: [{ session: { header: { provider: 'from-header', model: 'h-model' } } }] }),
    () => {},
    {},
    noProfile,
  )
  assert.deepEqual(selection, { provider: 'from-header', model: 'h-model' })
})

test('a nested model header shape is understood too', () => {
  const selection = resolveModelSelection(
    fakeCtx({ agents: [{ session: { header: { model: { provider: 'p', id: 'm' } } } }] }),
    () => {},
    {},
    noProfile,
  )
  assert.deepEqual(selection, { provider: 'p', model: 'm' })
})

test('an explicitly configured profile beats a live session', () => {
  // The active session's model can be a temporary switch; a profile row is what
  // the user configured on purpose, so it wins.
  const selection = resolveModelSelection(
    fakeCtx({ agents: [{ options: { provider: 'temp', model: 'temp-model' } }] }),
    () => {},
    {},
    () => ({ provider: 'configured', model: 'configured-model' }),
  )
  assert.deepEqual(selection, { provider: 'configured', model: 'configured-model' })
})

test('the plugin config is the last resort before giving up', () => {
  const logs = []
  const selection = resolveModelSelection(fakeCtx({}), message => logs.push(message), { provider: 'cfg', model: 'cfg-model' }, noProfile)
  assert.deepEqual(selection, { provider: 'cfg', model: 'cfg-model' })
})

test('giving up is loud, because the phone cannot reply without a model', () => {
  const logs = []
  const selection = resolveModelSelection(fakeCtx({}), message => logs.push(message), {}, noProfile)
  assert.equal(selection, undefined)
  assert.equal(logs.some(line => /默认模型/.test(line)), true)
})

test('readProfileDefaultModel reads a plain patch row', () => {
  const home = withProfile([
    '- id: some-other-plugin',
    '  name: x',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
    '    reasoningEffort: high',
    '',
  ].join('\n'))
  assert.deepEqual(readProfileDefaultModel({ dshHome: home }), {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
  rmSync(home, { recursive: true, force: true })
})

test('readProfileDefaultModel tolerates quotes and inline comments', () => {
  const home = withProfile([
    '- id: "agent-default-model"',
    "  config: { provider: 'p1', model: 'm1' }",
    '    provider: p2 # the effective one',
    '    model: "m2"',
    '',
  ].join('\n'))
  const selection = readProfileDefaultModel({ dshHome: home })
  assert.equal(selection.provider, 'p2')
  assert.equal(selection.model, 'm2')
  rmSync(home, { recursive: true, force: true })
})

test('readProfileDefaultModel takes the last complete row (patches overwrite by id)', () => {
  const home = withProfile([
    '- id: agent-default-model',
    '  config:',
    '    provider: old',
    '    model: old-model',
    '- id: agent-default-model',
    '  config:',
    '    provider: new',
    '    model: new-model',
    '',
  ].join('\n'))
  assert.deepEqual(readProfileDefaultModel({ dshHome: home }), { provider: 'new', model: 'new-model' })
  rmSync(home, { recursive: true, force: true })
})

test('readProfileDefaultModel ignores an incomplete row', () => {
  const home = withProfile([
    '- id: agent-default-model',
    '  config:',
    '    provider: only-provider',
    '',
  ].join('\n'))
  assert.equal(readProfileDefaultModel({ dshHome: home }), undefined)
  rmSync(home, { recursive: true, force: true })
})

test('readProfileDefaultModel stops at the next sibling row', () => {
  const home = withProfile([
    '- id: agent-default-model',
    '  config:',
    '    provider: p',
    '- id: another-plugin',
    '  config:',
    '    model: leaked-model',
    '',
  ].join('\n'))
  // `provider` came from the model row but `model` belongs to a different plugin:
  // accepting this would make the phone run on a stranger's model.
  assert.equal(readProfileDefaultModel({ dshHome: home }), undefined)
  rmSync(home, { recursive: true, force: true })
})

test('readProfileDefaultModel also reads cordis.yml', () => {
  const home = withProfile([
    '- id: agent-default-model',
    '  config:',
    '    provider: from-cordis-yml',
    '    model: m',
    '',
  ].join('\n'), { file: 'cordis.yml' })
  assert.deepEqual(readProfileDefaultModel({ dshHome: home }), { provider: 'from-cordis-yml', model: 'm' })
  rmSync(home, { recursive: true, force: true })
})

test('readProfileDefaultModel returns undefined for a missing home or malformed tree', () => {
  const previous = process.env.DSH_HOME
  // Blank the environment so `dshHome: undefined` really means "no profile",
  // instead of silently reading the machine's real DSH_HOME.
  delete process.env.DSH_HOME
  try {
    assert.equal(readProfileDefaultModel({}), undefined)
    assert.equal(readProfileDefaultModel({ dshHome: join(tmpdir(), 'definitely-not-a-dsh-home-12345') }), undefined)
  } finally {
    if (previous !== undefined) process.env.DSH_HOME = previous
  }

  // A home that exists but has no profiles directory is undefined too, not a throw.
  const emptyHome = mkdtempSync(join(tmpdir(), 'openwhale-empty-home-'))
  assert.equal(readProfileDefaultModel({ dshHome: emptyHome }), undefined)
  rmSync(emptyHome, { recursive: true, force: true })
})

test('resolveModelSelection falls back to the profile file when the service is absent', () => {
  const home = withProfile([
    '- id: agent-default-model',
    '  config:',
    '    provider: from-profile',
    '    model: profile-model',
    '',
  ].join('\n'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const logs = []
    const selection = resolveModelSelection(fakeCtx({}), message => logs.push(message), {})
    assert.deepEqual(selection, { provider: 'from-profile', model: 'profile-model' })
    assert.equal(logs.some(line => /profile/.test(line)), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
