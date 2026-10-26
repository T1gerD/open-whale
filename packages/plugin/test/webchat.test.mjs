// /openwhale/app 静态资源服务（内置 Web/PWA 客户端）。
//
// 关键约束（原生 ESM 与 Service Worker 对 MIME 很严格）：
//  · `.mjs` / `.js` 必须是 text/javascript，否则浏览器拒绝加载 module；
//  · `.webmanifest` 必须是 application/manifest+json；
//  · index.html 必须 no-store（Web 客户端会随插件更新而变）；
//  · 防路径穿越（`..`、编码后的 `%2e%2e`、绝对路径）且只允许 GET/HEAD。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import {
  WebClientServer,
  contentTypeFor,
  resolveWebClientDir,
} from '../src/webchat.mjs'

/** A fake request object: the handler only reads method/url/headers. */
function fakeRequest(path, method = 'GET') {
  return { method, url: path, headers: {} }
}

/** A writable fake response that records status, headers and the streamed body. */
function fakeResponse() {
  const chunks = []
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  response.status = 0
  response.headers = {}
  response.writeHead = (status, headers = {}) => {
    response.status = status
    response.headers = headers
    return response
  }
  Object.defineProperty(response, 'body', { get: () => Buffer.concat(chunks) })
  return response
}

async function call(server, request) {
  const response = fakeResponse()
  const finished = new Promise(resolve => response.once('finish', resolve))
  const handled = await server.handle(request, response)
  if (!response.writableEnded) response.end()
  await finished
  return { handled, response }
}

function makeClientTree() {
  const root = mkdtempSync(join(tmpdir(), 'openwhale-webchat-'))
  const dir = join(root, 'webchat')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'vendor'), { recursive: true })
  mkdirSync(join(dir, 'icons'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Open Whale</title>')
  writeFileSync(join(dir, 'app.js'), 'export const x = 1')
  writeFileSync(join(dir, 'styles.css'), 'body{}')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Open Whale"}')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("install", () => {})')
  writeFileSync(join(dir, 'lib', 'messages.mjs'), 'export const y = 2')
  writeFileSync(join(dir, 'vendor', 'tweetnacl.min.js'), 'var nacl = {}')
  writeFileSync(join(dir, 'icons', 'icon.svg'), '<svg></svg>')
  writeFileSync(join(dir, 'icons', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return { root, dir }
}

test('index.html is served at /openwhale/app and /openwhale/app/', async t => {
  const { root, dir } = makeClientTree()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = new WebClientServer({ dirs: [dir] })

  for (const path of ['/openwhale/app', '/openwhale/app/']) {
    const { handled, response } = await call(server, fakeRequest(path))
    assert.equal(handled, true)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(response.headers['cache-control'], 'no-store', 'the app shell must never be cached')
    assert.match(response.body.toString('utf8'), /Open Whale/)
  }
})

test('native ESM and app assets get browser-loadable content types', async t => {
  const { root, dir } = makeClientTree()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = new WebClientServer({ dirs: [dir] })

  const cases = [
    ['/openwhale/app/lib/messages.mjs', 'text/javascript; charset=utf-8'],
    ['/openwhale/app/app.js', 'text/javascript; charset=utf-8'],
    ['/openwhale/app/sw.js', 'text/javascript; charset=utf-8'],
    ['/openwhale/app/vendor/tweetnacl.min.js', 'text/javascript; charset=utf-8'],
    ['/openwhale/app/styles.css', 'text/css; charset=utf-8'],
    ['/openwhale/app/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/openwhale/app/icons/icon.svg', 'image/svg+xml'],
    ['/openwhale/app/icons/icon.png', 'image/png'],
  ]
  for (const [path, expected] of cases) {
    const { response } = await call(server, fakeRequest(path))
    assert.equal(response.status, 200, `${path} must be served`)
    assert.equal(response.headers['content-type'], expected, path)
    assert.notEqual(response.headers['content-type'], 'text/plain', `${path} must not fall back to text/plain`)
  }
})

test('a missing asset is a 404, not an HTML fallback', async t => {
  const { root, dir } = makeClientTree()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = new WebClientServer({ dirs: [dir] })
  const { handled, response } = await call(server, fakeRequest('/openwhale/app/nope.mjs'))
  assert.equal(handled, true)
  assert.equal(response.status, 404)
})

test('path traversal is rejected even when percent-encoded', async t => {
  const { root, dir } = makeClientTree()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'secret.txt'), 'top secret')
  const server = new WebClientServer({ dirs: [dir] })

  for (const path of [
    '/openwhale/app/../secret.txt',
    '/openwhale/app/%2e%2e/secret.txt',
    '/openwhale/app/lib/../../secret.txt',
    '/openwhale/app/..%2fsecret.txt',
    '/openwhale/app/%2e%2e%2fsecret.txt',
  ]) {
    const { handled, response } = await call(server, fakeRequest(path))
    // `new URL()` normalises a plain `..` away, so some of these never reach the
    // handler. Either way the file must not be served: a handled response is a
    // 404, an unhandled one leaves the gateway to answer 404 itself.
    if (handled) assert.equal(response.status, 404, `${path} must not escape the web client directory`)
    assert.equal(response.body.toString('utf8').includes('top secret'), false)
  }
})

test('only GET and HEAD are allowed', async t => {
  const { root, dir } = makeClientTree()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = new WebClientServer({ dirs: [dir] })
  const { response } = await call(server, fakeRequest('/openwhale/app/', 'POST'))
  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'GET, HEAD')
})

test('HEAD returns headers without a body', async t => {
  const { root, dir } = makeClientTree()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = new WebClientServer({ dirs: [dir] })
  const { response } = await call(server, fakeRequest('/openwhale/app/styles.css', 'HEAD'))
  assert.equal(response.status, 200)
  assert.equal(response.body.length, 0)
  assert.equal(Number(response.headers['content-length']) > 0, true)
})

test('a missing web client directory is reported as "not installed"', async t => {
  const root = mkdtempSync(join(tmpdir(), 'openwhale-noweb-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = new WebClientServer({ dirs: [join(root, 'missing')] })
  assert.equal(server.available(), false)
  const { handled, response } = await call(server, fakeRequest('/openwhale/app/'))
  assert.equal(handled, true)
  assert.equal(response.status, 404)
  assert.match(response.body.toString('utf8'), /网页版客户端/)
})

test('resolveWebClientDir finds the development layout (repo/packages/webchat)', t => {
  const root = mkdtempSync(join(tmpdir(), 'openwhale-layout-dev-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'packages', 'plugin')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  mkdirSync(join(root, 'packages', 'webchat'), { recursive: true })
  writeFileSync(join(root, 'packages', 'webchat', 'index.html'), '<html></html>')
  assert.equal(resolveWebClientDir({ packageRoot }), join(root, 'packages', 'webchat'))
})

test('resolveWebClientDir finds the packaged layout (<pluginPackage>/webchat)', t => {
  const root = mkdtempSync(join(tmpdir(), 'openwhale-layout-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'dsh-openwhale')
  mkdirSync(join(packageRoot, 'webchat'), { recursive: true })
  writeFileSync(join(packageRoot, 'webchat', 'index.html'), '<html></html>')
  assert.equal(resolveWebClientDir({ packageRoot }), join(packageRoot, 'webchat'))
})

test('resolveWebClientDir returns undefined when nothing is installed', t => {
  const root = mkdtempSync(join(tmpdir(), 'openwhale-layout-none-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(resolveWebClientDir({ packageRoot: join(root, 'pkg') }), undefined)
})

test('content types never fall back to text/plain for scripts', () => {
  assert.equal(contentTypeFor('a.mjs'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('a.js'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('a.webmanifest'), 'application/manifest+json; charset=utf-8')
  assert.equal(contentTypeFor('a.woff2'), 'font/woff2')
  assert.equal(contentTypeFor('a.bin'), 'application/octet-stream')
})




