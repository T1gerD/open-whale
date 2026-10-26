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

/**
 * Bump when a breaking change is made. Both sides compare `major`.
 *
 * 2.2.0 keeps the wire format at **1.x on purpose**: every frame added here is
 * additive and both sides are required to ignore unknown frames (design rule 1),
 * so a v2.1.0 phone keeps working against a v2.2.0 computer and the other way
 * round. New behaviour is negotiated through `capabilities` instead of a version
 * check, which is what lets a user upgrade one side at a time.
 */
export const PROTOCOL_VERSION = '1.1.0'

/**
 * Feature flags exchanged in `hello` / `hello/ack`.
 *
 * A capability means "I understand these frames"; it never means the feature is
 * enabled (that is a separate boolean, e.g. `collaboration`). A peer that does
 * not advertise a capability must simply not be sent those frames.
 */
export const CAPABILITIES = /** @type {const} */ ({
  /** `chat/echo`: a user message from any device in the session is echoed to peers. */
  CHAT_ECHO: 'chat-echo-v1',
  /** `chat/message`: one assistant message, upserted by `messageId` (dedupes attempt/message). */
  CHAT_MESSAGE: 'chat-message-v1',
  /** `session/sync` + `session/events`: snapshot and cursor-based catch-up. */
  SESSION_SYNC: 'session-sync-v1',
  /** `session/participants`: who is in the conversation right now. */
  PARTICIPANTS: 'participants-v1',
  /** `upload/*`: chunked, back-pressured attachment upload. */
  UPLOAD: 'upload-v1',
  /** `collab/set` + `collab/state`: collaboration can be switched from the phone. */
  COLLAB: 'collab-v1',
  /** `file/offered`: the computer can push a file card into the conversation. */
  FILE_OFFER: 'file-offer-v1',
  /** The pairing QR / hello-ack carry classified endpoints (`epk`). */
  ENDPOINT_KINDS: 'endpoint-kinds-v1',
})

/** Every capability this build understands. */
export const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES))

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
  DEVICE_RENAME: 'device/rename',
  DEVICE_FORGET: 'device/forget',
  POWER: 'power/request',
  /** Ask for the conversation state missed while offline (`cursor` based). */
  SESSION_SYNC: 'session/sync',
  /** Chunked attachment upload, three-step handshake. */
  UPLOAD_START: 'upload/start',
  UPLOAD_CHUNK: 'upload/chunk',
  UPLOAD_END: 'upload/end',
  UPLOAD_CANCEL: 'upload/cancel',
  /** Switch collaboration mode from the phone. */
  COLLAB_SET: 'collab/set',
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
  /** A user message from any device in the conversation, broadcast to its peers. */
  CHAT_ECHO: 'chat/echo',
  /** One assistant message, upserted by `messageId`. */
  CHAT_MESSAGE: 'chat/message',
  /** Full snapshot of a conversation (first connect / session switch). */
  SESSION_STATE: 'session/state',
  /** Durable events after the client's `cursor` (reconnect catch-up). */
  SESSION_EVENTS: 'session/events',
  /** Who is in this conversation right now. */
  PARTICIPANTS: 'session/participants',
  /** Collaboration state changed (by the computer or another phone). */
  COLLAB_STATE: 'collab/state',
  /** Upload handshake replies. */
  UPLOAD_READY: 'upload/ready',
  UPLOAD_PROGRESS: 'upload/progress',
  UPLOAD_DONE: 'upload/done',
  UPLOAD_ERROR: 'upload/error',
  /** The computer queued a file for this device to download. */
  FILE_OFFERED: 'file/offered',
})

/** How the phone reaches the computer. One value is always chosen explicitly. */
export const CONNECTION_MODE = /** @type {const} */ ({
  /** Pick automatically: last working endpoint first, then Tailscale, LAN, tunnel. */
  AUTO: 'auto',
  LAN: 'lan',
  TAILSCALE: 'tailscale',
  TUNNEL: 'tunnel',
})

/** Every connection mode, in the order the UI offers them. */
export const CONNECTION_MODES = Object.freeze(Object.values(CONNECTION_MODE))

/**
 * Network kind of one endpoint. The plugin classifies them so the phone never
 * has to guess, and so "Tailscale" stops being treated as just another LAN IP.
 */
export const ENDPOINT_KIND = /** @type {const} */ ({
  LAN: 'lan',
  TAILSCALE: 'tailscale',
  TUNNEL: 'tunnel',
  LOOPBACK: 'loopback',
  UNKNOWN: 'unknown',
})

/**
 * One-letter codes used in the pairing QR (`epk`), because QR density is a real
 * scanning risk: the full word "tailscale" four times would grow the code by
 * ~150 bytes for no benefit.
 */
export const ENDPOINT_KIND_CODE = /** @type {const} */ ({
  lan: 'l',
  tailscale: 't',
  tunnel: 'c',
  loopback: 'u',
  unknown: 'x',
})

/** Reverse map for parsing `epk`. */
export const ENDPOINT_CODE_KIND = /** @type {const} */ ({
  l: ENDPOINT_KIND.LAN,
  t: ENDPOINT_KIND.TAILSCALE,
  c: ENDPOINT_KIND.TUNNEL,
  u: ENDPOINT_KIND.LOOPBACK,
  x: ENDPOINT_KIND.UNKNOWN,
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
 * @property {string[]=} epk          One-letter endpoint kinds aligned with `endpoints`
 *                                    (`l` LAN, `t` Tailscale, `c` public tunnel, `u` USB loopback,
 *                                    `x` unknown). Added in 2.2.0; a v2.1.0 phone ignores it.
 * @property {string=} web            Web/PWA client URL (HarmonyOS + iOS + any browser). The plugin
 *                                    page shows it as a second QR so a system camera can open it.
 * @property {string=} mode           Which connection mode produced this ordering (see CONNECTION_MODE).
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
 * @property {string[]} [capabilities] Additive feature flags (see `CAPABILITIES`).
 *                                   Absent from a v2.1.0 client, so the computer must treat
 *                                   "no list" as "no optional frames".
 * @property {number} [cursor]       Highest `seq` of the conversation event log this client has
 *                                   already applied. Only meaningful with `SESSION_SYNC`.
 * @property {string} [sessionId]    Conversation the client believes it is in. Used to detect
 *                                   that collaboration mode switched the session under it.
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
 * @property {string[]} [capabilities] Additive feature flags the computer understands.
 * @property {string} [sessionId]      The conversation this device is bound to. Changes when
 *                                     collaboration mode is switched; the phone must then drop
 *                                     its local view and take the `session/sync` snapshot.
 * @property {number} [sessionEpoch]   Increments on every session switch, so two switches back to
 *                                     the same id are still detectable.
 * @property {number} [eventCursor]    Highest durable event `seq` the computer holds for this
 *                                     conversation. `0` means "no log yet, take the snapshot".
 * @property {boolean} [collaboration] Collaboration mode is currently ON for this computer.
 * @property {string} [connectionMode] Which connection mode the computer advertises
 *                                     (`auto|lan|tailscale|tunnel`), so the phone can show it.
 * @property {Array<{url: string, kind: string}>} [endpointList] Classified endpoints (2.2.0+).
 *                                     `endpoints` stays for v2.1.0 clients.
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
 * @property {string} [msgId]      Client-generated idempotency key (also used as the bubble id
 *                                 everywhere). Falls back to `rid`/`callId` so a v2.1.0 client
 *                                 still gets server-side duplicate suppression.
 * @property {string} [callId]     Legacy alias of `rid`.
 * @property {string} text
 * @property {string} [speaker]    Display name of the sender (collaboration mode).
 * @property {Array<{uploadId?: string, name: string, mime?: string, size?: number, dataBase64?: string}>} [files]
 *           Attachments. v2.2.0 clients upload through `upload/*` and send only `uploadId`s;
 *           inline `dataBase64` stays supported for a v2.1.0 client (bounded by the plugin).
 */

/**
 * @typedef {object} ChatEchoFrame
 * One user message in the conversation, broadcast to every device in the session
 * (including the sender, which already has it locally and dedupes by `msgId`).
 * @property {'chat/echo'} t
 * @property {string} msgId
 * @property {string} [rid]
 * @property {string} [callId]
 * @property {string} deviceId     Which device sent it.
 * @property {string} [speaker]    Display name shown in peers' bubbles.
 * @property {string} text
 * @property {Array<{fileId?: string, name: string, size: number, mime?: string}>} [files]
 * @property {string} at           ISO-8601 send time (computer clock).
 * @property {number} [seq]        Event log sequence number.
 */

/**
 * @typedef {object} ChatMessageFrame
 * One assistant message. `messageId` is stable per assistant message in DSH, so a
 * replayed `assistant/attempt` can never append the same text twice.
 * @property {'chat/message'} t
 * @property {string} callId
 * @property {string} messageId
 * @property {number} index        Order inside this turn (0-based).
 * @property {string} text         Full text of this message (replace, never append).
 * @property {number} [seq]        Event log sequence number.
 */
/**
 * @typedef {object} SessionSyncFrame
 * Full state of the conversation, pushed after `hello/ack` when the client has no
 * usable cursor (first connect, session switch) or in reply to `session/sync`.
 * @property {'session/state'} t
 * @property {string} sessionId
 * @property {number} sessionEpoch
 * @property {number} head         Newest event `seq` included; client stores it as its cursor.
 * @property {{messages: Array<{id: string, kind: 'user'|'assistant', text: string, at: string,
 *            callId?: string, msgId?: string, speaker?: string,
 *            files?: Array<{fileId?: string, name: string, size: number, mime?: string}>}>,
 *            activeCall?: {callId: string, text: string, typing: boolean}}} snapshot
 * @property {boolean} collaboration
 */

/**
 * @typedef {object} SessionEventsFrame
 * Durable events with `seq > cursor`, replayed in order (reconnect catch-up).
 * Each item is the same shape as the broadcast frame it stands for, with `seq`.
 * @property {'session/events'} t
 * @property {string} sessionId
 * @property {number} head
 * @property {number} from
 * @property {Array<ChatEchoFrame|ChatMessageFrame|{t:'chat/done', callId: string, text: string, seq: number}|{t:'file/offered', fileId: string, name: string, size: number, mime?: string, url?: string, seq: number}>} events
 */

/**
 * @typedef {object} ParticipantsFrame
 * @property {'session/participants'} t
 * @property {string} sessionId
 * @property {boolean} collaboration
 * @property {Array<{deviceId: string, name: string, online: boolean, deviceName?: string}>} participants
 */

/**
 * @typedef {object} CollabStateFrame
 * @property {'collab/state'} t
 * @property {boolean} on
 * @property {string} sessionId
 * @property {number} sessionEpoch
 */

/**
 * @typedef {object} UploadStartFrame
 * @property {'upload/start'} t
 * @property {string} uploadId
 * @property {string} name
 * @property {number} size
 * @property {string} [mime]
 * @property {string} [sha256]
 */

/**
 * @typedef {object} UploadReadyFrame
 * @property {'upload/ready'} t
 * @property {string} uploadId
 * @property {number} chunkBytes  Server-chosen chunk size.
 * @property {number} maxBytes    Remaining allowance for this device.
 */

/**
 * @typedef {object} UploadChunkFrame
 * @property {'upload/chunk'} t
 * @property {string} uploadId
 * @property {number} seq
 * @property {string} dataBase64
 */

/**
 * @typedef {object} UploadProgressFrame
 * Backpressure signal: the client must not send chunk `nextSeq` before receiving
 * this with the matching `nextSeq`.
 * @property {'upload/progress'} t
 * @property {string} uploadId
 * @property {number} nextSeq
 * @property {number} received
 */

/**
 * @typedef {object} UploadDoneFrame
 * @property {'upload/done'} t
 * @property {string} uploadId
 * @property {string} fileId
 * @property {string} name
 * @property {number} size
 * @property {string} [mime]
 * @property {string} [path]      Absolute path on the computer (inside the session workspace).
 * @property {string} [sha256]
 */

/**
 * @typedef {object} FileOfferedFrame
 * @property {'file/offered'} t
 * @property {string} fileId
 * @property {string} name
 * @property {number} size
 * @property {string} [mime]
 * @property {string} [url]       One-shot download URL (already tokenised).
 * @property {string} [from]      Display name of who sent it.
 * @property {number} [seq]
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
 * Upload chunk size for phone → computer attachments.
 *
 * 512 KiB base64-encodes to ~683 KiB of JSON, comfortably under the body limits
 * of Cloudflare Quick Tunnels and Tailscale's DERP path, while still being big
 * enough that a 20 MB photo is ~40 round-trips instead of 300.
 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024

/** Largest single attachment the phone may upload (v2.2.0: 64 MiB, was 32 MiB inline). */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** Attachments allowed per message. */
export const MAX_UPLOAD_ATTACHMENTS = 8

/** An upload with no chunk for this long is discarded and its file removed. */
export const UPLOAD_IDLE_TIMEOUT_MS = 3 * 60 * 1000

/**
 * How long the computer remembers "this device already sent this msgId".
 *
 * Must comfortably outlive a phone's reconnect + retry window (the outbox retries
 * with backoff for minutes); 30 minutes does that without unbounded memory.
 */
export const DEDUPE_TTL_MS = 30 * 60 * 1000

/** Hard cap on remembered messages so a misbehaving client cannot grow memory. */
export const DEDUPE_MAX_ENTRIES = 2048

/** Durable conversation events kept in memory for reconnect catch-up. */
export const SESSION_EVENT_LOG_LIMIT = 400

/** Messages included in a `session/sync` snapshot. */
export const SESSION_SNAPSHOT_LIMIT = 60

/** Where the plugin serves the web/PWA client (HarmonyOS, iOS, any browser). */
export const WEB_CLIENT_PATH = '/openwhale/app'

/** One-shot download route used by file cards. */
export const DOWNLOAD_PATH = '/openwhale/download'

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
  // Additive 2.2.0 fields: a malformed one is a hard error (the phone would
  // otherwise silently pick the wrong network), while an absent one is fine —
  // a v2.1.0 plugin never sends them.
  if (p.epk !== undefined) {
    if (!Array.isArray(p.epk) || !p.epk.every(code => typeof code === 'string')) {
      return { ok: false, error: '二维码字段 epk 格式不合法' }
    }
  }
  if (p.web !== undefined && (typeof p.web !== 'string' || p.web === '')) {
    return { ok: false, error: '二维码字段 web 格式不合法' }
  }
  if (p.mode !== undefined && !CONNECTION_MODES.includes(/** @type {any} */ (p.mode))) {
    return { ok: false, error: `未知的连接方式：${String(p.mode)}` }
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
 *
 * Rule changed in 2.2.0: the old implementation always preferred `https://`,
 * which meant a public tunnel beat a perfectly good LAN/Tailscale connection and
 * burned the whole retry budget on a slow hop. The ordering now comes from
 * {@link orderEndpointCandidates}; `preferred` still wins when it is still usable.
 * @param {string[]} endpoints
 * @param {string|undefined} preferred
 * @param {{mode?: string, allowLoopback?: boolean, kinds?: string[]}} [options]
 * @returns {string|undefined}
 */
export function pickEndpoint(endpoints, preferred, options = {}) {
  const list = orderEndpointCandidates(endpoints, { ...options, preferred })
  return list[0]?.url
}

// ---------------------------------------------------------------------------
// Endpoint classification and ordering (2.2.0)
// ---------------------------------------------------------------------------

/**
 * Is this host a Tailscale address?
 *
 * Two families exist and both must be recognised, or a Tailscale link keeps
 * being mistaken for a "LAN" address (which is exactly the reported bug):
 *  · IPv4 CGNAT range 100.64.0.0/10 — what `tailscale ip -4` returns;
 *  · IPv6 ULA `fd7a:115c:a1e0::/48` — Tailscale's dedicated prefix;
 *  · MagicDNS names end in `.ts.net`.
 * @param {string} host Hostname or IP literal, no port, brackets stripped.
 * @returns {boolean}
 */
export function isTailscaleHost(host) {
  const value = String(host ?? '').trim().toLowerCase()
  if (value === '') return false
  if (value.endsWith('.ts.net')) return true
  if (value.includes(':')) {
    const bare = value.replace(/^\[|\]$/g, '')
    return bare.startsWith('fd7a:115c:a1e0:') || bare === 'fd7a:115c:a1e0::'
  }
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false
  return a === 100 && b >= 64 && b <= 127
}

/**
 * RFC1918 private IPv4 (excluding the loopback handled separately).
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateIpv4Host(host) {
  const parts = String(host ?? '').trim().split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * Split an endpoint into its host without using `new URL` (Hermes' URL is
 * incomplete, and the plugin cannot depend on one either).
 * @param {unknown} endpoint
 * @returns {{scheme: string, host: string} | undefined}
 */
export function endpointAuthority(endpoint) {
  const text = String(endpoint ?? '').trim()
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)/.exec(text)
  if (!match) return undefined
  const scheme = match[1].toLowerCase()
  let authority = match[2]
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  let host = authority
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close < 0) return undefined
    host = host.slice(0, close + 1)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon >= 0) host = host.slice(0, colon)
  }
  if (host === '') return undefined
  return { scheme, host }
}

/**
 * Classify one endpoint into {@link ENDPOINT_KIND}.
 * @param {unknown} endpoint
 * @returns {string}
 */
export function classifyEndpoint(endpoint) {
  const parsed = endpointAuthority(endpoint)
  if (!parsed) return ENDPOINT_KIND.UNKNOWN
  const host = parsed.host.toLowerCase()
  const bare = host.startsWith('[') ? host.slice(1, -1) : host
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return ENDPOINT_KIND.LOOPBACK
  if (isTailscaleHost(bare)) return ENDPOINT_KIND.TAILSCALE
  const secure = parsed.scheme === 'https' || parsed.scheme === 'wss'
  if (isPrivateIpv4Host(bare)) return ENDPOINT_KIND.LAN
  if (secure) return ENDPOINT_KIND.TUNNEL
  // An http:// address on a public host is usually an explicit user choice
  // (a custom port-forward or a reverse proxy); classify it as unknown rather
  // than pretending it is a tunnel.
  return ENDPOINT_KIND.UNKNOWN
}

/**
 * Which kinds a connection mode accepts, in priority order.
 *
 * `auto` prefers the private paths first — Tailscale, then LAN, and only then the
 * public tunnel. That is the whole point of the 2.2.0 fix: the tunnel is the
 * slowest and least reliable path for most users, so it must not outrank a
 * direct one.
 * @param {string} [mode]
 * @returns {string[]}
 */
export function endpointKindsForMode(mode) {
  switch (mode) {
    case CONNECTION_MODE.LAN:
      return [ENDPOINT_KIND.LAN]
    case CONNECTION_MODE.TAILSCALE:
      return [ENDPOINT_KIND.TAILSCALE]
    case CONNECTION_MODE.TUNNEL:
      return [ENDPOINT_KIND.TUNNEL, ENDPOINT_KIND.UNKNOWN]
    case CONNECTION_MODE.AUTO:
    default:
      return [ENDPOINT_KIND.TAILSCALE, ENDPOINT_KIND.LAN, ENDPOINT_KIND.TUNNEL, ENDPOINT_KIND.UNKNOWN]
  }
}

/**
 * Order endpoints for connection attempts.
 *
 * Guarantees, in order:
 *  1. loopback (USB) is excluded unless explicitly allowed, and always last;
 *  2. `preferred` comes first when it is still allowed by the mode;
 *  3. then the mode's kind priority (`auto`: Tailscale → LAN → tunnel → unknown);
 *  4. otherwise the original order is preserved (stable sort).
 * @param {unknown[]} endpoints
 * @param {{mode?: string, preferred?: string, allowLoopback?: boolean}} [options]
 * @returns {Array<{url: string, kind: string}>}
 */
export function orderEndpointCandidates(endpoints, options = {}) {
  const mode = CONNECTION_MODES.includes(/** @type {any} */ (options.mode)) ? /** @type {string} */ (options.mode) : CONNECTION_MODE.AUTO
  const allowLoopback = options.allowLoopback === true
  const preferred = typeof options.preferred === 'string' ? options.preferred.trim() : undefined
  const kinds = endpointKindsForMode(mode)
  const items = []
  const seen = new Set()
  for (const raw of Array.isArray(endpoints) ? endpoints : []) {
    if (typeof raw !== 'string') continue
    const url = raw.trim()
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const kind = classifyEndpoint(url)
    if (kind === ENDPOINT_KIND.LOOPBACK) {
      if (!allowLoopback) continue
      items.push({ url, kind, rank: 100 })
      continue
    }
    const rank = kinds.indexOf(kind)
    if (rank < 0) continue
    items.push({ url, kind, rank })
  }
  items.sort((a, b) => {
    if (preferred) {
      if (a.url === preferred) return -1
      if (b.url === preferred) return 1
    }
    if (a.rank !== b.rank) return a.rank - b.rank
    return 0
  })
  return items.map(({ url, kind }) => ({ url, kind }))
}

/**
 * Convenience wrapper returning just the URLs.
 * @param {unknown[]} endpoints
 * @param {{mode?: string, preferred?: string, allowLoopback?: boolean}} [options]
 * @returns {string[]}
 */
export function orderEndpoints(endpoints, options = {}) {
  return orderEndpointCandidates(endpoints, options).map(item => item.url)
}

/**
 * Parse the compact `epk` array from a pairing QR into kinds.
 * `epk` and `endpoints` are parallel arrays; when lengths disagree the missing
 * tail is classified from the URL itself.
 * @param {string[]} endpoints
 * @param {unknown} epk
 * @returns {string[]}
 */
export function parseEndpointKinds(endpoints, epk) {
  const codes = Array.isArray(epk) ? epk : []
  return (Array.isArray(endpoints) ? endpoints : []).map((url, index) => {
    const code = typeof codes[index] === 'string' ? codes[index] : ''
    const mapped = ENDPOINT_CODE_KIND[code]
    return mapped ?? classifyEndpoint(url)
  })
}

/**
 * Compact `epk` array for the pairing QR.
 * @param {string[]} endpoints
 * @returns {string[]}
 */
export function encodeEndpointKinds(endpoints) {
  return (Array.isArray(endpoints) ? endpoints : []).map(url => ENDPOINT_KIND_CODE[classifyEndpoint(url)] ?? 'x')
}

// ---------------------------------------------------------------------------
// Idempotency (2.2.0)
// ---------------------------------------------------------------------------

/**
 * Dedupe key for one user message: the device plus its client-generated id.
 * @param {string} deviceId
 * @param {string} msgId
 * @returns {string}
 */
export function dedupeKey(deviceId, msgId) {
  return `${deviceId}\u0000${msgId}`
}

/**
 * Normalise a client-supplied message id into something safe to log and store.
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeMessageId(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 200) return fallback
  return trimmed
}

/**
 * Bounded TTL map: "have I already processed this exact message?".
 *
 * The phone's offline outbox deliberately re-sends an unacknowledged message, so
 * the computer MUST treat a second `chat/send` with the same `msgId` as a replay
 * instead of injecting it into the conversation twice (reported bug: one message,
 * two AI replies). A TTL + LRU bound keeps memory flat no matter what a client does.
 */
export class IdempotencyCache {
  /**
   * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEDUPE_TTL_MS
    this.maxEntries = options.maxEntries ?? DEDUPE_MAX_ENTRIES
    this.now = options.now ?? (() => Date.now())
    /** @type {Map<string, {value: any, at: number}>} insertion order == LRU order */
    this.entries = new Map()
  }

  /** @param {string} key @returns {any | undefined} */
  get(key) {
    this.#prune()
    const hit = this.entries.get(key)
    if (!hit) return undefined
    // Re-insert so the Map's insertion order keeps working as LRU order.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  /** @param {string} key */
  has(key) {
    return this.get(key) !== undefined
  }

  /**
   * @param {string} key
   * @param {any} value
   * @returns {void}
   */
  remember(key, value) {
    this.#prune()
    this.entries.delete(key)
    this.entries.set(key, { value, at: this.now() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** @param {string} key */
  forget(key) {
    this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  #prune() {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.at <= this.ttlMs) break
      this.entries.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Conversation event log (2.2.0)
// ---------------------------------------------------------------------------

/**
 * Bounded, sequence-numbered log of durable conversation events.
 *
 * Every phone in a conversation needs to be able to answer two questions after a
 * reconnect: "what did I miss?" (`eventsSince(cursor)`) and "what is the state
 * now?" (`snapshot()`). Keeping this on the computer — rather than replaying DSH
 * history — is what makes late joiners and multi-device sync work without a
 * database: the log only has to outlive one reconnect, and a client that falls
 * behind the window simply gets a snapshot instead.
 */
export class SessionEventLog {
  /**
   * @param {{limit?: number, snapshotLimit?: number}} [options]
   */
  constructor(options = {}) {
    this.limit = Math.max(1, options.limit ?? SESSION_EVENT_LOG_LIMIT)
    this.snapshotLimit = Math.max(1, options.snapshotLimit ?? SESSION_SNAPSHOT_LIMIT)
    /** @type {Array<{seq: number, event: any}>} */
    this.events = []
    this.seq = 0
  }

  /**
   * Append one durable event; returns the event with its `seq`.
   * @param {any} event
   * @returns {any}
   */
  append(event) {
    this.seq += 1
    const recorded = { ...event, seq: this.seq }
    this.events.push({ seq: this.seq, event: recorded })
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit)
    return recorded
  }

  /** @returns {number} */
  get head() {
    return this.seq
  }

  /** @returns {number} oldest seq still in the log (0 when empty) */
  get oldest() {
    return this.events.length > 0 ? this.events[0].seq : 0
  }

  /**
   * Events after `cursor`; `undefined` when the cursor fell out of the window
   * (the caller must then send a snapshot instead of a partial replay).
   * @param {number} cursor
   * @returns {any[] | undefined}
   */
  eventsSince(cursor) {
    const from = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0
    if (from >= this.seq) return []
    if (this.events.length === 0) return from === 0 ? [] : undefined
    if (from < this.events[0].seq - 1) return undefined
    return this.events.filter(item => item.seq > from).map(item => item.event)
  }

  /**
   * Rebuild a compact conversation snapshot from the log: one entry per user
   * message (`chat/echo`) and per assistant turn (`chat/done`), in order.
   * @returns {Array<any>}
   */
  snapshot() {
    const messages = []
    const assistantByCall = new Map()
    for (const { event } of this.events) {
      if (event.t === SERVER_FRAME.CHAT_ECHO) {
        messages.push({
          id: `usr_${event.msgId}`,
          kind: 'user',
          text: String(event.text ?? ''),
          at: String(event.at ?? new Date().toISOString()),
          callId: event.callId,
          msgId: event.msgId,
          speaker: event.speaker,
          files: event.files,
        })
        continue
      }
      if (event.t === SERVER_FRAME.CHAT_MESSAGE) {
        const entry = assistantByCall.get(event.callId) ?? { parts: new Map(), at: undefined }
        entry.parts.set(String(event.messageId), String(event.text ?? ''))
        assistantByCall.set(event.callId, entry)
        continue
      }
      if (event.t === SERVER_FRAME.CHAT_DONE) {
        const entry = assistantByCall.get(event.callId)
        if (entry) {
          const text = [...entry.parts.values()].filter(Boolean).join('\n\n')
          messages.push({
            id: `msg_${event.callId}`,
            kind: 'assistant',
            text: text || String(event.text ?? ''),
            at: String(event.at ?? new Date().toISOString()),
            callId: event.callId,
          })
        }
        continue
      }
    }
    return messages.slice(-this.snapshotLimit)
  }

  clear() {
    this.events = []
    this.seq = 0
  }
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
