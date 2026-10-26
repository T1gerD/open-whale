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
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  CONNECTION_MODE,
  CONNECTION_MODES,
  DEFAULT_HEARTBEAT_MS,
  DOWNLOAD_PATH,
  FILE_CHUNK_BYTES,
  IdempotencyCache,
  MAX_FILE_BYTES,
  MAX_UPLOAD_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  NonceReplayGuard,
  POWER_REFUSAL,
  PROTOCOL_VERSION,
  SERVER_FRAME,
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
import { MAX_DEVICES } from './state.mjs'
import { UploadManager, guessMimeType, sanitizeFileName } from './upload.mjs'
import { WebClientServer, webClientCandidates } from './webchat.mjs'
import { acceptUpgrade, validateUpgrade } from './ws.mjs'

/** Path the phone opens its WebSocket on. */
export const WS_PATH = '/openwhale/ws'

/** This build's plugin version (the wire protocol version lives in protocol.mjs). */
export const PLUGIN_VERSION = '2.2.0'

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

/** Bodies we accept on the small JSON management routes (send-file etc.). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * @typedef {object} Bridge
 * The DSH-facing half. The gateway never imports DSH packages directly, which
 * is what keeps the wire protocol testable without a harness.
 * @property {(input: {deviceId: string, callId: string, text: string, speaker?: string, attachments: Array<{name: string, mime?: string, size?: number, path?: string, dataBase64?: string, fileId?: string}>}) => Promise<void>} send
 *           Deliver a user message into the device's assistant conversation.
 * @property {(callId: string, deviceId?: string) => void} [cancel]
 * @property {() => Promise<Array<{fileId: string, name: string, size: number, mime?: string, path?: string}>>} [listFiles]
 *           Files the assistant produced that the phone may fetch.
 * @property {(fileId: string) => Promise<{name: string, mime?: string, path: string} | undefined>} [fileFor]
 * @property {(input: {deviceId: string, label: string}) => Promise<void>} [renameAssistant]
 * @property {(input: {deviceId: string, action: string, delaySeconds?: number, mac?: string}) => Promise<{accepted: boolean, delaySeconds?: number, cancelToken?: string, reason?: string, message?: string}>} [power]
 * @property {(deviceId: string) => void} [attachDevice] Register a freshly authenticated
 *           device in its conversation without waiting for it to speak.
 * @property {() => Promise<void>} [resetSessions] Rebuild device → conversation mapping
 *           after collaboration mode switched.
 * @property {(listener: (event: object) => void) => () => void} [onEvent]
 *           Bridge events: {kind:'message'|'done'|'tool'|'typing'|'error', sessionId, deviceId, callId, ...}
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
    this.helloDeadline = setTimeout(() => {
      this.sendError('handshake-timeout', '连接后未发送 hello，已断开')
      this.close(1008, 'handshake timeout')
    }, 10_000)
    this.helloDeadline.unref?.()

    connection.on('message', text => this.#onMessage(text))
    connection.on('close', () => this.#onClose())
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

  #onClose() {
    clearTimeout(this.helloDeadline)
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
   * @param {(deviceId: string) => string} [options.sessionIdFor] Conversation id of a device.
   * @param {() => boolean} [options.collaboration] Current collaboration flag.
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
    /** Conversation id for a device. Collaboration mode maps every device to one shared id. */
    this.sessionIdFor = options.sessionIdFor ?? (deviceId => this.store.sessionIdFor(deviceId))
    /** Runtime collaboration flag (a preference, so it can change without a restart). */
    this.collaboration = options.collaboration ?? (() => this.store.getPreference('collaboration', false) === true)
    this.serverVersion = PLUGIN_VERSION

    /** @type {Set<Session>} */
    this.sessions = new Set()
    /** @type {Map<string, Set<Session>>} deviceId → live sessions (see MAX_SESSIONS_PER_DEVICE) */
    this.byDevice = new Map()
    /** One-shot download tokens for phone-side file pulls. */
    this.downloadTokens = new Map()
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
    /** @type {Map<string, SessionEventLog>} conversationId → durable event log */
    this.eventLogs = new Map()
    /** conversationId → in-flight assistant turn shown by session/state snapshots. */
    this.activeCalls = new Map()
    /** fileId → file the computer offered to the phones (computer → phone send). */
    this.offeredFiles = new Map()

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

  /** First live session for a device, if any (compatibility helper). */
  sessionFor(deviceId) {
    return this.byDevice.get(deviceId)?.values().next().value
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
        collaboration: this.collaboration(),
        connectionMode: this.#mode(),
        endpoints: this.#reachableEndpoints(),
        devices: this.store.devices.map(d => ({ id: d.id, label: d.label ?? d.deviceName })),
        // 客户端会故意并发竞速两个地址，一个设备可能同时有 2 条会话；对用户/诊断
        // 有意义的是「在线设备数」，原始 socket 数单独放在 sessions 里。
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
        collaboration: this.collaboration(),
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
      const payload = this.pairingPayload()
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
      const webQr = local && webUrl && this.webClient.available() ? await renderQrContent(webUrl) : null
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(this.#pageHtml({ payload, qr, webQr, webUrl, endpoints, local }))
      return true
    }

    if (path === '/openwhale/collaboration') {
      if (req.method === 'POST' && !this.#requireLocal(req, res)) return true
      if (req.method === 'POST') {
        const on = url.searchParams.get('on')
        await this.setCollaboration(on === '1' || on === 'true')
      }
      return this.#json(res, 200, {
        ok: true,
        collaboration: this.collaboration(),
        sessionEpoch: this.sessionEpoch,
      })
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
      this.#broadcastParticipants(this.sessionIdFor(deviceId))
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
          const conversationId = this.sessionIdFor(targetDeviceId)
          this.store.unbindDevice(targetDeviceId)
          this.bridge.forgetDevice?.(targetDeviceId)?.catch?.(() => {})
          this.log(`pairing: device ${targetDeviceId} unbound from desktop page`)
          this.#broadcastParticipants(conversationId)
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
          this.store.unbindDevice(deviceId)
          this.bridge.forgetDevice?.(deviceId)?.catch?.(() => {})
          this.log(`pairing: device ${deviceId} unbound from desktop page`)
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
      return this.#handleDownload(url, res)
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
      case 'ping':
        return session.send({ t: SERVER_FRAME.PONG, time: new Date().toISOString() })
      case 'chat/send':
        return this.#handleChatSend(session, frame)
      case 'chat/cancel':
        this.bridge.cancel?.(frame.callId, session.deviceId ?? undefined)
        return session.send({ t: SERVER_FRAME.CHAT_ACK, rid: frame.rid, callId: frame.callId, cancelled: true })
      case 'session/sync':
        return this.#handleSessionSync(session, frame)
      case 'collab/set':
        return this.#handleCollabSet(session, frame)
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
    session.sessionId = this.sessionIdFor(deviceId)
    clearTimeout(session.helloDeadline)

    // Racing two endpoints means two handshakes with the same deviceId arrive
    // almost together; both must stay alive (the loser is closed by the client).
    // Only when a device accumulates more than MAX_SESSIONS_PER_DEVICE do we
    // retire the oldest connection, so a disconnect never leaves a dead socket.
    const wasOnline = this.deviceOnline(deviceId)
    const evicted = this.#addDeviceSession(session)
    for (const stale of evicted) stale.close(1000, 'replaced by a newer connection')

    // Register the device in its conversation immediately: a phone that has not
    // spoken yet must still receive peers' messages and the participant list.
    if (this.bridge.attachDevice) {
      try {
        this.bridge.attachDevice(deviceId)
      } catch (error) {
        this.log(`bridge: attachDevice failed: ${/** @type {Error} */ (error).message}`)
      }
    }

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
      collaboration: this.collaboration(),
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
    // A client that believes it is in a *different* conversation (collaboration
    // was switched while it was offline) must never be caught up with events from
    // this one: its cursor was issued by another session's log, so only a full
    // snapshot is correct.
    if (session.hasCap(CAPABILITIES.SESSION_SYNC)) {
      const cursor = Number.isFinite(frame.cursor) ? Math.max(0, Math.floor(Number(frame.cursor))) : undefined
      const believedSession = typeof frame.sessionId === 'string' && frame.sessionId !== '' ? frame.sessionId : undefined
      const sessionChanged = believedSession !== undefined && believedSession !== conversationId
      if (sessionChanged || cursor === undefined) this.#deliverSessionState(session)
      else this.#deliverSessionEvents(session, cursor)
      if (sessionChanged) {
        this.log(`sync: 客户端认为的会话 ${believedSession} 与当前 ${conversationId} 不一致，已发全量快照`)
      }
    }
    // Presence only changes on the first/last session; a racing second socket is
    // not a new participant.
    if (!wasOnline) this.#broadcastParticipants(conversationId)

    this.gatewayEvents.emit('device-online', { deviceId, sessionId: session.id, computerId: this.store.computerId })
    this.log(`auth: device ${deviceId} connected as ${device?.label ?? device?.deviceName} session=${conversationId}`)
  }

  /**
   * Called by a Session when its socket closes. Broadcasts the presence change.
   * @param {Session} session
   */
  handleSessionClosed(session) {
    this.log(`ws: ${session.id} 断开（device=${session.deviceId ?? '-'}）`)
    this.sessions.delete(session)
    if (!session.deviceId) return
    this.#removeDeviceSession(session)
    const stillOnline = this.deviceOnline(session.deviceId)
    if (!stillOnline) {
      this.gatewayEvents.emit('device-offline', { deviceId: session.deviceId, sessionId: session.id })
    }
    // With another connection still up the device is still online: the
    // participant list does not change, so no broadcast is needed.
    if (session.sessionId && !stillOnline) this.#broadcastParticipants(session.sessionId)
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
    this.dedupe.remember(key, { callId, msgId })
    session.send({
      t: SERVER_FRAME.CHAT_ACK,
      rid: frame.rid,
      callId,
      msgId,
      ...(prior?.failed ? { duplicate: true } : {}),
    })

    const conversationId = session.sessionId ?? this.sessionIdFor(deviceId)
    const sender = this.store.device(deviceId)
    const speaker = sender?.label ?? sender?.deviceName
    if (!prior?.failed) {
      // Only the first attempt appends an echo: a retry of a failed delivery must
      // not duplicate the bubble in every other device's chat.
      const echo = this.#appendEvent(conversationId, {
        t: SERVER_FRAME.CHAT_ECHO,
        msgId,
        rid: frame.rid,
        callId,
        deviceId,
        speaker,
        text,
        files: stored.map(attachment => ({
          ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
          name: attachment.name,
          size: attachment.size ?? 0,
          ...(attachment.mime ? { mime: attachment.mime } : {}),
        })),
        at: new Date().toISOString(),
      })
      this.#broadcastToConversation(conversationId, echo, { requireCapability: CAPABILITIES.CHAT_ECHO })
    }

    try {
      await this.bridge.send({ deviceId, callId, text, attachments: stored, speaker })
    } catch (error) {
      // Keep a "failed" marker instead of dropping the claim: a retry gets the
      // duplicate ack it expects (so its outbox clears) AND is delivered again,
      // so one transient DSH error cannot permanently swallow the message.
      this.dedupe.remember(key, { callId, msgId, failed: true })
      const message = /** @type {Error} */ (error).message
      this.log(`chat: 投递失败 rid=${frame.rid} msgId=${msgId} → ${message}`)
      return session.sendError('send-failed', `消息未能送达电脑上的 AI：${message}`)
    }

    // A successfully delivered retry is a normal accepted message from now on.
    if (prior?.failed) this.dedupe.remember(key, { callId, msgId })
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
    if (cursor === undefined) this.#deliverSessionState(session)
    else this.#deliverSessionEvents(session, cursor)
    return undefined
  }

  /**
   * Switch collaboration mode: everyone shares one conversation, or each device
   * keeps its own. Called by `collab/set` and by the local HTTP toggle.
   * @param {boolean} on
   */
  async setCollaboration(on) {
    const desired = on === true
    if (this.collaboration() === desired) {
      this.#broadcastCollabState(desired)
      return
    }
    this.store.setPreference('collaboration', desired)
    this.sessionEpoch += 1
    this.log(`collab: 协作模式 → ${desired ? '开' : '关'}（sessionEpoch=${this.sessionEpoch}）`)

    // Rebuild the mapping before any frame is sent: the new sessionId is what
    // session/state and the bridge's attach must agree on.
    for (const session of this.sessions) {
      if (session.authenticated) session.sessionId = this.sessionIdFor(/** @type {string} */ (session.deviceId))
    }
    try {
      await this.bridge.resetSessions?.()
    } catch (error) {
      this.log(`collab: 重建会话映射失败：${/** @type {Error} */ (error).message}`)
    }
    for (const session of this.sessions) {
      if (!session.authenticated) continue
      try {
        this.bridge.attachDevice?.(/** @type {string} */ (session.deviceId))
      } catch (error) {
        this.log(`collab: attachDevice 失败：${/** @type {Error} */ (error).message}`)
      }
    }

    this.#broadcastCollabState(desired)
    const conversations = new Set(
      [...this.sessions].filter(session => session.authenticated && session.sessionId).map(session => session.sessionId),
    )
    for (const conversationId of conversations) {
      this.#broadcastParticipants(/** @type {string} */ (conversationId))
      for (const session of this.sessions) {
        if (!session.authenticated || session.sessionId !== conversationId) continue
        if (session.hasCap(CAPABILITIES.SESSION_SYNC)) this.#deliverSessionState(session)
      }
    }
  }

  /** @param {Session} session @param {any} frame */
  async #handleCollabSet(session, frame) {
    if (!session.hasCap(CAPABILITIES.COLLAB)) return undefined
    await this.setCollaboration(frame.on === true)
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

  /** @param {Session} session @param {any} frame */
  async #handleFileFetch(session, frame) {
    const fileId = String(frame.fileId ?? '')
    if (!fileId) return session.sendError('bad-frame', 'file/fetch 缺少 fileId')
    // Files the assistant produced are registered by the bridge; files the user
    // explicitly sent from the computer are registered here.
    const file = (await this.bridge.fileFor?.(fileId)) ?? this.offeredFiles.get(fileId)
    if (!file) {
      return session.send({ t: SERVER_FRAME.FILE_ERROR, fileId, code: 'not-found', message: '找不到该文件' })
    }
    let size = 0
    try {
      size = (await stat(file.path)).size
    } catch (error) {
      return session.send({
        t: SERVER_FRAME.FILE_ERROR,
        fileId,
        code: 'unreadable',
        message: `无法读取文件：${/** @type {Error} */ (error).message}`,
      })
    }
    if (size > MAX_FILE_BYTES) {
      return session.send({
        t: SERVER_FRAME.FILE_ERROR,
        fileId,
        code: 'too-large',
        message: `文件过大（${Math.round(size / 1024 / 1024)} MB），上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`,
      })
    }

    session.send({
      t: SERVER_FRAME.FILE_META,
      fileId,
      name: file.name,
      mime: file.mime,
      size,
      // A plain HTTP fallback for clients that cannot or prefer not to reassemble
      // base64 chunks. The token is single-use and short-lived.
      downloadPath: `${DOWNLOAD_PATH}?token=${this.#issueDownloadToken(file.path, file.name, file.mime)}`,
    })

    await this.#streamFileToSession(session, fileId, file.path, size)
    return undefined
  }

  /**
   * Push a file as base64 chunks, aborting if the session drops.
   * @param {Session} session
   * @param {string} fileId
   * @param {string} path
   * @param {number} size
   */
  async #streamFileToSession(session, fileId, path, size) {
    const stream = createReadStream(path, { highWaterMark: FILE_CHUNK_BYTES })
    let seq = 0
    let sent = 0
    let aborted = false
    const onClose = () => {
      aborted = true
      stream.destroy()
    }
    session.connection.once('close', onClose)
    try {
      for await (const chunk of stream) {
        if (aborted || session.connection.closed) {
          aborted = true
          break
        }

        // Respect the socket's write buffer. Pushing a whole large file at a
        // socket that cannot drain it (a slow phone link, or a host with a smaller
        // send buffer) queues the remainder in Node's internals, and the transfer
        // then stalls instead of finishing — observed as a timeout on macOS CI for a
        // 700 KiB file. Waiting for `drain` bounds memory to one chunk.
        const frame = JSON.stringify({
          t: SERVER_FRAME.FILE_CHUNK,
          fileId,
          seq,
          dataBase64: /** @type {Buffer} */ (chunk).toString('base64'),
        })
        const accepted = typeof session.connection.sendWithBackpressure === 'function'
          ? session.connection.sendWithBackpressure(frame)
          : session.send({
            t: SERVER_FRAME.FILE_CHUNK,
            fileId,
            seq,
            dataBase64: /** @type {Buffer} */ (chunk).toString('base64'),
          })
        if (!accepted) {
          // Either the connection is gone or the frame buffered. Distinguish them:
          // a buffered write must be waited for, a dead connection must abort.
          if (session.connection.closed) {
            aborted = true
            break
          }
          await session.connection.waitForDrain()
          if (session.connection.closed || aborted) {
            aborted = true
            break
          }
        }

        seq += 1
        sent += /** @type {Buffer} */ (chunk).length
        // Yield so incoming frames (including the phone's cancel) are never starved.
        if (seq % 4 === 0) await new Promise(resolve => setImmediate(resolve))
      }
    } finally {
      session.connection.off('close', onClose)
    }
    if (aborted) {
      this.log(`file: transfer of ${fileId} aborted after ${sent}/${size} bytes`)
      return
    }
    session.send({ t: SERVER_FRAME.FILE_END, fileId, seq })
  }

  /** @param {Session} session @param {any} frame */
  async #handleRename(session, frame) {
    const label = String(frame.label ?? '').slice(0, 60)
    if (!label) return session.sendError('bad-frame', '备注名不能为空')
    const deviceId = /** @type {string} */ (session.deviceId)
    this.store.updateDevice(deviceId, { label })
    session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: this.#assistantList() })
    // 协作头像条要立刻看到新昵称，不必等下一次连接事件。
    if (session.sessionId) this.#broadcastParticipants(session.sessionId)
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
    if (session.sessionId) this.#broadcastParticipants(session.sessionId)
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleForget(session, frame) {
    const deviceId = /** @type {string} */ (session.deviceId)
    if (String(frame.deviceId ?? '') !== deviceId) {
      return session.sendError('forbidden', '只能解绑自己')
    }
    const conversationId = session.sessionId
    this.store.unbindDevice(deviceId)
    this.log(`pairing: device ${deviceId} unbound itself`)
    session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: [], unbound: true })
    session.close(1000, 'device unbound')
    if (conversationId) this.#broadcastParticipants(conversationId)
    return undefined
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
   * Push a bridge event. Chat-level frames go to **every** device in the
   * event's conversation (v2.2.0 multi-device sync); device-level frames stay
   * targeted. The event log keeps the durable ones for reconnect catch-up.
   * @param {{kind: string, sessionId?: string, deviceId?: string, callId?: string, [key: string]: unknown}} event
   */
  pushEvent(event) {
    const deviceId = typeof event.deviceId === 'string' ? event.deviceId : ''
    const conversationId = typeof event.sessionId === 'string' && event.sessionId !== ''
      ? event.sessionId
      : deviceId ? this.sessionIdFor(deviceId) : ''
    if (!conversationId) return false

    switch (event.kind) {
      case 'typing': {
        const frame = { t: SERVER_FRAME.TYPING, callId: event.callId, active: event.active !== false }
        return this.#broadcastToConversation(conversationId, frame) > 0
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
    for (const session of this.sessions) {
      if (!session.authenticated || session.sessionId !== conversationId) continue
      if (options.skipDeviceId && session.deviceId === options.skipDeviceId) continue
      if (options.requireCapability && !session.hasCap(options.requireCapability)) continue
      if (session.send(frame)) delivered += 1
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
    for (const session of this.sessions) {
      if (!session.authenticated || session.sessionId !== conversationId) continue
      const payload = session.hasCap(capability) ? frame : fallback(session)
      if (payload && session.send(payload)) delivered += 1
    }
    return delivered
  }

  /** @param {string} conversationId */
  #broadcastParticipants(conversationId) {
    const participants = this.#participants(conversationId)
    const collaboration = this.collaboration()
    for (const session of this.sessions) {
      if (!session.authenticated || session.sessionId !== conversationId) continue
      if (!session.hasCap(CAPABILITIES.PARTICIPANTS)) continue
      session.send({
        t: SERVER_FRAME.PARTICIPANTS,
        sessionId: conversationId,
        collaboration,
        participants,
      })
    }
  }

  /**
   * Bound devices that belong to this conversation, with their live state.
   * @param {string} conversationId
   */
  #participants(conversationId) {
    return this.store.devices
      .filter(device => this.sessionIdFor(device.id) === conversationId)
      .map(device => ({
        deviceId: device.id,
        name: device.label ?? device.deviceName,
        online: this.deviceOnline(device.id),
      }))
  }

  /** @param {boolean} on */
  #broadcastCollabState(on) {
    for (const session of this.sessions) {
      if (!session.authenticated || !session.hasCap(CAPABILITIES.COLLAB)) continue
      session.send({
        t: SERVER_FRAME.COLLAB_STATE,
        on,
        sessionId: session.sessionId,
        sessionEpoch: this.sessionEpoch,
      })
    }
  }

  /** @param {Session} session */
  #deliverSessionState(session) {
    const conversationId = session.sessionId
    if (!conversationId) return
    const log = this.#log(conversationId)
    const active = this.activeCalls.get(conversationId)
    session.send({
      t: SERVER_FRAME.SESSION_STATE,
      sessionId: conversationId,
      sessionEpoch: this.sessionEpoch,
      head: log.head,
      snapshot: {
        messages: log.snapshot(),
        ...(active ? { activeCall: { callId: active.callId, text: active.text, typing: active.typing !== false } } : {}),
      },
      collaboration: this.collaboration(),
    })
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
      this.#deliverSessionState(session)
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
   * The exact payload the QR encodes. Shared by the QR routes, the page and the
   * `/openwhale` command so they can never disagree.
   * @returns {{ok: true, payload: any} | {ok: false, reason: string, message: string}}
   */
  pairingPayload() {
    const availability = pairingAvailability(this.store)
    if (!availability.available) {
      return { ok: false, reason: availability.reason, message: availability.message }
    }
    const endpoints = this.#reachableEndpoints()
    if (endpoints.length === 0) {
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
      collaboration: this.collaboration(),
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
    const token = this.#issueDownloadToken(absolute, name, mime)
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

  /** @param {import('node:http').ServerResponse} res */
  async #handleDownload(url, res) {
    const token = url.searchParams.get('token') ?? ''
    const entry = this.downloadTokens.get(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      this.downloadTokens.delete(token)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('下载链接已失效')
      return true
    }
    this.downloadTokens.delete(token)
    let size
    try {
      size = (await stat(entry.path)).size
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('文件不存在')
      return true
    }
    res.writeHead(200, {
      'content-type': entry.mime ?? 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${encodeURIComponent(entry.name)}"`,
      'cache-control': 'no-store',
    })
    createReadStream(entry.path).pipe(res)
    return true
  }

  /**
   * @param {string} path
   * @param {string} name
   * @param {string} [mime]
   */
  #issueDownloadToken(path, name, mime) {
    const token = randomBytes(24).toString('base64url')
    this.downloadTokens.set(token, { path, name, mime, expiresAt: Date.now() + 5 * 60 * 1000 })
    // Bound the map so a phone looping file/fetch cannot grow memory forever.
    if (this.downloadTokens.size > 64) {
      const oldest = [...this.downloadTokens.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) this.downloadTokens.delete(oldest[0])
    }
    return token
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
   * @param {{payload: any, qr: any, webQr: any, webUrl: string | undefined, endpoints: Array<{url: string, kind: string}>, local: boolean}} view
   */
  #pageHtml(view) {
    const { payload, qr, webQr, webUrl, endpoints, local } = view
    const collaboration = this.collaboration()
    const mode = this.#mode()
    const report = this.connectionModeReport()
    const boundDevices = this.store.devices ?? []
    const remaining = Math.max(0, MAX_DEVICES - boundDevices.length)
    const expiry = payload.ok ? new Date(payload.payload.expires).toLocaleString('zh-CN') : ''
    const port = this.port || 8787

    const kindLabel = { lan: '局域网', tailscale: 'Tailscale', tunnel: '公网隧道', loopback: '本机回环', unknown: '其它' }
    const addressList = endpoints.length
      ? endpoints.map(endpoint => `<li><code>${escapeHtml(endpoint.url)}</code> <span class="tag">${kindLabel[endpoint.kind] ?? endpoint.kind}</span></li>`).join('')
      : '<li>还没有可用地址（请开启局域网监听，或启动公网隧道）</li>'
    const detectedSection = ['tailscale', 'lan', 'tunnel', 'loopback']
      .map(kind => {
        const urls = report.detected?.[kind] ?? []
        return `<li><b>${kindLabel[kind]}地址</b>：${urls.length
          ? urls.map(url => `<code>${escapeHtml(url)}</code>`).join('、')
          : '<span class="hint">未检测到</span>'}</li>`
      })
      .join('')

    const deviceRows = boundDevices.length
      ? `<ul class="devs">${boundDevices.map(device => `<li><span>${escapeHtml(device.label ?? device.deviceName)}</span>${
        local
          ? `<span><button class="btn-sm" data-rename="${escapeHtml(device.id)}">改名</button> <button class="btn-sm" data-unbind="${escapeHtml(device.id)}">移除</button></span>`
          : `<span class="hint">${this.deviceOnline(device.id) ? '在线' : '离线'}</span>`
      }</li>`).join('')}</ul>`
      : '<p class="hint">还没有绑定任何手机。用 Open Whale 应用扫描二维码即可绑定。</p>'

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Whale ${PLUGIN_VERSION} 绑定</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#0b1220;color:#e8eefc}
 .wrap{max-width:1000px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:0 0 10px}
 .sub{color:#93a4c8;margin-bottom:24px;font-size:14px}
 .grid{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}
 .col{flex:1;min-width:330px;display:flex;flex-direction:column;gap:18px}
 .card{background:#131c31;border:1px solid #24304d;border-radius:14px;padding:18px}
 .qr{background:#fff;padding:12px;border-radius:12px;line-height:0;display:inline-block}
 code{background:#0b1220;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}
 .fp{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#9ee7c0;word-break:break-all}
 .warn{color:#ffd479} .bad{color:#ff9a9a} .hint{color:#93a4c8;font-size:13px}
 ul{line-height:1.7;font-size:14px;margin:6px 0;padding-left:18px}
 .btn{background:#ef4444;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;margin-top:8px}
 .btn:hover{background:#dc2626} .btn[disabled]{background:#475569;cursor:not-allowed}
 .btn-sm{background:#334155;color:#e8eefc;border:0;border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer}
 .btn-sm:hover{background:#475569} .btn-sm[disabled]{opacity:.5;cursor:not-allowed}
 .devs{list-style:none;padding:0;margin:6px 0 2px}
 .devs li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 10px;background:#0b1220;border:1px solid #24304d;border-radius:8px;margin:6px 0;font-size:14px}
 .tag{display:inline-block;background:#1d4ed8;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px}
 .modes label{display:block;margin:6px 0;font-size:14px}
 .banner{background:#3b1d1d;border:1px solid #7f1d1d;color:#ffb4b4;border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:13px}
 input[type=text]{background:#0b1220;border:1px solid #24304d;border-radius:8px;color:#e8eefc;padding:8px 10px;font-size:14px;min-width:260px}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 .ok{color:#9ee7c0}
</style></head><body><div class="wrap">
<h1>Open Whale <span class="tag">v${PLUGIN_VERSION}</span></h1>
<div class="sub">用手机上的 Open Whale 应用扫描二维码绑定；也可以用手机浏览器直接打开网页版（无需安装应用）。</div>
${local ? '' : `<div class="banner">当前页面不是在这台电脑上打开的。为避免经公网隧道暴露管理能力，配对二维码与所有修改操作（改名/解绑/协作开关/连接方式/发送文件）都请在本机浏览器操作：<code>http://127.0.0.1:${port}/openwhale</code></div>`}
<div class="grid">
  <div class="col" style="flex:0 0 auto">
    <div class="card">
      <h2>扫码绑定</h2>
      ${local
        ? (qr ? `<div class="qr">${qr.svg}</div>` : `<p class="bad">${escapeHtml(payload.message ?? '当前无法生成二维码')}</p>`)
        : `<p class="hint">配对二维码包含一次性绑定密钥，只在本机浏览器显示。请在电脑上打开 <code>http://127.0.0.1:${port}/openwhale</code> 扫码。</p>`}
      ${local && payload.ok ? `<p><b>二维码有效期</b>：${escapeHtml(expiry)}</p><p class="warn">二维码包含一次性绑定密钥，请勿截图外发；绑定成功后立即失效。</p>` : ''}
    </div>
    <div class="card">
      <h2>网页版 / PWA</h2>
      ${webUrl ? `
        ${webQr ? `<div class="qr">${webQr.svg}</div>` : '<p class="hint">二维码只在本机浏览器显示。</p>'}
        <p>手机浏览器打开：<br><code>${escapeHtml(webUrl)}</code></p>
        <p class="hint">${this.webClient.available()
          ? '鸿蒙 / iOS / 任意浏览器可用；添加到主屏幕即为 PWA。'
          : '网页版客户端还没有打包进插件（缺少 webchat 目录）。'}</p>
      ` : '<p class="hint">还没有可用地址，无法生成网页版入口。</p>'}
    </div>
  </div>
  <div class="col">
    <div class="card">
      <h2>电脑</h2>
      <p><b>电脑名称</b>：${escapeHtml(this.store.computerName)}</p>
      <p><b>已绑定设备</b>：${boundDevices.length} 台 · 还可绑定 ${remaining} 台${remaining === 0 ? ' · <span class="bad">已达上限，需先移除不用的设备</span>' : ''}</p>
      ${deviceRows}
      <p><b>协作模式</b>：${collaboration ? '<span class="ok">已开启（多台手机共用一个对话，互相可见）</span>' : '关闭（每台设备各自独立）'}
        ${local ? `<button class="btn-sm" id="collab">${collaboration ? '关闭' : '开启'}</button>` : ''}</p>
      <p><b>公钥指纹</b>：<span class="fp">${escapeHtml(formatFp(payload.ok ? payload.payload.fp : this.store.fingerprint))}</span></p>
      <p><b>可用地址</b>：</p><ul>${addressList}</ul>
    </div>
    <div class="card">
      <h2>连接方式</h2>
      <p class="hint">决定手机优先用哪条线路连这台电脑。自动模式按「上次成功 → Tailscale → 局域网 → 公网隧道」排序；<b>Tailscale 是独立选项，不再算作局域网</b>。</p>
      <div class="modes">
        ${['auto', 'lan', 'tailscale', 'tunnel'].map(value => `<label><input type="radio" name="connection-mode" value="${value}" ${mode === value ? 'checked' : ''} ${local ? '' : 'disabled'}> ${connectionModeLabel(value)}</label>`).join('')}
      </div>
      ${local ? '<button class="btn-sm" id="save-mode">保存连接方式</button>' : '<p class="hint">连接方式只能在本机浏览器修改。</p>'}
      <p><b>检测到的地址</b>：</p><ul>${detectedSection}</ul>
    </div>
    <div class="card">
      <h2>发送到手机</h2>
      ${local ? `
        <p class="hint">把本会话工作目录里的文件推送到所有已连接的手机（聊天里会出现文件卡片）。</p>
        <div class="row">
          <input type="text" id="send-file-path" placeholder="相对路径，例如 report.pdf">
          <button class="btn-sm" id="send-file-btn">发送</button>
        </div>
        <p id="send-file-result" class="hint"></p>
      ` : '<p class="hint">发送文件需要读取电脑上的路径，只允许在本机浏览器操作。</p>'}
    </div>
  </div>
</div>
<p class="hint">Open Whale v${PLUGIN_VERSION} · 电脑 ID <code>${escapeHtml(this.store.computerId)}</code> · 状态：${payload.ok ? 'ready' : 'blocked'}</p>
</div>
<script>
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  }
  document.getElementById('collab')?.addEventListener('click', async function (event) {
    var button = event.currentTarget
    var next = button.textContent.trim() === '开启'
    button.disabled = true
    try {
      var response = await postJson('/openwhale/collaboration?on=' + (next ? '1' : '0'))
      if (!response.ok) throw new Error(await response.text())
      location.reload()
    } catch (error) {
      alert('切换失败：' + error.message)
      button.disabled = false
    }
  })
  document.getElementById('save-mode')?.addEventListener('click', async function (event) {
    var button = event.currentTarget
    var selected = document.querySelector('input[name=connection-mode]:checked')
    if (!selected) return
    button.disabled = true
    try {
      var response = await postJson('/openwhale/connection-mode?mode=' + encodeURIComponent(selected.value))
      if (!response.ok) throw new Error(await response.text())
      location.reload()
    } catch (error) {
      alert('保存失败：' + error.message)
      button.disabled = false
    }
  })
  document.getElementById('send-file-btn')?.addEventListener('click', async function (event) {
    var button = event.currentTarget
    var input = document.getElementById('send-file-path')
    var result = document.getElementById('send-file-result')
    var path = input.value.trim()
    if (!path) { alert('请填写文件路径'); return }
    button.disabled = true
    result.textContent = '正在发送…'
    try {
      var response = await postJson('/openwhale/send-file', { path: path })
      var body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.message || body.error || '发送失败')
      result.innerHTML = '已发送 <b>' + body.name + '</b>（' + body.size + ' 字节）'
    } catch (error) {
      result.textContent = '发送失败：' + error.message
    } finally {
      button.disabled = false
    }
  })
  document.querySelectorAll('[data-rename]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var id = button.getAttribute('data-rename')
      var name = prompt('给这台设备起个昵称（多人协作时消息会带这个前缀）')
      if (!name) return
      button.disabled = true
      try {
        var response = await fetch('/openwhale/device-rename?deviceId=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(name), { method: 'POST' })
        if (!response.ok) throw new Error(await response.text())
        location.reload()
      } catch (error) {
        alert('改名失败：' + error.message)
        button.disabled = false
      }
    })
  })
  document.querySelectorAll('[data-unbind]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var id = button.getAttribute('data-unbind')
      if (!confirm('确定移除这台设备？移除后它需要重新扫码才能再连。')) return
      button.disabled = true
      try {
        var response = await fetch('/openwhale/unbind?deviceId=' + encodeURIComponent(id), { method: 'POST' })
        if (!response.ok) throw new Error(await response.text())
        location.reload()
      } catch (error) {
        alert('移除失败：' + error.message)
        button.disabled = false
      }
    })
  })
</script>
</body></html>`
  }
}

/** 中文标签：连接方式选择项。 */
export function connectionModeLabel(mode) {
  switch (mode) {
    case CONNECTION_MODE.AUTO: return '自动（Tailscale → 局域网 → 隧道）'
    case CONNECTION_MODE.LAN: return '只走局域网'
    case CONNECTION_MODE.TAILSCALE: return '只走 Tailscale（独立于局域网）'
    case CONNECTION_MODE.TUNNEL: return '只走公网隧道'
    default: return String(mode)
  }
}

/** @param {Gateway} gateway */
function buildPayload(gateway) {
  const result = gateway.pairingPayload()
  if (!result.ok) throw new Error(result.message)
  return result.payload
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char)
}

function formatFp(hex) {
  return String(hex).toUpperCase().match(/.{1,4}/g)?.slice(0, 16).join(' ') ?? ''
}

export { buildPayload, pickEndpoint, timingSafeEqual, createHash }
