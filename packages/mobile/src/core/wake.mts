// “唤醒电脑”（远程开机）的纯逻辑。
//
// 现实约束（写在 README 里，也在 UI 上直说）：
//  * 电脑关机后手机连不上它，所以不存在“发个协议帧就能开机”的假按钮；
//  * 真正的 Wake-on-LAN 需要在**同一个局域网**里发 UDP 魔术包，而手机在 4G/5G 时
//    广播进不了家里局域网；RN 也没有免原生模块的 UDP 能力（见 _recon/MOBILE-STACK.md §3.5）；
//  * 协议里**没有** WOL 帧，我们也不发明新帧。因此这里只做两件事：
//    1) 用户可以在本地设置一个“唤醒代理地址”（局域网里常开设备上的 HTTP 端点），
//       手机对它发一个普通 HTTP 请求，由那台设备去发魔术包；
//    2) 没配置时给出明确的配置引导文案。

export interface WakeSetting {
  /** 用户配置的唤醒代理 URL，支持 {computerId} / {id} / {mac} / {name} 占位符。 */
  url?: string
  /** 电脑的 MAC（协议不提供，需要用户自己填）。 */
  mac?: string
}

export interface WakeRequest {
  url: string
  method: 'GET'
}

export type WakePlan =
  | { ok: true; request: WakeRequest; note: string }
  | { ok: false; reason: 'unconfigured'; message: string; guidance: string[] }

/** 校验用户填的地址是否像个能用的 http(s) 端点。 */
export function isValidWakeUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  return /^https?:\/\/[^\s]+$/i.test(url.trim())
}

/**
 * 展开占位符；没有 mac 时把 `{mac}` 替换成空串而不是留下花括号。
 * `{id}` 是 `{computerId}` 的别名：电脑端的 WakeTarget 用 `id` 命名，两种写法都接受，
 * 用户照着哪边的文档写都不会错。
 */
export function expandWakeUrl(template: string, values: { computerId?: string; mac?: string; name?: string }): string {
  const computerId = encodeURIComponent(values.computerId ?? '')
  return String(template)
    .replace(/\{computerId\}/g, computerId)
    .replace(/\{id\}/g, computerId)
    .replace(/\{mac\}/g, encodeURIComponent(values.mac ?? ''))
    .replace(/\{name\}/g, encodeURIComponent(values.name ?? ''))
}

/**
 * 规划一次唤醒请求。
 * 说明：这是一个**本地扩展**（不是 wire protocol 的一部分），只有在用户自己
 * 搭了唤醒代理（例如电脑端插件将来提供的 HTTP 端点，或 NAS 上的小脚本）时才有用。
 */
export function planWake(setting: WakeSetting, assistant: { computerId: string; name: string }): WakePlan {
  if (!isValidWakeUrl(setting.url)) {
    return {
      ok: false,
      reason: 'unconfigured',
      message: '还没有配置唤醒方式，手机无法把电脑叫醒',
      guidance: wakeGuidance(setting),
    }
  }
  const expanded = expandWakeUrl(String(setting.url).trim(), {
    computerId: assistant.computerId,
    mac: setting.mac,
    name: assistant.name,
  })
  const needsMac = /\{mac\}/.test(String(setting.url)) && !setting.mac
  return {
    ok: true,
    request: { url: expanded, method: 'GET' },
    note: needsMac
      ? '唤醒代理里带了 {mac} 占位符，但你还没填 MAC：请求会缺少 MAC，请补上后再试'
      : '已向唤醒代理发送请求；如果电脑 30 秒内没上线，请检查 BIOS 的网络唤醒（Wake on LAN）是否开启',
  }
}

/** 配置引导：必须具体到用户能照着做，而不是“请配置代理”。 */
export function wakeGuidance(setting: WakeSetting = {}): string[] {
  const lines = [
    '真正能开机的是网卡上的“魔术包”，它只能从**同一局域网**里发出——手机在 4G/5G 时做不到这件事。',
  ]
  if (!setting.mac) {
    lines.push('先在助理详情里填上这台电脑的 MAC 地址（Windows: `ipconfig /all`；macOS: 系统设置→网络→详细信息）。')
  }
  lines.push(
    '在局域网里准备一台常开的设备（路由器、NAS、树莓派，或另一台一直开着的电脑），让它替你发魔术包。',
    '把那台设备上的 HTTP 端点填到“唤醒代理地址”，可用 {computerId} / {mac} 占位符。',
    '电脑的 BIOS/UEFI 里要打开 Wake on LAN，Windows 还关掉“快速启动”，否则关机后网卡会断电。',
  )
  return lines
}
