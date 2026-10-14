// 真实 protocol 实现的唯一入口。
//
// App 里**不允许**别的地方 import '@openwhale/protocol'：跨包导入在 Metro 里需要
// metro.config.js 的 alias（已配好），集中在这里的好处是——协议改名时只需要改一处，
// 而且启动期就能断言“镜像常量 == 协议常量”，把静默失联变成一次明确崩溃。

import * as protocol from '@openwhale/protocol'

import { CLIENT_FRAME, SERVER_FRAME } from '../core/frames.mts'
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

export const POWER_REFUSAL = protocol.POWER_REFUSAL as Record<string, string>
export const ACTIVITY_KIND = protocol.ACTIVITY_KIND as Record<string, string>

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
 * 启动期契约断言：镜像的帧名必须和协议一致。
 * 只在开发期抛错，生产里静默放过（老 App 遇到新协议也应该能继续跑）。
 */
export function assertProtocolContract(): void {
  const protocolClient = protocol.CLIENT_FRAME as Record<string, string>
  const protocolServer = protocol.SERVER_FRAME as Record<string, string>
  const problems: string[] = []
  for (const [key, value] of Object.entries(CLIENT_FRAME)) {
    if (protocolClient[key] !== value) problems.push(`CLIENT_FRAME.${key}: 镜像 ${value} ≠ 协议 ${protocolClient[key]}`)
  }
  for (const [key, value] of Object.entries(SERVER_FRAME)) {
    if (protocolServer[key] !== value) problems.push(`SERVER_FRAME.${key}: 镜像 ${value} ≠ 协议 ${protocolServer[key]}`)
  }
  if (problems.length > 0 && __DEV__) {
    throw new Error(`Open Whale 协议镜像与 @openwhale/protocol 不一致：\n${problems.join('\n')}`)
  }
}
