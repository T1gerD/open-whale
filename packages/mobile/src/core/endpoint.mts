// endpoint 解析与 WebSocket URL 推导（纯逻辑）。
//
// 为什么不用 `new URL`：RN/Hermes 里的 URL 是精简实现，`searchParams`/相对路径
// 行为与 Node 不一致；这里只需要 http(s)/ws(s) 的 origin + 路径，正则足够且完全可控。
// 推导规则以电脑端 `gateway.mjs` 的 `WS_PATH = '/openwhale/ws'` 为准。

/** 手机连接电脑的 WebSocket 路径，必须与 gateway.mjs 一致。 */
export const WS_PATH = '/openwhale/ws'

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

/**
 * 重连时要依次尝试的地址阶梯：
 * 上次成功的地址优先（可能是局域网直连，最省流量），然后 https 隧道，最后其余。
 * 与 protocol 的 `pickEndpoint` 语义一致，但这里返回**完整序列**，供逐级重试。
 */
export function endpointLadder(endpoints: string[], preferred?: string): string[] {
  const valid = normalizeEndpoints(endpoints)
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: string | undefined): void => {
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }
  if (preferred) push(normalizeEndpoint(preferred))
  for (const endpoint of valid) if (endpoint.startsWith('https://')) push(endpoint)
  for (const endpoint of valid) push(endpoint)
  return out
}

/** 给 UI 的地址标签：公网隧道 / 局域网 / 自定义。 */
export function endpointLabel(endpoint: string): string {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return '地址无效'
  if (parsed.scheme === 'https' || parsed.scheme === 'wss') return '公网隧道'
  if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.host) || parsed.host.startsWith('[')) return '局域网'
  return '局域网域名'
}

/** 判断手机是否可能和该地址在同一局域网（WoL 引导文案要用，纯字符串判断）。 */
export function looksLocal(endpoint: string): boolean {
  const parsed = parseEndpoint(endpoint)
  if (!parsed) return false
  if (parsed.isSecure) return false
  return (
    /^10\./.test(parsed.host) ||
    /^192\.168\./.test(parsed.host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.host) ||
    parsed.host === 'localhost' ||
    parsed.host === '127.0.0.1' ||
    parsed.host.startsWith('[')
  )
}
