// Wake-on-LAN proxy for the Open Whale computer plugin.
//
// The single fact this module exists to make honest:
//
//   A computer that is truly shut down is not running any software, so no part of
//   this plugin can wake *this* computer. A magic packet is a Layer-2 broadcast
//   frame; it does not cross subnets, and Tailscale/ZeroTier (Layer 3) officially
//   cannot emit it either. Waking therefore requires an always-on device in the
//   same broadcast domain to send the packet on your behalf.
//
// So this is a *sender*, not a waker. The plugin exposes it so that:
//   · an always-on machine (another PC, a Raspberry Pi, a NAS) can act as the
//     proxy and be told which MACs to wake, and
//   · a phone can reach that proxy from the internet and ask for a wake.
//
// Two consequences shape the API:
//   · `wake()` reports "packet sent", never "computer is up" — there is no
//     reliable way to observe a machine that has not booted yet;
//   · repeated taps are throttled per target, because a wake is a broadcast frame
//     and a burst of them is both useless and disruptive.
//
// The send itself reuses `sendWakeOnLan` from `./power.mjs`; WOL packet
// construction lives in exactly one place in this codebase.
import { formatMac, localBroadcastAddresses, sendWakeOnLan } from './power.mjs'

/** Same-target wake requests closer than this are refused as duplicates. */
export const WAKE_THROTTLE_MS = 3_000

/** Preference key under which the target list is persisted by the caller's store. */
export const WAKE_TARGETS_KEY = 'wol.targets'

/** Bounds that keep a malformed phone payload from being stored. */
export const MAX_LABEL_LENGTH = 64
export const MAX_WAKE_TARGETS = 32

/** Stable refusal reasons, so the phone UI can branch without parsing prose. */
export const WAKE_REASON = /** @type {const} */ ({
  THROTTLED: 'throttled',
  UNKNOWN_TARGET: 'unknown-target',
  INVALID_MAC: 'invalid-mac',
  SEND_FAILED: 'send-failed',
  TOO_MANY_TARGETS: 'too-many-targets',
  NO_TARGET: 'no-target',
})

/**
 * Strict IPv4 check. Deliberately not `net.isIPv4`, which historically accepted
 * forms like `192.168.1.010` that a router would reject, and deliberately not a
 * hostname check: a DNS name here would silently redirect broadcasts.
 * @param {string} value
 */
export function isIPv4(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
}

/**
 * Validate a user- or phone-supplied wake target.
 *
 * Returns a discriminated result instead of throwing so a settings form can show
 * every problem at once, and so a bad phone payload cannot poison the store.
 *
 * @param {object} input
 * @param {string} [input.id]        Optional existing id (preserved when editing).
 * @param {string} input.label       Human name shown in the list.
 * @param {string} input.mac         Any common MAC notation; normalized on output.
 * @param {string} [input.address]   Optional UDP destination (broadcast or unicast).
 * @param {number|string} [input.port] Optional UDP port, 1-65535, default 9.
 * @returns {{ok: boolean, errors: string[], normalized: {id?: string, label: string, mac: string, address?: string, port: number} | null}}
 */
export function validateWakeTarget(input) {
  /** @type {string[]} */
  const errors = []
  const raw = input ?? {}

  const mac = formatMac(raw.mac)
  if (!mac) errors.push('MAC 地址无效：请填写 12 位十六进制，例如 AA:BB:CC:DD:EE:FF')

  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (!label) errors.push('名称不能为空')
  else if (label.length > MAX_LABEL_LENGTH) errors.push(`名称过长（最多 ${MAX_LABEL_LENGTH} 个字符）`)

  let address
  if (raw.address !== undefined && raw.address !== null && String(raw.address).trim() !== '') {
    address = String(raw.address).trim()
    if (!isIPv4(address)) errors.push('地址必须是合法的 IPv4，例如 192.168.1.255（不要填域名）')
  }

  let port = 9
  if (raw.port !== undefined && raw.port !== null && String(raw.port).trim() !== '') {
    const parsed = Number(raw.port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) errors.push('端口必须是 1-65535 之间的整数')
    else port = parsed
  }

  if (errors.length > 0 || !mac) return { ok: false, errors, normalized: null }

  /** @type {{id?: string, label: string, mac: string, address?: string, port: number}} */
  const normalized = { label, mac, port }
  if (raw.id) normalized.id = String(raw.id)
  if (address) normalized.address = address
  return { ok: true, errors: [], normalized }
}

/**
 * Why `wake()` can never return a definitive "it booted" answer.
 * Surfaced in the UI next to the wake button so the user is not left guessing.
 * @param {string} [mac]
 * @returns {{canConfirm: false, hint: string, suggestions: string[]}}
 */
export function describeWakeConfirmation(mac) {
  const target = mac ? formatMac(mac) ?? mac : '目标机'
  return {
    canConfirm: false,
    hint: `魔术包只是“把广播喊出去”，${target} 是否上电无法从这里确认：目标机关机时没有任何进程可以回话，而开机过程也没有可靠的旁路信号。`,
    suggestions: [
      '把“已发送”当作结果，然后等 30-90 秒再尝试连接目标机（局域网 ping 或远程桌面）',
      '在局域网常开代理上用 `ping -t <目标机IP>` 观察它何时出现在网络上',
      '如果一直不醒，按 docs/remote-power.md 的检查清单逐项排查（BIOS、快速启动、有线连接）',
    ],
  }
}

/**
 * Chinese pre-flight checklist for the wake feature, driven by the platform.
 *
 * Every entry traces to a sourced constraint; the `source` field says which kind
 * of claim it is ('official' | 'vendor' | 'community' | 'unverified'), because
 * presenting an unverified firmware behaviour as a guarantee is exactly the kind
 * of dishonest UI this project avoids.
 *
 * @param {{platform?: NodeJS.Platform}} [options]
 * @returns {Array<{id: string, title: string, detail: string, critical: boolean, source: string, verify?: string}>}
 */
export function describeWakePreconditions(options = {}) {
  const platform = options.platform ?? process.platform
  const isWindows = platform === 'win32'

  /** @type {Array<{id: string, title: string, detail: string, critical: boolean, source: string, verify?: string}>} */
  const items = [
    {
      id: 'lan-proxy',
      title: '局域网内需要一台常开设备代发魔术包',
      detail:
        '关机后目标电脑上没有任何进程在运行，它无法唤醒自己；魔术包是二层广播帧，不能跨网段，Tailscale / ZeroTier 这类三层组网官方也明确不能发送它。请准备一台常开、与目标机同网段的有线设备（树莓派 / NAS / 软路由 / 旧笔记本），由它运行本插件或 UpSnap 之类的代理。',
      critical: true,
      source: 'official',
    },
    {
      id: 'same-broadcast-domain',
      title: '目标机与代发设备在同一广播域',
      detail:
        '魔术包发往 UDP 9（或 7）的广播地址，只能在同一个二层网段内被网卡收到。若目标机在另一个 VLAN/子网，需要路由器支持 IP directed broadcast（企业网络特性，家用路由器多数不提供；未验证）。',
      critical: true,
      source: 'official',
    },
    {
      id: 'wired-ethernet',
      title: '目标机使用有线网卡',
      detail:
        'Wi-Fi 网卡通常只在睡眠（S0ix/S3）下支持 WoWLAN，关机后基本无法接收魔术包。请用有线以太网连接（官方文档明确要求有线连接）。',
      critical: true,
      source: 'official',
    },
    {
      id: 'standby-power',
      title: '网卡在关机后仍获得待机供电（PME）',
      detail:
        '这是物理前提：主板 + 电源 + 网卡三方都必须支持并在固件里开启。整机断电（拔插头、关闭排插）时 WOL 一定无效，只能靠带外手段（智能插座 + 主板“来电自启”，该做法未取得权威文档，未验证）。',
      critical: true,
      source: 'official',
    },
    {
      id: 'power-state-s3-or-s4',
      title: '睡眠（S3/S0ix）或显式休眠（S4）下唤醒：官方支持路径',
      detail:
        '微软官方文档：WOL 仅在从 sleep 或用户显式进入 hibernate（S4）时受支持，此时网卡保持 arm 状态，这是最可靠的场景。Modern Standby（S0ix）机型另有官方要求：必须接入交流电源并使用有线以太网。注意本机（S0ix-only、无 S3）不在微软公布的支持机型清单内，需实机验证。',
      critical: false,
      source: 'official',
    },
    {
      id: 'power-state-s5',
      title: '真正关机（S5）下唤醒：取决于主板/网卡固件',
      detail:
        '微软官方承认“部分系统的固件与硬件可能在 Windows 不参与的情况下自行 arm 网卡”，但这是例外而非保证，必须实机验证。',
      critical: false,
      source: 'unverified',
    },
    {
      id: 'no-out-of-band',
      title: '整机断电无法被 WOL 唤醒',
      detail: '停电、拔插头或排插断电后网卡没有待机供电，任何魔术包都无效。',
      critical: false,
      source: 'official',
    },
  ]

  if (isWindows) {
    // The decisive official constraint, kept first among the Windows-specific
    // entries because it silently defeats every other correct setting.
    items.splice(3, 0, {
      id: 'disable-fast-startup',
      title: '关闭 Windows 快速启动（关键）',
      detail:
        'Windows 10/11 默认“关机”是快速启动（hybrid shutdown，S4）：微软官方明确在此状态下 WOL 不受支持，网卡被“显式地不 arm”。关闭方法：控制面板 → 电源选项 → 选择电源按钮的功能 → 取消勾选“启用快速启动（推荐）” → 保存（需管理员）。',
      critical: true,
      source: 'official',
      verify: "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power').HiberbootEnabled  # 期望 0",
    })
    items.push({
      id: 'bios-wake-on-magic-packet',
      title: 'BIOS/UEFI 开启 Wake on Magic Packet / Power On By PCI-E',
      detail:
        '各厂商命名不同（有的叫“Wake on LAN”“PCI-E 唤醒”“Resume by LAN”），需要进入固件设置里开启网卡唤醒并允许 S5 供电。该项目名称在官方文档中没有统一来源，属厂商经验。',
      critical: true,
      source: 'vendor',
    })
    items.push({
      id: 'nic-advanced-property',
      title: '网卡驱动属性里开启“魔术包唤醒”',
      detail:
        '设备管理器 → 网络适配器 → 属性 → 电源管理：勾选“允许此设备唤醒计算机”和“只允许魔术包唤醒计算机”；高级选项卡里若有“Wake on Magic Packet / Shutdown Wake-On-Lan”设为 Enabled。需管理员权限查看（本机沙箱中被拒绝访问：0x80041003）。',
      critical: true,
      source: 'vendor',
      verify: 'Get-NetAdapterPowerManagement | Select-Object Name, WakeOnMagicPacket',
    })
    items.push({
      id: 'verify-armed',
      title: '确认网卡已注册为唤醒源',
      detail: '在目标机上运行该命令，列表中应出现你的有线网卡。若无，说明固件/驱动层还没准备好，远程唤醒一定失败。',
      critical: false,
      source: 'official',
      verify: 'powercfg /devicequery wake_armed',
    })
  }

  return items
}

/**
 * Always-on-device wake proxy.
 *
 * @typedef {object} WakeTarget
 * @property {string} id
 * @property {string} label
 * @property {string} mac       Normalized AA:BB:CC:DD:EE:FF
 * @property {string} [address]
 * @property {number} port
 * @property {number} [attempts]
 * @property {string} [lastAttemptAt]
 * @property {object} [lastResult]
 */

/**
 * @typedef {object} WakeProxyOptions
 * @property {{getPreference: Function, setPreference: Function}} store
 * @property {() => number} [now]
 * @property {number} [throttleMs]
 * @property {(input: object) => Promise<object>} [wake] Test seam for the UDP send.
 * @property {() => string[]} [broadcasts] Test seam for NIC enumeration.
 * @property {() => string} [newId] Test seam for deterministic ids.
 */
export class WakeProxy {
  /** @param {WakeProxyOptions} options */
  constructor(options) {
    if (!options?.store) throw new Error('WakeProxy 需要传入 StateStore（用于持久化可唤醒设备列表）')
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
    this.throttleMs = options.throttleMs ?? WAKE_THROTTLE_MS
    this.send = options.wake ?? sendWakeOnLan
    this.broadcasts = options.broadcasts ?? localBroadcastAddresses
    this.newId = options.newId ?? (() => `wt_${Math.random().toString(36).slice(2, 10)}`)
    /** @type {Map<string, number>} last accepted wake time, keyed by MAC. */
    this.recent = new Map()
    /** @type {any[]} */ this.targets = this.#load()
  }

  #load() {
    const stored = this.store.getPreference(WAKE_TARGETS_KEY, [])
    if (!Array.isArray(stored)) return []
    // Re-validate on load: a hand-edited state file must not be able to smuggle a
    // malformed MAC into the send path.
    const out = []
    for (const entry of stored) {
      const result = validateWakeTarget(entry ?? {})
      if (!result.ok || !result.normalized) continue
      out.push({
        ...result.normalized,
        id: String(entry.id ?? result.normalized.id ?? this.newId()),
      })
    }
    return out
  }

  #save() {
    this.store.setPreference(WAKE_TARGETS_KEY, this.targets)
  }

  /** @returns {WakeTarget[]} a copy, so callers cannot mutate stored state. */
  list() {
    return this.targets.map(target => ({ ...target }))
  }

  /** @returns {WakeTarget | undefined} */
  get(id) {
    const found = this.targets.find(target => target.id === id)
    return found ? { ...found } : undefined
  }

  /**
   * Add a wake target.
   * @param {object} target
   * @returns {{ok: true, target: WakeTarget} | {ok: false, reason: string, errors: string[]}}
   */
  register(target) {
    if (this.targets.length >= MAX_WAKE_TARGETS) {
      return { ok: false, reason: WAKE_REASON.TOO_MANY_TARGETS, errors: [`最多只能登记 ${MAX_WAKE_TARGETS} 台可唤醒设备`] }
    }
    const id = target?.id ? String(target.id) : this.newId()
    const result = validateWakeTarget({ ...target, id })
    if (!result.ok || !result.normalized) return { ok: false, reason: WAKE_REASON.INVALID_MAC, errors: result.errors }
    const record = /** @type {WakeTarget} */ ({ ...result.normalized, id, attempts: 0, lastAttemptAt: null, lastResult: null })
    const existing = this.targets.findIndex(item => item.id === id)
    if (existing >= 0) this.targets[existing] = { ...this.targets[existing], ...record }
    else this.targets.push(record)
    this.#save()
    return { ok: true, target: { ...record } }
  }

  /**
   * Remove a wake target. The throttle entry goes too, so re-adding the same MAC
   * is not immediately blocked by an attempt from a minute ago.
   * @param {string} id
   * @returns {{ok: boolean, removed?: WakeTarget, reason?: string}}
   */
  unregister(id) {
    const index = this.targets.findIndex(target => target.id === id)
    if (index < 0) return { ok: false, reason: WAKE_REASON.UNKNOWN_TARGET }
    const [removed] = this.targets.splice(index, 1)
    this.recent.delete(removed.mac)
    this.#save()
    return { ok: true, removed }
  }

  /**
   * Forget throttle timestamps older than the window. Without this the map grows
   * without bound on a long-running proxy that is woken for many MACs.
   */
  #sweep() {
    const cutoff = this.now() - this.throttleMs
    for (const [mac, at] of this.recent) if (at <= cutoff) this.recent.delete(mac)
  }

  /**
   * Send a magic packet.
   *
   * Accepts either a registered `id` or an ad-hoc `{mac, address}` — the ad-hoc
   * form exists because a phone that just learned a MAC should not have to
   * register it first. A registered target is preferred over an ad-hoc one when
   * both are given, so the stored address/port always wins.
   *
   * @param {string | {id?: string, mac?: string, address?: string, port?: number}} request
   * @returns {Promise<{ok: boolean, reason?: string, message?: string, mac?: string, address?: string, port?: number, packetBytes?: number, targetId?: string, throttleRemainingMs?: number, confirmable: false}>}
   */
  async wake(request) {
    this.#sweep()
    const selector = typeof request === 'string' ? { id: request } : (request ?? {})
    /** @type {WakeTarget | undefined} */
    let target
    if (selector.id) {
      target = this.targets.find(item => item.id === selector.id)
      if (!target) {
        return this.#refuse(WAKE_REASON.UNKNOWN_TARGET, `未登记的可唤醒设备：${selector.id}`, { confirmable: false })
      }
    } else {
      const normalized = validateWakeTarget({ label: selector.label ?? '临时目标', mac: selector.mac, address: selector.address, port: selector.port })
      if (!normalized.ok || !normalized.normalized) {
        return this.#refuse(WAKE_REASON.INVALID_MAC, normalized.errors.join('；'), { confirmable: false })
      }
      target = /** @type {WakeTarget} */ ({ id: null, ...normalized.normalized, attempts: 0 })
    }

    const mac = target.mac
    const last = this.recent.get(mac)
    if (last !== undefined) {
      const elapsed = this.now() - last
      if (elapsed < this.throttleMs) {
        const remaining = this.throttleMs - elapsed
        return this.#refuse(WAKE_REASON.THROTTLED, `刚刚已经发过魔术包，请等待 ${(remaining / 1000).toFixed(1)} 秒再试`, {
          mac,
          throttleRemainingMs: remaining,
          confirmable: false,
        })
      }
    }
    // Record the attempt before sending: two concurrent wake calls for the same
    // MAC must not both pass the check and both transmit.
    this.recent.set(mac, this.now())

    let sent
    try {
      // `this.send`, NOT `this.wake`: the public method is named `wake`, so storing
      // the injected sender under the same name would make this call recurse into
      // itself forever.
      sent = await this.send({ mac, address: target.address, port: target.port, label: target.label })
    } catch (error) {
      const result = { ok: false, packetBytes: 0, mac, address: target.address ?? '255.255.255.255', port: target.port ?? 9, error: /** @type {Error} */ (error).message }
      this.#record(target, result)
      return this.#refuse(WAKE_REASON.SEND_FAILED, `发送魔术包失败：${result.error}`, { mac, confirmable: false })
    }

    this.#record(target, sent)
    return {
      ok: true,
      mac,
      address: sent.address,
      port: sent.port,
      packetBytes: sent.packetBytes,
      targetId: target.id ?? undefined,
      confirmable: false,
    }
  }

  /** @param {WakeTarget} target @param {object} result */
  #record(target, result) {
    if (!target.id) return
    const stored = this.targets.find(item => item.id === target.id)
    if (!stored) return
    stored.attempts = (stored.attempts ?? 0) + 1
    stored.lastAttemptAt = new Date(this.now()).toISOString()
    stored.lastResult = {
      ok: Boolean(result.ok),
      address: result.address,
      port: result.port,
      packetBytes: result.packetBytes,
      ...(result.error ? { error: result.error } : {}),
    }
    this.#save()
  }

  /**
   * @param {string} reason
   * @param {string} message
   * @param {object} extra
   */
  #refuse(reason, message, extra = {}) {
    // `extra` first: the refusal verdict itself must never be overridable by a
    // caller-supplied field.
    return { ...extra, ok: false, confirmable: /** @type {false} */ (false), reason, message }
  }

  /**
   * Explain why "is it awake yet?" cannot be answered from here.
   * Provided as a method (not just a free function) so the UI can call it with the
   * target it already has selected.
   * @param {string} [mac]
   */
  probe(mac) {
    return describeWakeConfirmation(mac)
  }

  /** Candidate broadcast addresses on this proxy's NICs (for the settings UI). */
  localBroadcasts() {
    return this.broadcasts()
  }
}
