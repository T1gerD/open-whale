// 网页版布局防回归：聊天页不允许横向滚动。
//
// 为什么要有这个测试：v2.4.0 之前的聊天页里，一条超长的代码行（Windows 路径、
// 命令行）会把助手气泡撑到 ~1000px：`.msg` 是 flex item，`min-width` 默认是
// `auto`（= min-content），于是 `max-width: 86%` 被 min-content 压过，气泡溢出
// `.message-area`，整个会话区变成可左右拖动的画布 —— 手机上表现为「文字两边被
// 切掉、还能横向拖」。纯逻辑单测抓不到这种问题，所以这里对样式表做结构性断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/**
 * 取出一个选择器的声明块（只匹配顶层、非嵌套写法）。
 * @param {string} selector
 * @returns {string}
 */
function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(match, `styles.css must define ${selector}`)
  return match[1]
}

test('the message scroller can never be dragged sideways', () => {
  const area = block('.message-area')
  assert.match(area, /overflow-y:\s*auto/, 'the chat must still scroll vertically')
  assert.match(area, /overflow-x:\s*hidden/, 'horizontal scrolling is what made the phone chat look broken')
  // 兜底：整页也不该可以左右拖动
  assert.match(css, /html,\s*\nbody\s*\{[^}]*overflow-x:\s*hidden/s)
})

test('message bubbles may shrink below their content width', () => {
  // flex item 的 min-width:auto 会被 min-content 顶住，max-width 就失效了。
  assert.match(block('.msg'), /min-width:\s*0/)
  const bubble = block('.bubble')
  assert.match(bubble, /min-width:\s*0/)
  assert.match(bubble, /max-width:\s*100%/)
})

test('long code lines scroll inside their own block instead of the page', () => {
  const codeBlock = block('.code-block')
  assert.match(codeBlock, /max-width:\s*100%/)
  assert.match(codeBlock, /min-width:\s*0/)
  const pre = block('.code-block pre')
  assert.match(pre, /overflow-x:\s*auto/)
  assert.match(pre, /max-width:\s*100%/)
})

test('inline code and media cannot push the bubble wider than the screen', () => {
  assert.match(block('.bubble-text code'), /overflow-wrap:\s*anywhere/)
  assert.match(css, /\.bubble-text img,[\s\S]*?max-width:\s*100%/)
})

test('the attachment tray is one scrollable row so it cannot cover the chat', () => {
  // 真机反馈：8 张截图在 tray 里竖向铺开，把消息区挤没了，翻不了上文。
  const tray = css.slice(css.indexOf('.attachment-tray'), css.indexOf('.attachment-tray::-webkit-scrollbar'))
  assert.match(tray, /flex-wrap:\s*nowrap/)
  assert.match(tray, /overflow-x:\s*auto/)
  assert.match(tray, /max-height:\s*\d+px/)
  const chip = css.slice(css.indexOf('.tray-chip {'), css.indexOf('.tray-chip .tray-name'))
  assert.match(chip, /flex:\s*0 0 auto/)
})
