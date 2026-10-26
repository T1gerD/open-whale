// 附件上传状态机测试：inline/分块选择、分块计划、背压、进度、失败与取消。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AttachmentUploader,
  UPLOAD_STATE,
  UPLOAD_TRANSPORT,
  chooseTransport,
  createBlobSliceReader,
  isImageAttachment,
  planAttachmentProgress,
  planChunks,
  readBlobAsBase64,
} from '../lib/upload.mjs'
import { fromBase64, toBase64 } from '../lib/bytes.mjs'

/** 假传输：记录发出的帧；返回 true（模拟连接在线）。 */
function createFakeTransport(options = {}) {
  const frames = []
  let online = options.online ?? true
  return {
    frames,
    send(frame) {
      if (!online) return false
      frames.push(frame)
      return true
    },
    setOnline(value) {
      online = value
    },
    take(type) {
      return frames.filter(frame => frame.t === type)
    },
    last() {
      return frames[frames.length - 1]
    },
  }
}

/** 假文件内容：按字节可预测，便于断言分块边界。 */
/** 等一轮微任务 + 宏任务，让上传器的 Promise 链跑完（readSlice 是 async）。 */
async function flush() {
  await new Promise(resolve => setImmediate(resolve))
}

function fakeBytes(size) {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251
  return bytes
}

/** 构造上传器：读块从 fakeBytes 上切。 */
function createUploader(size, transport, overrides = {}) {
  const bytes = fakeBytes(size)
  const progress = []
  const done = []
  const errors = []
  const uploader = new AttachmentUploader({
    send: transport.send,
    readSlice: async (seq, offset, length) => bytes.slice(offset, offset + length),
    onProgress: value => progress.push(value),
    onDone: value => done.push(value),
    onError: value => errors.push(value),
    chunkBytes: overrides.chunkBytes,
    maxBytes: overrides.maxBytes,
  })
  return { uploader, progress, done, errors, bytes }
}

test('chooseTransport：<=2MiB inline，大文件分块，>64MiB 拒绝', () => {
  assert.equal(chooseTransport(1).transport, UPLOAD_TRANSPORT.INLINE)
  assert.equal(chooseTransport(2 * 1024 * 1024).transport, UPLOAD_TRANSPORT.INLINE)
  assert.equal(chooseTransport(2 * 1024 * 1024 + 1).transport, UPLOAD_TRANSPORT.CHUNKED)
  assert.equal(chooseTransport(64 * 1024 * 1024).transport, UPLOAD_TRANSPORT.CHUNKED)
  const tooBig = chooseTransport(64 * 1024 * 1024 + 1)
  assert.equal(tooBig.transport, UPLOAD_TRANSPORT.REJECTED)
  assert.match(tooBig.reason, /上限 64\.0 MB/)
  assert.equal(chooseTransport(0).transport, UPLOAD_TRANSPORT.REJECTED)
  assert.equal(chooseTransport(Number.NaN).transport, UPLOAD_TRANSPORT.REJECTED)
  // 上限可注入（测试/未来协议变化）
  assert.equal(chooseTransport(1000, { inlineLimit: 500 }).transport, UPLOAD_TRANSPORT.CHUNKED)
})

test('planChunks 分块边界', () => {
  assert.deepEqual(planChunks(0), { chunkBytes: 512 * 1024, chunkCount: 0, lastChunkBytes: 0 })
  assert.deepEqual(planChunks(1), { chunkBytes: 512 * 1024, chunkCount: 1, lastChunkBytes: 1 })
  assert.deepEqual(planChunks(512 * 1024), { chunkBytes: 512 * 1024, chunkCount: 1, lastChunkBytes: 512 * 1024 })
  assert.deepEqual(planChunks(512 * 1024 + 1), { chunkBytes: 512 * 1024, chunkCount: 2, lastChunkBytes: 1 })
  assert.deepEqual(planChunks(1024, 300), { chunkBytes: 300, chunkCount: 4, lastChunkBytes: 124 })
})

test('完整上传流程：start → ready → chunk → progress → … → end → done', async () => {
  const transport = createFakeTransport()
  const size = 512 * 1024 * 2 + 100 // 三块：512K + 512K + 100B
  const { uploader, progress, done } = createUploader(size, transport)

  const started = uploader.start({ name: 'photo.jpg', size, mime: 'image/jpeg' })
  assert.equal(started.ok, true)
  const startFrame = transport.last()
  assert.equal(startFrame.t, 'upload/start')
  assert.equal(startFrame.name, 'photo.jpg')
  assert.equal(startFrame.size, size)
  assert.equal(startFrame.mime, 'image/jpeg')
  assert.equal(uploader.state, UPLOAD_STATE.WAITING_READY)

  // 没收到 ready 之前不能发 chunk（服务端还没给块大小/配额）。
  await flush()
  assert.equal(transport.take('upload/chunk').length, 0)

  uploader.handleFrame({ t: 'upload/ready', uploadId: started.uploadId, chunkBytes: 512 * 1024, maxBytes: 64 * 1024 * 1024 })
  await flush()
  const chunks = transport.take('upload/chunk')
  assert.equal(chunks.length, 1, '收到 ready 后只允许发第一块')
  assert.equal(chunks[0].seq, 0)
  assert.equal(fromBase64(chunks[0].dataBase64).length, 512 * 1024)

  // 背压：没有 progress 就不发第二块。
  await flush()
  assert.equal(transport.take('upload/chunk').length, 1)
  uploader.handleFrame({ t: 'upload/progress', uploadId: started.uploadId, nextSeq: 1, received: 512 * 1024 })
  await flush()
  let chunks2 = transport.take('upload/chunk')
  assert.equal(chunks2.length, 2, 'progress 后发第二块')
  assert.equal(chunks2[1].seq, 1)
  assert.equal(fromBase64(chunks2[1].dataBase64).length, 512 * 1024)
  assert.equal(progress[progress.length - 1].percent, 50)

  uploader.handleFrame({ t: 'upload/progress', uploadId: started.uploadId, nextSeq: 2, received: 512 * 1024 * 2 })
  await flush()
  chunks2 = transport.take('upload/chunk')
  assert.equal(chunks2.length, 3, '第二块确认后发最后一块')
  assert.equal(chunks2[2].seq, 2)
  assert.equal(fromBase64(chunks2[2].dataBase64).length, 100)
  assert.equal(transport.take('upload/end').length, 0, '还有块没确认，不能提前 end')

  // 最后一块确认后才发 upload/end。
  uploader.handleFrame({ t: 'upload/progress', uploadId: started.uploadId, nextSeq: 3, received: size })
  await flush()
  const endFrames = transport.take('upload/end')
  assert.equal(endFrames.length, 1)
  assert.equal(uploader.state, UPLOAD_STATE.FINISHING)
  assert.equal(progress[progress.length - 1].percent, 100)

  uploader.handleFrame({ t: 'upload/done', uploadId: started.uploadId, fileId: 'f1', name: 'photo.jpg', size, mime: 'image/jpeg', path: '/tmp/photo.jpg' })
  assert.equal(uploader.state, UPLOAD_STATE.DONE)
  assert.equal(done.length, 1)
  assert.equal(done[0].fileId, 'f1')
  assert.equal(done[0].path, '/tmp/photo.jpg')
})

test('重复 / 乱序 progress 幂等，不会跳块或重复发块', async () => {
  const transport = createFakeTransport()
  const { uploader } = createUploader(512 * 1024, transport)
  const started = uploader.start({ name: 'a.bin', size: 512 * 1024 })
  uploader.handleFrame({ t: 'upload/ready', uploadId: started.uploadId, chunkBytes: 512 * 1024, maxBytes: 1024 * 1024 })
  await flush()
  assert.equal(transport.take('upload/chunk').length, 1)
  // 重复的旧 progress（nextSeq=0）不应导致重发。
  uploader.handleFrame({ t: 'upload/progress', uploadId: started.uploadId, nextSeq: 0, received: 0 })
  await flush()
  assert.equal(transport.take('upload/chunk').length, 1)
  uploader.handleFrame({ t: 'upload/progress', uploadId: started.uploadId, nextSeq: 1, received: 512 * 1024 })
  await flush()
  assert.equal(transport.take('upload/chunk').length, 1)
  assert.equal(transport.take('upload/end').length, 1)
})

test('服务端 upload/error 会终止并回调错误', () => {
  const transport = createFakeTransport()
  const { uploader, errors } = createUploader(1024, transport)
  const started = uploader.start({ name: 'a.bin', size: 1024 })
  uploader.handleFrame({ t: 'upload/error', uploadId: started.uploadId, code: 'disk-full', message: '磁盘满了' })
  assert.equal(uploader.state, UPLOAD_STATE.ERROR)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'disk-full')
  assert.match(errors[0].message, /磁盘满了/)
})

test('超过服务端配额（ready.maxBytes）会失败，而不是硬传', () => {
  const transport = createFakeTransport()
  const { uploader, errors } = createUploader(10 * 1024, transport)
  const started = uploader.start({ name: 'a.bin', size: 10 * 1024 })
  uploader.handleFrame({ t: 'upload/ready', uploadId: started.uploadId, chunkBytes: 512 * 1024, maxBytes: 1024 })
  assert.equal(uploader.state, UPLOAD_STATE.ERROR)
  assert.equal(errors[0].code, 'too-large')
})

test('文件过大 / 空文件在 start 阶段就被拒绝（不浪费流量）', () => {
  const transport = createFakeTransport()
  const { uploader } = createUploader(1, transport)
  const tooBig = uploader.start({ name: 'big.bin', size: 65 * 1024 * 1024 })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /文件过大/)
  assert.equal(transport.frames.length, 0)

  const empty = new AttachmentUploader({
    send: transport.send,
    readSlice: async () => new Uint8Array(0),
  })
  assert.equal(empty.start({ name: 'empty', size: 0 }).ok, false)
})

test('断线时 start 立刻失败（由上层进离线队列，而不是假上传）', () => {
  const transport = createFakeTransport({ online: false })
  const { uploader } = createUploader(1024, transport)
  const result = uploader.start({ name: 'a.bin', size: 1024 })
  assert.equal(result.ok, false)
  assert.equal(uploader.state, UPLOAD_STATE.ERROR)
})

test('cancel 发 upload/cancel 并进入取消态', () => {
  const transport = createFakeTransport()
  const { uploader } = createUploader(1024, transport)
  const started = uploader.start({ name: 'a.bin', size: 1024 })
  assert.equal(uploader.cancel(), true)
  const cancelFrames = transport.take('upload/cancel')
  assert.equal(cancelFrames.length, 1)
  assert.equal(cancelFrames[0].uploadId, started.uploadId)
  assert.equal(uploader.state, UPLOAD_STATE.CANCELLED)
  assert.equal(uploader.cancel(), false)
})

test('不相关 uploadId 的帧不会被本任务消费', () => {
  const transport = createFakeTransport()
  const { uploader } = createUploader(1024, transport)
  uploader.start({ name: 'a.bin', size: 1024 })
  assert.equal(uploader.handleFrame({ t: 'upload/progress', uploadId: 'up_other', nextSeq: 1, received: 1 }), false)
  assert.equal(uploader.handleFrame({ t: 'chat/delta', callId: 'c', text: 'x' }), false)
})

test('isImageAttachment 认 mime 与常见扩展名', () => {
  assert.equal(isImageAttachment('image/png', 'a.bin'), true)
  assert.equal(isImageAttachment('', 'IMG_0001.HEIC'), true)
  assert.equal(isImageAttachment('', 'photo.jpeg'), true)
  assert.equal(isImageAttachment('application/pdf', 'a.pdf'), false)
  assert.equal(isImageAttachment(undefined, 'a.txt'), false)
})

test('planAttachmentProgress 生成整体进度区间（多附件顺序上传）', () => {
  const plan = planAttachmentProgress([
    { name: 'a', size: 100 },
    { name: 'b', size: 300 },
  ])
  assert.equal(plan.items.length, 2)
  assert.equal(plan.items[0].startPercent, 0)
  assert.equal(plan.items[0].endPercent, 25)
  assert.equal(plan.items[1].startPercent, 25)
  assert.equal(plan.items[1].endPercent, 100)
  assert.deepEqual(planAttachmentProgress([]), { items: [] })
})

test('readBlobAsBase64 / createBlobSliceReader 在 Node 的 Blob 上可用', async () => {
  const bytes = new TextEncoder().encode('open whale')
  const blob = new Blob([bytes])
  assert.equal(await readBlobAsBase64(blob), toBase64(bytes))
  const reader = createBlobSliceReader(blob)
  const slice = await reader(0, 0, 4)
  assert.deepEqual(Array.from(slice), [0x6f, 0x70, 0x65, 0x6e])
})
