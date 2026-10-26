// 离线壳 Service Worker。
//
// 职责边界（刻意收得很窄）：
//   * 只缓存「壳」——index.html / 样式 / 入口脚本 / lib / vendor / 图标，
//     让手机回到弱网或断网时还能打开界面并看到错误提示；
//   * **绝不缓存聊天内容与 WebSocket**：聊天是隐私数据，而且必须实时；
//   * 版本号变化时清掉旧缓存，避免用户卡在旧前端。
//
// 注意：局域网 http:// 下浏览器禁止注册 Service Worker（非安全上下文），
// 此时网页版照常能用，只是没有离线壳 —— 详见 README 的「已知限制」。

const CACHE_NAME = 'ow-webchat-shell-v2.2.0'

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

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // `addAll` 会因为任何一个资源 404 整体失败；逐个 add 更稳（比如图标缺失
      // 不该让整个 PWA 装不上）。
      await Promise.all(
        SHELL.map(async url => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }))
          } catch {
            /* 单个资源失败忽略 */
          }
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
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

  // 导航请求：网络优先，断网回退到缓存的 index.html（离线壳）。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request)
        } catch {
          const cache = await caches.open(CACHE_NAME)
          return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error()
        }
      })(),
    )
    return
  }

  // 静态资源：缓存优先 + 后台更新（stale-while-revalidate）。
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(request)
      if (cached) {
        fetch(request)
          .then(response => {
            if (response.ok) cache.put(request, response.clone())
          })
          .catch(() => {})
        return cached
      }
      try {
        const response = await fetch(request)
        if (response.ok) cache.put(request, response.clone())
        return response
      } catch {
        return Response.error()
      }
    })(),
  )
})
