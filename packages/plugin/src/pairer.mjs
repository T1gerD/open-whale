// Pairing / QR code generation for the Open Whale computer plugin.
//
// The QR carries a *single-use, short-lived* secret, never the long-term device
// credential. A photographed QR is therefore only dangerous while the pairing
// window is open, and the window closes on first use.
//
// The QR encoder is in-tree (src/qr.mjs) rather than an npm dependency so that a
// fresh checkout can display a binding code with no install step at all.
import { DEFAULT_PORT, PAIR_SECRET_TTL_MS, encodeEndpointKinds, orderEndpoints } from './protocol.mjs'
import { MAX_DEVICES } from './state.mjs'
import { encode, toPng, toSvg, toTerminal } from './qr.mjs'

/**
 * @typedef {object} PairingOptions
 * @property {import('./state.mjs').StateStore} store
 * @property {string[]} [tunnelUrls] Public base URLs (https) currently reachable.
 * @property {string[]} [lanUrls]    LAN base URLs (http) currently reachable.
 * @property {number} [ttlMs]
 * @property {number} [port]
 * @property {string} [mode]         Connection mode that produced this ordering.
 * @property {string} [web]          Web/PWA client URL shown as a second QR.
 * @property {string} [version]      Plugin version for diagnostics.
 */

/**
 * Build the payload that goes into the QR code.
 *
 * Endpoint order comes from the shared protocol helper so the phone does not
 * have to guess: in `auto` that means Tailscale → LAN → tunnel, which is the
 * v2.2.0 fix for "the public tunnel always wins".
 * @param {PairingOptions} options
 */
export function buildPairingPayload(options) {
  const { store } = options
  const issued = store.issuePairingSecret({ ttlMs: options.ttlMs ?? PAIR_SECRET_TTL_MS })
  const raw = [...(options.tunnelUrls ?? []), ...(options.lanUrls ?? [])].filter(Boolean)
  const endpoints = orderEndpoints(raw, { mode: options.mode ?? 'auto' })
  if (endpoints.length === 0) {
    throw new Error('没有可用地址：请至少启用局域网监听或公网隧道后再生成二维码')
  }
  return {
    v: 1,
    p: 'openwhale',
    host: store.computerName,
    id: store.computerId,
    fp: store.fingerprint,
    pk: store.publicKeySpkiBase64Url,
    secret: issued.secret,
    expires: issued.expires,
    endpoints,
    epk: encodeEndpointKinds(endpoints),
    ...(options.web ? { web: options.web } : {}),
    mode: options.mode ?? 'auto',
    port: options.port ?? DEFAULT_PORT,
    lan: (options.lanUrls ?? [])[0],
    name: store.computerName,
    version: options.version ?? '2.2.1',
  }
}

/**
 * Render arbitrary text as a QR code. Used for the web-client URL, which a
 * system camera must read as a plain URL (a JSON-quoted URL would not open).
 * @param {string} text
 * @param {{scale?: number, margin?: number}} [options]
 * @returns {Promise<{dataUrl: string, png: Buffer, svg: string, terminal: string, target: string, version: number}>}
 */
export async function renderQrContent(text, options = {}) {
  const target = String(text)
  const qr = encode(target, { level: 'M' })
  const png = toPng(qr, { scale: options.scale ?? 8, margin: options.margin ?? 4 })
  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    png,
    svg: toSvg(qr, { scale: 10, margin: 2 }),
    terminal: toTerminal(qr, { margin: 2 }),
    target,
    version: qr.version,
  }
}

/**
 * Render a pairing payload as a scannable QR code.
 * @param {object} payload
 * @param {{scale?: number, margin?: number}} [options]
 * @returns {Promise<{dataUrl: string, png: Buffer, svg: string, terminal: string, target: string, version: number}>}
 */
export async function renderPairingQr(payload, options = {}) {
  return renderQrContent(JSON.stringify(payload), options)
}

/**
 * Human-facing availability of the binding flow.
 * @param {import('./state.mjs').StateStore} store
 */
export function pairingAvailability(store) {
  const bound = store.devices.length
  if (bound >= MAX_DEVICES) {
    const labels = store.devices.map(d => d.label ?? d.deviceName).join('、')
    return {
      available: false,
      reason: 'too-many-devices',
      message: `此电脑已绑定 ${bound} 台设备（${labels}），达到上限 ${MAX_DEVICES} 台。请先在电脑端解除不用的设备。`,
    }
  }
  return {
    available: true,
    reason: 'ready',
    message: bound === 0 ? '可以绑定第一台手机。' : `已绑定 ${bound} 台，最多可再绑定 ${MAX_DEVICES - bound} 台。`,
  }
}
