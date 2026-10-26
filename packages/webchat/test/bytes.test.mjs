// 字节 / Base64 工具测试：上传分块依赖它，编码错一个字节电脑端就收不到文件。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bytesEqual,
  concatBytes,
  formatBytes,
  fromBase64,
  fromBase64Url,
  hexFromBytes,
  randomBytes,
  toBase64,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../lib/bytes.mjs'

test('标准 base64 与 Node Buffer 结果一致（含所有填充长度）', () => {
  for (let length = 0; length < 40; length += 1) {
    const bytes = Uint8Array.from({ length }, (_value, index) => (index * 37 + length) % 256)
    const expected = Buffer.from(bytes).toString('base64')
    assert.equal(toBase64(bytes), expected, `长度 ${length}`)
    assert.deepEqual(Array.from(fromBase64(expected)), Array.from(bytes), `解码长度 ${length}`)
  }
})

test('base64url 无填充且与 Node 的 base64url 一致', () => {
  const bytes = Uint8Array.from([251, 255, 190, 0, 1, 2, 3, 250])
  assert.equal(toBase64Url(bytes), Buffer.from(bytes).toString('base64url'))
  assert.equal(toBase64Url(bytes).includes('='), false)
  assert.deepEqual(Array.from(fromBase64Url(toBase64Url(bytes))), Array.from(bytes))
})

test('fromBase64 拒绝非法输入', () => {
  assert.throws(() => fromBase64('!!!!'), /非法字符/)
  assert.throws(() => fromBase64('A'), /长度不合法/)
  // 空格/换行应被容忍（插件页面复制的 base64 常带换行）。
  assert.deepEqual(Array.from(fromBase64('b3Bl\nbiB3aGFsZQ==')), Array.from(utf8Encode('open whale')))
})

test('utf8 往返（中文 / emoji）', () => {
  const text = '你好，Open Whale 🐋'
  assert.equal(utf8Decode(utf8Encode(text)), text)
})

test('concatBytes / bytesEqual / hexFromBytes', () => {
  const joined = concatBytes([Uint8Array.from([1, 2]), Uint8Array.from([3]), new Uint8Array(0), Uint8Array.from([4, 5])])
  assert.deepEqual(Array.from(joined), [1, 2, 3, 4, 5])
  assert.equal(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2])), true)
  assert.equal(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])), false)
  assert.equal(bytesEqual(Uint8Array.from([1]), Uint8Array.from([1, 2])), false)
  assert.equal(bytesEqual(null, Uint8Array.from([1])), false)
  assert.equal(hexFromBytes(Uint8Array.from([0, 15, 255])), '000fff')
})

test('randomBytes 长度正确且不是常量', () => {
  const first = randomBytes(16)
  const second = randomBytes(16)
  assert.equal(first.length, 16)
  assert.notDeepEqual(Array.from(first), Array.from(second))
})

test('formatBytes 人类可读体积', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB')
  assert.equal(formatBytes(Number.NaN), '未知大小')
})
