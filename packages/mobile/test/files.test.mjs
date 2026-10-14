// 文件工具：命名消毒、体积、进度与分块累计。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ASSEMBLY_BYTES,
  canAssemble,
  base64ByteLength,
  describeTransfer,
  formatBytes,
  guessMime,
  isAccumulatorComplete,
  isImage,
  partFileName,
  planAssembly,
  pushChunk,
  sanitizeFileName,
  startAccumulator,
  transferProgress,
  uniqueFileName,
  uploadGuard,
} from '../src/core/files.mts'

test('file names from the computer cannot escape the download directory', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('C:\\Windows\\system32\\x.dll'), 'x.dll')
  assert.equal(sanitizeFileName('a/b/c.txt'), 'c.txt')
  assert.equal(sanitizeFileName('..'), 'file')
  assert.equal(sanitizeFileName(''), 'file')
  assert.equal(sanitizeFileName(null), 'file')
  assert.equal(sanitizeFileName('bad:name?.txt'), 'bad_name_.txt')
  assert.equal(sanitizeFileName('报告.pdf'), '报告.pdf')
  const long = sanitizeFileName(`${'x'.repeat(200)}.txt`)
  assert.ok(long.length <= 96, `没有截断：${long.length}`)
  assert.ok(long.endsWith('.txt'))
})

test('duplicate names get a suffix instead of overwriting an earlier download', () => {
  const taken = new Set(['a.txt', 'a-2.txt'])
  assert.equal(uniqueFileName('a.txt', taken), 'a-3.txt')
  assert.equal(uniqueFileName('b.txt', taken), 'b.txt')
  assert.equal(uniqueFileName('noext', new Set(['noext', 'noext-2'])), 'noext-3')
})

test('part file names sort in chunk order', () => {
  assert.equal(partFileName('a.bin', 7), 'a.bin.part-00007')
  assert.ok(partFileName('a.bin', 2) < partFileName('a.bin', 10))
})

test('base64 byte length matches Buffer without decoding', () => {
  for (const size of [0, 1, 2, 3, 4, 1024, 65537]) {
    const base64 = Buffer.alloc(size, 7).toString('base64')
    assert.equal(base64ByteLength(base64), size)
  }
  assert.equal(base64ByteLength(''), 0)
  assert.equal(base64ByteLength(null), 0)
  assert.equal(base64ByteLength('!!!!'), 0)
})

test('human sizes and mime guesses cover the cases the chat shows', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(3 * 1024 ** 3), '3.00 GB')
  assert.equal(formatBytes(-1), '未知大小')
  assert.equal(guessMime('a.pdf'), 'application/pdf')
  assert.equal(guessMime('a.PNG'), 'image/png')
  assert.equal(guessMime('a.unknown'), 'application/octet-stream')
  assert.equal(isImage('a.JPG'), true)
  assert.equal(isImage('a.bin', 'image/webp'), true)
  assert.equal(isImage('a.bin'), false)
})

test('progress and status copy degrade gracefully when the size is unknown', () => {
  assert.equal(transferProgress({ receivedBytes: 5, size: 10 }), 0.5)
  assert.equal(transferProgress({ receivedBytes: 50, size: 10 }), 1)
  assert.equal(transferProgress({ receivedBytes: 5, size: 0 }), undefined)
  assert.match(describeTransfer({ status: 'downloading', receivedBytes: 5, size: 10 }), /50%/)
  assert.match(describeTransfer({ status: 'offered', receivedBytes: 0, size: 10 }), /点按下载/)
  assert.match(describeTransfer({ status: 'failed', receivedBytes: 0, size: 10, error: '断线' }), /断线/)
  assert.match(describeTransfer({ status: 'too-large', receivedBytes: 0, size: 10 }), /上限/)
})

test('assembly planning uses the protocol chunk size', () => {
  const plan = planAssembly({ name: 'a.bin', size: 256 * 1024 + 1 })
  assert.equal(plan.expectedParts, 2)
  assert.equal(plan.chunkBytes, 256 * 1024)
  assert.equal(planAssembly({ name: 'empty', size: 0 }).expectedParts, 1)
  assert.equal(canAssemble(MAX_ASSEMBLY_BYTES), true)
  assert.equal(canAssemble(MAX_ASSEMBLY_BYTES + 1), false)
  assert.equal(canAssemble(Number.NaN), false)
})

test('the chunk accumulator rejects duplicates, gaps and overflow', () => {
  let acc = startAccumulator('f1', 8)
  const first = pushChunk(acc, 0, Buffer.alloc(4).toString('base64'))
  assert.equal(first.ok, true)
  acc = first.accumulator
  assert.equal(isAccumulatorComplete(acc), false)

  const duplicate = pushChunk(acc, 0, Buffer.alloc(4).toString('base64'))
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.reason, 'duplicate')

  const gap = pushChunk(acc, 2, Buffer.alloc(4).toString('base64'))
  assert.equal(gap.ok, false)
  assert.equal(gap.reason, 'out-of-order')

  const second = pushChunk(acc, 1, Buffer.alloc(4).toString('base64'))
  assert.equal(second.ok, true)
  acc = second.accumulator
  assert.equal(isAccumulatorComplete(acc), true)

  const overflow = pushChunk(acc, 2, Buffer.alloc(8).toString('base64'))
  assert.equal(overflow.ok, false)
  assert.equal(overflow.reason, 'overflow')
})

test('uploads are refused above the in-band attachment cap with an actionable message', () => {
  assert.deepEqual(uploadGuard(1024), { ok: true })
  const tooBig = uploadGuard(9 * 1024 * 1024)
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.message, /8\.0 MB/)
  assert.equal(uploadGuard(Number.NaN).ok, false)
})
