// Open Whale — DSH plugin entry.
//
// Composition, in one place:
//   StateStore  → computer identity, pairing window, bound phones (durable)
//   DshBridge   → one DSH conversation per phone + assistant voice + files
//   Gateway     → HTTP/WebSocket surface the phone talks to
//   TunnelManager (optional) → public URL when the phone is not on the LAN
//   PowerManager / WakeProxy  → remote shutdown, restart, cancel, and wake
//
// The plugin is deliberately forgiving about its optional halves: if the DSH web
// server is unavailable it listens on its own port; if the tunnel binary is
// missing it says so instead of failing to load. A binding QR that works on the
// LAN must never depend on either.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PORT } from './protocol.mjs'
import { DshBridge } from './dsh-bridge.mjs'
import { Gateway } from './gateway.mjs'
import { PowerManager, sendWakeOnLan } from './power.mjs'
import { StateStore } from './state.mjs'
import { pairingAvailability, renderPairingQr } from './pairer.mjs'

export const name = 'openwhale'

/**
 * Service keys this plugin needs.
 *
 * `agentDefaultModel` is listed because Cordis refuses property access to an
 * undeclared service ("cannot get property ... without inject"). Reading it gives
 * the authoritative provider/model for a new conversation; the plugin still has
 * three fallbacks when it is absent, so a profile without this service degrades
 * instead of failing.
 */
export const inject = ['agents', 'commands', 'webServer', 'systemPrompt', 'tools', 'agentDefaultModel']

/**
 * Default configuration, used as the fallback when the schema below cannot be
 * built. Every value is mirrored in `apply`, so a missing schema never changes
 * runtime behaviour — it only removes the settings-page fields.
 */
export const DEFAULT_CONFIG = Object.freeze({
  host: 'Open Whale 电脑',
  enabled: true,
  lanEnabled: true,
  port: DEFAULT_PORT,
  heartbeatMs: 25000,
  voice: 'personal-assistant',
  assistantName: '助理',
  cwd: '',
  allowRemoteShutdown: true,
  shutdownDelaySeconds: 30,
  autoApproveTools: false,
  tunnelMode: 'off',
  cloudflaredPath: '',
})

/**
 * Build the config schema from the harness's schemastery.
 *
 * Loaded dynamically on purpose. `@deepseek-ai/schemastery` is provided by the
 * harness, not by this package, so its availability depends on how the harness
 * resolves a plugin's imports; a failure here must degrade to "no settings
 * fields" instead of "the whole plugin refuses to load".
 * @returns {Promise<any | null>}
 */
async function buildConfigSchema() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery')
    return z.object({
      host: z.string().default(DEFAULT_CONFIG.host).description('电脑在手机上显示的名称（可随时修改）'),
      enabled: z.boolean().default(true).description('启用 Open Whale 远程连接'),
      lanEnabled: z.boolean().default(true).description('监听局域网端口，供同一 Wi-Fi 下的手机连接'),
      port: z.number().default(DEFAULT_PORT).description('局域网监听端口（0 表示由系统分配）'),
      heartbeatMs: z.number().default(25000).description('手机心跳间隔（毫秒）'),
      voice: z.string().default('personal-assistant').description('回复语气：personal-assistant（个人助理口语化）或 off（保持默认）'),
      assistantName: z.string().default('助理').description('助理的名字，用于回复语气'),
      cwd: z.string().default('').description('手机对话的工作目录（留空则使用当前会话工作区）'),
      allowRemoteShutdown: z.boolean().default(true).description('允许手机远程关机/重启（取消始终可用）'),
      shutdownDelaySeconds: z.number().default(30).description('远程关机的宽限秒数，期间可取消'),
      autoApproveTools: z.boolean().default(false).description('手机会话是否自动批准所有工具调用（默认关闭，走 DSH 原有审批策略）'),
      tunnelMode: z.string().default('off').description('公网隧道：off | quick（cloudflared 快速隧道，适合临时使用）'),
      cloudflaredPath: z.string().default('').description('cloudflared 可执行文件路径（留空则自动探测）'),
    })
  } catch {
    return null
  }
}

/** The resolved schema, or `null` when schemastery was unavailable. */
export const Config = await buildConfigSchema()

/**
 * Patch the injected config with user-editable volatile fields.
 *
 * Fields carrying `.volatile()` become live-editable from the DSH settings page
 * (and persist into the active profile's Cordis patch); the rest require a
 * restart. Returns an empty object when the schema is unavailable.
 * @param {any} schema
 */
function volatilize(schema) {
  const dict = schema?.dict ?? {}
  const patches = {}
  for (const key of ['host', 'voice', 'assistantName', 'enabled', 'lanEnabled', 'allowRemoteShutdown', 'shutdownDelaySeconds', 'autoApproveTools', 'tunnelMode']) {
    if (dict[key]?.volatile) patches[key] = dict[key].volatile()
  }
  return patches
}

/**
 * @param {any} ctx
 * @param {any} config
 */
export async function apply(ctx, config) {
  const settings = {
    host: config.host ?? 'Open Whale 电脑',
    enabled: config.enabled !== false,
    lanEnabled: config.lanEnabled !== false,
    port: config.port ?? DEFAULT_PORT,
    heartbeatMs: config.heartbeatMs ?? 25000,
    voice: config.voice ?? 'personal-assistant',
    assistantName: config.assistantName ?? '助理',
    cwd: config.cwd ?? '',
    allowRemoteShutdown: config.allowRemoteShutdown !== false,
    shutdownDelaySeconds: config.shutdownDelaySeconds ?? 30,
    autoApproveTools: config.autoApproveTools === true,
    tunnelMode: config.tunnelMode ?? 'off',
    cloudflaredPath: config.cloudflaredPath ?? '',
  }

  if (!settings.enabled) {
    const text = 'Open Whale: 已禁用（enabled=false）'
    if (ctx.logger?.info) ctx.logger.info(text)
    return
  }

  const dataDir = await resolveDataDir(ctx)
  await mkdir(join(dataDir, 'uploads'), { recursive: true })

  const store = new StateStore({
    dir: dataDir,
    hostName: settings.host,
    port: settings.port,
  })
  if (store.computerName !== settings.host) store.setComputerName(settings.host)

  // Plugin logging goes somewhere the user can actually find.
  //
  // `ctx.logger` is not guaranteed to have a sink in every profile, and a silent
  // plugin is impossible to debug when a phone cannot connect, so every line is
  // also appended to `<dataDir>/openwhale.log`. That file is the first thing to
  // read when pairing or chatting misbehaves.
  const logFile = join(dataDir, 'openwhale.log')
  const log = message => {
    const line = `${new Date().toISOString()} ${message}`
    try {
      appendFileSync(logFile, `${line}\n`)
    } catch { /* logging must never break the plugin */ }
    if (ctx.logger?.info) ctx.logger.info(`Open Whale: ${message}`)
  }

  /** @type {string[]} */
  let tunnelUrls = []
  /** @type {any} */
  let tunnel = null
  const lanUrls = () => {
    if (!settings.lanEnabled) return []
    const address = ctx.webServer?.port ? `http://127.0.0.1:${ctx.webServer.port}` : null
    const lan = lanAddresses(settings.port || ctx.webServer?.port)
    return [...new Set([...lan, ...(address ? [address] : [])])]
  }

  const bridge = new DshBridge({
    ctx,
    config: {
      voice: settings.voice,
      assistantName: settings.assistantName,
      cwd: settings.cwd,
      autoApproveTools: settings.autoApproveTools,
      agentOptions: {},
      sessionIdFor: deviceId => store.sessionIdFor(deviceId),
    },
    emit: event => gateway.pushEvent(event),
    log,
    defaultCwd: () => process.cwd(),
    modelSelection: () => resolveModelSelection(ctx, log, settings.agentOptions ?? {}),
  })

  const power = new PowerManager({
    platform: process.platform,
    log,
  })

  const gateway = new Gateway({
    store,
    bridge: {
      send: input => bridge.send(input),
      cancel: callId => bridge.cancel(callId),
      fileFor: fileId => bridge.fileFor(fileId),
      renameAssistant: async ({ label }) => {
        store.setComputerName(label)
      },
      power: async input => {
        const result = power.request({
          action: input.action,
          delaySeconds: input.delaySeconds ?? settings.shutdownDelaySeconds,
        })
        return result
      },
      wake: async input => wakeTarget(store, input, log),
    },
    lanUrls,
    tunnelUrls: () => tunnelUrls,
    log,
    uploadDir: join(dataDir, 'uploads'),
  })
  gateway.heartbeatMs = settings.heartbeatMs

  // Prefer riding the DSH web server (one port, one tunnel, same origin as the
  // GUI). Fall back to our own listener when the web server is unavailable.
  const routes = {
    health: '/openwhale/health',
    info: '/openwhale/info',
    qrSvg: '/openwhale/qr.svg',
    qrPng: '/openwhale/qr.png',
    pairing: '/openwhale/pairing.json',
    page: '/openwhale',
    download: '/openwhale/download',
  }
  let usingWebServer = false
  if (ctx.webServer?.register) {
    for (const path of Object.values(routes)) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => gateway.handleRequest(req, res),
      }), `openwhale: route ${path}`)
    }
    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: '/openwhale/ws',
      handler: (req, socket, head) => gateway.attachUpgradeHandler(req, socket, head),
    }), 'openwhale: websocket route')
    usingWebServer = true
    gateway.port = ctx.webServer.port ?? settings.port
    log(`HTTP 路由已挂载到 DSH Web 服务器（端口 ${gateway.port}）`)
  }

  if (!usingWebServer && settings.lanEnabled) {
    await gateway.listen(settings.port, '0.0.0.0')
    log(`已监听 0.0.0.0:${gateway.port}`)
  } else if (usingWebServer && settings.lanEnabled) {
    // The DSH web server usually binds loopback only; a phone on the same Wi-Fi
    // needs a socket on the LAN interface, so open a second listener for it.
    try {
      await gateway.listenSecondary(settings.port || DEFAULT_PORT, '0.0.0.0')
      log(`已额外监听 0.0.0.0:${gateway.secondaryPort}（局域网）`)
    } catch (error) {
      log(`局域网监听失败（不影响公网隧道）：${/** @type {Error} */ (error).message}`)
    }
  }

  bridge.start()

  // Optional public tunnel.
  if (settings.tunnelMode && settings.tunnelMode !== 'off') {
    tunnel = await startTunnel({ ctx, settings, gateway, log, onUrl: url => { tunnelUrls = url ? [url] : [] } })
  }

  // The `/openwhale` command shows the binding QR inside the GUI/CLI.
  if (ctx.commands?.register) {
    ctx.effect(() => ctx.commands.register({
      name: 'openwhale',
      description: '显示 Open Whale 绑定二维码 / 查看已绑定手机',
      handler: async invocation => {
        const availability = pairingAvailability(store)
        if (!availability.available) {
          const labels = store.devices.map(d => d.label ?? d.deviceName).join('、')
          return { kind: 'success', text: `Open Whale 已绑定手机：${labels}\n如需重新绑定，请先在手机端「解除绑定」。` }
        }
        const endpoints = [...tunnelUrls, ...lanUrls()]
        if (endpoints.length === 0) {
          return { kind: 'error', text: 'Open Whale：还没有可用地址。请启用局域网监听，或把 tunnelMode 设为 quick。' }
        }
        const payload = {
          v: 1,
          p: 'openwhale',
          host: store.computerName,
          id: store.computerId,
          fp: store.fingerprint,
          pk: store.publicKeySpkiBase64Url,
          secret: store.activePairing?.secret ?? store.issuePairingSecret().secret,
          expires: store.activePairing?.expires ?? new Date(Date.now() + 600_000).toISOString(),
          endpoints,
          port: settings.port,
          lan: lanUrls()[0],
          name: store.computerName,
          version: '1.0.0',
        }
        const qr = await renderPairingQr(payload)
        return {
          kind: 'success',
          text: [
            '用手机上的 Open Whale 应用扫描下面的二维码完成绑定：',
            '',
            qr.terminal,
            '',
            `电脑名称：${store.computerName}`,
            `公钥指纹：${store.fingerprint.slice(0, 32).toUpperCase().match(/.{1,4}/g)?.join(' ') ?? ''}`,
            `可用地址：${endpoints.join('、')}`,
            `二维码有效期至：${new Date(payload.expires).toLocaleString('zh-CN')}`,
            '',
            '二维码含一次性绑定密钥，请勿截图外发；绑定成功后立即失效。',
            `也可以在浏览器打开：${endpoints[0]}/openwhale`,
          ].join('\n'),
        }
      },
    }), 'openwhale: command')
  }

  ctx.on('dispose', async () => {
    log('正在关闭…')
    await bridge.dispose()
    if (tunnel) await tunnel.stop?.().catch(() => {})
    await gateway.close()
  })

  log(`就绪（电脑 ID ${store.computerId}，已绑定：${store.isPaired ? '是' : '否'}）`)
}

/**
 * Which provider/model a phone conversation should use.
 *
 * This is not a cosmetic detail. The harness registers a prompt variable
 * `model` (`dsh-agent-loop`: `ctx.systemPrompt.variable('model', ctx => ctx.agent?.options.model)`)
 * and its persona section references `{{model}}` unconditionally. A new agent
 * created without a model therefore fails during prompt assembly with
 * "prompt variable \"{{model}}\" has no value" — before any model call. The phone
 * would see the same internal error on every message.
 *
 * Resolution order, most authoritative first:
 *  1. the harness's `agentDefaultModel` service (what the settings UI edits);
 *  2. the profile's own `agent-default-model` config row, read from disk — the
 *     user configured it explicitly, and the service may be missing from this
 *     profile's composition;
 *  3. a live session's header, so a phone conversation still runs on whatever the
 *     user is currently using (this is only a fallback: an active session's model
 *     can be a temporary switch);
 *  4. the plugin's own `agentOptions` config.
 *
 * @param {any} ctx
 * @param {(message: string) => void} log
 * @param {Record<string, unknown>} [configured] The plugin's own agentOptions.
 * @param {() => ({provider?: string, model?: string, reasoningEffort?: string} | undefined)} [readProfile]
 *        Overridable so tests never depend on the machine's real DSH_HOME.
 * @returns {{provider?: string, model?: string, reasoningEffort?: string} | undefined}
 */
export function resolveModelSelection(ctx, log, configured = {}, readProfile = readProfileDefaultModel) {
  const fromService = (() => {
    try {
      const selection = ctx.agentDefaultModel?.currentSelection?.()
      return selection?.provider && selection?.model ? selection : undefined
    } catch (error) {
      log(`无法读取默认模型服务：${/** @type {Error} */ (error).message}`)
      return undefined
    }
  })()
  if (fromService) return normalizeSelection(fromService)

  const fromProfile = readProfile()
  if (fromProfile?.provider && fromProfile?.model) {
    log(`默认模型服务不可用，改用 profile 中的 agent-default-model：${fromProfile.provider}/${fromProfile.model}`)
    return normalizeSelection(fromProfile)
  }

  try {
    for (const agent of ctx.agents?.list?.() ?? []) {
      const header = agent?.session?.header ?? {}
      const options = agent?.options ?? {}
      const provider = options.provider ?? header.provider ?? header.model?.provider
      const model = options.model ?? header.model?.id ?? header.model?.model
        ?? (typeof header.model === 'string' ? header.model : undefined)
      if (provider && model) return normalizeSelection({ provider, model })
    }
  } catch (error) {
    log(`无法从现有会话推断模型：${/** @type {Error} */ (error).message}`)
  }

  if (configured.provider && configured.model) return normalizeSelection(configured)

  log('警告：没有可用的默认模型，手机会话将无法回复。请在 DSH 设置里选择默认模型，或在本插件的 agentOptions 中显式指定。')
  return undefined
}

/** @param {{provider?: string, model?: string, reasoningEffort?: unknown}} selection */
function normalizeSelection(selection) {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
  }
}

/** Comment lines are skipped, so the header text in a generated file is harmless. */
const MODEL_ROW_PATTERN = /^[ \t]*-?[ \t]*id:[ \t]*['"]?agent-default-model['"]?[ \t]*$/
const KEY_VALUE_PATTERN = /^[ \t]*(provider|model|reasoningEffort):[ \t]*(?<value>.+?)[ \t]*$/

/**
 * Read the effective default model out of this profile's patch layers.
 *
 * Layered patches overwrite by row id, so the *last* `agent-default-model` row
 * that carries both `provider` and `model` wins. This mirrors how the loader
 * builds the entry, without needing to import the loader.
 *
 * YAML is not parsed in full on purpose: a hand-rolled reader over a handful of
 * deeply indented keys is easier to reason about than a parser dependency in a
 * zero-dependency plugin, and the tests pin the exact shapes it accepts.
 *
 * @param {{dshHome?: string} & {readFileImpl?: (path: string) => string}} [options]
 * @returns {{provider: string, model: string, reasoningEffort?: string} | undefined}
 */
export function readProfileDefaultModel(options = {}) {
  const dshHome = options.dshHome ?? process.env.DSH_HOME
  if (!dshHome) return undefined
  const read = options.readFileImpl ?? (path => readFileSync(path, 'utf8'))
  const profilesDir = join(dshHome, 'profiles')
  let profiles
  try {
    profiles = readdirSync(profilesDir)
  } catch {
    return undefined
  }

  // Layers overwrite by row id, so the last complete row wins.
  let found
  for (const profile of profiles) {
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      let text
      try {
        text = read(join(profilesDir, profile, file))
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index++) {
        if (!MODEL_ROW_PATTERN.test(lines[index])) continue
        const row = {}
        for (let scan = index + 1; scan < lines.length; scan++) {
          const line = lines[scan]
          if (line.trim() === '') continue
          if (MODEL_ROW_PATTERN.test(line)) break
          if (/^[ \t]*-\s/.test(line)) break
          const match = KEY_VALUE_PATTERN.exec(line)
          if (match?.groups) {
            const key = line.trim().split(':')[0]
            row[key] = unquote(match.groups.value)
          }
        }
        if (row.provider && row.model) found = row
      }
    }
  }
  if (!found) return undefined
  return {
    provider: found.provider,
    model: found.model,
    ...(found.reasoningEffort ? { reasoningEffort: found.reasoningEffort } : {}),
  }
}

/** Strip inline YAML quotes and comments from a scalar. */
function unquote(value) {
  let out = value
  const comment = out.indexOf(' #')
  if (comment !== -1) out = out.slice(0, comment)
  out = out.trim()
  if ((out.startsWith("'") && out.endsWith("'")) || (out.startsWith('"') && out.endsWith('"'))) {
    out = out.slice(1, -1)
  }
  return out
}

/**
 * Wake a sleeping computer by sending a magic packet from *this* machine, which
 * only works when both are in the same broadcast domain. Targets are configured
 * by the user; the phone may name one of them.
 * @param {StateStore} store
 * @param {{mac?: string, targetId?: string}} input
 * @param {(message: string) => void} log
 */
async function wakeTarget(store, input, log) {
  const targets = /** @type {Array<{id: string, label: string, mac: string, address?: string, port?: number}>} */ (
    store.getPreference('wol.targets', [])
  )
  let target
  if (input.targetId) target = targets.find(entry => entry.id === input.targetId)
  if (!target && input.mac) target = { id: 'ad-hoc', label: '指定设备', mac: input.mac }
  if (!target && targets.length === 1) target = targets[0]
  if (!target) {
    return {
      accepted: false,
      reason: 'disabled-by-policy',
      message: targets.length === 0
        ? '没有配置可唤醒的设备。电脑关机后需要由同网段的一台常开设备代发唤醒包，请在电脑上配置唤醒代理。'
        : '未指定要唤醒哪台设备。',
    }
  }
  try {
    const result = await sendWakeOnLan({ mac: target.mac, address: target.address, port: target.port })
    log(`wol: sent ${result.packetBytes} bytes to ${result.mac} via ${result.address}:${result.port}`)
    return {
      accepted: true,
      message: `已向 ${target.label} 发送唤醒包。若电脑没有开机，请检查 BIOS 的 Wake on Magic Packet、以及是否关闭了 Windows 快速启动。`,
    }
  } catch (error) {
    return {
      accepted: false,
      reason: 'failed',
      message: `发送唤醒包失败：${/** @type {Error} */ (error).message}`,
    }
  }
}

/** Best-effort list of LAN base URLs a phone could reach. */
function lanAddresses(port) {
  if (!port) return []
  const out = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      out.push(`http://${entry.address}:${port}`)
    }
  }
  return out
}

/** Resolve `$DSH_HOME/openwhale` without importing the harness when unavailable. */
async function resolveDataDir(ctx) {
  try {
    const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
    return dshHomePath('openwhale')
  } catch {
    const { homedir } = await import('node:os')
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'openwhale')
  }
}

/**
 * Start the optional public tunnel and keep the advertised URL in sync as
 * cloudflared hands out a new hostname on every restart.
 */
async function startTunnel({ ctx, settings, gateway, log, onUrl }) {
  const { TunnelManager, resolveCloudflared } = await import('./tunnel.mjs')
  // `resolveCloudflared` actually executes `--version`: a present-but-dangling
  // binary (a stale npm shim, for instance) must not be treated as usable.
  const probe = resolveCloudflared({ explicitPath: settings.cloudflaredPath || undefined })
  if (!probe.available) {
    log(`公网隧道不可用：${probe.error ?? '未找到 cloudflared'}。${probe.installHint ?? ''}`)
    return null
  }
  log(`使用 cloudflared ${probe.version}（来源 ${probe.source}）`)

  const port = gateway.port || settings.port
  const manager = new TunnelManager({
    binaryPath: probe.path,
    port,
    origin: `http://127.0.0.1:${port}`,
    log,
  })
  manager.on('url', event => {
    const url = typeof event === 'string' ? event : event?.url
    log(`公网地址：${url}`)
    onUrl(url)
  })
  manager.on('state', event => {
    const state = typeof event === 'string' ? event : event?.state
    if (state === 'failed') onUrl('')
  })
  manager.on('exit', () => onUrl(''))

  const result = await manager.start()
  if (result && result.ok === false) {
    log(`公网隧道启动失败：${result.message ?? result.reason ?? '未知原因'}${result.installHint ? ` ${result.installHint}` : ''}`)
    return manager
  }
  ctx.on('dispose', () => manager.stop().catch(() => {}))
  return manager
}

export { volatilize }
