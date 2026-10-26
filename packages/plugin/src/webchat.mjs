// /openwhale/app 静态资源服务：插件内置的 Web/PWA 客户端。
//
// 为什么内置：鸿蒙/iOS 没有现成安装包时，用系统相机扫电脑上的第二个二维码就能
// 打开一个可用的聊天界面，无需装 App。它由 `packages/webchat`（开发布局）或
// `<插件包>/webchat`（打包布局）提供，插件只负责按 URL 把文件发出去。
//
// 这里有两个真实会踩的坑：
//  · 原生 ESM 与 Service Worker 对 MIME 极严格：`.mjs` 回成 `text/plain` 时
//    浏览器直接拒绝执行（`Failed to load module script`），所以扩展名表必须
//    完整，缺省也**不能**用 text/plain；
//  · 静态服务最常见的漏洞是路径穿越，`..`、`%2e%2e`、`..%2f` 都要在解码后统一
//    拦截，且解析出的绝对路径必须仍在上传目录内。
import { createReadStream, existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { WEB_CLIENT_PATH } from './protocol.mjs'

/** 本文件所在目录与插件包根目录（源码布局即 packages/plugin）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = dirname(MODULE_DIR)

/**
 * 按优先级列出可能存放 Web 客户端的目录。
 *
 * 开发形态：`packages/plugin/src/webchat.mjs` → `packages/webchat`；
 * 打包形态：`<插件包>/webchat`（`scripts/build-plugin-package.mjs` 会复制进去）。
 * @param {string} [packageRoot]
 * @returns {string[]}
 */
export function webClientCandidates(packageRoot = PACKAGE_ROOT) {
  return [
    join(packageRoot, 'webchat'),
    join(packageRoot, '..', 'webchat'),
  ].map(dir => resolve(dir))
}

/**
 * 找到第一个真正包含 `index.html` 的 Web 客户端目录。
 * @param {{packageRoot?: string, candidates?: string[]}} [options]
 * @returns {string | undefined}
 */
export function resolveWebClientDir(options = {}) {
  const candidates = options.candidates ?? webClientCandidates(options.packageRoot ?? PACKAGE_ROOT)
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue
      if (!statSync(join(dir, 'index.html')).isFile()) continue
      return dir
    } catch { /* 目录不可读就继续看下一个候选 */ }
  }
  return undefined
}

/** 扩展名 → Content-Type。顺序无所谓，查表即可。 */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
})

/**
 * @param {string} file
 * @returns {string}
 */
export function contentTypeFor(file) {
  return CONTENT_TYPES[extname(String(file ?? '')).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * `WebClientServer` 处理 `/openwhale/app` 前缀下的 GET/HEAD。
 *
 * 它只回答这个前缀；返回 `false` 表示「不是我的路径」，网关据此继续路由。
 */
export class WebClientServer {
  /**
   * @param {{dirs?: Array<string | undefined>, candidates?: string[], log?: (message: string) => void}} [options]
   */
  constructor(options = {}) {
    this.dirs = (options.dirs ?? options.candidates ?? []).filter(Boolean)
    this.log = options.log ?? (() => {})
  }

  /** 是否有可用的客户端目录（插件页面据此决定是否显示网页版二维码）。 */
  available() {
    return this.directory() !== undefined
  }

  /** @returns {string | undefined} */
  directory() {
    for (const dir of this.dirs) {
      try {
        if (existsSync(join(dir, 'index.html'))) return dir
      } catch { /* ignore */ }
    }
    return undefined
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} true 表示已处理
   */
  async handle(req, res) {
    const pathname = readPathname(req.url)
    if (pathname !== WEB_CLIENT_PATH && !pathname.startsWith(`${WEB_CLIENT_PATH}/`)) return false

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return this.#text(res, 405, '请用 GET 访问', { allow: 'GET, HEAD' })
    }

    const dir = this.directory()
    if (!dir) {
      return this.#text(
        res,
        404,
        '网页版客户端未安装：没有找到 webchat 目录（开发布局应为 packages/webchat，打包后应为插件包内的 webchat）。',
      )
    }

    const relative = this.#relativePath(pathname)
    if (relative === undefined) return this.#text(res, 404, '未找到该资源')
    const filePath = this.#resolveInside(dir, relative)
    if (!filePath) {
      this.log(`webchat: 拒绝越界路径 ${pathname}`)
      return this.#text(res, 404, '未找到该资源')
    }

    let info
    try {
      info = await stat(filePath)
    } catch {
      return this.#text(res, 404, '未找到该资源')
    }
    if (!info.isFile()) return this.#text(res, 404, '未找到该资源')

    // index.html 必须 no-store：Web 客户端随插件更新，缓存住会让用户一直跑旧版。
    const isIndex = relative === 'index.html'
    const headers = {
      'content-type': contentTypeFor(filePath),
      'content-length': String(info.size),
      'cache-control': isIndex ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    try {
      await pipeline(createReadStream(filePath), res)
    } catch (error) {
      // 客户端中断下载时很常见，不值得把整台插件搞崩。
      this.log(`webchat: 发送 ${relative} 失败：${/** @type {Error} */ (error).message}`)
    }
    return true
  }

  /**
   * `/openwhale/app` → index.html；子路径去掉前缀后的相对路径。
   * @param {string} pathname
   * @returns {string | undefined}
   */
  #relativePath(pathname) {
    let tail = pathname.slice(WEB_CLIENT_PATH.length)
    try {
      tail = decodeURIComponent(tail)
    } catch {
      return undefined
    }
    tail = tail.replace(/^[/\\]+/, '')
    if (tail === '') return 'index.html'
    return tail
  }

  /**
   * 把相对路径解析到目录内，并拒绝一切越界写法。
   * @param {string} dir
   * @param {string} relative
   * @returns {string | undefined}
   */
  #resolveInside(dir, relative) {
    if (relative.includes('\u0000')) return undefined
    const segments = relative.split(/[\\/]+/)
    if (segments.some(segment => segment === '..' || segment === '.' || segment === '')) return undefined
    // 隐藏文件（.env 等）不通过静态服务暴露。
    if (segments.some(segment => segment.startsWith('.'))) return undefined
    const absolute = resolve(dir, relative)
    if (absolute !== dir && !absolute.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)) return undefined
    return absolute
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} message
   * @param {Record<string, string>} [extra]
   * @returns {true}
   */
  #text(res, status, message, extra = {}) {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    })
    res.end(message)
    return true
  }
}

/**
 * `new URL` 会把 `..` 规范化掉，但解码后的路径仍可能带 `%2f` 之类，所以这里
 * 只取 pathname（不做解码），由 `#relativePath` 负责一次解码。
 * @param {string | undefined} rawUrl
 * @returns {string}
 */
function readPathname(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname
  } catch {
    return '/'
  }
}
