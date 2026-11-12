// 从相册/截图里识别绑定二维码。
//
// 为什么网页版也要做这件事：鸿蒙 NEXT 和 iOS 没有「扫码后直接打开网页」的可靠
// 自动化路径；用户经常是把电脑上的二维码截了图，再从相册里选图。所以：
//   1. 有 `BarcodeDetector`（Chrome/鸿蒙浏览器等）时优先用它 —— 原生解码，快；
//   2. 否则 fallback 到本地 vendor 的 jsQR（纯 JS，Safari/Firefox 都能用）；
//   3. 大图先缩到 1024 / 2048 两档再解（4000×3000 原图直接解码会 OOM，研究报告结论）。
//
// 纯逻辑（尺寸规划、管线调度、结果校验）在这里，DOM 细节由 `createBrowserQrReader`
// 收口；`test/qr.test.mjs` 用假 bitmap / 假 jsQR 覆盖调度逻辑。

import { parsePairingInput } from './pairing.mjs'

/** 解码尝试的缩放宽度（先小后大：小图快、识别率不够再上大图）。 */
export const QR_SCAN_WIDTHS = Object.freeze([1024, 2048])

/** 拍照场景的完整阶梯：全图三档 → 低对比度增强 → 3×3 原分辨率裁块。 */
export const QR_PHOTO_WIDTHS = Object.freeze([1024, 1600, 2400])

/** 扫图失败的默认文案（与手机端保持一致的语气）。 */
export const QR_NOT_FOUND_MESSAGE = '这张图里没有找到二维码。换一张更清晰、二维码更大的截图再试。'

/**
 * 规划缩放尺寸：保持宽高比，只缩小不放大；去重。
 * @param {number} width
 * @param {number} height
 * @param {readonly number[]} [widths]
 * @returns {Array<{width: number, height: number}>}
 */
export function planScanSizes(width, height, widths = QR_SCAN_WIDTHS) {
  const naturalWidth = Math.max(0, Math.floor(Number(width) || 0))
  const naturalHeight = Math.max(0, Math.floor(Number(height) || 0))
  if (naturalWidth === 0 || naturalHeight === 0) return []
  const sizes = []
  const seen = new Set()
  for (const target of widths) {
    const scale = Math.min(1, Number(target) / naturalWidth)
    const outWidth = Math.max(1, Math.round(naturalWidth * scale))
    const outHeight = Math.max(1, Math.round(naturalHeight * scale))
    const key = `${outWidth}x${outHeight}`
    if (seen.has(key)) continue
    seen.add(key)
    sizes.push({ width: outWidth, height: outHeight })
  }
  return sizes
}

/**
 * 在给定环境下扫一张已经解码成 bitmap 的图片。
 *
 * 环境注入（浏览器实现见 `createBrowserQrReader`，测试里是假对象）：
 *  - detectBarcodes?(bitmap): Promise<string[]>  原生 BarcodeDetector
 *  - readImageData(bitmap, width, height, attempt): Promise<{data, width, height}>
 *  - jsQR(data, width, height, options): {data?: string} | null
 * @param {{width: number, height: number}} bitmap
 * @param {object} env
 * @param {{widths?: readonly number[]}} [options]
 * @returns {Promise<{ok: true, text: string, method: 'barcode-detector'|'jsqr', attempt?: any} | {ok: false, error: string, detail?: any}>}
 */
export async function scanBitmapForQr(bitmap, env, options = {}) {
  if (!bitmap || !Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height)) {
    return { ok: false, error: '无法读取这张图片，请换一张截图。' }
  }
  if (typeof env?.detectBarcodes === 'function') {
    try {
      const results = await env.detectBarcodes(bitmap)
      const text = Array.isArray(results) ? results.find(item => typeof item === 'string' && item.trim() !== '') : ''
      if (text) return { ok: true, text: text.trim(), method: 'barcode-detector' }
    } catch {
      // 系统解码器不可用（比如图片格式不支持）→ 老老实实走 jsQR。
    }
  }
  if (typeof env?.readImageData !== 'function' || typeof env?.jsQR !== 'function') {
    return { ok: false, error: '当前浏览器不支持图片解码，请改用相机/系统扫码打开绑定链接。' }
  }
  const attempts = planScanAttempts(bitmap.width, bitmap.height, options)
  let blank = 0
  for (const attempt of attempts) {
    try {
      const image = await env.readImageData(bitmap, attempt.width, attempt.height, attempt)
      if (!image?.data) continue
      // 超大照片在部分手机 WebView 上会「画上去一片空白」（canvas 尺寸/纹理上限），
      // 这种图再喂给 jsQR 也不会成功，但要能和其他失败原因区分开。
      if (looksBlank(image)) {
        blank += 1
        continue
      }
      const prepared = attempt.contrast ? stretchContrast(image) : image
      // jsQR 可能是同步的（测试 / 已经加载过），也可能是异步的（浏览器里要先 await
      // 动态加载 250 KB 的 vendor 脚本）。这里必须 await：不 await 拿到的是 Promise，
      // `code.data` 恒为 undefined，于是每一张图都报「没有找到二维码」——真机上
      // 「选择二维码图片」一直不可用就是这个原因。
      const code = await env.jsQR(prepared.data, prepared.width ?? attempt.width, prepared.height ?? attempt.height, {
        inversionAttempts: 'attemptBoth',
      })
      const text = typeof code?.data === 'string' ? code.data.trim() : ''
      if (text !== '') return { ok: true, text, method: 'jsqr', attempt }
    } catch {
      // 某一张尺寸解码失败不影响下一张（例如 canvas 被 taint）。
    }
  }
  if (attempts.length > 1 && blank === attempts.length) {
    return {
      ok: false,
      error: '这张照片在浏览器里解码成了一片空白（常见于手机原图过大），请改用「从相册」选一张截图，或离屏幕近一点重拍。',
      detail: { attempts: attempts.length, blank },
    }
  }
  return { ok: false, error: QR_NOT_FOUND_MESSAGE, detail: { attempts: attempts.length, blank } }
}

/**
 * 拍照阶梯的裁块参数：3×3 网格、相邻块重叠 12%（二维码正好压在两块之间也能完整落进一块）。
 */
export const QR_TILE_GRID = 3
export const QR_TILE_OVERLAP = 0.12
/** 只有长边不小于这个值才值得裁块——小图裁完只会更糊。 */
export const QR_TILE_MIN_EDGE = 1600
/** 单块渲染宽度上限：jsQR 在 1200～1400 px 上最稳，再大只是变慢。 */
export const QR_TILE_MAX_WIDTH = 1400

/**
 * 把照片切成互相重叠的方块，每块用接近原图的分辨率渲染。
 *
 * 为什么需要这一层：「对着电脑屏幕拍一张」时二维码常常只占画面 10%，
 * 整幅缩到 1024 宽以后一个模块只剩 2～3 个像素，jsQR 必然认不出来；
 * 而原图直接跑 jsQR 又慢到不可用。裁块是两头都照顾的做法。
 * @param {number} width
 * @param {number} height
 * @returns {Array<{x: number, y: number, width: number, height: number, renderWidth: number, renderHeight: number}>}
 */
export function planScanTiles(width, height, options = {}) {
  const naturalWidth = Math.max(0, Math.floor(Number(width) || 0))
  const naturalHeight = Math.max(0, Math.floor(Number(height) || 0))
  if (naturalWidth === 0 || naturalHeight === 0) return []
  const grid = options.grid ?? QR_TILE_GRID
  const overlap = options.overlap ?? QR_TILE_OVERLAP
  const maxWidth = options.maxWidth ?? QR_TILE_MAX_WIDTH
  if (grid < 1) return []
  const tileWidth = naturalWidth / (grid - (grid - 1) * overlap)
  const tileHeight = naturalHeight / (grid - (grid - 1) * overlap)
  const stepX = tileWidth * (1 - overlap)
  const stepY = tileHeight * (1 - overlap)
  const tiles = []
  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      const x = Math.min(Math.round(column * stepX), Math.max(0, naturalWidth - 1))
      const y = Math.min(Math.round(row * stepY), Math.max(0, naturalHeight - 1))
      const cropWidth = Math.max(1, Math.min(Math.round(tileWidth), naturalWidth - x))
      const cropHeight = Math.max(1, Math.min(Math.round(tileHeight), naturalHeight - y))
      // 只缩小不放大：块本身比 maxWidth 小就按原样跑。
      const scale = Math.min(1, maxWidth / cropWidth)
      tiles.push({
        x,
        y,
        width: cropWidth,
        height: cropHeight,
        renderWidth: Math.max(1, Math.round(cropWidth * scale)),
        renderHeight: Math.max(1, Math.round(cropHeight * scale)),
      })
    }
  }
  return tiles
}

/**
 * 解码阶梯：先便宜后昂贵，任何一步成功就返回。
 *
 *  1. 整幅 1024 —— 截图、正对的照片在这一步就够了（几十毫秒）；
 *  2. 整幅 2048 —— 稍微远一点的照片；
 *  3. 整幅 2048 + 直方图拉伸 —— 屏幕反光、暗光、白平衡偏掉的照片；
 *  4. 3×3 原分辨率裁块 —— 二维码在画面里只占一小块的照片（手机对着屏幕拍的典型形态）。
 * @param {number} width
 * @param {number} height
 * @param {{widths?: readonly number[], tiles?: boolean}} [options]
 * @returns {Array<{kind: string, width: number, height: number, source: null | {x: number, y: number, width: number, height: number}, contrast: boolean}>}
 */
export function planScanAttempts(width, height, options = {}) {
  const naturalWidth = Math.max(0, Math.floor(Number(width) || 0))
  const naturalHeight = Math.max(0, Math.floor(Number(height) || 0))
  if (naturalWidth === 0 || naturalHeight === 0) return []
  const sizes = planScanSizes(naturalWidth, naturalHeight, options.widths ?? QR_SCAN_WIDTHS)
  if (sizes.length === 0) return []
  const attempts = sizes.map(size => ({
    kind: 'full',
    width: size.width,
    height: size.height,
    source: null,
    contrast: false,
  }))
  const largest = sizes[sizes.length - 1]
  attempts.push({
    kind: 'full-contrast',
    width: largest.width,
    height: largest.height,
    source: null,
    contrast: true,
  })
  if (options.tiles !== false && Math.max(naturalWidth, naturalHeight) >= QR_TILE_MIN_EDGE) {
    for (const tile of planScanTiles(naturalWidth, naturalHeight)) {
      attempts.push({
        kind: 'tile',
        width: tile.renderWidth,
        height: tile.renderHeight,
        source: { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
        contrast: false,
      })
    }
  }
  return attempts
}

/**
 * 画布上是不是一片纯色（手机 WebView 对超大图常见：drawImage 成功、像素却全白/全黑）。
 * @param {{data?: Uint8ClampedArray}} image
 * @returns {boolean}
 */
export function looksBlank(image) {
  const data = image?.data
  if (!data || data.length < 64) return true
  const pixels = Math.floor(data.length / 4)
  // 步长强制取奇数：偶数步长会正好踩在偶数像素上，遇到明暗交替的图（摩尔纹、条纹）
  // 会清一色采到同一种颜色，把有内容的照片误判成空白。
  const step = Math.max(1, Math.floor(pixels / 512) | 1)
  let min = 255
  let max = 0
  for (let pixel = 0; pixel < pixels; pixel += step) {
    const i = pixel * 4
    const luminance = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
    if (luminance < min) min = luminance
    if (luminance > max) max = luminance
    if (max - min >= 8) return false
  }
  return max - min < 8
}

/**
 * 直方图拉伸（5% / 95% 分位），把「灰蒙蒙」的照片拉回黑白分明——jsQR 的二值化
 * 对低对比度很敏感，而手机拍屏幕最常见的退化就是对比度掉了。
 * @param {{data: Uint8ClampedArray, width?: number, height?: number}} image
 * @returns {{data: Uint8ClampedArray, width?: number, height?: number}}
 */
export function stretchContrast(image) {
  const source = image?.data
  if (!source || source.length < 64) return image
  const data = new Uint8ClampedArray(source)
  const histogram = new Uint32Array(256)
  let total = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    histogram[Math.min(255, Math.max(0, Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000)))] += 1
    total += 1
  }
  const lowTarget = total * 0.05
  let low = 0
  let acc = 0
  for (let value = 0; value < 256; value += 1) {
    acc += histogram[value]
    if (acc >= lowTarget) {
      low = value
      break
    }
  }
  let high = 255
  acc = 0
  for (let value = 255; value >= 0; value -= 1) {
    acc += histogram[value]
    if (acc >= lowTarget) {
      high = value
      break
    }
  }
  // 本来就没有动态范围（纯白/纯黑/几乎一致）时拉伸只会把噪点放大成花。
  if (high - low < 24) return image
  const span = high - low
  const table = new Uint8ClampedArray(256)
  for (let value = 0; value < 256; value += 1) {
    table[value] = Math.max(0, Math.min(255, Math.round(((value - low) * 255) / span)))
  }
  for (let i = 0; i + 3 < data.length; i += 4) {
    data[i] = table[data[i]]
    data[i + 1] = table[data[i + 1]]
    data[i + 2] = table[data[i + 2]]
  }
  return { ...image, data }
}

/**
 * 扫图 → 解析绑定载荷（一条龙）。
 *
 * `resolveText` 是给**短二维码**留的：电脑上那张码只有
 * `http://<ip>:8787/openwhale/app?s=<一次性密钥>` 九十来个字符，本身不含载荷，
 * 必须回到同源的 `/openwhale/pairing.json` 兑换。只有 `parsePairingInput`
 * 认不出来（也就是短码）时才调用它——整段 `#p=` 的旧码不受影响。
 * @param {{width: number, height: number}} bitmap
 * @param {object} env
 * @param {{now?: number, resolveText?: (text: string, context: {now: number}) => Promise<{ok: true, payload: any, source?: string} | {ok: false, error: string}>}} [options]
 * @returns {Promise<{ok: true, payload: any, source: string, method: string} | {ok: false, error: string}>}
 */
export async function readPairingFromBitmap(bitmap, env, options = {}) {
  const scanned = await scanBitmapForQr(bitmap, env, options)
  if (!scanned.ok) return scanned
  const now = options.now ?? Date.now()
  const parsed = parsePairingInput(scanned.text, { now })
  if (parsed.ok) return { ...parsed, method: scanned.method }
  if (typeof options.resolveText === 'function') {
    let resolved
    try {
      resolved = await options.resolveText(scanned.text, { now })
    } catch (error) {
      resolved = { ok: false, error: `无法兑换短二维码：${/** @type {Error} */ (error).message}` }
    }
    if (resolved?.ok && resolved.payload) {
      return { ok: true, payload: resolved.payload, source: resolved.source ?? 'secret', method: scanned.method }
    }
    return { ok: false, error: `二维码内容无效：${resolved?.error ?? parsed.error}` }
  }
  return { ok: false, error: `二维码内容无效：${parsed.error}` }
}

/**
 * 浏览器环境实现。
 *
 * 注意 `<script>` 动态加载 jsQR：只有用户真的点「从相册识别」时才下载 250 KB，
 * 首屏不为很少用的功能买单。
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {() => Promise<any>} [options.loadJsQr] 返回 jsQR 函数
 * @param {any} [options.BarcodeDetectorImpl] 覆盖 window.BarcodeDetector（测试/特殊浏览器）
 * @param {boolean} [options.isSecureContext]
 * @returns {object}
 */
export function createBrowserQrReader(options = {}) {
  const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : undefined)
  const loadJsQr = options.loadJsQr ?? (() => loadJsQrFromVendor(documentRef))
  const BarcodeDetectorImpl = options.BarcodeDetectorImpl
    ?? (typeof globalThis !== 'undefined' ? globalThis.BarcodeDetector : undefined)
  const isSecureContext = options.isSecureContext
    ?? (typeof globalThis !== 'undefined' ? globalThis.isSecureContext !== false : false)

  /** 原生 BarcodeDetector 需要安全上下文（https / localhost），否则构造会抛错。 */
  const detector = (() => {
    if (!BarcodeDetectorImpl || !isSecureContext) return undefined
    try {
      const instance = new BarcodeDetectorImpl({ formats: ['qr_code'] })
      return instance
    } catch {
      return undefined
    }
  })()

  return {
    /** 是否能避免下载 jsQR（仅供设置页显示诊断信息）。 */
    get hasBarcodeDetector() {
      return Boolean(detector)
    },
    /**
     * 把 File/Blob 解码成 bitmap。
     *
     * 两个坑都在真机上踩过：
     *  - 手机原图带 EXIF 方向，必须 `imageOrientation: 'from-image'` 让浏览器先转正；
     *  - 某些编码（HEIC、部分 HEIF/RAW 直出）`createImageBitmap` 直接抛错，
     *    而 `<img>` 走的是另一套解码器，常常还能读——所以失败要能退回 `<img>`，
     *    否则用户只会看到「图片识别失败」，永远不知道为什么。
     * @param {Blob} file
     */
    async loadBitmap(file) {
      if (typeof createImageBitmap === 'function') {
        try {
          return await createImageBitmap(file, { imageOrientation: 'from-image' })
        } catch {
          // 落回 <img>：方向由浏览器按 EXIF 自动处理。
        }
      }
      return loadImageElement(file, documentRef)
    },
    /**
     * @param {Blob} file
     * @param {{resolveText?: (text: string, context: {now: number}) => Promise<any>}} [options]
     */
    async scanFile(file, options = {}) {
      const original = await this.loadBitmap(file)
      // 手机原图动辄 4000～8000 px。把这么大的 bitmap 直接 drawImage 到小画布上，
      // 在移动端 GPU 上会撞纹理上限（>4096 常常画出一片空白），而且一次双线性
      // 缩小会把二维码糊成灰块。先让浏览器自己做一次高质量缩放，后面所有尝试
      // 都在这张「工作图」上做——这也是「拍照能识别」和「拍照永远认不出」的分水岭。
      const bitmap = await shrinkBitmap(original)
      // 没有 `createImageBitmap` 的浏览器（老 Safari / 部分 WebView）走的是
      // `<img>` 兜底，那时 bitmap 是一个带 width/height 的包装对象，**不能**直接
      // 喂给 drawImage / BarcodeDetector —— 必须用里面的 `source`（真正的图片元素）。
      const drawable = image => image?.source ?? image
      try {
        const env = {
          detectBarcodes: async image => {
            if (!detector) return []
            const results = await detector.detect(drawable(image))
            return (results ?? []).map(item => (typeof item?.rawValue === 'string' ? item.rawValue : '')).filter(Boolean)
          },
          readImageData: (image, width, height, attempt) =>
            readImageData(documentRef, drawable(image), width, height, attempt?.source),
          jsQR: async (...args) => (await loadJsQr())(...args),
        }
        // 直接把 bitmap 传下去：`<img>` 兜底时它是带 `source` 的包装对象，
        // 重新包成 `{width, height}` 会把 `source` 丢掉。
        const result = await readPairingFromBitmap(bitmap, env, options)
        // 带上照片本身的信息：失败时 UI 能说清「是这张图多大、什么格式」，
        // 而不是只有一句「没有找到二维码」。
        return {
          ...result,
          image: {
            width: Math.round(Number(original?.width) || 0),
            height: Math.round(Number(original?.height) || 0),
            bytes: Number(file?.size) || 0,
            type: file?.type ?? '',
          },
        }
      } finally {
        if (bitmap !== original && typeof bitmap.close === 'function') bitmap.close()
        if (typeof original?.close === 'function') original.close()
      }
    },
  }
}

/**
 * 工作图的长边上限：再大也只是让每次 drawImage 更慢，而且更容易撞上移动端
 * GPU 的纹理上限（4096）。
 */
export const QR_WORK_MAX_EDGE = 2400

/**
 * 用浏览器自己的重采样把超大原图缩到工作尺寸（`resizeQuality: 'high'` 是区域平均，
 * 比 canvas 的一次双线性缩小干净得多）。不支持时原样返回，调用方照常往下跑。
 * @param {any} bitmap
 * @returns {Promise<any>}
 */
async function shrinkBitmap(bitmap) {
  const width = Math.round(Number(bitmap?.width) || 0)
  const height = Math.round(Number(bitmap?.height) || 0)
  const edge = Math.max(width, height)
  if (edge <= QR_WORK_MAX_EDGE || width === 0 || height === 0) return bitmap
  if (typeof createImageBitmap !== 'function') return bitmap
  const scale = QR_WORK_MAX_EDGE / edge
  try {
    return await createImageBitmap(bitmap?.source ?? bitmap, {
      resizeWidth: Math.max(1, Math.round(width * scale)),
      resizeHeight: Math.max(1, Math.round(height * scale)),
      resizeQuality: 'high',
    })
  } catch {
    return bitmap
  }
}

/**
 * @param {Document | undefined} documentRef
 * @param {any} image
 * @param {number} width
 * @param {number} height
 * @param {{x: number, y: number, width: number, height: number} | null} [source] 只渲染原图的这一块（裁块扫描）
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
function readImageData(documentRef, image, width, height, source) {
  if (!documentRef) throw new Error('没有 DOM，无法读取像素')
  const canvas = documentRef.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器不支持 canvas 2d')
  // 裁块时把源矩形放大画满整块画布：一个模块从 2px 变回 8px，jsQR 才认得出。
  if (source) {
    context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height)
  } else {
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
  }
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

/**
 * @param {Blob} file
 * @param {Document | undefined} documentRef
 * @returns {Promise<{width: number, height: number, close: () => void}>}
 */
function loadImageElement(file, documentRef) {
  if (!documentRef || typeof URL === 'undefined') throw new Error('当前浏览器不支持图片解码')
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        // `source` 是真正能 drawImage 的对象；`width/height` 只是给调度用的尺寸。
        source: image,
        element: image,
        close() {
          URL.revokeObjectURL(url)
        },
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片无法解码（换一张截图试试）'))
    }
    image.src = url
  })
}

/**
 * 本地 vendor 的 jsQR 是 UMD 文件，按需插入 `<script>` 后从 window 上取。
 * @param {Document | undefined} documentRef
 * @returns {Promise<any>}
 */
export function loadJsQrFromVendor(documentRef) {
  const existing = typeof globalThis !== 'undefined' ? globalThis.jsQR : undefined
  if (typeof existing === 'function') return Promise.resolve(existing)
  if (!documentRef) return Promise.reject(new Error('没有 DOM，无法加载 jsQR'))
  return new Promise((resolve, reject) => {
    const script = documentRef.createElement('script')
    // 用**模块自己的地址**解析 vendor：页面是 `/openwhale/app`（没有尾斜杠）、
    // 还是 `/openwhale/app/`，`document.baseURI` 会解析出两个不同的路径——其中一个
    // 是 404。模块地址永远指向 `/openwhale/app/lib/`，跟页面 URL 怎么写无关。
    script.src = (() => {
      try {
        return new URL('../vendor/jsqr.js', import.meta.url).href
      } catch {
        return new URL('./vendor/jsqr.js', documentRef.baseURI).href
      }
    })()
    script.async = true
    script.onload = () => {
      const jsQR = typeof globalThis !== 'undefined' ? globalThis.jsQR : undefined
      if (typeof jsQR === 'function') resolve(jsQR)
      else reject(new Error('jsQR 加载后没有导出解码函数'))
    }
    script.onerror = () => reject(new Error('jsQR 加载失败（网络问题）'))
    documentRef.head.appendChild(script)
  })
}
