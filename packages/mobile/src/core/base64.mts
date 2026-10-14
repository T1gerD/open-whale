// 零依赖的 base64 / base64url / UTF-8 编解码。
//
// 为什么自己写而不用 Buffer 或 atob：核心逻辑必须能在没装任何依赖的机器上直接
// 用 `node` 跑通（见 README 的“测试”一节），而且 Hermes 上 atob 的历史行为并不
// 一致；自己实现也让编解码规则有单元测试覆盖。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 反向查表，避免每次解码都 indexOf。标准与 URL 两套字母表都能解。 */
const REVERSE = new Map<string, number>()
for (let i = 0; i < ALPHABET.length; i++) REVERSE.set(ALPHABET[i]!, i)
REVERSE.set('-', 62)
REVERSE.set('_', 63)

/** 标准 base64（带 `=` 填充），用于 WebSocket 帧里的文件分块。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += ALPHABET[b0 >> 2]
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f]
  }
  return out
}

/**
 * 解 base64。遇到非法字符直接抛错，而不是静默产出错误字节——签名和公钥一旦被
 * 悄悄破坏，故障会表现为“连不上”，极难排查。
 */
export function base64ToBytes(text: string): Uint8Array {
  const body = String(text).replace(/[\r\n\s]/g, '').replace(/=+$/, '')
  if (body.length === 0) return new Uint8Array(0)
  if (!/^[A-Za-z0-9+/\-_]+$/.test(body)) {
    throw new Error(`base64 内容非法：${body.slice(0, 16)}…`)
  }
  const out = new Uint8Array(Math.floor((body.length * 3) / 4))
  let acc = 0
  let bits = 0
  let index = 0
  for (let i = 0; i < body.length; i++) {
    const value = REVERSE.get(body[i]!)
    if (value === undefined) throw new Error(`base64 字符非法：${body[i]}`)
    // 只保留低 24 位，避免长期左移把整数推成浮点。
    acc = ((acc << 6) | value) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (acc >> bits) & 0xff
    }
  }
  return out.slice(0, index)
}

/** base64url（无填充），用于协议里的密钥、签名、id。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function base64UrlToBytes(text: string): Uint8Array {
  const normalized = String(text).trim().replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(normalized)
}

/**
 * 手写 UTF-8 编码：签名时消息里可能出现中文（例如设备名），而 Hermes 不保证有
 * TextEncoder。代理对（emoji）按 codePointAt 一次消费两个 UTF-16 码元。
 */
export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)
    if (code === undefined) continue
    if (code > 0xffff) i++
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/** UTF-8 字节数：用于核对协议里的长度上限（按字节而非 UTF-16 长度）。 */
export function utf8ByteLength(text: string): number {
  return utf8ToBytes(text).length
}

export function bytesToUtf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!
    let code: number
    let size: number
    if (b0 < 0x80) {
      code = b0
      size = 1
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f
      size = 2
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f
      size = 3
    } else if ((b0 & 0xf8) === 0xf0) {
      code = b0 & 0x07
      size = 4
    } else {
      // 非法起始字节：用替换字符占位而不是抛错，聊天内容不该因为一个坏字节整条丢失。
      out += '\uFFFD'
      i++
      continue
    }
    if (i + size > bytes.length) {
      out += '\uFFFD'
      break
    }
    for (let k = 1; k < size; k++) code = (code << 6) | (bytes[i + k]! & 0x3f)
    out += String.fromCodePoint(code)
    i += size
  }
  return out
}
