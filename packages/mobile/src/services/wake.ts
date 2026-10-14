// 唤醒代理请求（本地扩展，不是 wire protocol 的一部分）。
//
// 协议里没有 WOL 帧，我们也不发明帧。用户可以在助理详情里填一个局域网内常开设备的
// HTTP 端点，手机对它发一个普通 GET，由那台设备去发魔术包。没配置时只给引导文案。

import { isValidWakeUrl, planWake, type WakePlan, type WakeSetting } from '../core/wake.mts'

export interface WakeOutcome {
  ok: boolean
  message: string
  /** 配置缺失时的引导步骤。 */
  guidance?: string[]
  url?: string
}

export async function performWake(
  setting: WakeSetting,
  assistant: { computerId: string; name: string },
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<WakeOutcome> {
  const plan: WakePlan = planWake(setting, assistant)
  if (!plan.ok) {
    return { ok: false, message: plan.message, guidance: plan.guidance }
  }
  if (!isValidWakeUrl(plan.request.url)) {
    return { ok: false, message: '唤醒代理地址无效，请检查是否以 http:// 或 https:// 开头' }
  }

  const timeoutMs = options.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl ?? fetch)(plan.request.url, {
      method: 'GET',
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, message: `唤醒代理返回 ${response.status}，请检查它的服务是否正常`, url: plan.request.url }
    }
    return { ok: true, message: plan.note, url: plan.request.url }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? '唤醒代理没有响应（超时）' : '无法连接唤醒代理'
    return {
      ok: false,
      message: `${reason}：请确认手机与唤醒代理在同一网络，且地址填写正确`,
      url: plan.request.url,
    }
  } finally {
    clearTimeout(timer)
  }
}
