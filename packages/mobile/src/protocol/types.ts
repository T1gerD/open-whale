// 协议帧的类型定义。
//
// ⚠️ 这个文件**镜像**自 `packages/protocol/src/index.mjs`（以及电脑端 gateway.mjs 的
// 实际收发行为）。任何字段疑问、字段增删，一律以 protocol 的源码为准：
// 这里只是为了让 App 的 TS 代码有类型可写。运行期的取值入口是
// `src/protocol/runtime.ts`（它 import 真实的 `@openwhale/protocol`），帧名字面量则
// 只在 `src/core/frames.mts` 里镜像一份，由 `test/frames.test.mjs` 核对。

export interface QrPairingPayload {
  v: 1
  p: 'openwhale'
  host: string
  id: string
  fp: string
  secret: string
  expires: string
  endpoints: string[]
  port?: string | number
  lan?: string
  name?: string
  version?: string
}

export interface HelloFrame {
  t: 'hello'
  version: string
  deviceId: string
  deviceName: string
  devicePublicKey: string
  nonce?: string
  /** 仅首次绑定时携带。 */
  pairSecret?: string
  /**
   * 设备私钥对 `openwhale-hello:<nonce>` 的签名（base64url）。
   * protocol 的 HelloFrame typedef 里没有这个字段，但电脑端 gateway.mjs 对
   * 已绑定设备要求它——细节与不一致见 src/core/pairing.mts 的注释。
   */
  signature?: string
}

export interface HelloAckFrame {
  t: 'hello/ack'
  version: string
  computerId: string
  computerName: string
  computerFingerprint: string
  paired: boolean
  pairAccepted: boolean
  nonce?: string
  proof?: string
  heartbeatMs?: number
  serverTime?: string
  /** 电脑端在握手响应里附带的可用地址（gateway.mjs 会带）。 */
  endpoints?: string[]
}

export interface ErrorFrame {
  t: 'error'
  code: string
  message: string
  [key: string]: unknown
}

export interface PongFrame {
  t: 'pong'
  time?: string
}

export interface AssistantsFrame {
  t: 'assistants'
  assistants?: Array<{ id: string; name: string; fingerprint: string; online?: boolean; pairedAt?: string }>
  /** 电脑端告知允许哪些电源操作。 */
  power?: { allowed?: string[] }
  unbound?: boolean
}

export interface ChatSendFrame {
  t: 'chat/send'
  rid: string
  /** 电脑端优先取 callId，取不到才回落到 rid；两个都发最稳。 */
  callId: string
  text: string
  files?: Array<{ name: string; mime: string; dataBase64: string }>
}

export interface ChatCancelFrame {
  t: 'chat/cancel'
  callId: string
}

export interface ChatAckFrame {
  t: 'chat/ack'
  rid?: string
  callId?: string
  cancelled?: boolean
}

export interface ChatDeltaFrame {
  t: 'chat/delta'
  callId: string
  seq: number
  text: string
}

export interface ChatDoneFrame {
  t: 'chat/done'
  callId: string
  text: string
  durationMs?: number
  truncated?: boolean
  files?: Array<{ fileId: string; name: string; size: number; mime?: string }>
}

export interface ChatErrorFrame {
  t: 'chat/error'
  callId?: string
  message: string
  retryable?: boolean
}

export interface ToolFrame {
  t: 'chat/tool'
  callId: string
  phase: 'tool-start' | 'tool-end'
  toolCallId: string
  tool: string
  summary?: string
  ok?: boolean
}

export interface TypingFrame {
  t: 'chat/typing'
  callId: string
  active?: boolean
}

export interface FileMetaFrame {
  t: 'file/meta'
  fileId: string
  name: string
  size: number
  mime?: string
  sha256?: string
  /** 电脑端附加的 HTTP 一次性下载路径（相对 endpoint）。 */
  downloadPath?: string
}

export interface FileChunkFrame {
  t: 'file/chunk'
  fileId: string
  seq: number
  dataBase64: string
}

export interface FileEndFrame {
  t: 'file/end'
  fileId: string
  seq?: number
}

export interface FileErrorFrame {
  t: 'file/error'
  fileId: string
  code?: string
  message?: string
}

export interface FileFetchFrame {
  t: 'file/fetch'
  fileId: string
}

export interface FileCancelFrame {
  t: 'file/cancel'
  fileId: string
}

export interface AssistantRenameFrame {
  t: 'assistant/rename'
  /** 电脑端读的是 `label`。 */
  label: string
}

export interface DeviceRenameFrame {
  t: 'device/rename'
  /** 我在这台电脑上的昵称；多人协作时消息前缀用它。 */
  label: string
}

export interface DeviceForgetFrame {
  t: 'device/forget'
  deviceId: string
}

export interface PowerRequestFrame {
  t: 'power/request'
  rid: string
  action: 'shutdown' | 'restart' | 'cancel' | 'wake'
  delaySeconds?: number
}

export interface PowerStateFrame {
  t: 'power/state'
  rid: string
  action: 'shutdown' | 'restart' | 'cancel' | 'wake'
  accepted: boolean
  delaySeconds?: number
  cancelToken?: string
  reason?: string
  message?: string
}

export interface PingFrame {
  t: 'ping'
}

/** 电脑端可能发的所有帧。未知帧一律忽略（协议要求）。 */
export type ServerFrame =
  | HelloAckFrame
  | ErrorFrame
  | PongFrame
  | AssistantsFrame
  | ChatAckFrame
  | ChatDeltaFrame
  | ChatDoneFrame
  | ChatErrorFrame
  | ToolFrame
  | TypingFrame
  | FileMetaFrame
  | FileChunkFrame
  | FileEndFrame
  | FileErrorFrame
  | PowerStateFrame

/** 手机端会发的所有帧。 */
export type ClientFrame =
  | HelloFrame
  | PingFrame
  | ChatSendFrame
  | ChatCancelFrame
  | FileFetchFrame
  | FileCancelFrame
  | AssistantRenameFrame
  | DeviceRenameFrame
  | DeviceForgetFrame
  | PowerRequestFrame

/** 连接状态（UI 直接渲染）。 */
export type LinkStatus = 'idle' | 'connecting' | 'handshaking' | 'online' | 'reconnecting' | 'offline' | 'failed'

export interface LinkSnapshot {
  status: LinkStatus
  endpoint?: string
  attempt: number
  online: boolean
  heartbeatMs: number
  lastError?: string
  /** 电脑端在 hello/ack 里报的版本，便于排查。 */
  serverVersion?: string
  connectedAt?: number
  /** 致命错误（例如签名校验失败）：自动重连已停止，需要用户操作。 */
  fatal?: boolean
  /** 用户可执行的下一步（中文）。 */
  hint?: string
}
