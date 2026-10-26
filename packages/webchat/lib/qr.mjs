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
 *  - readImageData(bitmap, width, height): Promise<{data: Uint8ClampedArray, width: number, height: number}>
 *  - jsQR(data, width, height, options): {data?: string} | null
 * @param {{width: number, height: number}} bitmap
 * @param {object} env
 * @param {{widths?: readonly number[]}} [options]
 * @returns {Promise<{ok: true, text: string, method: 'barcode-detector'|'jsqr'} | {ok: false, error: string}>}
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
  const sizes = planScanSizes(bitmap.width, bitmap.height, options.widths ?? QR_SCAN_WIDTHS)
  for (const size of sizes) {
    try {
      const image = await env.readImageData(bitmap, size.width, size.height)
      if (!image?.data) continue
      const code = env.jsQR(image.data, image.width ?? size.width, image.height ?? size.height, {
        inversionAttempts: 'attemptBoth',
      })
      const text = typeof code?.data === 'string' ? code.data.trim() : ''
      if (text !== '') return { ok: true, text, method: 'jsqr' }
    } catch {
      // 某一张尺寸解码失败不影响下一张（例如 canvas 被 taint）。
    }
  }
  return { ok: false, error: QR_NOT_FOUND_MESSAGE }
}

/**
 * 扫图 → 解析绑定载荷（一条龙）。
 * @param {{width: number, height: number}} bitmap
 * @param {object} env
 * @param {{now?: number}} [options]
 * @returns {Promise<{ok: true, payload: any, source: string, method: string} | {ok: false, error: string}>}
 */
export async function readPairingFromBitmap(bitmap, env, options = {}) {
  const scanned = await scanBitmapForQr(bitmap, env, options)
  if (!scanned.ok) return scanned
  const parsed = parsePairingInput(scanned.text, { now: options.now })
  if (!parsed.ok) {
    return { ok: false, error: `二维码内容无效：${parsed.error}` }
  }
  return { ...parsed, method: scanned.method }
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
     * @param {Blob} file
     */
    async loadBitmap(file) {
      if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file)
      }
      return loadImageElement(file, documentRef)
    },
    /** @param {Blob} file */
    async scanFile(file) {
      const bitmap = await this.loadBitmap(file)
      try {
        const env = {
          detectBarcodes: async image => {
            if (!detector) return []
            const results = await detector.detect(image)
            return (results ?? []).map(item => (typeof item?.rawValue === 'string' ? item.rawValue : '')).filter(Boolean)
          },
          readImageData: (image, width, height) => readImageData(documentRef, image, width, height),
          jsQR: async (...args) => (await loadJsQr())(...args),
        }
        const result = await readPairingFromBitmap({ width: bitmap.width, height: bitmap.height }, env)
        return result
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close()
      }
    },
  }
}

/**
 * @param {Document | undefined} documentRef
 * @param {any} image
 * @param {number} width
 * @param {number} height
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
function readImageData(documentRef, image, width, height) {
  if (!documentRef) throw new Error('没有 DOM，无法读取像素')
  const canvas = documentRef.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器不支持 canvas 2d')
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
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
    script.src = new URL('./vendor/jsqr.js', documentRef.baseURI).href
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
