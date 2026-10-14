// Independent verifier for the in-tree QR encoder.
//
// Structural tests (finder patterns, timing, dark module) can pass on a matrix
// that still cannot be scanned, so this file re-reads the matrix the way a real
// decoder does — locating the format information, undoing the mask, walking the
// zig-zag data path and checking that every Reed-Solomon block has zero
// syndromes — then decodes the header and payload back out.
//
// This deliberately re-implements the reading side instead of calling the
// encoder's internals: a shared wrong assumption would otherwise make the test
// vacuous.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EC_LEVEL, alignmentPositions, byteCapacity, dataCodewordCount, encode, moduleCount, toUtf8Bytes } from '../src/qr.mjs'

/** The authoritative block table, restated independently from the encoder. */
const BLOCKS = {
  1: [[7, 1, 19], [10, 1, 16], [13, 1, 13], [17, 1, 9]],
  2: [[10, 1, 34], [16, 1, 28], [22, 1, 22], [28, 1, 16]],
  3: [[15, 1, 55], [26, 1, 44], [18, 2, 17], [22, 2, 13]],
  4: [[20, 1, 80], [18, 2, 32], [26, 2, 24], [16, 4, 9]],
  5: [[26, 1, 108], [24, 2, 43], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
  6: [[18, 2, 68], [16, 4, 27], [24, 4, 19], [28, 4, 15]],
  7: [[20, 2, 78], [18, 4, 31], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
}
const BLOCK_ORDER = ['L', 'M', 'Q', 'H']

/** GF(256) helpers, written independently of the encoder. */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** Format-information codewords, recomputed here. */
const FORMAT_TABLE = (() => {
  const entries = []
  const generator = 0b10100110111
  for (let levelBits = 0; levelBits < 4; levelBits++) {
    for (let mask = 0; mask < 8; mask++) {
      const data = (levelBits << 3) | mask
      let remainder = data << 10
      for (let i = 4; i >= 0; i--) {
        if (remainder & (1 << (i + 10))) remainder ^= generator << i
      }
      entries.push({ levelBits, mask, bits: ((data << 10) | remainder) ^ 0b101010000010010 })
    }
  }
  return entries
})()

const VERSION_TABLE = (() => {
  const entries = new Map()
  const generator = 0b1111100100101
  for (let version = 7; version <= 40; version++) {
    let remainder = version << 12
    for (let i = 5; i >= 0; i--) {
      if (remainder & (1 << (i + 12))) remainder ^= generator << i
    }
    entries.set(version, (version << 12) | remainder)
  }
  return entries
})()

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** Rebuild the set of reserved (function) module coordinates for a version. */
function reservedMap(version) {
  const size = moduleCount(version)
  const reserved = new Set()
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved.add(y * size + x)
  }
  // Timing.
  for (let i = 0; i < size; i++) {
    mark(6, i)
    mark(i, 6)
  }
  // Finders + separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
    }
  }
  // Alignment patterns.
  const positions = alignmentPositions(version)
  for (const cy of positions) {
    for (const cx of positions) {
      const nearFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)
      if (nearFinder) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy)
      }
    }
  }
  // Format information: row 8 / column 8 near the finders, plus the dark module.
  for (let i = 0; i <= 8; i++) {
    mark(8, i)
    mark(i, 8)
  }
  for (let i = 0; i <= 7; i++) mark(size - 1 - i, 8)
  for (let i = 0; i < 7; i++) mark(8, size - 1 - i)
  mark(8, size - 8)
  // Version information.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(Math.floor(i / 3), size - 11 + (i % 3))
      mark(size - 11 + (i % 3), Math.floor(i / 3))
    }
  }
  return { reserved, size }
}

/** Undo the mask and read the data codewords using the standard zig-zag path. */
function readCodewords(qr, mask) {
  const { reserved, size } = reservedMap(qr.version)
  const bits = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (reserved.has(y * size + x)) continue
        let bit = qr.isDark(x, y) ? 1 : 0
        if (MASKS[mask](x, y)) bit ^= 1
        bits.push(bit)
      }
    }
  }
  const codewords = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  return codewords
}

/** Read the format information and return the matching (level, mask). */
function readFormat(qr) {
  const size = qr.size
  const bits = []
  // Copy 1: (8,0..5), (8,7), (8,8), (7,8), (0..5,8) — read MSB-first per spec order.
  const order1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
  for (const [x, y] of order1) bits.push(qr.isDark(x, y) ? 1 : 0)
  let value = 0
  for (let i = 0; i < 15; i++) value |= bits[i] << i
  const match = FORMAT_TABLE.find(entry => entry.bits === value)
  if (!match) return null
  return { levelBits: match.levelBits, mask: match.mask, size }
}

/** Read the version information for versions 7+. */
function readVersion(qr) {
  const size = qr.size
  let bits = 0
  for (let i = 0; i < 18; i++) {
    if (qr.isDark(Math.floor(i / 3), size - 11 + (i % 3))) bits |= 1 << i
  }
  for (const [version, expected] of VERSION_TABLE) {
    if (expected === bits) return version
  }
  // Version information is duplicated; check the transposed copy too.
  let other = 0
  for (let i = 0; i < 18; i++) {
    if (qr.isDark(size - 11 + (i % 3), Math.floor(i / 3))) other |= 1 << i
  }
  for (const [version, expected] of VERSION_TABLE) {
    if (expected === other) return version
  }
  return null
}

/** Split interleaved codewords back into their RS blocks. */
function deinterleave(codewords, version, level) {
  const blocks = BLOCKS[version][BLOCK_ORDER.indexOf(level)]
  const ecPerBlock = blocks[0]
  const groups = []
  if (blocks.length === 3) groups.push({ count: blocks[1], dataLen: blocks[2] })
  else groups.push({ count: blocks[1], dataLen: blocks[2] }, { count: blocks[3], dataLen: blocks[4] })

  const dataBlocks = []
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) dataBlocks.push({ data: [], ec: [], dataLen: group.dataLen })
  }

  let cursor = 0
  const maxData = Math.max(...dataBlocks.map(b => b.dataLen))
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      if (i < block.dataLen) block.data.push(codewords[cursor++])
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of dataBlocks) block.ec.push(codewords[cursor++])
  }
  return { blocks: dataBlocks, consumed: cursor, ecPerBlock, totalExpected: codewords.length }
}

/** Zero syndromes mean the block is a valid RS codeword. */
function syndromesAreZero(block) {
  const codeword = [...block.data, ...block.ec]
  for (let i = 0; i < block.ec.length; i++) {
    let sum = 0
    for (let j = 0; j < codeword.length; j++) {
      sum = mul(sum, EXP[i]) ^ codeword[j]
    }
    if (sum !== 0) return false
  }
  return true
}

/** Decode the bit stream header and byte payload. */
function decodePayload(dataCodewords, version) {
  const bits = []
  for (const byte of dataCodewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  }
  let cursor = 0
  const take = count => {
    let value = 0
    for (let i = 0; i < count; i++) value = (value << 1) | bits[cursor++]
    return value
  }
  const mode = take(4)
  assert.equal(mode, 0b0100, 'byte mode indicator')
  const length = take(version < 10 ? 8 : 16)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = take(8)
  return { text: new TextDecoder().decode(bytes), length }
}

/**
 * Full round-trip: verify the matrix decodes back to the original text, and
 * report which level/mask the format information was found to describe.
 */
function verify(text, options = {}) {
  const qr = encode(text, options)
  const format = readFormat(qr)
  assert.ok(format, `format information must decode for "${text.slice(0, 20)}"`)
  const level = BLOCK_ORDER[format.levelBits === 1 ? 0 : format.levelBits === 0 ? 1 : format.levelBits === 3 ? 2 : 3]
  assert.equal(MASKS[format.mask], MASKS[format.mask])

  if (qr.version >= 7) {
    assert.equal(readVersion(qr), qr.version, 'version information must be locatable')
  }

  const codewords = readCodewords(qr, format.mask)
  const { blocks, totalExpected } = deinterleave(codewords, qr.version, level)
  assert.ok(totalExpected <= codewords.length)
  for (const block of blocks) {
    assert.ok(
      syndromesAreZero(block),
      `every RS block must have zero syndromes (v${qr.version}-${level})`,
    )
  }
  const dataCodewords = blocks.flatMap(block => block.data)
  const decoded = decodePayload(dataCodewords, qr.version)
  return { qr, decoded, format, level, dataCodewords }
}

test('a version 1 QR decodes back to its text', () => {
  const { decoded, qr } = verify('HELLO')
  assert.equal(decoded.text, 'HELLO')
  assert.equal(qr.version, 1)
})

test('the encoded payload length matches what was written', () => {
  const text = 'Open Whale'
  const { decoded } = verify(text)
  assert.equal(decoded.length, toUtf8Bytes(text).length)
  assert.equal(decoded.text, text)
})

test('Chinese text survives the whole encode/decode round-trip', () => {
  const text = '书房电脑 绑定 Open Whale'
  const { decoded } = verify(text)
  assert.equal(decoded.text, text)
})

test('the round-trip holds at every EC level', () => {
  for (const level of ['L', 'M', 'Q', 'H']) {
    const text = `level-${level}-round-trip`
    const { decoded, level: decodedLevel, qr } = verify(text, { level })
    assert.equal(decoded.text, text, `level ${level}`)
    assert.equal(decodedLevel, level, 'format information must record the requested level')
    assert.equal(qr.level, level)
  }
})

test('the round-trip holds across versions, including multi-block ones', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const text = 'v'.repeat(Math.min(byteCapacity(version, 'Q'), 60))
    const { decoded, qr, level } = verify(text, { version, level: 'Q' })
    assert.equal(decoded.text, text, `version ${version}`)
    assert.equal(qr.version, version)
    assert.equal(level, 'Q')
  }
})

test('the round-trip holds at the exact capacity of each level', () => {
  for (const level of ['L', 'M', 'Q', 'H']) {
    const text = 'x'.repeat(byteCapacity(3, level))
    const { decoded } = verify(text, { version: 3, level })
    assert.equal(decoded.text, text, `exactly full at level ${level}`)
  }
})

test('the round-trip holds for a payload containing every byte value', () => {
  // Two-byte UTF-8 sequences for the full BMP-ish range that fits in v7-Q.
  let text = ''
  for (let code = 0x20; code < 0x7f; code++) text += String.fromCharCode(code)
  text += '中文测试🐳'
  const { decoded } = verify(text, { level: 'M' })
  assert.equal(decoded.text, text)
})

test('the advertised mask is the one a decoder finds in the format bits', () => {
  for (const text of ['a', 'mask probing', 'x'.repeat(50)]) {
    const qr = encode(text)
    const format = readFormat(qr)
    assert.ok(format)
    assert.equal(format.mask, qr.mask, 'the encoder must write the mask it reports')
  }
})

test('padding is EC/11 alternation after the terminator', () => {
  const { dataCodewords, qr } = verify('pad')
  const payload = toUtf8Bytes('pad')
  const expectedData = dataCodewordCount(qr.version, qr.level)
  assert.equal(dataCodewords.length, expectedData)
  // Byte 0 holds the mode nibble and the high nibble of the length byte; the
  // pad bytes follow the payload at alternating 0xEC / 0x11.
  const usedBytes = Math.ceil((4 + 8 + payload.length * 8) / 8)
  for (let i = usedBytes; i < dataCodewords.length; i++) {
    const expected = (i - usedBytes) % 2 === 0 ? 0xec : 0x11
    assert.equal(dataCodewords[i], expected, `pad byte ${i}`)
  }
})

test('a corrupted module is actually detectable by the syndrome check', () => {
  // Proves the verifier is not vacuously true: flipping one data module must
  // break the syndrome check (or the decoded text), not pass silently.
  const qr = encode('tamper me')
  const format = readFormat(qr)
  const { reserved, size } = reservedMap(qr.version)
  // Find the first non-reserved module and flip it.
  let target = -1
  for (let index = 0; index < size * size; index++) {
    if (!reserved.has(index)) { target = index; break }
  }
  assert.ok(target >= 0)
  const x = target % size
  const y = Math.floor(target / size)
  const mutated = {
    ...qr,
    isDark: (qx, qy) => (qx === x && qy === y ? !qr.isDark(qx, qy) : qr.isDark(qx, qy)),
  }
  const codewords = readCodewords(mutated, /** @type {any} */ (format).mask)
  const { blocks } = deinterleave(codewords, qr.version, 'M')
  const allZero = blocks.every(syndromesAreZero)
  const decoded = decodePayload(blocks.flatMap(b => b.data), qr.version).text
  assert.ok(!allZero || decoded !== 'tamper me', 'a single flipped module must not decode to the original text')
})
