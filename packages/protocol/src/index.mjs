/**
 * Open Whale wire protocol — the single source of truth shared by the DSH computer
 * plugin (`dsh-openwhale`) and the Open Whale mobile app.
 *
 * Design rules (do not break these; both sides depend on them):
 *  1. Every frame is a JSON object with a `t` (type) discriminators and, where a
 *     reply is expected, a `rid` (request id). Unknown frame types MUST be ignored
 *     by both sides so that either side can be upgraded independently.
 *  2. Payloads are plain JSON. Binary data (files) travels as base64 chunks over
 *     the same socket so a single transport suffices behind any HTTP proxy.
 *  3. No long-term secret is ever transmitted after pairing. Post-pairing traffic
 *     is authorised by proof-of-possession of a device key, not by replaying one.
 *
 * @module @openwhale/protocol
 */

/** Bump when a breaking change is made. Both sides compare `major`. */
export const PROTOCOL_VERSION = '1.0.0'

/** Frames that a client may send to the computer. */
export const CLIENT_FRAME = /** @type {const} */ ({
  HELLO: 'hello',
  PAIR_REQ: 'pair/req',
  PING: 'ping',
  CHAT: 'chat/send',
  CHAT_CANCEL: 'chat/cancel',
  FILE_FETCH: 'file/fetch',
  FILE_CANCEL: 'file/cancel',
  ASSISTANT_RENAME: 'assistant/rename',
  DEVICE_FORGET: 'device/forget',
  POWER: 'power/request',
})

/** Frames that the computer may send to a client. */
export const SERVER_FRAME = /** @type {const} */ ({
  HELLO_ACK: 'hello/ack',
  ERROR: 'error',
  PAIR_OK: 'pair/ok',
  PONG: 'pong',
  CHAT_ACK: 'chat/ack',
  CHAT_DELTA: 'chat/delta',
  CHAT_DONE: 'chat/done',
  CHAT_ERROR: 'chat/error',
  TOOL: 'chat/tool',
  TYPING: 'chat/typing',
  FILE_META: 'file/meta',
  FILE_CHUNK: 'file/chunk',
  FILE_END: 'file/end',
  FILE_ERROR: 'file/error',
  ASSISTANTS: 'assistants',
  POWER_STATE: 'power/state',
})

/** Frame types the computer sends in reply to a client request. */
export const ACTIVITY_KIND = /** @type {const} */ ({
  THINKING: 'thinking',
  TOOL_START: 'tool-start',
  TOOL_END: 'tool-end',
})

/** Reasons a `power/request` may be refused; surfaced verbatim to the phone. */
export const POWER_REFUSAL = /** @type {const} */ ({
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
  NO_PRIVILEGE: 'no-privilege',
  DISABLED_BY_POLICY: 'disabled-by-policy',
  ALREADY_PENDING: 'already-pending',
  FAILED: 'failed',
})

/**
 * @typedef {object} QrPairingPayload
 * The exact JSON object encoded in the binding QR code. Keep it compact: QR
 * density is a real scanning risk, and this is read by a phone camera.
 * `secret` is a single-use pairing secret with a short TTL — it is NOT the
 * long-term credential, so a photographed QR is only dangerous inside the window.
 * @property {1} v
 * @property {'openwhale'} p          Protocol tag, so a foreign QR is rejected early.
 * @property {string} host            Computer display name.
 * @property {string} id              Stable computer id (opaque, random, not a hostname).
 * @property {string} fp              Long-term computer public key fingerprint (SHA-256, hex, grouped).
 * @property {string=} pk             Computer Ed25519 public key, base64url SPKI DER. Present so the
 *                                    phone can verify the signature in `hello/ack` and detect an impostor
 *                                    holding the same tunnel URL. A payload without it still binds, but
 *                                    the phone can then only compare the fingerprint.
 * @property {string} secret          Single-use pairing secret (base64url, >=128 bits).
 * @property {string} expires         ISO-8601 expiry instant of `secret`.
 * @property {string[]} endpoints     Candidate base URLs, best first (https when tunneled).
 * @property {string|number=} port    LAN port, for the same-network case.
 * @property {string=} lan            LAN base URL (http://192.168.x.y:port) when known.
 * @property {string=} name           Suggested assistant label (usually the host name).
 * @property {string=} version        Plugin version, for diagnostics.
 */

/**
 * @typedef {object} HelloFrame
 * Sent immediately after the socket opens, before anything is trusted.
 * @property {'hello'} t
 * @property {string} version        Protocol version the client speaks ('1.0.0').
 * @property {string} deviceId       Client-generated stable id (opaque).
 * @property {string} deviceName     Human name shown on the computer side.
 * @property {string} devicePublicKey base64url-encoded Ed25519 public key (SPKI DER).
 * @property {string} nonce          Client-generated random nonce, unique per hello.
 * @property {string} [pairSecret]   Present only on the first, pairing handshake.
 * @property {string} [signature]    Required for an already-bound device: the Ed25519 signature
 *                                   over `helloSignatureMessage(nonce)`.
 */

/**
 * The exact string a client signs (and the computer verifies) when reconnecting
 * with an already-bound device key.
 *
 * The nonce is chosen by the *client* on purpose: the client needs something to
 * sign before it has received anything from the computer, and the computer only
 * trusts that key after verifying this signature. Replay is prevented by rejecting
 * a nonce the device has already used (see `NonceReplayGuard`), not by trusting a
 * client-supplied timestamp.
 * @param {string} nonce
 * @returns {string}
 */
export function helloSignatureMessage(nonce) {
  return `openwhale-hello:${nonce}`
}

/**
 * Small bounded store of nonces already used by a device, so a captured and
 * replayed `hello` cannot authenticate a second time.
 *
 * Bounded by age and by entry count: a device that reconnects forever must not
 * grow this without limit, and the window only has to outlive the shortest
 * network round-trip (an attacker replaying a hello is doing it immediately).
 */
export class NonceReplayGuard {
  /**
   * @param {{windowMs?: number, maxPerDevice?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 10 * 60 * 1000
    this.maxPerDevice = options.maxPerDevice ?? 256
    this.now = options.now ?? (() => Date.now())
    /** @type {Map<string, Map<string, number>>} deviceId → (nonce → usedAt) */
    this.seen = new Map()
  }

  /**
   * Record a nonce as used. Returns false when it was already used inside the
   * window, which is the replay case the caller must reject.
   * @param {string} deviceId
   * @param {string} nonce
   * @returns {boolean} true when the nonce is fresh
   */
  use(deviceId, nonce) {
    const now = this.now()
    let entries = this.seen.get(deviceId)
    if (!entries) {
      entries = new Map()
      this.seen.set(deviceId, entries)
    }
    for (const [key, usedAt] of entries) {
      if (now - usedAt > this.windowMs) entries.delete(key)
    }
    if (entries.has(nonce)) return false
    entries.set(nonce, now)
    // Oldest-first eviction keeps the structure bounded even inside the window.
    while (entries.size > this.maxPerDevice) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    return true
  }

  /** Forget a device (unbind), so its ids cannot be replayed or accumulate. */
  forget(deviceId) {
    this.seen.delete(deviceId)
  }
}

/**
 * @typedef {object} HelloAckFrame
 * @property {'hello/ack'} t
 * @property {string} version
 * @property {string} computerId
 * @property {string} computerName
 * @property {string} computerFingerprint
 * @property {boolean} paired          True when this device is already bound.
 * @property {boolean} pairAccepted    True when a first-time pairing was accepted.
 * @property {string} nonce            Addressable copy of the server nonce for diagnostics.
 * @property {string} [proof]          Ed25519 signature by the computer key over
 *                                     `helloAckProofMessage(nonce, deviceId)`, verifiable with the
 *                                     `pk` from the pairing QR.
 * @property {number} [heartbeatMs]    How often the client should send `ping`.
 * @property {string} [serverTime]     ISO-8601, so the phone can show correct times.
 */

/**
 * The exact string the computer signs in `hello/ack`, so the phone can prove it is
 * talking to the computer it paired with.
 * @param {string} nonce
 * @param {string} deviceId
 * @returns {string}
 */
export function helloAckProofMessage(nonce, deviceId) {
  return `openwhale-hello-ack:${nonce}:${deviceId}`
}

/**
 * @typedef {object} ChatSendFrame
 * @property {'chat/send'} t
 * @property {string} rid
 * @property {string} text
 * @property {Array<{name: string, mime: string, dataBase64: string}>} [files]
 *           Attachments the phone uploads with the message (small files only).
 */

/**
 * @typedef {object} ChatDeltaFrame
 * One incremental piece of the assistant's answer. Clients append `text` to the
 * bubble identified by `callId`; `seq` is strictly increasing per call so a
 * dropped/duplicated delta is detectable.
 * @property {'chat/delta'} t
 * @property {string} callId
 * @property {number} seq
 * @property {string} text
 */

/**
 * @typedef {object} ChatDoneFrame
 * @property {'chat/done'} t
 * @property {string} callId
 * @property {string} text          Full assistant text, authoritative over deltas.
 * @property {number} [durationMs]
 * @property {boolean} [truncated]  True when the plugin clamped an over-long answer.
 */

/**
 * @typedef {object} ToolFrame
 * Activity line rendered as a small status row in the app, never as assistant prose.
 * @property {'chat/tool'} t
 * @property {string} callId
 * @property {'tool-start'|'tool-end'} phase
 * @property {string} toolCallId
 * @property {string} tool          Tool name.
 * @property {string} [summary]     Short human-readable summary of the call.
 * @property {boolean} [ok]
 */

/**
 * @typedef {object} FileMetaFrame
 * @property {'file/meta'} t
 * @property {string} fileId
 * @property {string} name
 * @property {number} size
 * @property {string} [mime]
 * @property {string} [sha256]
 */

/**
 * @typedef {object} FileChunkFrame
 * @property {'file/chunk'} t
 * @property {string} fileId
 * @property {number} seq
 * @property {string} dataBase64
 */

/**
 * @typedef {object} PowerRequestFrame
 * @property {'power/request'} t
 * @property {string} rid
 * @property {'shutdown'|'restart'|'cancel'|'wake'} action
 * @property {number} [delaySeconds] Grace period before the action; cancellable meanwhile.
 */

/**
 * @typedef {object} PowerStateFrame
 * @property {'power/state'} t
 * @property {string} rid
 * @property {'shutdown'|'restart'|'cancel'|'wake'} action
 * @property {boolean} accepted
 * @property {number} [delaySeconds]
 * @property {string} [cancelToken]  Opaque token for a follow-up `cancel`.
 * @property {string} [reason]       A `POWER_REFUSAL` value when `accepted` is false.
 * @property {string} [message]      Human-readable explanation for the phone UI.
 */

/**
 * @typedef {object} AssistantSummary
 * One computer the phone knows about. The phone renders one chat per assistant.
 * @property {string} id
 * @property {string} name            Display label; the user may rename it.
 * @property {string} fingerprint
 * @property {string} [endpoint]
 * @property {boolean} online
 * @property {string} [pairedAt]
 */

/** Default TCP port the plugin listens on. Chosen to be memorable and unassigned. */
export const DEFAULT_PORT = 8787

/** Heartbeat period; a client silent for 3x this is considered gone. */
export const DEFAULT_HEARTBEAT_MS = 25_000

/** Pairing secret lifetime. Short on purpose: it is the only replayable value. */
export const PAIR_SECRET_TTL_MS = 10 * 60 * 1000

/** Longest assistant answer pushed to the phone in one frame (bytes of text). */
export const MAX_ASSISTANT_CHARS = 24_000

/** File chunk size. 256 KiB keeps frames comfortably under proxy limits. */
export const FILE_CHUNK_BYTES = 256 * 1024

/** Largest single file the phone may pull from the computer. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024

/**
 * Validate a QR pairing payload. Returns a discriminated result rather than
 * throwing so callers can show a precise error in the scanner UI.
 * @param {unknown} value
 * @param {{now?: number}} [options]
 * @returns {{ok: true, payload: QrPairingPayload} | {ok: false, error: string}}
 */
export function parsePairingPayload(value, options = {}) {
  const now = options.now ?? Date.now()
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'QR 内容不是有效对象' }
  const p = /** @type {Record<string, unknown>} */ (value)
  if (p.p !== 'openwhale') return { ok: false, error: '这不是 Open Whale 的绑定二维码' }
  if (p.v !== 1) return { ok: false, error: `不支持的二维码版本：${String(p.v)}` }
  // `pk` is validated separately below: it is required in practice but must not
  // block pairing. A payload without it can still be bound, at the cost of being
  // unable to verify the computer's identity — rejecting it outright would break
  // compatibility with a QR generated by an older plugin, for a strictly better
  // outcome than refusing to bind at all.
  for (const key of ['host', 'id', 'fp', 'secret', 'expires']) {
    if (typeof p[key] !== 'string' || p[key] === '') return { ok: false, error: `二维码缺少字段：${key}` }
  }
  if (p.pk !== undefined && (typeof p.pk !== 'string' || p.pk === '')) {
    return { ok: false, error: '二维码字段 pk 格式不合法' }
  }
  if (!Array.isArray(p.endpoints) || p.endpoints.every(e => typeof e !== 'string')) {
    return { ok: false, error: '二维码缺少可用地址' }
  }
  const expires = Date.parse(/** @type {string} */ (p.expires))
  if (!Number.isFinite(expires)) return { ok: false, error: '二维码过期时间格式错误' }
  // The expiry instant itself is already expired: "valid until T" must not
  // accept a pairing at exactly T, or the single-use window is one tick longer
  // than the user was shown.
  if (expires <= now) return { ok: false, error: '二维码已过期，请在电脑上重新生成' }
  return { ok: true, payload: /** @type {QrPairingPayload} */ (p) }
}

/**
 * Constant-time string comparison. Used for secrets and tokens so that a timing
 * side channel cannot be used to recover them a byte at a time.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/**
 * Format a hex fingerprint for display: uppercase, grouped in fours.
 * @param {string} hex
 * @returns {string}
 */
export function formatFingerprint(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  const groups = clean.match(/.{1,4}/g) ?? []
  return groups.slice(0, 16).join(' ')
}

/**
 * Pick the endpoint a client should try first. Callers pass the list the
 * computer advertised plus the one currently in use, so a reconnect does not
 * keep retrying a dead tunnel.
 * @param {string[]} endpoints
 * @param {string|undefined} preferred
 * @returns {string|undefined}
 */
export function pickEndpoint(endpoints, preferred) {
  if (preferred && endpoints.includes(preferred)) return preferred
  return endpoints.find(e => e.startsWith('https://')) ?? endpoints[0]
}

/**
 * Clamp an assistant answer to the protocol's per-frame limit without cutting a
 * surrogate pair in half (which would render as a replacement character).
 * @param {string} text
 * @param {number} [limit]
 * @returns {{text: string, truncated: boolean}}
 */
export function clampAssistantText(text, limit = MAX_ASSISTANT_CHARS) {
  if (text.length <= limit) return { text, truncated: false }
  let cut = limit
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return { text: `${text.slice(0, cut)}\n\n…（内容过长，已截断；完整内容可在电脑上查看）`, truncated: true }
}
