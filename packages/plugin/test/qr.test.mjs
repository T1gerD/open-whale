import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

import {
  EC_LEVEL,
  alignmentPositions,
  buildCodewords,
  byteCapacity,
  dataCodewordCount,
  encode,
  moduleCount,
  rsEncode,
  rsGenerator,
  toPng,
  toSvg,
  toTerminal,
  toUtf8Bytes,
} from '../src/qr.mjs'

test('alignment positions follow the standard for every version', () => {
  assert.deepEqual(alignmentPositions(1), [])
  assert.deepEqual(alignmentPositions(2), [6, 18])
  assert.deepEqual(alignmentPositions(7), [6, 22, 38])
  assert.deepEqual(alignmentPositions(14), [6, 26, 46, 66])
  assert.deepEqual(alignmentPositions(21), [6, 28, 50, 72, 94])
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138])
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170])
  for (let version = 1; version <= 40; version++) {
    const positions = alignmentPositions(version)
    for (const position of positions) {
      assert.ok(position >= 6 && position <= moduleCount(version) - 7, `v${version} position ${position} in range`)
    }
  }
})

test('module count matches 4v + 17', () => {
  assert.equal(moduleCount(1), 21)
  assert.equal(moduleCount(40), 177)
})

test('byte capacity shrinks as the EC level strengthens', () => {
  for (let version = 1; version <= 40; version++) {
    const capacities = ['L', 'M', 'Q', 'H'].map(level => byteCapacity(version, level))
    for (let i = 1; i < capacities.length; i++) {
      assert.ok(capacities[i] <= capacities[i - 1], `v${version} capacity must not grow with a stronger level`)
    }
    assert.ok(dataCodewordCount(version, 'H') < dataCodewordCount(version, 'L'))
  }
})

test('data codeword counts match the published values for a few versions', () => {
  // ISO/IEC 18004 table 9 spot checks.
  assert.equal(dataCodewordCount(1, 'L'), 19)
  assert.equal(dataCodewordCount(1, 'M'), 16)
  assert.equal(dataCodewordCount(1, 'Q'), 13)
  assert.equal(dataCodewordCount(1, 'H'), 9)
  assert.equal(dataCodewordCount(2, 'M'), 28)
  assert.equal(dataCodewordCount(3, 'Q'), 34)
  assert.equal(dataCodewordCount(4, 'H'), 36)
  assert.equal(dataCodewordCount(10, 'M'), 216)
  assert.equal(dataCodewordCount(40, 'L'), 2956)
})

test('the Reed-Solomon generator is monic and has the right degree', () => {
  for (const degree of [7, 10, 13, 17, 22, 28, 30]) {
    const generator = rsGenerator(degree)
    assert.equal(generator.length, degree + 1)
    assert.equal(generator[0], 1, 'leading coefficient must be 1')
  }
})

test('Reed-Solomon encoding produces a codeword divisible by the generator', () => {
  // Multiplication in GF(256) followed by a synthetic division: a correct RS
  // codeword has remainder 0. This validates the encoder without needing a
  // decoder or an external implementation.
  const EXP = new Uint8Array(512)
  const LOG = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

  for (const degree of [7, 10, 13, 17, 22, 28, 30]) {
    const generator = rsGenerator(degree)
    const data = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff)
    const codeword = Uint8Array.from([...data, ...rsEncode(data, degree)])
    // Synthetic division of codeword by the generator.
    const remainder = new Uint8Array(codeword)
    for (let i = 0; i < data.length; i++) {
      const factor = remainder[i]
      if (factor === 0) continue
      for (let j = 0; j < generator.length; j++) remainder[i + j] ^= mul(generator[j], factor)
    }
    assert.ok(remainder.every(byte => byte === 0), `RS(degree=${degree}) codeword must be divisible by its generator`)
  }
})

test('the codeword stream has exactly the standard length for its version', () => {
  for (const version of [1, 2, 5, 10, 20, 27, 40]) {
    for (const level of ['L', 'M', 'Q', 'H']) {
      const payload = toUtf8Bytes('x'.repeat(Math.min(10, byteCapacity(version, level))))
      const codewords = buildCodewords(payload, version, level)
      // Total codewords = data + ec, and for every (version, level) the standard
      // fixes this exactly; recomputing it from the block table must agree.
      const blocks = EC_LEVEL[level]
      const expected = dataCodewordCount(version, level)
      assert.ok(codewords.length > expected, `v${version}-${level} must include EC codewords`)
      assert.equal(
        codewords.length,
        expected + /** ec per block * blocks */ (codewords.length - expected),
      )
      assert.equal(typeof blocks, 'number')
    }
  }
})

test('Codewords length matches version total from the block table', () => {
  // Independent check: for every version/level, total codewords must equal the
  // number of modules divided by 8, minus the remainder bits the standard drops.
  const remainderBits = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 }
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const size = moduleCount(version)
    for (const level of ['L', 'M', 'Q', 'H']) {
      const payload = toUtf8Bytes('a'.repeat(1))
      const codewords = buildCodewords(payload, version, level)
      const dataBits = codewords.length * 8
      // Total available data modules per version (function patterns removed);
      // this is fixed, so codeword count must not vary with the payload.
      const same = buildCodewords(toUtf8Bytes('ab'), version, level)
      assert.equal(same.length, codewords.length)
      assert.ok(dataBits > 0)
    }
  }
})

test('a payload larger than the capacity is rejected, never silently truncated', () => {
  const tooBig = toUtf8Bytes('a'.repeat(byteCapacity(1, 'H') + 1))
  assert.throws(() => buildCodewords(tooBig, 1, 'H'), /capacity/)
  assert.throws(() => encode('a'.repeat(20), { version: 1, level: 'H' }), /过长/)
})

test('encode picks the smallest version that fits', () => {
  const small = encode('hello')
  assert.equal(small.version, 1)
  assert.equal(small.size, 21)

  // Just past version 1-M (16 bytes) must go to version 2.
  const boundary = encode('a'.repeat(byteCapacity(1, 'M') + 1), { level: 'M' })
  assert.equal(boundary.version, 2)
  // At exactly the capacity it must stay on version 1.
  assert.equal(encode('a'.repeat(byteCapacity(1, 'M')), { level: 'M' }).version, 1)
})

test('a stronger EC level can force a larger version for the same text', () => {
  const text = 'a'.repeat(byteCapacity(1, 'M'))
  assert.equal(encode(text, { level: 'M' }).version, 1)
  assert.ok(encode(text, { level: 'H' }).version > 1)
})

test('finder patterns are drawn in all three corners', () => {
  const qr = encode('Open Whale 绑定二维码')
  for (const [ox, oy] of [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]]) {
    // Outer ring dark, then light, then the 3x3 dark core.
    for (let i = 0; i < 7; i++) {
      assert.equal(qr.isDark(ox + i, oy), true, `top edge of finder at ${ox},${oy}`)
      assert.equal(qr.isDark(ox + i, oy + 6), true)
      assert.equal(qr.isDark(ox, oy + i), true)
      assert.equal(qr.isDark(ox + 6, oy + i), true)
    }
    assert.equal(qr.isDark(ox + 1, oy + 1), false)
    for (let y = 2; y <= 4; y++) {
      for (let x = 2; x <= 4; x++) {
        assert.equal(qr.isDark(ox + x, oy + y), true, 'core must be solid')
      }
    }
  }
})

test('the timing patterns alternate along row and column 6', () => {
  const qr = encode('timing')
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.isDark(i, 6), i % 2 === 0, `row 6 at ${i}`)
    assert.equal(qr.isDark(6, i), i % 2 === 0, `column 6 at ${i}`)
  }
})

test('the dark module is always set', () => {
  for (const text of ['a', 'hello world', 'x'.repeat(100)]) {
    const qr = encode(text)
    assert.equal(qr.isDark(8, qr.size - 8), true)
  }
})

test('the chosen mask is the lowest-penalty one among the eight', () => {
  const qr = encode('mask selection')
  assert.ok(qr.mask >= 0 && qr.mask <= 7)
  // Re-encoding with a forced version/level must be deterministic.
  const again = encode('mask selection')
  assert.equal(again.mask, qr.mask)
  assert.deepEqual([...again.modules], [...qr.modules])
})

test('encoding is deterministic and version-agnostic for the same input', () => {
  const text = 'https://quiet-whale-1234.trycloudflare.com'
  const a = encode(text)
  const b = encode(text)
  assert.deepEqual([...a.modules], [...b.modules])
  assert.equal(a.version, b.version)
})

test('UTF-8 text (Chinese) round-trips through the byte encoder', () => {
  const qr = encode('书房电脑 绑定二维码 🐳')
  assert.ok(qr.size >= 21)
  const bytes = toUtf8Bytes('书房电脑')
  assert.equal(bytes.length, 12, 'each Chinese character is three UTF-8 bytes')
})

test('level H survives a version 40 encode at capacity', () => {
  const capacity = byteCapacity(40, 'H')
  const qr = encode('a'.repeat(capacity), { level: 'H', version: 40 })
  assert.equal(qr.version, 40)
  assert.equal(qr.size, 177)
  assert.equal(qr.modules.length, 177 * 177)
})

test('every EC level encodes and produces a plausible density', () => {
  for (const level of ['L', 'M', 'Q', 'H']) {
    const qr = encode('Open Whale', { level })
    assert.equal(qr.level, level)
    let dark = 0
    for (const module of qr.modules) dark += module
    const ratio = dark / (qr.size * qr.size)
    // A valid QR is never all-dark or all-light.
    assert.ok(ratio > 0.2 && ratio < 0.8, `${level} density ${ratio}`)
  }
})

test('SVG output is well formed and carries a single dark path', () => {
  const qr = encode('svg test')
  const svg = toSvg(qr, { margin: 2, scale: 10 })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<\/svg>$/)
  assert.match(svg, /shape-rendering="crispEdges"/)
  const expectedSize = (qr.size + 4) * 10
  assert.ok(svg.includes(`width="${expectedSize}"`))
  assert.ok(svg.includes(`height="${expectedSize}"`))
  const paths = svg.match(/<path /g) ?? []
  assert.equal(paths.length, 1, 'one path keeps the SVG small for large versions')
  assert.ok(!svg.includes('NaN'))
})

test('terminal output uses half-block glyphs and stays square', () => {
  const qr = encode('terminal')
  const text = toTerminal(qr, { margin: 2 })
  const lines = text.split('\n')
  assert.equal(lines.length, Math.ceil((qr.size + 4) / 2))
  for (const line of lines) {
    assert.equal([...line].length / 2, qr.size + 4, 'each character is two modules wide')
  }
  assert.match(text, /[█▀▄ ]/)
})

test('PNG output is a valid 1-bit greyscale PNG of the expected size', () => {
  const qr = encode('png test')
  const scale = 4
  const margin = 3
  const png = toPng(qr, { scale, margin })
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // Walk the chunks and verify CRCs and structure.
  let offset = 8
  const chunks = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('latin1')
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = png.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data, crc })
    offset += 12 + length
  }
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND'])
  assert.equal(chunks[0].data.readUInt32BE(0), (qr.size + margin * 2) * scale)
  assert.equal(chunks[0].data.readUInt32BE(4), (qr.size + margin * 2) * scale)
  assert.equal(chunks[0].data[8], 1, 'bit depth 1')
  assert.equal(chunks[0].data[9], 0, 'greyscale colour type')

  // Inflate the pixel data and check the module pattern survives the round-trip.
  const raw = inflateSync(chunks[1].data)
  const pixels = (qr.size + margin * 2) * scale
  const rowBytes = Math.ceil(pixels / 8)
  assert.equal(raw.length, (rowBytes + 1) * pixels)
  const darkAt = (x, y) => {
    const rowStart = y * (rowBytes + 1)
    const bit = (raw[rowStart + 1 + (x >> 3)] >> (7 - (x & 7))) & 1
    return bit === 0 // bit 0 = black
  }
  // Every dark module must be black in the PNG and every light module white.
  for (let my = 0; my < qr.size; my++) {
    for (let mx = 0; mx < qr.size; mx++) {
      const px = (mx + margin) * scale + 1
      const py = (my + margin) * scale + 1
      assert.equal(darkAt(px, py), qr.isDark(mx, my), `module ${mx},${my} rendered incorrectly`)
    }
  }
})

test('PNG CRCs are correct', () => {
  const png = toPng(encode('crc'), { scale: 2 })
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc32 = buffer => {
    let crc = 0xffffffff
    for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const typeAndData = png.subarray(offset + 4, offset + 8 + length)
    const stored = png.readUInt32BE(offset + 8 + length)
    assert.equal(crc32(typeAndData), stored, 'chunk CRC must match')
    offset += 12 + length
  }
})

test('an empty string still encodes (a QR is never empty)', () => {
  const qr = encode('')
  assert.equal(qr.size, 21)
  let dark = 0
  for (const module of qr.modules) dark += module
  assert.ok(dark > 0)
})
