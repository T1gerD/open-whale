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

import { CONNECTION_MODES, DEFAULT_PORT, WEB_CLIENT_PATH } from './protocol.mjs'
import { DshBridge } from './dsh-bridge.mjs'
import { Gateway } from './gateway.mjs'
import { PowerManager, sendWakeOnLan } from './power.mjs'
import { StateStore } from './state.mjs'

export const name = 'openwhale'

/**
 * Service keys this plugin REQUIRES.
 *
 * Cordis `inject` is a hard dependency list: the plugin mounts only when every
 * listed service is provided. It is **not** a permission to read — a service read
 * as a plain property without being declared throws
 * (`cannot get property "..." without inject`), and declaring it to silence that
 * error turns an optional service into a mount blocker, which is strictly worse
 * than degrading.
 *
 * So only what the plugin cannot function without is listed:
 *   · `agents` — the bridge creates and drives agent sessions
 *     (`dsh-bridge.mjs` calls `ctx.agents.create()` / `.get()`).
 *
 * Everything else is read through `ctx.get(name)`, which Cordis documents as
 * "read a service from the store without the inject requirement" and which
 * returns `undefined` when the service is not provided. That matches what the rest
 * of this file and the README's fault-tolerance table already assume:
 *   · `webServer`         → falls back to this plugin's own listener
 *   · `sessionQuery`      → session list/select falls back to the live agent list
 *   · `agentDefaultModel` → `resolveModelSelection` falls back to profile config,
 *                           then to the live agent list
 *
 * Historical note: this list used to carry six services (`agents`, `commands`,
 * `webServer`, `systemPrompt`, `tools`, `agentDefaultModel`). `systemPrompt` and
 * `tools` were never read anywhere in the package, and the other three were
 * already handled defensively — so all five were pure mount risk. v2.3.0 also
 * removed the `/openwhale` command, so `commands` is no longer a candidate at all.
 */
export const inject = ['agents']

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
  // 实验性：双端审批。开启时手机作答会通过 AbortController 信号代理把桌面原生弹窗
  // 一起收掉；关闭时手机卡片、先答先算照旧，只是桌面弹窗需要用户自己点掉。
  // 非法值（非布尔）按默认 true 处理，见 resolveDualApproval。
  experimentalDualApproval: true,
  connectionMode: 'auto',
  tunnelMode: 'off',
  cloudflaredPath: '',
  // 转发窗口（毫秒）。默认值与协议常量一致，但做成配置项：用户的网络/作息差别
  // 很大（有人 10 秒就点、有人要开手机解锁），写死一个值总有一边不合适。
  questionTimeoutMs: 90000,
  questionTimedTimeoutMs: 30000,
  questionLateWindowMs: 300000,
})



/**
 * 把配置里的提问窗口归一化（只校验非负）。
 * 纯函数，便于在没有 DSH 上下文的测试里钉住行为。
 * @param {{questionTimeoutMs?: unknown, questionTimedTimeoutMs?: unknown, questionLateWindowMs?: unknown}} [config]
 * @returns {{questionTimeoutMs: number, questionTimedTimeoutMs: number, questionLateWindowMs: number}}
 */
export function resolveForwardTimeouts(config = {}) {
  const finiteOr = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback
  }
  return {
    questionTimeoutMs: finiteOr(config.questionTimeoutMs, DEFAULT_CONFIG.questionTimeoutMs),
    questionTimedTimeoutMs: finiteOr(config.questionTimedTimeoutMs, DEFAULT_CONFIG.questionTimedTimeoutMs),
    questionLateWindowMs: finiteOr(config.questionLateWindowMs, DEFAULT_CONFIG.questionLateWindowMs),
  }
}

/**
 * 归一化实验性双端审批开关：只有**显式 `false`** 才关闭，其余（缺省/非法值）都是开。
 *
 * 「双端审批」指手机作答后用 `AbortController` 信号代理把桌面原生弹窗一起收掉，
 * 依赖 DSH 内部实现（`req.signal` 可写、abort 能传回 `ui-approval`），所以必须有
 * 一个开关能一键退回「桌面自己点掉」。语义见 docs/v3.0.0/APPROVAL.md。
 * @param {any} [config]
 * @returns {boolean}
 */
export function resolveDualApproval(config = {}) {
  return config?.experimentalDualApproval !== false
}

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
      experimentalDualApproval: z.boolean().default(true).description('实验性：双端审批（手机作答后用 signal 代理关闭桌面原生弹窗）。关闭后手机卡片仍可作答、仍先答先算，但桌面弹窗要自己点掉'),
      connectionMode: z.string().default('auto').description('连接方式偏好：auto（Tailscale→局域网→隧道）| lan | tailscale | tunnel'),
      tunnelMode: z.string().default('off').description('公网隧道：off | quick（cloudflared 快速隧道，适合临时使用）'),
      cloudflaredPath: z.string().default('').description('cloudflared 可执行文件路径（留空则自动探测）'),
      // 转发窗口（毫秒）：手机不在线时这些值不影响桌面（直接走原有审批 UI）。
      questionTimeoutMs: z.number().default(DEFAULT_CONFIG.questionTimeoutMs).description('阻塞式提问（ask_user_question）等待手机的毫秒数'),
      questionTimedTimeoutMs: z.number().default(DEFAULT_CONFIG.questionTimedTimeoutMs).description('带超时提问（askTimed / 计划审阅）等待手机的毫秒数，应短于调用方超时'),
      questionLateWindowMs: z.number().default(DEFAULT_CONFIG.questionLateWindowMs).description('带超时提问超时后仍可通过手机补答的窗口（毫秒）'),
    })
  } catch {
    // MUST be `undefined`, never `null`.
    //
    // DSH's settings form asks each plugin for its schema like this
    // (`@deepseek-ai/dsh-settings`):
    //     const schema = entry.fiber?.runtime?.Config;
    //     return schema !== void 0 && "toJSON" in schema ? schema : void 0;
    // The guard excludes only `undefined`, so a `null` Config reaches
    // `"toJSON" in null`, which throws a TypeError. That error escapes
    // `settings/describe` as `{ ok: false }`, and the desktop main process turns
    // a non-ok envelope into `desktop welcome: Web RPC failed` — a blank window
    // and an application that never finishes starting.
    //
    // This is not hypothetical. `@deepseek-ai/schemastery` is provided by the
    // harness, and for a `link:`-installed plugin Node resolves this dynamic
    // import against the symlink TARGET (the checkout), where schemastery does
    // not exist. So this catch is reached on every start of a linked install.
    return undefined
  }
}

/** The resolved schema, or `null` when schemastery was unavailable. */
export const Config = await buildConfigSchema()

/**
 * 同一进程内 DSH 可能重复挂载插件（每次 web boot / 设置保存都会重新 apply）。
 * 旧实例如果没有被 dispose，会继续占着 8787，新实例绑定失败；手机上连到的却是
 * 已经 dispose 的旧上下文（表现为 `cannot get required service "agents" in
 * inactive context`，会话列表/历史全失败）。这里用模块级变量兜底：新实例启动前
 * 先把上一个实例关干净。
 * @type {null | (() => Promise<void>)}
 */
let currentCleanup = null

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
  for (const key of ['host', 'voice', 'assistantName', 'enabled', 'lanEnabled', 'allowRemoteShutdown', 'shutdownDelaySeconds', 'autoApproveTools', 'experimentalDualApproval', 'connectionMode', 'tunnelMode', 'questionTimeoutMs', 'questionTimedTimeoutMs', 'questionLateWindowMs']) {
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
    experimentalDualApproval: resolveDualApproval(config),
    connectionMode: config.connectionMode ?? 'auto',
    tunnelMode: config.tunnelMode ?? 'off',
    cloudflaredPath: config.cloudflaredPath ?? '',
    ...resolveForwardTimeouts(config),
  }

  if (!settings.enabled) {
    const text = 'Open Whale: 已禁用（enabled=false）'
    if (ctx.logger?.info) ctx.logger.info(text)
    return
  }

  // 先收掉同一进程里的上一个实例（端口、监听器、agent 转发者都在它身上）。
  if (currentCleanup) {
    const previous = currentCleanup
    currentCleanup = null
    try {
      await previous()
    } catch (error) {
      if (ctx.logger?.warn) ctx.logger.warn(`Open Whale: 关闭上一个实例失败：${/** @type {Error} */ (error).message}`)
    }
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
    const webServer = ctx.get('webServer')
    const address = webServer?.port ? `http://127.0.0.1:${webServer.port}` : null
    const lan = lanAddresses(settings.port || webServer?.port)
    return [...new Set([...lan, ...(address ? [address] : [])])]
  }

  // 连接方式偏好：首次启动用配置值播种，之后由配对页/手机端修改并持久化。
  if (!CONNECTION_MODES.includes(/** @type {any} */ (store.getPreference('connectionMode')))) {
    store.setPreference('connectionMode', CONNECTION_MODES.includes(/** @type {any} */ (settings.connectionMode))
      ? settings.connectionMode
      : 'auto')
  }

  /** @type {Gateway | null} 网关在桥之后构造，回调里按需取用。 */
  let gateway = null

  const bridge = new DshBridge({
    ctx,
    config: {
      voice: settings.voice,
      assistantName: settings.assistantName,
      cwd: settings.cwd,
      autoApproveTools: settings.autoApproveTools,
      experimentalDualApproval: settings.experimentalDualApproval,
      agentOptions: {},
    },
    emit: event => gateway?.pushEvent(event),
    // 审批转发前先问网关「这个会话有没有在线手机」；没有就交回桌面。
    devicesInSession: sessionId => (gateway ? gateway.approvalDevicesFor(sessionId) : []),
    questionTimeoutMs: settings.questionTimeoutMs,
    questionTimedTimeoutMs: settings.questionTimedTimeoutMs,
    questionLateWindowMs: settings.questionLateWindowMs,
    log,
    defaultCwd: () => process.cwd(),
    modelSelection: () => resolveModelSelection(ctx, log, settings.agentOptions ?? {}),
  })

  const power = new PowerManager({
    platform: process.platform,
    log,
  })

  gateway = new Gateway({
    store,
    bridge: {
      send: input => bridge.send(input),
      cancel: (callId, deviceId) => bridge.cancel(callId, deviceId),
      fileFor: fileId => bridge.fileFor(fileId),
      // v2.3.0：手机的会话列表 / 选择 / 新建、会话历史与审批作答。
      listSessions: () => bridge.listSessions(),
      selectSession: sessionId => bridge.selectSession(sessionId),
      createSession: () => bridge.createSession(),
      historyMessages: sessionId => bridge.historyMessages(sessionId),
      answerApproval: input => bridge.answerApproval(input),
      // 刷新/重连后把还没答的审批再推一次。
      pendingApprovals: sessionId => bridge.pendingApprovals(sessionId),
      // 重连时补发最近结束的审批，清掉已经失效的卡片。
      // 结构化提问（ask_user_question / 计划审阅）的作答，与审批是两条 seam。
      answerQuestion: input => bridge.answerQuestion(input),
      releaseSession: sessionId => bridge.releaseSession(sessionId),
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
    // 附件落盘与电脑→手机发文件的根目录，必须是该会话的工作目录，
    // 否则 DSH 的文件沙箱读不到（「手机发的图片模型看不到」的根因）。
    cwd: () => bridge.workingDirectory(),
    // uploads go to <cwd>/.openwhale/uploads; the old dataDir/uploads is kept
    // only as a migration no-op for previously stored files.
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
    // 手动解除绑定：手机没连上时它的 device/forget 发不出去，电脑端会一直占着绑定，
    // 配对页又不再出二维码 —— 这个入口用来打破那个死锁。
    unbind: '/openwhale/unbind',
    deviceRename: '/openwhale/device-rename',
    download: '/openwhale/download',
    // v2.2.0：连接方式偏好 + 电脑→手机发文件（写操作仅本机）。
    connectionMode: '/openwhale/connection-mode',
    sendFile: '/openwhale/send-file',
  }
  let usingWebServer = false
  const webServer = ctx.get('webServer')
  if (webServer?.register) {
    for (const path of Object.values(routes)) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => gateway.handleRequest(req, res),
      }), `openwhale: route ${path}`)
    }
    // The built-in web/PWA client is a whole directory, so it needs a prefix
    // route (exact routes cannot cover `/openwhale/app/lib/*`).
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: WEB_CLIENT_PATH,
      handler: (req, res) => gateway.handleRequest(req, res),
    }), `openwhale: route ${WEB_CLIENT_PATH}/*`)
    ctx.effect(() => webServer.registerUpgrade({
      path: '/openwhale/ws',
      handler: (req, socket, head) => gateway.attachUpgradeHandler(req, socket, head),
    }), 'openwhale: websocket route')
    usingWebServer = true
    gateway.port = webServer.port ?? settings.port
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

  /**
   * 幂等清理：先关网关（释放 8787 与所有连接），再拆桥和隧道。
   * 任何一步失败都不能留下监听器——旧实例如若继续占着端口，下一个实例会连不上。
   */
  let disposed = false
  const cleanup = async () => {
    if (disposed) return
    disposed = true
    log('正在关闭…')
    try {
      await gateway.close()
    } catch (error) {
      log(`关闭网关失败：${/** @type {Error} */ (error).message}`)
    }
    try {
      await bridge.dispose()
    } catch (error) {
      log(`关闭桥失败：${/** @type {Error} */ (error).message}`)
    }
    try {
      if (tunnel) await tunnel.stop?.()
    } catch (error) {
      log(`关闭隧道失败：${/** @type {Error} */ (error).message}`)
    }
    if (currentCleanup === cleanup) currentCleanup = null
  }
  currentCleanup = cleanup
  // ctx.effect 是 cordis 的官方清理方式；ctx.on('dispose') 作为兜底（某些宿主不发 effect 清理）。
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { void cleanup() }, 'openwhale: dispose')
  ctx.on('dispose', () => { void cleanup() })

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
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
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
