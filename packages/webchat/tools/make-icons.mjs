// 生成 PWA 图标（零依赖：只用 node:zlib 手写 PNG）。
//
// 为什么不用 canvas/sharp：本仓库要求 `node --check`/测试在裸 Node 下可跑，
// 图标是构建期一次性产物，没必要为此引入原生依赖。改动图标后运行：
//   node packages/webchat/tools/make-icons.mjs
// 产物（已提交）：icons/icon-192.png、icon-512.png、icon-maskable-512.png、
// apple-touch-icon.png；icons/icon.svg 是手写的矢量版，浏览器优先用 SVG。
//
// 图形是「鲸歌 + 声呐」：深海渐变底、两道白色声波、右上一点鲸蓝/青绿信号点。

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')

/** @param {number[][]} table */
function buildCrcTable() {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
}

const CRC_TABLE = buildCrcTable()

/** @param {Buffer} buffer */
function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const clamp01 = value => Math.min(1, Math.max(0, value))

/** 平滑边缘：alpha 在 [edge - feather, edge + feather] 之间过渡。 */
function coverage(distance, edge, feather = 0.004) {
  return clamp01((edge + feather - distance) / (2 * feather))
}

/**
 * 在单位坐标（0..1）上绘制一枚图标。
 * @param {number} u
 * @param {number} v
 * @param {{maskable?: boolean}} options
 */
function sampleIcon(u, v, options = {}) {
  const maskable = options.maskable === true
  // 背景：深海底色 + 右上鲸蓝光晕 + 左下青绿余光。
  const glowDistance = Math.hypot(u - 0.78, v - 0.18)
  const tealDistance = Math.hypot(u - 0.12, v - 0.92)
  const glow = Math.max(0, 1 - glowDistance / 0.85) ** 2
  const teal = Math.max(0, 1 - tealDistance / 0.6) ** 2
  let r = 7 + glow * 60 + teal * 6
  let g = 13 + glow * 95 + teal * 90
  let b = 25 + glow * 200 + teal * 105
  let a = 1

  // 非 maskable 图标做圆角（iOS/Android 桌面会对图标再裁一次，圆角更统一）。
  if (!maskable) {
    const radius = 0.22
    const dx = Math.max(radius - u, 0, u - (1 - radius))
    const dy = Math.max(radius - v, 0, v - (1 - radius))
    const distance = Math.hypot(dx, dy)
    a = coverage(distance, radius, 0.006)
  }

  // glyph 区域：maskable 收进中心 72%（安全区），普通图标用 100%。
  const scale = maskable ? 0.72 : 1
  const gu = (u - 0.5) / scale + 0.5
  const gv = (v - 0.5) / scale + 0.5

  /** 在 glyph 坐标上叠加一条白色声波。 */
  const wave = (baseY, amplitude, frequency, phase, thickness, alpha) => {
    if (gu < 0.12 || gu > 0.88) return 0
    const t = (gu - 0.12) / 0.76
    const y = baseY + Math.sin(t * Math.PI * 2 * frequency + phase) * amplitude
    const distance = Math.abs(gv - y)
    // 两端做淡出，避免声波像被刀切平。
    const edgeFade = Math.min(1, (gu - 0.12) / 0.05) * Math.min(1, (0.88 - gu) / 0.05)
    return coverage(distance, thickness, 0.012) * alpha * edgeFade
  }
  const wave1 = wave(0.6, 0.052, 1.15, 0, 0.03, 1)
  const wave2 = wave(0.47, 0.05, 1.15, 1.1, 0.024, 0.55)
  const signalX = gu - 0.71
  const signalY = gv - 0.3
  const signal = coverage(Math.hypot(signalX, signalY), 0.055, 0.012)

  /** @param {number} amount @param {number[]} color */
  const blend = (amount, [cr, cg, cb]) => {
    const alpha = clamp01(amount)
    if (alpha <= 0) return
    r = r * (1 - alpha) + cr * alpha
    g = g * (1 - alpha) + cg * alpha
    b = b * (1 - alpha) + cb * alpha
  }
  blend(wave2, [235, 243, 255])
  blend(wave1, [255, 255, 255])
  blend(signal, [55, 211, 182])

  return [Math.round(clamp01(r / 255) * 255), Math.round(clamp01(g / 255) * 255), Math.round(clamp01(b / 255) * 255), Math.round(a * 255)]
}

/**
 * 超采样渲染（4x）后做盒式降采样，得到平滑边缘。
 * @param {number} size
 * @param {{maskable?: boolean}} [options]
 */
function renderIcon(size, options = {}) {
  const scale = 4
  const big = size * scale
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const u = (x * scale + sx + 0.5) / big
          const v = (y * scale + sy + 0.5) / big
          const [pr, pg, pb, pa] = sampleIcon(u, v, options)
          r += pr * pa
          g += pg * pa
          b += pb * pa
          a += pa
        }
      }
      const offset = (y * size + x) * 4
      if (a === 0) {
        rgba[offset] = 0
        rgba[offset + 1] = 0
        rgba[offset + 2] = 0
        rgba[offset + 3] = 0
      } else {
        rgba[offset] = Math.round(r / a)
        rgba[offset + 1] = Math.round(g / a)
        rgba[offset + 2] = Math.round(b / a)
        rgba[offset + 3] = Math.round(a / (scale * scale))
      }
    }
  }
  return rgba
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  /** @type {Array<{file: string, size: number, maskable?: boolean}>} */
  const targets = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
    { file: 'apple-touch-icon.png', size: 180 },
  ]
  for (const target of targets) {
    const rgba = renderIcon(target.size, { maskable: target.maskable === true })
    const png = encodePng(target.size, target.size, rgba)
    writeFileSync(join(OUT_DIR, target.file), png)
    console.log(`icons/${target.file}  ${png.length} bytes`)
  }
}

main()
