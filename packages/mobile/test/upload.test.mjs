// 分块上传状态机：切块、背压、序号、重试、取消、上限。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../src/core/frames.mts'
import {
  acceptDone,
  acceptError,
  acceptProgress,
  acceptReady,
  cancelUpload,
  canRetryUpload,
  createUploadState,
  describeUpload,
  describeUploadFailure,
  isUploadActive,
  markChunkSent,
  markEndSent,
  markStartSent,
  nextChunkPlan,
  readyToEnd,
  totalChunks,
  uploadFailureLabel,
  uploadGuard,
  uploadIdleExceeded,
  uploadProgress,
  uploadRetryDelayMs,
} from '../src/core/upload.mts'

function stateFor(size) {
  return createUploadState({ uploadId: 'upl_1', name: 'photo.jpg', size, mime: 'image/jpeg', now: 1000 })
}

/** 模拟一次完整上传（先 ready 定 chunkBytes，再逐块 progress）。 */
function runUpload(size, chunkBytes = UPLOAD_CHUNK_BYTES) {
  let state = stateFor(size)
  state = markStartSent(state, 1001)
  const accepted = acceptReady(state, { chunkBytes, maxBytes: MAX_UPLOAD_BYTES })
  assert.equal(accepted.ok, true)
  state = accepted.state
  const chunks = []
  for (;;) {
    if (readyToEnd(state)) break
    const plan = nextChunkPlan(state)
    assert.ok(plan, 'expected another chunk')
    chunks.push(plan)
    state = markChunkSent(state, plan.seq, plan.length, 1002 + plan.seq)
    const next = acceptProgress(state, { nextSeq: plan.seq + 1, received: (plan.seq + 1) * chunkBytes }, 1003 + plan.seq)
    assert.ok(next, 'expected progress to be accepted')
    state = next
  }
  state = markEndSent(state, 2000)
  state = acceptDone(state, { fileId: 'file_1', name: 'photo.jpg', size }, 2001)
  return { state, chunks }
}

test('uploads are guarded by the 64 MiB protocol limit', () => {
  assert.deepEqual(uploadGuard(1024), { ok: true })
  assert.deepEqual(uploadGuard(MAX_UPLOAD_BYTES), { ok: true })
  const tooBig = uploadGuard(MAX_UPLOAD_BYTES + 1)
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.message, /64 MB/)
  assert.equal(uploadGuard(Number.NaN).ok, false)
  assert.equal(uploadGuard(-1).ok, false)
})

test('a file is cut into the server-provided chunk size', () => {
  const { state, chunks } = runUpload(10 * 1024 + 5, 4096)
  assert.equal(totalChunks(state), 3)
  assert.deepEqual(
    chunks.map(plan => [plan.seq, plan.offset, plan.length]),
    [
      [0, 0, 4096],
      [1, 4096, 4096],
      [2, 8192, 10 * 1024 + 5 - 8192],
    ],
  )
  assert.equal(state.phase, 'done')
  assert.equal(state.fileId, 'file_1')
  assert.equal(state.receivedBytes, 10 * 1024 + 5)
  assert.equal(uploadProgress(state), 1)
})

test('backpressure blocks the next chunk until upload/progress arrives', () => {
  let state = stateFor(10000)
  state = markStartSent(state)
  state = acceptReady(state, { chunkBytes: 4096 }).state
  const first = nextChunkPlan(state)
  state = markChunkSent(state, first.seq, first.length)
  // 上一块还没确认：不允许发下一块
  assert.equal(nextChunkPlan(state), undefined)
  // 重复/过期的 progress 不会被接受，也不会让状态倒退（返回 undefined 让调用方忽略）
  assert.equal(acceptProgress(state, { nextSeq: 0, received: 0 }, 2000), undefined)
  const advanced = acceptProgress(state, { nextSeq: 1, received: 4096 }, 2001)
  assert.equal(advanced.nextSeq, 1)
  assert.equal(advanced.inflightSeq, undefined)
  assert.equal(nextChunkPlan(advanced).seq, 1)
})

test('a gap in the acknowledged chunk sequence fails the upload', () => {
  let state = stateFor(10000)
  state = markStartSent(state)
  state = acceptReady(state, { chunkBytes: 4096 }).state
  state = markChunkSent(state, 0, 4096)
  const gap = acceptProgress(state, { nextSeq: 5, received: 20000 }, 2000)
  assert.equal(gap.phase, 'failed')
  assert.match(gap.error, /序号跳变/)
})

test('zero-byte files finish without sending any chunk', () => {
  const { state, chunks } = runUpload(0, 4096)
  assert.deepEqual(chunks, [])
  assert.equal(state.phase, 'done')
  assert.equal(uploadProgress(state), 1)
})

test('server-ready validation rejects absurd chunk sizes and exhausted quota', () => {
  const state = stateFor(1024)
  assert.equal(acceptReady(state, { chunkBytes: 0 }).ok, false)
  assert.equal(acceptReady(state, { chunkBytes: 9 * 1024 * 1024 }).ok, false)
  const quota = acceptReady(state, { chunkBytes: 4096, maxBytes: 100 })
  assert.equal(quota.ok, false)
  assert.match(quota.message, /额度不足/)
})

test('errors and cancellation converge to terminal states', () => {
  let state = stateFor(1024)
  state = markStartSent(state)
  const errored = acceptError(state, { message: '电脑端磁盘满了' }, 2000)
  assert.equal(errored.phase, 'failed')
  assert.equal(errored.error, '电脑端磁盘满了')
  assert.equal(isUploadActive(errored), false)

  const cancelled = cancelUpload(state, 2000)
  assert.equal(cancelled.phase, 'cancelled')
  // 成功之后不能再被取消
  const done = acceptDone(errored, { fileId: 'f1' })
  assert.equal(cancelUpload(done).phase, 'done')
})

test('retry policy and backoff are bounded', () => {
  let state = stateFor(1024)
  state = acceptError(markStartSent(state), { message: 'network' })
  assert.equal(canRetryUpload(state), true)
  assert.equal(canRetryUpload({ ...state, attempts: 3 }), false)
  assert.deepEqual([0, 1, 2, 5].map(uploadRetryDelayMs), [1000, 2000, 4000, 8000])
})

test('idle uploads are detected so temp files do not live forever', () => {
  let state = markStartSent(stateFor(1024), 1000)
  assert.equal(uploadIdleExceeded(state, 2000, 3 * 60 * 1000), false)
  assert.equal(uploadIdleExceeded(state, 1000 + 3 * 60 * 1000 + 1, 3 * 60 * 1000), true)
  state = acceptDone(state, { fileId: 'f1' }, 3000)
  assert.equal(uploadIdleExceeded(state, 10 ** 9, 1), false)
})

test('status copy is readable for every phase', () => {
  let state = stateFor(1000)
  assert.match(describeUpload(state), /准备上传/)
  state = markStartSent(state)
  state = acceptReady(state, { chunkBytes: 500 }).state
  state = markChunkSent(state, 0, 500)
  state = acceptProgress(state, { nextSeq: 1, received: 500 }, 2000)
  assert.match(describeUpload(state), /上传中 50%/)
  assert.match(describeUpload(acceptDone(state, { fileId: 'f1' }, 3000)), /已上传/)
  assert.match(describeUpload(acceptError(state, { message: 'x' }, 3000)), /上传失败/)
})

test('upload failures are classified into retryable vs needs-a-fix', () => {
  // 网络断开：可重试，文案指向“连接恢复后点重试”
  const network = describeUploadFailure('network', '连接已断开')
  assert.equal(network.retryable, true)
  assert.equal(network.kind, 'network')
  assert.match(network.hint, /重试/)

  // 电脑端拒绝：不可重试，文案指向电脑端检查
  const server = describeUploadFailure('server', '磁盘空间不足')
  assert.equal(server.retryable, false)
  assert.match(server.hint, /磁盘空间不足/)

  // 文件过大 / 本地文件读不出来 / 取消：都不可重试（换文件或重新选）
  assert.equal(describeUploadFailure('too-large').retryable, false)
  assert.match(describeUploadFailure('too-large').hint, /64 MB/)
  assert.equal(describeUploadFailure('local').retryable, false)
  assert.equal(describeUploadFailure('cancelled').retryable, false)

  assert.equal(uploadFailureLabel('network'), '网络断开')
  assert.equal(uploadFailureLabel('server'), '电脑端拒绝')
  assert.equal(uploadFailureLabel('too-large'), '文件过大')
})
