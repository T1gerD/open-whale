// 分块上传状态机（手机 → 电脑附件）。
//
// 这一层独立于网关，只做「帧数据 → 磁盘文件」的确定性状态机，所以可以脱离
// 网络单测。协议契约见 PROTOCOL-V2.md §5：
//  · 512 KiB/块，单附件 64 MiB 上限，每块必须等 `upload/progress` 再发下一块；
//  · 落盘在会话工作目录内的 `.openwhale/uploads/`（DSH 的文件沙箱只认这个根）；
//  · 保留原始扩展名 —— `photo.jpg` 不能变成 `photo`，否则图片工具识别不了；
//  · 空闲 3 分钟清理临时文件，完成后 rename 到正式名。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
} from '../src/protocol.mjs'
import { UploadManager, guessMimeType, sanitizeFileName } from '../src/upload.mjs'

function makeManager(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'openwhale-upload-'))
  const manager = new UploadManager({
    dir,
    log: () => {},
    ...options,
  })
  return { manager, dir }
}

/** 把一段数据切成 base64 块，像手机那样逐块发送并检查背压回执。 */
async function sendChunks(manager, uploadId, deviceId, buffer, chunkSize = UPLOAD_CHUNK_BYTES) {
  let seq = 0
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const slice = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length))
    const result = await manager.chunk({
      uploadId,
      deviceId,
      seq,
      dataBase64: slice.toString('base64'),
    })
    assert.equal(result.ok, true, `chunk ${seq} must be accepted: ${result.message ?? ''}`)
    assert.equal(result.progress.nextSeq, seq + 1, 'the progress frame is the backpressure signal')
    seq += 1
  }
  return seq
}

test('a file uploads in chunks, keeps its extension and lands inside the upload dir', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('这是一张照片的内容'.repeat(2000), 'utf8')

  const started = await manager.start({
    uploadId: 'up_1',
    deviceId: 'dev_a',
    name: 'photo.jpg',
    size: bytes.length,
    mime: 'image/jpeg',
  })
  assert.equal(started.ok, true)
  assert.equal(started.ready.chunkBytes, UPLOAD_CHUNK_BYTES)
  assert.equal(started.ready.maxBytes, MAX_UPLOAD_BYTES)

  await sendChunks(manager, 'up_1', 'dev_a', bytes)
  const ended = await manager.end({ uploadId: 'up_1', deviceId: 'dev_a' })
  assert.equal(ended.ok, true, ended.message)
  assert.equal(ended.done.name, 'photo.jpg')
  assert.equal(ended.done.size, bytes.length)
  assert.equal(ended.done.mime, 'image/jpeg')
  assert.equal(ended.done.path.endsWith('photo.jpg'), true, 'the original extension must be preserved')
  assert.equal(ended.done.sha256, createHash('sha256').update(bytes).digest('hex'))
  // The file is inside the session working directory, so DSH's file sandbox can read it.
  assert.equal(ended.done.path.startsWith(dir), true)
  assert.equal(readFileSync(ended.done.path).equals(bytes), true)
  await manager.dispose()
})

test('a chunk out of order is refused and does not advance the upload', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await manager.start({ uploadId: 'up_2', deviceId: 'dev_a', name: 'a.bin', size: 8 })
  const skipped = await manager.chunk({ uploadId: 'up_2', deviceId: 'dev_a', seq: 1, dataBase64: 'AAAAAAAAAAA=' })
  assert.equal(skipped.ok, false)
  assert.equal(skipped.code, 'out-of-order')
  assert.equal(skipped.nextSeq, 0, 'the client needs to know which seq to send next')
  const wrongDevice = await manager.chunk({ uploadId: 'up_2', deviceId: 'dev_b', seq: 0, dataBase64: 'AAAA' })
  assert.equal(wrongDevice.ok, false)
  assert.equal(wrongDevice.code, 'not-found')
  await manager.dispose()
})

test('ending before every byte arrived is refused', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await manager.start({ uploadId: 'up_3', deviceId: 'dev_a', name: 'a.txt', size: 10 })
  await manager.chunk({ uploadId: 'up_3', deviceId: 'dev_a', seq: 0, dataBase64: Buffer.from('hello').toString('base64') })
  const ended = await manager.end({ uploadId: 'up_3', deviceId: 'dev_a' })
  assert.equal(ended.ok, false)
  assert.equal(ended.code, 'incomplete')
  await manager.dispose()
})

test('an optional sha256 mismatch is rejected and the temp file removed', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await manager.start({ uploadId: 'up_4', deviceId: 'dev_a', name: 'a.txt', size: 5 })
  await manager.chunk({ uploadId: 'up_4', deviceId: 'dev_a', seq: 0, dataBase64: Buffer.from('hello').toString('base64') })
  const ended = await manager.end({ uploadId: 'up_4', deviceId: 'dev_a', sha256: 'deadbeef'.repeat(8) })
  assert.equal(ended.ok, false)
  assert.equal(ended.code, 'sha256-mismatch')
  // No half-finished uploads may be left behind.
  assert.deepEqual(manager.uploads.size, 0)
  assert.deepEqual(requireFiles(dir), [])
  await manager.dispose()
})

test('a matching sha256 is accepted', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('hello', 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await manager.start({ uploadId: 'up_5', deviceId: 'dev_a', name: 'a.txt', size: bytes.length, sha256 })
  await sendChunks(manager, 'up_5', 'dev_a', bytes)
  const ended = await manager.end({ uploadId: 'up_5', deviceId: 'dev_a' })
  assert.equal(ended.ok, true, ended.message)
  assert.equal(ended.done.sha256, sha256)
  await manager.dispose()
})

test('cancel removes the temp file', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await manager.start({ uploadId: 'up_6', deviceId: 'dev_a', name: 'a.txt', size: 10 })
  await manager.chunk({ uploadId: 'up_6', deviceId: 'dev_a', seq: 0, dataBase64: 'AAAA' })
  const cancelled = await manager.cancel({ uploadId: 'up_6', deviceId: 'dev_a' })
  assert.equal(cancelled.ok, true)
  assert.equal(manager.uploads.size, 0)
  assert.deepEqual(requireFiles(dir), [])
  await manager.dispose()
})

test('a hostile file name cannot escape the upload directory', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const started = await manager.start({
    uploadId: 'up_7',
    deviceId: 'dev_a',
    name: '../../evil.jpg',
    size: 3,
  })
  assert.equal(started.ok, true)
  await sendChunks(manager, 'up_7', 'dev_a', Buffer.from('abc'))
  const ended = await manager.end({ uploadId: 'up_7', deviceId: 'dev_a' })
  assert.equal(ended.ok, true)
  assert.equal(ended.done.name, 'evil.jpg')
  assert.equal(ended.done.path.startsWith(dir), true)
  assert.equal(ended.done.path.includes('..'), false)
  await manager.dispose()
})

test('an upload larger than the protocol limit is refused at start', async t => {
  const { manager, dir } = makeManager()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const started = await manager.start({
    uploadId: 'up_8',
    deviceId: 'dev_a',
    name: 'huge.bin',
    size: MAX_UPLOAD_BYTES + 1,
  })
  assert.equal(started.ok, false)
  assert.equal(started.code, 'too-large')
  await manager.dispose()
})

test('an idle upload is cleaned up after the timeout', async t => {
  let clock = 1_000
  const { manager, dir } = makeManager({ idleTimeoutMs: 100, now: () => clock })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await manager.start({ uploadId: 'up_9', deviceId: 'dev_a', name: 'slow.bin', size: 1024 })
  await manager.chunk({ uploadId: 'up_9', deviceId: 'dev_a', seq: 0, dataBase64: 'AAAA' })
  assert.equal(requireFiles(dir).length, 1, 'the temp file exists while the upload is alive')

  clock += 101
  await manager.cleanup()
  assert.equal(manager.uploads.size, 0)
  assert.deepEqual(requireFiles(dir), [], 'an abandoned upload must not leave a temp file behind')
  await manager.dispose()
})

test('a completed upload is still resolvable as an attachment for a while', async t => {
  let clock = 1_000
  const { manager, dir } = makeManager({ completedTtlMs: 500, now: () => clock })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await manager.start({ uploadId: 'up_10', deviceId: 'dev_a', name: 'note.txt', size: 2 })
  await sendChunks(manager, 'up_10', 'dev_a', Buffer.from('hi'))
  const ended = await manager.end({ uploadId: 'up_10', deviceId: 'dev_a' })
  assert.equal(ended.ok, true)

  const resolved = manager.completed('up_10', 'dev_a')
  assert.ok(resolved, 'chat/send references this upload right after upload/done')
  assert.equal(resolved.name, 'note.txt')
  assert.equal(manager.completed('up_10', 'dev_b'), undefined, 'another device cannot claim this upload')

  clock += 501
  await manager.cleanup()
  assert.equal(manager.completed('up_10', 'dev_a'), undefined)
  assert.equal(existsSync(ended.done.path), true, 'the landed file is kept; only the reference expires')
  await manager.dispose()
})

test('file names are sanitised and keep their extension', () => {
  assert.equal(sanitizeFileName('photo.jpg'), 'photo.jpg')
  assert.equal(sanitizeFileName('C:\\Users\\x\\报表 2024.xlsx'), '报表 2024.xlsx')
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('   '), 'upload.bin')
  assert.equal(sanitizeFileName('a'.repeat(400) + '.png').endsWith('.png'), true)
  assert.equal(sanitizeFileName('bad:name?.png').includes(':'), false)
})

test('mime types are guessed so the phone renders the right preview', () => {
  assert.equal(guessMimeType('photo.jpg'), 'image/jpeg')
  assert.equal(guessMimeType('photo.PNG'), 'image/png')
  assert.equal(guessMimeType('doc.pdf'), 'application/pdf')
  assert.equal(guessMimeType('sheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(guessMimeType('note.txt'), 'text/plain; charset=utf-8')
  assert.equal(guessMimeType('archive.zip'), 'application/zip')
  assert.equal(guessMimeType('mystery.bin'), 'application/octet-stream')
})

/** Files currently present in the upload directory. */
function requireFiles(dir) {
  return readdirSync(dir)
}
