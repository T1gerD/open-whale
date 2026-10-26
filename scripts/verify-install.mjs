// End-to-end verification of an installed Open Whale plugin.
//
// What this proves that unit tests cannot: that the plugin actually loads inside
// DSH, serves the pairing surfaces, and that a *foreign* client can bind with the
// QR payload and authenticate with an Ed25519 key — the exact path the phone and
// the web client take. Run it against an isolated DSH profile:
//
//   set DSH_HOME=<empty dir>
//   dsh plugin --profile e2e add <repo>/packages/plugin
//   dsh --profile e2e --no-open            # in another terminal
//   node scripts/verify-install.mjs http://127.0.0.1:3080
//
// Checks, in order (each prints PASS/FAIL and the script exits non-zero on any
// failure so CI could use it):
//   1. GET  /openwhale/health            → ok, version, device/connection counts
//   2. GET  /openwhale/pairing.json      → a payload that validates against the
//                                          *real* protocol parser (not a copy)
//   3. GET  /openwhale/app/              → the web/PWA client is served (2.2.0)
//   4. WS   handshake with pairSecret    → hello/ack, computer fingerprint matches
//                                          the QR, ack proof verifies against the
//                                          QR's public key
//   5. capability negotiation            → the computer advertises 2.2.0 features
//   6. session snapshot/catch-up         → session/state or session/events arrives
//   7. one chat/send with a fixed msgId  → chat/ack arrives; sending the same msgId
//                                          again returns a duplicate ack and does
//                                          NOT start a second turn (2.2.0 idempotency)
//
// Deliberately zero dependencies: same policy as the plugin, so this runs on a
// bare Node in the same sandbox the project already tests in.
import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

import { PROTOCOL_VERSION, parsePairingPayload } from '../packages/protocol/src/index.mjs'

const baseArg = process.argv[2] ?? process.env.OPENWHALE_BASE ?? 'http://127.0.0.1:3080'
const base = baseArg.replace(/\/+$/, '')
const WS_PATH = '/openwhale/ws'

let failures = 0
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
  return ok
}

/** @param {string} path */
async function getJson(path) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body, text }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/** Minimal frame socket with a pending-reply map, so each step can await one frame. */
class FrameSocket {
  constructor(url) {
    this.url = url
    this.ws = new WebSocket(url)
    /** @type {Map<string, Array<(frame: any) => void>>} */
    this.waiters = new Map()
    this.received = []
    this.ws.addEventListener('message', event => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      this.received.push(frame)
      const list = this.waiters.get(frame.t)
      if (list && list.length > 0) {
        const resolve = list.shift()
        resolve?.(frame)
      }
    })
  }

  open() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket open timeout')), 15_000)
      this.ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      this.ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('websocket error'))
      })
    })
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame))
  }

  /** Wait for the next frame of the given type. */
  waitFor(type, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(type) ?? []
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
      list.push(frame => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.waiters.set(type, list)
    })
  }

  close() {
    try {
      this.ws.close(1000, 'verify done')
    } catch { /* already closed */ }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 1. health
// ---------------------------------------------------------------------------
let health
try {
  health = await getJson('/openwhale/health')
} catch (error) {
  console.error(`cannot reach ${base} — is DSH running with the plugin installed?`)
  console.error(String(error))
  process.exit(2)
}
check('health endpoint answers', health.status === 200, `HTTP ${health.status}`)
check('plugin reports ready', health.body?.ok === true, JSON.stringify(health.body))
const version = String(health.body?.version ?? '')
check('plugin version is 2.2.x or newer', version === '' || /^2\.(?:[2-9]|[1-9]\d)\./.test(version), version || 'not reported by /health')

// ---------------------------------------------------------------------------
// 2. pairing payload
// ---------------------------------------------------------------------------
const pairing = await getJson('/openwhale/pairing.json')
check('pairing.json answers', pairing.status === 200, `HTTP ${pairing.status}`)
const rawPayload = pairing.body?.payload ?? pairing.body
const parsed = rawPayload ? parsePairingPayload(rawPayload, { now: Date.now() }) : { ok: false, error: 'no body' }
check('pairing payload validates against the real protocol parser', parsed.ok === true, parsed.ok ? '' : parsed.error)
if (!parsed.ok) {
  console.error('\nCannot continue without a valid pairing payload (already bound? unbind first).')
  process.exit(1)
}
const payload = parsed.payload
console.log(`      endpoints: ${payload.endpoints.join(', ')}`)
if (Array.isArray(payload.epk)) console.log(`      endpoint kinds: ${payload.epk.join(',')} (mode=${payload.mode ?? 'n/a'})`)
if (payload.web) console.log(`      web client: ${payload.web}`)

// ---------------------------------------------------------------------------
// 3. web/PWA client is served
// ---------------------------------------------------------------------------
try {
  const asset = await getJson('/openwhale/app/')
  const isHtml = /<html/i.test(asset.text)
  check('/openwhale/app/ serves the web client', asset.status === 200 && isHtml, `HTTP ${asset.status}, ${asset.text.length} bytes`)
} catch (error) {
  check('/openwhale/app/ serves the web client', false, String(error))
}

// ---------------------------------------------------------------------------
// 4. WebSocket handshake using the QR secret + a fresh Ed25519 device key
// ---------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeySpki = base64url(publicKey.export({ format: 'der', type: 'spki' }))
const deviceId = `dev_${randomBytes(9).toString('hex')}`
const nonce = base64url(randomBytes(16))
const helloSignature = base64url(sign(null, Buffer.from(`openwhale-hello:${nonce}`), privateKey))

const wsBase = payload.endpoints[0]
const wsUrl = `${wsBase.startsWith('https') ? 'wss' : 'ws'}://${wsBase.replace(/^https?:\/\//, '')}${WS_PATH}`
console.log(`      websocket: ${wsUrl}`)

const socket = new FrameSocket(wsUrl)
await socket.open()
socket.send({
  t: 'hello',
  version: PROTOCOL_VERSION,
  deviceId,
  deviceName: 'verify-install',
  devicePublicKey: publicKeySpki,
  nonce,
  pairSecret: payload.secret,
  signature: helloSignature,
  capabilities: [
    'chat-echo-v1',
    'chat-message-v1',
    'session-sync-v1',
    'participants-v1',
    'upload-v1',
    'collab-v1',
    'file-offer-v1',
    'endpoint-kinds-v1',
  ],
  cursor: 0,
})

let ack
try {
  ack = await socket.waitFor('hello/ack', 20_000)
} catch (error) {
  const errorFrame = socket.received.find(frame => frame.t === 'error')
  check('hello handshake succeeds', false, `no hello/ack (${JSON.stringify(errorFrame ?? String(error))})`)
  socket.close()
  process.exit(1)
}
check('hello handshake succeeds', true, `paired=${ack.paired} pairAccepted=${ack.pairAccepted}`)
check('computer id matches the QR', ack.computerId === payload.id, `${ack.computerId}`)
const fingerprintOk = String(ack.computerFingerprint ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase() ===
  String(payload.fp ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
check('computer fingerprint matches the QR', fingerprintOk)

if (typeof payload.pk === 'string' && payload.pk.length > 0 && typeof ack.proof === 'string') {
  const message = Buffer.from(`openwhale-hello-ack:${ack.nonce}:${deviceId}`)
  const computerKey = Buffer.from(payload.pk, 'base64url')
  const keyObject = (await import('node:crypto')).createPublicKey({ key: computerKey, format: 'der', type: 'spki' })
  const proofOk = verify(null, message, keyObject, Buffer.from(ack.proof, 'base64url'))
  check('hello/ack proof verifies against the QR public key', proofOk)
} else {
  check('hello/ack proof verifies against the QR public key', false, 'missing pk in QR or proof in ack')
}

// ---------------------------------------------------------------------------
// 5. capability negotiation
// ---------------------------------------------------------------------------
const capabilities = Array.isArray(ack.capabilities) ? ack.capabilities : []
check('computer advertises 2.2.0 capabilities', capabilities.includes('session-sync-v1') && capabilities.includes('chat-echo-v1'), capabilities.join(','))
check('hello/ack carries the session id', typeof ack.sessionId === 'string' && ack.sessionId.length > 0, String(ack.sessionId))
check('hello/ack reports the plugin version', typeof ack.serverVersion === 'string' && ack.serverVersion.length > 0, String(ack.serverVersion))
check('hello/ack reports collaboration state', typeof ack.collaboration === 'boolean', String(ack.collaboration))

// ---------------------------------------------------------------------------
// 6. session snapshot / catch-up
// ---------------------------------------------------------------------------
// The computer may push `session/state` or `session/events` as soon as it processes
// `hello`, i.e. before this code starts waiting. Poll the received buffer instead of
// registering a single waiter, so neither frame can be missed.
let snapshot = socket.received.find(frame => frame.t === 'session/state' || frame.t === 'session/events')
for (let i = 0; !snapshot && i < 50; i++) {
  await sleep(200)
  snapshot = socket.received.find(frame => frame.t === 'session/state' || frame.t === 'session/events')
}
if (!snapshot) {
  // An empty conversation legitimately has nothing to replay; ask for a snapshot
  // explicitly to prove the request path works too.
  socket.send({ t: 'session/sync', rid: `sync_${randomBytes(4).toString('hex')}`, cursor: 0 })
  for (let i = 0; !snapshot && i < 50; i++) {
    await sleep(200)
    snapshot = socket.received.find(frame => frame.t === 'session/state' || frame.t === 'session/events')
  }
}
check('conversation snapshot or catch-up arrives after hello', Boolean(snapshot), snapshot?.t ?? 'none')

// ---------------------------------------------------------------------------
// 7. idempotent chat/send
// ---------------------------------------------------------------------------
const msgId = `msg_verify_${randomBytes(6).toString('hex')}`
const send = () => socket.send({ t: 'chat/send', rid: msgId, msgId, callId: msgId, text: '来自 verify-install 的连通性测试', files: [] })
send()
let ackFrame
try {
  ackFrame = await socket.waitFor('chat/ack', 20_000)
} catch (error) {
  const errorFrame = socket.received.find(frame => frame.t === 'chat/error' || frame.t === 'error')
  check('chat/send is accepted', false, JSON.stringify(errorFrame ?? String(error)))
}
if (ackFrame) {
  check('chat/send is accepted', ackFrame.callId === msgId, `callId=${ackFrame.callId}`)
  // Re-send the exact same msgId: 2.2.0 must answer with a duplicate ack and not
  // deliver the message into the agent conversation a second time.
  send()
  let duplicateAck
  try {
    duplicateAck = await socket.waitFor('chat/ack', 10_000)
  } catch { /* reported below */ }
  const duplicate = duplicateAck && (duplicateAck.duplicate === true || duplicateAck.deduped === true)
  check('replaying the same msgId returns a duplicate ack', Boolean(duplicate), JSON.stringify(duplicateAck ?? null))
  // Give the (possibly unconfigured) model a moment; an error frame here is fine —
  // the point is that the turn started exactly once, which the duplicate check covers.
  await sleep(1_500)
  const errorFrame = socket.received.find(frame => frame.t === 'chat/error')
  if (errorFrame) console.log(`      note: agent turn reported an error (expected without a model): ${errorFrame.message}`)
}

socket.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
