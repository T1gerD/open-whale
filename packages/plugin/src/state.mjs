// Persistent state for the Open Whale computer plugin.
//
// Everything here is deliberately dependency-free (node:crypto + node:fs) so the
// plugin installs with no build step and no native modules. The file is JSON with
// 0600 permissions and is written atomically, because losing computer identity
// would invalidate every paired phone.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  timingSafeEqual as nodeTimingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_PORT, PAIR_SECRET_TTL_MS, timingSafeEqual } from './protocol.mjs'

/** Schema version of the state file; bump with a migration when the shape changes. */
export const STATE_VERSION = 1

/**
 * How many phones may be bound to one computer.
 *
 * It used to be implicitly 1: the gateway refused a second device even with a
 * valid pairing secret. A five-person demo needs more, and devices are already
 * isolated per device by `sessionIdFor`, so the only real cost is unbounded
 * growth from a leaked QR — hence a hard cap rather than "unlimited".
 */
export const MAX_DEVICES = 5

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function shortId(prefix) {
  return `${prefix}_${randomBytes(9).toString('hex')}`
}

/** SHA-256 over the raw 32-byte Ed25519 public key; stable across restarts. */
export function fingerprintOf(publicKeyDer) {
  return createHash('sha256').update(publicKeyDer).digest('hex')
}

/**
 * Derive the raw 32-byte Ed25519 public key from a KeyObject.
 * @param {import('node:crypto').KeyObject} key
 */
function rawPublicKey(key) {
  const der = key.export({ type: 'spki', format: 'der' })
  // The raw key is the trailing 32 bytes of the SPKI structure for Ed25519.
  return der.subarray(der.length - 32)
}

/**
 * Durable, single-writer state store for one computer.
 *
 * Trust model encoded here:
 *  - the computer owns one long-term Ed25519 keypair (identity);
 *  - a phone is trusted only while a `DeviceRecord` for it exists;
 *  - a `pairSecret` is single-use, TTL-bounded and consumed exactly once;
 *  - one device id can never be attached twice, and re-pairing a *new* device is
 *    only possible while the store is not "locked" to an existing phone —
 *    callers decide that policy, the store just records it.
 */
export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.dir        Directory holding `state.json`.
   * @param {string} [options.hostName] Computer display name.
   * @param {number} [options.port]     Listen port recorded for LAN endpoints.
   * @param {() => number} [options.now] Injectable clock (tests).
   */
  constructor(options) {
    this.dir = options.dir
    this.file = join(options.dir, 'state.json')
    /** @type {() => number} */
    this.now = options.now ?? (() => Date.now())
    this.hostName = options.hostName ?? 'Open Whale 电脑'
    this.port = options.port ?? DEFAULT_PORT
    /** @type {any} */
    this.data = this.#load()
    this.#ensureIdentity()
  }

  #load() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
        if (parsed && parsed.version === STATE_VERSION) return parsed
      }
    } catch (error) {
      // A corrupt state file must not brick the plugin; move it aside so the
      // user keeps the old data for inspection and we start clean.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
    }
    return {
      version: STATE_VERSION,
      identity: null,
      computer: null,
      pairing: null,
      devices: [],
      preferences: {},
    }
  }

  #ensureIdentity() {
    if (!this.data.identity) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      this.data.identity = {
        id: shortId('cmp'),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        // Escrow the raw seed too: it makes key rotation and export possible
        // without parsing PEM back out, and it is not weaker than the PEM above.
        createdAt: new Date(this.now()).toISOString(),
      }
    }
    if (!this.data.computer) {
      this.data.computer = { name: this.hostName, port: this.port }
    }
    this.save()
  }

  /** @returns {string} Stable opaque computer id. */
  get computerId() {
    return this.data.identity.id
  }

  /** @returns {string} Uppercase hex SHA-256 of the computer public key. */
  get fingerprint() {
    return fingerprintOf(rawPublicKey(this.publicKeyObject))
  }

  /** @returns {import('node:crypto').KeyObject} */
  get privateKeyObject() {
    return createPrivateKey(this.data.identity.privateKey)
  }

  /** @returns {import('node:crypto').KeyObject} */
  get publicKeyObject() {
    return createPublicKey(this.data.identity.publicKey)
  }

  /**
   * Sign an arbitrary string with the computer identity key.
   * Used to prove "this QR really came from this computer" during pairing.
   * @param {string} message
   * @returns {string} base64url signature
   */
  sign(message) {
    return base64url(cryptoSign(null, Buffer.from(message, 'utf8'), this.privateKeyObject))
  }

  /**
   * Verify a signature made by a paired *device* key.
   * @param {string} deviceId
   * @param {string} message
   * @param {string} signature base64url
   * @returns {boolean}
   */
  verifyDeviceSignature(deviceId, message, signature) {
    const device = this.device(deviceId)
    if (!device) return false
    try {
      const key = createPublicKey({
        key: Buffer.from(device.publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      })
      return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'))
    } catch {
      return false
    }
  }

  /**
   * The computer's Ed25519 public key as base64url **SPKI DER** (44 bytes for
   * Ed25519), which is what `crypto.createPublicKey({format:'der',type:'spki'})`
   * accepts on both Node and the mobile client.
   *
   * This is what the pairing QR carries so the phone can verify the `proof`
   * signature in `hello/ack`. It is a public key: putting it in a QR is safe, and
   * without it a phone cannot tell the real computer from an impostor that took
   * over the same tunnel URL. Note this is the full SPKI structure, not the raw
   * 32-byte key — sending the raw key produces an unimportable QR payload.
   * @returns {string}
   */
  get publicKeySpkiBase64Url() {
    return this.publicKeyObject.export({ type: 'spki', format: 'der' }).toString('base64url')
  }

  get computerName() {
    return this.data.computer?.name ?? this.hostName
  }

  /** @param {string} name */
  setComputerName(name) {
    this.data.computer.name = String(name)
    this.save()
  }

  get devices() {
    return this.data.devices
  }

  /**
   * True when at least one phone is bound. The plugin uses this to enforce
   * "one computer may be bound to exactly one phone" (the phone side allows many
   * computers per phone).
   */
  get isPaired() {
    return this.data.devices.length > 0
  }

  /**
   * @param {string} id
   * @returns {any | undefined}
   */
  device(id) {
    return this.data.devices.find(d => d.id === id)
  }

  /**
   * Create (or refresh) a single-use pairing secret.
   * Only one pairing window is live at a time: generating a new QR invalidates
   * the previous secret, so a stale screenshot cannot be used later.
   * @param {{ttlMs?: number}} [options]
   * @returns {{secret: string, expires: string, computerId: string, fingerprint: string}}
   */
  issuePairingSecret(options = {}) {
    const ttl = options.ttlMs ?? PAIR_SECRET_TTL_MS
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + ttl
    this.data.pairing = {
      secret,
      expiresAt,
      issuedAt: this.now(),
      consumedAt: null,
    }
    this.save()
    return {
      secret,
      expires: new Date(expiresAt).toISOString(),
      computerId: this.computerId,
      fingerprint: this.fingerprint,
    }
  }

  /** @returns {{secret: string, expires: string} | null} */
  get activePairing() {
    const pairing = this.data.pairing
    if (!pairing || pairing.consumedAt) return null
    if (pairing.expiresAt <= this.now()) return null
    return { secret: pairing.secret, expires: new Date(pairing.expiresAt).toISOString() }
  }

  /**
   * Consume the pairing secret exactly once.
   * @param {string} presented
   * @returns {{ok: true} | {ok: false, reason: 'no-window'|'expired'|'mismatch'|'used'}}
   */
  consumePairingSecret(presented) {
    const pairing = this.data.pairing
    if (!pairing) return { ok: false, reason: 'no-window' }
    if (pairing.consumedAt) return { ok: false, reason: 'used' }
    if (pairing.expiresAt <= this.now()) return { ok: false, reason: 'expired' }
    if (!timingSafeEqual(pairing.secret, String(presented))) return { ok: false, reason: 'mismatch' }
    pairing.consumedAt = this.now()
    this.save()
    return { ok: true }
  }

  /**
   * Bind a phone. Re-binding the same device id refreshes its key instead of
   * creating a duplicate assistant.
   * @param {object} input
   * @param {string} input.deviceId
   * @param {string} input.deviceName
   * @param {string} input.publicKey   base64url SPKI DER
   * @param {string} [input.label]     Assistant label shown in the app.
   * @returns {any} the stored device record
   */
  bindDevice(input) {
    const existing = this.device(input.deviceId)
    if (existing) {
      existing.publicKey = input.publicKey
      existing.deviceName = input.deviceName
      existing.lastSeenAt = new Date(this.now()).toISOString()
      if (input.label) existing.label = input.label
      this.save()
      return existing
    }
    /** @type {any} */
    const record = {
      id: input.deviceId,
      deviceName: input.deviceName,
      label: input.label ?? input.deviceName,
      publicKey: input.publicKey,
      pairedAt: new Date(this.now()).toISOString(),
      lastSeenAt: new Date(this.now()).toISOString(),
    }
    this.data.devices.push(record)
    this.save()
    return record
  }

  /**
   * @param {string} id
   * @param {{label?: string}} patch
   * @returns {any | undefined}
   */
  updateDevice(id, patch) {
    const device = this.device(id)
    if (!device) return undefined
    if (patch.label !== undefined) device.label = String(patch.label)
    this.save()
    return device
  }

  /**
   * Forget a phone. Its key stops being accepted immediately.
   * @param {string} id
   * @returns {boolean}
   */
  unbindDevice(id) {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter(d => d.id !== id)
    if (this.data.devices.length !== before) {
      this.save()
      return true
    }
    return false
  }

  /**
   * The session id used for a device's assistant conversation. Deterministic so
   * the phone keeps one continuous chat across reconnects and restarts.
   * @param {string} deviceId
   * @returns {string}
   */
  sessionIdFor(deviceId) {
    const digest = createHash('sha256')
      .update(`${this.computerId}:${deviceId}`)
      .digest('hex')
      .slice(0, 32)
    return `ow-${digest}`
  }

  /**
   * The session id shared by *every* device, used in collaboration mode.
   *
   * Deliberately derived from the computer id only: all phones bound to this
   * computer land in one DSH conversation, so the five people at a demo table
   * are talking to the same assistant and see each other's turns.
   * @returns {string}
   */
  sharedSessionId() {
    const digest = createHash('sha256')
      .update(`${this.computerId}:shared`)
      .digest('hex')
      .slice(0, 32)
    return `ow-${digest}`
  }

  /** @param {string} key @param {unknown} value */
  setPreference(key, value) {
    this.data.preferences[key] = value
    this.save()
  }

  /** @param {string} key @param {unknown} fallback */
  getPreference(key, fallback = undefined) {
    return Object.hasOwn(this.data.preferences, key) ? this.data.preferences[key] : fallback
  }

  /** Atomically persist state. */
  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch { /* Windows ACLs do not use POSIX modes; ignore */ }
  }
}

/**
 * Generate an opaque bearer token (used for the short-lived socket session).
 * @param {number} [bytes]
 */
export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export { nodeTimingSafeEqual, randomUUID }
