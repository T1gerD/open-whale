// 协议帧名的字面量镜像。
//
// 为什么再抄一遍字面量：核心逻辑是零依赖的（不 import 任何包，包括
// `@openwhale/protocol`），否则 `node --test` 在没有 node_modules 的机器上跑不起来。
// 唯一的契约风险——“协议改了名字而镜像没跟着改”——由
// `test/frames.test.mjs` 兜住：它把这里的每个字面量和真实的
// `packages/protocol/src/index.mjs` 做 deepEqual 比较。
// 任何字段/类型上的疑问，一律以 protocol 的源码为准。

export const CLIENT_FRAME = {
  HELLO: 'hello',
  PAIR_REQ: 'pair/req',
  PING: 'ping',
  CHAT: 'chat/send',
  CHAT_CANCEL: 'chat/cancel',
  FILE_FETCH: 'file/fetch',
  FILE_CANCEL: 'file/cancel',
  ASSISTANT_RENAME: 'assistant/rename',
  DEVICE_RENAME: 'device/rename',
  DEVICE_FORGET: 'device/forget',
  POWER: 'power/request',
} as const

export const SERVER_FRAME = {
  HELLO_ACK: 'hello/ack',
  ERROR: 'error',
  PAIR_OK: 'pair/ok',
  PONG: 'pong',
  CHAT_ACK: 'chat/ack',
  CHAT_DELTA: 'chat/delta',
  CHAT_DONE: 'chat/done',
  CHAT_ERROR: 'chat/error',
  TOOL: 'chat/tool',
  TYPING: 'chat/typing',
  FILE_META: 'file/meta',
  FILE_CHUNK: 'file/chunk',
  FILE_END: 'file/end',
  FILE_ERROR: 'file/error',
  ASSISTANTS: 'assistants',
  POWER_STATE: 'power/state',
} as const

/** 协议版本，镜像 `PROTOCOL_VERSION`（由 frames 测试核对）。 */
export const PROTOCOL_VERSION = '1.0.0'

/** 心跳默认值，镜像 `DEFAULT_HEARTBEAT_MS`。 */
export const DEFAULT_HEARTBEAT_MS = 25_000

/** 单帧助理回答上限，镜像 `MAX_ASSISTANT_CHARS`。 */
export const MAX_ASSISTANT_CHARS = 24_000

/** 文件分块大小，镜像 `FILE_CHUNK_BYTES`。 */
export const FILE_CHUNK_BYTES = 256 * 1024

/** 单个文件上限，镜像 `MAX_FILE_BYTES`。 */
export const MAX_FILE_BYTES = 512 * 1024 * 1024

/** 电源拒绝原因，镜像 `POWER_REFUSAL`。 */
export const POWER_REFUSAL = {
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
  NO_PRIVILEGE: 'no-privilege',
  DISABLED_BY_POLICY: 'disabled-by-policy',
  ALREADY_PENDING: 'already-pending',
  FAILED: 'failed',
} as const

/** 活动行类型，镜像 `ACTIVITY_KIND`。 */
export const ACTIVITY_KIND = {
  THINKING: 'thinking',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
} as const
