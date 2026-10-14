// Remote power control for the Open Whale computer plugin.
//
// Two very different capabilities live here, and conflating them is the classic
// mistake on this feature:
//
//  1. shutdown / restart / cancel — the computer is running, so this process can
//     ask the OS to do it. Fully supported, with a cancellable grace window.
//  2. wake — the computer is OFF, so nothing running on it can help. A magic
//     packet must be sent by a device that is still on, inside the target's
//     broadcast domain. This module therefore implements a *sender* (WOL proxy),
//     and the plugin exposes it so another always-on machine can wake this one.
//
// Platform notes that the UI must surface honestly:
//  - Windows: shutdown.exe with /t <seconds> gives a real cancel window; /p has
//    no warning and cannot be cancelled, so it is not used.
//  - Windows "fast startup" turns a normal shutdown into a hybrid one in which
//    the NIC is explicitly not armed; Wake-on-LAN then does not work. The user
//    must disable fast startup (documented in docs/remote-power.md).
import { createSocket } from 'node:dgram'
import { execFile, execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

import { POWER_REFUSAL } from './protocol.mjs'

/** Default grace period before a shutdown takes effect. */
export const DEFAULT_DELAY_SECONDS = 30

/** Delay bounds, so a phone cannot pass 0 (no chance to cancel) or a ridiculous value. */
export const MIN_DELAY_SECONDS = 5
export const MAX_DELAY_SECONDS = 600

/**
 * Build an IPv4 magic packet for a MAC address.
 * @param {string} mac e.g. "AA:BB:CC:DD:EE:FF"
 * @returns {Buffer} 6 x 0xFF followed by the MAC repeated 16 times (102 bytes)
 */
export function magicPacket(mac) {
  const bytes = parseMac(mac)
  if (!bytes) throw new Error(`不是有效的 MAC 地址：${mac}`)
  const packet = Buffer.alloc(6 + 16 * 6)
  packet.fill(0xff, 0, 6)
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) packet[6 + i * 6 + j] = bytes[j]
  }
  return packet
}

/**
 * Parse a MAC address in any common notation.
 * @param {string} mac
 * @returns {number[] | null} six bytes, or null when invalid
 */
export function parseMac(mac) {
  if (typeof mac !== 'string') return null
  const hex = mac.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 12) return null
  const bytes = []
  for (let i = 0; i < 12; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

/** Normalise a MAC address to AA:BB:CC:DD:EE:FF for display and storage. */
export function formatMac(mac) {
  const bytes = parseMac(mac)
  if (!bytes) return null
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

/**
 * Normalise a raw MAC from a platform command into AA:BB:CC:DD:EE:FF.
 * Handles the `AA-BB-CC-DD-EE-FF` and `AABBCCDDEEFF` forms.
 * @param {string} raw
 */
export function formatMacFromPlatform(raw) {
  return formatMac(raw)
}

/**
 * Send a Wake-on-LAN magic packet.
 *
 * `address` is where the UDP datagram is sent: a broadcast address on the same
 * L2 segment reaches the sleeping machine directly, while a unicast address
 * (already-mapped ARP entry, or a router that forwards it) can work across a
 * subnet. Port 9 (discard) and 7 (echo) are both widely accepted; 9 is the
 * default. Sockets are closed even on failure so a phone retry cannot leak fds.
 *
 * @param {object} input
 * @param {string} input.mac
 * @param {string} [input.address]  Default 255.255.255.255
 * @param {number} [input.port]     Default 9
 * @param {boolean} [input.dryRun]  Build the packet and skip the socket (tests)
 * @returns {Promise<{ok: true, packetBytes: number, address: string, port: number, mac: string}>}
 */
export async function sendWakeOnLan(input) {
  const mac = formatMac(input.mac)
  if (!mac) throw new Error(`不是有效的 MAC 地址：${String(input.mac)}`)
  const address = input.address ?? '255.255.255.255'
  const port = input.port ?? 9
  const packet = magicPacket(mac)
  if (input.dryRun) {
    return { ok: true, packetBytes: packet.length, address, port, mac }
  }
  await new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    const done = error => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch { /* already closed */ }
      if (error) reject(error)
      else resolve(undefined)
    }
    socket.once('error', done)
    socket.bind(() => {
      // ON by default, but setting it explicitly keeps the intent visible and
      // makes the failure mode (EPERM under a restrictive sandbox) obvious.
      try {
        socket.setBroadcast(true)
      } catch { /* non-broadcast address needs no permission */ }
      socket.send(packet, 0, packet.length, port, address, error => done(error))
    })
  })
  return { ok: true, packetBytes: packet.length, address, port, mac }
}

/** Collect candidate broadcast addresses for WOL from the machine's own NICs. */
export function localBroadcastAddresses() {
  const out = new Set(['255.255.255.255'])
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' || !entry.netmask) continue
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      out.add(ip.map((part, i) => (part & mask[i]) | (~mask[i] & 255)).join('.'))
    }
  }
  return [...out]
}

/**
 * The platform's shutdown command as argv, so it can be asserted in tests
 * without executing anything.
 * @param {'shutdown'|'restart'} action
 * @param {number} delaySeconds
 * @param {string} [comment]
 * @param {NodeJS.Platform} [platform]
 * @returns {{command: string, args: string[]}}
 */
export function shutdownCommand(action, delaySeconds, comment, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'shutdown.exe',
      args: [
        action === 'restart' ? '/r' : '/s',
        '/t', String(delaySeconds),
        '/d', 'p:0:0',
        ...(comment ? ['/c', comment] : []),
      ],
    }
  }
  if (platform === 'darwin') {
    return { command: 'sudo', args: ['shutdown', action === 'restart' ? '-r' : '-h', `+${Math.ceil(delaySeconds / 60)}`] }
  }
  return { command: 'shutdown', args: [action === 'restart' ? '-r' : '-h', `+${Math.ceil(delaySeconds / 60)}`] }
}

/**
 * Cancellable power scheduler. Holds at most one pending action, because two
 * overlapping shutdowns is a decision the user cannot meaningfully make.
 */
export class PowerManager {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {(command: string, args: string[]) => void} [options.run] Override for tests.
   * @param {NodeJS.Platform} [options.platform]
   * @param {(message: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now())
    this.platform = options.platform ?? process.platform
    this.log = options.log ?? (() => {})
    this.run = options.run ?? ((command, args) => {
      execFile(command, args, { windowsHide: true }, error => {
        if (error) this.log(`power: ${command} failed: ${error.message}`)
      })
    })
    /** @type {{action: 'shutdown'|'restart', executeAt: number, token: string, delaySeconds: number, timer: NodeJS.Timeout} | null} */
    this.pending = null
    /** Refuse actions on platforms we have not verified. */
    this.supported = this.platform === 'win32' || this.platform === 'darwin' || this.platform === 'linux'
  }

  /**
   * Request a power action.
   * @param {object} input
   * @param {'shutdown'|'restart'|'cancel'} input.action
   * @param {number} [input.delaySeconds]
   * @param {string} [input.reason]
   * @returns {{accepted: boolean, delaySeconds?: number, cancelToken?: string, reason?: string, message?: string, executeAt?: string}}
   */
  request(input) {
    if (!this.supported) {
      return {
        accepted: false,
        reason: POWER_REFUSAL.UNSUPPORTED_PLATFORM,
        message: `暂不支持在 ${this.platform} 上远程关机`,
      }
    }
    if (input.action === 'cancel') {
      return this.cancel(input.reason)
    }
    if (input.action !== 'shutdown' && input.action !== 'restart') {
      return { accepted: false, reason: POWER_REFUSAL.FAILED, message: `未知操作：${String(input.action)}` }
    }
    if (this.pending) {
      return {
        accepted: false,
        reason: POWER_REFUSAL.ALREADY_PENDING,
        message: `已有一个${this.pending.action === 'restart' ? '重启' : '关机'}计划在 ${new Date(this.pending.executeAt).toLocaleTimeString()} 执行，请先取消`,
      }
    }

    const requested = Number.isFinite(input.delaySeconds) ? Number(input.delaySeconds) : DEFAULT_DELAY_SECONDS
    const delaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(requested)))
    const comment = input.reason ? String(input.reason).slice(0, 200) : '通过 Open Whale 远程执行'
    const { command, args } = shutdownCommand(input.action, delaySeconds, comment, this.platform)

    const token = `pw_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    let timer
    const record = {
      action: input.action,
      delaySeconds,
      executeAt: this.now() + delaySeconds * 1000,
      token,
      timer: /** @type {any} */ (null),
    }
    timer = setTimeout(() => {
      this.log(`power: executing ${input.action} now`)
      this.pending = null
      try {
        this.run(command, args)
      } catch (error) {
        this.log(`power: failed to run ${command}: ${/** @type {Error} */ (error).message}`)
      }
    }, delaySeconds * 1000)
    timer.unref?.()
    record.timer = timer
    this.pending = record

    return {
      accepted: true,
      delaySeconds,
      cancelToken: token,
      executeAt: new Date(record.executeAt).toISOString(),
    }
  }

  /**
   * Cancel the pending action. `token` is optional: a phone that reconnected and
   * lost the token can still cancel, because cancelling is the safe direction
   * (refusing it would shut the machine down).
   * @param {string} [reason]
   * @param {string} [token]
   */
  cancel(reason, token) {
    if (!this.pending) {
      return { accepted: false, reason: POWER_REFUSAL.FAILED, message: '当前没有待执行的关机/重启' }
    }
    if (token && token !== this.pending.token) {
      return { accepted: false, reason: POWER_REFUSAL.FAILED, message: '取消失败：令牌不匹配' }
    }
    clearTimeout(this.pending.timer)
    const cancelled = this.pending.action
    this.pending = null
    // Ask the OS to abort too: our own timer only covers the window we own, and
    // a restart may already have been handed to the OS by a previous run.
    if (this.platform === 'win32') {
      try {
        execFileSync('shutdown.exe', ['/a'], { windowsHide: true, stdio: 'ignore' })
      } catch { /* nothing scheduled at the OS level, or already too late */ }
    } else if (this.platform === 'linux' || this.platform === 'darwin') {
      try {
        execFileSync('shutdown', ['-c'], { stdio: 'ignore' })
      } catch { /* ignore */ }
    }
    this.log(`power: cancelled pending ${cancelled}`)
    return { accepted: true, message: `已取消${cancelled === 'restart' ? '重启' : '关机'}${reason ? `（${reason}）` : ''}` }
  }

  /** Current pending state, for the phone to show a countdown. */
  state() {
    if (!this.pending) return { pending: false }
    return {
      pending: true,
      action: this.pending.action,
      executeAt: new Date(this.pending.executeAt).toISOString(),
      remainingSeconds: Math.max(0, Math.round((this.pending.executeAt - this.now()) / 1000)),
    }
  }

  /** Release the timer without running the action (plugin unload). */
  dispose() {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }
}
