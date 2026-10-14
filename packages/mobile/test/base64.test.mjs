// base64 / UTF-8 编解码：用 Node 的 Buffer 当 oracle。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url, bytesToUtf8, utf8ByteLength, utf8ToBytes } from '../src/core/base64.mts'

test('base64 encode/decode round-trips against Buffer', () => {
  const cases = [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([0, 1, 2]),
    Uint8Array.from([0, 1, 2, 250, 255, 128]),
    new Uint8Array(randomBytes(300)),
  ]
  for (const bytes of cases) {
    const expected = Buffer.from(bytes).toString('base64')
    assert.equal(bytesToBase64(bytes), expected)
    assert.deepEqual(Array.from(base64ToBytes(expected)), Array.from(bytes))
    // 无填充的 base64url 也必须能解回来
    const url = bytesToBase64Url(bytes)
    assert.equal(url.includes('+'), false)
    assert.equal(url.includes('/'), false)
    assert.equal(url.includes('='), false)
    assert.deepEqual(Array.from(base64UrlToBytes(url)), Array.from(bytes))
  }
})

test('base64 rejects junk instead of silently producing wrong bytes', () => {
  assert.throws(() => base64ToBytes('a*b'), /非法/)
  assert.throws(() => base64ToBytes('中文'), /非法/)
})

test('base64 tolerates whitespace and padding variations', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4])
  const padded = Buffer.from(bytes).toString('base64')
  assert.deepEqual(Array.from(base64ToBytes(`  ${padded}\n`)), [1, 2, 3, 4])
  assert.deepEqual(Array.from(base64ToBytes(padded.replace(/=+$/, ''))), [1, 2, 3, 4])
})

test('utf8 encoding matches Buffer and survives surrogate pairs', () => {
  for (const text of ['', 'hello', '中文测试', '🐳 whale 🐋', 'a\u0000b']) {
    const expected = Buffer.from(text, 'utf8')
    const encoded = utf8ToBytes(text)
    assert.deepEqual(Array.from(encoded), Array.from(expected), `encode ${text}`)
    assert.equal(utf8ByteLength(text), expected.length)
    assert.equal(bytesToUtf8(encoded), text)
  }
})

test('invalid utf8 bytes degrade to a replacement character instead of throwing', () => {
  // 一个坏字节不该让整条聊天消息消失。
  assert.equal(bytesToUtf8(Uint8Array.from([0xff, 0x41])), '\uFFFD' + 'A')
  assert.equal(bytesToUtf8(Uint8Array.from([0xe4, 0xb8])), '\uFFFD')
})
