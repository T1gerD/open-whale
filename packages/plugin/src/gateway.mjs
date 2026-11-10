// The Open Whale gateway: everything the phone talks to.
//
// Two ways to run this server, because both are needed:
//  * `class Gateway` with `attach(server)` / `attachUpgrade(server)` lets the
//    plugin ride the DSH web server (same port as the GUI) when available.
//  * `class Gateway` with `listen()` runs its own HTTP server, which is what the
//    LAN case needs (a phone on the same Wi-Fi must reach the phone-facing port
//    even when the GUI is bound to loopback).
//
// Authorisation model (see pairer.mjs / state.mjs for the computer side):
//  1. The client sends a `hello` frame as its FIRST message. Nothing else is
//     accepted before that, so an unauthenticated peer cannot probe the API.
//  2. An already-bound device proves possession of its Ed25519 key by signing
//     the challenge the computer sends in `hello/ack`.
//  3. A new device must present the single-use pairing secret from the QR code.
//  4. One computer may serve up to MAX_DEVICES phones (default 5).
//
// v2.2.0 adds the conversation layer that v2.1.0 was missing:
//  · per-conversation broadcast (all devices in a session see every chat frame);
//  · `(deviceId, msgId)` idempotency so a phone retrying an unacknowledged
//    message cannot wake the assistant twice;
//  · a bounded session event log for reconnect catch-up (`session/state` /
//    `session/events`);
//  · chunked uploads landing inside the conversation's working directory;
//  · computer → phone file offers, connection-mode preference, and the built-in
//    web/PWA client under `/openwhale/app`.
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  ALL_CAPABILITIES,
  APPROVAL_REPLY_OUTCOMES,
  CAPABILITIES,
  CONNECTION_MODE,
  CONNECTION_MODES,
  DEDUPE_MAX_ENTRIES,
  DEDUPE_TTL_MS,
  DEFAULT_HEARTBEAT_MS,
  DOWNLOAD_PATH,
  IdempotencyCache,
  MAX_FILE_BYTES,
  MAX_UPLOAD_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  NonceReplayGuard,
  POWER_REFUSAL,
  PROTOCOL_VERSION,
  SERVER_FRAME,
  SESSION_SNAPSHOT_LIMIT,
  SESSION_WATCH_LIMIT,
  SessionEventLog,
  UPLOAD_CHUNK_BYTES,
  WEB_CLIENT_PATH,
  clampAssistantText,
  dedupeKey,
  encodeEndpointKinds,
  helloAckProofMessage,
  helloSignatureMessage,
  normalizeMessageId,
  orderEndpointCandidates,
  pickEndpoint,
  timingSafeEqual,
} from './protocol.mjs'
import { pairingAvailability, renderPairingQr, renderQrContent } from './pairer.mjs'
import { renderPageHtml } from './page.mjs'
import { FileService } from './files.mjs'
import { MAX_DEVICES } from './state.mjs'
import { UploadManager, guessMimeType, sanitizeFileName } from './upload.mjs'
import { WebClientServer, webClientCandidates } from './webchat.mjs'
import { acceptUpgrade, validateUpgrade } from './ws.mjs'

/** Path the phone opens its WebSocket on. */
export const WS_PATH = '/openwhale/ws'

/** This build's plugin version (the wire protocol version lives in protocol.mjs). */
export const PLUGIN_VERSION = '3.0.1'

/**
 * How many concurrent sessions one device may hold.
 *
 * Phones and the web client race two endpoints on purpose ("whichever handshake
 * wins first"): two sockets with the SAME deviceId briefly coexist during that
 * race, and in a browser two tabs are two connections as well. Kicking the older
 * one on every hello turned the race into an endless ping-pong loop
 * (connect → auth → kicked → reconnect …), so a device may keep a few live
 * sessions; frames delivered to all of them are deduplicated by the client via
 * `seq`/`msgId`. Three covers the race plus a tab or two.
 */
const MAX_SESSIONS_PER_DEVICE = 3

/** Legacy inline base64 attachments are still accepted, but bounded. */
const MAX_INLINE_ATTACHMENT_BYTES = 32 * 1024 * 1024

/** Longest message text accepted from a phone. */
const MAX_TEXT_LENGTH = 100_000

/**
 * 前后台判定的新鲜度窗口（毫秒）。
 *
 * 网页版客户端每 `DEFAULT_HEARTBEAT_MS`（25s，见 protocol）发一帧 `ping`，
 * 切后台/锁屏时还会立刻补一帧 `ping{visible:false}`。窗口取 70s ≈ 2.8 个
 * 心跳周期：比 3 个周期略短，移动网络抖动下也不容易误判，同时又能在一两次
 * 丢包/浏览器冻结定时器后及时把「在线」降级成「在线（后台）」。
 * 旧客户端不会发 `visible`，按前台处理（协议 ping.visible 注释），靠心跳续期。
 */
const PRESENCE_FRESHNESS_MS = 70_000

/** Bodies we accept on the small JSON management routes (send-file etc.). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * @typedef {object} Bridge
 * The DSH-facing half. The gateway never imports DSH packages directly, which
 * is what keeps the wire protocol testable without a harness.
 * @property {(input: {deviceId: string, sessionId: string, callId: string, text: string, attachments: Array<{name: string, mime?: string, size?: number, path?: string, dataBase64?: string, fileId?: string}>}) => Promise<void>} send
 *           Deliver a user message into the session the device is bound to.
 * @property {(callId: string, deviceId?: string) => void} [cancel]
 * @property {() => Promise<Array<{fileId: string, name: string, size: number, mime?: string, path?: string}>>} [listFiles]
 *           Files the assistant produced that the phone may fetch.
 * @property {(fileId: string) => Promise<{name: string, mime?: string, path: string} | undefined>} [fileFor]
 * @property {(input: {deviceId: string, label: string}) => Promise<void>} [renameAssistant]
 * @property {(input: {deviceId: string, action: string, delaySeconds?: number, mac?: string}) => Promise<{accepted: boolean, delaySeconds?: number, cancelToken?: string, reason?: string, message?: string}>} [power]
 * @property {() => Promise<{sessions: Array<object>, truncated: boolean}>} [listSessions]
 *           Root DSH sessions for the phone's picker (newest first, truncated).
 * @property {(sessionId: string) => Promise<{ok: true, sessionId: string, title?: string} | {ok: false, error: string, message: string}>} [selectSession]
 *           Bind-ready open of an existing session (resume unless it is live).
 * @property {() => Promise<{ok: true, sessionId: string}>} [createSession]
 *           Create a brand new DSH session for a device that has no binding yet.
 * @property {(sessionId: string) => Promise<Array<{id: string, kind: 'user'|'assistant', text: string, at: string}>>} [historyMessages]
 *           Log-backed history for `session/state` (degrades to `[]` on failure).
 * @property {(input: {approvalId: string, deviceId?: string, outcome: string}) => boolean} [answerApproval]
 *           Settle a forwarded approval with the phone's answer.
 * @property {(sessionId: string) => Array<object>} [pendingApprovals]
 *           Approvals still waiting in one conversation, replayed after a reconnect.
 * @property {(input: {questionId: string, deviceId?: string, answers: unknown}) => boolean} [answerQuestion]
 *           Settle a forwarded structured question with the phone's answers.
 * @property {(sessionId: string) => Promise<void>} [releaseSession]
 *           Tear down an agent no device is bound to any more.
 * @property {(listener: (event: object) => void) => () => void} [onEvent]
 *           Bridge events: {kind:'message'|'done'|'tool'|'typing'|'error'|'approval-ask'|'approval-resolved', sessionId, deviceId, callId, ...}
 */

/**
 * One authenticated phone connection.
 */
class Session {
  /**
   * @param {Gateway} gateway
   * @param {import('./ws.mjs').WsConnection} connection
   */
  constructor(gateway, connection) {
    this.gateway = gateway
    this.connection = connection
    this.id = `sess_${randomBytes(6).toString('hex')}`
    /** @type {string | null} */
    this.deviceId = null
    /** @type {string | null} Conversation this device is in (set at hello). */
    this.sessionId = null
    /** @type {Set<string>} Capabilities the client declared in `hello`. */
    this.capabilities = new Set()
    this.authenticated = false
    this.nonce = randomBytes(16).toString('base64url')
    this.lastSeenAt = Date.now()
    /**
     * 页面是否可见（前后台信号）。客户端在 `ping` 帧里带 `visible`（协议
     * ping.visible）；缺省 true 表示按前台处理，兼容还没上报可见性的旧客户端。
     */
    this.visible = true
    /** 最近一次收到 visible 信号（握手 / 带 visible 的心跳）的时间，用于 freshness 判定。 */
    this.lastVisibleAt = this.gateway.now()
    this.helloDeadline = setTimeout(() => {
      this.sendError('handshake-timeout', '连接后未发送 hello，已断开')
      this.close(1008, 'handshake timeout')
    }, 10_000)
    this.helloDeadline.unref?.()

    connection.on('message', text => this.#onMessage(text))
    connection.on('close', payload => this.#onClose(payload))
    connection.on('error', () => this.#onClose())
  }

  /**
   * @param {string} capability
   * @returns {boolean}
   */
  hasCap(capability) {
    return this.capabilities.has(capability)
  }

  /** @param {object} frame */
  send(frame) {
    return this.connection.send(JSON.stringify(frame))
  }

  /** @param {string} code @param {string} message @param {object} [extra] */
  sendError(code, message, extra = {}) {
    this.send({ t: SERVER_FRAME.ERROR, code, message, ...extra })
  }

  /** @param {number} code @param {string} reason */
  close(code, reason) {
    clearTimeout(this.helloDeadline)
    this.connection.close(code, reason)
  }

  /** @param {Buffer|undefined} [payload] WebSocket CLOSE 帧载荷（code + reason）。 */
  #onClose(payload) {
    clearTimeout(this.helloDeadline)
    if (Buffer.isBuffer(payload) && payload.length >= 2) {
      this.closeCode = payload.readUInt16BE(0)
      this.closeReason = payload.subarray(2).toString('utf8').slice(0, 120)
    }
    this.gateway.handleSessionClosed(this)
  }

  /**
   * @param {string} text
   */
  async #onMessage(text) {
    this.lastSeenAt = Date.now()
    /** @type {any} */
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      this.sendError('bad-json', '帧不是合法 JSON')
      return
    }
    if (!frame || typeof frame.t !== 'string') {
      this.sendError('bad-frame', '帧缺少 t 字段')
      return
    }
    // Before authentication only `hello` is allowed.
    if (!this.authenticated && frame.t !== 'hello') {
      this.sendError('not-authenticated', '请先发送 hello 握手')
      return
    }
    try {
      await this.gateway.handleFrame(this, frame)
    } catch (error) {
      this.sendError('internal', `处理失败：${/** @type {Error} */ (error).message}`)
    }
  }
}

/**
 * The gateway. Owns the socket surface and the device registry, and delegates
 * every DSH-specific action to the injected bridge.
 */
export class Gateway {
  /**
   * @param {object} options
   * @param {import('./state.mjs').StateStore} options.store
   * @param {Bridge} options.bridge
   * @param {string} [options.host] Advertised LAN host (for endpoint building).
   * @param {number} [options.port]
   * @param {() => string[]} [options.tunnelUrls] Currently reachable public URLs.
   * @param {() => string[]} [options.lanUrls]
   * @param {(message: string) => void} [options.log]
   * @param {string} [options.uploadDir] Override for phone attachment storage (tests).
   * @param {() => string} [options.cwd] Session working directory (uploads/file offers).
   * @param {string} [options.webClientDir] Explicit web-client directory (tests).
   * @param {() => number} [options.now]
   * @param {number} [options.uploadIdleTimeoutMs]
   */
  constructor(options) {
    this.store = options.store
    this.bridge = options.bridge
    this.port = options.port ?? 0
    this.tunnelUrls = options.tunnelUrls ?? (() => [])
    this.lanUrls = options.lanUrls ?? (() => [])
    this.log = options.log ?? (() => {})
    this.cwd = options.cwd ?? (() => process.cwd())
    this.heartbeatMs = DEFAULT_HEARTBEAT_MS
    this.sessionEpoch = 1
    /**
     * deviceId → sessionId（v2.3.0）：每台手机始终只驱动它当前绑定的那个 DSH
     * 会话，取代旧的「每个设备一个固定会话 / 协作时共用一个会话」方案。
     *
     * 绑定会写进 state store 的偏好里，这样插件重启后手机连回来仍落到同一个
     * 会话（否则每次重启都会新建一个会话，聊天记录看起来像是丢了）。
     * @type {Map<string, string>}
     */
    this.deviceSession = new Map(Object.entries(
      /** @type {Record<string, string>} */ (this.store.getPreference('deviceSession', {})) ?? {},
    ).filter(([, sessionId]) => typeof sessionId === 'string' && sessionId !== ''))
    /**
     * deviceId → 后台仍打开的会话（v1.3.0「会话标签」）。
     *
     * 手机可以像桌面侧边栏一样同时开几个会话：当前活跃的那个走 `deviceSession`，
     * 其余标签走这里订阅事件。只存在内存里——重连后客户端会重新发一次
     * `session/watch`，把它落盘反而会攒下一堆过期 id。
     * @type {Map<string, Set<string>>}
     */
    this.deviceWatch = new Map()
    this.serverVersion = PLUGIN_VERSION

    /** @type {Set<Session>} */
    this.sessions = new Set()
    /** @type {Map<string, Set<Session>>} deviceId → live sessions (see MAX_SESSIONS_PER_DEVICE) */
    this.byDevice = new Map()
    /** Rejects a replayed `hello` from an already-bound device. */
    this.nonces = new NonceReplayGuard()
    this.gatewayEvents = new EventEmitter()
    this.server = null
    /** Secondary (LAN) listener, when the primary one belongs to the DSH web server. */
    this.secondary = null
    this.secondaryPort = 0
    this.startedAt = Date.now()

    /** `(deviceId, msgId)` → already accepted message. Fixes duplicate delivery. */
    this.dedupe = new IdempotencyCache()
    this.now = options.now ?? (() => Date.now())
    /**
     * 幂等表的落盘副本。
     *
     * 内存里的 IdempotencyCache 只活一个进程：插件重启后手机 outbox 重试同一
     * msgId，会被当成新消息再喂给模型一次（用户看到两条一样的回答）。这里把
     * 已受理的消息镜像到 `<dataDir>/dedupe.json`，启动时加载、变化后去抖落盘、
     * dispose 时同步 flush。失败只记日志——幂等是体验优化，绝不能拖垮收消息。
     */
    this.dedupeFile = this.store?.dir ? join(this.store.dir, 'dedupe.json') : null
    /** @type {Map<string, {value: any, at: number}>} */
    this.dedupeRecords = new Map()
    /** @type {any} */
    this.dedupeFlushTimer = null
    this.#loadDedupe()
    /** @type {Map<string, SessionEventLog>} conversationId → durable event log */
    this.eventLogs = new Map()
    /** conversationId → in-flight assistant turn shown by session/state snapshots. */
    this.activeCalls = new Map()
    /** fileId → file the computer offered to the phones (computer → phone send). */
    this.offeredFiles = new Map()
    /** 文件出站（分片推送 + 一次性下载链接）的 I/O 半层，见 files.mjs。 */
    this.files = new FileService({
      bridge: this.bridge,
      offeredFiles: this.offeredFiles,
      log: this.log,
    })

    this.uploads = new UploadManager({
      dir: options.uploadDir ?? (() => join(this.cwd(), '.openwhale', 'uploads')),
      log: this.log,
      ...(options.uploadIdleTimeoutMs ? { idleTimeoutMs: options.uploadIdleTimeoutMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    })

    this.webClient = options.webClient ?? new WebClientServer({
      dirs: options.webClientDir ? [options.webClientDir] : webClientCandidates(),
      log: this.log,
    })
  }

  /**
   * Live sessions for a device. Several can coexist while a client races two
   * endpoints or opens two tabs.
   * @param {string} deviceId
   * @returns {Session[]}
   */
  sessionsForDevice(deviceId) {
    return [...(this.byDevice.get(deviceId) ?? [])]
  }

  /**
   * Is at least one session of this device connected?
   * @param {string} deviceId
   * @returns {boolean}
   */
  deviceOnline(deviceId) {
    return (this.byDevice.get(deviceId)?.size ?? 0) > 0
  }

  /**
   * 设备在线状态，区分「前台 / 后台 / 离线」。
   *
   * 手机网页版切后台、锁屏、浏览器冻结定时器时不再谎报「在线」。但后台设备
   * **仍然算可用**：审批/提问的转发资格仍按 {@link deviceOnline}（后台也推），
   * 用户回到前台就能看到待办；这里只影响设置页展示与 health 统计。
   *
   * 判定规则：没有任何已认证 socket → offline；最近一次可见信号（握手或
   * `ping{visible:true}`）在 `PRESENCE_FRESHNESS_MS` 窗口内 → foreground；
   * 否则（显式 hidden，或前端卡死/丢包导致心跳过期）→ background。
   * 一台设备可能有 2 条 socket（竞速/多窗口）：任意一条前台即算前台。
   * @param {string} deviceId
   * @returns {'foreground'|'background'|'offline'}
   */
  devicePresence(deviceId) {
    const sessions = this.sessionsForDevice(deviceId)
    if (sessions.length === 0) return 'offline'
    const now = this.now()
    const foreground = sessions.some(session =>
      session.visible !== false && now - session.lastVisibleAt <= PRESENCE_FRESHNESS_MS)
    return foreground ? 'foreground' : 'background'
  }

  /**
   * health 用的在线统计：在线设备里再分前台/后台。
   * @returns {{onlineDevices: number, foregroundDevices: number, backgroundDevices: number}}
   */
  #presenceCounts() {
    let foregroundDevices = 0
    for (const deviceId of this.byDevice.keys()) {
      if (this.devicePresence(deviceId) === 'foreground') foregroundDevices += 1
    }
    const onlineDevices = this.byDevice.size
    return { onlineDevices, foregroundDevices, backgroundDevices: onlineDevices - foregroundDevices }
  }

  /** First live session for a device, if any (compatibility helper). */
  sessionFor(deviceId) {
    return this.byDevice.get(deviceId)?.values().next().value
  }

  /**
   * 在线且绑定到某个会话的设备（桥用它决定审批能不能转发；没有手机时审批
   * 必须交回桌面 UI，绝不能冒领）。
   *
   * v1.3.0：**后台标签也算**。一台手机可能把会话 B 开在后台看着（watch），
   * 此时 B 里的工具调用同样应该能转到这台手机，而不是因为「它不是当前标签」
   * 就静默等桌面。
   * @param {string} sessionId
   * @returns {string[]}
   */
  devicesInSession(sessionId) {
    if (!sessionId) return []
    const devices = new Set()
    for (const [deviceId, bound] of this.deviceSession) {
      if (bound === sessionId) devices.add(deviceId)
    }
    for (const [deviceId, watched] of this.deviceWatch) {
      if (watched.has(sessionId)) devices.add(deviceId)
    }
    return [...devices].filter(deviceId => this.deviceOnline(deviceId))
  }

  /**
   * 后台标签订阅（session/watch）。
   * @param {string} deviceId
   * @param {string} sessionId
   * @returns {boolean}
   */
  #watches(deviceId, sessionId) {
    return this.deviceWatch.get(deviceId)?.has(sessionId) === true
  }

  /**
   * 用手机发来的标签列表替换后台订阅。当前活跃会话不算在 watch 里（它天然
   * 一直在收），所以这里把它过滤掉，避免同一帧被同一个 socket 收两遍。
   * @param {string} deviceId
   * @param {unknown} value
   * @param {string} [activeSessionId]
   * @returns {string[]} the accepted watch set
   */
  #setWatch(deviceId, value, activeSessionId) {
    const ids = Array.isArray(value)
      ? [...new Set(value.filter(id => typeof id === 'string' && id !== '' && id !== activeSessionId))].slice(0, SESSION_WATCH_LIMIT)
      : []
    if (ids.length === 0) this.deviceWatch.delete(deviceId)
    else this.deviceWatch.set(deviceId, new Set(ids))
    return ids
  }

  /**
   * 可以接收审批请求的设备：在线、绑定该会话、且声明了 `approval-v1`。
   * @param {string} sessionId
   * @returns {string[]}
   */
  approvalDevicesFor(sessionId) {
    const capable = []
    for (const deviceId of this.devicesInSession(sessionId)) {
      const sessions = this.sessionsForDevice(deviceId)
      if (sessions.some(session => session.authenticated && session.hasCap(CAPABILITIES.APPROVAL))) {
        capable.push(deviceId)
      }
    }
    return capable
  }

  /**
   * 记录 deviceId → sessionId 绑定。写内存 Map 的同时落盘，插件重启后仍能回到
   * 同一个会话（见 constructor 的 `deviceSession`）。
   * @param {string} deviceId
   * @param {string} sessionId
   */
  #bindDeviceSession(deviceId, sessionId) {
    this.deviceSession.set(deviceId, sessionId)
    try {
      this.store.setPreference('deviceSession', Object.fromEntries(this.deviceSession))
    } catch (error) {
      this.log(`session: 保存设备会话绑定失败：${/** @type {Error} */ (error).message}`)
    }
    const sessions = this.sessionsForDevice(deviceId)
    for (const session of sessions) session.sessionId = sessionId
  }

  /**
   * 一台设备当前应绑定的会话：已有绑定直接用；新设备首次绑定则新建一个会话。
   * 建会话失败时退化为一个本地生成的 id，下一次发送仍会尝试在 DSH 里创建。
   * @param {string} deviceId
   * @returns {Promise<string>}
   */
  async #ensureDeviceSession(deviceId) {
    const existing = this.deviceSession.get(deviceId)
    if (existing) return existing
    try {
      const created = await this.bridge.createSession?.(deviceId)
      if (created?.sessionId) {
        this.#bindDeviceSession(deviceId, created.sessionId)
        this.log(`session: 新设备 ${deviceId} 绑定到新会话 ${created.sessionId}`)
        return created.sessionId
      }
    } catch (error) {
      this.log(`session: 为新设备新建会话失败（降级）：${/** @type {Error} */ (error).message}`)
    }
    const fallback = `ow-${randomBytes(16).toString('hex')}`
    this.#bindDeviceSession(deviceId, fallback)
    return fallback
  }

  /**
   * Register an authenticated session for its device, evicting the oldest one
   * when the per-device cap is exceeded.
   * @param {Session} session
   * @returns {Session[]} sessions that were evicted
   */
  #addDeviceSession(session) {
    const deviceId = /** @type {string} */ (session.deviceId)
    let group = this.byDevice.get(deviceId)
    if (!group) {
      group = new Set()
      this.byDevice.set(deviceId, group)
    }
    group.add(session)
    const evicted = []
    // Insertion order is authentication order, so "first" is the oldest.
    while (group.size > MAX_SESSIONS_PER_DEVICE) {
      const oldest = group.values().next().value
      if (!oldest) break
      group.delete(oldest)
      evicted.push(oldest)
    }
    return evicted
  }

  /**
   * Remove one session from its device group, keeping the others alive.
   * @param {Session} session
   */
  #removeDeviceSession(session) {
    const deviceId = session.deviceId
    if (!deviceId) return
    const group = this.byDevice.get(deviceId)
    if (!group) return
    group.delete(session)
    if (group.size === 0) this.byDevice.delete(deviceId)
  }

  /** @returns {boolean} */
  get hasBridgeEvents() {
    return typeof this.bridge.onEvent === 'function'
  }

  // ---------------------------------------------------------------------------
  // HTTP + upgrade surface
  // ---------------------------------------------------------------------------

  /** Route an upgrade request; returns true when this gateway handled it. */
  attachUpgrade(server) {
    server.on('upgrade', (req, socket, head) => this.attachUpgradeHandler(req, socket, head))
  }

  /**
   * Handle one upgrade request directly, so the gateway can ride the DSH web
   * server's `registerUpgrade` route instead of owning an HTTP server.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  attachUpgradeHandler(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== WS_PATH) {
      // Answer with a real status instead of returning silently: once an HTTP
      // server has emitted `upgrade`, it no longer manages the socket, so doing
      // nothing leaves the connection hanging until the client times out.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const reason = validateUpgrade(req)
    if (reason) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const connection = acceptUpgrade(req, socket, head)
    const session = new Session(this, connection)
    this.sessions.add(session)
    this.log(`ws: client connected (${session.id}) host=${req.headers.host ?? '-'} remote=${socket.remoteAddress ?? '-'}`)
  }

  /**
   * Open a second listener while keeping the first one alive.
   *
   * This exists because the DSH web server normally binds loopback only: routes
   * there serve the local browser, and a phone on the same Wi-Fi needs a socket
   * on the LAN interface as well. Both listeners share one session registry, so a
   * device connected over either path is handled identically.
   * @param {number} port
   * @param {string} [host]
   * @returns {Promise<number>}
   */
  async listenSecondary(port = 0, host = '0.0.0.0') {
    const server = createServer((req, res) => {
      this.handleRequest(req, res)
        .then(handled => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Open Whale: 未找到该路径')
          }
        })
        .catch(error => {
          this.log(`http: ${/** @type {Error} */ (error).message}`)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Open Whale: 内部错误')
        })
    })
    this.attachUpgrade(server)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve(undefined)
      })
    })
    // Keep-alive sockets would otherwise hold the process open after dispose.
    server.keepAliveTimeout = 5000
    this.secondary = server
    this.secondaryPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port
    return this.secondaryPort
  }

  /**
   * Route an HTTP request; returns true when this gateway handled it.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // Built-in Web/PWA client. Served from the same origin as the rest of the
    // plugin so no CORS/proxy configuration is needed.
    if (path === WEB_CLIENT_PATH || path.startsWith(`${WEB_CLIENT_PATH}/`)) {
      return this.webClient.handle(req, res)
    }

    if (path === '/openwhale/health') {
      return this.#json(res, 200, {
        ok: true,
        plugin: 'dsh-openwhale',
        version: this.serverVersion,
        computerId: this.store.computerId,
        computerName: this.store.computerName,
        paired: this.store.isPaired,
        connectionMode: this.#mode(),
        endpoints: this.#reachableEndpoints(),
        devices: this.store.devices.map(d => ({ id: d.id, label: d.label ?? d.deviceName })),
        // 客户端会故意并发竞速两个地址，一个设备可能同时有 2 条会话；对用户/诊断
        // 有意义的是「在线设备数」，原始 socket 数单独放在 sessions 里。
        // 在线再细分前/后台：后台设备仍算可用（审批/提问照常转发），只是用户
        // 没在看页面 → 统计分开计数，connections 保持「在线设备数」的老语义。
        ...this.#presenceCounts(),
        connections: this.byDevice.size,
        sessions: this.sessions.size,
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      })
    }

    if (path === '/openwhale/info') {
      return this.#json(res, 200, {
        version: this.serverVersion,
        computerId: this.store.computerId,
        computerName: this.store.computerName,
        fingerprint: this.store.fingerprint,
        connectionMode: this.#mode(),
        endpoints: this.#allEndpointList(),
        pairing: pairingAvailability(this.store),
        webClient: this.#webClientUrl(this.#reachableEndpoints()),
      })
    }

    // The QR image encodes a single-use pairing secret, so it is only rendered
    // on request from this machine — a tunnel visitor must not get it.
    if (path === '/openwhale/qr.svg' || path === '/openwhale/qr.png') {
      if (!this.#requireLocal(req, res)) return true
      // 配对向导第三步：按用户选择的线路生成二维码（未选则沿用全部可用地址）。
      const payload = this.pairingPayload(url.searchParams.get('mode') ?? undefined)
      if (!payload.ok) return this.#json(res, 409, { error: payload.reason, message: payload.message })
      const qr = await renderPairingQr(payload.payload)
      if (path.endsWith('.png')) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(qr.png)
      } else {
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
        res.end(qr.svg)
      }
      return true
    }

    if (path === '/openwhale/pairing.json') {
      const payload = this.pairingPayload()
      if (!payload.ok) return this.#json(res, 409, { error: payload.reason, message: payload.message })
      // The secret is included on purpose: this route is for the computer's own
      // UI/debugging. The QR image route above is what stays local-only.
      return this.#json(res, 200, { ok: true, payload: payload.payload })
    }

    if (path === '/openwhale' || path === '/openwhale/') {
      const local = this.isLocalRequest(req)
      const payload = this.pairingPayload()
      const qr = payload.ok && local ? await renderPairingQr(payload.payload) : null
      const endpoints = this.#reachableEndpoints()
      const webUrl = this.#webClientUrl(endpoints)
      // 网页版二维码必须**按地址分开生成**，并且**带上一次性的 #p= 绑定载荷**：
      //  · 只给一个地址时（v2.2.0）用的是排序第一的地址——通常是 Tailscale 的
      //    100.x，没装/没连 Tailscale 的 iPhone 根本打不开页面；
      //  · 二维码里没有 #p= 时，页面只能停在「粘贴链接」这一步，扫码不能直接绑定。
      // 局域网放最前（同一 Wi-Fi 最常见），其次 Tailscale，最后公网隧道。
      const webEntries = local && payload.ok && this.webClient.available()
        ? await this.#webBindingEntries(endpoints, payload.payload)
        : []
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(this.#pageHtml({ payload, qr, webEntries, webUrl, endpoints, local }))
      return true
    }

    if (path === '/openwhale/device-rename') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
        res.end('请用 POST 调用')
        return true
      }
      if (!this.#requireLocal(req, res)) return true
      const deviceId = url.searchParams.get('deviceId')
      const label = String(url.searchParams.get('label') ?? '').trim()
      if (!deviceId || !label) return this.#json(res, 400, { ok: false, error: 'missing-params' })
      if (label.length > 24) return this.#json(res, 400, { ok: false, error: 'label-too-long' })
      const updated = this.store.updateDevice(deviceId, { label })
      if (!updated) return this.#json(res, 404, { ok: false, error: 'device-not-found' })
      this.log(`device: ${deviceId} 改名为「${label}」`)
      return this.#json(res, 200, { ok: true, device: { id: updated.id, label: updated.label } })
    }

    if (path === '/openwhale/unbind') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
        res.end('请用 POST 调用')
        return true
      }
      if (!this.#requireLocal(req, res)) return true
      // 多设备支持后，"全部解绑"不够用了：队友手机丢了不该连自己的也一起踢。
      // 带 ?deviceId=xxx 只解绑那一台，不带则维持原来的全量解绑语义。
      const targetDeviceId = url.searchParams.get('deviceId')
      if (targetDeviceId) {
        const device = this.store.device(targetDeviceId)
        if (!device) return this.#json(res, 404, { ok: false, error: 'device-not-found' })
        try {
          this.#unbindDevice(targetDeviceId)
        } catch (error) {
          this.log(`pairing: 手动解绑 ${targetDeviceId} 失败：${/** @type {Error} */ (error).message}`)
          return this.#json(res, 500, { ok: false, error: 'unbind-failed' })
        }
        return this.#json(res, 200, { ok: true, removed: 1 })
      }
      const removed = this.store.devices ?? []
      for (const device of removed) {
        const deviceId = device.id ?? device.deviceId
        try {
          this.#unbindDevice(deviceId)
        } catch (error) {
          this.log(`pairing: 手动解绑 ${deviceId} 失败：${/** @type {Error} */ (error).message}`)
        }
      }
      this.log(`pairing: manual unbind finished, removed ${removed.length} device(s)`)
      return this.#json(res, 200, { ok: true, removed: removed.length })
    }

    if (path === '/openwhale/connection-mode') {
      return this.#handleConnectionMode(req, res, url)
    }

    if (path === '/openwhale/send-file') {
      return this.#handleSendFile(req, res)
    }

    if (path === '/openwhale/download') {
      return this.files.handleDownload(url, res)
    }

    return false
  }

  /** Start a standalone HTTP server (LAN case). */
  async listen(port = 0, host = '0.0.0.0') {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res)
        .then(handled => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('Open Whale: 未找到该路径')
          }
        })
        .catch(error => {
          this.log(`http: ${/** @type {Error} */ (error).message}`)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Open Whale: 内部错误')
        })
    })
    this.attachUpgrade(this.server)
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server?.off('error', reject)
        resolve(undefined)
      })
    })
    const address = /** @type {import('node:net').AddressInfo} */ (this.server.address())
    this.port = address.port
    return this.port
  }

  async close() {
    // 关服前把幂等表同步落盘：dispose 之后不可能再 flush，丢的会是最新那批。
    this.#flushDedupe()
    for (const session of this.sessions) session.close(1001, 'server shutting down')
    this.sessions.clear()
    this.byDevice.clear()
    await this.uploads.dispose()
    for (const server of [this.server, this.secondary]) {
      if (!server) continue
      // `server.close()` only stops accepting new connections; it keeps waiting for
      // the open ones. A phone socket can stay half-open indefinitely, so a graceful
      // close would hang plugin shutdown (and every test that disposes a gateway).
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      server.close(() => {})
    }
    this.server = null
    this.secondary = null
  }

  // ---------------------------------------------------------------------------
  // Durable idempotency table (v3.0.0)
  // ---------------------------------------------------------------------------

  /** 启动时从 `<dataDir>/dedupe.json` 恢复未过期的幂等记录（坏文件只忽略）。 */
  #loadDedupe() {
    if (!this.dedupeFile) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.dedupeFile, 'utf8'))
    } catch (error) {
      // 首次运行没有文件是正常的；有文件但读不出来才是异常，记一条日志即可。
      if (existsSync(this.dedupeFile)) {
        this.log(`dedupe: 幂等表不可读，已忽略：${/** @type {Error} */ (error).message}`)
      }
      return
    }
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const now = this.now()
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || entry.key === '') continue
      if (!Number.isFinite(entry.at) || now - entry.at > DEDUPE_TTL_MS) continue
      const value = entry.value && typeof entry.value === 'object' ? entry.value : undefined
      if (!value) continue
      this.dedupeRecords.set(entry.key, { value, at: entry.at })
    }
    // 超出容量时保留最新的（Map 的顺序＝写入顺序）。
    while (this.dedupeRecords.size > DEDUPE_MAX_ENTRIES) {
      const oldest = this.dedupeRecords.keys().next().value
      if (oldest === undefined) break
      this.dedupeRecords.delete(oldest)
    }
    for (const [key, record] of this.dedupeRecords) this.dedupe.remember(key, record.value)
    if (this.dedupeRecords.size > 0) this.log(`dedupe: 从磁盘恢复了 ${this.dedupeRecords.size} 条幂等记录`)
  }

  /**
   * 记住一条已受理的消息（内存 + 落盘镜像）。
   * @param {string} key
   * @param {any} value
   */
  #rememberDedupe(key, value) {
    this.dedupe.remember(key, value)
    this.dedupeRecords.set(key, { value, at: this.now() })
    while (this.dedupeRecords.size > DEDUPE_MAX_ENTRIES) {
      const oldest = this.dedupeRecords.keys().next().value
      if (oldest === undefined) break
      this.dedupeRecords.delete(oldest)
    }
    this.#scheduleDedupeFlush()
  }

  /** 去抖：burst 里的多条消息只写一次盘。 */
  #scheduleDedupeFlush() {
    if (!this.dedupeFile || this.dedupeFlushTimer) return
    this.dedupeFlushTimer = setTimeout(() => {
      this.dedupeFlushTimer = null
      this.#flushDedupe()
    }, 250)
    this.dedupeFlushTimer.unref?.()
  }

  /**
   * 原子写幂等表（tmp + rename）。任何失败只记日志：幂等表是体验优化，
   * 绝不能因为磁盘只读/配额满而让收消息失败。
   */
  #flushDedupe() {
    if (this.dedupeFlushTimer) {
      clearTimeout(this.dedupeFlushTimer)
      this.dedupeFlushTimer = null
    }
    if (!this.dedupeFile) return
    try {
      const now = this.now()
      /** @type {Array<{key: string, at: number, value: any}>} */
      const entries = []
      for (const [key, record] of this.dedupeRecords) {
        if (now - record.at > DEDUPE_TTL_MS) {
          this.dedupeRecords.delete(key)
          continue
        }
        entries.push({ key, at: record.at, value: record.value })
      }
      if (entries.length === 0) return
      mkdirSync(dirname(this.dedupeFile), { recursive: true })
      const tmp = `${this.dedupeFile}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 })
      renameSync(tmp, this.dedupeFile)
    } catch (error) {
      this.log(`dedupe: 写入幂等表失败（忽略）：${/** @type {Error} */ (error).message}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Frame routing
  // ---------------------------------------------------------------------------

  /**
   * @param {Session} session
   * @param {any} frame
   */
  async handleFrame(session, frame) {
    switch (frame.t) {
      case 'hello':
        return this.#handleHello(session, frame)
      case 'ping': {
        // 前后台信号（协议 `ping.visible`，缺省按前台处理，兼容旧客户端）。
        // 只用于展示/统计，**不影响**审批与提问的转发资格（那仍按 deviceOnline）。
        const visible = typeof frame.visible === 'boolean' ? frame.visible : true
        session.visible = visible
        session.lastVisibleAt = this.now()
        return session.send({ t: SERVER_FRAME.PONG, time: new Date().toISOString() })
      }
      case 'chat/send':
        return this.#handleChatSend(session, frame)
      case 'chat/cancel':
        this.bridge.cancel?.(frame.callId, session.deviceId ?? undefined)
        return session.send({ t: SERVER_FRAME.CHAT_ACK, rid: frame.rid, callId: frame.callId, cancelled: true })
      case 'session/sync':
        return this.#handleSessionSync(session, frame)
      case 'session/list':
        return this.#handleSessionList(session, frame)
      case 'session/select':
        return this.#handleSessionSelect(session, frame)
      case 'session/create':
        return this.#handleSessionCreate(session, frame)
      case 'session/watch':
        return this.#handleSessionWatch(session, frame)
      case 'session/snapshot':
        return this.#handleSessionSnapshot(session, frame)
      case 'approval/reply':
        return this.#handleApprovalReply(session, frame)
      case 'question/reply':
        return this.#handleQuestionReply(session, frame)
      case 'upload/start':
        return this.#handleUploadStart(session, frame)
      case 'upload/chunk':
        return this.#handleUploadChunk(session, frame)
      case 'upload/end':
        return this.#handleUploadEnd(session, frame)
      case 'upload/cancel':
        return this.#handleUploadCancel(session, frame)
      case 'file/fetch':
        return this.#handleFileFetch(session, frame)
      case 'assistant/rename':
        return this.#handleRename(session, frame)
      case 'device/rename':
        return this.#handleDeviceRename(session, frame)
      case 'power/request':
        return this.#handlePower(session, frame)
      case 'device/forget':
        return this.#handleForget(session, frame)
      default:
        // Unknown frames are ignored on purpose: both sides must be able to ship
        // independently.
        return undefined
    }
  }

  /** @param {Session} session @param {any} frame */
  async #handleHello(session, frame) {
    if (session.authenticated) {
      return session.sendError('already-authenticated', '已经完成握手')
    }
    const deviceId = String(frame.deviceId ?? '')
    const publicKey = String(frame.devicePublicKey ?? '')
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) {
      session.sendError('bad-device-id', 'deviceId 格式不合法')
      return session.close(1008, 'bad device id')
    }
    if (!publicKey) {
      session.sendError('bad-device-key', '缺少 devicePublicKey')
      return session.close(1008, 'missing device key')
    }

    const existing = this.store.device(deviceId)
    let pairAccepted = false

    if (!existing) {
      // A brand new device needs the pairing secret, and the computer must not
      // already be bound to another phone.
      if (this.store.devices.length >= MAX_DEVICES) {
        session.sendError(
          'too-many-devices',
          `此电脑已绑定 ${this.store.devices.length} 台设备（上限 ${MAX_DEVICES} 台）。请先在电脑端解除不用的设备。`,
        )
        return session.close(1008, 'too many devices')
      }
      const presented = String(frame.pairSecret ?? '')
      if (!presented) {
        session.sendError('pairing-required', '需要绑定：请扫描电脑上的二维码')
        return session.close(1008, 'pairing required')
      }
      const consumed = this.store.consumePairingSecret(presented)
      if (!consumed.ok) {
        const reasons = {
          'no-window': '电脑上没有正在进行的绑定窗口，请重新生成二维码',
          expired: '二维码已过期，请在电脑上重新生成',
          mismatch: '绑定密钥不正确，请重新扫码',
          used: '该二维码已被使用过，请重新生成',
        }
        session.sendError('pairing-rejected', reasons[consumed.reason] ?? '绑定被拒绝')
        return session.close(1008, 'pairing rejected')
      }
      this.store.bindDevice({ deviceId, deviceName: String(frame.deviceName ?? '手机'), publicKey })
      pairAccepted = true
      this.log(`pairing: accepted device ${deviceId}`)
    } else {
      // Known device: verify it still holds the private key it was bound with.
      //
      // The signed string uses the *client's* nonce. That is the only choice that
      // works for a plain reconnect: the client must sign something before it has
      // heard anything from the computer, and the computer has nothing to send it
      // that is not itself unauthenticated. Replay of a captured hello is stopped
      // by the nonce guard below, not by trusting a client timestamp.
      const nonce = String(frame.nonce ?? '')
      if (nonce.length < 16 || nonce.length > 256) {
        session.sendError('bad-nonce', 'hello 缺少 nonce（或长度不合法）')
        return session.close(1008, 'bad nonce')
      }
      const signature = String(frame.signature ?? '')
      if (!signature || !this.store.verifyDeviceSignature(deviceId, helloSignatureMessage(nonce), signature)) {
        session.sendError('bad-signature', '设备密钥验证失败，请重新绑定')
        return session.close(1008, 'bad signature')
      }
      if (!this.nonces.use(deviceId, nonce)) {
        session.sendError('replayed-nonce', '检测到重复的握手随机数，已拒绝本次连接')
        return session.close(1008, 'replayed nonce')
      }
      this.store.bindDevice({
        deviceId,
        deviceName: String(frame.deviceName ?? existing.deviceName),
        publicKey: existing.publicKey,
      })
    }

    session.deviceId = deviceId
    session.authenticated = true
    session.capabilities = new Set(
      Array.isArray(frame.capabilities) ? frame.capabilities.filter(capability => typeof capability === 'string') : [],
    )
    // 每台设备的会话绑定：已有绑定直接用，新设备首次绑定则新建一个会话。
    session.sessionId = await this.#ensureDeviceSession(deviceId)
    clearTimeout(session.helloDeadline)

    // Racing two endpoints means two handshakes with the same deviceId arrive
    // almost together; both must stay alive (the loser is closed by the client).
    // Only when a device accumulates more than MAX_SESSIONS_PER_DEVICE do we
    // retire the oldest connection, so a disconnect never leaves a dead socket.
    const evicted = this.#addDeviceSession(session)
    for (const stale of evicted) stale.close(1000, 'replaced by a newer connection')

    // The proof echoes the nonce this hello presented, so a phone that bound
    // through the QR can verify the ack against the computer's public key (`pk`)
    // from that same QR. A first-time pairing has no nonce to echo, so the ack
    // carries the computer's own fresh one and is only meaningful as a heartbeat.
    const ackNonce = String(frame.nonce ?? session.nonce)
    const endpoints = this.#reachableEndpoints()
    const endpointUrls = endpoints.length > 0 ? endpoints.map(endpoint => endpoint.url) : this.#endpointUrls()
    const conversationId = session.sessionId
    const log = this.#log(conversationId)
    session.send({
      t: SERVER_FRAME.HELLO_ACK,
      version: PROTOCOL_VERSION,
      serverVersion: this.serverVersion,
      computerId: this.store.computerId,
      computerName: this.store.computerName,
      computerFingerprint: this.store.fingerprint,
      paired: true,
      pairAccepted,
      nonce: ackNonce,
      // Signed challenge so the phone can prove it is talking to the computer it
      // paired with, not to a man in the middle replaying the tunnel URL.
      proof: this.store.sign(helloAckProofMessage(ackNonce, deviceId)),
      heartbeatMs: this.heartbeatMs,
      serverTime: new Date().toISOString(),
      capabilities: [...ALL_CAPABILITIES],
      sessionId: conversationId,
      sessionEpoch: this.sessionEpoch,
      eventCursor: log.head,
      connectionMode: this.#mode(),
      endpoints: endpointUrls,
      endpointList: endpoints,
    })

    const device = this.store.device(deviceId)
    session.send({
      t: SERVER_FRAME.ASSISTANTS,
      assistants: this.store.devices.map(d => ({
        id: d.id,
        name: d.label ?? d.deviceName,
        fingerprint: this.store.fingerprint,
        online: true,
        pairedAt: d.pairedAt,
      })),
      power: this.store.getPreference('power.allowShutdown', true)
        ? { allowed: ['shutdown', 'restart', 'cancel'] }
        : { allowed: ['cancel'] },
    })

    // Conversation sync: snapshot first (no cursor), replay when the client says
    // how far it got and that position is still inside the log window.
    //
    // A client that believes it is in a *different* conversation (it selected
    // another session elsewhere) must never be caught up with events from this
    // one: its cursor was issued by another session's log, so only a full
    // snapshot is correct.
    if (session.hasCap(CAPABILITIES.SESSION_SYNC)) {
      const cursor = Number.isFinite(frame.cursor) ? Math.max(0, Math.floor(Number(frame.cursor))) : undefined
      const believedSession = typeof frame.sessionId === 'string' && frame.sessionId !== '' ? frame.sessionId : undefined
      const sessionChanged = believedSession !== undefined && believedSession !== conversationId
      if (sessionChanged || cursor === undefined) await this.#deliverSessionState(session)
      else this.#deliverSessionEvents(session, cursor)
      if (sessionChanged) {
        this.log(`sync: 客户端认为的会话 ${believedSession} 与当前 ${conversationId} 不一致，已发全量快照`)
      }
    }

    this.gatewayEvents.emit('device-online', { deviceId, sessionId: session.id, computerId: this.store.computerId })
    this.log(`auth: device ${deviceId} connected as ${device?.label ?? device?.deviceName} session=${conversationId}`)
  }

  /**
   * Called by a Session when its socket closes.
   * @param {Session} session
   */
  handleSessionClosed(session) {
    const closeInfo = session.closeCode !== undefined
      ? ` code=${session.closeCode} reason=${session.closeReason || '-'}`
      : ' 未收到 CLOSE 帧（网络断开/进程被杀）'
    this.log(`ws: ${session.id} 断开（device=${session.deviceId ?? '-'}）${closeInfo}`)
    this.sessions.delete(session)
    if (!session.deviceId) return
    this.#removeDeviceSession(session)
    if (!this.deviceOnline(session.deviceId)) {
      this.gatewayEvents.emit('device-offline', { deviceId: session.deviceId, sessionId: session.id })
    }
  }

  /** @param {Session} session @param {any} frame */
  async #handleChatSend(session, frame) {
    const deviceId = /** @type {string} */ (session.deviceId)
    const callId = String(frame.callId ?? frame.rid ?? '')
    // The idempotency key. v2.2.0 clients send `msgId`; a v2.1.0 client falls back
    // to its `callId`/`rid`, which is exactly what it retries with.
    const msgId = normalizeMessageId(frame.msgId) || normalizeMessageId(frame.callId) || normalizeMessageId(frame.rid)
    this.log(`chat: 收到消息 rid=${frame.rid} callId=${callId} msgId=${msgId} 文本长度=${typeof frame.text === 'string' ? frame.text.length : 0} 附件=${Array.isArray(frame.files) ? frame.files.length : 0}`)
    if (!callId) {
      this.log('chat: 缺少 callId，拒绝')
      return session.sendError('bad-frame', 'chat/send 缺少 callId')
    }
    if (!msgId) {
      return session.sendError('bad-frame', 'chat/send 缺少 msgId/callId')
    }

    // The phone's outbox deliberately re-sends a message it never saw an ack for.
    // Answer with the same success ack and do NOT touch the assistant again —
    // unless the first attempt was rejected by the bridge, in which case the
    // retry must actually be delivered (the phone keeps the message queued until
    // it gets a successful ack *and* a failed turn still needs to reach the model).
    const key = dedupeKey(deviceId, msgId)
    const prior = this.dedupe.get(key)

    const text = typeof frame.text === 'string' ? frame.text : ''
    const files = Array.isArray(frame.files) ? frame.files : []
    if (!text.trim() && files.length === 0) {
      this.log('chat: 内容为空，拒绝')
      return session.sendError('empty-message', '消息内容为空')
    }
    if (text.length > MAX_TEXT_LENGTH) {
      this.log(`chat: 消息过长 ${text.length} 字符，拒绝`)
      return session.sendError('too-long', '消息过长，请拆分后发送')
    }
    if (files.length > MAX_UPLOAD_ATTACHMENTS) {
      return session.sendError('too-many-attachments', `每条消息最多 ${MAX_UPLOAD_ATTACHMENTS} 个附件`)
    }

    // A replay of an already accepted (and delivered) message stops here, before any
    // attachment work is repeated.
    if (prior && !prior.failed) {
      this.log(`chat: 重复消息 msgId=${msgId}，回 duplicate ack（不再投递）`)
      session.send({ t: SERVER_FRAME.CHAT_ACK, rid: frame.rid, callId, msgId, duplicate: true })
      return undefined
    }

    // Resolve attachments *before* claiming the idempotency slot: a message that
    // references a broken upload must not burn its msgId.
    /** @type {Array<{name: string, mime?: string, size?: number, dataBase64?: string, path?: string, fileId?: string}>} */
    const stored = []
    for (const attachment of files) {
      const resolved = await this.#resolveAttachment(deviceId, attachment)
      if (!resolved.ok) {
        this.log(`chat: 附件不可用 → ${resolved.message}`)
        return session.sendError(resolved.code, resolved.message)
      }
      if (resolved.attachment) stored.push(resolved.attachment)
    }

    // Claim the message, then acknowledge "accepted": the ack no longer waits for
    // the bridge (which may need seconds to resume the DSH conversation), which is
    // what made the phone retry and the assistant answer twice.
    this.#rememberDedupe(key, { callId, msgId })
    session.send({
      t: SERVER_FRAME.CHAT_ACK,
      rid: frame.rid,
      callId,
      msgId,
      ...(prior?.failed ? { duplicate: true } : {}),
    })

    const conversationId = /** @type {string} */ (session.sessionId)
    if (!prior?.failed) {
      // Only the first attempt appends an echo: a retry of a failed delivery must
      // not duplicate the bubble in every other device's chat. `chat/echo` now
      // only serves the same device's other sockets (two tabs, endpoint race).
      const echo = this.#appendEvent(conversationId, {
        t: SERVER_FRAME.CHAT_ECHO,
        msgId,
        rid: frame.rid,
        callId,
        deviceId,
        text,
        files: stored.map(attachment => ({
          ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
          name: attachment.name,
          size: attachment.size ?? 0,
          ...(attachment.mime ? { mime: attachment.mime } : {}),
        })),
        at: new Date().toISOString(),
      })
      // 只回给同一设备的其它 socket：`chat/echo` 现在用于同一台手机的多窗口/
      // 竞速连接去重，协作语义已不存在，另一台设备即使绑到同一会话也不该收到。
      this.#broadcastToDevice(deviceId, echo)
    }

    try {
      await this.bridge.send({ deviceId, sessionId: conversationId, callId, text, attachments: stored })
    } catch (error) {
      // Keep a "failed" marker instead of dropping the claim: a retry gets the
      // duplicate ack it expects (so its outbox clears) AND is delivered again,
      // so one transient DSH error cannot permanently swallow the message.
      this.#rememberDedupe(key, { callId, msgId, failed: true })
      const message = /** @type {Error} */ (error).message
      this.log(`chat: 投递失败 rid=${frame.rid} msgId=${msgId} → ${message}`)
      return session.sendError('send-failed', `消息未能送达电脑上的 AI：${message}`)
    }

    // A successfully delivered retry is a normal accepted message from now on.
    if (prior?.failed) this.#rememberDedupe(key, { callId, msgId })
    this.log(`chat: 投递成功 rid=${frame.rid} msgId=${msgId}`)
    return undefined
  }

  /**
   * Turn a `chat/send.files[]` entry into a real on-disk attachment.
   *
   * v2.2.0 references a completed `upload/*` by `uploadId`; the legacy inline
   * `dataBase64` shape is still accepted for a v2.1.0 client.
   * @param {string} deviceId
   * @param {any} attachment
   */
  async #resolveAttachment(deviceId, attachment) {
    if (!attachment || typeof attachment !== 'object') {
      return { ok: false, code: 'bad-frame', message: '附件格式不合法' }
    }
    if (typeof attachment.uploadId === 'string' && attachment.uploadId !== '') {
      const state = this.uploads.completed(attachment.uploadId, deviceId)
      if (!state) {
        return { ok: false, code: 'upload-not-found', message: '附件尚未上传完成（或已过期），请重新发送' }
      }
      return {
        ok: true,
        attachment: {
          name: state.name,
          mime: state.mime,
          size: state.size,
          path: state.path,
          fileId: state.fileId,
        },
      }
    }
    if (typeof attachment.dataBase64 === 'string') {
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      if (bytes.length > MAX_INLINE_ATTACHMENT_BYTES) {
        return { ok: false, code: 'too-large', message: '附件过大' }
      }
      const name = sanitizeFileName(attachment.name ?? 'upload.bin')
      try {
        const dir = this.uploads.directory()
        await mkdir(dir, { recursive: true })
        const path = join(dir, `${Date.now()}-${randomBytes(3).toString('hex')}-${name}`)
        await writeFile(path, bytes)
        // 旧版内联附件同样要能变成可下载的文件卡片：给它一个稳定的 fileId 并登记
        // 到本网关的文件表，`file/fetch` 才能把它分块发回手机。
        const fileId = `f_${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`
        this.offeredFiles.set(fileId, { name, path, mime: attachment.mime, size: bytes.length })
        return {
          ok: true,
          attachment: { name, mime: attachment.mime, size: bytes.length, path, fileId, dataBase64: attachment.dataBase64 },
        }
      } catch (error) {
        this.log(`upload: failed to store attachment: ${/** @type {Error} */ (error).message}`)
        return { ok: false, code: 'io-error', message: '附件保存失败' }
      }
    }
    // An entry with neither shape is ignored rather than failing the whole message.
    return { ok: true, attachment: null }
  }

  /** @param {Session} session @param {any} frame */
  #handleSessionSync(session, frame) {
    if (!session.hasCap(CAPABILITIES.SESSION_SYNC)) return undefined
    const cursor = Number.isFinite(frame.cursor) ? Math.max(0, Math.floor(Number(frame.cursor))) : undefined
    if (cursor === undefined) void this.#deliverSessionState(session)
    else this.#deliverSessionEvents(session, cursor)
    return undefined
  }

  // ---------------------------------------------------------------------------
  // 会话列表 / 选择 / 新建（v2.3.0）
  // ---------------------------------------------------------------------------

  /**
   * `session/list`：把电脑上的 DSH 会话列给手机。
   * @param {Session} session
   * @param {any} frame
   */
  async #handleSessionList(session, frame) {
    if (!session.hasCap(CAPABILITIES.SESSIONS)) return undefined
    const deviceId = /** @type {string} */ (session.deviceId)
    const current = session.sessionId ?? ''
    let result = { sessions: [], truncated: false }
    try {
      result = await (this.bridge.listSessions?.() ?? result)
    } catch (error) {
      this.log(`session: 列出会话失败：${/** @type {Error} */ (error).message}`)
      session.sendError('session-list-failed', `无法列出电脑上的会话：${/** @type {Error} */ (error).message}`)
      return undefined
    }
    const sessions = (Array.isArray(result?.sessions) ? result.sessions : []).map(summary => ({
      ...summary,
      ...(summary.id === current ? { current: true } : {}),
    }))
    session.send({
      t: SERVER_FRAME.SESSIONS,
      rid: frame.rid,
      current: this.deviceSession.get(deviceId) ?? current,
      sessions,
      ...(result?.truncated ? { truncated: true } : {}),
    })
    return undefined
  }

  /**
   * `session/select`：把这台设备绑定到已有会话，并推新会话的快照。
   * @param {Session} session
   * @param {any} frame
   */
  async #handleSessionSelect(session, frame) {
    if (!session.hasCap(CAPABILITIES.SESSIONS)) return undefined
    const deviceId = /** @type {string} */ (session.deviceId)
    const requested = String(frame.sessionId ?? '')
    const result = await this.#switchSession(deviceId, session, async () => this.bridge.selectSession?.(requested) ?? {
      ok: false,
      error: 'unavailable',
      message: '电脑端不支持选择会话',
    })
    session.send({
      t: SERVER_FRAME.SESSION_SELECTED,
      rid: frame.rid,
      ...result,
    })
    if (result.ok) await this.#deliverSessionState(session)
    return undefined
  }

  /**
   * `session/create`：新建一个 DSH 会话并把这台设备绑过去。
   * @param {Session} session
   * @param {any} frame
   */
  async #handleSessionCreate(session, frame) {
    if (!session.hasCap(CAPABILITIES.SESSIONS)) return undefined
    const deviceId = /** @type {string} */ (session.deviceId)
    const result = await this.#switchSession(deviceId, session, async () => this.bridge.createSession?.() ?? {
      ok: false,
      error: 'unavailable',
      message: '电脑端不支持新建会话',
    })
    session.send({
      t: SERVER_FRAME.SESSION_SELECTED,
      rid: frame.rid,
      ...result,
    })
    if (result.ok) await this.#deliverSessionState(session)
    return undefined
  }

  /**
   * `session/watch`：订阅后台标签页的事件（会话像桌面侧边栏一样常驻）。
   * 只在这些会话上发事件，不会改变当前活跃会话；空数组表示全部退订。
   * @param {Session} session
   * @param {any} frame
   */
  #handleSessionWatch(session, frame) {
    if (!session.hasCap(CAPABILITIES.SESSION_TABS)) return undefined
    const deviceId = /** @type {string} */ (session.deviceId)
    const watched = this.#setWatch(deviceId, frame.sessionIds, session.sessionId ?? undefined)
    this.log(`session: 设备 ${deviceId} 订阅后台标签 ${watched.length} 个`)
    return undefined
  }

  /**
   * `session/snapshot`：取某个标签页的状态，但**不切换**当前活跃会话。
   * 客户端点击标签时先渲染本地缓存，再用这帧补齐电脑上的最新状态。
   * @param {Session} session
   * @param {any} frame
   */
  async #handleSessionSnapshot(session, frame) {
    if (!session.hasCap(CAPABILITIES.SESSION_TABS)) return undefined
    const requested = String(frame.sessionId ?? '')
    if (requested === '') return session.sendError('bad-frame', 'session/snapshot 缺少 sessionId')
    // 只允许取自己绑定或订阅过的会话，避免手机枚举电脑上的任意会话内容。
    const allowed = requested === session.sessionId || this.#watches(/** @type {string} */ (session.deviceId), requested)
    if (!allowed) return session.sendError('not-allowed', '这个会话不在当前标签页里')
    await this.#deliverSessionState(session, { sessionId: requested, rid: frame.rid })
    return undefined
  }

  /**
   * 执行一次会话切换：成功则更新 deviceSession、递增 sessionEpoch，并让该设备
   * 的所有 socket 都跟着换会话（多窗口/竞速连接不能各看一个会话）。
   * @param {string} deviceId
   * @param {Session} session
   * @param {() => Promise<{ok: true, sessionId: string, title?: string} | {ok: false, error: string, message: string}>} open
   * @returns {Promise<{ok: boolean, sessionId?: string, title?: string, sessionEpoch?: number, error?: string, message?: string}>}
   */
  async #switchSession(deviceId, session, open) {
    let opened
    try {
      opened = await open()
    } catch (error) {
      this.log(`session: 切换会话失败：${/** @type {Error} */ (error).message}`)
      return { ok: false, error: 'failed', message: `切换会话失败：${/** @type {Error} */ (error).message}` }
    }
    if (!opened?.ok || !opened.sessionId) {
      return {
        ok: false,
        error: opened?.error ?? 'failed',
        message: opened?.message ?? '切换会话失败',
      }
    }
    const previous = this.deviceSession.get(deviceId)
    this.#bindDeviceSession(deviceId, opened.sessionId)
    this.sessionEpoch += 1
    // 同一设备可能有多个 socket（竞速/多窗口），它们必须一起换会话。
    for (const sibling of this.sessionsForDevice(deviceId)) sibling.sessionId = opened.sessionId
    session.sessionId = opened.sessionId
    // v1.3.0：切走**不释放**旧会话的 agent。手机现在可以同时开几个标签，
    // 旧会话里的回合还在跑；把它杀掉会让「切走再切回来」变成一次静默失败。
    // 旧标签改为后台订阅，这样它的流式输出和「正在回复」仍能推到手机上。
    if (previous && previous !== opened.sessionId) {
      const watched = this.deviceWatch.get(deviceId) ?? new Set()
      watched.add(previous)
      watched.delete(opened.sessionId)
      this.deviceWatch.set(deviceId, new Set([...watched].slice(0, SESSION_WATCH_LIMIT)))
    }
    this.log(`session: 设备 ${deviceId} 切换到会话 ${opened.sessionId}（epoch=${this.sessionEpoch}）`)
    return {
      ok: true,
      sessionId: opened.sessionId,
      ...(opened.title ? { title: opened.title } : {}),
      sessionEpoch: this.sessionEpoch,
    }
  }

  /**
   * `approval/reply`：手机对一条审批请求作答。未知/不属于该设备的请求被忽略
   * （对方可能已经超时，卡片也会收到 resolved 帧）。
   * @param {Session} session
   * @param {any} frame
   */
  async #handleApprovalReply(session, frame) {
    if (!session.hasCap(CAPABILITIES.APPROVAL)) return undefined
    const approvalId = String(frame.approvalId ?? '')
    if (!approvalId) return session.sendError('bad-frame', 'approval/reply 缺少 approvalId')
    const outcome = APPROVAL_REPLY_OUTCOMES.includes(/** @type {any} */ (frame.outcome))
      ? frame.outcome
      : 'rejected'
    const accepted = this.bridge.answerApproval?.({
      approvalId,
      deviceId: /** @type {string} */ (session.deviceId),
      outcome,
    }) === true
    this.log(`approval: 收到手机作答 ${approvalId}（device=${session.deviceId} outcome=${outcome} accepted=${accepted}）`)
    if (!accepted) this.log(`approval: 忽略已失效的作答 ${approvalId}`)
    return undefined
  }

  /**
   * `question/reply`：手机对一条结构化提问作答。
   *
   * 答案校验（每个问题恰好一条、选项必须合法）在 bridge 里用协议共享的
   * `normalizeQuestionAnswers()` 完成；这里只做能力位与形状检查。
   * @param {Session} session
   * @param {any} frame
   */
  async #handleQuestionReply(session, frame) {
    if (!session.hasCap(CAPABILITIES.QUESTIONS)) return undefined
    const questionId = String(frame.questionId ?? '')
    if (!questionId) return session.sendError('bad-frame', 'question/reply 缺少 questionId')
    if (!Array.isArray(frame.answers)) return session.sendError('bad-frame', 'question/reply 缺少 answers')
    const accepted = this.bridge.answerQuestion?.({
      questionId,
      deviceId: /** @type {string} */ (session.deviceId),
      answers: frame.answers,
    }) === true
    if (!accepted) this.log(`question: 忽略无效或已过期的作答 ${questionId}`)
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Chunked uploads
  // ---------------------------------------------------------------------------

  /** @param {Session} session @param {any} frame */
  async #handleUploadStart(session, frame) {
    const result = await this.uploads.start({
      uploadId: frame.uploadId,
      deviceId: /** @type {string} */ (session.deviceId),
      name: frame.name,
      size: frame.size,
      mime: frame.mime,
      sha256: frame.sha256,
    })
    if (!result.ok) {
      session.send({
        t: SERVER_FRAME.UPLOAD_ERROR,
        uploadId: String(frame.uploadId ?? ''),
        code: result.code,
        message: result.message,
      })
      return undefined
    }
    session.send({ t: SERVER_FRAME.UPLOAD_READY, ...result.ready })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleUploadChunk(session, frame) {
    const result = await this.uploads.chunk({
      uploadId: frame.uploadId,
      deviceId: /** @type {string} */ (session.deviceId),
      seq: frame.seq,
      dataBase64: frame.dataBase64,
    })
    if (!result.ok) {
      session.send({
        t: SERVER_FRAME.UPLOAD_ERROR,
        uploadId: String(frame.uploadId ?? ''),
        code: result.code,
        message: result.message,
        ...(result.nextSeq !== undefined ? { nextSeq: result.nextSeq } : {}),
      })
      return undefined
    }
    session.send({ t: SERVER_FRAME.UPLOAD_PROGRESS, ...result.progress })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleUploadEnd(session, frame) {
    const result = await this.uploads.end({
      uploadId: frame.uploadId,
      deviceId: /** @type {string} */ (session.deviceId),
      sha256: frame.sha256,
    })
    if (!result.ok) {
      session.send({
        t: SERVER_FRAME.UPLOAD_ERROR,
        uploadId: String(frame.uploadId ?? ''),
        code: result.code,
        message: result.message,
        ...(result.nextSeq !== undefined ? { nextSeq: result.nextSeq } : {}),
      })
      return undefined
    }
    session.send({ t: SERVER_FRAME.UPLOAD_DONE, ...result.done })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleUploadCancel(session, frame) {
    // 取消不产生响应帧：客户端主动放弃，不需要再等一个结果。
    await this.uploads.cancel({
      uploadId: frame.uploadId,
      deviceId: /** @type {string} */ (session.deviceId),
    })
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Frames the assistant produced / files
  // ---------------------------------------------------------------------------

  /** 文件分片推送的 I/O 实现已移到 files.mjs。 @param {Session} session @param {any} frame */
  async #handleFileFetch(session, frame) {
    return this.files.fetch(session, frame)
  }

  /** @param {Session} session @param {any} frame */
  async #handleRename(session, frame) {
    const label = String(frame.label ?? '').slice(0, 60)
    if (!label) return session.sendError('bad-frame', '备注名不能为空')
    const deviceId = /** @type {string} */ (session.deviceId)
    this.store.updateDevice(deviceId, { label })
    session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: this.#assistantList() })
    await this.bridge.renameAssistant?.({ deviceId, label })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleDeviceRename(session, frame) {
    const deviceId = /** @type {string} */ (session.deviceId)
    const label = String(frame.label ?? '').trim()
    if (!label) return session.sendError('bad-label', '昵称不能为空')
    if (label.length > 24) return session.sendError('bad-label', '昵称最多 24 个字符')
    const updated = this.store.updateDevice(deviceId, { label })
    if (!updated) return session.sendError('device-not-found', '找不到这台设备')
    this.log(`device: ${deviceId} 昵称改为「${label}」`)
    // 顺带把新列表推回去，手机端就不用再拉一次。
    session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: this.#assistantList() })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleForget(session, frame) {
    const deviceId = /** @type {string} */ (session.deviceId)
    if (String(frame.deviceId ?? '') !== deviceId) {
      return session.sendError('forbidden', '只能解绑自己')
    }
    this.#unbindDevice(deviceId)
    this.log(`pairing: device ${deviceId} unbound itself`)
    session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: [], unbound: true })
    session.close(1000, 'device unbound')
    return undefined
  }

  /**
   * 解除一台设备的绑定：信任立刻失效，同时清掉它的会话绑定；如果那个会话没有
   * 别的设备在用，就释放它的 agent（会话历史已持久化）。
   * @param {string} deviceId
   */
  #unbindDevice(deviceId) {
    const sessionId = this.deviceSession.get(deviceId)
    const watched = this.deviceWatch.get(deviceId)
    this.deviceWatch.delete(deviceId)
    this.deviceSession.delete(deviceId)
    try {
      this.store.setPreference('deviceSession', Object.fromEntries(this.deviceSession))
    } catch (error) {
      this.log(`session: 清理设备会话绑定失败：${/** @type {Error} */ (error).message}`)
    }
    this.store.unbindDevice(deviceId)
    this.log(`pairing: device ${deviceId} unbound from desktop page`)
    // 解绑是把设备真正送走：它绑定和订阅过的会话，如果没别的设备在用，
    // 就把 agent 释放掉（切换标签不会走到这里，那是 v1.3.0 刻意保留的）。
    for (const id of new Set([sessionId, ...(watched ?? [])])) {
      if (!id) continue
      if (this.devicesInSession(id).length === 0) {
        this.bridge.releaseSession?.(id)?.catch?.(() => {})
      }
    }
  }

  /** @param {Session} session @param {any} frame */
  async #handlePower(session, frame) {
    const action = String(frame.action ?? '')
    // `wake` is a distinct capability: shutdown/restart act on this running
    // machine, while wake sends a magic packet to a target that is off. A wake
    // is never blocked by the shutdown policy.
    if (!['shutdown', 'restart', 'cancel', 'wake'].includes(action)) {
      return session.send({
        t: SERVER_FRAME.POWER_STATE,
        rid: frame.rid,
        action,
        accepted: false,
        reason: POWER_REFUSAL.FAILED,
        message: `不支持的操作：${action}`,
      })
    }
    if (action !== 'cancel' && action !== 'wake' && this.store.getPreference('power.allowShutdown', true) === false) {
      return session.send({
        t: SERVER_FRAME.POWER_STATE,
        rid: frame.rid,
        action,
        accepted: false,
        reason: POWER_REFUSAL.DISABLED_BY_POLICY,
        message: '电脑端已禁止远程关机/重启',
      })
    }
    const handler = action === 'wake' ? this.bridge.wake : this.bridge.power
    if (!handler) {
      return session.send({
        t: SERVER_FRAME.POWER_STATE,
        rid: frame.rid,
        action,
        accepted: false,
        reason: POWER_REFUSAL.UNSUPPORTED_PLATFORM,
        message: action === 'wake'
          ? '未配置唤醒代理：电脑已关机时，必须由同一局域网内一台常开设备代发唤醒包'
          : '当前电脑不支持远程电源操作',
      })
    }
    const result = await handler({
      deviceId: /** @type {string} */ (session.deviceId),
      action,
      delaySeconds: frame.delaySeconds,
      mac: frame.mac,
      targetId: frame.targetId,
    })
    session.send({ t: SERVER_FRAME.POWER_STATE, rid: frame.rid, action, ...result })
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Bridge → phones: per-conversation broadcast
  // ---------------------------------------------------------------------------

  /**
   * Push a bridge event. 会话级帧发给绑定该会话的**所有**设备（同一台手机的多
   * socket 也都在内），审批帧只发给声明了 `approval-v1` 的设备。事件日志只保留
   * 可重放的聊天事件。
   * @param {{kind: string, sessionId?: string, deviceId?: string, callId?: string, [key: string]: unknown}} event
   */
  pushEvent(event) {
    const deviceId = typeof event.deviceId === 'string' ? event.deviceId : ''
    const conversationId = typeof event.sessionId === 'string' && event.sessionId !== '' ? event.sessionId : ''
    if (!conversationId) return false

    switch (event.kind) {
      case 'typing': {
        const frame = { t: SERVER_FRAME.TYPING, callId: event.callId, active: event.active !== false }
        return this.#broadcastToConversation(conversationId, frame) > 0
      }
      case 'user-message': {
        // 桌面端发起的用户消息：实时同步到手机上（手机自己的消息由本地乐观气泡 +
        // chat/echo 负责，不会走这里）。
        const messageId = String(event.messageId ?? '')
        if (messageId === '') return false
        const frame = {
          t: SERVER_FRAME.CHAT_ECHO,
          msgId: `dsh_${messageId}`,
          text: String(event.text ?? ''),
          files: [],
          at: new Date(Number.isFinite(Number(event.at)) ? Number(event.at) : Date.now()).toISOString(),
        }
        const recorded = this.#appendEvent(conversationId, frame)
        return this.#broadcastToConversation(conversationId, recorded) > 0
      }
      case 'message': {
        const text = String(event.text ?? '')
        const index = Number.isFinite(event.index) ? Number(event.index) : 0
        const frame = {
          t: SERVER_FRAME.CHAT_MESSAGE,
          callId: event.callId,
          messageId: event.messageId ?? `msg_${index}`,
          index,
          text,
        }
        const recorded = this.#appendEvent(conversationId, frame)
        this.#trackActiveCall(conversationId, event.callId, text, 'block')
        // A v2.1.0 client has no chat-message-v1 capability and keeps receiving
        // append-only deltas, exactly like before.
        const fallback = () => ({ t: SERVER_FRAME.CHAT_DELTA, callId: event.callId, seq: index, text })
        const delivered = this.#broadcastWithFallback(conversationId, recorded, CAPABILITIES.CHAT_MESSAGE, fallback)
        return delivered > 0
      }
      case 'delta': {
        const text = String(event.text ?? '')
        const frame = { t: SERVER_FRAME.CHAT_DELTA, callId: event.callId, seq: event.seq ?? 0, text }
        this.#trackActiveCall(conversationId, event.callId, text, 'inline')
        return this.#broadcastToConversation(conversationId, frame) > 0
      }
      case 'done': {
        const { text, truncated } = clampAssistantText(String(event.text ?? ''))
        const frame = {
          t: SERVER_FRAME.CHAT_DONE,
          callId: event.callId,
          text,
          truncated: truncated || Boolean(event.truncated),
          durationMs: event.durationMs,
          files: Array.isArray(event.files) ? event.files : undefined,
        }
        const recorded = this.#appendEvent(conversationId, frame)
        this.activeCalls.delete(conversationId)
        return this.#broadcastToConversation(conversationId, recorded) > 0
      }
      case 'tool':
        return this.#broadcastToConversation(conversationId, {
          t: SERVER_FRAME.TOOL,
          callId: event.callId,
          phase: event.phase,
          toolCallId: event.toolCallId,
          tool: event.tool,
          summary: event.summary,
          ok: event.ok,
        }) > 0
      case 'error': {
        const frame = {
          t: SERVER_FRAME.CHAT_ERROR,
          callId: event.callId,
          message: String(event.message ?? '处理失败'),
          retryable: event.retryable !== false,
        }
        this.activeCalls.delete(conversationId)
        return this.#broadcastToConversation(conversationId, frame) > 0
      }
      case 'assistants': {
        const sessions = this.sessionsForDevice(deviceId)
        if (sessions.length === 0) return false
        let delivered = 0
        for (const session of sessions) {
          if (session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: this.#assistantList() })) delivered += 1
        }
        return delivered > 0
      }
      case 'approval-ask': {
        const frame = {
          t: SERVER_FRAME.APPROVAL_ASK,
          approvalId: event.approvalId,
          toolName: event.toolName,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          ...(event.displayReason !== undefined ? { displayReason: event.displayReason } : {}),
          ...(event.callId !== undefined ? { callId: event.callId } : {}),
          ...(event.onDesktop === true ? { onDesktop: true } : {}),
        }
        const delivered = this.#broadcastToConversation(conversationId, frame, {
          requireCapability: CAPABILITIES.APPROVAL,
        })
        this.log(`approval: 推送 ${event.approvalId} → 会话 ${conversationId}，送达设备 ${delivered} 台`)
        return delivered > 0
      }
      case 'approval-resolved':
        return this.#broadcastToConversation(conversationId, {
          t: SERVER_FRAME.APPROVAL_RESOLVED,
          approvalId: event.approvalId,
          outcome: event.outcome,
          ...(event.source !== undefined ? { source: event.source } : {}),
        }, { requireCapability: CAPABILITIES.APPROVAL }) > 0
      case 'question-ask':
        return this.#broadcastToConversation(conversationId, {
          t: SERVER_FRAME.QUESTION_ASK,
          questionId: event.questionId,
          items: Array.isArray(event.items) ? event.items : [],
          ...(event.callId !== undefined ? { callId: event.callId } : {}),
          expiresAt: event.expiresAt,
          ...(event.canAnswerLate === true ? { canAnswerLate: true } : {}),
        }, { requireCapability: CAPABILITIES.QUESTIONS }) > 0
      case 'question-resolved':
        return this.#broadcastToConversation(conversationId, {
          t: SERVER_FRAME.QUESTION_RESOLVED,
          questionId: event.questionId,
          outcome: event.outcome,
          ...(event.source !== undefined ? { source: event.source } : {}),
        }, { requireCapability: CAPABILITIES.QUESTIONS }) > 0
      default:
        return false
    }
  }

  /** Broadcast a bridge event to every connected device (used for shutdown notices). */
  broadcast(event) {
    let delivered = 0
    const seenConversations = new Set()
    for (const session of this.sessions) {
      if (!session.authenticated) continue
      // pushEvent already fans out per conversation; one call per conversation is
      // enough even when a device holds several sessions.
      const key = session.sessionId ?? session.deviceId
      if (key && seenConversations.has(key)) continue
      if (key) seenConversations.add(key)
      if (this.pushEvent({ ...event, deviceId: /** @type {string} */ (session.deviceId) })) delivered += 1
    }
    return delivered
  }

  // ---------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------

  /**
   * @param {string} conversationId
   * @returns {SessionEventLog}
   */
  #log(conversationId) {
    let log = this.eventLogs.get(conversationId)
    if (!log) {
      log = new SessionEventLog()
      this.eventLogs.set(conversationId, log)
    }
    return log
  }

  /**
   * Append a durable event and return it with its `seq`.
   * @param {string} conversationId
   * @param {any} frame
   */
  #appendEvent(conversationId, frame) {
    return this.#log(conversationId).append(frame)
  }

  /**
   * @param {string} conversationId
   * @param {any} frame
   * @param {{requireCapability?: string, skipDeviceId?: string}} [options]
   * @returns {number} how many sessions received it
   */
  #broadcastToConversation(conversationId, frame, options = {}) {
    let delivered = 0
    // v1.3.0：每个会话帧都带 sessionId，客户端据此把事件放进对应标签页；
    // 后台标签（watched）也收，这样没切过去也能看到「正在回复」和未读数。
    const tagged = frame.sessionId === conversationId ? frame : { ...frame, sessionId: conversationId }
    for (const session of this.sessions) {
      if (!session.authenticated) continue
      const bound = session.sessionId === conversationId
      if (!bound && !this.#watches(session.deviceId, conversationId)) continue
      if (options.skipDeviceId && session.deviceId === options.skipDeviceId) continue
      if (options.requireCapability && !session.hasCap(options.requireCapability)) continue
      if (session.send(tagged)) delivered += 1
    }
    return delivered
  }

  /**
   * Send one frame shape to capable clients and a fallback shape to legacy ones.
   * @param {string} conversationId
   * @param {any} frame
   * @param {string} capability
   * @param {(session: Session) => any} fallback
   * @returns {number}
   */
  #broadcastWithFallback(conversationId, frame, capability, fallback) {
    let delivered = 0
    const tagged = frame.sessionId === conversationId ? frame : { ...frame, sessionId: conversationId }
    for (const session of this.sessions) {
      if (!session.authenticated) continue
      const bound = session.sessionId === conversationId
      if (!bound && !this.#watches(session.deviceId, conversationId)) continue
      const payload = session.hasCap(capability) ? tagged : fallback(session)
      if (payload && session.send(payload)) delivered += 1
    }
    return delivered
  }

  /**
   * Send one frame to every live socket of one device (multi-tab / endpoint race).
   * @param {string} deviceId
   * @param {any} frame
   * @returns {number}
   */
  #broadcastToDevice(deviceId, frame) {
    let delivered = 0
    for (const session of this.sessionsForDevice(deviceId)) {
      if (!session.authenticated) continue
      if (session.send(frame)) delivered += 1
    }
    return delivered
  }

  /** @param {Session} session */
  async #deliverSessionState(session, options = {}) {
    const conversationId = options.sessionId ?? session.sessionId
    if (!conversationId) return
    const log = this.#log(conversationId)
    const active = this.activeCalls.get(conversationId)
    const messages = await this.#snapshotMessages(conversationId, log)
    session.send({
      t: SERVER_FRAME.SESSION_STATE,
      ...(options.rid ? { rid: options.rid } : {}),
      sessionId: conversationId,
      ...(options.title ? { title: options.title } : {}),
      ...(options.sessionId ? { active: options.sessionId === session.sessionId } : {}),
      sessionEpoch: this.sessionEpoch,
      head: log.head,
      snapshot: {
        messages,
        ...(active ? { activeCall: { callId: active.callId, text: active.text, typing: active.typing !== false } } : {}),
      },
    })
    this.#replayPendingApprovals(session, conversationId)
  }

  /**
   * 重发一个会话里还在等答复的审批。
   *
   * 审批卡是常驻的（电脑端不再超时交回桌面），所以页面刷新 / 重连 / 切回标签后
   * 必须能把还没答的卡片再推一次；否则手机看着空白、电脑那边工具调用一直挂着。
   * 客户端按 approvalId 幂等合并，重发不会多出一张卡。
   * @param {Session} session
   * @param {string} conversationId
   */
  #replayPendingApprovals(session, conversationId) {
    if (!session.hasCap(CAPABILITIES.APPROVAL)) return
    let pending = []
    try {
      pending = this.bridge.pendingApprovals?.(conversationId) ?? []
    } catch (error) {
      this.log(`approval: 读取待答审批失败：${/** @type {Error} */ (error).message}`)
      return
    }
    for (const approval of pending) {
      session.send({
        t: SERVER_FRAME.APPROVAL_ASK,
        sessionId: conversationId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
        ...(approval.displayReason !== undefined ? { displayReason: approval.displayReason } : {}),
        ...(approval.callId !== undefined ? { callId: approval.callId } : {}),
        ...(approval.onDesktop === true ? { onDesktop: true } : {}),
      })
    }
  }

  /**
   * 快照消息 = 会话日志里的历史 + 本进程收到但日志里还没有的增量。
   *
   * 历史来自 `bridge.historyMessages()`（`ctx.sessionQuery.readSession()`）；
   * 读不到历史时整份退回进程内日志，绝不抛。两边会有重叠（一条手机消息既写进
   * 会话日志又写进本进程日志），所以按 `kind + text` 做**计数式**去重：日志里
   * 出现 n 次就抵掉 n 条历史，重复内容不会被误删，刚发出尚未提交的消息也不会
   * 丢。
   * @param {string} conversationId
   * @param {SessionEventLog} log
   * @returns {Promise<Array<any>>}
   */
  async #snapshotMessages(conversationId, log) {
    const incremental = log.snapshot()
    let history = []
    try {
      history = (await this.bridge.historyMessages?.(conversationId)) ?? []
    } catch (error) {
      this.log(`session: 读取历史失败（退回进程内日志）：${/** @type {Error} */ (error).message}`)
      history = []
    }
    return mergeSnapshotMessages(Array.isArray(history) ? history : [], incremental, SESSION_SNAPSHOT_LIMIT)
  }

  /**
   * @param {Session} session
   * @param {number} cursor
   */
  #deliverSessionEvents(session, cursor) {
    const conversationId = session.sessionId
    if (!conversationId) return
    const log = this.#log(conversationId)
    const events = log.eventsSince(cursor)
    if (!events) {
      // The cursor fell out of the retention window: a full snapshot is the only
      // correct answer (a partial replay would leave a hole in the chat).
      void this.#deliverSessionState(session)
      return
    }
    session.send({
      t: SERVER_FRAME.SESSION_EVENTS,
      sessionId: conversationId,
      from: cursor,
      head: log.head,
      events,
    })
  }

  /**
   * Track the assistant turn in flight so a late joiner's snapshot shows the
   * answer as it is being produced.
   * @param {string} conversationId
   * @param {any} callId
   * @param {string} text
   * @param {'block'|'inline'} mode
   */
  #trackActiveCall(conversationId, callId, text, mode) {
    const current = this.activeCalls.get(conversationId)
    if (current && current.callId === callId) {
      let merged
      if (mode === 'inline') merged = `${current.text}${text}`
      else merged = current.text ? `${current.text}\n\n${text}` : text
      this.activeCalls.set(conversationId, { callId, text: merged, typing: true })
      return
    }
    this.activeCalls.set(conversationId, { callId, text, typing: true })
  }

  #assistantList() {
    return this.store.devices.map(d => ({
      id: d.id,
      name: d.label ?? d.deviceName,
      fingerprint: this.store.fingerprint,
      online: this.deviceOnline(d.id),
      pairedAt: d.pairedAt,
    }))
  }

  // ---------------------------------------------------------------------------
  // Endpoint / connection-mode helpers
  // ---------------------------------------------------------------------------

  /** @returns {string[]} */
  #endpointUrls() {
    const raw = [...this.tunnelUrls(), ...this.lanUrls()]
      .filter(url => typeof url === 'string' && url.trim() !== '')
      .map(url => url.trim())
    return [...new Set(raw)]
  }

  /** Current connection-mode preference, validated. */
  #mode() {
    const value = this.store.getPreference('connectionMode', CONNECTION_MODE.AUTO)
    return CONNECTION_MODES.includes(/** @type {any} */ (value)) ? /** @type {string} */ (value) : CONNECTION_MODE.AUTO
  }

  /** Endpoints the phone should try, in order. Loopback only as a last resort. */
  #reachableEndpoints() {
    const urls = this.#endpointUrls()
    const mode = this.#mode()
    const ordered = orderEndpointCandidates(urls, { mode })
    if (ordered.length > 0) return ordered
    // No phone-reachable address (a single-machine development run): fall back to
    // loopback so the QR flow still works for the local test client.
    return orderEndpointCandidates(urls, { mode, allowLoopback: true })
  }

  /** Every endpoint including loopback, for diagnostics/UI. */
  #allEndpointList() {
    return orderEndpointCandidates(this.#endpointUrls(), { mode: CONNECTION_MODE.AUTO, allowLoopback: true })
  }

  /**
   * @param {Array<{url: string, kind: string}>} endpoints
   * @returns {string | undefined}
   */
  #webClientUrl(endpoints) {
    const reachable = endpoints.find(endpoint => endpoint.kind !== 'loopback') ?? endpoints[0]
    if (!reachable) return undefined
    try {
      return new URL(WEB_CLIENT_PATH, reachable.url).toString()
    } catch {
      return undefined
    }
  }

  /**
   * Web/PWA binding entries: one QR per reachable address, each carrying the
   * one-time pairing payload in the URL fragment (`#p=...`).
   *
   * Why every address instead of one: v2.2.0 only rendered the first endpoint,
   * which in `auto` mode is usually the Tailscale `100.x` address — an iPhone
   * without Tailscale connected therefore could not open the page at all
   * (reported as "iOS 扫第二个二维码打不开网页"). LAN is listed first because
   * "same Wi-Fi" is the common case; Tailscale and the tunnel follow.
   *
   * @param {Array<{url: string, kind: string}>} endpoints
   * @param {any} payload
   * @returns {Promise<Array<{kind: string, label: string, url: string, qr: any}>>}
   */
  async #webBindingEntries(endpoints, payload) {
    const order = { lan: 0, tailscale: 1, tunnel: 2, unknown: 3 }
    const labels = { lan: '局域网（同一 Wi-Fi）', tailscale: 'Tailscale（外网）', tunnel: '公网隧道', unknown: '其它地址' }
    const entries = []
    const seen = new Set()
    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint.url !== 'string' || endpoint.kind === 'loopback') continue
      let url
      try {
        // Short, scannable URL: the web client redeems `?s=<pairing secret>`
        // against the same-origin `/openwhale/pairing.json` and verifies that the
        // secret matches before using the payload. Embedding the whole payload
        // (`#p=`, ~850 chars) produced a QR that iOS Camera struggles to read and
        // made the "just scan it" flow depend on a very dense code.
        const parsed = new URL(WEB_CLIENT_PATH, endpoint.url)
        parsed.searchParams.set('s', String(payload.secret))
        url = parsed.toString()
      } catch {
        continue
      }
      if (seen.has(url)) continue
      seen.add(url)
      try {
        entries.push({
          kind: endpoint.kind,
          label: labels[endpoint.kind] ?? endpoint.kind,
          url,
          qr: await renderQrContent(url),
        })
      } catch {
        // A QR that cannot be generated must never take the whole page down.
      }
    }
    entries.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
    return entries.slice(0, 3)
  }

  /**
   * The exact payload the QR encodes. Shared by the QR routes, the page and the
   * `/openwhale` command so they can never disagree.
   * @returns {{ok: true, payload: any} | {ok: false, reason: string, message: string}}
   */
  pairingPayload(mode) {
    const availability = pairingAvailability(this.store)
    if (!availability.available) {
      return { ok: false, reason: availability.reason, message: availability.message }
    }
    /** @type {string | undefined} */
    const wanted = typeof mode === 'string' && ['lan', 'tailscale', 'tunnel'].includes(mode) ? mode : undefined
    const all = this.#reachableEndpoints()
    const endpoints = wanted ? all.filter(endpoint => endpoint.kind === wanted) : all
    if (endpoints.length === 0) {
      if (wanted) {
        const label = wanted === 'lan' ? '局域网' : wanted === 'tailscale' ? 'Tailscale' : '公网隧道'
        return {
          ok: false,
          reason: 'mode-unavailable',
          message: `当前没有可用的${label}地址：请先启用该线路（局域网监听 / Tailscale / 公网隧道）再生成二维码。`,
        }
      }
      return {
        ok: false,
        reason: 'no-endpoint',
        message: '还没有可用地址：请开启局域网监听，或先启动公网隧道。',
      }
    }
    const urls = endpoints.map(endpoint => endpoint.url)
    let secret
    let expires
    const active = this.store.activePairing
    if (active) {
      secret = active.secret
      expires = active.expires
    } else {
      // No live secret: mint one, which invalidates any earlier unused QR.
      const issued = this.store.issuePairingSecret()
      secret = issued.secret
      expires = issued.expires
    }
    return {
      ok: true,
      payload: {
        v: 1,
        p: 'openwhale',
        host: this.store.computerName,
        id: this.store.computerId,
        fp: this.store.fingerprint,
        pk: this.store.publicKeySpkiBase64Url,
        secret,
        expires,
        endpoints: urls,
        // Single-letter network kinds keep the QR small enough to scan reliably.
        epk: encodeEndpointKinds(urls),
        web: this.#webClientUrl(endpoints),
        mode: this.#mode(),
        port: this.port,
        lan: this.lanUrls()[0],
        name: this.store.computerName,
        version: this.serverVersion,
      },
    }
  }

  /**
   * `GET /openwhale/connection-mode` (read-only, remote OK) and POST (local only).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async #handleConnectionMode(req, res, url) {
    if (req.method === 'POST') {
      if (!this.#requireLocal(req, res)) return true
      let mode = url.searchParams.get('mode')
      if (!mode) {
        const body = await this.#readJsonBody(req)
        if (body.ok && body.value && typeof body.value.mode === 'string') mode = body.value.mode
      }
      if (!CONNECTION_MODES.includes(/** @type {any} */ (mode))) {
        return this.#json(res, 400, { ok: false, error: 'bad-mode', modes: CONNECTION_MODES })
      }
      this.store.setPreference('connectionMode', mode)
      this.log(`connection: 连接方式 → ${mode}`)
    } else if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' })
      res.end('请用 GET 或 POST 调用')
      return true
    }
    return this.#json(res, 200, this.connectionModeReport())
  }

  /** @returns {any} */
  connectionModeReport() {
    const endpoints = this.#reachableEndpoints()
    const all = this.#allEndpointList()
    /** @type {Record<string, string[]>} */
    const detected = { tailscale: [], lan: [], tunnel: [], loopback: [], unknown: [] }
    for (const endpoint of all) {
      const bucket = detected[endpoint.kind]
      if (bucket) bucket.push(endpoint.url)
    }
    return {
      ok: true,
      mode: this.#mode(),
      modes: [...CONNECTION_MODES],
      endpoints,
      detected,
      web: this.#webClientUrl(endpoints),
      webClientAvailable: this.webClient.available(),
    }
  }

  /**
   * `POST /openwhale/send-file` — push a file from the computer to every phone.
   * Local-only: this reads arbitrary paths inside the conversation workspace.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #handleSendFile(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
      res.end('请用 POST 调用')
      return true
    }
    if (!this.#requireLocal(req, res)) return true
    const body = await this.#readJsonBody(req)
    if (!body.ok) return this.#json(res, body.status ?? 400, { ok: false, error: body.error })
    const inputPath = String(body.value?.path ?? '').trim()
    if (!inputPath) return this.#json(res, 400, { ok: false, error: 'missing-path', message: '请填写文件路径' })

    const cwd = resolve(this.cwd())
    const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
    const rel = relative(cwd, absolute)
    // Only files inside the conversation workspace may be sent: the phone must
    // never be able to pull an arbitrary path off the computer.
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return this.#json(res, 400, {
        ok: false,
        error: 'path-outside-workspace',
        message: '只能发送本次对话工作目录内的文件',
      })
    }
    let info
    try {
      info = await stat(absolute)
    } catch {
      return this.#json(res, 404, { ok: false, error: 'not-found', message: '找不到该文件' })
    }
    if (!info.isFile()) return this.#json(res, 400, { ok: false, error: 'not-a-file', message: '只能发送文件' })
    if (info.size > MAX_FILE_BYTES) {
      return this.#json(res, 400, { ok: false, error: 'too-large', message: '文件过大' })
    }

    const name = sanitizeFileName(body.value?.name ?? basename(absolute))
    const mime = guessMimeType(name)
    const token = this.files.issueDownloadToken(absolute, name, mime)
    const url = `${DOWNLOAD_PATH}?token=${token}`
    const fileId = `f_${createHash('sha256').update(`${absolute}:${info.size}`).digest('hex').slice(0, 16)}`
    this.offeredFiles.set(fileId, { name, path: absolute, mime, size: info.size })

    // Broadcast to every authenticated device that understands file cards,
    // grouped per conversation so the event log can replay it.
    const from = this.store.computerName
    const conversations = new Set(
      [...this.sessions]
        .filter(session => session.authenticated && session.hasCap(CAPABILITIES.FILE_OFFER) && session.sessionId)
        .map(session => session.sessionId),
    )
    for (const conversationId of conversations) {
      const offered = this.#appendEvent(/** @type {string} */ (conversationId), {
        t: SERVER_FRAME.FILE_OFFERED,
        fileId,
        name,
        size: info.size,
        mime,
        url,
        from,
      })
      this.#broadcastToConversation(/** @type {string} */ (conversationId), offered, {
        requireCapability: CAPABILITIES.FILE_OFFER,
      })
    }
    this.log(`send-file: 已推送 ${name}（${info.size} 字节）给 ${conversations.size} 个会话`)
    return this.#json(res, 200, { ok: true, fileId, name, size: info.size, mime, url })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<{ok: true, value: any} | {ok: false, status: number, error: string}>}
   */
  #readJsonBody(req) {
    return new Promise(resolvePromise => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        resolvePromise(result)
      }
      req.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > MAX_JSON_BODY_BYTES) {
          finish({ ok: false, status: 413, error: 'body-too-large' })
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') return finish({ ok: true, value: {} })
        try {
          finish({ ok: true, value: JSON.parse(text) })
        } catch {
          finish({ ok: false, status: 400, error: 'bad-json' })
        }
      })
      req.on('error', () => finish({ ok: false, status: 400, error: 'bad-request' }))
    })
  }

  /**
   * Is this request coming from the computer's own browser?
   *
   * A loopback socket is not enough: when the plugin rides the DSH web server
   * through a cloudflared tunnel, the tunnel's local connector also arrives from
   * 127.0.0.1. Forwarding headers are what separate "the user at this machine"
   * from "anyone holding the tunnel URL".
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  isLocalRequest(req) {
    const address = String(req.socket?.remoteAddress ?? '')
    const loopback = address === '127.0.0.1'
      || address === '::1'
      || address === '::ffff:127.0.0.1'
    if (!loopback) return false
    const headers = req.headers ?? {}
    return !(headers['x-forwarded-for']
      || headers['x-real-ip']
      || headers['cf-connecting-ip']
      || headers['cf-ray']
      || headers['forwarded'])
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean} true when the request may proceed
   */
  #requireLocal(req, res) {
    if (this.isLocalRequest(req)) return true
    this.#json(res, 403, {
      ok: false,
      error: 'local-only',
      message: '这个操作会改变电脑或手机的状态，只允许在这台电脑的浏览器里执行。',
    })
    return false
  }

  /** 一次性 HTTP 下载的实现已移到 files.mjs。 @param {URL} url @param {import('node:http').ServerResponse} res */
  async #handleDownload(url, res) {
    return this.files.handleDownload(url, res)
  }

  /** @param {import('node:http').ServerResponse} res */
  #json(res, status, body) {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
    return true
  }

  // ---------------------------------------------------------------------------
  // The local management page
  // ---------------------------------------------------------------------------

  /**
   * 绑定页 / 插件页 HTML：模板与纯辅助都在 `page.mjs`，这里只收集渲染数据。
   * @param {{payload: any, qr: any, webEntries: Array<{kind: string, label: string, url: string, qr: any}>, webUrl: string | undefined, endpoints: Array<{url: string, kind: string}>, local: boolean}} view
   */
  #pageHtml(view) {
    return renderPageHtml(view, {
      version: PLUGIN_VERSION,
      mode: this.#mode(),
      report: this.connectionModeReport(),
      devices: this.store.devices ?? [],
      online: deviceId => this.deviceOnline(deviceId),
      presence: deviceId => this.devicePresence(deviceId),
      computerName: this.store.computerName,
      computerId: this.store.computerId,
      fingerprint: this.store.fingerprint,
      webClientAvailable: this.webClient.available(),
      port: this.port || 8787,
    })
  }
}

/**
 * 合并「会话日志历史」与「本进程增量」成一份快照消息列表。
 *
 * 历史是权威的，但刚发出、DSH 还没来得及提交的消息只存在于进程内日志里，所以
 * 必须保留增量。两者重叠的部分（同一条消息既在会话日志里又在进程日志里）用
 * `kind + text` 计数抵消：历史里出现 n 次就抵掉 n 条增量，既不会漏掉重复内容，
 * 也不会把尚未提交的新消息误删。
 * @param {Array<{id: string, kind: string, text: string, at: string}>} history
 * @param {Array<{id: string, kind: string, text: string, at: string}>} incremental
 * @param {number} limit
 * @returns {Array<any>}
 */
export function mergeSnapshotMessages(history, incremental, limit = SESSION_SNAPSHOT_LIMIT) {
  const historic = Array.isArray(history) ? history : []
  const fresh = Array.isArray(incremental) ? incremental : []
  if (historic.length === 0) return fresh.slice(-limit)
  const remaining = new Map()
  for (const message of historic) {
    const key = `${message?.kind}\u0000${message?.text}`
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const extra = []
  for (const message of fresh) {
    const key = `${message?.kind}\u0000${message?.text}`
    const count = remaining.get(key) ?? 0
    if (count > 0) {
      remaining.set(key, count - 1)
      continue
    }
    extra.push(message)
  }
  return [...historic, ...extra].slice(-limit)
}

// 绑定页的纯辅助已移到 page.mjs；保持 gateway 的公开导出不变。
export { connectionModeLabel, escapeHtml, formatFp } from './page.mjs'

/** @param {Gateway} gateway */
function buildPayload(gateway) {
  const result = gateway.pairingPayload()
  if (!result.ok) throw new Error(result.message)
  return result.payload
}

export { buildPayload, pickEndpoint, timingSafeEqual, createHash }
