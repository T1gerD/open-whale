// 配对（扫码绑定）与握手判定的纯逻辑。
//
// 所有校验都委托给注入的 protocol 函数（`parsePairingPayload` / `pickEndpoint`），
// 这样这里能保持零依赖，同时测试可以传入**真实的** protocol 实现，
// 不会出现“镜像实现和协议不一致”的漂移。

import { normalizeEndpoint, normalizeEndpoints, wsUrlFor } from './endpoint.mts'
import type { ParsedEndpoint } from './endpoint.mts'
import { DEFAULT_HEARTBEAT_MS, PROTOCOL_VERSION } from './frames.mts'
import { isValidDeviceId, DEVICE_ID_RE } from './keys.mts'

/** 二维码载荷，字段以 protocol 的 `QrPairingPayload` typedef 为准。 */
export interface PairingPayload {
  v: 1
  p: 'openwhale'
  host: string
  id: string
  fp: string
  secret: string
  expires: string
  endpoints: string[]
  /** 与 endpoints 一一对应的单字母网络类型（l/t/c/u/x，2.2.0 新增）。 */
  epk?: string[]
  /** 网页版/PWA 客户端地址（鸿蒙/iOS/任意浏览器）。 */
  web?: string
  /** 生成这份载荷时电脑端使用的连接方式（auto/lan/tailscale/tunnel）。 */
  mode?: string
  port?: string | number
  lan?: string
  name?: string
  version?: string
}

/** 注入的 protocol 工具集（App 传真实实现，测试传相对路径 import 的真实实现）。 */
export interface PairingDeps {
  parsePairingPayload(
    value: unknown,
    options?: { now?: number },
  ): { ok: true; payload: PairingPayload } | { ok: false; error: string }
  pickEndpoint(endpoints: string[], preferred?: string): string | undefined
}

/** 手机侧持久化的“助理”记录：一台电脑一条。 */
export interface AssistantRecord {
  /** 主键，等于电脑 id。 */
  id: string
  computerId: string
  name: string
  fingerprint: string
  endpoints: string[]
  preferredEndpoint?: string
  lan?: string
  /** 本机设备 id，私钥在 SecureStore 里按它分区。 */
  deviceId: string
  deviceName: string
  pairedAt: string
  lastConnectedAt?: string
  online: boolean
  /** 电脑端通过 `assistants` 帧告知允许的电源操作。 */
  powerAllowed: string[]
  serverVersion?: string
  /** 可选的唤醒代理地址（本地设置，不属于 wire protocol）。 */
  wakeProxyUrl?: string
  /**
   * 连接方式偏好（auto/lan/tailscale/tunnel），持久化在助理记录里。
   * 二维码里带了 `mode` 时以它作为初始值，否则 auto。
   */
  connectionMode?: string
  /** 当前会话 id（协作模式切换会变）；hello 时带上去做断点续传。 */
  sessionId?: string
  /** 会话纪元：每次切换 +1，切换回同一个 sessionId 也能被发现。 */
  sessionEpoch?: number
  /** 已应用到的会话事件序号（session/events 的 cursor）。 */
  sessionCursor?: number
}

export interface PairingValidated {
  ok: true
  payload: PairingPayload
  /** 规范化并可用的地址；空表示二维码里的地址都不可用。 */
  endpoints: string[]
}

export interface PairingRejected {
  ok: false
  error: string
}

/**
 * 校验二维码内容。
 * 在 protocol 校验之外补两件事：
 *  1. 地址规范化（protocol 的校验允许数组里混入非字符串项）；
 *  2. 地址必须至少剩一个可用项，否则给出可操作的中文提示。
 */
export function validatePairingQr(
  raw: unknown,
  deps: PairingDeps,
  now: number = Date.now(),
): PairingValidated | PairingRejected {
  const parsed = deps.parsePairingPayload(raw, { now })
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const endpoints = normalizeEndpoints(parsed.payload.endpoints)
  if (endpoints.length === 0) {
    return { ok: false, error: '二维码里的地址都不可用，请在电脑上重新生成二维码' }
  }
  return { ok: true, payload: parsed.payload, endpoints }
}

/** 把校验结果落成一条助理记录（还没连接，所以 online=false）。 */
export function buildAssistantFromPairing(
  input: { payload: PairingPayload; endpoints: string[]; deviceId: string; deviceName: string; now?: number },
): AssistantRecord {
  if (!isValidDeviceId(input.deviceId)) throw new Error(`deviceId 不合法：${input.deviceId}`)
  const now = input.now ?? Date.now()
  const endpoints = input.endpoints.length > 0 ? input.endpoints : normalizeEndpoints(input.payload.endpoints)
  return {
    id: input.payload.id,
    computerId: input.payload.id,
    name: input.payload.name?.trim() || input.payload.host,
    fingerprint: input.payload.fp,
    endpoints,
    preferredEndpoint: endpoints[0],
    lan: normalizeEndpoint(input.payload.lan),
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    pairedAt: new Date(now).toISOString(),
    lastConnectedAt: undefined,
    online: false,
    // 首次配对时不知道电脑端的策略，先按最保守的“都允许”，由 `assistants` 帧纠正。
    powerAllowed: ['shutdown', 'restart', 'cancel'],
    serverVersion: input.payload.version,
    wakeProxyUrl: undefined,
    // 二维码里带了电脑端生成时的连接方式就沿用它，否则自动。
    connectionMode: normalizeConnectionModeInput(input.payload.mode),
    sessionId: undefined,
    sessionEpoch: undefined,
    sessionCursor: 0,
  }
}

/** 二维码里的 mode 只接受四个合法值；其余（含老插件缺省）一律 auto。 */
function normalizeConnectionModeInput(mode: unknown): string {
  return mode === 'lan' || mode === 'tailscale' || mode === 'tunnel' ? mode : 'auto'
}

/** `hello/ack` 里我们真正要用的字段（其余字段宽容忽略）。 */
export interface HelloAckLike {
  t?: string
  /** 协议版本（2.2.0 仍是 '1.1.0'，由 protocol 的 PROTOCOL_VERSION 决定）。 */
  version?: string
  /** 插件版本（例如 '2.2.0'）；只用于展示，缺失时回退 version。 */
  serverVersion?: string
  computerId?: string
  computerName?: string
  computerFingerprint?: string
  paired?: boolean
  pairAccepted?: boolean
  nonce?: string
  proof?: string
  heartbeatMs?: number
  serverTime?: string
  endpoints?: unknown
  /** 电脑端声明的能力（2.2.0 新增）。 */
  capabilities?: unknown
  /** 当前会话 id；协作模式切换会变。 */
  sessionId?: string
  /** 会话纪元：每次切换 +1。 */
  sessionEpoch?: number
  /** 电脑端事件日志的最大 seq（0 = 没有日志，只能拿快照）。 */
  eventCursor?: number
  /** 协作模式当前是否开启。 */
  collaboration?: boolean
  /** 电脑端当前使用的连接方式（展示用）。 */
  connectionMode?: string
  /** 带网络类型的地址列表（2.2.0 新增）。 */
  endpointList?: unknown
}

export type HelloAckOutcome =
  | {
      ok: true
      /** 电脑端指定的心跳周期（已做合理范围收敛）。 */
      heartbeatMs: number
      serverTime?: string
      /** 电脑端本次通告的地址（可能与库里不同，需并集更新）。 */
      endpoints: string[]
      /** 电脑端理解的能力（缺省 = 没有能力，按老协议降级）。 */
      capabilities: string[]
      /** 当前会话信息（会随协作模式切换）。 */
      sessionId?: string
      sessionEpoch?: number
      eventCursor?: number
      collaboration?: boolean
      connectionMode?: string
      patch: Partial<AssistantRecord>
    }
  | { ok: false; code: 'bad-ack' | 'not-paired' | 'pairing-refused' | 'wrong-computer' | 'fingerprint-mismatch' | 'not-authenticated-ack'; message: string }

/** 指纹统一成小写十六进制再比较，容忍分组空格/大写。 */
export function normalizeFingerprint(value: unknown): string {
  return String(value ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
}

/**
 * 判定 `hello/ack`。
 * 指纹比对是这里唯一真正有安全价值的一步：二维码里的 `fp` 是电脑长期公钥的
 * SHA-256，任何人换了隧道地址后都必须拿出同一个公钥才能通过。
 * 注意：protocol 的 `hello/ack.proof` 理论上能证明电脑身份，但二维码里只有指纹、
 * 没有电脑公钥，手机端无法验签——这一点已在 README 的“已知限制”里写明。
 */
export function interpretHelloAck(
  ack: HelloAckLike,
  expected: { computerId: string; fingerprint: string; pairing: boolean },
  now: number = Date.now(),
): HelloAckOutcome {
  if (!ack || typeof ack !== 'object' || ack.t !== 'hello/ack') {
    return { ok: false, code: 'bad-ack', message: '电脑端返回的握手响应无法识别' }
  }
  const computerId = typeof ack.computerId === 'string' ? ack.computerId : ''
  if (!computerId) return { ok: false, code: 'bad-ack', message: '电脑端没有返回电脑 ID' }
  if (expected.computerId && computerId !== expected.computerId) {
    return {
      ok: false,
      code: 'wrong-computer',
      message: '连上的电脑与二维码不是同一台，请在电脑上重新生成二维码',
    }
  }
  const ackFp = normalizeFingerprint(ack.computerFingerprint)
  const wantFp = normalizeFingerprint(expected.fingerprint)
  if (ackFp && wantFp && ackFp !== wantFp) {
    return {
      ok: false,
      code: 'fingerprint-mismatch',
      message: '电脑公钥指纹与绑定记录不一致，连接可能被中间人替换，已断开',
    }
  }
  if (ack.paired === false) {
    return { ok: false, code: 'not-paired', message: '电脑端不认为这台手机已绑定，请重新扫码绑定' }
  }
  if (expected.pairing && ack.pairAccepted !== true) {
    return { ok: false, code: 'pairing-refused', message: '电脑端拒绝了本次绑定，请重新生成二维码后再扫' }
  }
  // 电脑端可能通告新的隧道/局域网地址；与库里做并集，保留用户上次成功的地址。
  // 2.2.0 的 `endpointList` 带网络类型，但地址本身就是唯一键，这里只取 url。
  const endpointListUrls = Array.isArray(ack.endpointList)
    ? ack.endpointList
        .map(item => (item && typeof item === 'object' ? (item as { url?: unknown }).url : item))
        .filter(url => typeof url === 'string')
    : []
  const endpoints = normalizeEndpoints([...endpointListUrls, ...(Array.isArray(ack.endpoints) ? ack.endpoints : [])])
  const heartbeatMs = clampHeartbeat(ack.heartbeatMs)
  const capabilities = Array.isArray(ack.capabilities)
    ? ack.capabilities.filter((item): item is string => typeof item === 'string')
    : []
  const sessionId = typeof ack.sessionId === 'string' && ack.sessionId !== '' ? ack.sessionId : undefined
  const sessionEpoch = typeof ack.sessionEpoch === 'number' && Number.isFinite(ack.sessionEpoch) ? ack.sessionEpoch : undefined
  const eventCursor = typeof ack.eventCursor === 'number' && Number.isFinite(ack.eventCursor) ? Math.max(0, Math.floor(ack.eventCursor)) : undefined
  return {
    ok: true,
    heartbeatMs,
    serverTime: typeof ack.serverTime === 'string' ? ack.serverTime : undefined,
    endpoints,
    capabilities,
    sessionId,
    sessionEpoch,
    eventCursor,
    collaboration: typeof ack.collaboration === 'boolean' ? ack.collaboration : undefined,
    connectionMode: typeof ack.connectionMode === 'string' ? ack.connectionMode : undefined,
    patch: {
      online: true,
      lastConnectedAt: new Date(now).toISOString(),
      fingerprint: typeof ack.computerFingerprint === 'string' ? ack.computerFingerprint : expected.fingerprint,
      // 展示用版本号：ack.serverVersion 是插件版本（2.2.0），ack.version 是协议版本（1.1.0）。
      serverVersion:
        (typeof ack.serverVersion === 'string' && ack.serverVersion) ||
        (typeof ack.version === 'string' ? ack.version : undefined),
      ...(endpoints.length > 0 ? { endpoints } : {}),
    },
  }
}

/** 心跳周期做范围收敛：太小会空耗电，太大则断线发现太慢。 */
export function clampHeartbeat(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_HEARTBEAT_MS
  // 电脑端是权威值，但如果它算错了（比如 200ms），手机这边必须兜住。
  return Math.min(Math.max(Math.round(numeric), 5_000), 120_000)
}

export interface HelloInput {
  deviceId: string
  deviceName: string
  /** base64url 的 SPKI DER 公钥。 */
  devicePublicKey: string
  /** 客户端自选的随机 nonce（protocol 的 HelloFrame.nonce）。 */
  nonce: string
  /** 仅首次绑定携带。 */
  pairSecret?: string
  /** 已知设备时对 `helloSignatureMessage()` 的签名（base64url）。 */
  signature?: string
  protocolVersion?: string
  /** 本 build 理解的能力（2.2.0）；不传就不带该字段，电脑端按老端处理。 */
  capabilities?: string[]
  /** 已应用到的会话事件序号（断点续传）；0/缺省表示要快照。 */
  cursor?: number
  /** 客户端认为自己在的会话 id（用于发现协作模式切换）。 */
  sessionId?: string
}

export interface HelloFrame {
  t: 'hello'
  version: string
  deviceId: string
  deviceName: string
  devicePublicKey: string
  nonce: string
  pairSecret?: string
  signature?: string
  capabilities?: string[]
  cursor?: number
  sessionId?: string
}

/**
 * 组装 `hello` 帧。
 * `signature` 不在 protocol 的 HelloFrame typedef 里，但电脑端 `gateway.mjs`
 * 对**已绑定设备**要求它（`openwhale-hello:<nonce>`）。我们照发，理由写在
 * `helloSignatureMessage` 的注释与 README 的“跨包不一致”一节。
 */
export function buildHelloFrame(input: HelloInput): HelloFrame {
  if (!isValidDeviceId(input.deviceId)) {
    throw new Error(`deviceId 必须是 ${DEVICE_ID_RE} 的形状，收到：${input.deviceId}`)
  }
  if (!input.devicePublicKey) throw new Error('缺少 devicePublicKey')
  const frame: HelloFrame = {
    t: 'hello',
    version: input.protocolVersion ?? PROTOCOL_VERSION,
    deviceId: input.deviceId,
    deviceName: input.deviceName || '手机',
    devicePublicKey: input.devicePublicKey,
    nonce: input.nonce,
  }
  if (input.pairSecret) frame.pairSecret = input.pairSecret
  if (input.signature) frame.signature = input.signature
  // 能力/游标/会话只在有值时带：老电脑端不认识它们也没关系（协议只增不改）。
  const capabilities = Array.isArray(input.capabilities) ? input.capabilities.filter(item => typeof item === 'string' && item !== '') : []
  if (capabilities.length > 0) frame.capabilities = capabilities
  if (typeof input.cursor === 'number' && Number.isFinite(input.cursor) && input.cursor > 0) {
    frame.cursor = Math.max(0, Math.floor(input.cursor))
  }
  if (typeof input.sessionId === 'string' && input.sessionId !== '') frame.sessionId = input.sessionId
  return frame
}

/**
 * 被签名的字符串。
 *
 * ⚠️ 跨包不一致（未修改协议，只记录）：电脑端算的是
 * `openwhale-hello:${session.nonce}`，而 `session.nonce` 是**服务端**在连接建立时
 * 生成的，并且在认证成功后的 `hello/ack` 里才发给手机——手机在发 `hello` 时根本
 * 拿不到它，所以按当前电脑端实现，已绑定设备无法通过签名校验。
 * 这里默认签手机自己的 nonce（与 protocol typedef 的语义一致，也是把
 * `session.nonce` 换成 `frame.nonce` 那一行修复后正确的行为）；一旦电脑端在握手前
 * 下发挑战值，把 `serverNonce` 传进来即可，客户端无需改协议。
 */
export function helloSignatureMessage(nonce: string, serverNonce?: string): string {
  return `openwhale-hello:${serverNonce ?? nonce}`
}

/** 握手期服务器错误的可操作提示（code 来自 `error` 帧）。 */
export function handshakeErrorHint(code: unknown, message?: string): string {
  const fallback = typeof message === 'string' && message ? message : '握手失败'
  switch (String(code)) {
    case 'bad-signature':
      // 这是当前已知的跨包不一致最可能的表现，必须给出可执行的下一步。
      return '设备密钥校验失败：电脑端无法验证本机签名（已知的挑战值顺序问题）。需要在电脑上解除绑定后重新扫码。'
    case 'pairing-required':
      return '这台手机还没绑定该电脑，请扫描电脑上显示的二维码'
    case 'pairing-rejected':
    case 'already-paired':
      return fallback
    case 'not-authenticated':
      return '握手顺序被拒绝，请稍后重试'
    case 'handshake-timeout':
      return '电脑端等待握手超时，请检查手机与电脑是否在同一网络'
    case 'internal':
      return `电脑端处理失败：${fallback}`
    default:
      return fallback
  }
}

/** 给“手动粘贴二维码内容”入口用：从任意文本里抠出 JSON 对象。 */
export function extractJsonObject(text: string): unknown {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return undefined
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export { normalizeEndpoints, normalizeEndpoint, wsUrlFor }
export type { ParsedEndpoint }
