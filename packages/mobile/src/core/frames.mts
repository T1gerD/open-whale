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
  SESSION_SYNC: 'session/sync',
  UPLOAD_START: 'upload/start',
  UPLOAD_CHUNK: 'upload/chunk',
  UPLOAD_END: 'upload/end',
  UPLOAD_CANCEL: 'upload/cancel',
  /** 会话选择器（2.3.0）：列出电脑上的 DSH 会话。 */
  SESSION_LIST: 'session/list',
  /** 选中其中一个会话（电脑端可能 resume 它）。 */
  SESSION_SELECT: 'session/select',
  /** 新建一个会话并绑定这台设备。 */
  SESSION_CREATE: 'session/create',
  /**
   * 保持这些会话的事件继续推给我（2.4.0 标签页）。
   * 整体替换上一次的订阅集合；当前活跃会话不需要列进来。
   */
  SESSION_WATCH: 'session/watch',
  /** 取某个标签的状态快照，不改变"消息发往哪个会话"（2.4.0）。 */
  SESSION_SNAPSHOT: 'session/snapshot',
  /** 回答电脑端转发来的 DSH 权限请求（2.3.0）。 */
  APPROVAL_REPLY: 'approval/reply',
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
  CHAT_ECHO: 'chat/echo',
  CHAT_MESSAGE: 'chat/message',
  SESSION_STATE: 'session/state',
  SESSION_EVENTS: 'session/events',
  /** 会话列表（session/list 的回复）。 */
  SESSIONS: 'sessions',
  /** session/select / session/create 的结果；成功后紧跟一条 session/state 快照。 */
  SESSION_SELECTED: 'session/selected',
  /** 电脑端转发来的一条 DSH 权限请求。 */
  APPROVAL_ASK: 'approval/ask',
  /** 那条请求已经在别处（手机/电脑/超时）被处理。 */
  APPROVAL_RESOLVED: 'approval/resolved',
  UPLOAD_READY: 'upload/ready',
  UPLOAD_PROGRESS: 'upload/progress',
  UPLOAD_DONE: 'upload/done',
  UPLOAD_ERROR: 'upload/error',
  FILE_OFFERED: 'file/offered',
} as const

/**
 * 能力协商字符串，镜像 protocol 的 `CAPABILITIES`。
 *
 * hello / hello/ack 用它声明「我认识哪些新帧」。旧版本没有这个字段 = 没有任何能力，
 * 双方靠它决定发不发新帧，而不是比较版本号（协议兼容矩阵见 PROTOCOL-V2.md §8）。
 */
export const CAPABILITIES = {
  CHAT_ECHO: 'chat-echo-v1',
  CHAT_MESSAGE: 'chat-message-v1',
  SESSION_SYNC: 'session-sync-v1',
  UPLOAD: 'upload-v1',
  FILE_OFFER: 'file-offer-v1',
  ENDPOINT_KINDS: 'endpoint-kinds-v1',
  /** 会话选择器（2.3.0）。 */
  SESSIONS: 'sessions-v1',
  /** 权限请求转发（2.3.0）。 */
  APPROVAL: 'approval-v1',
  /**
   * 会话标签页（2.4.0）：`session/watch` + `session/snapshot`，且所有会话帧
   * 都带 `sessionId`。旧电脑端不声明它，手机端就退回单会话行为。
   */
  SESSION_TABS: 'session-tabs-v1',
} as const

/** 本 build 理解的全部能力（hello 时整包声明）。 */
export const ALL_CAPABILITIES: readonly string[] = Object.freeze(Object.values(CAPABILITIES))

/** 连接方式，镜像 protocol 的 `CONNECTION_MODE`（UI 四选一，持久化到助理记录）。 */
export const CONNECTION_MODE = {
  AUTO: 'auto',
  LAN: 'lan',
  TAILSCALE: 'tailscale',
  TUNNEL: 'tunnel',
} as const

/** 全部连接方式，顺序即 UI 里的展示顺序。 */
export const CONNECTION_MODES: readonly string[] = Object.freeze(Object.values(CONNECTION_MODE))

/** 地址的网络类型，镜像 protocol 的 `ENDPOINT_KIND`。 */
export const ENDPOINT_KIND = {
  LAN: 'lan',
  TAILSCALE: 'tailscale',
  TUNNEL: 'tunnel',
  LOOPBACK: 'loopback',
  UNKNOWN: 'unknown',
} as const

/** 插件默认端口，镜像 protocol 的 `DEFAULT_PORT`（手动输入 host 时补全用）。 */
export const DEFAULT_PORT = 8787

/** 上传空闲清理时间，镜像 protocol 的 `UPLOAD_IDLE_TIMEOUT_MS`。 */
export const UPLOAD_IDLE_TIMEOUT_MS = 3 * 60 * 1000

/** 协议版本，镜像 `PROTOCOL_VERSION`（由 frames 测试核对）。 */
export const PROTOCOL_VERSION = '1.3.0'

/** 心跳默认值，镜像 `DEFAULT_HEARTBEAT_MS`。 */
export const DEFAULT_HEARTBEAT_MS = 25_000

/** 单帧助理回答上限，镜像 `MAX_ASSISTANT_CHARS`。 */
export const MAX_ASSISTANT_CHARS = 24_000

/** 文件分块大小（下载），镜像 `FILE_CHUNK_BYTES`。 */
export const FILE_CHUNK_BYTES = 256 * 1024

/** 上传分块大小，镜像 `UPLOAD_CHUNK_BYTES`。 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024

/** 单个上传附件上限，镜像 `MAX_UPLOAD_BYTES`。 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** 每条消息最多附件数，镜像 `MAX_UPLOAD_ATTACHMENTS`。 */
export const MAX_UPLOAD_ATTACHMENTS = 8

/** 单个文件上限，镜像 `MAX_FILE_BYTES`。 */
export const MAX_FILE_BYTES = 512 * 1024 * 1024

/** 一次 `sessions` 帧里最多列出的会话数，镜像 `SESSION_LIST_LIMIT`。 */
export const SESSION_LIST_LIMIT = 200

/**
 * 一个设备在活跃会话之外最多保持实时订阅的会话数，镜像 `SESSION_WATCH_LIMIT`。
 * `session/watch` 超过这个数量会被整体截断，手机端在构造帧时先截断。
 */
export const SESSION_WATCH_LIMIT = 8

/** 电脑端等手机回答权限请求的时长，镜像 `APPROVAL_TIMEOUT_MS`（UI 用它提示“电脑会先代答”）。 */
export const APPROVAL_TIMEOUT_MS = 60_000

/** 手机端唯一允许的审批答复，镜像 `APPROVAL_REPLY_OUTCOMES`。 */
export const APPROVAL_REPLY_OUTCOMES: readonly string[] = Object.freeze(['allowed-once', 'rejected'])

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
