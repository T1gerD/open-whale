// 相册识图 / QR 解码调度测试。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  QR_NOT_FOUND_MESSAGE,
  planScanSizes,
  readPairingFromBitmap,
  scanBitmapForQr,
} from '../lib/qr.mjs'

const NOW = Date.parse('2026-10-26T00:00:00.000Z')
const PAYLOAD_TEXT = JSON.stringify({
  v: 1,
  p: 'openwhale',
  host: '电脑',
  id: 'cmp_1',
  fp: 'deadbeef',
  secret: 'c2VjcmV0',
  expires: '2099-01-01T00:00:00.000Z',
  endpoints: ['http://192.168.1.5:8787'],
})

test('planScanSizes 先 1024 再 2048，只缩小不放大，去重', () => {
  assert.deepEqual(planScanSizes(4000, 3000), [
    { width: 1024, height: 768 },
    { width: 2048, height: 1536 },
  ])
  // 小图不放大（放大只会更糊更慢），两档退化成同一尺寸后要自动去重。
  assert.deepEqual(planScanSizes(800, 600), [{ width: 800, height: 600 }])
  // 宽高比极端时仍然至少 1px。
  assert.deepEqual(planScanSizes(4000, 1, [1024]), [{ width: 1024, height: 1 }])
  assert.deepEqual(planScanSizes(0, 100), [])
  assert.deepEqual(planScanSizes(Number.NaN, 100), [])
})

test('BarcodeDetector 可用时优先原生解码，不碰 jsQR', async () => {
  let jsQrCalls = 0
  const env = {
    detectBarcodes: async () => [PAYLOAD_TEXT],
    readImageData: async () => ({ data: new Uint8ClampedArray(4), width: 2, height: 2 }),
    jsQR: () => {
      jsQrCalls += 1
      return null
    },
  }
  const result = await scanBitmapForQr({ width: 1000, height: 1000 }, env)
  assert.equal(result.ok, true)
  assert.equal(result.method, 'barcode-detector')
  assert.equal(result.text, PAYLOAD_TEXT)
  assert.equal(jsQrCalls, 0)
})

test('原生解码失败/为空时用 jsQR 兜底，并按尺寸重试', async () => {
  const seenSizes = []
  const env = {
    detectBarcodes: async () => [],
    readImageData: async (_bitmap, width, height) => {
      seenSizes.push(`${width}x${height}`)
      return { data: new Uint8ClampedArray(width * height * 4), width, height }
    },
    jsQR: (_data, width) => (width === 1024 ? null : { data: PAYLOAD_TEXT }),
  }
  const result = await scanBitmapForQr({ width: 2000, height: 1000 }, env)
  assert.equal(result.ok, true)
  assert.equal(result.method, 'jsqr')
  assert.deepEqual(seenSizes, ['1024x512', '2000x1000'], '第一档解不出才试第二档（2048 超过原宽，退化为原尺寸）')
})

test('原生解码抛错（如图片格式不支持）也会落到 jsQR', async () => {
  const env = {
    detectBarcodes: async () => {
      throw new Error('unsupported')
    },
    readImageData: async () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }),
    jsQR: () => ({ data: PAYLOAD_TEXT }),
  }
  const result = await scanBitmapForQr({ width: 500, height: 500 }, env)
  assert.equal(result.ok, true)
  assert.equal(result.method, 'jsqr')
})

test('图里没有二维码时给出可操作文案', async () => {
  const env = {
    readImageData: async () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }),
    jsQR: () => null,
  }
  const result = await scanBitmapForQr({ width: 500, height: 500 }, env)
  assert.equal(result.ok, false)
  assert.equal(result.error, QR_NOT_FOUND_MESSAGE)
})

test('两个解码器都不可用时明确提示', async () => {
  const result = await scanBitmapForQr({ width: 500, height: 500 }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /不支持图片解码/)
  const bad = await scanBitmapForQr(null, {})
  assert.equal(bad.ok, false)
})

test('readPairingFromBitmap：扫到二维码后直接解析成绑定载荷', async () => {
  const env = {
    detectBarcodes: async () => [PAYLOAD_TEXT],
    readImageData: async () => {
      throw new Error('should not be called')
    },
    jsQR: () => null,
  }
  const result = await readPairingFromBitmap({ width: 600, height: 600 }, env, { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.payload.id, 'cmp_1')
  assert.equal(result.method, 'barcode-detector')
})

test('readPairingFromBitmap：二维码是别的内容时给出「内容无效」而不是静默', async () => {
  const env = {
    detectBarcodes: async () => ['https://example.com/not-ours'],
    readImageData: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    jsQR: () => null,
  }
  const result = await readPairingFromBitmap({ width: 600, height: 600 }, env, { now: NOW })
  assert.equal(result.ok, false)
  assert.match(result.error, /二维码内容无效/)
})
