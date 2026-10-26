// 手动连接：GET /openwhale/health 预检（原生能力层）。
//
// 纯判定在 core/manual-connect.mts（可单测），这里只负责发请求、超时与错误归类。
// 为什么用 HTTP 预检而不是直接建 WebSocket：用户手输的地址经常是错的（端口、拼写、
// 服务不是 Open Whale），WebSocket 握手失败只能得到 "连接出错"，没法告诉用户到底哪里错。

import { describeProbeError, interpretHealthResponse, type HealthOutcome } from '../core/manual-connect.mts'
import { healthUrlFor, normalizeManualAddress } from '../core/endpoint.mts'

/** 预检超时：局域网/Tailscale 正常在 200ms 内，5 秒足够；公网隧道慢也不该超过这个数。 */
export const PROBE_TIMEOUT_MS = 5_000

export interface AddressProbe extends HealthOutcome {
  /** 规范化后的地址（写入 assistant.endpoints 的就是它）。 */
  address?: string
  /** 地址标签：局域网 / Tailscale / 公网隧道 / USB 调试通道。 */
  label?: string
  /** 网络类型（lan/tailscale/tunnel/loopback/unknown）。 */
  kind?: string
}

function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return task(controller.signal).finally(() => clearTimeout(timer))
}

/**
 * 探活一个手动输入的地址。
 * 无论成功失败都返回结构化结果，不抛错（UI 直接展示 message/hint）。
 */
export async function probeAddress(input: string, options: { timeoutMs?: number } = {}): Promise<AddressProbe> {
  const normalized = normalizeManualAddress(input)
  if (!normalized.ok) return { ok: false, message: normalized.message, hint: normalized.hint }
  const url = healthUrlFor(normalized.endpoint)
  if (!url) {
    return { ok: false, message: '地址无法转换成健康检查 URL', hint: '请检查地址格式，例如 192.168.1.5:8787。' }
  }
  try {
    const response = await withTimeout(async signal => {
      const result = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      })
      let body: unknown
      try {
        body = await result.json()
      } catch {
        body = undefined
      }
      return { status: result.status, body }
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS)
    const outcome = interpretHealthResponse(response.status, response.body)
    return {
      ...outcome,
      address: normalized.endpoint,
      label: normalized.label,
      kind: normalized.kind,
    }
  } catch (error) {
    const failure = describeProbeError(error)
    return {
      ok: false,
      message: failure.message,
      hint: failure.hint,
      address: normalized.endpoint,
      label: normalized.label,
      kind: normalized.kind,
    }
  }
}
