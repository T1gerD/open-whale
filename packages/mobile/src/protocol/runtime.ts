// 真实 protocol 实现的唯一入口。
//
// App 里**不允许**别的地方 import '@openwhale/protocol'：跨包导入在 Metro 里需要
// metro.config.js 的 alias（已配好），集中在这里的好处是——协议改名时只需要改一处，
// 而且启动期就能断言“镜像常量 == 协议常量”，把静默失联变成一次明确崩溃。
//
// 例外：`src/core/endpoint.mts` 直接用相对路径 import 协议源码。原因是协议的分类/排序
// 函数是同步纯函数、必须零依赖可测（node --test 不装 node_modules），而 v2.1.0 自己写的
// 那套网段判断漏掉了 Tailscale 的 100.64/10 —— 不允许再出现第二份实现。

import * as protocol from '@openwhale/protocol'

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  CLIENT_FRAME,
  CONNECTION_MODE,
  DEFAULT_PORT as MIRROR_DEFAULT_PORT,
  ENDPOINT_KIND,
  PROTOCOL_VERSION as MIRROR_PROTOCOL_VERSION,
  SERVER_FRAME,
  UPLOAD_CHUNK_BYTES as MIRROR_UPLOAD_CHUNK_BYTES,
} from '../core/frames.mts'
import type { PairingDeps, PairingPayload } from '../core/pairing.mts'
import type { QrPairingPayload } from './types'

/** 协议版本 / 上限常量：直接取协议的值，不镜像，避免两处维护。 */
export const PROTOCOL_VERSION: string = protocol.PROTOCOL_VERSION
export const DEFAULT_HEARTBEAT_MS: number = protocol.DEFAULT_HEARTBEAT_MS
export const MAX_ASSISTANT_CHARS: number = protocol.MAX_ASSISTANT_CHARS
export const FILE_CHUNK_BYTES: number = protocol.FILE_CHUNK_BYTES
export const MAX_FILE_BYTES: number = protocol.MAX_FILE_BYTES
export const PAIR_SECRET_TTL_MS: number = protocol.PAIR_SECRET_TTL_MS
export const DEFAULT_PORT: number = protocol.DEFAULT_PORT
export const UPLOAD_CHUNK_BYTES: number = protocol.UPLOAD_CHUNK_BYTES
export const MAX_UPLOAD_BYTES: number = protocol.MAX_UPLOAD_BYTES
export const MAX_UPLOAD_ATTACHMENTS: number = protocol.MAX_UPLOAD_ATTACHMENTS
export const UPLOAD_IDLE_TIMEOUT_MS: number = protocol.UPLOAD_IDLE_TIMEOUT_MS
export const DEDUPE_TTL_MS: number = protocol.DEDUPE_TTL_MS

export const POWER_REFUSAL = protocol.POWER_REFUSAL as Record<string, string>
export const ACTIVITY_KIND = protocol.ACTIVITY_KIND as Record<string, string>
export const CONNECTION_MODES = protocol.CONNECTION_MODES as readonly string[]
export const ENDPOINT_KINDS = protocol.ENDPOINT_KIND as Record<string, string>
export const PROTOCOL_CAPABILITIES = protocol.ALL_CAPABILITIES as readonly string[]

/** 与电脑端 gateway.mjs 的 WS_PATH 一致。 */
export const WS_PATH = '/openwhale/ws'

export type ParsePairingResult =
  | { ok: true; payload: QrPairingPayload }
  | { ok: false; error: string }

export function parsePairingPayload(value: unknown, options?: { now?: number }): ParsePairingResult {
  // protocol 是 .mjs + JSDoc，这里显式收窄成 App 侧的类型（结构一致）。
  return protocol.parsePairingPayload(value, options) as ParsePairingResult
}

export function pickEndpoint(endpoints: string[], preferred?: string): string | undefined {
  return protocol.pickEndpoint(endpoints, preferred)
}

/** 按连接方式排序后的地址（带网络类型）；电脑端没声明 epk 时协议会自己分类。 */
export function orderEndpointCandidates(
  endpoints: string[],
  options: { mode?: string; preferred?: string; allowLoopback?: boolean } = {},
): Array<{ url: string; kind: string }> {
  return protocol.orderEndpointCandidates(endpoints, options) as Array<{ url: string; kind: string }>
}

export function orderEndpoints(
  endpoints: string[],
  options: { mode?: string; preferred?: string; allowLoopback?: boolean } = {},
): string[] {
  return protocol.orderEndpoints(endpoints, options) as string[]
}

/** 图片/文件附件的上传上限（服务层与服务端约定）。 */
export function formatFingerprint(hex: string): string {
  return protocol.formatFingerprint(hex)
}

export function timingSafeEqual(a: string, b: string): boolean {
  return protocol.timingSafeEqual(a, b)
}

export function clampAssistantText(text: string, limit?: number): { text: string; truncated: boolean } {
  return protocol.clampAssistantText(text, limit)
}

/** core/pairing.mts 是零依赖的，真实的协议函数在装配层注入进去。 */
export const pairingDeps: PairingDeps = {
  parsePairingPayload(value, options) {
    const result = parsePairingPayload(value, options)
    if (!result.ok) return result
    return { ok: true, payload: result.payload as unknown as PairingPayload }
  },
  pickEndpoint,
}

/**
 * 启动期契约断言：镜像的帧名/常量必须和协议一致。
 * 只在开发期抛错，生产里静默放过（老 App 遇到新协议也应该能继续跑）。
 */
export function assertProtocolContract(): void {
  const protocolClient = protocol.CLIENT_FRAME as Record<string, string>
  const protocolServer = protocol.SERVER_FRAME as Record<string, string>
  const protocolCapabilities = protocol.CAPABILITIES as Record<string, string>
  const problems: string[] = []
  for (const [key, value] of Object.entries(CLIENT_FRAME)) {
    if (protocolClient[key] !== value) problems.push(`CLIENT_FRAME.${key}: 镜像 ${value} ≠ 协议 ${protocolClient[key]}`)
  }
  for (const [key, value] of Object.entries(SERVER_FRAME)) {
    if (protocolServer[key] !== value) problems.push(`SERVER_FRAME.${key}: 镜像 ${value} ≠ 协议 ${protocolServer[key]}`)
  }
  for (const [key, value] of Object.entries(CAPABILITIES)) {
    if (protocolCapabilities[key] !== value) problems.push(`CAPABILITIES.${key}: 镜像 ${value} ≠ 协议 ${protocolCapabilities[key]}`)
  }
  for (const [key, value] of Object.entries(ENDPOINT_KIND)) {
    if ((protocol.ENDPOINT_KIND as Record<string, string>)[key] !== value) {
      problems.push(`ENDPOINT_KIND.${key}: 镜像 ${value} ≠ 协议 ${(protocol.ENDPOINT_KIND as Record<string, string>)[key]}`)
    }
  }
  for (const [key, value] of Object.entries(CONNECTION_MODE)) {
    if ((protocol.CONNECTION_MODE as Record<string, string>)[key] !== value) {
      problems.push(`CONNECTION_MODE.${key}: 镜像 ${value} ≠ 协议 ${(protocol.CONNECTION_MODE as Record<string, string>)[key]}`)
    }
  }
  if (protocol.PROTOCOL_VERSION !== MIRROR_PROTOCOL_VERSION) problems.push('PROTOCOL_VERSION 镜像不一致')
  if (protocol.DEFAULT_PORT !== MIRROR_DEFAULT_PORT) problems.push('DEFAULT_PORT 镜像不一致')
  if (protocol.UPLOAD_CHUNK_BYTES !== MIRROR_UPLOAD_CHUNK_BYTES) problems.push('UPLOAD_CHUNK_BYTES 镜像不一致')
  if ((protocol.ALL_CAPABILITIES as readonly string[]).join(',') !== (ALL_CAPABILITIES as readonly string[]).join(',')) {
    problems.push('ALL_CAPABILITIES 镜像不一致')
  }
  if (problems.length > 0 && __DEV__) {
    throw new Error(`Open Whale 协议镜像与 @openwhale/protocol 不一致：\n${problems.join('\n')}`)
  }
}
