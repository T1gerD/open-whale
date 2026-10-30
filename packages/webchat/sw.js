// 离线壳 Service Worker（module worker：直接 import 协议镜像里的版本号，不手抄）。
//
// 职责边界（刻意收得很窄）：
//   * 只缓存「壳」——index.html / 样式 / 入口脚本 / lib / vendor / 图标，
//     让手机回到弱网或断网时还能打开界面并看到错误提示；
//   * **绝不缓存聊天内容与 WebSocket**：聊天是隐私数据，而且必须实时；
//   * 壳按**版本整体**缓存：缓存名由协议版本 + 网页版版本派生，一次部署一个快照，
//     `app.js` 与 `lib/*.mjs` 因此不可能来自两次不同的部署（v2.2.0 的
//     stale-while-revalidate 会逐个文件后台刷新，正好会造成这种混用）；
//   * 快照只有在**全部资源都拿到**时才生效；缺任何一个就整版回退到网络直连，
//     宁可没有离线壳，也不要把半新半旧的模块喂给浏览器。
//
// 注意：局域网 http:// 下浏览器禁止注册 Service Worker（非安全上下文），
// 此时网页版照常能用，只是没有离线壳 —— 详见 README 的「已知限制」。

import { PROTOCOL_VERSION, WEBCHAT_VERSION } from './lib/protocol.mjs'

/** 缓存名前缀；activate 只清理这个前缀的缓存，不碰同源的其它 Cache Storage。 */
const CACHE_PREFIX = 'ow-webchat-shell-v'

/**
 * 这一版壳的版本号：协议版本保证协议一升级就不会复用旧模块；网页版版本保证每次
 * 发布都是一个新快照。两者都来自 `lib/protocol.mjs`，这里不再手写版本号。
 */
const CACHE_VERSION = `${PROTOCOL_VERSION}-${WEBCHAT_VERSION}`
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`

/** 快照清单在缓存里的键（相对本 worker 的地址）。 */
const MANIFEST_URL = './__shell-manifest.json'

/** 壳资源清单：必须与 index.html / app.js 的实际引用保持一致。 */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './lib/bytes.mjs',
  './lib/protocol.mjs',
  './lib/endpoints.mjs',
  './lib/pairing.mjs',
  './lib/keys.mjs',
  './lib/messages.mjs',
  './lib/upload.mjs',
  './lib/connection.mjs',
  './lib/storage.mjs',
  './lib/qr.mjs',
  './vendor/tweetnacl.min.js',
  './vendor/jsqr.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
]

/** 缓存里的清单解析一次就够；同一个 worker 进程只服务一个版本。 */
let manifestPromise

/**
 * 读取本版本的壳清单；没有 / 损坏 / 不完整都当作「不可 cache-first」。
 * @returns {Promise<{version: string, complete: boolean, urls: string[]} | undefined>}
 */
function shellManifest() {
  manifestPromise ??= (async () => {
    try {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(MANIFEST_URL)
      if (!cached) return undefined
      const parsed = await cached.json()
      if (!parsed || parsed.version !== CACHE_VERSION) return undefined
      return {
        version: parsed.version,
        complete: parsed.complete === true,
        urls: Array.isArray(parsed.urls) ? parsed.urls.filter(url => typeof url === 'string') : [],
      }
    } catch {
      return undefined
    }
  })()
  return manifestPromise
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      /** @type {string[]} 真正写进缓存的绝对 URL。 */
      const urls = []
      // `addAll` 会因为任何一个资源 404 整体失败；逐个 add 更稳（比如图标缺失
      // 不该让整个 PWA 装不上）。`cache: 'reload'` 绕过 HTTP 缓存，拿到的就是
      // 这次部署的文件。
      await Promise.all(
        SHELL.map(async url => {
          try {
            const absolute = new URL(url, self.location.href).href
            const response = await fetch(new Request(absolute, { cache: 'reload' }))
            if (!response.ok) return
            await cache.put(absolute, response)
            urls.push(absolute)
          } catch {
            /* 单个资源失败忽略，但会让整版快照标记为不完整 */
          }
        }),
      )
      const complete = urls.length === SHELL.length
      await cache.put(
        MANIFEST_URL,
        new Response(JSON.stringify({ version: CACHE_VERSION, complete, urls }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const manifest = await shellManifest()
      // 只有本版快照完整时才敢删旧壳；不完整就留着旧缓存（反正不会被读取），
      // 等下一次发布成功安装时再清。
      if (manifest?.complete === true) {
        const keys = await caches.keys()
        await Promise.all(
          keys
            .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map(key => caches.delete(key)),
        )
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // 只处理同源静态壳；WebSocket、健康检查、下载、任何 API 都不碰。
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(new URL('./', self.location.href).pathname)) return
  if (url.pathname.endsWith('/sw.js')) return

  event.respondWith(
    (async () => {
      const manifest = await shellManifest()
      // 壳不完整：全部走网络，绝不把缓存里半旧的模块混给页面。
      if (!manifest?.complete) return fetch(request)

      const cache = await caches.open(CACHE_NAME)
      // 导航请求固定用快照里的 index.html：HTML 与 JS 必须是同一次部署。
      const key = request.mode === 'navigate' ? new URL('./index.html', self.location.href).href : request.url
      if (request.mode !== 'navigate' && !manifest.urls.includes(key)) {
        // 不在清单里的同源请求（未来新增的文件）：直接走网络，且不进缓存，
        // 这样这一版快照始终保持「同一个部署」。
        return fetch(request)
      }
      const cached = await cache.match(key)
      if (cached) return cached
      // 清单说应该有、缓存却没有（被浏览器清理过）：网络取一次，但不写缓存，
      // 避免把可能是下个部署的文件塞进这一版快照。
      try {
        return await fetch(request)
      } catch {
        return Response.error()
      }
    })(),
  )
})
