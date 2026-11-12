// 渲染 / 滚动 / 发送路径的结构性回归。
//
// 这几类 bug 都是「DOM 行为」而不是纯逻辑，单测跑不到；但它们的根因都能在源码里
// 用结构断言钉住：
//   · 消息列表只能有一条渲染路径（keyed 差分），不能再出现整页 innerHTML 重建；
//   · 程序滚动不能被当成用户上滑（CSS 不能是 smooth）；
//   · 气泡不能把模板缩进当正文（pre-wrap 只能在 .bubble-text 上）；
//   · 发送必须先上屏、后上传附件（否则带图消息要等 3–5 秒才出现）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(here, '..', 'app.js'), 'utf8')
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')
const html = readFileSync(join(here, '..', 'index.html'), 'utf8')

test('消息列表只有一套 keyed 渲染路径', () => {
  assert.match(app, /function updateMessageNode\(/, '必须有 keyed 节点更新函数')
  assert.match(app, /const messageView = \{/, '必须有 keyed 节点缓存')
  assert.equal(
    /dom\.messageList\.innerHTML\s*=/.test(app),
    false,
    '消息列表不能再整页 innerHTML 重建（长会话一次一两秒，首帧被拖住）',
  )
  assert.equal(/function messageSignature\(/.test(app), false, 'messageSignature 哈希跳过已经删除')
  assert.equal(/appendLocalUserBubble/.test(app.replace(/\/\/.*$/gm, '')), false, '不能再有第二条追加路径')
})

test('流式只改正文节点，不重建整颗气泡', () => {
  assert.match(app, /querySelector\('\.bubble-text'\)/, '结构不变时必须只 patch 正文节点')
  assert.match(app, /function bubbleTextHtml\(/, '正文 HTML 必须由同一个函数产出（渲染与 patch 一致）')
})

test('长会话按窗口渲染，并能加载更早', () => {
  assert.match(app, /const MESSAGE_WINDOW_STEP = 30/, '初始挂载窗口 30 条')
  assert.match(app, /data-action="load-earlier"/, '必须有「加载更早」按钮')
  assert.match(app, /function loadEarlierMessages\(/, '加载更早要能保持视口位置')
})

test('程序滚动不会被误判成用户上滑', () => {
  const area = /(?:^|\n)\.message-area\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(area, /scroll-behavior:\s*auto/, 'smooth 会让自动跟随持续发 scroll 事件，被当成用户上滑')
  assert.match(app, /let followBottom = true/, '跟随底部必须是显式状态')
  assert.match(app, /programmaticUntil/, '程序滚动要有静默窗口')
})

test('气泡不把模板缩进当正文', () => {
  const bubble = /(?:^|\n)\.bubble\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(bubble, /white-space:\s*normal/, '.bubble 不能 pre-wrap（模板缩进会变成几百像素空白）')
  assert.match(css, /\.bubble-text\s*\{[^}]*white-space:\s*pre-wrap/, '空白只在正文节点里保留')
})

test('发送先上屏、后上传附件', () => {
  const body = app.slice(app.indexOf('async function deliverMessage'))
  const addAt = body.indexOf('addLocalUserMessage')
  const uploadAt = body.indexOf('uploadAttachment(')
  assert.ok(addAt > 0, 'deliverMessage 必须自己插入本地气泡')
  assert.ok(uploadAt > addAt, '本地气泡必须在上传之前插入（带图消息不能等上传完才出现）')
  assert.match(body.slice(0, uploadAt), /renderMessages\(\{ forceScroll: true \}\)/, '插入后必须立刻渲染一次')
})

test('静态资源版本号一致（防手机继续跑旧模块）', () => {
  const version = /WEBCHAT_VERSION = '([0-9.]+)'/.exec(
    readFileSync(join(here, '..', 'lib', 'protocol.mjs'), 'utf8'),
  )?.[1]
  assert.ok(version, 'WEBCHAT_VERSION 必须可读')
  const expected = `v=${version.split('.').join('')}`
  const htmlTag = /app\.js\?v=([0-9]+)/.exec(html)?.[1]
  const appTag = /messages\.mjs\?v=([0-9]+)/.exec(app)?.[1]
  assert.ok(htmlTag, 'index.html 的 app.js 必须带版本参数')
  assert.equal(`v=${htmlTag}`, expected, 'index.html 的版本参数要与 WEBCHAT_VERSION 对齐')
  assert.equal(`v=${appTag}`, expected, 'app.js 的 lib import 版本参数要与 WEBCHAT_VERSION 对齐')
})

test('相册识别把官方短码（?s=）交给同源兑换', () => {
  assert.match(app, /function payloadFromScannedText/, '短码必须有一个统一的兑换入口')
  const scanCall = app.slice(app.indexOf('createBrowserQrReader()'))
  assert.ok(
    scanCall.slice(0, 400).includes('resolveText'),
    '「从相册选二维码图片」必须把 resolveText 传下去，否则官方短码会报「链接里没有找到绑定参数」',
  )
  assert.match(app, /redeemBindingSecret\(/, '兑换逻辑只能有一份（地址栏 / 相册 / 粘贴共用）')
  const qr = readFileSync(join(here, '..', 'lib', 'qr.mjs'), 'utf8')
  assert.match(qr, /options\.resolveText/, 'readPairingFromBitmap 要支持 resolveText 兜底')
})
