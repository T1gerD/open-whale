// Open Whale 网页版客户端入口。
//
// 零构建、原生 ESM：浏览器直接加载本文件，import 同目录 lib/*.mjs。所有协议 / 加密 /
// 合并逻辑都在 lib 里（可被 node --test 直接测），这里只负责：
//   1. 屏幕切换（绑定页 ↔ 聊天页）与移动端交互；
//   2. 把 ConnectionManager 的事件接到 ChatTabsModel 和 DOM（含会话标签条）；
//   3. 附件选择 / 分块上传 / 下载、设置面板、PWA 安装提示。
//
// 终端用户视角：扫码或粘贴绑定信息 → 选地址自动连接 → 聊天。技术细节只出现在设置页。

import {
  CAPABILITIES,
  CLIENT_FRAME,
  CONNECTION_MODE,
  MAX_UPLOAD_ATTACHMENTS,
  PROTOCOL_VERSION,
  SERVER_FRAME,
  UPLOAD_CHUNK_BYTES,
  WEBCHAT_VERSION,
  formatFingerprint,
} from './lib/protocol.mjs'
import { formatBytes, hexFromBytes, randomBytes } from './lib/bytes.mjs'
import {
  ENDPOINT_KIND_LABEL,
  baseOrigin,
  classifyEndpoint,
  mergeEndpointSources,
  normalizeManualEndpoint,
  orderCandidates,
} from './lib/endpoints.mjs'
import {
  bindingFromPayload,
  deviceNameFromUserAgent,
  bindingSecretFromSearch,
  healthUrl,
  parsePairingInput,
} from './lib/pairing.mjs'
import {
  buildHello,
  createIdentity,
  newNonce,
  normalizeDeviceName,
  restoreIdentity,
  serializeIdentity,
  signHello,
  verifyHelloAckProof,
} from './lib/keys.mjs'
import { ChatTabsModel, MESSAGE_STATUS, TAB_LIMIT, buildQuestionReply, buildSnapshotFrame, buildWatchFrame, composerAction, normalizeAttachments } from './lib/messages.mjs'
import { CONNECTION_STATE, ConnectionManager, describeStatus } from './lib/connection.mjs'
import { createStorage } from './lib/storage.mjs'
import {
  AttachmentUploader,
  UPLOAD_TRANSPORT,
  chooseTransport,
  createBlobSliceReader,
  readBlobAsBase64,
} from './lib/upload.mjs'
import { createBrowserQrReader } from './lib/qr.mjs'

// ---------------------------------------------------------------------------
// 环境与 DOM
// ---------------------------------------------------------------------------

const APP_VERSION = WEBCHAT_VERSION
const nacl = globalThis.nacl

/** localStorage 在隐私模式下可能一访问就抛错；抛错就退化成内存存储。 */
function safeLocalStorage() {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const storage = createStorage(safeLocalStorage())

const dom = {
  app: document.getElementById('app'),
  bootScreen: document.getElementById('boot-screen'),
  bootText: document.getElementById('boot-text'),
  bindScreen: document.getElementById('bind-screen'),
  bindCard: document.getElementById('bind-card'),
  bindForm: document.getElementById('bind-form'),
  bindRecognized: document.getElementById('bind-recognized'),
  bindSummary: document.getElementById('bind-summary'),
  bindInput: document.getElementById('bind-input'),
  bindConnect: document.getElementById('bind-connect'),
  bindScanImage: document.getElementById('bind-scan-image'),
  bindConfirm: document.getElementById('bind-confirm'),
  bindCancel: document.getElementById('bind-cancel'),
  bindStatus: document.getElementById('bind-status'),
  bindVersion: document.getElementById('bind-version'),
  bindProtocol: document.getElementById('bind-protocol'),
  chatScreen: document.getElementById('chat-screen'),
  statusDot: document.getElementById('status-dot'),
  computerName: document.getElementById('computer-name'),
  connectionDetail: document.getElementById('connection-detail'),
  sessionTabs: document.getElementById('session-tabs'),
  sessionSheet: document.getElementById('session-sheet'),
  menuBtn: document.getElementById('menu-btn'),
  statusBanner: document.getElementById('status-banner'),
  statusBannerText: document.getElementById('status-banner-text'),
  statusBannerActions: document.getElementById('status-banner-actions'),
  messageArea: document.getElementById('message-area'),
  messageList: document.getElementById('message-list'),
  jumpLatest: document.getElementById('jump-latest'),
  composerWrap: document.getElementById('composer-wrap'),
  composer: document.getElementById('composer'),
  messageQueue: document.getElementById('message-queue'),
  approvalBanner: document.getElementById('approval-banner'),
  approvalBannerText: document.getElementById('approval-banner-text'),
  approvalBannerJump: document.getElementById('approval-banner-jump'),
  composerInput: document.getElementById('composer-input'),
  sendBtn: document.getElementById('send-btn'),
  stopBtn: document.getElementById('stop-btn'),
  attachBtn: document.getElementById('attach-btn'),
  imageBtn: document.getElementById('image-btn'),
  attachmentTray: document.getElementById('attachment-tray'),
  uploadProgress: document.getElementById('upload-progress'),
  uploadProgressText: document.getElementById('upload-progress-text'),
  uploadProgressBar: document.getElementById('upload-progress-bar'),
  uploadProgressFill: document.getElementById('upload-progress-fill'),
  composerHint: document.getElementById('composer-hint'),
  sheetBackdrop: document.getElementById('sheet-backdrop'),
  settingsSheet: document.getElementById('settings-sheet'),
  dialog: document.getElementById('dialog'),
  dialogTitle: document.getElementById('dialog-title'),
  dialogBody: document.getElementById('dialog-body'),
  dialogCancel: document.getElementById('dialog-cancel'),
  dialogConfirm: document.getElementById('dialog-confirm'),
  installHint: document.getElementById('install-hint'),
  installHintText: document.getElementById('install-hint-text'),
  installHintAction: document.getElementById('install-hint-action'),
  installHintClose: document.getElementById('install-hint-close'),
  toastStack: document.getElementById('toast-stack'),
  qrFile: document.getElementById('qr-file'),
  attachFile: document.getElementById('attach-file'),
  imageFile: document.getElementById('image-file'),
}

/** 全局状态。刷新页面会从 localStorage 重建。 */
const state = {
  settings: storage.loadSettings(),
  view: 'boot',
  binding: undefined,
  identity: undefined,
  pendingPayload: undefined,
  pairSecret: '',
  computerName: '电脑',
  endpoints: [],
  connection: undefined,
  model: undefined,
  status: { state: CONNECTION_STATE.IDLE },
  serverCaps: new Set(),
  verified: false,
  assistants: [],
  outbox: [],
  attachments: [], // 待发送附件 {id, file, name, size, mime, transport}
  queue: [], // 排队待发的消息 {id, text, attachments}
  flushing: false,
  uploader: undefined,
  sending: false,
  syncTimer: null,
  syncReceived: false,
  firstOnlineShown: false,
  download: undefined,
  installPrompt: undefined,
  settingsOpen: false,
  sessionSheetOpen: false,
  sessionListLoading: false,
  /** 正在等电脑端确认的会话操作：{reason:'switch'|'create', sessionId?}。 */
  pendingSelect: null,
  /** 已发出但还没回的 session/snapshot（rid → sessionId）。 */
  pendingSnapshots: new Map(),
  /** 审批倒计时定时器（有带 expiresAt 的待办审批时才跑）。 */
  approvalTicker: null,
  lastRenderSignature: '',
  lastTabsSignature: '',
  lastActiveTabId: '',
  connectionWarned: false,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** @param {string} prefix */
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${hexFromBytes(randomBytes(4))}`
}

/** @param {string} tag */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** @param {string} iso */
function clockText(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** @param {string} iso */
function daySeparatorText(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000)
  if (diffDays === 0) return `今天 ${clockText(iso)}`
  if (diffDays === 1) return `昨天 ${clockText(iso)}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clockText(iso)}`
}

/** @param {string} name */
function fileExtension(name) {
  const match = /\.([A-Za-z0-9]{1,6})$/.exec(String(name ?? ''))
  return match ? match[1].toUpperCase() : 'FILE'
}

/**
 * 会话列表里的相对时间（电脑端只给 Unix ms，这里只做展示）。
 * @param {number} value
 * @returns {string}
 */
function relativeTime(value) {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return ''
  const delta = Date.now() - time
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/**
 * 审批卡片正文：优先本地化文案，其次机器原因，最后按工具名兜底。
 * @param {any} approval
 * @returns {string}
 */
function approvalReasonText(approval) {
  const text = approval?.displayReason || approval?.reason
  if (typeof text === 'string' && text.trim() !== '') return text.trim()
  return `「${approval?.toolName ?? '工具'}」请求执行`
}

/**
 * 审批卡片倒计时文案（电脑端超时后会补一条 resolved，这里只负责让用户看到期限）。
 * @param {any} approval
 * @param {number} [now]
 * @returns {string}
 */
function approvalCountdownText(approval, now = Date.now()) {
  const expiresAt = Number(approval?.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return ''
  const left = Math.max(0, expiresAt - now)
  if (left <= 0) return '已超时，电脑会自行处理'
  const seconds = Math.ceil(left / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后交回电脑处理`
}

/** @param {any} approval @param {number} [now] */
function approvalExpired(approval, now = Date.now()) {
  const expiresAt = Number(approval?.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now
}

/**
 * 提问卡片倒计时文案（3.0.0）。`canAnswerLate` 的提问超时后仍可补答，
 * 所以文案要说明「还能答」，而不是像审批那样一律「交回电脑」。
 * @param {any} question
 * @param {number} [now]
 * @returns {string}
 */
function questionCountdownText(question, now = Date.now()) {
  const expiresAt = Number(question?.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return ''
  const left = Math.max(0, expiresAt - now)
  const late = question?.canAnswerLate === true
  if (left <= 0) return late ? '已交回电脑，仍可补答' : '已交回电脑处理'
  const seconds = Math.ceil(left / 1000)
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return late ? `${clock} 后交回电脑（仍可补答）` : `${clock} 后交回电脑处理`
}

/** 过了前台等待时间、且不能补答的提问才真正作废。 */
function questionExpired(question, now = Date.now()) {
  const expiresAt = Number(question?.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false
  if (expiresAt > now) return false
  return question?.canAnswerLate !== true
}

/** @param {string} raw */
function renderRichText(raw) {
  const escaped = escapeHtml(raw)
  /** @type {string[]} */
  const codeBlocks = []
  // 先抽出围栏代码块（此时内容已经 HTML 转义，直接放进 <pre> 是安全的）。
  let html = escaped.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const index = codeBlocks.length
    codeBlocks.push(code.replace(/\n$/, ''))
    const label = lang ? escapeHtml(lang) : '代码'
    return `\u0000CODE${index}\u0000|\u0000LANG${escapeHtml(label)}\u0000`
  })
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(
    /(https?:\/\/[^\s<>\u0000]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  html = html
    .split(/\n{2,}/)
    .map(paragraph => `<p>${paragraph.replaceAll('\n', '<br />')}</p>`)
    .join('')
  html = html.replace(/\u0000CODE(\d+)\u0000\|\u0000LANG([^\u0000]*)\u0000/g, (_match, index, lang) => {
    const code = codeBlocks[Number(index)] ?? ''
    return `<div class="code-block"><div class="code-block-head"><span>${lang}</span><button class="code-copy" type="button" data-action="copy-code">复制</button></div><pre>${code}</pre></div>`
  })
  return html
}

/** @param {string} message @param {'ok'|'error'|''} [kind] @param {number} [ms] */
function showToast(message, kind = '', ms = 3400) {
  const toast = document.createElement('div')
  toast.className = `toast${kind ? ` is-${kind}` : ''}`
  toast.textContent = message
  dom.toastStack.appendChild(toast)
  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 240ms ease'
    setTimeout(() => toast.remove(), 260)
  }, ms)
}

/** 通用确认框；返回 Promise<boolean>。 */
function confirmDialog(options) {
  return new Promise(resolve => {
    dom.dialogTitle.textContent = options.title ?? '确认'
    dom.dialogBody.textContent = options.body ?? ''
    dom.dialogCancel.textContent = options.cancelText ?? '取消'
    dom.dialogConfirm.textContent = options.confirmText ?? '确定'
    dom.dialogConfirm.className = `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`
    dom.dialog.hidden = false
    const finish = value => {
      dom.dialog.hidden = true
      dom.dialogCancel.onclick = null
      dom.dialogConfirm.onclick = null
      dom.dialog.hidden = true
      resolve(value)
    }
    dom.dialogCancel.onclick = () => finish(false)
    dom.dialogConfirm.onclick = () => finish(true)
  })
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

let persistTimer = null

/** @param {number} [delay] */
function persistSoon(delay = 700) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, delay)
}

/**
 * 标签 / 当前会话变了就立刻落盘：刷新后要能回到同一组标签，不能等 700ms
 * （手机上切后台可能立刻冻结 JS）。
 */
function persistTabsNow() {
  if (!state.identity || !state.model) return
  try {
    storage.saveTabs(state.identity.deviceId, state.model.snapshotTabs())
  } catch {
    /* 存储满/隐私模式：不阻塞聊天 */
  }
}

function persistNow() {
  if (!state.identity || !state.model) return
  try {
    const snapshot = state.model.snapshotActiveChat({ limit: 200 })
    if (snapshot) storage.saveConversation(state.identity.deviceId, snapshot)
    storage.saveTabs(state.identity.deviceId, state.model.snapshotTabs())
    storage.saveOutbox(
      state.identity.deviceId,
      state.outbox.map(entry => ({
        msgId: entry.msgId,
        text: entry.text ?? '',
        at: entry.at,
        sessionId: entry.sessionId,
      })),
    )
  } catch {
    /* 存储满/隐私模式：不阻塞聊天 */
  }
}

/** 电脑显示名 / 设备昵称。 */
function currentDeviceName() {
  return (
    normalizeDeviceName(state.settings.deviceName) ||
    state.identity?.deviceName ||
    deviceNameFromUserAgent(navigator.userAgent)
  )
}

/** 二维码 payload 里的电脑公钥（没有则只能靠指纹）。 */
function computerPublicKey() {
  return state.pendingPayload?.pk || state.binding?.computerPublicKey || ''
}

// ---------------------------------------------------------------------------
// 主题 / 安装提示 / Service Worker
// ---------------------------------------------------------------------------

/** @param {string} theme */
function applyTheme(theme) {
  const value = ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto'
  document.documentElement.dataset.theme = value
  if (state.settings.theme !== value) state.settings = storage.saveSettings({ theme: value })
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)
  if (!secure) {
    // 局域网 http 下浏览器不允许注册 SW：聊天不受影响，只是没有离线壳。
    return
  }
  window.addEventListener('load', () => {
    const url = new URL('sw.js', document.baseURI)
    // 脚本 URL 带上版本号：每次发布都换一个注册地址，浏览器一定会重新安装 SW，
    // 不依赖「浏览器是否比较 module import」这种实现细节。
    url.searchParams.set('v', `${PROTOCOL_VERSION}-${WEBCHAT_VERSION}`)
    // sw.js 是 module worker：它 import lib/protocol.mjs 的版本号来给缓存命名，
    // 这样缓存名不会像 v2.2.0 那样写死在文件里（写死就会和 app.js 版本对不上）。
    // 浏览器不支持 module worker 时注册会失败：在线功能不受影响，只是没有离线壳。
    navigator.serviceWorker
      .register(url, { scope: './', type: 'module', updateViaCache: 'none' })
      .catch(() => {
        /* 失败不影响使用 */
      })
  })
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    /** @type {any} */ (navigator).standalone === true
  )
}

function showInstallHint(text, withAction = false) {
  if (state.settings.seenInstallHint) return
  if (state.view !== 'chat') return
  dom.installHintText.textContent = text
  dom.installHintAction.hidden = !withAction
  dom.installHint.hidden = false
}

function dismissInstallHint(remember = true) {
  dom.installHint.hidden = true
  if (remember) state.settings = storage.saveSettings({ seenInstallHint: true })
}

function setupInstallHint() {
  if (isStandalone()) return
  if (state.settings.seenInstallHint) return
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    state.installPrompt = event
    showInstallHint('把 Open Whale 添加到主屏幕，下次打开直接进聊天。', true)
  })
  const ua = navigator.userAgent
  setTimeout(() => {
    if (isStandalone() || state.settings.seenInstallHint) return
    if (state.installPrompt) return
    if (/iPhone|iPad/i.test(ua)) {
      showInstallHint('像 App 一样使用：点底部「分享」→「添加到主屏幕」。')
    } else if (/HarmonyOS/i.test(ua)) {
      showInstallHint('添加到桌面：浏览器菜单（右下角）→「添加到桌面」。')
    } else if (window.matchMedia?.('(display-mode: browser)')?.matches !== false) {
      showInstallHint('可以把这个页面添加到主屏幕，像 App 一样打开。')
    }
  }, 9000)
}

// ---------------------------------------------------------------------------
// 视图切换 / 绑定页
// ---------------------------------------------------------------------------

/** @param {'boot'|'bind'|'chat'} view */
function showView(view) {
  state.view = view
  dom.bootScreen.hidden = view !== 'boot'
  dom.bindScreen.hidden = view !== 'bind'
  dom.chatScreen.hidden = view !== 'chat'
}

/** @param {string} text @param {'ok'|'error'|'busy'|''} [kind] */
function setBindStatus(text, kind = '') {
  dom.bindStatus.textContent = text
  dom.bindStatus.className = `bind-status${kind ? ` is-${kind}` : ''}`
}

function resetBindUI() {
  dom.bindRecognized.hidden = true
  dom.bindForm.hidden = false
  dom.bindInput.value = ''
  setBindStatus('')
  state.pendingPayload = undefined
}

/** @param {any} payload @param {{warning?: string}} [options] */
function showRecognizedPayload(payload, options = {}) {
  state.pendingPayload = payload
  dom.bindRecognized.hidden = false
  dom.bindForm.hidden = true
  const rows = [
    ['电脑', escapeHtml(payload.host)],
    ['指纹', escapeHtml(formatFingerprint(payload.fp))],
  ]
  const endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : []
  const kinds = Array.isArray(payload.epk) ? payload.epk : []
  const kindLabels = { l: '局域网', t: 'Tailscale', c: '公网隧道', u: 'USB', x: '其他' }
  if (endpoints.length > 0) {
    rows.push([
      '地址',
      endpoints
        .map((url, index) => {
          const label = kindLabels[kinds[index]] ?? '其他'
          return `${escapeHtml(label)} · ${escapeHtml(url)}`
        })
        .join('<br />'),
    ])
  }
  if (options.warning) rows.push(['注意', escapeHtml(options.warning)])
  dom.bindSummary.innerHTML = rows
    .map(([key, value]) => `<div class="kv-row"><dt class="kv-key">${key}</dt><dd class="kv-value">${value}</dd></div>`)
    .join('')
  setBindStatus('')
}

/** 从 URL fragment 取绑定载荷（插件页面二维码 → 扫码打开本页）。 */
async function payloadFromLocation() {
  const hash = window.location.hash ?? ''
  if (hash && hash.includes('p=')) {
    const parsed = parsePairingInput(hash)
    return parsed.ok ? { payload: parsed.payload } : { error: parsed.error }
  }
  // 短二维码：`/openwhale/app?s=<一次性配对密钥>`。页面与插件同源，直接向
  // `/openwhale/pairing.json` 取当前载荷，并校验密钥一致才信任——这样二维码只有
  // 90 来个字符（iOS 相机一扫就中），又不需要把整段载荷塞进二维码。
  const secret = bindingSecretFromSearch(window.location.search)
  if (!secret) return undefined
  try {
    const response = await fetch('/openwhale/pairing.json', { cache: 'no-store' })
    const body = await response.json().catch(() => undefined)
    const payload = body?.payload ?? body
    if (!response.ok || !payload) {
      return { error: '这台电脑暂时没有可用的绑定信息：请在电脑上刷新配对页后重新扫码。' }
    }
    if (String(payload.secret) !== secret) {
      return { error: '这个二维码已过期或已被使用：请在电脑上刷新配对页后重新扫码。' }
    }
    // 密钥只用于这一次兑换，立即从地址栏去掉，避免刷新时重复使用。
    history.replaceState(null, '', window.location.pathname)
    return { payload }
  } catch {
    return { error: '无法读取绑定信息（网络或本地网络权限问题）：请在电脑上刷新配对页后重试。' }
  }
}

/** 用户输入 / 扫码 / URL 都汇聚到这里。 */
function connectFromInput() {
  const parsed = parsePairingInput(dom.bindInput.value)
  if (!parsed.ok) {
    setBindStatus(parsed.error, 'error')
    return
  }
  beginFromPayload(parsed.payload)
}

/** @param {any} payload */
function beginFromPayload(payload) {
  // 配对 secret 是一次性的：从地址栏去掉，避免刷新时重复使用导致「二维码已使用」。
  if (window.location.hash.includes('p=')) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }
  const existing = state.binding
  if (existing && existing.computerId !== payload.id) {
    showRecognizedPayload(payload, { warning: `连接后会替换当前绑定的「${existing.computerName}」。` })
    setBindStatus('这是一台新电脑：确认后会替换当前绑定。', 'busy')
    return
  }
  startSession({ payload })
}

/** 把 pending payload 的表单状态回退到输入框。 */
function cancelRecognizedPayload() {
  resetBindUI()
  setBindStatus('已取消识别结果，可以粘贴新的绑定链接。')
}

// ---------------------------------------------------------------------------
// 连接生命周期
// ---------------------------------------------------------------------------

function computeCandidates() {
  const pairs = state.endpoints.map(item => ({ url: item.url, kind: item.kind }))
  for (const raw of state.settings.manualEndpoints) {
    const url = String(raw ?? '').trim()
    if (url === '' || pairs.some(item => item.url === url)) continue
    pairs.push({ url, kind: classifyEndpoint(url) })
  }
  return orderCandidates(pairs, {
    mode: state.settings.mode,
    preferred: state.settings.preferredEndpoint,
  })
}

function emptyModeHint() {
  if (state.settings.mode === CONNECTION_MODE.TAILSCALE) {
    return '没有检测到 Tailscale 地址：请确认手机和电脑都登录了同一 tailnet，或在设置里改回「自动」。'
  }
  if (state.settings.mode === CONNECTION_MODE.LAN) {
    return '没有检测到局域网地址：请确认手机和电脑在同一个 Wi-Fi，或在设置里改回「自动」。'
  }
  if (state.settings.mode === CONNECTION_MODE.TUNNEL) {
    return '没有检测到公网隧道地址：请在电脑端开启隧道，或在设置里改回「自动」。'
  }
  return '没有可用地址：请重新扫码，或在设置里手动添加电脑地址（例如 192.168.1.5:8787）。'
}

/**
 * 开始/恢复一次会话。
 * @param {{payload?: any}} [options] payload 存在 = 首次绑定或重新扫码；否则用已保存的绑定重连
 */
function startSession(options = {}) {
  const payload = options.payload
  teardownConnection()

  if (payload) {
    state.pendingPayload = payload
    state.pairSecret = payload.secret
    state.verified = false
    state.computerName = payload.host
    state.endpoints = mergeEndpointSources(payload, [])
  } else if (state.binding) {
    state.pendingPayload = undefined
    state.pairSecret = ''
    state.computerName = state.binding.computerName
    state.endpoints = state.binding.endpoints.map(item => ({ url: item.url, kind: item.kind }))
  } else {
    showView('bind')
    return
  }

  // 身份：同一台电脑尽量复用已有密钥（电脑端认得它）；否则生成新的。
  try {
    if (state.binding && state.binding.computerId === (payload?.id ?? state.binding.computerId)) {
      state.identity = restoreIdentity(state.binding)
    } else {
      state.identity = createIdentity(nacl, { deviceName: currentDeviceName() })
    }
  } catch (error) {
    storage.clearBinding()
    state.binding = undefined
    showView('bind')
    setBindStatus(`本机保存的身份无法使用（${/** @type {Error} */ (error).message}），请重新扫码绑定。`, 'error')
    return
  }

  state.model = new ChatTabsModel({ myDeviceId: state.identity.deviceId })
  // 先恢复标签列表与当前标签，再把上次缓存的当前会话内容塞回去：
  // 刷新后立刻有内容，随后由 hello/ack 与 session/state 对账。
  const savedTabs = storage.loadTabs(state.identity.deviceId)
  if (savedTabs.tabs.length > 0) state.model.restoreTabs(savedTabs)
  const savedConversation = storage.loadConversation(state.identity.deviceId)
  if (savedConversation) state.model.restoreActiveChat(savedConversation)

  state.outbox = storage.loadOutbox(state.identity.deviceId).map(entry => ({
    msgId: entry.msgId,
    text: entry.text,
    at: entry.at,
    sessionId: entry.sessionId,
  }))
  for (const entry of state.outbox) {
    state.model.addLocalUserMessage(
      { msgId: entry.msgId, text: entry.text, at: entry.at, status: MESSAGE_STATUS.ERROR },
      entry.sessionId || state.model.activeSessionId,
    )
  }

  state.serverCaps = new Set()
  state.syncReceived = false
  state.attachments = []
  state.uploader = undefined
  state.sending = false
  state.sessionSheetOpen = false
  state.sessionListLoading = false
  state.pendingSelect = null
  state.pendingSnapshots = new Map()
  state.lastTabsSignature = ''
  state.lastActiveTabId = ''
  stopApprovalTicker()
  closeSettings()
  closeSessionSheet()

  showView('chat')
  renderAttachmentsTray()
  renderTabs()
  renderHeader()
  renderMessages({ forceScroll: true })
  renderComposerState()
  persistBinding()
  persistNow()

  // 首次绑定（有一次性 secret、还没有绑定记录）时不做并发竞速：
  // 两个 socket 用同一个 deviceId 会互相顶掉刚建立的会话，反而多一次重连。
  const pairing = Boolean(state.pairSecret) && !state.binding
  state.connection = new ConnectionManager({
    WebSocketImpl: globalThis.WebSocket,
    candidates: computeCandidates(),
    buildHello: buildHelloFrame,
    verifyAck: (ack, context) =>
      verifyHelloAckProof({
        nacl,
        computerPublicKey: computerPublicKey(),
        ack,
        deviceId: state.identity.deviceId,
        expectedNonce: context.hello?.nonce,
      }),
    onStatus: status => {
      state.status = status
      renderHeader()
      renderStatusBanner()
      if (status.state === CONNECTION_STATE.REJECTED) handleRejected(status)
    },
    onOnline: (ack, context) => handleOnline(ack, context),
    onOffline: info => {
      state.status = { state: CONNECTION_STATE.RECONNECTING, reason: info.reason }
      renderHeader()
      renderStatusBanner()
    },
    onFrame: frame => {
      // 单帧处理失败不能把整条连接搞哑：catch 住、提示、继续收下一帧。
      try {
        handleFrame(frame)
      } catch (error) {
        showToast(`处理消息帧失败：${/** @type {Error} */ (error).message}`, 'error', 5000)
      }
    },
  })
  state.connection.raceSize = pairing ? 1 : 2
  state.connection.start()
}

function teardownConnection() {
  if (state.connection) {
    state.connection.stop('页面切换')
    state.connection = undefined
  }
}

/** 每次 socket open 都构造新的 hello（nonce 必须每次不同）。 */
function buildHelloFrame() {
  if (!state.identity) throw new Error('没有设备身份')
  const nonce = newNonce()
  const frame = buildHello({
    identity: state.identity,
    nonce,
    deviceName: currentDeviceName(),
    cursor: state.model?.cursor ?? 0,
    sessionId: state.model?.sessionId ?? undefined,
  })
  frame.signature = signHello(nacl, state.identity, nonce)
  if (state.pairSecret) frame.pairSecret = state.pairSecret
  return frame
}

/** 把当前会话信息写回 localStorage 的绑定记录。 */
function persistBinding() {
  if (!state.identity) return
  let base
  if (state.pendingPayload) {
    base = bindingFromPayload(state.pendingPayload)
    if (!base.computerPublicKey) base.computerPublicKey = state.binding?.computerPublicKey ?? ''
  } else if (state.binding) {
    base = { ...state.binding }
  } else {
    return
  }
  state.binding = {
    ...base,
    ...serializeIdentity(state.identity),
    endpoints: state.endpoints.slice(0, 20),
    mode: state.settings.mode,
    verified: state.verified === true,
    lastConnectedAt: new Date().toISOString(),
  }
  storage.saveBinding(state.binding)
}

/** @param {object} ack @param {{url: string, kind: string, verified: boolean}} context */
function handleOnline(ack, context) {
  state.pairSecret = ''
  state.verified = context.verified === true
  state.serverCaps = new Set(Array.isArray(ack.capabilities) ? ack.capabilities : [])
  state.syncReceived = false
  state.sessionListLoading = false
  state.pendingSelect = null
  state.pendingSnapshots = new Map()

  // 电脑端当前的绑定。插件重启会忘掉「这台设备在哪个会话」并新建一个：
  // 我们以恢复出来的标签为准，让它重新 select 当前标签；一个标签都没有时
  // （首次绑定 / 首次打开网页）才把电脑端绑定的会话开成第一个标签。
  const boundSession = typeof ack.sessionId === 'string' ? ack.sessionId : ''
  if (boundSession) state.model.sessionsCurrent = boundSession
  if (!state.model.activeSessionId && boundSession) {
    state.model.openTab(boundSession, { activate: true })
  } else if (state.model.activeSessionId && sessionsSupported() && boundSession !== state.model.activeSessionId) {
    // 电脑端绑定的不是当前标签（插件重启 / 老版本没带 sessionId）：以标签为准选回来。
    sendSelect(state.model.activeSessionId, { reason: 'restore' })
  }

  // hello/ack 带回电脑当下认为可达的地址：并进候选列表（并保留二维码里的类型判断）。
  if (Array.isArray(ack.endpointList) && ack.endpointList.length > 0) {
    const current = state.endpoints.length > 0 ? state.endpoints : (state.binding?.endpoints ?? [])
    state.endpoints = mergeEndpointSources(
      { endpoints: current.map(item => item.url), epk: current.map(item => endpointKindCode(item.kind)) },
      ack.endpointList,
    )
    if (state.connection) state.connection.setCandidates(computeCandidates())
  }

  state.settings = storage.saveSettings({ preferredEndpoint: context.url })
  persistBinding()
  persistNow()
  // 重连后每个标签都要重新对账：刷新列表拿到最新标题/live，再让每个标签各取
  // 一份快照（后台会话的快照不会改变绑定），最后重发订阅与离线队列。
  if (sessionsSupported()) requestSessionList({ quiet: true })
  // 先订阅后台标签，再要快照：电脑端只允许「当前绑定或已订阅」的会话取快照，
  // 反过来发会被回 not-allowed。
  sendTabWatch()
  requestTabSnapshots()
  flushOutbox()
  scheduleSessionSync()
  renderTabs()
  renderHeader()
  renderStatusBanner()
  renderMessages({ forceScroll: true })
  renderComposerState()
  if (state.settingsOpen) renderSettings()
  if (ack.pairAccepted) {
    showToast(`已绑定「${state.computerName}」`, 'ok', 2600)
  } else if (!state.firstOnlineShown) {
    showToast('已连接', 'ok', 1800)
  }
  state.firstOnlineShown = true
}

/** @param {any} status */
function handleRejected(status) {
  const reason = String(status.reason ?? '连接被电脑拒绝')
  showToast(reason, 'error', 5200)
  if (!state.binding) {
    // 首次绑定失败：回绑定页，把错误留在原地让人重扫码。
    teardownConnection()
    state.pendingPayload = undefined
    state.pairSecret = ''
    showView('bind')
    resetBindUI()
    setBindStatus(reason, 'error')
  }
}

/** endpoint kind → 二维码单字母编码（用于 mergeEndpointSources 保留类型）。 */
function endpointKindCode(kind) {
  return { lan: 'l', tailscale: 't', tunnel: 'c', loopback: 'u', unknown: 'x' }[kind] ?? 'x'
}

function scheduleSessionSync() {
  if (state.syncTimer) {
    clearTimeout(state.syncTimer)
    state.syncTimer = null
  }
  if (!state.serverCaps.has(CAPABILITIES.SESSION_SYNC)) return
  if (state.model.cursor <= 0 && state.model.messages.length === 0) return
  state.syncTimer = setTimeout(() => {
    state.syncTimer = null
    if (state.syncReceived) return
    requestSessionSync()
    state.syncReceived = true // 只补一次；仍失败就等下次重连
  }, 2500)
}

function requestSessionSync() {
  if (!state.connection?.online) return
  if (!state.serverCaps.has(CAPABILITIES.SESSION_SYNC)) return
  state.connection.send({ t: CLIENT_FRAME.SESSION_SYNC, rid: uid('sync'), cursor: state.model.cursor })
}

// ---------------------------------------------------------------------------
// 会话标签条
// ---------------------------------------------------------------------------

/** 电脑端是否支持会话列表（老插件没有 sessions-v1）。 */
function sessionsSupported() {
  return state.serverCaps.has(CAPABILITIES.SESSIONS)
}

/** 电脑端是否支持多标签（session/watch + session/snapshot + 帧上的 sessionId）。 */
function tabsSupported() {
  return state.serverCaps.has(CAPABILITIES.SESSION_TABS)
}

/**
 * 告诉电脑端「消息发往哪个会话」。电脑端会保留其它会话的 agent（切走的标签继续跑）。
 * @param {string} sessionId
 * @param {{reason?: 'switch'|'create'|'restore'}} [options]
 */
function sendSelect(sessionId, options = {}) {
  if (!sessionsSupported()) return false
  const id = String(sessionId ?? '')
  if (id === '' || !state.connection?.online) return false
  const rid = uid('sess')
  const pending = { reason: options.reason ?? 'switch', sessionId: id, rid }
  state.pendingSelect = pending
  schedulePendingSelectTimeout(pending)
  return Boolean(state.connection.send({ t: CLIENT_FRAME.SESSION_SELECT, rid, sessionId: id }))
}

/**
 * 等 session/selected 的超时兜底：电脑端不回复（帧被代理吞掉 / 老插件）时，
 * 不能永远卡在「正在切换」把消息全压在队列里。
 * @param {any} pending
 */
function schedulePendingSelectTimeout(pending) {
  setTimeout(() => {
    if (state.pendingSelect !== pending) return
    state.pendingSelect = null
    flushOutbox()
  }, 6000)
}

/** 订阅后台标签（当前标签电脑端本来就会推，不用列进去）。 */
function sendTabWatch() {
  if (!tabsSupported() || !state.connection?.online) return
  const frame = buildWatchFrame(state.model?.watchList() ?? [])
  state.connection.send(frame)
}

/**
 * 让某个标签取一份现状（不改变这台设备的绑定）。用于新打开的标签、重连后对账。
 * @param {string} sessionId
 */
function requestTabSnapshot(sessionId) {
  if (!tabsSupported() || !state.connection?.online) return false
  const id = String(sessionId ?? '')
  if (id === '') return false
  const rid = uid('snap')
  state.pendingSnapshots.set(rid, id)
  // 防止长时间收不到回复时 Map 无限增长。
  if (state.pendingSnapshots.size > 32) {
    const oldest = state.pendingSnapshots.keys().next().value
    if (oldest !== undefined) state.pendingSnapshots.delete(oldest)
  }
  return Boolean(state.connection.send(buildSnapshotFrame(rid, id)))
}

/** 重连 / 打开后给每个标签各要一份快照。 */
function requestTabSnapshots() {
  if (!tabsSupported()) return
  for (const id of state.model?.tabs ?? []) requestTabSnapshot(id)
}

/** 打开会话面板时拉一次列表。 */
function requestSessionList({ force = false, quiet = false } = {}) {
  if (!sessionsSupported()) {
    if (!quiet) showToast('电脑端版本较旧，不支持会话列表；请升级电脑端插件', 'error', 4600)
    return
  }
  if (!state.connection?.online) {
    // 离线时面板还能显示缓存里的列表；不弹 toast（否则每次点开都提示一次）。
    state.sessionListLoading = false
    renderSessionSheet()
    return
  }
  if (state.sessionListLoading && !force) return
  state.sessionListLoading = true
  if (state.sessionSheetOpen) renderSessionSheet()
  state.connection.send({ t: CLIENT_FRAME.SESSION_LIST, rid: uid('list') })
}

/**
 * 标签 / 当前会话变化后的统一收尾：立刻重绘、落盘、重发订阅与绑定。
 * @param {{select?: boolean}} [options]
 */
function afterTabChange(options = {}) {
  const select = options.select !== false
  state.lastRenderSignature = ''
  renderTabs()
  renderHeader()
  renderMessages({ forceScroll: true })
  renderComposerState()
  syncApprovalTicker()
  persistTabsNow()
  if (!state.connection?.online) return
  sendTabWatch()
  const activeId = state.model?.activeSessionId ?? ''
  if (activeId === '') return
  if (select && sessionsSupported()) sendSelect(activeId)
  // 点标签先渲染本地缓存，再让电脑端补一份快照对账：缓存可能来自上一次会话
  // （页面在后台被冻结、socket 半死），快照是权威的。后台标签已经订阅过，允许取。
  if (tabsSupported()) requestTabSnapshot(activeId)
  flushOutbox()
}

/**
 * 点标签：本地立即切换（缓存先渲染），再让电脑端把绑定与快照对过来。
 * @param {string} sessionId
 */
function switchTab(sessionId) {
  const result = state.model?.activateTab(sessionId)
  if (!result?.ok || !result.changed) return
  afterTabChange()
}

/**
 * 从「全部会话」列表打开一个会话：已打开就切过去，没打开就新开一个标签。
 * @param {string} sessionId
 */
function openSessionTab(sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return
  if (!tabsSupported()) {
    // 老电脑端没有后台订阅：多标签只会看到僵住的内容，保持单标签语义。
    for (const other of [...state.model.tabs]) {
      if (other !== id) state.model.closeTab(other)
    }
  }
  const result = state.model.openTab(id, { activate: true })
  if (!result.ok) {
    if (result.reason === 'limit') {
      showToast(`最多同时打开 ${TAB_LIMIT} 个会话，先关掉一个标签再试`, 'error', 4200)
    }
    return
  }
  closeSessionSheet()
  afterTabChange({ select: result.opened || result.activated })
}

/** 关闭标签：只关本地；关的是当前标签就切相邻并让电脑端跟过去。 */
function closeTab(sessionId) {
  const before = state.model?.activeSessionId ?? ''
  const result = state.model?.closeTab(sessionId)
  if (!result?.ok) return
  // 被关标签的离线队列没有意义了（消息跟着标签一起消失）。
  state.outbox = state.outbox.filter(entry => entry.sessionId !== result.closed)
  // 关的不是当前标签时绑定没变，不用再发 session/select（也就不会白等一次确认）。
  afterTabChange({ select: result.activeSessionId !== before })
}

/** 新建会话：电脑端返回新 id 后再开标签并激活。 */
function createSession() {
  if (!sessionsSupported()) {
    showToast('电脑端版本较旧，不支持新建会话；请升级电脑端插件', 'error', 4600)
    return
  }
  if (!state.connection?.online) {
    showToast('还没连上电脑，暂时不能新建会话', 'error')
    return
  }
  const rid = uid('sess')
  const pending = { reason: 'create', rid }
  state.pendingSelect = pending
  schedulePendingSelectTimeout(pending)
  state.connection.send({ t: CLIENT_FRAME.SESSION_CREATE, rid })
  if (state.sessionSheetOpen) renderSessionSheet()
}

function openSessionSheet() {
  if (!sessionsSupported()) {
    showToast('电脑端版本较旧，不支持会话列表；请升级电脑端插件', 'error', 4600)
    return
  }
  state.sessionSheetOpen = true
  if (state.settingsOpen) closeSettings()
  dom.sessionSheet.hidden = false
  syncSheetBackdrop()
  renderSessionSheet()
  requestSessionList()
}

function closeSessionSheet() {
  state.sessionSheetOpen = false
  dom.sessionSheet.hidden = true
  syncSheetBackdrop()
}

/** 两个底部面板共用一层遮罩；只有都关掉时才隐藏。 */
function syncSheetBackdrop() {
  dom.sheetBackdrop.hidden = !(state.settingsOpen || state.sessionSheetOpen)
}

/** 标签条签名：只有它变了才重写 DOM（避免流式输出时标签条每帧闪一下）。 */
function tabSignature() {
  const model = state.model
  if (!model) return ''
  // 能力位（multi）也进签名：接上电脑端后关闭按钮 / 「+」/「全部会话」才会出现。
  const parts = [tabsSupported() ? 'multi' : 'single', model.activeSessionId]
  for (const id of model.tabs) {
    parts.push(
      `${id}\u0001${model.titleFor(id)}\u0001${model.unreadFor(id)}\u0001${model.typingFor(id) ? 1 : 0}\u0001${
        model.liveFor(id) ? 1 : 0
      }\u0001${model.hasApprovalIn(id) ? 1 : 0}`,
    )
  }
  return parts.join('\u0002')
}

/** 常驻在标题栏下方的会话标签条（标题 + 运行点 + 未读 + 审批角标 + 关闭 + 「+」）。 */
function renderTabs() {
  if (!dom.sessionTabs) return
  const model = state.model
  if (!model) {
    dom.sessionTabs.innerHTML = ''
    dom.sessionTabs.hidden = true
    return
  }
  const multi = tabsSupported()
  dom.sessionTabs.hidden = !multi && model.tabs.length === 0
  const signature = tabSignature()
  if (signature !== state.lastTabsSignature) {
    state.lastTabsSignature = signature
    const scrollLeft = dom.sessionTabs.scrollLeft
    // 同名标签追加 #序号，避免一排「会话」无法分辨（手机真机反馈）。
    const displayTitles = model.tabDisplayTitles?.() ?? new Map()
    const items = model.tabs
      .map(id => {
        const active = id === model.activeSessionId
        const title = displayTitles.get(id) ?? model.titleFor(id)
        const unread = model.unreadFor(id)
        const typing = model.typingFor(id)
        const live = model.liveFor(id)
        // 当前标签的审批卡片就在眼前，不需要再挂角标；只提醒「其它标签」有待办。
        const approval = !active && model.hasApprovalIn(id)
        const classes = ['session-tab']
        if (active) classes.push('is-active')
        if (typing) classes.push('is-running')
        const indicators = [
          typing
            ? '<span class="tab-dot is-running" title="正在回复"></span>'
            : live
              ? '<span class="tab-dot is-live" title="运行中"></span>'
              : '',
          approval ? '<span class="tab-approval" title="有权限请求">!</span>' : '',
          unread > 0 ? `<span class="tab-unread">${unread > 99 ? '99+' : unread}</span>` : '',
        ]
          .filter(Boolean)
          .join('')
        return `<div class="${classes.join(' ')}" role="presentation">
          <button class="session-tab-main" type="button" role="tab" aria-selected="${active ? 'true' : 'false'}" data-action="activate-tab" data-session-id="${escapeHtml(id)}" title="${escapeHtml(title)}">
            <span class="session-tab-title">${escapeHtml(title)}</span>
            ${indicators}
          </button>
          ${
            multi
              ? `<button class="session-tab-close" type="button" data-action="close-tab" data-session-id="${escapeHtml(
                  id,
                )}" aria-label="关闭 ${escapeHtml(title)}">×</button>`
              : ''
          }
        </div>`
      })
      .join('')
    const actions = multi
      ? `<button class="session-tab-add" type="button" data-action="new-session" aria-label="新建会话" title="新建会话">+</button>
         <button class="session-tab-all" type="button" data-action="open-sessions" title="全部会话">全部会话</button>`
      : ''
    dom.sessionTabs.innerHTML = `${items}${actions}`
    dom.sessionTabs.scrollLeft = scrollLeft
  }
  if (model.activeSessionId !== state.lastActiveTabId) {
    state.lastActiveTabId = model.activeSessionId
    const active = dom.sessionTabs.querySelector('.session-tab.is-active')
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
}

/** 会话面板：打开/切换标签的来源。 */
function renderSessionSheet() {
  if (!state.sessionSheetOpen || !dom.sessionSheet) return
  const model = state.model
  const sessions = Array.isArray(model?.sessions) ? model.sessions : []
  const openTabs = new Set(model?.tabs ?? [])
  const activeId = model?.activeSessionId ?? ''
  const multi = tabsSupported()
  const rows = sessions
    .map(session => {
      const badges = []
      if (session.live) badges.push('<span class="badge is-live">在线</span>')
      if (session.id === activeId) badges.push('<span class="badge is-current">当前</span>')
      else if (openTabs.has(session.id)) badges.push('<span class="badge is-open">已打开</span>')
      const time = relativeTime(session.updatedAt ?? session.createdAt)
      const meta = [time, session.cwd ? session.cwd : ''].filter(Boolean).map(escapeHtml).join(' · ')
      const action = multi ? 'open-session' : 'select-session'
      return `<button class="session-row" type="button" data-action="${action}" data-session-id="${escapeHtml(session.id)}">
        <span class="session-row-main">
          <span class="session-row-title">${escapeHtml(session.title)}</span>
          <span class="session-row-meta">${meta}</span>
        </span>
        <span class="session-badges">${badges.join('')}</span>
      </button>`
    })
    .join('')
  const empty = sessions.length === 0
    ? `<p class="session-empty">${
      state.sessionListLoading
        ? '正在读取电脑上的会话…'
        : state.connection?.online
          ? '还没有会话，点下面「新建会话」开始。'
          : '还没连上电脑：连上后这里会列出电脑上的会话。'
    }</p>`
    : ''
  const truncated = model?.sessionsTruncated
    ? '<p class="session-note">会话太多，这里只显示最近的一部分。</p>'
    : ''
  dom.sessionSheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <h2>全部会话</h2>
    <p class="sheet-row-note">${
      multi
        ? `点一个会话把它打开成标签（当前已打开 ${openTabs.size} / ${TAB_LIMIT} 个）；已打开的会直接切过去。`
        : '电脑端版本较旧，切换会话会替换当前页面的内容。'
    }</p>
    <div class="session-list" role="list">${rows}${empty}</div>
    ${truncated}
    <button class="btn btn-secondary btn-block session-new" type="button" data-action="new-session">新建会话</button>
  `
}

/**
 * `session/selected`：成功就补标签 / 激活，失败把刚开的标签收回去。
 * 连点标签时可能有多条 select 在途：只有最新那条的回复能清掉 pending 并放行队列，
 * 迟到的旧回复只补标签缓存，避免把消息发到旧的绑定上。
 * @param {any} frame
 */
function handleSessionSelected(frame) {
  const selection = state.model?.lastSessionSelection
  const pending = state.pendingSelect
  const frameRid = typeof frame?.rid === 'string' ? frame.rid : ''
  const stale = pending && pending.rid !== undefined && frameRid !== '' && pending.rid !== frameRid
  if (stale) {
    if (selection?.ok && selection.sessionId) state.model.openTab(selection.sessionId, { activate: false })
    persistTabsNow()
    return
  }
  state.pendingSelect = null
  if (!selection) return
  if (selection.ok) {
    const id = selection.sessionId || pending?.sessionId || ''
    if (id === '') return
    if (pending?.reason === 'create') {
      state.model.openTab(id, { activate: true })
      closeSessionSheet()
      afterTabChange({ select: false })
      // 列表里也补上新会话（标题 / live 需要电脑端算），下次打开面板就能看到。
      requestSessionList({ force: true, quiet: true })
      showToast(selection.title ? `已新建「${selection.title}」` : '已新建会话', 'ok', 2400)
    } else {
      const result = state.model.openTab(id, { activate: false })
      if (result.opened) afterTabChange({ select: false })
    }
    flushOutbox()
    return
  }
  // 切换 / 新建失败：not-found 的标签直接收回，避免一个永远加载不出来的标签。
  const id = pending?.sessionId || selection.sessionId || ''
  if (id) {
    const result = state.model.closeTab(id)
    if (result.changed) afterTabChange({ select: false })
  }
  if (state.sessionSheetOpen) renderSessionSheet()
  showToast(selection.message || selection.error || '切换会话失败', 'error', 4600)
  flushOutbox()
}

// ---------------------------------------------------------------------------
// 审批卡片
// ---------------------------------------------------------------------------

/** 没有待办 / 用户已答复 / 已过期时，倒计时定时器就该停。 */
function stopApprovalTicker() {
  if (state.approvalTicker !== null) {
    clearInterval(state.approvalTicker)
    state.approvalTicker = null
  }
}

function syncApprovalTicker() {
  const approvals = state.model?.approvals ?? []
  const questions = state.model?.questions ?? []
  // 只有「带 expiresAt 且还没回答」的卡片需要每秒刷新倒计时。
  const needApproval = approvals.some(
    item => !item.replied && Number.isFinite(Number(item.expiresAt)) && !approvalExpired(item),
  )
  const needQuestion = questions.some(
    item => !item.replied && Number.isFinite(Number(item.expiresAt)) && !questionExpired(item),
  )
  if (!needApproval && !needQuestion) {
    stopApprovalTicker()
    return
  }
  if (state.approvalTicker === null) {
    state.approvalTicker = setInterval(updateApprovalCountdowns, 1000)
  }
}

/** 只改倒计时文本和按钮可用态，不整表重绘（避免每秒钟闪一次）。 */
function updateApprovalCountdowns() {
  const model = state.model
  if (!model) {
    stopApprovalTicker()
    return
  }
  let live = false
  for (const node of dom.messageList.querySelectorAll('[data-countdown-for]')) {
    const approval = model.approvalsById.get(node.dataset.countdownFor ?? '')
    if (!approval) continue
    const expired = approvalExpired(approval)
    if (!approval.replied && !expired) live = true
    node.textContent = approvalCountdownText(approval)
    const card = node.closest('.approval-card')
    if (card) {
      card.classList.toggle('is-expired', expired)
      for (const button of card.querySelectorAll('button')) button.disabled = expired || approval.replied === true
    }
  }
  for (const node of dom.messageList.querySelectorAll('[data-question-countdown-for]')) {
    const question = model.questionsById.get(node.dataset.questionCountdownFor ?? '')
    if (!question) continue
    const expired = questionExpired(question)
    const answered = question.replied === true
    if (!answered && !(expired && question.canAnswerLate !== true)) live = true
    node.textContent = questionCountdownText(question)
    const card = node.closest('.question-card')
    if (card) {
      card.classList.toggle('is-expired', expired)
      const locked = answered || (expired && question.canAnswerLate !== true)
      if (locked) {
        for (const control of card.querySelectorAll('button, input')) control.disabled = true
      }
    }
  }
  if (!live) stopApprovalTicker()
}

/** @param {string} approvalId @param {'allowed-once'|'rejected'} outcome */
function replyApproval(approvalId, outcome) {
  const model = state.model
  if (!model) return
  if (!state.connection?.online) {
    showToast('还没连上电脑，无法回答这条请求', 'error')
    return
  }
  if (!model.markApprovalReplied(approvalId, outcome)) return
  state.connection.send({ t: CLIENT_FRAME.APPROVAL_REPLY, approvalId, outcome })
  scheduleRender()
  syncApprovalTicker()
  showToast(outcome === 'allowed-once' ? '已允许这一次调用' : '已拒绝这次调用', 'ok', 2200)
}

/**
 * 待处理审批卡片（一道请求一张卡，多条排队纵向排列）。
 * @param {any} approval
 * @returns {string}
 */
function approvalCardHtml(approval) {
  const expired = approvalExpired(approval)
  const replied = approval.replied === true
  const disabled = expired || replied
  const classes = ['approval-card']
  if (expired) classes.push('is-expired')
  if (replied) classes.push('is-replied')
  const reason = escapeHtml(approvalReasonText(approval))
  const tool = escapeHtml(approval.toolName ?? '工具')
  let foot = ''
  if (replied) {
    foot = `<p class="approval-state">${
      approval.repliedOutcome === 'allowed-once' ? '已允许（等待电脑确认）' : '已拒绝（等待电脑确认）'
    }</p>`
  } else if (approval.expiresAt) {
    foot = `<p class="approval-countdown" data-countdown-for="${escapeHtml(approval.approvalId)}">${escapeHtml(
      approvalCountdownText(approval),
    )}</p>`
  }
  return `<div class="${classes.join(' ')}" data-approval-card="${escapeHtml(approval.approvalId)}" role="group" aria-label="权限请求">
    <div class="approval-head">
      <span class="approval-tool">${tool}</span>
      <span class="approval-request">请求执行</span>
    </div>
    <p class="approval-reason">${reason}</p>
    ${foot}
    <div class="approval-actions">
      <button class="btn btn-primary approval-allow" type="button" data-action="approval-reply" data-approval-id="${escapeHtml(
        approval.approvalId,
      )}" data-outcome="allowed-once" ${disabled ? 'disabled' : ''}>允许一次</button>
      <button class="btn btn-danger approval-deny" type="button" data-action="approval-reply" data-approval-id="${escapeHtml(
        approval.approvalId,
      )}" data-outcome="rejected" ${disabled ? 'disabled' : ''}>拒绝</button>
    </div>
  </div>`
}

/** 所有待处理审批的卡片栈（没有则返回空串）。 */
function approvalCardsHtml() {
  const approvals = state.model?.approvals ?? []
  if (approvals.length === 0) return ''
  return `<div class="approval-stack" aria-live="polite">${approvals.map(approvalCardHtml).join('')}</div>`
}

// ---------------------------------------------------------------------------
// 提问卡片（3.0.0）
// ---------------------------------------------------------------------------

/**
 * 页面上的提问草稿：questionId → (itemId → {selected, custom})。
 * 放在 DOM 之外，重绘不会把用户已经选中的选项/输入的文本冲掉。
 */
const questionDrafts = new Map()

/** @param {string} questionId */
function draftFor(questionId) {
  let draft = questionDrafts.get(questionId)
  if (!draft) {
    draft = {}
    questionDrafts.set(questionId, draft)
  }
  return draft
}

/** @param {any} question */
function questionCardHtml(question) {
  const draft = draftFor(question.questionId)
  const expired = questionExpired(question)
  const replied = question.replied === true
  const disabled = replied || (expired && question.canAnswerLate !== true)
  const classes = ['question-card']
  if (expired) classes.push('is-expired')
  if (replied) classes.push('is-replied')
  const planReview = question.items.some(item => item.intent?.kind === 'plan-review')
  const items = question.items.map((item, index) => {
    const selection = draft[item.id] ?? { selected: [] }
    const options = (item.options ?? []).map(option => {
      const selected = (selection.selected ?? []).includes(option.label)
      const approve = item.intent?.kind === 'plan-review' && item.intent.approve === option.label
      const optionClasses = ['question-option']
      if (selected) optionClasses.push('is-selected')
      if (approve) optionClasses.push('is-approve')
      return `<button class="${optionClasses.join(' ')}" type="button" role="button"
        data-action="question-option" data-question-id="${escapeHtml(question.questionId)}"
        data-item-id="${escapeHtml(item.id)}" data-label="${escapeHtml(option.label)}"
        aria-pressed="${selected ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>
        <span class="question-option-label">${selected ? '✓ ' : ''}${escapeHtml(option.label)}</span>
        ${approve ? '<span class="question-approve-badge">同意</span>' : ''}
        ${option.description ? `<span class="question-option-desc">${escapeHtml(option.description)}</span>` : ''}
      </button>`
    })
    return `<div class="question-item">
      <p class="question-text">${question.items.length > 1 ? `${index + 1}. ` : ''}${escapeHtml(item.question)}</p>
      ${item.header ? `<p class="question-item-header">${escapeHtml(item.header)}</p>` : ''}
      ${item.detail ? `<p class="question-detail">${escapeHtml(item.detail)}</p>` : ''}
      ${options.length > 0 ? `<div class="question-options">${options.join('')}</div>` : ''}
      <input class="question-custom" type="text" autocomplete="off"
        data-question-id="${escapeHtml(question.questionId)}" data-item-id="${escapeHtml(item.id)}"
        placeholder="${item.options?.length ? '其他（可选，填写后覆盖上面的选择）' : '输入你的回答'}"
        value="${escapeHtml(selection.custom ?? '')}" ${disabled ? 'disabled' : ''} />
    </div>`
  })
  const foot = replied
    ? '<p class="question-state">已提交，等待电脑继续</p>'
    : `<p class="question-countdown" data-question-countdown-for="${escapeHtml(question.questionId)}">${escapeHtml(
        questionCountdownText(question),
      )}</p>
      <button class="btn btn-primary question-submit" type="button" data-action="question-submit"
        data-question-id="${escapeHtml(question.questionId)}" ${disabled ? 'disabled' : ''}>提交回答</button>`
  return `<div class="${classes.join(' ')}" data-question-card="${escapeHtml(question.questionId)}" role="group" aria-label="提问">
    <div class="question-head">
      <span class="question-title">${planReview ? '计划需要你确认' : '需要你的回答'}</span>
      ${question.canAnswerLate ? '<span class="question-badge">可稍后补答</span>' : ''}
    </div>
    ${items.join('')}
    <div class="question-foot">${foot}</div>
  </div>`
}

/**
 * 点一个选项：单选替换、多选切换。只改草稿 + 按钮选中态，整表重绘会把焦点丢掉。
 * @param {HTMLElement} button
 */
function toggleQuestionOption(button) {
  const questionId = button.dataset.questionId ?? ''
  const itemId = button.dataset.itemId ?? ''
  const label = button.dataset.label ?? ''
  const question = state.model?.questionsById.get(questionId)
  const item = question?.items.find(entry => entry.id === itemId)
  if (!item) return
  const draft = draftFor(questionId)
  const current = draft[itemId] ?? { selected: [] }
  const selected = new Set(current.selected ?? [])
  if (item.multiSelect === true) {
    if (selected.has(label)) selected.delete(label)
    else selected.add(label)
  } else if (selected.has(label)) {
    selected.clear()
  } else {
    selected.clear()
    selected.add(label)
  }
  draft[itemId] = { ...current, selected: [...selected] }
  const card = button.closest('.question-card')
  if (!card) return
  for (const option of card.querySelectorAll('.question-option')) {
    if (option.dataset.itemId !== itemId) continue
    const isSelected = (draft[itemId].selected ?? []).includes(option.dataset.label ?? '')
    option.classList.toggle('is-selected', isSelected)
    option.setAttribute('aria-pressed', isSelected ? 'true' : 'false')
    const labelNode = option.querySelector('.question-option-label')
    if (labelNode) labelNode.textContent = `${isSelected ? '✓ ' : ''}${option.dataset.label ?? ''}`
  }
}

/** 所有待回答提问的卡片栈（没有则返回空串）。 */
function questionCardsHtml() {
  const questions = state.model?.questions ?? []
  if (questions.length === 0) return ''
  return `<div class="question-stack" aria-live="polite">${questions.map(questionCardHtml).join('')}</div>`
}

/**
 * 提交一批回答。拼包规则与手机端一致（未答 = 跳过；单选 custom 覆盖 selected）。
 * @param {string} questionId
 */
function submitQuestion(questionId) {
  const model = state.model
  if (!model) return
  if (!state.connection?.online) {
    showToast('还没连上电脑，无法提交回答', 'error')
    return
  }
  const found = model.findQuestion(questionId)
  if (!found) return
  const reply = buildQuestionReply(found.question, draftFor(questionId))
  if (!reply) {
    showToast('这批提问已经失效了', 'error', 3200)
    return
  }
  if (!model.markQuestionReplied(questionId)) return
  state.connection.send({ t: CLIENT_FRAME.QUESTION_REPLY, ...reply })
  scheduleRender()
  syncApprovalTicker()
  showToast('已提交回答', 'ok', 2200)
}

// ---------------------------------------------------------------------------
// 帧处理
// ---------------------------------------------------------------------------

/** @param {any} frame */
function handleFrame(frame) {
  if (!frame || typeof frame.t !== 'string') return

  // 上传握手帧先交给当前上传任务（它用 uploadId 判断是不是自己的）。
  if (state.uploader && state.uploader.handleFrame(frame)) return

  if (
    frame.t === SERVER_FRAME.FILE_META ||
    frame.t === SERVER_FRAME.FILE_CHUNK ||
    frame.t === SERVER_FRAME.FILE_END ||
    frame.t === SERVER_FRAME.FILE_ERROR
  ) {
    handleFileFrame(frame)
    return
  }
  if (frame.t === SERVER_FRAME.ASSISTANTS) {
    state.assistants = Array.isArray(frame.assistants) ? frame.assistants : []
    return
  }
  if (frame.t === SERVER_FRAME.PONG) return

  if (frame.t === SERVER_FRAME.SESSION_EVENTS || (frame.t === SERVER_FRAME.SESSION_STATE && frame.active !== false)) {
    // 只有「当前会话」的快照/回放才算补同步；后台标签的快照不影响 cursor 策略。
    state.syncReceived = true
    if (state.syncTimer) {
      clearTimeout(state.syncTimer)
      state.syncTimer = null
    }
  }
  if (frame.t === SERVER_FRAME.SESSION_STATE && typeof frame.rid === 'string') {
    state.pendingSnapshots.delete(frame.rid)
  }

  const approvalsBefore = targetApprovalsCount(frame)
  const result = state.model.applyFrame(frame)
  const target = result.targetSessionId ?? state.model?.activeSessionId ?? ''
  const isActiveTarget = target === (state.model?.activeSessionId ?? '')

  if (frame.t === SERVER_FRAME.CHAT_ACK) {
    const msgId = String(frame.rid ?? frame.callId ?? '')
    if (msgId) {
      // ack 帧不带 sessionId，可能在切标签后才到：按 msgId 找到它真正的会话。
      state.model.markUserMessageSent(msgId, { callId: frame.callId, duplicate: frame.duplicate === true })
      state.outbox = state.outbox.filter(entry => entry.msgId !== msgId)
      storage.saveOutbox(
        state.identity?.deviceId ?? '',
        state.outbox.map(entry => ({
          msgId: entry.msgId,
          text: entry.text ?? '',
          at: entry.at,
          sessionId: entry.sessionId,
        })),
      )
    }
    persistSoon(200)
  }
  if (frame.t === SERVER_FRAME.ERROR) {
    showToast(String(frame.message ?? '电脑端返回错误'), 'error')
    if (state.sessionListLoading) {
      // 会话列表请求被拒时不能一直显示「正在读取…」。
      state.sessionListLoading = false
      if (state.sessionSheetOpen) renderSessionSheet()
    }
  }
  if (frame.t === SERVER_FRAME.CHAT_ERROR || frame.t === SERVER_FRAME.CHAT_DONE) renderComposerState()
  if (frame.t === SERVER_FRAME.CHAT_ERROR || frame.t === SERVER_FRAME.CHAT_DONE) flushQueue()

  if (frame.t === SERVER_FRAME.SESSIONS) {
    state.sessionListLoading = false
    if (state.sessionSheetOpen) renderSessionSheet()
    if (Array.isArray(result.dropped) && result.dropped.length > 0) {
      // 恢复出来的标签里有会话在电脑上已经没了：丢掉并提示（契约 §4）。
      afterTabChange({ select: true })
      showToast(`${result.dropped.length} 个会话在电脑上已不存在，已从标签里移除`, '', 4600)
    } else {
      renderTabs()
    }
    persistTabsNow()
  }
  if (frame.t === SERVER_FRAME.SESSION_SELECTED) handleSessionSelected(frame)
  if (frame.t === SERVER_FRAME.APPROVAL_ASK) {
    renderApprovalBanner()
    if (isActiveTarget) {
      syncApprovalTicker()
      if (targetApprovalsCount(frame) > approvalsBefore) {
        showToast('电脑在请求权限，请在上面这张卡片里作答', '', 3200)
      }
    } else if (targetApprovalsCount(frame) > approvalsBefore) {
      showToast(`「${state.model.titleFor(target)}」有一个权限请求，切到该标签处理`, '', 3600)
    }
  }
  if (frame.t === SERVER_FRAME.APPROVAL_RESOLVED) handleApprovalResolved(result.resolved)
  if (frame.t === SERVER_FRAME.APPROVAL_RESOLVED) renderApprovalBanner()
  if (frame.t === SERVER_FRAME.QUESTION_ASK) {
    syncApprovalTicker()
    if (isActiveTarget) {
      showToast('电脑有一个问题需要你回答', '', 3200)
    } else {
      showToast(`「${state.model.titleFor(target)}」有一个问题，切到该标签回答`, '', 3600)
    }
  }
  if (frame.t === SERVER_FRAME.QUESTION_RESOLVED) {
    showToast('问题已处理', '', 2200)
    scheduleRender()
  }
  if (result.needsWatch) sendTabWatch()

  if (result.changed) {
    scheduleRender({
      forceScroll:
        isActiveTarget &&
        (frame.t === SERVER_FRAME.SESSION_STATE ||
          frame.t === SERVER_FRAME.APPROVAL_ASK ||
          frame.t === SERVER_FRAME.QUESTION_ASK ||
          frame.t === SERVER_FRAME.SESSION_EVENTS),
    })
    persistSoon()
  }
  if (frame.t === SERVER_FRAME.SESSION_SELECTED || result.opened) persistTabsNow()
}

/**
 * 某条会话帧到达前的审批数（用于「这是新审批吗」的判断）。
 * @param {any} frame
 */
function targetApprovalsCount(frame) {
  const model = state.model
  if (!model) return 0
  const sessionId =
    typeof frame?.sessionId === 'string' && frame.sessionId !== '' ? frame.sessionId : model.activeSessionId
  return model.chatFor(sessionId)?.approvals.length ?? 0
}

/** `approval/resolved`：卡片由 reducer 移出队列；这里只补充用户看得懂的提示。 */
function handleApprovalResolved(resolved) {
  syncApprovalTicker()
  if (!resolved) return
  // 后台标签的请求被电脑处理掉时也给一句，但只在当前标签才需要「你答的」语气。
  const title = resolved.sessionId ? state.model?.titleFor(resolved.sessionId) : ''
  const label = resolved.sessionId && resolved.sessionId !== state.model?.activeSessionId ? `「${title}」的` : '这条'
  if (resolved.outcome === 'cancelled') {
    showToast(
      resolved.source === 'timeout' ? `${label}权限请求已超时，交回电脑处理` : `${label}权限请求已在电脑上取消`,
      '',
      3200,
    )
  } else if (resolved.source === 'desktop') {
    showToast(`${label}权限请求已在电脑上回答`, '', 2400)
  }
}

/** 下载（file/*）帧：优先用 file/meta 的 downloadPath 走 HTTP，其次拼分块。 */
function handleFileFrame(frame) {
  if (frame.t === SERVER_FRAME.FILE_ERROR) {
    showToast(String(frame.message ?? '文件下载失败'), 'error')
    state.download = undefined
    return
  }
  if (frame.t === SERVER_FRAME.FILE_META) {
    const fileId = String(frame.fileId ?? '')
    const origin = connectionOrigin()
    const downloadPath = typeof frame.downloadPath === 'string' ? frame.downloadPath : ''
    if (fileId) {
      const existing = state.model.files.get(fileId)
      if (existing) {
        existing.url = downloadPath ? `${origin}${downloadPath}` : existing.url
        existing.size = Number.isFinite(Number(frame.size)) ? Number(frame.size) : existing.size
        existing.name = String(frame.name ?? existing.name)
        existing.mime = String(frame.mime ?? existing.mime)
      }
    }
    if (downloadPath) {
      const url = `${origin}${downloadPath}`
      state.download = undefined
      openDownload(url, frame.name)
      return
    }
    state.download = {
      fileId,
      name: String(frame.name ?? '文件'),
      mime: String(frame.mime ?? ''),
      size: Number(frame.size) || 0,
      chunks: [],
      received: 0,
    }
    showToast('正在下载…', '', 1600)
    return
  }
  if (frame.t === SERVER_FRAME.FILE_CHUNK) {
    if (!state.download || frame.fileId !== state.download.fileId) return
    try {
      const bytes = Uint8Array.from(atob(String(frame.dataBase64 ?? '')), char => char.charCodeAt(0))
      state.download.chunks.push(bytes)
      state.download.received += bytes.length
      if (state.download.received > 32 * 1024 * 1024) {
        showToast('文件超过 32 MB，网页版暂不支持分块下载，请在电脑上打开', 'error', 5000)
        state.download = undefined
      }
    } catch {
      showToast('文件分块解码失败', 'error')
      state.download = undefined
    }
    return
  }
  if (frame.t === SERVER_FRAME.FILE_END) {
    const download = state.download
    state.download = undefined
    if (!download) return
    const blob = new Blob(download.chunks, { type: download.mime || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    openDownload(url, download.name)
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/** 当前连接的 origin（用于拼相对下载 URL）。 */
function connectionOrigin() {
  const url = state.connection?.connectedUrl ?? state.endpoints[0]?.url ?? ''
  return baseOrigin(url) ?? ''
}

/** @param {string} url @param {string} [name] */
function openDownload(url, name) {
  const anchor = document.createElement('a')
  anchor.href = url
  if (name) anchor.download = name
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** @param {string} fileId */
function downloadFile(fileId) {
  const meta = state.model?.files.get(fileId)
  const url = meta?.url ? absoluteUrl(meta.url) : ''
  if (url) {
    openDownload(url, meta?.name)
    return
  }
  if (!state.connection?.online) {
    showToast('还没连上电脑，无法下载', 'error')
    return
  }
  state.connection.send({ t: CLIENT_FRAME.FILE_FETCH, rid: uid('file'), fileId })
  showToast('正在向电脑请求文件…', '', 2000)
}

/** @param {string} url */
function absoluteUrl(url) {
  try {
    return new URL(url, connectionOrigin() || window.location.href).href
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// 发送 / 附件上传 / 离线队列
// ---------------------------------------------------------------------------

function autosizeInput() {
  dom.composerInput.style.height = 'auto'
  dom.composerInput.style.height = `${Math.min(dom.composerInput.scrollHeight, 132)}px`
}

/** 附件选择器内容加入待发区。 */
function addFiles(fileList) {
  if (!fileList || fileList.length === 0) return
  for (const file of fileList) {
    if (state.attachments.length >= MAX_UPLOAD_ATTACHMENTS) {
      showToast(`一条消息最多 ${MAX_UPLOAD_ATTACHMENTS} 个附件`, 'error')
      break
    }
    const transportInfo = chooseTransport(file.size)
    if (transportInfo.transport === UPLOAD_TRANSPORT.REJECTED) {
      showToast(`${file.name}：${transportInfo.reason}`, 'error', 4200)
      continue
    }
    if (transportInfo.transport === UPLOAD_TRANSPORT.CHUNKED && !state.serverCaps.has(CAPABILITIES.UPLOAD)) {
      showToast(`${file.name} 超过 2 MB，电脑端版本不支持分块上传；请升级电脑端或先压缩`, 'error', 5200)
      continue
    }
    state.attachments.push({
      id: uid('att'),
      file,
      name: String(file.name ?? '附件'),
      size: Number(file.size) || 0,
      mime: String(file.type ?? ''),
      transport: transportInfo.transport,
    })
  }
  renderAttachmentsTray()
  renderComposerState()
}

function renderAttachmentsTray() {
  if (state.attachments.length === 0) {
    dom.attachmentTray.hidden = true
    dom.attachmentTray.innerHTML = ''
    return
  }
  dom.attachmentTray.hidden = false
  dom.attachmentTray.innerHTML = state.attachments
    .map(
      attachment => `<span class="tray-chip">
        <span class="tray-name">${escapeHtml(attachment.name)}</span>
        <span class="tray-size">${escapeHtml(formatBytes(attachment.size))}</span>
        <button class="tray-remove" type="button" data-action="remove-attachment" data-id="${escapeHtml(attachment.id)}" aria-label="移除 ${escapeHtml(attachment.name)}">×</button>
      </span>`,
    )
    .join('')
}

/** @param {string} label @param {{percent: number, received: number, size: number}} progress */
function showUploadProgress(label, progress) {
  dom.uploadProgress.hidden = false
  dom.uploadProgressText.textContent = `${label} · ${progress.percent}%（${formatBytes(progress.received)} / ${formatBytes(progress.size)}）`
  dom.uploadProgressFill.style.width = `${progress.percent}%`
  dom.uploadProgressBar.setAttribute('aria-valuenow', String(progress.percent))
}

function hideUploadProgress() {
  dom.uploadProgress.hidden = true
  dom.uploadProgressFill.style.width = '0%'
}

/**
 * 分块上传一个附件。
 * @param {any} attachment
 * @returns {Promise<{uploadId?: string, fileId?: string, name?: string, size?: number, mime?: string} | undefined>}
 */
function uploadAttachment(attachment) {
  return new Promise(resolve => {
    const uploader = new AttachmentUploader({
      send: frame => Boolean(state.connection?.send(frame)),
      readSlice: createBlobSliceReader(attachment.file),
      chunkBytes: UPLOAD_CHUNK_BYTES,
      onProgress: progress => showUploadProgress(attachment.name, progress),
      onDone: info => {
        state.uploader = undefined
        hideUploadProgress()
        resolve({
          uploadId: uploader.uploadId,
          fileId: info.fileId,
          name: attachment.name,
          size: attachment.size,
          mime: attachment.mime || undefined,
        })
      },
      onError: error => {
        state.uploader = undefined
        hideUploadProgress()
        showToast(`${attachment.name} 上传失败：${error.message}`, 'error', 5000)
        resolve(undefined)
      },
    })
    state.uploader = uploader
    const started = uploader.start({ name: attachment.name, size: attachment.size, mime: attachment.mime })
    if (!started.ok) {
      state.uploader = undefined
      hideUploadProgress()
      showToast(started.error ?? '上传无法开始', 'error')
      resolve(undefined)
      return
    }
    showUploadProgress(attachment.name, { percent: 0, received: 0, size: attachment.size })
  })
}

/**
 * 消息能不能现在发：必须在线，而且「消息发往哪个会话」的切换已经生效。
 * 点标签会同时发 session/select；在它回来之前发消息会被电脑端投到旧会话里。
 * @param {string} sessionId
 */
function canSendTo(sessionId) {
  if (!state.connection?.online) return false
  const active = state.model?.activeSessionId ?? ''
  if (active === '' || sessionId === '' || sessionId !== active) return false
  // 绑定切换（含新建）还没确认前一律不发：宁可多等一次 selected，也不能投错会话。
  if (state.pendingSelect) return false
  return true
}

/** @param {object} frame @param {string} sessionId */
function queueOutbox(frame, sessionId) {
  const entry = {
    msgId: String(frame.msgId),
    text: String(frame.text ?? ''),
    at: new Date().toISOString(),
    sessionId: String(sessionId ?? ''),
    frame,
  }
  // 同一 msgId 只留一份（重试不应翻倍）。
  state.outbox = state.outbox.filter(item => item.msgId !== entry.msgId)
  state.outbox.push(entry)
  storage.saveOutbox(
    state.identity?.deviceId ?? '',
    state.outbox.map(item => ({ msgId: item.msgId, text: item.text, at: item.at, sessionId: item.sessionId })),
  )
}

function flushOutbox() {
  if (!state.connection?.online || state.outbox.length === 0) return
  // 把队列里的消息都送一遍（服务端按 (deviceId, msgId) 幂等，重复发送安全），
  // 但**不**在发送后清空：只有收到 chat/ack 才从队列删除，否则「发出去但 ack 丢了」
  // 会在刷新/重连后变成永远「发送中」的孤儿消息。
  // 只发当前标签的消息：别的标签的排队消息等切回去再发，绝不能投到错的会话里。
  const active = state.model?.activeSessionId ?? ''
  for (const entry of state.outbox) {
    const target = entry.sessionId || active
    if (!canSendTo(target)) continue
    const frame = entry.frame ?? {
      t: CLIENT_FRAME.CHAT,
      rid: entry.msgId,
      msgId: entry.msgId,
      callId: entry.msgId,
      text: entry.text,
    }
    if (state.connection.send(frame)) state.model.resetUserMessageForRetry(entry.msgId)
  }
  renderMessages({ forceScroll: true })
}

async function sendComposer() {
  if (state.sending) return
  if (!state.model?.activeSessionId) {
    showToast('还没有打开的会话：先在「全部会话」里打开一个，或新建一个', 'error', 4200)
    return
  }
  const text = dom.composerInput.value.trim()
  const attachments = state.attachments.slice()
  if (text === '' && attachments.length === 0) return
  if (attachments.length > MAX_UPLOAD_ATTACHMENTS) {
    showToast(`一条消息最多 ${MAX_UPLOAD_ATTACHMENTS} 个附件`, 'error')
    return
  }

  // 生成中（或上一条排队项正在发出）：先排到输入框上方的本地队列，
  // 用户可以编辑 / 删除 / 插队发送；本轮结束后自动按序发出。
  if (state.model.activeCallId || state.flushing) {
    state.queue.push({ id: uid('q'), text, attachments })
    dom.composerInput.value = ''
    autosizeInput()
    state.attachments = []
    renderAttachmentsTray()
    renderComposerState()
    showToast('已加入排队，当前回复结束后自动发送', '', 2200)
    return
  }
  await deliverMessage(text, attachments)
}

/**
 * 真正把一条消息发出去（上传附件 → 本地乐观消息 → outbox → chat/send）。
 * @param {string} text
 * @param {any[]} attachments
 */
async function deliverMessage(text, attachments) {
  state.sending = true
  renderComposerState()
  try {
    /** @type {any[]} */
    const files = []
    for (const attachment of attachments) {
      if (attachment.transport === UPLOAD_TRANSPORT.INLINE) {
        try {
          const dataBase64 = await readBlobAsBase64(attachment.file)
          files.push({
            name: attachment.name,
            size: attachment.size,
            mime: attachment.mime || undefined,
            dataBase64,
          })
        } catch {
          showToast(`${attachment.name} 读取失败`, 'error')
          return
        }
      } else {
        const uploaded = await uploadAttachment(attachment)
        if (!uploaded) return
        files.push(uploaded)
      }
    }

    const msgId = uid('m')
    const targetSessionId = state.model.activeSessionId
    state.model.addLocalUserMessage(
      {
        msgId,
        text,
        files: files.map(file => ({ name: file.name, size: file.size, mime: file.mime, uploadId: file.uploadId })),
      },
      targetSessionId,
    )
    /** @type {any} */
    const frame = {
      t: CLIENT_FRAME.CHAT,
      rid: msgId,
      msgId,
      callId: msgId,
      text,
    }
    if (files.length > 0) frame.files = files

    // 先入离线队列再发送：ack 丢失或页面被刷新时，重连后会带着同一个 msgId 重发，
    // 电脑端按幂等键去重，不会出现第二条消息。消息绑定它所属的标签：切到别的标签后
    // 不会再被发到错的会话里。
    queueOutbox(frame, targetSessionId)
    if (canSendTo(targetSessionId)) state.connection.send(frame)
    else if (state.pendingSelect) showToast('正在切换会话，消息会在切换完成后发出', '', 2600)

    dom.composerInput.value = ''
    autosizeInput()
    state.attachments = []
    renderAttachmentsTray()
    renderMessages({ forceScroll: true })
    renderComposerState()
    persistSoon(300)
  } finally {
    state.sending = false
    renderComposerState()
  }
}

/** 输入框上方的排队区：文本预览 + 插队发送 / 编辑 / 删除。 */
function renderQueue() {
  if (!dom.messageQueue) return
  const list = state.queue
  dom.messageQueue.hidden = list.length === 0
  if (list.length === 0) {
    dom.messageQueue.innerHTML = ''
    return
  }
  dom.messageQueue.innerHTML = list
    .map(entry => {
      const preview = entry.text !== '' ? entry.text : '（仅附件）'
      const meta = entry.attachments.length > 0 ? `${entry.attachments.length} 个附件` : ''
      return `<div class="queue-item" data-queue-id="${escapeHtml(entry.id)}">
        <span class="queue-text" title="${escapeHtml(preview)}">${escapeHtml(preview)}</span>
        ${meta ? `<span class="queue-meta">${escapeHtml(meta)}</span>` : ''}
        <span class="queue-actions">
          <button class="queue-btn" type="button" data-action="queue-send" data-queue-id="${escapeHtml(entry.id)}">插队发送</button>
          <button class="queue-btn" type="button" data-action="queue-edit" data-queue-id="${escapeHtml(entry.id)}">编辑</button>
          <button class="queue-btn danger" type="button" data-action="queue-delete" data-queue-id="${escapeHtml(entry.id)}">删除</button>
        </span>
      </div>`
    })
    .join('')
}

/** 本轮结束：把队首那条发出去（一次一条，避免把多条同时塞给电脑端）。 */
function flushQueue() {
  if (state.flushing) return
  if (state.queue.length === 0) return
  if (state.model?.activeCallId) return
  if (!state.connection?.online) return
  const entry = state.queue.shift()
  state.flushing = true
  renderQueue()
  deliverMessage(entry.text, entry.attachments)
    .catch(() => {
      // 发送失败：放回队首，等下一次机会（网络恢复/下一轮结束）。
      state.queue.unshift(entry)
    })
    .finally(() => {
      state.flushing = false
      renderComposerState()
    })
}

/** @param {string} id */
function queueEntryById(id) {
  return state.queue.find(entry => entry.id === id)
}

/** @param {string} id 插队发送：立刻发这条（电脑端会把它排在当前回合之后）。 */
function sendQueuedNow(id) {
  const index = state.queue.findIndex(entry => entry.id === id)
  if (index < 0) return
  const [entry] = state.queue.splice(index, 1)
  deliverMessage(entry.text, entry.attachments).catch(error => {
    state.queue.splice(index, 0, entry)
    renderQueue()
    showToast(`发送失败：${(error && error.message) || error}`, 'error', 3600)
  }).finally(() => renderComposerState())
}

/** @param {string} id 编辑：拿回输入框（附件也一并拿回），从队列移除。 */
function editQueued(id) {
  const index = state.queue.findIndex(entry => entry.id === id)
  if (index < 0) return
  const [entry] = state.queue.splice(index, 1)
  const existing = dom.composerInput.value.trim()
  dom.composerInput.value = existing !== '' && entry.text !== '' ? `${existing}\n${entry.text}` : existing || entry.text
  if (entry.attachments.length > 0) state.attachments.push(...entry.attachments)
  autosizeInput()
  renderAttachmentsTray()
  renderComposerState()
  dom.composerInput.focus()
}

/** @param {string} id 删除：直接丢掉这条排队消息。 */
function deleteQueued(id) {
  const index = state.queue.findIndex(entry => entry.id === id)
  if (index < 0) return
  state.queue.splice(index, 1)
  renderComposerState()
}

/** @param {string} msgId */
function retryMessage(msgId) {
  const found = state.model?.findUserMessage(msgId)
  if (!found) return
  const { sessionId, message } = found
  state.model.resetUserMessageForRetry(msgId)
  // 消息属于别的标签：先切过去，避免把内容发到当前会话。
  if (sessionId !== state.model.activeSessionId) switchTab(sessionId)
  const frame = {
    t: CLIENT_FRAME.CHAT,
    rid: msgId,
    msgId,
    callId: msgId,
    text: String(message.text ?? ''),
  }
  queueOutbox(frame, sessionId)
  const sent = canSendTo(sessionId) && Boolean(state.connection.send(frame))
  renderMessages({ forceScroll: true })
  if (!sent) showToast('当前离线：消息已排队，连上后自动发送', '', 2600)
}

function stopGeneration() {
  const callId = state.model?.activeCallId
  if (!callId) return
  state.connection?.send({ t: CLIENT_FRAME.CHAT_CANCEL, rid: uid('cancel'), callId })
  showToast('已请求停止生成', '', 1800)
}

// ---------------------------------------------------------------------------
// 聊天页渲染
// ---------------------------------------------------------------------------

function renderHeader() {
  dom.computerName.textContent = state.computerName || '电脑'
  const status = state.status ?? { state: CONNECTION_STATE.IDLE }
  dom.statusDot.className = 'status-dot'
  let detail = '未连接'
  if (status.state === CONNECTION_STATE.ONLINE) {
    dom.statusDot.classList.add('is-online')
    const kind = ENDPOINT_KIND_LABEL[state.connection?.connectedKind] ?? ''
    detail = [kind, connectionOrigin()].filter(Boolean).join(' · ')
  } else if (status.state === CONNECTION_STATE.CONNECTING) {
    dom.statusDot.classList.add('is-connecting')
    detail = '正在连接…'
  } else if (status.state === CONNECTION_STATE.RECONNECTING) {
    dom.statusDot.classList.add('is-connecting')
    detail = status.attempt > 0 ? `重连中（第 ${status.attempt} 次）…` : '正在重连…'
  } else if (status.state === CONNECTION_STATE.REJECTED) {
    dom.statusDot.classList.add('is-error')
    detail = '连接被拒绝'
  } else if (status.state === CONNECTION_STATE.STOPPED) {
    dom.statusDot.classList.add('is-warn')
    detail = '已断开'
  }
  dom.connectionDetail.textContent = detail
  renderTabs()
}

function renderStatusBanner() {
  const status = state.status ?? { state: CONNECTION_STATE.IDLE }
  const candidates = computeCandidates()
  const offline = status.state !== CONNECTION_STATE.ONLINE
  if (!offline) {
    dom.statusBanner.hidden = true
    dom.statusBanner.innerHTML = ''
    return
  }
  let text = describeStatus(status).detail
  if (candidates.length === 0) text = emptyModeHint()
  if (status.noEndpoints) text = emptyModeHint()
  dom.statusBanner.hidden = false
  dom.statusBanner.classList.toggle('is-error', status.state === CONNECTION_STATE.REJECTED)
  dom.statusBannerText.textContent = text
  const actions = []
  actions.push('<button class="banner-btn" type="button" data-action="reconnect">重试</button>')
  actions.push('<button class="banner-btn" type="button" data-action="open-settings">设置</button>')
  if (status.state === CONNECTION_STATE.REJECTED) {
    actions.push('<button class="banner-btn" type="button" data-action="rebind">重新扫码</button>')
  }
  dom.statusBannerActions.innerHTML = actions.join('')
}

function messageSignature() {
  if (!state.model) return ''
  // 换标签时必须整页换掉消息，所以 activeSessionId 进签名。
  let hash = state.model.activeSessionId.length + 7
  hash = (hash * 31 + state.model.messages.length) % 1_000_000_007
  for (const message of state.model.messages) {
    hash = (hash * 31 + message.id.length + (message.text?.length ?? 0) + (message.status?.length ?? 0)) % 1_000_000_007
    if (message.tools?.length) hash = (hash * 31 + message.tools.length) % 1_000_000_007
  }
  hash = (hash * 31 + state.model.typing.size) % 1_000_000_007
  // 审批卡片与当前会话标题也在同一份 DOM 里，必须进入签名，否则状态变化不会重绘。
  hash = (hash * 31 + state.model.approvals.length) % 1_000_000_007
  for (const approval of state.model.approvals) {
    hash = (hash * 31 + approval.approvalId.length + (approval.replied ? 7 : 3)) % 1_000_000_007
  }
  // 提问卡片同理：批次、题目数量、是否已提交都影响渲染。
  hash = (hash * 31 + state.model.questions.length) % 1_000_000_007
  for (const question of state.model.questions) {
    hash = (hash * 31 + question.questionId.length + question.items.length + (question.replied ? 7 : 3)) % 1_000_000_007
  }
  hash = (hash * 31 + state.model.sessionTitle.length) % 1_000_000_007
  return String(hash)
}

let renderQueued = false
let forceScrollQueued = false

function scheduleRender({ forceScroll = false } = {}) {
  if (forceScroll) forceScrollQueued = true
  if (renderQueued) return
  renderQueued = true
  window.requestAnimationFrame(() => {
    renderQueued = false
    const force = forceScrollQueued
    forceScrollQueued = false
    renderMessages({ forceScroll: force })
    renderHeader()
    renderTabs()
    renderComposerState()
  })
}

function renderMessages({ forceScroll = false } = {}) {
  if (!state.model) return
  const signature = messageSignature()
  if (!forceScroll && signature === state.lastRenderSignature) {
    maybeScrollToLatest(forceScroll)
    return
  }
  state.lastRenderSignature = signature
  const messages = state.model.messages
  const approvals = approvalCardsHtml()
  const questions = questionCardsHtml()
  if (messages.length === 0) {
    dom.messageList.innerHTML = `${questions}${approvals}${emptyStateHtml()}`
    updateApprovalCountdowns()
    syncApprovalTicker()
    maybeScrollToLatest(true)
    return
  }
  const parts = []
  let previous = undefined
  for (const message of messages) {
    const gap = previous ? new Date(message.at).getTime() - new Date(previous.at).getTime() : Number.POSITIVE_INFINITY
    if (!previous || gap > 10 * 60 * 1000) {
      parts.push(`<div class="time-sep">${escapeHtml(daySeparatorText(message.at))}</div>`)
    }
    const isFirst = !previous || previous.kind !== message.kind || gap > 5 * 60 * 1000
    const html = messageHtml(message, isFirst)
    if (html) parts.push(html)
    previous = message
  }
  if (state.model.isTyping) {
    const active = state.model.activeCallId
    const activeMessage = active ? state.model.byId.get(`msg_${active}`) : undefined
    if (!activeMessage || !activeMessage.text) {
      parts.push('<div class="typing-row" aria-label="助理正在输入"><span></span><span></span><span></span></div>')
    }
  }
  dom.messageList.innerHTML = `${parts.join('')}${questions}${approvals}`
  updateApprovalCountdowns()
  syncApprovalTicker()
  maybeScrollToLatest(forceScroll)
}

function emptyStateHtml() {
  const online = state.status?.state === CONNECTION_STATE.ONLINE
  const title = online ? `${escapeHtml(state.computerName || '电脑')} 已就绪` : '正在连接电脑…'
  const body = online
    ? '发一条消息试试。电脑也可以把文件推到这个会话里；消息只在你的电脑和这台设备之间传输。'
    : '第一次连接需要几秒。如果一直连不上，检查手机和电脑的网络，或在设置里换一种连接方式。'
  return `<div class="empty-state">
    <svg class="empty-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M7 30c5 0 5-6 10-6s5 6 10 6 5-6 10-6 2 3 4 4" />
        <path d="M7 22c5 0 5-6 10-6s5 6 10 6 5-6 10-6 2 3 4 4" opacity=".5" />
      </g>
      <circle cx="36" cy="13" r="3" fill="currentColor" />
    </svg>
    <h2>${title}</h2>
    <p>${escapeHtml(body)}</p>
  </div>`
}

/**
 * @param {any} message
 * @param {boolean} isFirst
 */
function messageHtml(message, isFirst) {
  if (message.kind === 'file') return fileMessageHtml(message)
  if (message.kind === 'assistant' && !message.text && (!message.tools || message.tools.length === 0)) return ''
  const classes = ['msg', message.kind === 'user' ? 'is-user' : 'is-assistant']
  if (isFirst) classes.push('is-first')
  const tools = message.kind === 'assistant' ? toolRowsHtml(message.tools) : ''
  const bubbleClasses = ['bubble']
  if (message.status === MESSAGE_STATUS.ERROR) bubbleClasses.push('is-error')
  const text = message.text ? renderRichText(message.text) : ''
  const cursor =
    message.kind === 'assistant' && message.status === MESSAGE_STATUS.STREAMING && message.text
      ? '<span class="stream-cursor" aria-hidden="true"></span>'
      : ''
  const attachments = attachmentChipsHtml(message.files)
  const foot = messageFootHtml(message)
  return `<div class="${classes.join(' ')}">
    <div class="${bubbleClasses.join(' ')}">
      ${tools}
      <div class="bubble-text">${text}${cursor}</div>
      ${attachments}
    </div>
    ${foot}
  </div>`
}

/** @param {any[]} tools */
function toolRowsHtml(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const rows = tools
    .map(tool => {
      const done = tool.phase === 'tool-end'
      const failed = done && tool.ok === false
      const classes = ['tool-row']
      if (done) classes.push(failed ? 'is-fail' : 'is-done')
      const summary = tool.summary ?? (done ? (failed ? '失败' : '完成') : '进行中')
      return `<div class="${classes.join(' ')}"><span class="tool-dot"></span><span class="tool-name">${escapeHtml(tool.tool)}</span><span class="tool-summary">${escapeHtml(summary)}</span></div>`
    })
    .join('')
  return `<div class="tool-rows">${rows}</div>`
}

/** @param {any[]} files */
function attachmentChipsHtml(files) {
  const list = normalizeAttachments(files)
  if (list.length === 0) return ''
  return `<div class="attachment-chips">${list
    .map(
      file =>
        `<span class="chip"><span class="chip-name">${escapeHtml(file.name)}</span><span class="chip-size">${escapeHtml(formatBytes(file.size))}</span></span>`,
    )
    .join('')}</div>`
}

/** @param {any} message */
function messageFootHtml(message) {
  if (message.kind === 'user') {
    if (message.status === MESSAGE_STATUS.PENDING) return '<div class="msg-foot"><span class="pending">发送中…</span></div>'
    if (message.status === MESSAGE_STATUS.ERROR) {
      return `<div class="msg-foot"><span>发送失败</span><button class="retry-btn" type="button" data-action="retry" data-msg-id="${escapeHtml(message.msgId)}">重试</button></div>`
    }
    return ''
  }
  if (message.kind === 'assistant') {
    if (message.truncated) return '<div class="msg-foot"><span>内容过长，已截断</span></div>'
    if (message.status === MESSAGE_STATUS.ERROR && message.error) {
      // 没有正文时错误已经显示在气泡里，不要重复一遍；有部分正文时脚注保留原因。
      if (!message.text || message.text === message.error) return ''
      return `<div class="msg-foot"><span>${escapeHtml(message.error)}</span></div>`
    }
  }
  return ''
}

/** @param {any} message */
function fileMessageHtml(message) {
  const file = message.file ?? {}
  const name = String(file.name ?? message.text ?? '文件')
  const meta = [formatBytes(file.size), file.mime ? shortMime(file.mime) : '', file.from ? `来自 ${file.from}` : '']
    .filter(Boolean)
    .join(' · ')
  return `<div class="msg is-file is-first">
    <div class="file-card">
      <div class="file-ico">${escapeHtml(fileExtension(name))}</div>
      <div class="file-body">
        <p class="file-name">${escapeHtml(name)}</p>
        <p class="file-meta">${escapeHtml(meta)}</p>
      </div>
      <button class="file-download" type="button" data-action="download-file" data-file-id="${escapeHtml(file.fileId ?? '')}">下载</button>
    </div>
  </div>`
}

/** @param {string} mime */
function shortMime(mime) {
  const value = String(mime ?? '')
  if (value.startsWith('image/')) return '图片'
  if (value.startsWith('video/')) return '视频'
  if (value.startsWith('audio/')) return '音频'
  if (value === 'application/pdf') return 'PDF'
  return value.split('/').pop() ?? value
}

// 滚动 -----------------------------------------------------------------

let nearBottom = true

function maybeScrollToLatest(force) {
  if (force) {
    dom.messageArea.scrollTop = dom.messageArea.scrollHeight
    nearBottom = true
    dom.jumpLatest.hidden = true
    return
  }
  if (nearBottom) dom.messageArea.scrollTop = dom.messageArea.scrollHeight
  dom.jumpLatest.hidden = nearBottom
}

function setupScrollTracking() {
  dom.messageArea.addEventListener(
    'scroll',
    () => {
      const area = dom.messageArea
      nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 90
      dom.jumpLatest.hidden = nearBottom
    },
    { passive: true },
  )
  dom.jumpLatest.addEventListener('click', () => {
    dom.messageArea.scrollTo({ top: dom.messageArea.scrollHeight, behavior: 'smooth' })
    nearBottom = true
    dom.jumpLatest.hidden = true
  })
}

// 输入区状态 -----------------------------------------------------------

/** 同步审批提醒横幅：有多少条待答请求，就显示多少条。 */
function renderApprovalBanner() {
  if (!dom.approvalBanner) return
  const count = state.model?.approvals?.length ?? 0
  dom.approvalBanner.hidden = count === 0
  if (count === 0) return
  const first = state.model.approvals[0]
  const tool = first?.toolName ? `（${first.toolName}）` : ''
  dom.approvalBannerText.textContent = count === 1 ? `电脑在请求权限${tool}，请处理` : `有 ${count} 条权限请求待处理`
  // 横幅出现时震动一下：手机放桌上/在别的应用里回来更容易注意到。
  try {
    if (navigator.vibrate) navigator.vibrate([120, 60, 120])
  } catch {}
}

function renderComposerState() {
  renderQueue()
  renderApprovalBanner()
  const hasText = dom.composerInput.value.trim() !== ''
  const hasAttachments = state.attachments.length > 0
  const streaming = Boolean(state.model?.activeCallId)
  const hasSession = Boolean(state.model?.activeSessionId)
  // 用户要求：输入框有内容时右侧永远是「发送」（生成中则排队发送）；
  // 只有输入框为空且正在生成时，右侧才是「停止」。
  const action = composerAction({ streaming, hasText, hasAttachments, hasSession, sending: state.sending })
  dom.sendBtn.hidden = action.showStop
  dom.stopBtn.hidden = !action.showStop
  dom.sendBtn.disabled = action.sendDisabled
  if (!hasSession) {
    dom.composerHint.textContent = '还没有打开的会话：用标签条末端的「+」新建，或在「全部会话」里打开一个'
  } else if (state.uploader) {
    dom.composerHint.textContent = '正在上传附件…'
  } else if (state.pendingSelect) {
    dom.composerHint.textContent = '正在切换会话：消息会先排队，切换完成后自动发送'
  } else if (!state.connection?.online) {
    dom.composerHint.textContent = '当前离线：消息会先排队，连上后自动发送'
  } else {
    dom.composerHint.textContent = '消息只在你的电脑和这台设备之间传输'
  }
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

function openSettings() {
  state.settingsOpen = true
  if (state.sessionSheetOpen) closeSessionSheet()
  renderSettings()
  dom.settingsSheet.hidden = false
  syncSheetBackdrop()
}

function closeSettings() {
  state.settingsOpen = false
  dom.settingsSheet.hidden = true
  syncSheetBackdrop()
}

function renderSettings() {
  if (!state.settingsOpen) return
  const candidates = computeCandidates()
  const mode = state.settings.mode
  const modeButtons = [
    [CONNECTION_MODE.AUTO, '自动'],
    [CONNECTION_MODE.LAN, '局域网'],
    [CONNECTION_MODE.TAILSCALE, 'Tailscale'],
    [CONNECTION_MODE.TUNNEL, '公网隧道'],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-mode="${value}" aria-pressed="${mode === value ? 'true' : 'false'}">${label}</button>`,
    )
    .join('')
  const endpointItems =
    candidates.length === 0
      ? `<li class="endpoint-item">${escapeHtml(emptyModeHint())}</li>`
      : candidates
          .map(item => {
            const used = state.connection?.connectedUrl === item.url
            return `<li class="endpoint-item${used ? ' is-used' : ''}"><span class="endpoint-kind">${escapeHtml(ENDPOINT_KIND_LABEL[item.kind] ?? '其他')}</span><span class="endpoint-url">${escapeHtml(item.url)}</span>${used ? '<span>使用中</span>' : ''}</li>`
          })
          .join('')
  const themeButtons = [
    ['auto', '跟随系统'],
    ['light', '浅色'],
    ['dark', '深色'],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-theme-choice="${value}" aria-pressed="${state.settings.theme === value ? 'true' : 'false'}">${label}</button>`,
    )
    .join('')
  const binding = state.binding
  const openTabs = state.model?.tabs.length ?? 0
  const sessionsNote = !sessionsSupported()
    ? '电脑端版本较旧，暂不支持在网页里切换会话。'
    : tabsSupported()
      ? `已打开 ${openTabs} / ${TAB_LIMIT} 个标签：切走的会话继续在后台跑，标签上会显示运行点与未读数。`
      : '电脑端版本较旧，切换会话会替换当前页面的内容（没有后台标签）。'
  dom.settingsSheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <h2>设置</h2>

    <section class="sheet-section">
      <h3 class="sheet-section-title">会话标签</h3>
      <div class="sheet-row">
        <span class="sheet-row-label">${escapeHtml(state.model?.titleFor(state.model?.activeSessionId) || '未选择')}</span>
        <button class="btn btn-secondary btn-sm" type="button" data-action="open-sessions" ${sessionsSupported() ? '' : 'disabled'}>全部会话</button>
      </div>
      <p class="sheet-row-note">${escapeHtml(sessionsNote)}</p>
    </section>

    <section class="sheet-section">
      <h3 class="sheet-section-title">连接</h3>
      <div class="segmented" role="group" aria-label="连接方式">${modeButtons}</div>
      <p class="sheet-row-note">自动顺序：上次成功 → Tailscale → 局域网 → 公网隧道。Tailscale 现在不再被当成局域网。</p>
      <ul class="endpoint-list">${endpointItems}</ul>
      <div class="settings-input-row">
        <input class="input" id="manual-endpoint" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="手动地址，例如 192.168.1.5:8787" />
        <button class="btn btn-secondary" type="button" data-action="add-endpoint">添加</button>
      </div>
      <div class="settings-input-row">
        <button class="btn btn-secondary" type="button" data-action="reconnect">重新连接</button>
        <button class="btn btn-ghost" type="button" data-action="health-check">测试地址</button>
      </div>
      <p class="sheet-row-note" id="settings-feedback" aria-live="polite"></p>
    </section>

    <section class="sheet-section">
      <h3 class="sheet-section-title">设备</h3>
      <div class="settings-input-row">
        <input class="input" id="device-name-input" maxlength="24" value="${escapeHtml(normalizeDeviceName(state.settings.deviceName) || '')}" placeholder="${escapeHtml(currentDeviceName())}" />
        <button class="btn btn-secondary" type="button" data-action="save-name">保存名称</button>
      </div>
      <p class="sheet-row-note">这个名字只用于电脑端的设备列表，不会出现在聊天消息里。</p>
    </section>

    <section class="sheet-section">
      <h3 class="sheet-section-title">外观</h3>
      <div class="segmented" role="group" aria-label="外观">${themeButtons}</div>
    </section>

    <section class="sheet-section">
      <h3 class="sheet-section-title">关于</h3>
      <div class="about-grid">
        <div class="about-row"><span>网页版版本</span><span>${escapeHtml(APP_VERSION)}</span></div>
        <div class="about-row"><span>协议版本</span><span>${escapeHtml(PROTOCOL_VERSION)}</span></div>
        <div class="about-row"><span>电脑</span><span>${escapeHtml(state.computerName || '未知')}</span></div>
        <div class="about-row"><span>电脑指纹</span><span>${escapeHtml(formatFingerprint(binding?.fingerprint ?? ''))}</span></div>
        <div class="about-row"><span>本机身份</span><span>${escapeHtml(state.identity?.deviceId ?? '')}</span></div>
        <div class="about-row"><span>身份校验</span><span>${state.verified ? '已通过' : '未验证（老电脑端或二维码缺少公钥）'}</span></div>
        <div class="about-row"><span>绑定时间</span><span>${escapeHtml(binding?.pairedAt ?? '')}</span></div>
        <div class="about-row"><span>连接地址</span><span>${escapeHtml(state.connection?.connectedUrl ?? '未连接')}</span></div>
        <div class="about-row"><span>存储</span><span>${storage.available ? '本机浏览器' : '仅本页内存'}</span></div>
      </div>
      <div class="sheet-footer">
        <button class="btn btn-secondary btn-block" type="button" data-action="install">添加到主屏幕</button>
        <button class="btn btn-ghost btn-block" type="button" data-action="clear-conversation">清空本机聊天记录</button>
        <button class="btn btn-danger btn-block" type="button" data-action="unbind">解除绑定</button>
        <p class="sheet-hint">网页版把设备私钥保存在这个浏览器的 localStorage 里：不要在公共电脑上绑定。解除绑定会同时让电脑端忘记这台设备。</p>
      </div>
    </section>
  `
}

/** 设置面板里的一次性反馈行。 */
function settingsFeedback(text, kind = '') {
  const node = document.getElementById('settings-feedback')
  if (!node) return
  node.textContent = text
  node.style.color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? 'var(--song)' : ''
}

function changeConnectionMode(mode, { reconnect = true } = {}) {
  state.settings = storage.saveSettings({ mode })
  if (state.connection) state.connection.setCandidates(computeCandidates())
  renderSettings()
  renderStatusBanner()
  if (reconnect && state.connection) {
    const candidates = computeCandidates()
    if (candidates.length === 0) {
      showToast(emptyModeHint(), 'error', 5000)
      return
    }
    state.connection.reconnect()
  }
}

async function addManualEndpoint(input, { reconnect = true } = {}) {
  const normalized = normalizeManualEndpoint(input)
  if (!normalized.ok) {
    settingsFeedback(normalized.error, 'error')
    return
  }
  const manual = [...state.settings.manualEndpoints]
  if (!manual.includes(normalized.url)) manual.push(normalized.url)
  state.settings = storage.saveSettings({ manualEndpoints: manual })
  settingsFeedback(`已添加 ${normalized.url}`, 'ok')
  renderSettings()
  if (reconnect && state.connection) {
    state.connection.setCandidates(computeCandidates())
    state.connection.reconnect()
  }
}

async function testManualEndpoint(input) {
  const normalized = normalizeManualEndpoint(input)
  if (!normalized.ok) {
    settingsFeedback(normalized.error, 'error')
    return
  }
  const url = healthUrl(normalized.url)
  settingsFeedback('正在测试连接…')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    clearTimeout(timer)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json().catch(() => ({}))
    settingsFeedback(`连接正常：${data.computerName ?? '这台电脑'}（${data.plugin ?? 'dsh-openwhale'}）`, 'ok')
  } catch (error) {
    settingsFeedback(`连不上：${/** @type {Error} */ (error).message}。检查地址、端口和网络。`, 'error')
  }
}

async function saveDeviceName(input) {
  const name = normalizeDeviceName(input)
  if (name === '') {
    settingsFeedback('昵称不能为空', 'error')
    return
  }
  state.settings = storage.saveSettings({ deviceName: name })
  if (state.identity) state.identity.deviceName = name
  if (state.binding) {
    state.binding.deviceName = name
    storage.saveBinding(state.binding)
  }
  state.connection?.send({ t: CLIENT_FRAME.DEVICE_RENAME, label: name })
  settingsFeedback('名称已保存（重连后对电脑端生效）', 'ok')
  renderSettings()
}

async function unbindDevice() {
  const ok = await confirmDialog({
    title: '解除绑定？',
    body: '这台浏览器上的聊天记录和设备身份会被清除；电脑端也会忘记这台设备。之后需要重新扫码才能连接。',
    confirmText: '解除绑定',
    danger: true,
  })
  if (!ok) return
  try {
    if (state.connection?.online && state.identity) {
      state.connection.send({ t: CLIENT_FRAME.DEVICE_FORGET, deviceId: state.identity.deviceId })
    }
  } catch {
    /* 电脑端没收到也没关系，本地照样清 */
  }
  teardownConnection()
  if (state.identity) {
    storage.clearConversation(state.identity.deviceId)
    storage.clearOutbox(state.identity.deviceId)
    storage.clearTabs(state.identity.deviceId)
  }
  storage.clearBinding()
  state.binding = undefined
  state.identity = undefined
  state.model = undefined
  state.pendingPayload = undefined
  state.pairSecret = ''
  state.serverCaps = new Set()
  state.status = { state: CONNECTION_STATE.STOPPED }
  state.sessionListLoading = false
  state.pendingSelect = null
  state.pendingSnapshots = new Map()
  state.lastRenderSignature = ''
  state.lastTabsSignature = ''
  state.lastActiveTabId = ''
  stopApprovalTicker()
  if (dom.sessionTabs) dom.sessionTabs.innerHTML = ''
  closeSettings()
  closeSessionSheet()
  showView('bind')
  resetBindUI()
  setBindStatus('已解除绑定。需要重新扫码或粘贴绑定链接。', 'ok')
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function setupComposerEvents() {
  dom.composer.addEventListener('submit', event => {
    event.preventDefault()
    sendComposer()
  })
  dom.composerInput.addEventListener('input', () => {
    autosizeInput()
    renderComposerState()
  })
  dom.composerInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    // 中文输入法组词时 Enter 是选词，不能当发送。
    event.preventDefault()
    sendComposer()
  })
  dom.attachBtn.addEventListener('click', () => dom.attachFile.click())
  dom.imageBtn.addEventListener('click', () => dom.imageFile.click())
  dom.attachFile.addEventListener('change', () => {
    addFiles(dom.attachFile.files)
    dom.attachFile.value = ''
  })
  dom.imageFile.addEventListener('change', () => {
    addFiles(dom.imageFile.files)
    dom.imageFile.value = ''
  })
  dom.stopBtn.addEventListener('click', stopGeneration)
  dom.approvalBannerJump?.addEventListener('click', () => {
    const card = dom.messageList.querySelector('.approval-card')
    if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' })
    else dom.messageArea.scrollTo({ top: 0, behavior: 'smooth' })
  })
  dom.messageQueue?.addEventListener('click', event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    const id = button.dataset.queueId ?? ''
    if (button.dataset.action === 'queue-send') sendQueuedNow(id)
    else if (button.dataset.action === 'queue-edit') editQueued(id)
    else if (button.dataset.action === 'queue-delete') deleteQueued(id)
  })
  dom.attachmentTray.addEventListener('click', event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    if (button.dataset.action === 'remove-attachment') {
      state.attachments = state.attachments.filter(attachment => attachment.id !== button.dataset.id)
      renderAttachmentsTray()
      renderComposerState()
    }
  })
}

function setupBindEvents() {
  dom.bindConnect.addEventListener('click', connectFromInput)
  dom.bindConfirm.addEventListener('click', () => {
    if (!state.pendingPayload) return
    const payload = state.pendingPayload
    startSession({ payload })
  })
  dom.bindCancel.addEventListener('click', cancelRecognizedPayload)
  dom.bindScanImage.addEventListener('click', () => dom.qrFile.click())
  dom.qrFile.addEventListener('change', async () => {
    const file = dom.qrFile.files?.[0]
    dom.qrFile.value = ''
    if (!file) return
    setBindStatus('正在识别图片里的二维码…', 'busy')
    try {
      const reader = createBrowserQrReader()
      const result = await reader.scanFile(file)
      if (!result.ok) {
        setBindStatus(result.error, 'error')
        return
      }
      setBindStatus(`已识别「${result.payload.host}」的绑定信息`, 'ok')
      beginFromPayload(result.payload)
    } catch (error) {
      setBindStatus(`图片识别失败：${/** @type {Error} */ (error).message}`, 'error')
    }
  })
  dom.bindInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) connectFromInput()
  })
}

function setupChatEvents() {
  dom.menuBtn.addEventListener('click', openSettings)
  dom.sessionTabs.addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action
    if (action === 'activate-tab') {
      switchTab(target.dataset.sessionId ?? '')
      return
    }
    if (action === 'close-tab') {
      closeTab(target.dataset.sessionId ?? '')
      return
    }
    if (action === 'new-session') {
      createSession()
      return
    }
    if (action === 'open-sessions') openSessionSheet()
  })
  dom.sheetBackdrop.addEventListener('click', () => {
    closeSettings()
    closeSessionSheet()
  })
  dom.sessionSheet.addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action
    if (action === 'open-session' || action === 'select-session') {
      openSessionTab(target.dataset.sessionId ?? '')
      return
    }
    if (action === 'open-sessions') {
      openSessionSheet()
      return
    }
    if (action === 'new-session') createSession()
  })
  dom.settingsSheet.addEventListener('click', async event => {
    const target = event.target.closest('[data-action], [data-mode], [data-theme-choice]')
    if (!target) return
    const action = target.dataset.action
    if (target.dataset.mode) {
      changeConnectionMode(target.dataset.mode)
      return
    }
    if (target.dataset.themeChoice) {
      applyTheme(target.dataset.themeChoice)
      renderSettings()
      return
    }
    switch (action) {
      case 'open-sessions':
        openSessionSheet()
        break
      case 'reconnect':
        if (state.connection) state.connection.reconnect()
        settingsFeedback('正在重新连接…')
        break
      case 'add-endpoint': {
        const input = document.getElementById('manual-endpoint')
        if (input) await addManualEndpoint(input.value)
        break
      }
      case 'health-check': {
        const input = document.getElementById('manual-endpoint')
        const value = input?.value || computeCandidates()[0]?.url || state.connection?.connectedUrl || ''
        if (value) await testManualEndpoint(value)
        break
      }
      case 'save-name': {
        const input = document.getElementById('device-name-input')
        if (input) await saveDeviceName(input.value)
        break
      }
      case 'install':
        if (state.installPrompt) {
          state.installPrompt.prompt()
          state.installPrompt = undefined
          settingsFeedback('已打开安装提示', 'ok')
        } else {
          settingsFeedback('iOS：分享 → 添加到主屏幕；鸿蒙：浏览器菜单 → 添加到桌面', 'ok')
        }
        break
      case 'clear-conversation': {
        const ok = await confirmDialog({
          title: '清空本机聊天记录？',
          body: '只清除这台浏览器上的显示记录，电脑端的会话不受影响。下次重连会重新同步最近的消息。',
          confirmText: '清空',
          danger: true,
        })
        if (ok) {
          state.model?.clearActiveConversation()
          state.lastRenderSignature = ''
          stopApprovalTicker()
          if (state.identity) storage.clearConversation(state.identity.deviceId)
          renderMessages({ forceScroll: true })
          renderTabs()
          closeSettings()
          showToast('已清空本机记录', 'ok')
        }
        break
      }
      case 'unbind':
        await unbindDevice()
        break
      default:
        break
    }
  })
  dom.statusBanner.addEventListener('click', event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    if (button.dataset.action === 'reconnect') state.connection?.reconnect()
    if (button.dataset.action === 'open-settings') openSettings()
    if (button.dataset.action === 'rebind') {
      showView('bind')
      resetBindUI()
      setBindStatus('请重新扫描电脑上的网页版二维码，或粘贴新的绑定链接。')
    }
  })
  dom.messageList.addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    if (target.dataset.action === 'copy-code') {
      const pre = target.closest('.code-block')?.querySelector('pre')
      const text = pre?.textContent ?? ''
      copyText(text, target)
      return
    }
    if (target.dataset.action === 'retry') {
      retryMessage(target.dataset.msgId ?? '')
      return
    }
    if (target.dataset.action === 'download-file') {
      downloadFile(target.dataset.fileId ?? '')
      return
    }
    if (target.dataset.action === 'approval-reply') {
      const outcome = target.dataset.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
      replyApproval(target.dataset.approvalId ?? '', outcome)
      return
    }
    if (target.dataset.action === 'question-option') {
      toggleQuestionOption(target)
      return
    }
    if (target.dataset.action === 'question-submit') {
      submitQuestion(target.dataset.questionId ?? '')
    }
  })
  // 「其他」文本框：只更新草稿和本地 DOM，不整表重绘（否则输入焦点会丢）。
  dom.messageList.addEventListener('input', event => {
    const input = event.target.closest('.question-custom')
    if (!input) return
    const questionId = input.dataset.questionId ?? ''
    const itemId = input.dataset.itemId ?? ''
    if (!questionId || !itemId) return
    const draft = draftFor(questionId)
    draft[itemId] = { ...(draft[itemId] ?? { selected: [] }), custom: input.value }
  })
  dom.installHintAction.addEventListener('click', () => {
    if (state.installPrompt) {
      state.installPrompt.prompt()
      state.installPrompt = undefined
    }
    dismissInstallHint()
  })
  dom.installHintClose.addEventListener('click', () => dismissInstallHint())
}

/** @param {string} text */
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = '已复制'
    setTimeout(() => {
      button.textContent = '复制'
    }, 1500)
  } catch {
    showToast('复制失败：浏览器不允许剪贴板访问', 'error')
  }
}

function setupLifecycleEvents() {
  window.addEventListener('online', () => {
    if (!state.connection?.online) {
      state.connection?.reconnect()
      showToast('网络恢复，正在重连…', '', 2200)
    }
  })
  window.addEventListener('offline', () => showToast('网络已断开', 'error'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (state.connection && !state.connection.online && state.status?.state !== CONNECTION_STATE.REJECTED) {
      state.connection.reconnect()
    }
  })
  window.addEventListener('hashchange', async () => {
    const result = await payloadFromLocation()
    if (!result) return
    if (result.error) {
      showView('bind')
      setBindStatus(result.error, 'error')
      return
    }
    beginFromPayload(result.payload)
  })
  window.addEventListener('beforeunload', () => {
    persistNow()
  })
  window.addEventListener('pagehide', () => {
    persistNow()
  })
  window.addEventListener('error', event => {
    const message = event?.message ?? ''
    if (message && !message.includes('ResizeObserver')) showToast(`页面出错：${message}`, 'error', 5000)
  })
  window.addEventListener('unhandledrejection', event => {
    const reason = event?.reason
    const message = reason instanceof Error ? reason.message : String(reason ?? '')
    if (message) showToast(`操作失败：${message}`, 'error', 5000)
  })
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot() {
  applyTheme(state.settings.theme)
  dom.bindVersion.textContent = `Open Whale 网页版 v${APP_VERSION}`
  if (dom.bindProtocol) dom.bindProtocol.textContent = `协议 ${PROTOCOL_VERSION}`
  setupBindEvents()
  setupComposerEvents()
  setupChatEvents()
  setupLifecycleEvents()
  setupScrollTracking()
  setupServiceWorker()
  setupInstallHint()

  if (!nacl?.sign) {
    showView('bind')
    setBindStatus('安全模块（tweetnacl）加载失败。请刷新页面重试；如果反复失败，检查浏览器是否拦截了本地脚本。', 'error')
    return
  }
  if (!('WebSocket' in window)) {
    showView('bind')
    setBindStatus('当前浏览器不支持 WebSocket，请换一个现代浏览器（鸿蒙浏览器 / Safari / Chrome）。', 'error')
    return
  }

  const fromLocation = await payloadFromLocation()
  if (fromLocation?.payload) {
    showView('bind')
    setBindStatus('已从二维码读取绑定信息，正在连接…', 'busy')
    beginFromPayload(fromLocation.payload)
    return
  }
  if (fromLocation?.error) {
    showView('bind')
    setBindStatus(fromLocation.error, 'error')
    return
  }

  const binding = storage.loadBinding()
  if (binding) {
    state.binding = binding
    state.computerName = binding.computerName
    startSession({})
    return
  }
  showView('bind')
}

boot()
