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
//  4. One computer may be bound to exactly one phone: when already bound, a
//     second device is refused even with a valid secret.
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'

import {
  DEFAULT_HEARTBEAT_MS,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  NonceReplayGuard,
  POWER_REFUSAL,
  SERVER_FRAME,
  clampAssistantText,
  helloAckProofMessage,
  helloSignatureMessage,
  pickEndpoint,
  timingSafeEqual,
} from './protocol.mjs'
import { pairingAvailability, renderPairingQr } from './pairer.mjs'
import { MAX_DEVICES } from './state.mjs'
import { acceptUpgrade, validateUpgrade } from './ws.mjs'

/** Path the phone opens its WebSocket on. */
export const WS_PATH = '/openwhale/ws'

/** Longest body we will accept on an upload route. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/**
 * @typedef {object} Bridge
 * The DSH-facing half. The gateway never imports DSH packages directly, which
 * is what keeps the wire protocol testable without a harness.
 * @property {(input: {deviceId: string, callId: string, text: string, attachments: Array<{name: string, mime?: string, dataBase64: string}>}) => Promise<void>} send
 *           Deliver a user message into the device's assistant conversation.
 * @property {(callId: string) => void} [cancel]
 * @property {() => Promise<Array<{fileId: string, name: string, size: number, mime?: string, path?: string}>>} [listFiles]
 *           Files the assistant produced that the phone may fetch.
 * @property {(fileId: string) => Promise<{name: string, mime?: string, path: string} | undefined>} [fileFor]
 * @property {(input: {deviceId: string, label: string}) => Promise<void>} [renameAssistant]
 * @property {(input: {deviceId: string, action: string, delaySeconds?: number, mac?: string}) => Promise<{accepted: boolean, delaySeconds?: number, cancelToken?: string, reason?: string, message?: string}>} [power]
 * @property {(listener: (event: object) => void) => () => void} [onEvent]
 *           Bridge events: {kind:'delta'|'done'|'tool'|'typing'|'error', deviceId, callId, ...}
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
    this.gateway.sessions.delete(this)
    if (this.deviceId) {
      this.gateway.gatewayEvents.emit('device-offline', { deviceId: this.deviceId, sessionId: this.id })
    }
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
   * @param {string} [options.uploadDir] Where phone attachments land.
   */
  constructor(options) {
    this.store = options.store
    this.bridge = options.bridge
    this.port = options.port ?? 0
    this.tunnelUrls = options.tunnelUrls ?? (() => [])
    this.lanUrls = options.lanUrls ?? (() => [])
    this.log = options.log ?? (() => {})
    this.uploadDir = options.uploadDir
    this.heartbeatMs = DEFAULT_HEARTBEAT_MS
    /** @type {Set<Session>} */
    this.sessions = new Set()
    /** @type {Map<string, Session>} deviceId → live session */
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
  }

  /** Live session for a device, if any. */
  sessionFor(deviceId) {
    return this.byDevice.get(deviceId)
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
    this.log(`ws: client connected (${session.id})`)
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

    if (path === '/openwhale/health') {
      return this.#json(res, 200, {
        ok: true,
        plugin: 'dsh-openwhale',
        computerId: this.store.computerId,
        computerName: this.store.computerName,
        paired: this.store.isPaired,
        devices: this.store.devices.map(d => ({ id: d.id, label: d.label ?? d.deviceName })),
        connections: this.sessions.size,
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      })
    }

    if (path === '/openwhale/info') {
      return this.#json(res, 200, {
        computerId: this.store.computerId,
        computerName: this.store.computerName,
        fingerprint: this.store.fingerprint,
        endpoints: [...this.tunnelUrls(), ...this.lanUrls()],
        pairing: pairingAvailability(this.store),
      })
    }

    if (path === '/openwhale/qr.svg' || path === '/openwhale/qr.png') {
      const payload = this.#currentOrNewQrPayload()
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
      const payload = this.#currentOrNewQrPayload()
      if (!payload.ok) return this.#json(res, 409, { error: payload.reason, message: payload.message })
      // The secret is included on purpose: this route is only reachable by
      // someone who can already reach the plugin's own surface, i.e. the user.
      return this.#json(res, 200, { ok: true, payload: payload.payload })
    }

    if (path === '/openwhale' || path === '/openwhale/') {
      const payload = this.#currentOrNewQrPayload()
      const qr = payload.ok ? await renderPairingQr(payload.payload) : null
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(this.#pageHtml(payload, qr))
      return true
    }

    // 强制解除绑定。
    // 手机端的 device/forget 需要走 WebSocket：手机没连上（网络变了、隧道换了地址）
    // 就发不出去，于是出现「手机已解绑、电脑仍占着」的死锁 —— 电脑端不给二维码，
    // 手机端又连不上来解绑。这个入口只在本机/局域网可达（与配对页同一保护级别），
    // 供用户手动解开。
    if (path === '/openwhale/unbind') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
        res.end('请用 POST 调用')
        return true
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
        this.bridge.cancel?.(frame.callId)
        return session.send({ t: SERVER_FRAME.CHAT_ACK, rid: frame.rid, callId: frame.callId, cancelled: true })
      case 'file/fetch':
        return this.#handleFileFetch(session, frame)
      case 'assistant/rename':
        return this.#handleRename(session, frame)
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
    clearTimeout(session.helloDeadline)

    // Kick any previous connection for this device so the phone's reconnect
    // always wins instead of racing a half-dead socket.
    const previous = this.byDevice.get(deviceId)
    if (previous && previous !== session) previous.close(1000, 'replaced by a newer connection')
    this.byDevice.set(deviceId, session)

    // The proof echoes the nonce this hello presented, so a phone that bound
    // through the QR can verify the ack against the computer's public key (`pk`)
    // from that same QR. A first-time pairing has no nonce to echo, so the ack
    // carries the computer's own fresh one and is only meaningful as a heartbeat.
    const ackNonce = String(frame.nonce ?? session.nonce)
    session.send({
      t: SERVER_FRAME.HELLO_ACK,
      version: '1.0.0',
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
      endpoints: [...this.tunnelUrls(), ...this.lanUrls()],
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
    this.gatewayEvents.emit('device-online', { deviceId, sessionId: session.id, computerId: this.store.computerId })
    this.log(`auth: device ${deviceId} connected as ${device?.label ?? device?.deviceName}`)
  }

  /** @param {Session} session @param {any} frame */
  async #handleChatSend(session, frame) {
    const callId = String(frame.callId ?? frame.rid ?? '')
    this.log(`chat: 收到消息 rid=${frame.rid} callId=${callId} 文本长度=${typeof frame.text === 'string' ? frame.text.length : 0} 附件=${Array.isArray(frame.files) ? frame.files.length : 0}`)
    if (!callId) {
      this.log('chat: 缺少 callId，拒绝')
      return session.sendError('bad-frame', 'chat/send 缺少 callId')
    }
    const text = typeof frame.text === 'string' ? frame.text : ''
    const attachments = Array.isArray(frame.files) ? frame.files : []
    if (!text.trim() && attachments.length === 0) {
      this.log('chat: 内容为空，拒绝')
      return session.sendError('empty-message', '消息内容为空')
    }
    if (text.length > 100_000) {
      this.log(`chat: 消息过长 ${text.length} 字符，拒绝`)
      return session.sendError('too-long', '消息过长，请拆分后发送')
    }

    // Persist phone attachments so the assistant can read them as real files.
    /** @type {Array<{name: string, mime?: string, dataBase64: string, path?: string}>} */
    const stored = []
    for (const attachment of attachments.slice(0, 8)) {
      if (!attachment || typeof attachment.dataBase64 !== 'string') continue
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      if (bytes.length > MAX_UPLOAD_BYTES) continue
      let path
      if (this.uploadDir) {
        try {
          await mkdir(this.uploadDir, { recursive: true })
          const safeName = basename(String(attachment.name ?? 'upload.bin')).replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
          path = join(this.uploadDir, `${Date.now()}-${randomBytes(3).toString('hex')}-${safeName}`)
          await writeFile(path, bytes)
        } catch (error) {
          this.log(`upload: failed to store attachment: ${/** @type {Error} */ (error).message}`)
          path = undefined
        }
      }
      stored.push({ name: String(attachment.name ?? 'upload.bin'), mime: attachment.mime, dataBase64: attachment.dataBase64, path })
    }

    try {
      const sender = this.store.device(/** @type {string} */ (session.deviceId))
      await this.bridge.send({
        deviceId: /** @type {string} */ (session.deviceId),
        callId,
        text,
        attachments: stored,
        // 协作模式下所有手机共用一个会话，没有这行就分不清「谁说的」。
        speaker: sender?.label ?? sender?.deviceName,
      })
    } catch (error) {
      // 投递失败必须在日志里留痕：否则手机端已经收到 ACK、显示「已发送」，
      // 而消息其实从未进入 AI 会话，现象会表现为「发了没反应」且毫无线索。
      const message = /** @type {Error} */ (error).message
      this.log(`chat: 投递失败 rid=${frame.rid} → ${message}`)
      return session.sendError('send-failed', `消息未能送达电脑上的 AI：${message}`)
    }

    this.log(`chat: 投递成功 rid=${frame.rid}`)
    session.send({ t: SERVER_FRAME.CHAT_ACK, rid: frame.rid, callId })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleFileFetch(session, frame) {
    const fileId = String(frame.fileId ?? '')
    if (!fileId) return session.sendError('bad-frame', 'file/fetch 缺少 fileId')
    const file = await this.bridge.fileFor?.(fileId)
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
      downloadPath: `/openwhale/download?token=${this.#issueDownloadToken(file.path, file.name)}`,
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
    await this.bridge.renameAssistant?.({ deviceId, label })
    return undefined
  }

  /** @param {Session} session @param {any} frame */
  async #handleForget(session, frame) {
    const deviceId = /** @type {string} */ (session.deviceId)
    if (String(frame.deviceId ?? '') !== deviceId) {
      return session.sendError('forbidden', '只能解绑自己')
    }
    this.store.unbindDevice(deviceId)
    this.log(`pairing: device ${deviceId} unbound itself`)
    session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: [], unbound: true })
    session.close(1000, 'device unbound')
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
  // Bridge → phone push
  // ---------------------------------------------------------------------------

  /**
   * Push a bridge event to the owning device.
   * @param {{kind: string, deviceId: string, callId?: string, [key: string]: unknown}} event
   */
  pushEvent(event) {
    const session = this.byDevice.get(event.deviceId)
    if (!session) return false
    switch (event.kind) {
      case 'delta':
        return session.send({
          t: SERVER_FRAME.CHAT_DELTA,
          callId: event.callId,
          seq: event.seq ?? 0,
          text: String(event.text ?? ''),
        })
      case 'done': {
        const { text, truncated } = clampAssistantText(String(event.text ?? ''))
        return session.send({
          t: SERVER_FRAME.CHAT_DONE,
          callId: event.callId,
          text,
          truncated: truncated || Boolean(event.truncated),
          durationMs: event.durationMs,
          files: Array.isArray(event.files) ? event.files : undefined,
        })
      }
      case 'tool':
        return session.send({
          t: SERVER_FRAME.TOOL,
          callId: event.callId,
          phase: event.phase,
          toolCallId: event.toolCallId,
          tool: event.tool,
          summary: event.summary,
          ok: event.ok,
        })
      case 'typing':
        return session.send({ t: SERVER_FRAME.TYPING, callId: event.callId, active: event.active !== false })
      case 'error':
        return session.send({
          t: SERVER_FRAME.CHAT_ERROR,
          callId: event.callId,
          message: String(event.message ?? '处理失败'),
          retryable: event.retryable !== false,
        })
      case 'assistants':
        return session.send({ t: SERVER_FRAME.ASSISTANTS, assistants: this.#assistantList() })
      default:
        return false
    }
  }

  /** Broadcast a bridge event to every connected device (used for shutdown notices). */
  broadcast(event) {
    for (const session of this.sessions) {
      if (session.authenticated) this.pushEvent({ ...event, deviceId: /** @type {string} */ (session.deviceId) })
    }
  }

  #assistantList() {
    return this.store.devices.map(d => ({
      id: d.id,
      name: d.label ?? d.deviceName,
      fingerprint: this.store.fingerprint,
      online: this.byDevice.has(d.id),
      pairedAt: d.pairedAt,
    }))
  }

  #json(res, status, body) {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
    return true
  }

  /** Reuse the live secret while it is valid so reloading the page does not invalidate a QR being scanned. */
  #currentOrNewQrPayload() {
    const availability = pairingAvailability(this.store)
    if (!availability.available) {
      return { ok: false, reason: availability.reason, message: availability.message }
    }
    const endpoints = [...this.tunnelUrls(), ...this.lanUrls()]
    if (endpoints.length === 0) {
      return {
        ok: false,
        reason: 'no-endpoint',
        message: '还没有可用地址：请开启局域网监听，或先启动公网隧道。',
      }
    }
    const active = this.store.activePairing
    if (active) {
      return {
        ok: true,
        payload: {
          v: 1,
          p: 'openwhale',
          host: this.store.computerName,
          id: this.store.computerId,
          fp: this.store.fingerprint,
          pk: this.store.publicKeySpkiBase64Url,
          secret: active.secret,
          expires: active.expires,
          endpoints,
          port: this.port,
          lan: this.lanUrls()[0],
          name: this.store.computerName,
          version: '1.0.0',
        },
      }
    }
    // No live secret: mint one, which invalidates any earlier unused QR.
    try {
      return { ok: true, payload: buildPayload(this) }
    } catch (error) {
      return { ok: false, reason: 'no-endpoint', message: /** @type {Error} */ (error).message }
    }
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

  /** @param {string} path @param {string} name */
  #issueDownloadToken(path, name) {
    const token = randomBytes(24).toString('base64url')
    this.downloadTokens.set(token, { path, name, expiresAt: Date.now() + 5 * 60 * 1000 })
    // Bound the map so a phone looping file/fetch cannot grow memory forever.
    if (this.downloadTokens.size > 64) {
      const oldest = [...this.downloadTokens.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (oldest) this.downloadTokens.delete(oldest[0])
    }
    return token
  }

  /** @param {any} payload @param {any} qr */
  #pageHtml(payload, qr) {
    const status = payload.ok ? 'ready' : 'blocked'
    const endpoints = payload.ok ? payload.payload.endpoints : []
    const expiry = payload.ok
      ? new Date(payload.payload.expires).toLocaleString('zh-CN')
      : ''
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Whale 绑定</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#0b1220;color:#e8eefc}
 .wrap{max-width:840px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px}
 .sub{color:#93a4c8;margin-bottom:24px;font-size:14px}
 .grid{display:flex;gap:32px;flex-wrap:wrap;align-items:flex-start}
 .card{background:#131c31;border:1px solid #24304d;border-radius:14px;padding:20px}
 .qr{background:#fff;padding:12px;border-radius:12px;line-height:0}
 code{background:#0b1220;padding:2px 6px;border-radius:6px;font-size:13px}
 .fp{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#9ee7c0;word-break:break-all}
 .warn{color:#ffd479} .bad{color:#ff9a9a}
 <ul{padding-left:18px;line-height:1.8;font-size:14px}
 li{margin:2px 0}
 .btn{background:#ef4444;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;margin-top:8px}
 .btn:hover{background:#dc2626}
 .btn[disabled]{background:#475569;cursor:not-allowed}
 .hint{color:#93a4c8;font-size:13px;margin-top:6px}
</style></head><body><div class="wrap">
<h1>Open Whale</h1>
<div class="sub">用手机上的 Open Whale 应用扫描右侧二维码即可完成绑定。</div>
<div class="grid">
  <div class="card qr">${qr ? qr.svg : '<p class="bad">当前无法生成二维码</p>'}</div>
  <div class="card" style="min-width:320px;flex:1">
    ${payload.ok ? `
      <p><b>电脑名称</b>：${escapeHtml(payload.payload.host)}</p>
      <p><b>公钥指纹</b>：<span class="fp">${escapeHtml(formatFp(payload.payload.fp))}</span></p>
      <p><b>可用地址</b>：</p><ul>${endpoints.map(e => `<li><code>${escapeHtml(e)}</code></li>`).join('')}</ul>
      <p><b>二维码有效期</b>：${escapeHtml(expiry)}</p>
      <p class="warn">二维码包含一次性绑定密钥，请勿截图外发。绑定成功后二维码立即失效。</p>
    ` : `<p class="bad">${escapeHtml(payload.message)}</p>
      ${
        (this.store.devices ?? []).length
          ? `<button class="btn" id="unbind">解除绑定</button>
      <p class="hint">手机端解绑时如果网络不通，电脑端不会自动解除。点上方按钮可强制解除，之后手机需重新扫码绑定。</p>
      <script>
        document.getElementById('unbind')?.addEventListener('click', async (ev) => {
          const btn = ev.currentTarget
          if (!confirm('确定解除当前手机的绑定？解除后该手机需要重新扫码。')) return
          btn.disabled = true
          btn.textContent = '正在解除…'
          try {
            const r = await fetch('/openwhale/unbind', { method: 'POST' })
            if (!r.ok) throw new Error(await r.text())
            location.reload()
          } catch (e) {
            alert('解除失败：' + e.message)
            btn.disabled = false
            btn.textContent = '解除绑定'
          }
        })
      </script>`
          : ''
      }`}
    <p style="color:#93a4c8;font-size:13px">状态：${status} · 电脑 ID <code>${escapeHtml(this.store.computerId)}</code></p>
  </div>
</div></div></body></html>`
  }
}

/** @param {Gateway} gateway */
function buildPayload(gateway) {
  const endpoints = [...gateway.tunnelUrls(), ...gateway.lanUrls()]
  if (endpoints.length === 0) throw new Error('还没有可用地址：请开启局域网监听，或先启动公网隧道。')
  const issued = gateway.store.issuePairingSecret()
  return {
    v: 1,
    p: 'openwhale',
    host: gateway.store.computerName,
    id: gateway.store.computerId,
    fp: gateway.store.fingerprint,
    pk: gateway.store.publicKeySpkiBase64Url,
    secret: issued.secret,
    expires: issued.expires,
    endpoints,
    port: gateway.port,
    lan: gateway.lanUrls()[0],
    name: gateway.store.computerName,
    version: '1.0.0',
  }
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
