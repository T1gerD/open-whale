// endpoint 解析、连接候选排序与手动地址规范化（纯逻辑）。
//
// 网络类型分类与排序的**唯一权威**是 `packages/protocol`：`classifyEndpoint` /
// `orderEndpointCandidates` / `isTailscaleHost` / `endpointKindsForMode`。
// v2.1.0 在这里自己写过一套「私有网段判断」，漏掉了 Tailscale 的 100.64.0.0/10，
// 于是 tailnet 被当成公网、又被 https 硬优先顶掉——所以本文件不再重复实现分类规则，
// 直接 import 协议的纯 ESM 源码（相对路径，不需要 node_modules，`node --test` 可直跑），
// 协议改了这里自动跟着改，不存在第二套判断漂移的问题。
//
// 另外保留三类协议不关心的本地逻辑：
//  * http(s)/ws(s) 文本解析（RN/Hermes 的 URL 实现不完整，不能用 `new URL`）；
//  * 手动输入地址的规范化与 `/openwhale/health` 预检地址推导；
//  * 面向 UI 的中文标签与「该模式下没有可用地址」的可操作提示。

import {
  CONNECTION_MODE,
  CONNECTION_MODES,
  DEFAULT_PORT,
  ENDPOINT_KIND,
  classifyEndpoint as protocolClassifyEndpoint,
  endpointKindsForMode as protocolKindsForMode,
  isTailscaleHost as protocolIsTailscaleHost,
  orderEndpointCandidates as protocolOrderEndpointCandidates,
} from '../../../protocol/src/index.mjs'

/** 手机连接电脑的 WebSocket 路径，必须与 gateway.mjs 一致。 */
export const WS_PATH = '/openwhale/ws'

// 连接方式/网络类型的常量直接取协议的值（core/frames.mts 里另有一份镜像给 reducer 用，
// 由 frames.test.mjs 与协议做 deepEqual 核对）。
export { CONNECTION_MODE, CONNECTION_MODES, DEFAULT_PORT, ENDPOINT_KIND }

/** 手动连接预检用的健康检查路径（gateway.mjs 的无认证只读路由）。 */
export const HEALTH_PATH = '/openwhale/health'

const ENDPOINT_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?[^#]*)?$/

export interface ParsedEndpoint {
  scheme: string
  /** 主机名（IPv6 保留方括号）。 */
  host: string
  /** 端口字符串，未写时为空串。 */
  port: string
  /** 原始路径，未写时为空串。 */
  path: string
  isSecure: boolean
}

/** 解析一个 endpoint；不是可用的 http(s)/ws(s) 地址时返回 undefined。 */
export function parseEndpoint(value: unknown): ParsedEndpoint | undefined {
  if (typeof value !== 'string') return undefined
  const match = ENDPOINT_RE.exec(value.trim())
  if (!match) return undefined
  const scheme = match[1]!.toLowerCase()
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') return undefined
  let authority = match[2]!
  if (authority === '') return undefined
  // 去掉 user:pass@（隧道地址正常不会带，带了也不该出现在日志里）。
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)

  let host = authority
  let port = ''
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close < 0) return undefined
    const rest = host.slice(close + 1)
    host = host.slice(0, close + 1)
    if (rest.startsWith(':')) port = rest.slice(1)
    else if (rest !== '') return undefined
  } else {
    const colon = host.lastIndexOf(':')
    if (colon >= 0) {
      port = host.slice(colon + 1)
      host = host.slice(0, colon)
    }
  }
  if (host === '') return undefined
  if (port !== '') {
    // 端口必须是 1–65535：5 位数字还不够（`99999` 会被 TCP 直接拒掉）。
    if (!/^\d{1,5}$/.test(port)) return undefined
    const numeric = Number(port)
    if (numeric < 1 || numeric > 65535) return undefined
  }
  return {
    scheme,
    host,
    port,
    path: match[3] ?? '',
    isSecure: scheme === 'https' || scheme === 'wss',
  }
}

/**
 * endpoint → WebSocket URL。
 * - http→ws / https→wss（cloudflared 这类隧道是 https，必须升级成 wss）；
 * - 地址里已经带了 `/openwhale/ws` 时原样返回，便于用户直接填完整 ws 地址；
 * - 地址带了反向代理前缀（例如 `https://host/whale`）时前缀保留，只追加路径。
 */
export function wsUrlFor(endpoint: unknown, path: string = WS_PATH): string | undefined {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return undefined
  const scheme = parsed.isSecure ? 'wss' : 'ws'
  const origin = `${scheme}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`
  const rawPath = parsed.path
  const trimmed = rawPath.replace(/\/+$/, '')
  if (trimmed.endsWith(WS_PATH)) return `${origin}${trimmed}`
  // 用户直接给了 ws/wss 且带自定义路径：认为那就是入口，不再猜。
  if ((parsed.scheme === 'ws' || parsed.scheme === 'wss') && trimmed !== '') return `${origin}${trimmed}`
  return `${origin}${trimmed}${path}`
}

/**
 * endpoint → HTTP(S) 基地址（health 预检、一次性下载链接用）。
 * ws→http、wss→https，其余原样；非法地址返回 undefined。
 */
export function httpUrlFor(endpoint: unknown): string | undefined {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return undefined
  const scheme = parsed.scheme === 'wss' ? 'https' : parsed.scheme === 'ws' ? 'http' : parsed.scheme
  const origin = `${scheme}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`
  return `${origin}${parsed.path.replace(/\/+$/, '')}`
}

/** endpoint → `/openwhale/health` 的完整 URL（手动连接预检用）。 */
export function healthUrlFor(endpoint: unknown, path: string = HEALTH_PATH): string | undefined {
  const base = httpUrlFor(endpoint)
  if (!base) return undefined
  return `${base}${path}`
}

/** 规范化一个 endpoint，用于入库与去重；非法则返回 undefined。 */
export function normalizeEndpoint(value: unknown): string | undefined {
  const parsed = parseEndpoint(value)
  if (!parsed) return undefined
  const path = parsed.path.replace(/\/+$/, '')
  return `${parsed.scheme}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${path}`
}

/** 过滤非法项、去重（保持二维码里的优先级顺序），并按规范化结果去重。 */
export function normalizeEndpoints(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const normalized = normalizeEndpoint(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/** 判断是否为 USB 调试通道地址（回环地址，靠 adb reverse 转发）。 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return false
  const host = parsed.host.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

// ---------------------------------------------------------------------------
// 网络类型（委托协议）
// ---------------------------------------------------------------------------

/** 地址的网络类型：lan / tailscale / tunnel / loopback / unknown。 */
export function endpointKind(endpoint: unknown): string {
  return protocolClassifyEndpoint(endpoint)
}

/**
 * 是不是 Tailscale 地址（CGNAT 100.64/10、fd7a:115c:a1e0::/48、*.ts.net）。
 * 分类委托协议；这里只负责从 endpoint 里取出 host。
 */
export function isTailscaleEndpoint(endpoint: unknown): boolean {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return false
  const host = parsed.host.startsWith('[') ? parsed.host.slice(1, -1) : parsed.host
  return protocolIsTailscaleHost(host)
}

/** 把任意值收窄成合法的连接方式，非法/缺省一律 auto。 */
export function normalizeConnectionMode(mode: unknown): string {
  return typeof mode === 'string' && (CONNECTION_MODES as readonly string[]).includes(mode)
    ? mode
    : CONNECTION_MODE.AUTO
}

/** 连接方式的中文标签（设置页）。 */
export function connectionModeLabel(mode: unknown): string {
  switch (normalizeConnectionMode(mode)) {
    case CONNECTION_MODE.LAN:
      return '局域网'
    case CONNECTION_MODE.TAILSCALE:
      return 'Tailscale'
    case CONNECTION_MODE.TUNNEL:
      return '公网隧道'
    default:
      return '自动'
  }
}

/** 网络类型的中文标签（连接状态条 / 设置页的「当前线路」）。 */
export function endpointKindLabel(kind: unknown): string {
  switch (String(kind)) {
    case ENDPOINT_KIND.LAN:
      return '局域网'
    case ENDPOINT_KIND.TAILSCALE:
      return 'Tailscale'
    case ENDPOINT_KIND.TUNNEL:
      return '公网隧道'
    case ENDPOINT_KIND.LOOPBACK:
      return 'USB 调试通道'
    default:
      return '未知网络'
  }
}

/** 给 UI 的地址标签：公网隧道 / Tailscale / 局域网 / USB 调试通道。 */
export function endpointLabel(endpoint: string): string {
  if (!parseEndpoint(endpoint)) return '地址无效'
  return endpointKindLabel(endpointKind(endpoint))
}

/** 判断手机是否可能和该地址在同一局域网（WoL 引导文案要用，纯字符串判断）。 */
export function looksLocal(endpoint: string): boolean {
  const kind = endpointKind(endpoint)
  return kind === ENDPOINT_KIND.LAN || kind === ENDPOINT_KIND.LOOPBACK
}

// ---------------------------------------------------------------------------
// 连接策略 / 候选阶梯
// ---------------------------------------------------------------------------

export interface EndpointLadderOptions {
  /** 连接方式（auto/lan/tailscale/tunnel），非法/缺省按 auto。 */
  mode?: string
  /** 允许 USB 回环地址（仅内部测试模式）。默认 false。 */
  allowUsb?: boolean
  /** allowUsb 的别名，便于旧调用点迁移。 */
  allowLoopback?: boolean
}

function allowsLoopback(options: EndpointLadderOptions): boolean {
  return options.allowUsb === true || options.allowLoopback === true
}

/**
 * 该地址在当前连接方式下是否允许使用。
 * 与协议 `endpointKindsForMode` 一致：显式模式只留该类地址；auto 全留（USB 除外）。
 */
export function isEndpointPermitted(endpoint: string, options: EndpointLadderOptions = {}): boolean {
  const kind = endpointKind(endpoint)
  if (kind === ENDPOINT_KIND.LOOPBACK) return allowsLoopback(options)
  const kinds = protocolKindsForMode(normalizeConnectionMode(options.mode)) as readonly string[]
  return kinds.includes(kind)
}

/**
 * 重连时要依次尝试的地址阶梯。
 *
 * 两层顺序叠加：
 *  1. **上次成功的地址**永远先试一次（即使电脑这次没在 hello/ack 里通告它，
 *     也不代表它失效；`protocol.orderEndpointCandidates` 只在列表内排序，做不到这点）；
 *  2. 其余地址完全交给协议：auto = Tailscale → 局域网 → 隧道 → 未知，
 *     显式模式只保留对应类型；USB 回环默认排除，内部测试模式才允许。
 */
export function endpointLadder(
  endpoints: string[],
  preferred?: string,
  options: EndpointLadderOptions = {},
): string[] {
  const normalized = normalizeEndpoints(endpoints)
  const ordered = protocolOrderEndpointCandidates(normalized, {
    mode: normalizeConnectionMode(options.mode),
    preferred: normalizeEndpoint(preferred ?? ''),
    allowLoopback: allowsLoopback(options),
  }).map(item => item.url)
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: string | undefined): void => {
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }
  // 上次成功的地址也要过策略：否则关掉 USB 之后它还会被优先使用一次。
  const sticky = normalizeEndpoint(preferred ?? '')
  if (sticky && isEndpointPermitted(sticky, options)) push(sticky)
  for (const endpoint of ordered) push(endpoint)
  return out
}

/**
 * 该连接方式下没有可用地址时的可操作提示（显式模式必须给，auto 不给）。
 * 返回 undefined 表示有可用地址、无需提示。
 */
export function missingModeHint(
  mode: unknown,
  endpoints: string[],
  options: EndpointLadderOptions = {},
): string | undefined {
  const normalizedMode = normalizeConnectionMode(mode)
  if (normalizedMode === CONNECTION_MODE.AUTO) return undefined
  const kindList = protocolKindsForMode(normalizedMode) as readonly string[]
  const hasAny = normalizeEndpoints(endpoints).some(endpoint => {
    const kind = endpointKind(endpoint)
    if (kind === ENDPOINT_KIND.LOOPBACK) return false
    return kindList.includes(kind)
  })
  if (hasAny) return undefined
  switch (normalizedMode) {
    case CONNECTION_MODE.TAILSCALE:
      return '没有检测到 Tailscale 地址，请确认手机与电脑都登录了同一个 tailnet，并在电脑上确认 Tailscale 已开启。'
    case CONNECTION_MODE.LAN:
      return '没有检测到局域网地址，请确认手机和电脑连接的是同一个 Wi-Fi，或把连接方式改回「自动」。'
    case CONNECTION_MODE.TUNNEL:
      return '没有检测到公网隧道地址，隧道可能已经更换，请在电脑上重新生成二维码。'
    default:
      return undefined
  }
}

/**
 * 连接方式偏好改变时的完整提示（含下一步操作）。
 * 比 `missingModeHint` 更啰嗦一点，用于设置页保存后的反馈文案。
 */
export function connectionModeNotice(mode: unknown, endpoints: string[]): string {
  const hint = missingModeHint(mode, endpoints)
  if (hint) return `${hint}\n可以换一种连接方式、重新扫码，或手动输入电脑地址。`
  return `连接方式已切换为「${connectionModeLabel(mode)}」，正在重新连接…`
}

// ---------------------------------------------------------------------------
// 手动地址输入
// ---------------------------------------------------------------------------

export type ManualAddressResult =
  | { ok: true; endpoint: string; kind: string; label: string }
  | { ok: false; message: string; hint?: string }

/** 输入里是否已经带了 scheme（http:// / https:// / ws:// …）。 */
function hasScheme(text: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)
}

/** 裸 IPv6 地址（没有方括号）：多个冒号且不是 host:port 的形状。 */
function looksLikeBareIpv6(text: string): boolean {
  if (text.includes('.') || text.startsWith('[')) return false
  const colons = text.split(':').length - 1
  return colons >= 2
}

/**
 * 规范化用户手动输入的地址。
 *
 * 支持：`192.168.1.5:8787`、`192.168.1.5`（补默认端口）、`http://host:port`、
 * `https://xxx.ts.net`、`[fd7a::1]:8787`、完整 `ws://host:port`；也允许带反向代理前缀。
 * 不带 scheme 时默认 http；ws/wss 统一存成 http/https（真正连的时候 `wsUrlFor` 再升级）。
 */
export function normalizeManualAddress(input: unknown): ManualAddressResult {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') {
    return { ok: false, message: '请输入电脑地址，例如 192.168.1.5:8787', hint: '地址可以在电脑上插件的配对页面看到。' }
  }
  // 带空格的“地址”一定不是合法主机名（用户可能粘贴了一段说明文字）。
  if (/\s/.test(raw)) {
    return {
      ok: false,
      message: '地址里不能有空格',
      hint: '只需要 host:port，例如 192.168.1.5:8787；也可以粘贴完整地址（http:// 或 https:// 开头）。',
    }
  }
  let candidate = raw.replace(/\/+$/, '')
  if (!hasScheme(candidate)) {
    // 没有 scheme 时把 authority 与 path 拆开处理：裸地址默认 http + 插件默认端口。
    const slash = candidate.indexOf('/')
    const authority = slash >= 0 ? candidate.slice(0, slash) : candidate
    const rest = slash >= 0 ? candidate.slice(slash) : ''
    const base = looksLikeBareIpv6(authority) ? `[${authority}]` : authority
    const withPort = /:\d+$/.test(base) ? base : `${base}:${DEFAULT_PORT}`
    candidate = `http://${withPort}${rest}`
  }
  const parsed = parseEndpoint(candidate)
  if (!parsed) {
    return {
      ok: false,
      message: '地址格式不正确，请输入 host:port（例如 192.168.1.5:8787）',
      hint: '也可以粘贴电脑上显示的完整地址（http:// 或 https:// 开头）。',
    }
  }
  // 主机名只允许字母数字/点/横线/下划线；IPv6 字面量额外允许冒号与 16 进制字符。
  const hostText = parsed.host
  const bareHost = hostText.startsWith('[') ? hostText.slice(1, -1) : hostText
  const validHost = /^[A-Za-z0-9._-]+$/.test(bareHost) || /^[0-9A-Fa-f:.]+$/.test(bareHost)
  if (bareHost === '' || !validHost) {
    return {
      ok: false,
      message: '主机名不合法',
      hint: '请输入 IP 或域名，例如 192.168.1.5:8787、desk.tail1a2b3c.ts.net。',
    }
  }
  // ws/wss 统一成 http/https：入库与 health 预检都按 HTTP 处理，连 WS 时再升级。
  let scheme = parsed.scheme
  if (scheme === 'ws') scheme = 'http'
  if (scheme === 'wss') scheme = 'https'
  let path = parsed.path.replace(/\/+$/, '')
  // 用户可能直接粘贴了完整的 WS 入口地址：把路径里的 /openwhale/ws 去掉，还原成基地址。
  if (path.endsWith(WS_PATH)) path = path.slice(0, -WS_PATH.length)
  const endpoint = `${scheme}://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}${path}`
  const kind = endpointKind(endpoint)
  return {
    ok: true,
    endpoint,
    kind,
    label: endpointKindLabel(kind),
  }
}
