// 绑定载荷：解析二维码链接 / 粘贴的 JSON，并校验成与 `@openwhale/protocol`
// 完全一致的 `QrPairingPayload`。
//
// 校验规则必须和电脑端一模一样（包括错误文案），否则「扫同一张码，手机端能绑、
// 网页版报错」会成为一类玄学问题。与真实协议的等价性由
// `test/protocol-mirror.test.mjs` 用同一批用例双向比对。

import { CONNECTION_MODES, DEFAULT_PORT, formatFingerprint, PROTOCOL_VERSION, WEB_CLIENT_PATH, WS_PATH } from './protocol.mjs'
import { fromBase64Url, utf8Decode, utf8Encode, toBase64Url } from './bytes.mjs'
import { classifyEndpoint, mergeEndpointSources, orderCandidates } from './endpoints.mjs'

/**
 * @typedef {object} PairingPayload
 * @property {1} v
 * @property {'openwhale'} p
 * @property {string} host
 * @property {string} id
 * @property {string} fp
 * @property {string} [pk]
 * @property {string} secret
 * @property {string} expires
 * @property {string[]} endpoints
 * @property {string[]} [epk]
 * @property {string} [web]
 * @property {string} [mode]
 * @property {string|number} [port]
 * @property {string} [lan]
 * @property {string} [name]
 * @property {string} [version]
 */

/**
 * 与 protocol.parsePairingPayload 完全同款的校验（错误文案也一致）。
 * @param {unknown} value
 * @param {{now?: number}} [options]
 * @returns {{ok: true, payload: PairingPayload} | {ok: false, error: string}}
 */
export function parsePairingPayload(value, options = {}) {
  const now = options.now ?? Date.now()
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'QR 内容不是有效对象' }
  const p = /** @type {Record<string, unknown>} */ (value)
  if (p.p !== 'openwhale') return { ok: false, error: '这不是 Open Whale 的绑定二维码' }
  if (p.v !== 1) return { ok: false, error: `不支持的二维码版本：${String(p.v)}` }
  for (const key of ['host', 'id', 'fp', 'secret', 'expires']) {
    if (typeof p[key] !== 'string' || p[key] === '') return { ok: false, error: `二维码缺少字段：${key}` }
  }
  if (p.pk !== undefined && (typeof p.pk !== 'string' || p.pk === '')) {
    return { ok: false, error: '二维码字段 pk 格式不合法' }
  }
  if (!Array.isArray(p.endpoints) || p.endpoints.every(e => typeof e !== 'string')) {
    return { ok: false, error: '二维码缺少可用地址' }
  }
  if (p.epk !== undefined) {
    if (!Array.isArray(p.epk) || !p.epk.every(code => typeof code === 'string')) {
      return { ok: false, error: '二维码字段 epk 格式不合法' }
    }
  }
  if (p.web !== undefined && (typeof p.web !== 'string' || p.web === '')) {
    return { ok: false, error: '二维码字段 web 格式不合法' }
  }
  if (p.mode !== undefined && !CONNECTION_MODES.includes(/** @type {any} */ (p.mode))) {
    return { ok: false, error: `未知的连接方式：${String(p.mode)}` }
  }
  const expires = Date.parse(/** @type {string} */ (p.expires))
  if (!Number.isFinite(expires)) return { ok: false, error: '二维码过期时间格式错误' }
  if (expires <= now) return { ok: false, error: '二维码已过期，请在电脑上重新生成' }
  return { ok: true, payload: /** @type {PairingPayload} */ (p) }
}

/**
 * 短二维码里的配对密钥：`/openwhale/app?s=<secret>`。
 *
 * 二维码因此只有 ~90 个字符（iOS 相机一扫就中），网页端再向同源的
 * `/openwhale/pairing.json` 兑换完整载荷，并校验密钥一致。
 * @param {string} search `window.location.search`（可带可不带 `?`）
 * @returns {string | undefined}
 */
export function bindingSecretFromSearch(search) {
  const text = String(search ?? '').trim()
  if (text === '') return undefined
  const params = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text)
  const secret = params.get('s')
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 200) return undefined
  return secret
}

/**
 * 从 URL fragment / query 里取出 `p=<base64url>` 并解码；也接受整个 hash 就是
 * base64url 的简写（插件页面万一直接拼了裸值）。
 * @param {string} hashOrQuery 形如 `#p=xxx`、`?p=xxx` 或 `xxx`
 * @returns {{ok: true, json: string} | {ok: false, error: string}}
 */
export function decodePayloadParam(hashOrQuery) {
  let text = String(hashOrQuery ?? '').trim()
  if (text === '') return { ok: false, error: '绑定内容为空' }
  if (text.startsWith('#') || text.startsWith('?')) text = text.slice(1)
  // URLSearchParams 能把 `%2F` 之类的转义解开；裸 base64url 也能被它当 key 读取。
  const params = new URLSearchParams(text)
  const raw = params.get('p') ?? params.get('P') ?? (/^[A-Za-z0-9_-]+$/.test(text) ? text : '')
  if (!raw) return { ok: false, error: '链接里没有找到绑定参数（#p=…）' }
  try {
    return { ok: true, json: utf8Decode(fromBase64Url(decodeURIComponent(raw))) }
  } catch {
    return { ok: false, error: '绑定二维码内容无法解码（base64url 不完整）' }
  }
}

/**
 * 解析用户提供的一切绑定输入：
 *  - 粘贴的 payload JSON；
 *  - 完整 URL（含 `#p=`）；
 *  - 裸 base64url；
 *  - 已经是对象（来自 QR 解码或代码调用）。
 * @param {unknown} input
 * @param {{now?: number}} [options]
 * @returns {{ok: true, payload: PairingPayload, source: 'object'|'json'|'url'|'base64url'} | {ok: false, error: string}}
 */
export function parsePairingInput(input, options = {}) {
  if (typeof input === 'object' && input !== null) {
    const result = parsePairingPayload(input, options)
    return result.ok ? { ...result, source: 'object' } : result
  }
  if (typeof input !== 'string') return { ok: false, error: '绑定内容不是文本或对象' }
  const text = input.trim()
  if (text === '') return { ok: false, error: '绑定内容为空' }

  /** @param {string} json @param {'json'|'url'|'base64url'} source */
  const finish = (json, source) => {
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, error: '绑定内容不是合法 JSON' }
    }
    const result = parsePairingPayload(parsed, options)
    return result.ok ? { ...result, source } : result
  }

  if (text.startsWith('{')) return finish(text, 'json')
  if (text.startsWith('http://') || text.startsWith('https://')) {
    const hashIndex = text.indexOf('#')
    const queryIndex = text.indexOf('?')
    const fragment = hashIndex >= 0 ? text.slice(hashIndex + 1) : queryIndex >= 0 ? text.slice(queryIndex + 1) : ''
    if (!fragment) return { ok: false, error: '链接里没有找到绑定参数（#p=…）' }
    const decoded = decodePayloadParam(fragment)
    if (!decoded.ok) return decoded
    return finish(decoded.json, 'url')
  }
  if (text.startsWith('#') || text.startsWith('?') || text.includes('p=')) {
    const decoded = decodePayloadParam(text)
    if (!decoded.ok) return decoded
    return finish(decoded.json, 'url')
  }
  // 裸 base64url（插件页面可能只把参数值贴出来）。只接受纯 base64url 字符，
  // 其它文本直接判定「既不是 JSON 也不是链接」，不要硬解码出一堆乱码再报 JSON 错。
  if (!/^[A-Za-z0-9_-]{16,}$/.test(text)) {
    return { ok: false, error: '绑定内容既不是 JSON，也不是有效的绑定链接' }
  }
  let json
  try {
    json = utf8Decode(fromBase64Url(text))
  } catch {
    return { ok: false, error: '绑定内容既不是 JSON，也不是有效的绑定链接' }
  }
  try {
    JSON.parse(json)
  } catch {
    return { ok: false, error: '绑定内容既不是 JSON，也不是有效的绑定链接' }
  }
  return finish(json, 'base64url')
}

/**
 * 生成 PWA 绑定链接（插件给二维码用的格式，测试与文档共用）。
 * @param {string} baseUrl 电脑地址，例如 http://192.168.1.5:8787
 * @param {PairingPayload} payload
 * @param {string} [webPath]
 * @returns {string}
 */
export function buildWebBindingUrl(baseUrl, payload, webPath = WEB_CLIENT_PATH) {
  const origin = /^[a-z]+:\/\/[^/]+/i.exec(String(baseUrl ?? '').trim())?.[0] ?? ''
  if (!origin) throw new Error('baseUrl 不合法')
  const encoded = toBase64Url(utf8Encode(JSON.stringify(payload)))
  return `${origin}${webPath}#p=${encoded}`
}

/**
 * 从绑定载荷得到可持久化的绑定信息（不含任何长期密钥，密钥由 keys.mjs 生成）。
 * 注意 `secret` 不进绑定记录：它是单次配对凭证，用一次就作废。
 * @param {PairingPayload} payload
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function bindingFromPayload(payload, options = {}) {
  const now = options.now ?? Date.now()
  const endpoints = mergeEndpointSources(payload, [])
  return {
    version: 1,
    computerId: payload.id,
    computerName: payload.host,
    computerPublicKey: typeof payload.pk === 'string' ? payload.pk : '',
    fingerprint: payload.fp,
    fingerprintDisplay: formatFingerprint(payload.fp),
    endpoints,
    webUrl: typeof payload.web === 'string' ? payload.web : '',
    mode: typeof payload.mode === 'string' ? payload.mode : 'auto',
    payloadVersion: typeof payload.version === 'string' ? payload.version : '',
    protocolVersion: PROTOCOL_VERSION,
    pairedAt: new Date(now).toISOString(),
  }
}

/**
 * 绑定之后重新连接要用的候选地址（preferred 优先 + 上次成功地址）。
 * @param {object} binding
 * @param {{mode?: string, preferred?: string, manualEndpoints?: string[]}} [options]
 * @returns {Array<{url: string, kind: string}>}
 */
export function candidatesForBinding(binding, options = {}) {
  const base = Array.isArray(binding?.endpoints) ? binding.endpoints : []
  const manual = Array.isArray(options.manualEndpoints) ? options.manualEndpoints : []
  /** @type {Map<string, string>} */
  const merged = new Map()
  for (const item of base) {
    if (item && typeof item.url === 'string') merged.set(item.url, item.kind)
  }
  for (const raw of manual) {
    const url = String(raw ?? '').trim()
    if (url !== '' && !merged.has(url)) merged.set(url, classifyEndpoint(url))
  }
  return orderCandidates(
    [...merged.entries()].map(([url, kind]) => ({ url, kind })),
    { mode: options.mode ?? binding?.mode ?? 'auto', preferred: options.preferred },
  )
}

/**
 * 绑定信息里给用户看的那一行（主机名 + 指纹尾段）。
 * @param {object} binding
 * @returns {string}
 */
export function describeBinding(binding) {
  const name = binding?.computerName ?? '我的电脑'
  const tail = String(binding?.fingerprint ?? '').replace(/[^0-9a-fA-F]/g, '').slice(-8).toUpperCase()
  return tail ? `${name} · 指纹 ${tail}` : String(name)
}

/**
 * 根据 User-Agent 给出设备名（电脑端的设备列表 / 多人协作时要显示昵称）。
 * @param {string} userAgent
 * @returns {string}
 */
export function deviceNameFromUserAgent(userAgent) {
  const ua = String(userAgent ?? '')
  if (/HarmonyOS/i.test(ua)) return '网页版 · 鸿蒙'
  if (/iPhone/i.test(ua)) return '网页版 · iPhone'
  if (/iPad/i.test(ua)) return '网页版 · iPad'
  if (/Android/i.test(ua)) return '网页版 · Android'
  if (/Macintosh|Mac OS X/i.test(ua)) return '网页版 · Mac'
  if (/Windows/i.test(ua)) return '网页版 · Windows'
  if (/Linux/i.test(ua)) return '网页版 · Linux'
  return '网页版 · 浏览器'
}

/**
 * 健康检查地址（手动地址预检）。
 * @param {string} baseUrl
 * @param {string} [healthPath]
 * @returns {string | undefined}
 */
export function healthUrl(baseUrl, healthPath = '/openwhale/health') {
  const match = /^(https?):\/\/([^/?#]+)/i.exec(String(baseUrl ?? '').trim())
  if (!match) return undefined
  return `${match[1].toLowerCase()}://${match[2]}${healthPath}`
}

/** 重新导出，方便调用方从一个模块拿齐绑定相关工具。 */
export { classifyEndpoint, DEFAULT_PORT, WS_PATH }
