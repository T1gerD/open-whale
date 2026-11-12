// 相册识图 / QR 解码调度测试。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createBrowserQrReader,
  looksBlank,
  planScanAttempts,
  planScanSizes,
  planScanTiles,
  QR_NOT_FOUND_MESSAGE,
  readPairingFromBitmap,
  scanBitmapForQr,
  stretchContrast,
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

/**
 * 造一段「有明暗变化」的 RGBA 像素：纯色像素会被 looksBlank 判成画布空白，
 * 那是另一条故障分支，不该混进解码调度的用例里。
 * @param {number} pixels
 */
function patternedData(pixels) {
  const data = new Uint8ClampedArray(pixels * 4)
  for (let i = 0; i < pixels; i += 1) {
    const value = i % 2 === 0 ? 18 : 238
    data[i * 4] = value
    data[i * 4 + 1] = value
    data[i * 4 + 2] = value
    data[i * 4 + 3] = 255
  }
  return data
}

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

test('planScanAttempts：整幅两档 → 对比度增强 → 3×3 原分辨率裁块', () => {
  const attempts = planScanAttempts(4000, 3000)
  assert.equal(attempts[0].kind, 'full')
  assert.deepEqual([attempts[0].width, attempts[0].height], [1024, 768])
  assert.equal(attempts[1].kind, 'full')
  assert.deepEqual([attempts[1].width, attempts[1].height], [2048, 1536])
  assert.equal(attempts[2].kind, 'full-contrast', '第三档只做直方图拉伸，尺寸不涨')
  assert.deepEqual([attempts[2].width, attempts[2].height], [2048, 1536])
  const tiles = attempts.filter(attempt => attempt.kind === 'tile')
  assert.equal(tiles.length, 9, '拍照时二维码常常只占画面一角，必须按原分辨率分块找')
  assert.ok(tiles.every(tile => tile.source && tile.source.width > 0 && tile.source.height > 0))
})

test('planScanAttempts：小图不裁块（裁完只会更糊），裁块开关可关', () => {
  const small = planScanAttempts(500, 500)
  assert.equal(small.filter(attempt => attempt.kind === 'tile').length, 0)
  const bigOff = planScanAttempts(4000, 3000, { tiles: false })
  assert.equal(bigOff.filter(attempt => attempt.kind === 'tile').length, 0)
})

test('planScanTiles：块落在图内、只缩小不放大、互相重叠覆盖整幅', () => {
  const width = 3024
  const height = 4032
  const tiles = planScanTiles(width, height)
  assert.equal(tiles.length, 9)
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0)
    assert.ok(tile.x + tile.width <= width, '块不能越界')
    assert.ok(tile.y + tile.height <= height, '块不能越界')
    assert.ok(tile.renderWidth <= 1400, '单块渲染宽度有上限，否则手机上慢到不可用')
    assert.ok(tile.renderWidth <= tile.width, '只缩小不放大')
  }
  // 第一条水平带的块必须互相搭接，否则压在两块之间的二维码会被切成两半。
  const firstRow = tiles.slice(0, 3)
  assert.ok(firstRow[0].x + firstRow[0].width > firstRow[1].x)
  assert.ok(firstRow[1].x + firstRow[1].width > firstRow[2].x)
  assert.equal(tiles[8].x + tiles[8].width <= width, true)
})

test('整幅认不出来时会退到裁块，成功时报告所用的那一块', async () => {
  const seenKinds = []
  const env = {
    readImageData: async (_bitmap, width, height, attempt) => {
      seenKinds.push({ kind: attempt?.kind ?? 'legacy', width, height })
      return { data: patternedData(Math.max(64, width * height)), width, height }
    },
    // 只有裁块（渲染宽度 1400）能解出来 —— 模拟「二维码在画面里只占一小块」的照片。
    jsQR: (_data, width) => (width === 1400 ? { data: PAYLOAD_TEXT } : null),
  }
  const result = await scanBitmapForQr({ width: 4032, height: 3024 }, env)
  assert.equal(result.ok, true, '整幅缩到 1024/2048 认不出，必须靠裁块救回来')
  assert.equal(result.attempt.kind, 'tile')
  assert.equal(result.attempt.width, 1400)
  assert.equal(seenKinds[0].kind, 'full', '先便宜后昂贵：整幅永远先跑')
})

test('照片在画布上解码成一片空白时，给的是「原图太大」而不是「没有二维码」', async () => {
  const env = {
    readImageData: async () => ({ data: new Uint8ClampedArray(1024), width: 16, height: 16 }),
    jsQR: () => null,
  }
  const result = await scanBitmapForQr({ width: 4000, height: 3000 }, env)
  assert.equal(result.ok, false)
  assert.match(result.error, /空白/)
  assert.match(result.error, /从相册/)
})

test('looksBlank：纯色算空白，有明暗变化不算', () => {
  assert.equal(looksBlank({ data: new Uint8ClampedArray(256) }), true)
  assert.equal(looksBlank({ data: patternedData(64) }), false)
  assert.equal(looksBlank(undefined), true)
})

test('stretchContrast：灰蒙蒙的低对比照片被拉到黑白两头', () => {
  const data = new Uint8ClampedArray(64 * 4)
  for (let i = 0; i < 64; i += 1) {
    const value = i % 2 === 0 ? 104 : 168 // 只差 64 级灰：jsQR 二值化时几乎分不开
    data[i * 4] = value
    data[i * 4 + 1] = value
    data[i * 4 + 2] = value
    data[i * 4 + 3] = 255
  }
  const stretched = stretchContrast({ data, width: 8, height: 8 })
  const values = new Set()
  for (let i = 0; i < stretched.data.length; i += 4) values.add(stretched.data[i])
  assert.deepEqual([...values].sort((a, b) => a - b), [0, 255])
  assert.equal(data[0], 104, '不能就地改掉调用方的像素')
})

test('stretchContrast：本来就没有动态范围时原样返回（别把噪点放大成花）', () => {
  const data = new Uint8ClampedArray(64 * 4).fill(200)
  const result = stretchContrast({ data, width: 8, height: 8 })
  assert.equal(result.data, data)
})

test('createBrowserQrReader：createImageBitmap 抛错（HEIC 等）时退回 <img> 解码', async () => {
  const image = { tagName: 'IMG', naturalWidth: 600, naturalHeight: 600 }
  const reader = createBrowserQrReader({
    documentRef: {
      baseURI: 'http://host/openwhale/app',
      createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: patternedData(256), width: 16, height: 16 }) }) }),
      head: { appendChild() {} },
    },
    isSecureContext: false,
    loadJsQr: async () => () => ({ data: 'https://example.test/#p=x' }),
    BarcodeDetectorImpl: undefined,
  })
  const closed = []
  reader.loadBitmap = async () => ({ width: 600, height: 600, source: image, close: () => closed.push('old') })
  const result = await reader.scanFile(new Blob([]), {})
  assert.match(result.error, /二维码内容无效/, '解码通了才会走到载荷解析')
  assert.deepEqual(closed, ['old'], 'bitmap 用完必须关掉，否则连拍几张就 OOM')
})

test('createBrowserQrReader：失败结果带上照片尺寸/大小，便于真机定位', async () => {
  const reader = createBrowserQrReader({
    documentRef: {
      baseURI: 'http://host/openwhale/app',
      createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: patternedData(256), width: 16, height: 16 }) }) }),
      head: { appendChild() {} },
    },
    isSecureContext: false,
    loadJsQr: async () => () => null,
    BarcodeDetectorImpl: undefined,
  })
  reader.loadBitmap = async () => ({ width: 3024, height: 4032, close() {} })
  const file = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' })
  const result = await reader.scanFile(file, {})
  assert.equal(result.ok, false)
  assert.deepEqual(result.image, { width: 3024, height: 4032, bytes: 2048, type: 'image/jpeg' })
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
      return { data: patternedData(Math.max(64, width * height)), width, height }
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
    readImageData: async () => ({ data: patternedData(256), width: 16, height: 16 }),
    jsQR: () => ({ data: PAYLOAD_TEXT }),
  }
  const result = await scanBitmapForQr({ width: 500, height: 500 }, env)
  assert.equal(result.ok, true)
  assert.equal(result.method, 'jsqr')
})

test('图里没有二维码时给出可操作文案', async () => {
  // 必须有明暗变化：纯色像素会被判定成「画布空白」（那是另一种故障，另有测试）。
  const data = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < data.length; i += 4) {
    const value = (i / 4) % 2 === 0 ? 20 : 235
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255
  }
  const env = {
    readImageData: async () => ({ data, width: 16, height: 16 }),
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

test('readPairingFromBitmap：官方短码（?s=）交给 resolveText 兑换', async () => {
  const env = {
    detectBarcodes: async () => ['http://192.168.43.5:8787/openwhale/app?s=SHORT_SECRET_123456'],
    readImageData: async () => {
      throw new Error('should not be called')
    },
    jsQR: () => null,
  }
  const seen = []
  const result = await readPairingFromBitmap({ width: 600, height: 600 }, env, {
    now: NOW,
    resolveText: async text => {
      seen.push(text)
      return { ok: true, payload: JSON.parse(PAYLOAD_TEXT), source: 'secret' }
    },
  })
  assert.deepEqual(seen, ['http://192.168.43.5:8787/openwhale/app?s=SHORT_SECRET_123456'])
  assert.equal(result.ok, true)
  assert.equal(result.payload.id, 'cmp_1')
  assert.equal(result.source, 'secret')
  // 来源要标出来：短码和整段载荷在诊断里是两回事。
  assert.equal(result.method, 'barcode-detector')
})

test('readPairingFromBitmap：短码兑换失败时把真实原因带出来', async () => {
  const env = {
    detectBarcodes: async () => ['http://192.168.43.5:8787/openwhale/app?s=EXPIRED_SECRET_1234'],
    readImageData: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    jsQR: () => null,
  }
  const result = await readPairingFromBitmap({ width: 600, height: 600 }, env, {
    now: NOW,
    resolveText: async () => ({ ok: false, error: '这个二维码已过期或已被使用' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /已过期/)
})

test('readPairingFromBitmap：兑换函数抛错也不能把页面卡在「正在识别」', async () => {
  const env = {
    detectBarcodes: async () => ['http://192.168.43.5:8787/openwhale/app?s=BOOM_SECRET_123456'],
    readImageData: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    jsQR: () => null,
  }
  const result = await readPairingFromBitmap({ width: 600, height: 600 }, env, {
    now: NOW,
    resolveText: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /无法兑换短二维码/)
})

test('readPairingFromBitmap：没有 resolveText 时短码仍然报「内容无效」', async () => {
  const env = {
    detectBarcodes: async () => ['http://192.168.43.5:8787/openwhale/app?s=SHORT_SECRET_123456'],
    readImageData: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    jsQR: () => null,
  }
  const result = await readPairingFromBitmap({ width: 600, height: 600 }, env, { now: NOW })
  assert.equal(result.ok, false)
  assert.match(result.error, /二维码内容无效/)
})

test('scanBitmapForQr 必须 await 异步 jsQR（浏览器里要先动态加载 vendor）', async () => {
  const env = {
    detectBarcodes: async () => [],
    readImageData: () => ({ data: patternedData(256), width: 16, height: 16 }),
    // 浏览器实现是 `async (...args) => (await loadJsQr())(...args)`：返回 Promise。
    jsQR: async () => ({ data: 'http://192.168.43.222:8787/openwhale/app?s=SECRET_123' }),
  }
  const result = await scanBitmapForQr({ width: 800, height: 800 }, env)
  assert.equal(result.ok, true, '异步 jsQR 被当成同步调用时恒为 undefined，整张图会被误判成「没有二维码」')
  assert.equal(result.text, 'http://192.168.43.222:8787/openwhale/app?s=SECRET_123')
  assert.equal(result.method, 'jsqr')
})

test('createBrowserQrReader：没有 createImageBitmap 时用 <img> 元素本身解码', async () => {
  const image = { tagName: 'IMG', naturalWidth: 600, naturalHeight: 600 }
  const seen = []
  const reader = createBrowserQrReader({
    documentRef: {
      baseURI: 'http://host/openwhale/app',
      createElement: () => ({ getContext: () => ({ drawImage: target => seen.push(target), getImageData: () => ({ data: patternedData(256), width: 16, height: 16 }) }) }),
      head: { appendChild() {} },
    },
    isSecureContext: false,
    loadJsQr: async () => () => ({ data: 'https://example.test/#p=x' }),
    BarcodeDetectorImpl: undefined,
  })
  // 模拟 `loadBitmap` 走进 `<img>` 兜底：返回带 source 的包装对象。
  reader.loadBitmap = async () => ({ width: image.naturalWidth, height: image.naturalHeight, source: image, close() {} })
  const result = await reader.scanFile(new Blob([]), {})
  assert.equal(seen[0], image, 'drawImage 必须拿到 <img> 本身，不能是包装对象')
  // 解出了文本但只是个普通链接：说明解码路径通了，卡在载荷解析（预期）。
  assert.match(result.error, /二维码内容无效/)
})
