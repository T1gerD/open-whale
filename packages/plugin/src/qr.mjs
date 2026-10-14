// Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
//
// Why in-tree instead of the `qrcode` npm package: the plugin must install and
// run with no build step and no dependency tree, because a binding QR code is the
// one thing that must work before anything else does. This is a complete
// byte-mode encoder (versions 1-40, all four EC levels, all eight masks,
// automatic version and mask selection) producing the matrix directly, which we
// then render as SVG (browser page) or PNG (decoded by the phone camera).
//
// PNPM's isolated linker also refused to make `qrcode`'s transitive deps
// resolvable from this package, so removing the dependency removes a whole class
// of install-time failure.
//
// Reference: ISO/IEC 18004:2015 tables 9 (EC blocks) and 1 (capacities). The
// capacity table below is generated from the block table, so the two cannot drift.
import { deflateSync } from 'node:zlib'

/** Error-correction levels, indexed by their two-bit format value. */
export const EC_LEVEL = { L: 0, M: 1, Q: 2, H: 3 }

/** Format-information bits for each (level, mask) pair: BCH(15,5) protected, XOR 0x5412. */
const FORMAT_BITS = (() => {
  const table = new Map()
  const generator = 0b10100110111
  for (const [level, levelBits] of [[0, 1], [1, 0], [2, 3], [3, 2]]) {
    for (let mask = 0; mask < 8; mask++) {
      const data = (levelBits << 3) | mask
      let remainder = data << 10
      for (let i = 4; i >= 0; i--) {
        if (remainder & (1 << (i + 10))) remainder ^= generator << i
      }
      table.set(`${level}:${mask}`, ((data << 10) | remainder) ^ 0b101010000010010)
    }
  }
  return table
})()

/** Version information for versions 7-40: BCH(18,6) protected. */
const VERSION_BITS = (() => {
  const generator = 0b1111100100101
  const table = new Map()
  for (let version = 7; version <= 40; version++) {
    let remainder = version << 12
    for (let i = 5; i >= 0; i--) {
      if (remainder & (1 << (i + 12))) remainder ^= generator << i
    }
    table.set(version, (version << 12) | remainder)
  }
  return table
})()

/**
 * Error-correction block structure.
 * Each entry is `[ecCodewordsPerBlock, blocksInGroup1, dataCodewordsGroup1, blocksInGroup2, dataCodewordsGroup2]`
 * for levels L, M, Q, H in that order. Source: ISO/IEC 18004 table 9.
 */
const EC_BLOCKS = {
  1: [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
  2: [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
  3: [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
  4: [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
  5: [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
  6: [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
  7: [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
  8: [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
  9: [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
  10: [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
  11: [[20, 4, 81, 0, 0], [30, 1, 50, 4, 51], [28, 4, 22, 4, 23], [24, 3, 12, 8, 13]],
  12: [[24, 2, 92, 2, 93], [22, 6, 36, 2, 37], [26, 4, 20, 6, 21], [28, 7, 14, 4, 15]],
  13: [[26, 4, 107, 0, 0], [22, 8, 37, 1, 38], [24, 8, 20, 4, 21], [22, 12, 11, 4, 12]],
  14: [[30, 3, 115, 1, 116], [24, 4, 40, 5, 41], [20, 11, 16, 5, 17], [24, 11, 12, 5, 13]],
  15: [[22, 5, 87, 1, 88], [24, 5, 41, 5, 42], [30, 5, 24, 7, 25], [24, 11, 12, 7, 13]],
  16: [[24, 5, 98, 1, 99], [28, 7, 45, 3, 46], [24, 15, 19, 2, 20], [30, 3, 15, 13, 16]],
  17: [[28, 1, 107, 5, 108], [28, 10, 46, 1, 47], [28, 1, 22, 15, 23], [28, 2, 14, 17, 15]],
  18: [[30, 5, 120, 1, 121], [26, 9, 43, 4, 44], [28, 17, 22, 1, 23], [28, 2, 14, 19, 15]],
  19: [[28, 3, 113, 4, 114], [26, 3, 44, 11, 45], [26, 17, 21, 4, 22], [26, 9, 13, 16, 14]],
  20: [[28, 3, 107, 5, 108], [26, 3, 41, 13, 42], [30, 15, 24, 5, 25], [28, 15, 15, 10, 16]],
  21: [[28, 4, 116, 4, 117], [26, 17, 42, 0, 0], [28, 17, 22, 6, 23], [30, 19, 16, 6, 17]],
  22: [[28, 2, 111, 7, 112], [28, 17, 46, 0, 0], [30, 7, 24, 16, 25], [24, 34, 13, 0, 0]],
  23: [[30, 4, 121, 5, 122], [28, 4, 47, 14, 48], [30, 11, 24, 14, 25], [30, 16, 15, 14, 16]],
  24: [[30, 6, 117, 4, 118], [28, 6, 45, 14, 46], [30, 11, 24, 16, 25], [30, 30, 16, 2, 17]],
  25: [[26, 8, 106, 4, 107], [28, 8, 47, 13, 48], [30, 7, 24, 22, 25], [30, 22, 15, 13, 16]],
  26: [[28, 10, 114, 2, 115], [28, 19, 46, 4, 47], [28, 28, 22, 6, 23], [30, 33, 16, 4, 17]],
  27: [[30, 8, 122, 4, 123], [28, 22, 45, 3, 46], [30, 8, 23, 26, 24], [30, 12, 15, 28, 16]],
  28: [[30, 3, 117, 10, 118], [28, 3, 45, 23, 46], [30, 4, 24, 31, 25], [30, 11, 15, 31, 16]],
  29: [[30, 7, 116, 7, 117], [28, 21, 45, 7, 46], [30, 1, 23, 37, 24], [30, 19, 15, 26, 16]],
  30: [[30, 5, 115, 10, 116], [28, 19, 47, 10, 48], [30, 15, 24, 25, 25], [30, 23, 15, 25, 16]],
  31: [[30, 13, 115, 3, 116], [28, 2, 46, 29, 47], [30, 42, 24, 1, 25], [30, 23, 15, 28, 16]],
  32: [[30, 17, 115, 0, 0], [28, 10, 46, 23, 47], [30, 10, 24, 35, 25], [30, 19, 15, 35, 16]],
  33: [[30, 17, 115, 1, 116], [28, 14, 46, 21, 47], [30, 29, 24, 19, 25], [30, 11, 15, 46, 16]],
  34: [[30, 13, 115, 6, 116], [28, 14, 46, 23, 47], [30, 44, 24, 7, 25], [30, 59, 16, 1, 17]],
  35: [[30, 12, 121, 7, 122], [28, 12, 47, 26, 48], [30, 39, 24, 14, 25], [30, 22, 15, 41, 16]],
  36: [[30, 6, 121, 14, 122], [28, 6, 47, 34, 48], [30, 46, 24, 10, 25], [30, 2, 15, 64, 16]],
  37: [[30, 17, 122, 4, 123], [28, 29, 46, 14, 47], [30, 49, 24, 10, 25], [30, 24, 15, 46, 16]],
  38: [[30, 4, 122, 18, 123], [28, 13, 46, 32, 47], [30, 48, 24, 14, 25], [30, 42, 15, 32, 16]],
  39: [[30, 20, 117, 4, 118], [28, 40, 47, 7, 48], [30, 43, 24, 22, 25], [30, 10, 15, 67, 16]],
  40: [[30, 19, 118, 6, 119], [28, 18, 47, 31, 48], [30, 34, 24, 34, 25], [30, 20, 15, 61, 16]],
}

/** Total codewords per version (data + EC), from the standard's capacity table. */
const TOTAL_CODEWORDS = (() => {
  const table = new Map()
  for (const [version, blocks] of Object.entries(EC_BLOCKS)) {
    const [ecPerBlock, b1, d1, b2, d2] = blocks[0]
    table.set(Number(version), (b1 + b2) * ecPerBlock + b1 * d1 + b2 * d2)
  }
  return table
})()

/**
 * Alignment pattern centre coordinates per version.
 * @param {number} version
 * @returns {number[]}
 */
export function alignmentPositions(version) {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (count * 2 - 2)) * 2
  const positions = [6]
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos)
  return positions
}

/** @param {number} version */
export function moduleCount(version) {
  return version * 4 + 17
}

/** Data capacity in codewords for a version/level. */
export function dataCodewordCount(version, level) {
  const [ecPerBlock, b1, d1, b2, d2] = EC_BLOCKS[version][EC_LEVEL[level]]
  return b1 * d1 + b2 * d2
}

/** Maximum byte-mode payload in bytes for a version/level (mode + length header removed). */
export function byteCapacity(version, level) {
  const codewords = dataCodewordCount(version, level)
  const lengthBits = version < 10 ? 8 : 16
  return Math.floor((codewords * 8 - 4 - lengthBits) / 8)
}

// --- GF(256) arithmetic for Reed-Solomon -------------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/**
 * Build the generator polynomial for `degree` error-correction codewords.
 * @param {number} degree
 * @returns {Uint8Array}
 */
export function rsGenerator(degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/**
 * Compute the Reed-Solomon error-correction codewords for one block.
 * @param {Uint8Array} data
 * @param {number} ecCount
 * @returns {Uint8Array}
 */
export function rsEncode(data, ecCount) {
  const generator = rsGenerator(ecCount)
  const remainder = new Uint8Array(ecCount)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecCount - 1] = 0
    for (let i = 0; i < ecCount; i++) remainder[i] ^= gfMul(generator[i + 1], factor)
  }
  return remainder
}

// --- Data encoding -----------------------------------------------------------

/**
 * Encode a string as byte mode. Text is UTF-8 encoded by TextEncoder, which is
 * what a phone camera decodes back into the same string.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function toUtf8Bytes(text) {
  return new TextEncoder().encode(text)
}

/**
 * Build the final codeword sequence for the chosen version/level.
 * @param {Uint8Array} payload
 * @param {number} version
 * @param {keyof typeof EC_LEVEL} level
 * @returns {Uint8Array} interleaved data + EC codewords
 */
export function buildCodewords(payload, version, level) {
  const [ecPerBlock, b1, d1, b2, d2] = EC_BLOCKS[version][EC_LEVEL[level]]
  const totalData = b1 * d1 + b2 * d2
  const capacity = byteCapacity(version, level)
  if (payload.length > capacity) {
    throw new Error(`payload of ${payload.length} bytes exceeds version ${version}-${level} capacity of ${capacity}`)
  }

  // Bit stream: mode indicator 0100, character count, payload.
  const lengthBits = version < 10 ? 8 : 16
  const bits = []
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(payload.length, lengthBits)
  for (const byte of payload) push(byte, 8)

  // Terminator (up to four zero bits), pad to a byte boundary, then pad bytes.
  const capacityBits = totalData * 8
  push(0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (bits.length < capacityBits) {
    push(padBytes[padIndex++ % 2], 8)
  }

  const dataCodewords = new Uint8Array(totalData)
  for (let i = 0; i < totalData; i++) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j]
    dataCodewords[i] = byte
  }

  // Split into blocks, compute EC per block, then interleave per the standard.
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let block = 0; block < b1 + b2; block++) {
    const size = block < b1 ? d1 : d2
    const slice = dataCodewords.subarray(offset, offset + size)
    offset += size
    dataBlocks.push(slice)
    ecBlocks.push(rsEncode(slice, ecPerBlock))
  }

  const total = TOTAL_CODEWORDS.get(version)
  const output = new Uint8Array(total)
  let cursor = 0
  const maxData = Math.max(d1, d2)
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) output[cursor++] = block[i]
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) output[cursor++] = block[i]
  }
  return output
}

// --- Matrix -----------------------------------------------------------------

/** A QR matrix with immutable size, mutated only through this module. */
class Matrix {
  /** @param {number} size */
  constructor(size) {
    this.size = size
    this.modules = new Uint8Array(size * size)
    this.reserved = new Uint8Array(size * size)
  }

  /** @param {number} x @param {number} y */
  get(x, y) {
    return this.modules[y * this.size + x]
  }

  /** @param {number} x @param {number} y @param {number} value */
  set(x, y, value) {
    this.modules[y * this.size + x] = value
  }

  /** @param {number} x @param {number} y @param {number} value */
  setFunction(x, y, value) {
    this.set(x, y, value)
    this.reserved[y * this.size + x] = 1
  }

  /** @param {number} x @param {number} y */
  isReserved(x, y) {
    return this.reserved[y * this.size + x] === 1
  }

  clone() {
    const copy = new Matrix(this.size)
    copy.modules.set(this.modules)
    return copy
  }
}

function drawFinder(matrix, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      matrix.setFunction(x, y, distance === 2 || distance === 4 ? 0 : 1)
    }
  }
}

function drawAlignment(matrix, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      matrix.setFunction(cx + dx, cy + dy, distance === 1 ? 0 : 1)
    }
  }
}

function drawFunctionPatterns(matrix, version, level, mask) {
  const size = matrix.size

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    matrix.setFunction(6, i, i % 2 === 0 ? 1 : 0)
    matrix.setFunction(i, 6, i % 2 === 0 ? 1 : 0)
  }

  // Finders with separators.
  drawFinder(matrix, 3, 3)
  drawFinder(matrix, size - 4, 3)
  drawFinder(matrix, 3, size - 4)

  // Alignment patterns, skipping the three finder corners.
  const positions = alignmentPositions(version)
  for (const cy of positions) {
    for (const cx of positions) {
      const nearFinder = (cx === 6 && cy === 6)
        || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6)
      if (!nearFinder) drawAlignment(matrix, cx, cy)
    }
  }

  // Dark module.
  matrix.setFunction(8, size - 8, 1)

  // Format information (with the mask's format bits).
  const format = FORMAT_BITS.get(`${level}:${mask}`)
  for (let i = 0; i <= 5; i++) matrix.setFunction(8, i, (format >> i) & 1)
  matrix.setFunction(8, 7, (format >> 6) & 1)
  matrix.setFunction(8, 8, (format >> 7) & 1)
  matrix.setFunction(7, 8, (format >> 8) & 1)
  for (let i = 9; i <= 14; i++) matrix.setFunction(14 - i, 8, (format >> i) & 1)
  for (let i = 0; i <= 7; i++) matrix.setFunction(size - 1 - i, 8, (format >> i) & 1)
  for (let i = 8; i <= 14; i++) matrix.setFunction(8, size - 15 + i, (format >> i) & 1)
  // The dark module occupies (8, size-8) and must stay set after format drawing.
  matrix.setFunction(8, size - 8, 1)

  // Version information for versions 7+.
  if (version >= 7) {
    const bits = VERSION_BITS.get(version)
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1
      matrix.setFunction(Math.floor(i / 3), size - 11 + (i % 3), bit)
      matrix.setFunction(size - 11 + (i % 3), Math.floor(i / 3), bit)
    }
  }
}

function maskAt(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default: throw new Error(`invalid mask ${mask}`)
  }
}

function placeData(matrix, codewords, mask) {
  const size = matrix.size
  let bitIndex = 0
  const totalBits = codewords.length * 8
  const nextBit = () => {
    if (bitIndex >= totalBits) return 0
    const byte = codewords[bitIndex >> 3]
    const bit = (byte >> (7 - (bitIndex & 7))) & 1
    bitIndex++
    return bit
  }

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; skip the pair that contains it.
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        // Upward and downward alternate per column pair.
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (matrix.isReserved(x, y)) continue
        const bit = nextBit()
        matrix.set(x, y, maskAt(mask, x, y) ? bit ^ 1 : bit)
      }
    }
  }
}

/** Penalty score used to pick the best mask (ISO/IEC 18004 8.8.2). */
export function maskPenalty(matrix) {
  const size = matrix.size
  let penalty = 0

  const lineRuns = (getter) => {
    let linePenalty = 0
    for (let i = 0; i < size; i++) {
      let runColor = getter(i, 0)
      let runLength = 1
      for (let j = 1; j < size; j++) {
        const color = getter(i, j)
        if (color === runColor) {
          runLength++
        } else {
          if (runLength >= 5) linePenalty += 3 + (runLength - 5)
          runColor = color
          runLength = 1
        }
      }
      if (runLength >= 5) linePenalty += 3 + (runLength - 5)
    }
    return linePenalty
  }
  penalty += lineRuns((y, x) => matrix.get(x, y))
  penalty += lineRuns((x, y) => matrix.get(x, y))

  // 2x2 blocks of the same colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = matrix.get(x, y)
      if (color === matrix.get(x + 1, y) && color === matrix.get(x, y + 1) && color === matrix.get(x + 1, y + 1)) {
        penalty += 3
      }
    }
  }

  // Finder-like patterns 1011101 with four light modules on either side.
  const pattern = [1, 0, 1, 1, 1, 0, 1]
  const check = (values) => {
    for (let start = 0; start + 11 <= values.length; start++) {
      let matches = true
      for (let i = 0; i < 7 && matches; i++) {
        if (values[start + i] !== pattern[i]) matches = false
      }
      if (!matches) continue
      const quietBefore = values.slice(start + 7, start + 11).every(v => v === 0)
      const quietAfter = start - 4 >= 0 && values.slice(start - 4, start).every(v => v === 0)
      if (quietBefore || quietAfter) penalty += 40
    }
  }
  for (let y = 0; y < size; y++) {
    const row = []
    for (let x = 0; x < size; x++) row.push(matrix.get(x, y))
    check(row)
  }
  for (let x = 0; x < size; x++) {
    const column = []
    for (let y = 0; y < size; y++) column.push(matrix.get(x, y))
    check(column)
  }

  // Dark/light balance.
  let dark = 0
  for (const value of matrix.modules) dark += value
  const total = size * size
  const percent = (dark * 100) / total
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10

  return penalty
}

/**
 * Encode text into a QR matrix.
 * @param {string} text
 * @param {object} [options]
 * @param {'L'|'M'|'Q'|'H'} [options.level] Default 'M' (the phone-camera sweet spot).
 * @param {number} [options.minVersion]
 * @param {number} [options.version] Force an exact version (tests).
 * @returns {{version: number, level: string, size: number, modules: Uint8Array, isDark(x: number, y: number): boolean, mask: number}}
 */
export function encode(text, options = {}) {
  const level = options.level ?? 'M'
  if (!(level in EC_LEVEL)) throw new Error(`invalid EC level ${level}`)
  const payload = toUtf8Bytes(text)

  let version = options.version ?? options.minVersion ?? 1
  if (options.version === undefined) {
    while (version <= 40 && payload.length > byteCapacity(version, level)) version++
    if (version > 40) throw new Error(`内容过长，无法放入单个二维码（${payload.length} 字节）`)
  }
  if (payload.length > byteCapacity(version, level)) {
    throw new Error(`内容过长：${payload.length} 字节 > 版本 ${version}-${level} 的 ${byteCapacity(version, level)} 字节`)
  }

  const codewords = buildCodewords(payload, version, level)

  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const matrix = new Matrix(moduleCount(version))
    drawFunctionPatterns(matrix, version, EC_LEVEL[level], mask)
    placeData(matrix, codewords, mask)
    const penalty = maskPenalty(matrix)
    if (!best || penalty < best.penalty) best = { matrix, mask, penalty }
  }

  const matrix = /** @type {Matrix} */ (best?.matrix)
  return {
    version,
    level,
    size: matrix.size,
    mask: /** @type {number} */ (best?.mask),
    modules: matrix.modules,
    isDark: (x, y) => matrix.get(x, y) === 1,
  }
}

/**
 * Render a matrix as a standalone SVG string. Uses one path so the SVG stays
 * tiny even for version 40 (a per-module <rect> would be ~31k elements).
 * @param {ReturnType<typeof encode>} qr
 * @param {{margin?: number, scale?: number, dark?: string, light?: string}} [options]
 */
export function toSvg(qr, options = {}) {
  const margin = options.margin ?? 2
  const scale = options.scale ?? 8
  const size = qr.size
  const total = (size + margin * 2) * scale
  const segments = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.isDark(x, y)) continue
      segments.push(`M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`)
    }
  }
  const dark = options.dark ?? '#000000'
  const light = options.light ?? '#ffffff'
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
    `<rect width="${total}" height="${total}" fill="${light}"/>`,
    `<path d="${segments.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('')
}

/** CRC-32, needed for the PNG chunks below. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * Render a matrix as a 1-bit greyscale PNG.
 *
 * Greyscale is deliberate: a 1-bit image gives the camera the crispest possible
 * module edges, and no palette or colour profile is needed. Scale is expressed in
 * pixels per module so the printed size is predictable.
 * @param {ReturnType<typeof encode>} qr
 * @param {{margin?: number, scale?: number}} [options]
 * @returns {Buffer}
 */
export function toPng(qr, options = {}) {
  const margin = options.margin ?? 4
  const scale = options.scale ?? 8
  const modules = qr.size + margin * 2
  const pixels = modules * scale
  // Bit depth 1: each row starts with a filter byte (0 = None) then packed bits,
  // MSB first, where 1 is white and 0 is black in greyscale.
  const rowBytes = Math.ceil(pixels / 8)
  const raw = Buffer.alloc((rowBytes + 1) * pixels)
  for (let y = 0; y < pixels; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0
    for (let x = 0; x < pixels; x++) {
      const mx = Math.floor(x / scale) - margin
      const my = Math.floor(y / scale) - margin
      const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.isDark(mx, my)
      if (dark) continue // bit stays 0 = black
      const byteIndex = rowStart + 1 + (x >> 3)
      raw[byteIndex] |= 0x80 >> (x & 7) // white
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(pixels, 0)
  ihdr.writeUInt32BE(pixels, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // greyscale
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Render a matrix as ASCII for terminal display (`/openwhale` in a CLI).
 * Two vertical modules per character row using half-block glyphs keeps the code
 * square in a terminal.
 * @param {ReturnType<typeof encode>} qr
 * @param {{margin?: number, dark?: string, light?: string}} [options]
 */
export function toTerminal(qr, options = {}) {
  const margin = options.margin ?? 2
  const dark = options.dark ?? '██'
  const light = options.light ?? '  '
  const size = qr.size
  const lines = []
  for (let y = -margin; y < size + margin; y += 2) {
    let line = ''
    for (let x = -margin; x < size + margin; x++) {
      const top = x >= 0 && y >= 0 && x < size && y < size && qr.isDark(x, y)
      const bottom = x >= 0 && y + 1 >= 0 && x < size && y + 1 < size && qr.isDark(x, y + 1)
      if (top && bottom) line += dark
      else if (top) line += '▀▀'
      else if (bottom) line += '▄▄'
      else line += light
    }
    lines.push(line)
  }
  return lines.join('\n')
}
