// 字节 / Base64 工具：浏览器和 Node 都能跑，零依赖、不依赖 atob/btoa 的 latin1 怪癖。
//
// 为什么自己实现 base64：上传分块的 `dataBase64` 必须是标准 base64（协议约定），
// 而浏览器 `btoa` 只接受 latin1 字符串，Node 的 Buffer 又不存在于网页里。手写
// 编解码器两边行为一致，也方便 `node --test` 直接测。

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  /** @type {Record<string, number>} */
  const table = Object.create(null)
  for (let index = 0; index < B64_ALPHABET.length; index += 1) table[B64_ALPHABET[index]] = index
  return table
})()

/** @param {string} text */
export function utf8Encode(text) {
  return new TextEncoder().encode(String(text))
}

/** @param {Uint8Array | ArrayBuffer} bytes */
export function utf8Decode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return new TextDecoder('utf-8', { fatal: false }).decode(view)
}

/**
 * 标准 base64 编码（带 `=` 填充）。
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {string}
 */
export function toBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0
    output += B64_ALPHABET[a >> 2]
    output += B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)]
    output += index + 1 < bytes.length ? B64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : '='
    output += index + 2 < bytes.length ? B64_ALPHABET[c & 0x3f] : '='
  }
  return output
}

/**
 * 标准 base64 解码；非法字符直接抛错（调用方负责给出可读错误）。
 * @param {string} text
 * @returns {Uint8Array}
 */
export function fromBase64(text) {
  const clean = String(text ?? '').replace(/\s+/g, '')
  if (clean.length % 4 === 1) throw new Error('base64 长度不合法')
  const padded = clean.padEnd(clean.length + ((4 - (clean.length % 4)) % 4), '=')
  const out = []
  for (let index = 0; index < padded.length; index += 4) {
    const chunk = padded.slice(index, index + 4)
    const v0 = B64_LOOKUP[chunk[0]]
    const v1 = B64_LOOKUP[chunk[1]]
    if (v0 === undefined || v1 === undefined) throw new Error('base64 含非法字符')
    const v2 = chunk[2] === '=' ? 0 : B64_LOOKUP[chunk[2]]
    const v3 = chunk[3] === '=' ? 0 : B64_LOOKUP[chunk[3]]
    if (v2 === undefined || v3 === undefined) throw new Error('base64 含非法字符')
    out.push((v0 << 2) | (v1 >> 4))
    if (chunk[2] !== '=') out.push(((v1 & 0x0f) << 4) | (v2 >> 2))
    if (chunk[3] !== '=') out.push(((v2 & 0x03) << 6) | v3)
  }
  return Uint8Array.from(out)
}

/**
 * base64url 编码（`-`/`_`，无填充）——绑定二维码与密钥都用它。
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {string}
 */
export function toBase64Url(input) {
  return toBase64(input).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * base64url 解码：宽容处理缺填充、标准 base64 混用。
 * @param {string} text
 * @returns {Uint8Array}
 */
export function fromBase64Url(text) {
  const normalized = String(text ?? '').replaceAll('-', '+').replaceAll('_', '/').replace(/\s+/g, '')
  return fromBase64(normalized)
}

/**
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * 定长比较，避免逐字节提前返回泄漏时序（密钥/签名比较用）。
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index]
  return diff === 0
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
export function randomBytes(length) {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hexFromBytes(bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * 人类可读体积，用于文件卡片和上传进度。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知大小'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}
