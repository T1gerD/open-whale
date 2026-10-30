// Open Whale 网页版客户端入口。
//
// 零构建、原生 ESM：浏览器直接加载本文件，import 同目录 lib/*.mjs。所有协议 / 加密 /
// 合并逻辑都在 lib 里（可被 node --test 直接测），这里只负责：
//   1. 屏幕切换（绑定页 ↔ 聊天页）与移动端交互；
//   2. 把 ConnectionManager 的事件接到 ChatModel 和 DOM；
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
import { ChatModel, MESSAGE_STATUS, normalizeAttachments, userMessageId } from './lib/messages.mjs'
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
  chatScreen: document.getElementById('chat-screen'),
  statusDot: document.getElementById('status-dot'),
  computerName: document.getElementById('computer-name'),
  connectionDetail: document.getElementById('connection-detail'),
  sessionChip: document.getElementById('session-chip'),
  sessionChipLabel: document.getElementById('session-chip-label'),
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
  sessionSelectPending: false,
  /** 刚由本页发起的会话选择：随后到的 session/state 不再重复提示。 */
  justSelectedSession: false,
  /** 这台设备上次选中的会话（localStorage，按助手分开存）。 */
  lastSessionId: '',
  /** 审批倒计时定时器（有带 expiresAt 的待办审批时才跑）。 */
  approvalTicker: null,
  lastRenderSignature: '',
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

function persistNow() {
  if (!state.identity || !state.model) return
  try {
    storage.saveConversation(state.identity.deviceId, state.model.snapshotForStorage({ limit: 200 }))
    storage.saveOutbox(
      state.identity.deviceId,
      state.outbox.map(entry => ({ msgId: entry.msgId, text: entry.text ?? '', at: entry.at })),
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

  state.model = new ChatModel({ myDeviceId: state.identity.deviceId })
  const savedConversation = storage.loadConversation(state.identity.deviceId)
  if (savedConversation) state.model.restoreFromStorage(savedConversation)

  state.outbox = storage.loadOutbox(state.identity.deviceId).map(entry => ({
    msgId: entry.msgId,
    text: entry.text,
    at: entry.at,
  }))
  for (const entry of state.outbox) {
    state.model.addLocalUserMessage({ msgId: entry.msgId, text: entry.text, at: entry.at, status: MESSAGE_STATUS.ERROR })
  }

  state.serverCaps = new Set()
  state.syncReceived = false
  state.attachments = []
  state.uploader = undefined
  state.sending = false
  // 会话选择器：记住这台设备上次选中的会话（按助手分开存在 localStorage）。
  state.lastSessionId = storage.loadLastSession(state.identity.deviceId)
  state.sessionSheetOpen = false
  state.sessionListLoading = false
  state.sessionSelectPending = false
  state.justSelectedSession = false
  stopApprovalTicker()
  closeSettings()
  closeSessionSheet()

  showView('chat')
  renderAttachmentsTray()
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
  state.sessionSelectPending = false

  // 电脑端换了这台设备的绑定会话（插件重启 / 另一个窗口切过）：本地旧消息作废，
  // 等随后到达的 session/state 快照整页替换。老电脑端不带宽带这两个字段时保持现状。
  const ackSessionId = typeof ack.sessionId === 'string' ? ack.sessionId : ''
  const ackSessionEpoch = Number.isFinite(Number(ack.sessionEpoch)) ? Number(ack.sessionEpoch) : undefined
  if (state.model.sessionId && (ackSessionId !== '' || ackSessionEpoch !== undefined)) {
    state.model.adoptServerSession(ackSessionId || state.model.sessionId, ackSessionEpoch ?? state.model.sessionEpoch)
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
  flushOutbox()
  scheduleSessionSync()
  maybeRestoreSession(ack)
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

/**
 * 重连后把「上次选中的会话」选回来。
 *
 * 电脑端把「这台设备在哪个会话」存在插件进程内存里：插件重启 / 换个地址重连后就
 * 忘了，会给这台设备新建一个会话。网页版因此把上次的选择存在 localStorage，
 * 连上后发现电脑端的绑定不是它，就重新 `session/select` 一次。选的会话已被删除时
 * 电脑会回 `session/selected {ok:false}`，那时再清掉本地记录。
 * @param {any} ack
 */
function maybeRestoreSession(ack) {
  if (!state.model || !state.connection?.online) return
  if (!state.serverCaps.has(CAPABILITIES.SESSIONS)) return
  const saved = state.lastSessionId
  if (!saved) return
  if (state.sessionSelectPending) return
  const serverSession = typeof ack?.sessionId === 'string' ? ack.sessionId : ''
  if (serverSession === saved) return
  sendSessionFrame(CLIENT_FRAME.SESSION_SELECT, { sessionId: saved })
  state.sessionSelectPending = true
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
// 会话选择器
// ---------------------------------------------------------------------------

/** 电脑端是否支持会话选择（老插件没有 sessions-v1）。 */
function sessionsSupported() {
  return state.serverCaps.has(CAPABILITIES.SESSIONS)
}

/**
 * 发一条会话相关帧；离线 / 老电脑端时给出可操作提示而不是静默失败。
 * @param {string} type
 * @param {object} [extra]
 * @returns {boolean}
 */
function sendSessionFrame(type, extra = {}) {
  if (!sessionsSupported()) {
    showToast('电脑端版本较旧，不支持在网页里切换会话；请升级电脑端插件', 'error', 4600)
    return false
  }
  if (!state.connection?.online) {
    showToast('还没连上电脑，暂时不能切换会话', 'error')
    return false
  }
  return Boolean(state.connection.send({ t: type, rid: uid('sess'), ...extra }))
}

/** 打开会话面板时拉一次列表。 */
function requestSessionList({ force = false } = {}) {
  if (!sessionsSupported()) {
    showToast('电脑端版本较旧，不支持会话列表；请升级电脑端插件', 'error', 4600)
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
  renderSessionSheet()
  state.connection.send({ t: CLIENT_FRAME.SESSION_LIST, rid: uid('list') })
}

/** @param {string} sessionId */
function selectSession(sessionId) {
  const id = String(sessionId ?? '')
  if (id === '' || id === state.model?.sessionId) {
    closeSessionSheet()
    return
  }
  if (!sendSessionFrame(CLIENT_FRAME.SESSION_SELECT, { sessionId: id })) return
  state.sessionSelectPending = true
  state.justSelectedSession = true
  renderSessionSheet()
}

function createSession() {
  if (!sendSessionFrame(CLIENT_FRAME.SESSION_CREATE)) return
  state.sessionSelectPending = true
  state.justSelectedSession = true
  renderSessionSheet()
}

/** 记住这台设备选中的会话（按助手 = 设备身份分开存）。 */
function rememberSession(sessionId) {
  const value = String(sessionId ?? '')
  const deviceId = state.identity?.deviceId ?? ''
  if (!deviceId) return
  if (value !== '' && value === state.lastSessionId) return
  storage.saveLastSession(deviceId, value)
  state.lastSessionId = value
}

/** 当前会话标题：会话快照的 title 优先，其次会话列表里的标题。 */
function currentSessionTitle() {
  const model = state.model
  if (!model) return ''
  const id = model.sessionId
  const fromList = Array.isArray(model.sessions) ? model.sessions.find(item => item.id === id) : undefined
  return model.sessionTitle || fromList?.title || ''
}

function openSessionSheet() {
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

/** 会话面板内容（标题 + 相对时间 + live / 当前徽标 + 新建会话）。 */
function renderSessionSheet() {
  if (!state.sessionSheetOpen || !dom.sessionSheet) return
  const model = state.model
  const sessions = Array.isArray(model?.sessions) ? model.sessions : []
  // 「当前」以电脑端的绑定为准（sessions.current），本地 sessionId 兜底。
  const currentId = model?.sessionsCurrent || model?.sessionId || ''
  const rows = sessions
    .map(session => {
      const badges = []
      if (session.live) badges.push('<span class="badge is-live">在线</span>')
      if (session.id === currentId) badges.push('<span class="badge is-current">当前</span>')
      const time = relativeTime(session.updatedAt ?? session.createdAt)
      const meta = [time, session.cwd ? session.cwd : ''].filter(Boolean).map(escapeHtml).join(' · ')
      const busy = state.sessionSelectPending && session.id !== currentId ? ' is-busy' : ''
      return `<button class="session-row${busy}" type="button" data-action="select-session" data-session-id="${escapeHtml(session.id)}">
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
    <h2>会话</h2>
    <p class="sheet-row-note">每台设备只驱动一个 DSH 会话；切换后这里会换成该会话的历史。</p>
    <div class="session-list" role="list">${rows}${empty}</div>
    ${truncated}
    <button class="btn btn-secondary btn-block session-new" type="button" data-action="new-session" ${state.sessionSelectPending ? 'disabled' : ''}>新建会话</button>
  `
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
  // 只有「带 expiresAt 且还没回答」的卡片需要每秒刷新倒计时。
  const need = approvals.some(
    item => !item.replied && Number.isFinite(Number(item.expiresAt)) && !approvalExpired(item),
  )
  if (!need) {
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

  if (frame.t === SERVER_FRAME.SESSION_STATE || frame.t === SERVER_FRAME.SESSION_EVENTS) {
    state.syncReceived = true
    if (state.syncTimer) {
      clearTimeout(state.syncTimer)
      state.syncTimer = null
    }
  }

  const approvalsBefore = state.model.approvals.length
  const result = state.model.applyFrame(frame)

  if (frame.t === SERVER_FRAME.CHAT_ACK) {
    const msgId = String(frame.rid ?? frame.callId ?? '')
    if (msgId) {
      state.outbox = state.outbox.filter(entry => entry.msgId !== msgId)
      storage.saveOutbox(
        state.identity?.deviceId ?? '',
        state.outbox.map(entry => ({ msgId: entry.msgId, text: entry.text ?? '', at: entry.at })),
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
  if (frame.t === SERVER_FRAME.CHAT_ERROR) renderComposerState()
  if (frame.t === SERVER_FRAME.CHAT_DONE) renderComposerState()

  if (frame.t === SERVER_FRAME.SESSIONS) {
    state.sessionListLoading = false
    if (state.sessionSheetOpen) renderSessionSheet()
    renderHeader()
  }
  if (frame.t === SERVER_FRAME.SESSION_SELECTED) handleSessionSelected()
  if (frame.t === SERVER_FRAME.APPROVAL_ASK) {
    syncApprovalTicker()
    if (state.model.approvals.length > approvalsBefore) {
      showToast('电脑在请求权限，请在上面这张卡片里作答', '', 3200)
    }
  }
  if (frame.t === SERVER_FRAME.APPROVAL_RESOLVED) handleApprovalResolved(result.resolved)

  if (result.changed) {
    scheduleRender({
      forceScroll:
        frame.t === SERVER_FRAME.SESSION_STATE ||
        frame.t === SERVER_FRAME.APPROVAL_ASK ||
        frame.t === SERVER_FRAME.SESSION_EVENTS,
    })
    persistSoon()
  }
  if (result.sessionChanged) handleSessionChanged(frame)
}

/**
 * 会话确实换了（本页选的，或电脑端通知的）：整页换成新会话的快照。
 * @param {any} frame
 */
function handleSessionChanged(frame) {
  state.lastRenderSignature = ''
  if (state.model.sessionId) rememberSession(state.model.sessionId)
  renderHeader()
  renderMessages({ forceScroll: true })
  renderComposerState()
  if (state.sessionSheetOpen) renderSessionSheet()
  if (state.justSelectedSession) {
    // 选择结果已经在 session/selected 里提示过了。
    state.justSelectedSession = false
  } else if (frame.t === SERVER_FRAME.SESSION_STATE) {
    showToast('已切换到电脑上的新会话', 'ok', 2400)
  }
}

/** `session/selected`：成功就关面板并记住选择，失败留在面板里说明原因。 */
function handleSessionSelected() {
  const selection = state.model?.lastSessionSelection
  state.sessionSelectPending = false
  if (!selection) return
  if (selection.ok) {
    // justSelectedSession 留给紧随其后的 session/state 消费，避免连报两次「已切换」。
    if (selection.sessionId) rememberSession(selection.sessionId)
    closeSessionSheet()
    showToast(selection.title ? `已切换到「${selection.title}」` : '已切换会话', 'ok', 2400)
  } else {
    state.justSelectedSession = false
    renderSessionSheet()
    // not-found：记住的会话可能已经在电脑上消失了，别再每次重连都重选它。
    if (selection.error === 'not-found') {
      rememberSession('')
      state.lastSessionId = ''
    }
    showToast(selection.message || selection.error || '切换会话失败', 'error', 4600)
  }
}

/** `approval/resolved`：卡片由 reducer 移出队列；这里只补充用户看得懂的提示。 */
function handleApprovalResolved(resolved) {
  syncApprovalTicker()
  if (!resolved) return
  if (resolved.outcome === 'cancelled') {
    showToast(
      resolved.source === 'timeout' ? '这条权限请求已超时，交回电脑处理' : '这条权限请求已在电脑上取消',
      '',
      3200,
    )
  } else if (resolved.source === 'desktop') {
    showToast('这条权限请求已在电脑上回答', '', 2400)
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

/** @param {object} frame */
function queueOutbox(frame) {
  const entry = {
    msgId: String(frame.msgId),
    text: String(frame.text ?? ''),
    at: new Date().toISOString(),
    frame,
  }
  // 同一 msgId 只留一份（重试不应翻倍）。
  state.outbox = state.outbox.filter(item => item.msgId !== entry.msgId)
  state.outbox.push(entry)
  storage.saveOutbox(
    state.identity?.deviceId ?? '',
    state.outbox.map(item => ({ msgId: item.msgId, text: item.text, at: item.at })),
  )
}

function flushOutbox() {
  if (!state.connection?.online || state.outbox.length === 0) return
  // 把队列里的消息都送一遍（服务端按 (deviceId, msgId) 幂等，重复发送安全），
  // 但**不**在发送后清空：只有收到 chat/ack 才从队列删除，否则「发出去但 ack 丢了」
  // 会在刷新/重连后变成永远「发送中」的孤儿消息。
  for (const entry of state.outbox) {
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
  const text = dom.composerInput.value.trim()
  const attachments = state.attachments.slice()
  if (text === '' && attachments.length === 0) return
  if (attachments.length > MAX_UPLOAD_ATTACHMENTS) {
    showToast(`一条消息最多 ${MAX_UPLOAD_ATTACHMENTS} 个附件`, 'error')
    return
  }

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
    state.model.addLocalUserMessage({
      msgId,
      text,
      files: files.map(file => ({ name: file.name, size: file.size, mime: file.mime, uploadId: file.uploadId })),
    })
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
    // 电脑端按幂等键去重，不会出现第二条消息。
    queueOutbox(frame)
    if (state.connection?.online) state.connection.send(frame)

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

/** @param {string} msgId */
function retryMessage(msgId) {
  const message = state.model?.byId.get(userMessageId(msgId))
  if (!message) return
  state.model.resetUserMessageForRetry(msgId)
  const frame = {
    t: CLIENT_FRAME.CHAT,
    rid: msgId,
    msgId,
    callId: msgId,
    text: String(message.text ?? ''),
  }
  queueOutbox(frame)
  const sent = Boolean(state.connection?.online && state.connection.send(frame))
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
  renderSessionChip()
}

/** 顶部会话胶囊：显示当前会话标题，点开是会话列表。 */
function renderSessionChip() {
  if (!dom.sessionChip) return
  const supported = sessionsSupported()
  // 老电脑端没有 sessions-v1：不显示一个点了只会报错的按钮。
  dom.sessionChip.hidden = !supported
  dom.sessionChip.title = '切换会话'
  if (!supported) return
  const title = currentSessionTitle()
  dom.sessionChipLabel.textContent = title || '会话'
  dom.sessionChip.classList.toggle('is-known', title !== '')
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
  let hash = state.model.messages.length
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
  if (messages.length === 0) {
    dom.messageList.innerHTML = `${approvals}${emptyStateHtml()}`
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
  dom.messageList.innerHTML = `${parts.join('')}${approvals}`
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

function renderComposerState() {
  const hasText = dom.composerInput.value.trim() !== ''
  const hasAttachments = state.attachments.length > 0
  const streaming = Boolean(state.model?.activeCallId)
  dom.sendBtn.hidden = streaming
  dom.stopBtn.hidden = !streaming
  dom.sendBtn.disabled = state.sending || (!hasText && !hasAttachments)
  if (state.uploader) {
    dom.composerHint.textContent = '正在上传附件…'
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
  const sessionTitle = currentSessionTitle()
  const sessionsNote = sessionsSupported()
    ? '每台设备只驱动一个 DSH 会话；切换后网页会换成该会话的历史。'
    : '电脑端版本较旧，暂不支持在网页里切换会话。'
  dom.settingsSheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <h2>设置</h2>

    <section class="sheet-section">
      <h3 class="sheet-section-title">会话</h3>
      <div class="sheet-row">
        <span class="sheet-row-label">${escapeHtml(sessionTitle || '未选择')}</span>
        <button class="btn btn-secondary btn-sm" type="button" data-action="open-sessions" ${sessionsSupported() ? '' : 'disabled'}>切换会话</button>
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
    storage.clearLastSession(state.identity.deviceId)
  }
  storage.clearBinding()
  state.binding = undefined
  state.identity = undefined
  state.model = undefined
  state.pendingPayload = undefined
  state.pairSecret = ''
  state.serverCaps = new Set()
  state.status = { state: CONNECTION_STATE.STOPPED }
  state.lastSessionId = ''
  state.sessionListLoading = false
  state.sessionSelectPending = false
  state.lastRenderSignature = ''
  stopApprovalTicker()
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
  dom.sessionChip.addEventListener('click', () => {
    if (!sessionsSupported()) {
      showToast('电脑端版本较旧，不支持切换会话；请升级电脑端插件', 'error', 4600)
      return
    }
    openSessionSheet()
  })
  dom.sheetBackdrop.addEventListener('click', () => {
    closeSettings()
    closeSessionSheet()
  })
  dom.sessionSheet.addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    if (target.dataset.action === 'select-session') {
      selectSession(target.dataset.sessionId ?? '')
      return
    }
    if (target.dataset.action === 'new-session') createSession()
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
          state.model?.clearConversation()
          state.lastRenderSignature = ''
          stopApprovalTicker()
          if (state.identity) storage.clearConversation(state.identity.deviceId)
          renderMessages({ forceScroll: true })
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
    }
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
