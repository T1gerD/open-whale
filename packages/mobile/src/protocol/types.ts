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
  /** 与 endpoints 一一对应的单字母网络类型（2.2.0）。 */
  epk?: string[]
  /** 网页版/PWA 客户端地址。 */
  web?: string
  /** 生成这份载荷时的连接方式。 */
  mode?: string
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
  /** 本 build 理解的能力（2.2.0）。 */
  capabilities?: string[]
  /** 已应用到的会话事件序号（断点续传）。 */
  cursor?: number
  /** 客户端认为自己在的会话 id（检测电脑端换了绑定会话）。 */
  sessionId?: string
}

export interface HelloAckFrame {
  t: 'hello/ack'
  /** 协议版本（2.3.0 是 '1.2.0'）。 */
  version: string
  /** 插件版本（例如 '2.3.0'）；展示用，缺失时回退 version。 */
  serverVersion?: string
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
  /** 电脑端理解的能力。 */
  capabilities?: string[]
  /** 当前会话 id / 纪元（会话选择器切换时会变）。 */
  sessionId?: string
  sessionEpoch?: number
  /** 电脑端事件日志最大 seq（0 = 只能用快照）。 */
  eventCursor?: number
  connectionMode?: string
  /** 带网络类型的地址列表（2.2.0）。 */
  endpointList?: Array<{ url: string; kind?: string }>
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

export interface ChatSendFile {
  /** 新路径：先分块上传，消息里只放 uploadId。 */
  uploadId?: string
  name: string
  mime?: string
  size?: number
  /** 老路径：内联 base64（仅小文件、且电脑端没有 upload-v1）。 */
  dataBase64?: string
}

export interface ChatSendFrame {
  t: 'chat/send'
  rid: string
  /** 幂等键（v2.2.0）；老电脑端缺省回落到 rid/callId。 */
  msgId?: string
  /** 电脑端优先取 callId，取不到才回落到 rid；两个都发最稳。 */
  callId: string
  text: string
  files?: ChatSendFile[]
}

export interface ChatCancelFrame {
  t: 'chat/cancel'
  callId: string
}

export interface ChatAckFrame {
  t: 'chat/ack'
  rid?: string
  /** 幂等键回显（v2.2.0）。 */
  msgId?: string
  callId?: string
  cancelled?: boolean
  /** 电脑端判重命中（同一 msgId 重发），正常视为 sent。 */
  duplicate?: boolean
}

export interface ChatDeltaFrame {
  t: 'chat/delta'
  callId: string
  seq: number
  text: string
  /** 有 chat-message-v1 能力时可能带。 */
  messageId?: string
}

export interface ChatDoneFrame {
  t: 'chat/done'
  callId: string
  text: string
  durationMs?: number
  truncated?: boolean
  files?: Array<{ fileId: string; name: string; size: number; mime?: string }>
  seq?: number
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
  seq?: number
}

export interface TypingFrame {
  t: 'chat/typing'
  callId: string
  active?: boolean
}

export interface ChatEchoFile {
  fileId: string
  name: string
  size: number
  mime?: string
}

/** 会话内任意设备发出的用户消息（广播给所有设备，含发送者）。 */
export interface ChatEchoFrame {
  t: 'chat/echo'
  msgId: string
  rid?: string
  callId?: string
  deviceId: string
  /**
   * 老协议里是发送者昵称。2.3.0 删掉了协作与昵称，手机端**不再读取/显示**它；
   * 字段留着只为镜像冻结的 protocol typedef（对端可能还带）。
   */
  speaker?: string
  text: string
  files?: ChatEchoFile[]
  at: string
  seq?: number
}

/** 一条助手消息，按 messageId 全文替换（修「回复重复拼接」）。 */
export interface ChatMessageFrame {
  t: 'chat/message'
  callId: string
  messageId: string
  index: number
  text: string
  seq?: number
}

export interface SessionSnapshotMessage {
  id: string
  kind: 'user' | 'assistant'
  text: string
  at: string
  callId?: string
  msgId?: string
  files?: ChatEchoFile[]
}

/** 会话快照（首次连接 / 会话切换 / 游标失效）。 */
export interface SessionStateFrame {
  t: 'session/state'
  sessionId: string
  /** 会话标题（会话选择器也显示它）。 */
  title?: string
  sessionEpoch: number
  head: number
  snapshot: {
    messages: SessionSnapshotMessage[]
    activeCall?: { callId: string; text: string; typing: boolean }
  }
}

/** 断线追赶：seq > cursor 的持久事件回放。 */
export interface SessionEventsFrame {
  t: 'session/events'
  sessionId: string
  from: number
  head: number
  events: Array<ChatEchoFrame | ChatMessageFrame | ChatDoneFrame | FileOfferFrame | ChatToolFrame>
}

export interface ChatToolFrame {
  t: 'chat/tool'
  callId: string
  phase: 'tool-start' | 'tool-end'
  toolCallId: string
  tool: string
  summary?: string
  ok?: boolean
  seq?: number
}

/** 电脑上的一个 DSH 会话（会话选择器的一行）。 */
export interface SessionSummary {
  id: string
  /** 日志里的标题；没有标题时电脑端给「新会话」这类兜底文案。 */
  title: string
  cwd?: string
  /** Unix 毫秒。 */
  createdAt: number
  /** Unix 毫秒；电脑端拿不到时省略。 */
  updatedAt?: number
  /** 电脑上现在有 agent 在跑。 */
  live: boolean
  /** 这台手机当前绑定的那个会话。 */
  current?: boolean
}

/** `session/list` 的回复。 */
export interface SessionsFrame {
  t: 'sessions'
  rid?: string
  current?: string
  sessions: SessionSummary[]
  truncated?: boolean
}

/** `session/select` / `session/create` 的结果；成功后紧跟一条 `session/state`。 */
export interface SessionSelectedFrame {
  t: 'session/selected'
  rid?: string
  ok: boolean
  sessionId?: string
  title?: string
  sessionEpoch?: number
  error?: string
  message?: string
}

/** 一条转发到手机的 DSH 权限请求。 */
export interface ApprovalAskFrame {
  t: 'approval/ask'
  approvalId: string
  toolName: string
  /** 电脑端记录的机器原因。 */
  reason?: string
  /** 本地化文案（至少有 `en`）。 */
  displayReason?: { en: string; [locale: string]: string }
  callId?: string
  /** Unix 毫秒：到点电脑端把提示交回桌面。 */
  expiresAt: number
}

/** 那条请求已经被处理（手机/电脑/超时）。 */
export interface ApprovalResolvedFrame {
  t: 'approval/resolved'
  approvalId: string
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  source?: 'phone' | 'desktop' | 'timeout' | 'cancelled'
}

export interface SessionListFrame {
  t: 'session/list'
  rid: string
}

export interface SessionSelectFrame {
  t: 'session/select'
  rid: string
  sessionId: string
}

export interface SessionCreateFrame {
  t: 'session/create'
  rid: string
}

/** 手机对一条权限请求的答复（只允许这两种结果）。 */
export interface ApprovalReplyFrame {
  t: 'approval/reply'
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
}

export interface FileOfferFrame {
  t: 'file/offered'
  fileId: string
  name: string
  size: number
  mime?: string
  url?: string
  from?: string
  seq?: number
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

export interface SessionSyncFrame {
  t: 'session/sync'
  rid?: string
  cursor?: number
}

export interface UploadStartFrame {
  t: 'upload/start'
  uploadId: string
  name: string
  size: number
  mime?: string
  sha256?: string
}

export interface UploadChunkFrame {
  t: 'upload/chunk'
  uploadId: string
  seq: number
  dataBase64: string
}

export interface UploadEndFrame {
  t: 'upload/end'
  uploadId: string
  sha256?: string
}

export interface UploadCancelFrame {
  t: 'upload/cancel'
  uploadId: string
}

export interface UploadReadyFrame {
  t: 'upload/ready'
  uploadId: string
  chunkBytes: number
  maxBytes: number
}

export interface UploadProgressFrame {
  t: 'upload/progress'
  uploadId: string
  nextSeq: number
  received: number
}

export interface UploadDoneFrame {
  t: 'upload/done'
  uploadId: string
  fileId: string
  name: string
  size: number
  mime?: string
  path?: string
  sha256?: string
}

export interface UploadErrorFrame {
  t: 'upload/error'
  uploadId: string
  code: string
  message: string
}

export interface AssistantRenameFrame {
  t: 'assistant/rename'
  /** 电脑端读的是 `label`。 */
  label: string
}

export interface DeviceRenameFrame {
  t: 'device/rename'
  /** 我在这台电脑上的显示名（设置页的设备名）。 */
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
  | ChatEchoFrame
  | ChatMessageFrame
  | SessionStateFrame
  | SessionEventsFrame
  | SessionsFrame
  | SessionSelectedFrame
  | ApprovalAskFrame
  | ApprovalResolvedFrame
  | UploadReadyFrame
  | UploadProgressFrame
  | UploadDoneFrame
  | UploadErrorFrame
  | FileOfferFrame

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
  | SessionSyncFrame
  | SessionListFrame
  | SessionSelectFrame
  | SessionCreateFrame
  | ApprovalReplyFrame
  | UploadStartFrame
  | UploadChunkFrame
  | UploadEndFrame
  | UploadCancelFrame

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
  /** 当前地址的网络类型（lan/tailscale/tunnel/loopback/unknown）。 */
  endpointKind?: string
  /** 连续失败时已尝试过的地址（可操作文案里列出来）。 */
  triedEndpoints?: string[]
  /** 电脑端声明的能力（hello/ack 后才有）。 */
  capabilities?: string[]
  /** 当前会话信息。 */
  sessionId?: string
  sessionEpoch?: number
  /** 电脑端事件日志 head。 */
  eventCursor?: number
  /** 电脑端报告的连接方式偏好。 */
  serverConnectionMode?: string
}
