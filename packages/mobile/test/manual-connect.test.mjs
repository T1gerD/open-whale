// 手动连接 / health 预检的纯判定。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeProbeError,
  interpretHealthResponse,
  mergeManualEndpoint,
  pickAssistantForEndpoint,
} from '../src/core/manual-connect.mts'

const HEALTH = {
  ok: true,
  plugin: 'dsh-openwhale',
  computerId: 'cmp_abc',
  computerName: '书房电脑',
  paired: true,
  connections: 0,
}

test('a healthy Open Whale plugin response is accepted', () => {
  const outcome = interpretHealthResponse(200, HEALTH)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.computerId, 'cmp_abc')
  assert.equal(outcome.name, '书房电脑')
  assert.match(outcome.message, /书房电脑/)
})

test('HTTP errors, foreign services and unhealthy bodies are rejected with hints', () => {
  const notFound = interpretHealthResponse(404, {})
  assert.equal(notFound.ok, false)
  assert.match(notFound.message, /HTTP 404/)
  assert.ok(notFound.hint)

  const foreign = interpretHealthResponse(200, { plugin: 'nginx', ok: true })
  assert.equal(foreign.ok, false)
  assert.match(foreign.message, /不是 Open Whale/)

  const unhealthy = interpretHealthResponse(200, { plugin: 'dsh-openwhale', ok: false })
  assert.equal(unhealthy.ok, false)

  assert.equal(interpretHealthResponse(200, '<html>').ok, false)
  assert.equal(interpretHealthResponse(500, undefined).ok, false)
})

test('network errors are turned into actionable Chinese copy', () => {
  const timeout = describeProbeError(new Error('AbortError: aborted'))
  assert.match(timeout.message, /超时/)
  const refused = describeProbeError(new TypeError('Network request failed'))
  assert.match(refused.message, /无法连接/)
  assert.match(refused.hint, /扫描|扫码/)
})

test('the right assistant record is chosen for a manually entered address', () => {
  const assistants = [
    { id: 'cmp_a', computerId: 'cmp_a' },
    { id: 'cmp_b', computerId: 'cmp_b' },
  ]
  assert.equal(pickAssistantForEndpoint(assistants, 'cmp_b')?.id, 'cmp_b')
  assert.equal(pickAssistantForEndpoint(assistants, 'cmp_a', 'cmp_b')?.id, 'cmp_b')
  assert.equal(pickAssistantForEndpoint(assistants, 'cmp_unknown'), undefined)
  assert.equal(pickAssistantForEndpoint(assistants, undefined), undefined)
})

test('a manually entered address is merged to the front without duplicates', () => {
  assert.deepEqual(mergeManualEndpoint(['https://a.example'], 'http://192.168.1.5:8787'), [
    'http://192.168.1.5:8787',
    'https://a.example',
  ])
  assert.deepEqual(mergeManualEndpoint(['http://x', 'http://y'], 'http://y'), ['http://y', 'http://x'])
  assert.deepEqual(mergeManualEndpoint(undefined, 'http://x'), ['http://x'])
})
