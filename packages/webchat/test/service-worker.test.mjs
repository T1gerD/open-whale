// Service Worker 离线壳的「版本一致性」测试。
//
// 真实缺陷（v2.3.0 review 指出）：`sw.js` 里把缓存名写死成 `v2.2.0`，而产品已经
// 2.3.0。写死的缓存名意味着一次部署之后 `app.js` 仍可能从旧缓存里被取出来，而
// `lib/*.mjs` 已经更新——两半来自不同部署，模块之间对不上。这里用纯文本断言
// 钉住两件事：
//   1. 缓存名必须由 `lib/protocol.mjs` 的版本号派生，不能出现写死的产品版本；
//   2. 壳清单必须覆盖 `lib/` 下的每一个模块（新增模块忘了加进离线壳 = 离线时白屏）。

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const ROOT = new URL('..', import.meta.url)

/** @param {string} name */
function read(name) {
  return readFileSync(new URL(name, ROOT), 'utf8')
}

/** 从 sw.js 的 SHELL 数组里取出缓存的相对路径。 */
function shellEntries(source) {
  const start = source.indexOf('const SHELL = [')
  assert.ok(start >= 0, 'sw.js 里找不到 SHELL 清单')
  const end = source.indexOf('\n]', start)
  assert.ok(end > start, 'SHELL 清单没有正常结束')
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1])
}

test('sw.js 的缓存名由协议版本派生（不再写死 v2.2.0）', () => {
  const source = read('sw.js')
  assert.match(
    source,
    /import\s*\{\s*PROTOCOL_VERSION,\s*WEBCHAT_VERSION\s*\}\s*from\s*'\.\/lib\/protocol\.mjs'/,
    'sw.js 必须从协议镜像里 import 版本号',
  )
  assert.match(source, /CACHE_VERSION\s*=\s*`\$\{PROTOCOL_VERSION\}-\$\{WEBCHAT_VERSION\}`/)
  assert.match(source, /CACHE_NAME\s*=\s*`\$\{CACHE_PREFIX\}\$\{CACHE_VERSION\}`/)
  // 不允许再把产品版本写进缓存名（注释里提到历史版本是可以的）。
  assert.doesNotMatch(source, /CACHE_NAME\s*=\s*['"][^'"]*v\d+\.\d+\.\d+/, '缓存名不能硬编码版本号')
})

test('sw.js 的壳清单覆盖 lib/ 下所有模块与入口文件', () => {
  const entries = new Set(shellEntries(read('sw.js')))
  const libs = readdirSync(new URL('lib/', ROOT)).filter(name => name.endsWith('.mjs'))
  assert.ok(libs.length > 0)
  for (const name of libs) {
    assert.equal(entries.has(`./lib/${name}`), true, `离线壳缺少 lib/${name}`)
  }
  for (const name of ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest']) {
    assert.equal(entries.has(name), true, `离线壳缺少 ${name}`)
  }
})

test('sw.js 是全新快照式的缓存优先：清单不完整就回退网络', () => {
  const source = read('sw.js')
  assert.match(source, /complete/, '必须有「整版快照是否完整」的标记')
  assert.match(source, /if \(!manifest\?\.complete\) return fetch\(request\)/, '不完整时必须整版回退网络')
  // 导航固定取快照里的 index.html，HTML 与 JS 必须来自同一次部署。
  assert.match(source, /request\.mode === 'navigate' \? new URL\('\.\/index\.html'/)
})

test('app.js 以 module worker + 禁用 HTTP 缓存的方式注册 sw.js', () => {
  const source = read('app.js')
  assert.match(source, /register\(url,\s*\{[^}]*type:\s*'module'[^}]*\}\)/s)
  assert.match(source, /updateViaCache:\s*'none'/)
  // 注册地址带版本号：每次发布都会重新安装 SW，不依赖浏览器比较 module import。
  assert.match(source, /searchParams\.set\('v',\s*`\$\{PROTOCOL_VERSION\}-\$\{WEBCHAT_VERSION\}`\)/)
})
