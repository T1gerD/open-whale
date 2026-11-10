// 协议镜像：网页版客户端跑在浏览器里，**不能** import 插件包内的 `packages/protocol`
// （那是构建产物里的相对路径，静态服务器也不保证提供），所以这里维护一份精简副本。
//
// 防漂移：`test/protocol-mirror.test.mjs` 把本文件的每个常量、以及
// `helloSignatureMessage` / `helloAckProofMessage` / `parsePairingPayload` 的行为
// 与真实的 `packages/protocol/src/index.mjs` 逐项比对；协议改名会让测试直接变红。
//
// 规则：本文件只放常量与纯函数；任何字段疑问一律以 protocol 源码为准。

/**
 * 协议 wire 版本。
 *
 * 1.2.0（v2.3.0「纯远程遥控器」）删掉协作，新增会话选择（`sessions-v1`）与
 * 审批转发（`approval-v1`）。
 * 1.3.0（v2.4.0「会话标签页」）新增 `session/watch` / `session/snapshot`
 * （`session-tabs-v1`），并让会话帧都带 `sessionId`：手机/网页可以同时让多个
 * 会话保持在线——就像 DSH 桌面的侧边栏。老客户端不认新帧会自动忽略，反之亦然。
 *
 * 3.0.0：全仓库版本号统一（产品、插件、网页版、协议都标 3.0.0），线上帧格式与
 * 1.3.0 逐字节一致，只改了版本字符串。
 */
export const PROTOCOL_VERSION = '3.0.0'

/** 网页版客户端自身的版本号（与产品版本一致，显示在「关于」里）。 */
export const WEBCHAT_VERSION = '3.0.0'

/** 能力协商标记（hello / hello/ack 的 capabilities）。 */
export const CAPABILITIES = Object.freeze({
  CHAT_ECHO: 'chat-echo-v1',
  CHAT_MESSAGE: 'chat-message-v1',
  SESSION_SYNC: 'session-sync-v1',
  UPLOAD: 'upload-v1',
  FILE_OFFER: 'file-offer-v1',
  ENDPOINT_KINDS: 'endpoint-kinds-v1',
  /** 手机/网页可以列出、切换、新建电脑上的 DSH 会话。 */
  SESSIONS: 'sessions-v1',
  /** 手机/网页可以回答电脑转发的权限请求。 */
  APPROVAL: 'approval-v1',
  /** 结构化提问（ask_user_question / 计划审阅）的转发与回答。 */
  QUESTIONS: 'questions-v1',
  /** `session/watch` + `session/snapshot`：多个会话标签同时保持在线。 */
  SESSION_TABS: 'session-tabs-v1',
})

/** 本客户端理解的全部能力，握手时全量声明。 */
export const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES))

/** 客户端 → 电脑 的帧名。 */
export const CLIENT_FRAME = Object.freeze({
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
  /** 列出电脑上的 DSH 会话（会话选择器）。 */
  SESSION_LIST: 'session/list',
  /** 绑定这台设备到其中一个会话并拉取快照。 */
  SESSION_SELECT: 'session/select',
  /** 新建一个 DSH 会话并绑定到它。 */
  SESSION_CREATE: 'session/create',
  /** 让这些（非当前激活的）会话继续把事件推过来（整体替换，最多 8 个）。 */
  SESSION_WATCH: 'session/watch',
  /** 只取某个会话的现状，不改变这台设备的绑定（回 session/state，带 rid、active:false）。 */
  SESSION_SNAPSHOT: 'session/snapshot',
  /** 回答一条 `approval/ask`（outcome 为 allowed-once / rejected）。 */
  APPROVAL_REPLY: 'approval/reply',
  /** 回答一条 `question/ask`（每个问题恰好一条答案）。 */
  QUESTION_REPLY: 'question/reply',
})

/** 电脑 → 客户端 的帧名。 */
export const SERVER_FRAME = Object.freeze({
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
  /** `session/list` 的回复：电脑上的会话列表。 */
  SESSIONS: 'sessions',
  /** `session/select` / `session/create` 的结果；成功后紧跟一条 `session/state`。 */
  SESSION_SELECTED: 'session/selected',
  /** 一条 DSH 权限请求，等待本设备作答。 */
  APPROVAL_ASK: 'approval/ask',
  /** 该权限请求已被处理（手机/电脑/超时）。 */
  APPROVAL_RESOLVED: 'approval/resolved',
  /** 一条结构化提问，等待本设备作答。 */
  QUESTION_ASK: 'question/ask',
  /** 该提问已被处理（手机/电脑/超时）。 */
  QUESTION_RESOLVED: 'question/resolved',
  UPLOAD_READY: 'upload/ready',
  UPLOAD_PROGRESS: 'upload/progress',
  UPLOAD_DONE: 'upload/done',
  UPLOAD_ERROR: 'upload/error',
  FILE_OFFERED: 'file/offered',
})

/** 连接方式。 */
export const CONNECTION_MODE = Object.freeze({
  AUTO: 'auto',
  LAN: 'lan',
  TAILSCALE: 'tailscale',
  TUNNEL: 'tunnel',
})

export const CONNECTION_MODES = Object.freeze(Object.values(CONNECTION_MODE))

/** 地址网络类型。 */
export const ENDPOINT_KIND = Object.freeze({
  LAN: 'lan',
  TAILSCALE: 'tailscale',
  TUNNEL: 'tunnel',
  LOOPBACK: 'loopback',
  UNKNOWN: 'unknown',
})

/** 二维码 `epk` 里的单字母编码。 */
export const ENDPOINT_KIND_CODE = Object.freeze({
  lan: 'l',
  tailscale: 't',
  tunnel: 'c',
  loopback: 'u',
  unknown: 'x',
})

/** 反向映射（解析 `epk` 用）。 */
export const ENDPOINT_CODE_KIND = Object.freeze({
  l: ENDPOINT_KIND.LAN,
  t: ENDPOINT_KIND.TAILSCALE,
  c: ENDPOINT_KIND.TUNNEL,
  u: ENDPOINT_KIND.LOOPBACK,
  x: ENDPOINT_KIND.UNKNOWN,
})

/** 电源请求拒绝原因。 */
export const POWER_REFUSAL = Object.freeze({
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
  NO_PRIVILEGE: 'no-privilege',
  DISABLED_BY_POLICY: 'disabled-by-policy',
  ALREADY_PENDING: 'already-pending',
  FAILED: 'failed',
})

/** 工具活动行类型。 */
export const ACTIVITY_KIND = Object.freeze({
  THINKING: 'thinking',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
})

/** 插件默认端口。 */
export const DEFAULT_PORT = 8787

/** 心跳默认间隔（ack 未带 heartbeatMs 时使用）。 */
export const DEFAULT_HEARTBEAT_MS = 25_000

/** 配对密钥有效期。 */
export const PAIR_SECRET_TTL_MS = 10 * 60 * 1000

/** 单帧助理回答上限。 */
export const MAX_ASSISTANT_CHARS = 24_000

/** 下载分块大小。 */
export const FILE_CHUNK_BYTES = 256 * 1024

/** 单文件下载上限。 */
export const MAX_FILE_BYTES = 512 * 1024 * 1024

/** 上传分块大小。 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024

/** 单附件上传上限。 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** 每条消息附件数上限。 */
export const MAX_UPLOAD_ATTACHMENTS = 8

/** 上传空闲清理时间（服务端行为，客户端只用于提示）。 */
export const UPLOAD_IDLE_TIMEOUT_MS = 3 * 60 * 1000

/** 电脑端消息幂等窗口。 */
export const DEDUPE_TTL_MS = 30 * 60 * 1000

export const DEDUPE_MAX_ENTRIES = 2048

/** 会话事件日志容量。 */
export const SESSION_EVENT_LOG_LIMIT = 400

/** 快照消息条数。 */
export const SESSION_SNAPSHOT_LIMIT = 60

/** 一次 `sessions` 帧最多列出多少个会话（电脑端截断后带 `truncated`）。 */
export const SESSION_LIST_LIMIT = 200

/**
 * 电脑端等手机回答审批的最长时间。超时后电脑把请求交回桌面 UI，
 * 并给手机补一条 `approval/resolved {outcome:'cancelled', source:'timeout'}`。
 * 客户端只用来做倒计时文案，真正的裁决在电脑端。
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/** 电脑端等手机回答阻塞式提问（ask()）的时长（比审批略长：多题、多选项、要打字）。 */
export const QUESTION_TIMEOUT_MS = 90_000

/** askTimed() 的提问用更短的窗口（必须小于调用方超时），否则桌面拿到的是过期等待。 */
export const QUESTION_TIMED_TIMEOUT_MS = 30_000

/** 超时后电脑端仍接受补答的窗口（DSH 的 askTimed / continued question）。 */
export const QUESTION_LATE_WINDOW_MS = 5 * 60_000

/** 一批提问的条目/选项/文本上限，与 protocol 保持一致。 */
export const QUESTION_MAX_ITEMS = 10
export const QUESTION_MAX_OPTIONS = 20
export const QUESTION_MAX_TEXT = 2_000

/** `approval/reply` 唯一允许的两种结果；其它值电脑端按 `rejected` 处理。 */
export const APPROVAL_REPLY_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'delegate'])

/**
 * 一台设备除当前会话外还能保持多少个后台会话（`session/watch` 上限）。
 * 标签条实际就开几个，这个上限只是防止一个坏掉的客户端把电脑端所有会话都订阅一遍。
 */
export const SESSION_WATCH_LIMIT = 8

/** 网页版客户端在插件上的路径。 */
export const WEB_CLIENT_PATH = '/openwhale/app'

/** 一次性下载路由。 */
export const DOWNLOAD_PATH = '/openwhale/download'

/** WebSocket 路径（与 gateway.mjs 的 WS_PATH 一致，protocol 源文件不导出它）。 */
export const WS_PATH = '/openwhale/ws'

/** 健康检查路径（手动地址预检用）。 */
export const HEALTH_PATH = '/openwhale/health'

/**
 * 小附件走 inline base64 的上限。超过就走 upload/* 分块上传：
 * 2 MiB 是 v2.2.0 的任务约定，base64 后约 2.7 MiB，仍在隧道/代理的单帧预算内。
 */
export const INLINE_ATTACHMENT_LIMIT = 2 * 1024 * 1024

/**
 * 客户端在 hello 里签名的字符串。与 protocol 的 `helloSignatureMessage` 逐字一致。
 * @param {string} nonce
 * @returns {string}
 */
export function helloSignatureMessage(nonce) {
  return `openwhale-hello:${nonce}`
}

/**
 * 电脑在 hello/ack 里签名的字符串。与 protocol 的 `helloAckProofMessage` 逐字一致。
 * @param {string} nonce
 * @param {string} deviceId
 * @returns {string}
 */
export function helloAckProofMessage(nonce, deviceId) {
  return `openwhale-hello-ack:${nonce}:${deviceId}`
}

/**
 * 指纹显示格式：大写、每 4 位一组，最多 16 组。
 * @param {string} hex
 * @returns {string}
 */
export function formatFingerprint(hex) {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const groups = clean.match(/.{1,4}/g) ?? []
  return groups.slice(0, 16).join(' ')
}

/**
 * 超长回答截断（与服务端同款，客户端兜底防御）。
 * @param {string} text
 * @param {number} [limit]
 * @returns {{text: string, truncated: boolean}}
 */
export function clampAssistantText(text, limit = MAX_ASSISTANT_CHARS) {
  if (text.length <= limit) return { text, truncated: false }
  let cut = limit
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return { text: `${text.slice(0, cut)}\n\n…（内容过长，已截断；完整内容可在电脑上查看）`, truncated: true }
}
