// 地址分类与排序：`packages/protocol/src/index.mjs` 的浏览器镜像（逻辑逐字对齐）。
//
// v2.2.0 的核心修复是「Tailscale 不算局域网、https 不再永远第一」：
//   auto 顺序 = 上次成功 > Tailscale > 局域网 > 公网隧道 > 未知
// 网页版必须用同一套排序，否则「手机端能连、网页版连不上」会被当成网页版缺陷。
// 与真实协议的等价性由 `test/protocol-mirror.test.mjs` + `test/endpoints.test.mjs` 覆盖。

import { CONNECTION_MODE, CONNECTION_MODES, DEFAULT_PORT, ENDPOINT_KIND, ENDPOINT_CODE_KIND, ENDPOINT_KIND_CODE, WS_PATH } from './protocol.mjs'

/** 各网络类型在界面上的中文名。 */
export const ENDPOINT_KIND_LABEL = Object.freeze({
  lan: '局域网',
  tailscale: 'Tailscale',
  tunnel: '公网隧道',
  loopback: 'USB / 本机',
  unknown: '其他',
})

/**
 * 是不是 Tailscale 地址。
 * 三种形态：IPv4 CGNAT 100.64.0.0/10、IPv6 ULA fd7a:115c:a1e0::/48、MagicDNS *.ts.net。
 * @param {string} host 不含端口、IPv6 去掉方括号
 * @returns {boolean}
 */
export function isTailscaleHost(host) {
  const value = String(host ?? '').trim().toLowerCase()
  if (value === '') return false
  if (value.endsWith('.ts.net')) return true
  if (value.includes(':')) {
    const bare = value.replace(/^\[|\]$/g, '')
    return bare.startsWith('fd7a:115c:a1e0:') || bare === 'fd7a:115c:a1e0::'
  }
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false
  return a === 100 && b >= 64 && b <= 127
}

/**
 * RFC1918 私有 IPv4（不含 loopback）。
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateIpv4Host(host) {
  const parts = String(host ?? '').trim().split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * 拆出 endpoint 的 scheme 与 host（不用 `new URL`，对象里没有它也不会崩）。
 * @param {unknown} endpoint
 * @returns {{scheme: string, host: string} | undefined}
 */
export function endpointAuthority(endpoint) {
  const text = String(endpoint ?? '').trim()
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)/.exec(text)
  if (!match) return undefined
  const scheme = match[1].toLowerCase()
  let authority = match[2]
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  let host = authority
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close < 0) return undefined
    host = host.slice(0, close + 1)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon >= 0) host = host.slice(0, colon)
  }
  if (host === '') return undefined
  return { scheme, host }
}

/**
 * 分类一个地址。
 * @param {unknown} endpoint
 * @returns {string} ENDPOINT_KIND 之一
 */
export function classifyEndpoint(endpoint) {
  const parsed = endpointAuthority(endpoint)
  if (!parsed) return ENDPOINT_KIND.UNKNOWN
  const host = parsed.host.toLowerCase()
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return ENDPOINT_KIND.LOOPBACK
  if (isTailscaleHost(bare)) return ENDPOINT_KIND.TAILSCALE
  const secure = parsed.scheme === 'https' || parsed.scheme === 'wss'
  if (isPrivateIpv4Host(bare)) return ENDPOINT_KIND.LAN
  if (secure) return ENDPOINT_KIND.TUNNEL
  return ENDPOINT_KIND.UNKNOWN
}

/**
 * 某种连接方式接受的网络类型（按优先级）。
 * @param {string} [mode]
 * @returns {string[]}
 */
export function endpointKindsForMode(mode) {
  switch (mode) {
    case CONNECTION_MODE.LAN:
      return [ENDPOINT_KIND.LAN]
    case CONNECTION_MODE.TAILSCALE:
      return [ENDPOINT_KIND.TAILSCALE]
    case CONNECTION_MODE.TUNNEL:
      return [ENDPOINT_KIND.TUNNEL, ENDPOINT_KIND.UNKNOWN]
    case CONNECTION_MODE.AUTO:
    default:
      return [ENDPOINT_KIND.TAILSCALE, ENDPOINT_KIND.LAN, ENDPOINT_KIND.TUNNEL, ENDPOINT_KIND.UNKNOWN]
  }
}

/**
 * 给候选地址排序。
 *
 * 保证（与协议一致）：
 *  1. loopback 默认排除，显式允许时永远排最后；
 *  2. `preferred`（上次成功的地址）排第一，前提是它仍被当前模式接受；
 *  3. 其余按模式的类型优先级（auto：Tailscale → 局域网 → 隧道 → 未知）；
 *  4. 同优先级保持原顺序（稳定排序）。
 * @param {unknown[]} endpoints
 * @param {{mode?: string, preferred?: string, allowLoopback?: boolean}} [options]
 * @returns {Array<{url: string, kind: string}>}
 */
export function orderEndpointCandidates(endpoints, options = {}) {
  const mode = CONNECTION_MODES.includes(/** @type {any} */ (options.mode)) ? /** @type {string} */ (options.mode) : CONNECTION_MODE.AUTO
  const allowLoopback = options.allowLoopback === true
  const preferred = typeof options.preferred === 'string' ? options.preferred.trim() : undefined
  const kinds = endpointKindsForMode(mode)
  const items = []
  const seen = new Set()
  for (const raw of Array.isArray(endpoints) ? endpoints : []) {
    if (typeof raw !== 'string') continue
    const url = raw.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const kind = classifyEndpoint(url)
    if (kind === ENDPOINT_KIND.LOOPBACK) {
      if (!allowLoopback) continue
      items.push({ url, kind, rank: 100 })
      continue
    }
    const rank = kinds.indexOf(kind)
    if (rank < 0) continue
    items.push({ url, kind, rank })
  }
  items.sort((a, b) => {
    if (preferred) {
      if (a.url === preferred) return -1
      if (b.url === preferred) return 1
    }
    if (a.rank !== b.rank) return a.rank - b.rank
    return 0
  })
  return items.map(({ url, kind }) => ({ url, kind }))
}

/**
 * 只返回 URL 的便捷版本。
 * @param {unknown[]} endpoints
 * @param {{mode?: string, preferred?: string, allowLoopback?: boolean}} [options]
 * @returns {string[]}
 */
export function orderEndpoints(endpoints, options = {}) {
  return orderEndpointCandidates(endpoints, options).map(item => item.url)
}

/**
 * 首选地址（兼容 protocol 的同名导出）。
 * @param {string[]} endpoints
 * @param {string|undefined} preferred
 * @param {{mode?: string, allowLoopback?: boolean}} [options]
 * @returns {string|undefined}
 */
export function pickEndpoint(endpoints, preferred, options = {}) {
  return orderEndpointCandidates(endpoints, { ...options, preferred })[0]?.url
}

/**
 * 把二维码里的 `epk` 单字母数组解析成网络类型；缺项按 URL 自动分类。
 * @param {string[]} endpoints
 * @param {unknown} epk
 * @returns {string[]}
 */
export function parseEndpointKinds(endpoints, epk) {
  const codes = Array.isArray(epk) ? epk : []
  return (Array.isArray(endpoints) ? endpoints : []).map((url, index) => {
    const code = typeof codes[index] === 'string' ? codes[index] : ''
    const mapped = ENDPOINT_CODE_KIND[code]
    return mapped ?? classifyEndpoint(url)
  })
}

/**
 * 生成 `epk` 单字母数组（二维码压缩用；网页版只在本地诊断里用得到）。
 * @param {string[]} endpoints
 * @returns {string[]}
 */
export function encodeEndpointKinds(endpoints) {
  return (Array.isArray(endpoints) ? endpoints : []).map(url => ENDPOINT_KIND_CODE[classifyEndpoint(url)] ?? 'x')
}

/**
 * 用「地址 + 已知类型」排序（二维码 epk 优先于 URL 自动分类）。
 *
 * 与 `orderEndpointCandidates` 的排序规则完全相同，只是 kind 由调用方提供：
 * 二维码已经声明了网络类型，就不该让 `http://` 前缀把 Tailscale 地址重新降级。
 * @param {Array<{url: string, kind?: string}>} candidates
 * @param {{mode?: string, preferred?: string, allowLoopback?: boolean}} [options]
 * @returns {Array<{url: string, kind: string}>}
 */
export function orderCandidates(candidates, options = {}) {
  const mode = CONNECTION_MODES.includes(/** @type {any} */ (options.mode)) ? /** @type {string} */ (options.mode) : CONNECTION_MODE.AUTO
  const allowLoopback = options.allowLoopback === true
  const preferred = typeof options.preferred === 'string' ? options.preferred.trim() : undefined
  const kinds = endpointKindsForMode(mode)
  const items = []
  const seen = new Set()
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = String(candidate?.url ?? '').trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const declared = typeof candidate?.kind === 'string' && Object.values(ENDPOINT_KIND).includes(candidate.kind)
      ? candidate.kind
      : classifyEndpoint(url)
    if (declared === ENDPOINT_KIND.LOOPBACK) {
      if (!allowLoopback) continue
      items.push({ url, kind: declared, rank: 100 })
      continue
    }
    const rank = kinds.indexOf(declared)
    if (rank < 0) continue
    items.push({ url, kind: declared, rank })
  }
  items.sort((a, b) => {
    if (preferred) {
      if (a.url === preferred) return -1
      if (b.url === preferred) return 1
    }
    if (a.rank !== b.rank) return a.rank - b.rank
    return 0
  })
  return items.map(({ url, kind }) => ({ url, kind }))
}

/**
 * 把两种来源的地址合并去重：绑定二维码里的（endpoints + epk）和 hello/ack 里的
 * `endpointList`。ack 的地址是电脑当前认为可达的，优先采用它的类型判断。
 * @param {{endpoints?: string[], epk?: string[]}} payload
 * @param {Array<{url?: string, kind?: string}>} [endpointList]
 * @returns {Array<{url: string, kind: string}>}
 */
export function mergeEndpointSources(payload, endpointList) {
  const endpoints = Array.isArray(payload?.endpoints) ? payload.endpoints : []
  const kinds = parseEndpointKinds(endpoints, payload?.epk)
  /** @type {Map<string, string>} */
  const merged = new Map()
  endpoints.forEach((url, index) => {
    const text = String(url ?? '').trim()
    if (text === '') return
    merged.set(text, kinds[index] ?? classifyEndpoint(text))
  })
  for (const item of Array.isArray(endpointList) ? endpointList : []) {
    const text = String(item?.url ?? '').trim()
    if (text === '') continue
    const kind = typeof item?.kind === 'string' && Object.values(ENDPOINT_KIND).includes(item.kind)
      ? item.kind
      : classifyEndpoint(text)
    merged.set(text, kind)
  }
  return [...merged.entries()].map(([url, kind]) => ({ url, kind }))
}

/** 竞速并发数：协议要求「新连接前并发竞速前两个候选」。 */
export const ENDPOINT_RACE_SIZE = 2

/**
 * 选出本轮要并发尝试的地址（前两个）。
 * @param {Array<{url: string, kind: string}>} ordered
 * @param {number} [size]
 * @returns {Array<{url: string, kind: string}>}
 */
export function raceSet(ordered, size = ENDPOINT_RACE_SIZE) {
  return (Array.isArray(ordered) ? ordered : []).slice(0, Math.max(1, size))
}

/**
 * 把 http(s) 基础地址转成 WebSocket 地址。
 * 允许直接传 ws(s)://；路径部分会被丢掉（地址只保留 origin）。
 * @param {string} baseUrl
 * @param {string} [wsPath]
 * @returns {string | undefined}
 */
export function buildWebSocketUrl(baseUrl, wsPath = WS_PATH) {
  const text = String(baseUrl ?? '').trim()
  const match = /^(https?|wss?):\/\/([^/?#]+)/i.exec(text)
  if (!match) return undefined
  const rawScheme = match[1].toLowerCase()
  const scheme = rawScheme === 'https' || rawScheme === 'wss' ? 'wss' : 'ws'
  return `${scheme}://${match[2]}${wsPath}`
}

/**
 * 把 http(s) 基础地址转成 origin（用于 health 预检 / 下载 URL 拼接）。
 * @param {string} baseUrl
 * @returns {string | undefined}
 */
export function baseOrigin(baseUrl) {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(String(baseUrl ?? '').trim())
  if (!match) return undefined
  return `${match[1].toLowerCase()}://${match[2]}`
}

/**
 * 把用户输入（`192.168.1.5:8787`、`http://host:8787`、`10.0.0.3`）规范化为 http 基础地址。
 * 不带端口时补插件默认端口 8787；IPv6 字面量要带方括号，这里只做保守处理。
 * @param {string} input
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function normalizeManualEndpoint(input) {
  const text = String(input ?? '').trim()
  if (text === '') return { ok: false, error: '请输入电脑地址，例如 192.168.1.5:8787' }
  if (/\s/.test(text)) return { ok: false, error: '地址里不能有空格' }
  let url = text
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return { ok: false, error: '只支持 http:// 或 https:// 地址' }
    url = `http://${url}`
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: '地址格式不正确' }
  }
  if (!parsed.hostname) return { ok: false, error: '地址格式不正确' }
  // http 无端口时补插件默认端口（8787）；https 无端口必须保持裸 origin ——
  // Tailscale Serve / 隧道给的是 https://host（默认 443），补 8787 会直接连不上。
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = String(DEFAULT_PORT)
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  const normalized = parsed.origin
  if (!/^https?:\/\/[^/]+$/.test(normalized)) return { ok: false, error: '地址格式不正确' }
  return { ok: true, url: normalized }
}

/**
 * 一句话概括一组候选地址，用于状态胶囊与设置页。
 * @param {Array<{url: string, kind: string}>} candidates
 * @returns {string}
 */
export function summarizeCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return '没有可用地址'
  const counts = new Map()
  for (const item of list) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  return [...counts.entries()].map(([kind, count]) => `${ENDPOINT_KIND_LABEL[kind] ?? kind}×${count}`).join(' · ')
}
