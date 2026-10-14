// 契约测试：镜像到 core/frames.mts 的常量必须和真实 protocol 完全一致。
//
// 这是“核心逻辑零依赖”的代价的对冲：字面量可以抄，但抄错必须立刻红。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVITY_KIND,
  CLIENT_FRAME,
  DEFAULT_HEARTBEAT_MS,
  FILE_CHUNK_BYTES,
  MAX_ASSISTANT_CHARS,
  MAX_FILE_BYTES,
  POWER_REFUSAL,
  PROTOCOL_VERSION,
  SERVER_FRAME,
} from '../../protocol/src/index.mjs'

import {
  ACTIVITY_KIND as MIRROR_ACTIVITY,
  CLIENT_FRAME as MIRROR_CLIENT,
  DEFAULT_HEARTBEAT_MS as MIRROR_HEARTBEAT,
  FILE_CHUNK_BYTES as MIRROR_CHUNK,
  MAX_ASSISTANT_CHARS as MIRROR_MAX_CHARS,
  MAX_FILE_BYTES as MIRROR_MAX_FILE,
  POWER_REFUSAL as MIRROR_REFUSAL,
  PROTOCOL_VERSION as MIRROR_VERSION,
  SERVER_FRAME as MIRROR_SERVER,
} from '../src/core/frames.mts'

test('mirrored frame vocabularies match the protocol exactly', () => {
  assert.deepEqual(MIRROR_CLIENT, CLIENT_FRAME)
  assert.deepEqual(MIRROR_SERVER, SERVER_FRAME)
  assert.deepEqual(MIRROR_ACTIVITY, ACTIVITY_KIND)
  assert.deepEqual(MIRROR_REFUSAL, POWER_REFUSAL)
})

test('mirrored numeric constants match the protocol exactly', () => {
  assert.equal(MIRROR_VERSION, PROTOCOL_VERSION)
  assert.equal(MIRROR_HEARTBEAT, DEFAULT_HEARTBEAT_MS)
  assert.equal(MIRROR_MAX_CHARS, MAX_ASSISTANT_CHARS)
  assert.equal(MIRROR_CHUNK, FILE_CHUNK_BYTES)
  assert.equal(MIRROR_MAX_FILE, MAX_FILE_BYTES)
})
