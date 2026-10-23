// Pairing / QR code generation for the Open Whale computer plugin.
//
// The QR carries a *single-use, short-lived* secret, never the long-term device
// credential. A photographed QR is therefore only dangerous while the pairing
// window is open, and the window closes on first use.
//
// The QR encoder is in-tree (src/qr.mjs) rather than an npm dependency so that a
// fresh checkout can display a binding code with no install step at all.
import { DEFAULT_PORT, PAIR_SECRET_TTL_MS } from './protocol.mjs'
import { MAX_DEVICES } from './state.mjs'
import { encode, toPng, toSvg, toTerminal } from './qr.mjs'

/**
 * @typedef {object} PairingOptions
 * @property {import('./state.mjs').StateStore} store
 * @property {string[]} [tunnelUrls] Public base URLs (https) currently reachable.
 * @property {string[]} [lanUrls]    LAN base URLs (http) currently reachable.
 * @property {number} [ttlMs]
 * @property {number} [port]
 */

/**
 * Build the payload that goes into the QR code.
 * @param {PairingOptions} options
 */
export function buildPairingPayload(options) {
  const { store } = options
  const issued = store.issuePairingSecret({ ttlMs: options.ttlMs ?? PAIR_SECRET_TTL_MS })
  const endpoints = [...(options.tunnelUrls ?? []), ...(options.lanUrls ?? [])].filter(Boolean)
  if (endpoints.length === 0) {
    throw new Error('没有可用地址：请至少启用局域网监听或公网隧道后再生成二维码')
  }
  return {
    v: 1,
    p: 'openwhale',
    host: store.computerName,
    id: store.computerId,
    fp: store.fingerprint,
    secret: issued.secret,
    expires: issued.expires,
    endpoints,
    port: options.port ?? DEFAULT_PORT,
    lan: (options.lanUrls ?? [])[0],
    name: store.computerName,
    version: '1.0.0',
  }
}

/**
 * Render a pairing payload as a scannable QR code.
 * @param {object} payload
 * @param {{scale?: number, margin?: number}} [options]
 * @returns {Promise<{dataUrl: string, png: Buffer, svg: string, terminal: string, target: string, version: number}>}
 */
export async function renderPairingQr(payload, options = {}) {
  const target = JSON.stringify(payload)
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
