// 手动连接 / health 预检的纯逻辑。
//
// 真实网络请求在 `services/manual-connect.ts`（fetch 属于原生能力），这里只做：
//  * health 响应的判定与中文文案（可测）；
//  * 预检成功后把地址合并进已绑定助理的规则（去重、保留 preferredEndpoint）。

/** `/openwhale/health` 的目标字段（gateway.mjs 的只读路由）。 */
export interface HealthBody {
  ok?: unknown
  plugin?: unknown
  computerId?: unknown
  computerName?: unknown
  paired?: unknown
  devices?: unknown
  connections?: unknown
  version?: unknown
}

export interface HealthOutcome {
  ok: boolean
  computerId?: string
  name?: string
  paired?: boolean
  version?: string
  message: string
  hint?: string
}

/**
 * 判定 health 响应。`status` 允许 undefined（fetch 网络层失败时调用方自己给文案），
 * 但传进来就按真实 HTTP 状态码判，不把 404 页面当成功。
 */
export function interpretHealthResponse(status: number | undefined, body: unknown): HealthOutcome {
  if (typeof status === 'number' && status !== 200) {
    return {
      ok: false,
      message: `这个地址返回了 HTTP ${status}`,
      hint: '确认端口没有写错，并且电脑上的 Open Whale 插件正在运行。',
    }
  }
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      message: '这个地址不是 Open Whale 电脑端',
      hint: '请检查地址；电脑上的插件配对页面会显示正确的地址。',
    }
  }
  const health = body as HealthBody
  if (health.plugin !== undefined && health.plugin !== 'dsh-openwhale') {
    return {
      ok: false,
      message: '这个地址上的服务不是 Open Whale 插件',
      hint: '确认端口指向的是电脑上运行的 Open Whale 插件，而不是别的服务。',
    }
  }
  if (health.ok !== true) {
    return {
      ok: false,
      message: '电脑端没有返回健康的响应',
      hint: '可以在电脑上重启 Open Whale 插件后再试。',
    }
  }
  const name = typeof health.computerName === 'string' ? health.computerName : undefined
  const computerId = typeof health.computerId === 'string' ? health.computerId : undefined
  const version = typeof health.version === 'string' ? health.version : undefined
  return {
    ok: true,
    computerId,
    name,
    version,
    paired: health.paired === true,
    message: name ? `已连接到「${name}」` : '地址可用',
  }
}

/** 网络层错误的可操作文案（fetch 直接抛错时用）。 */
export function describeProbeError(error: unknown): { message: string; hint: string } {
  const text = error instanceof Error ? error.message : String(error ?? '')
  const message = /abort|timeout/i.test(text) ? '连接超时：这个地址没有在 5 秒内响应' : `无法连接这个地址：${text || '网络错误'}`
  return {
    message,
    hint: '确认手机和电脑在同一网络、地址端口正确、电脑端插件已启动；也可以改用扫码绑定。',
  }
}

/**
 * 预检通过后决定要写到哪台「助理」记录上。
 * @param assistants 已绑定电脑（至少有 id/computerId/endpoints）
 * @param computerId health 返回的电脑 ID
 * @param assistantId 用户在 UI 上明确指定的助理（优先）
 */
export function pickAssistantForEndpoint<T extends { id: string; computerId?: string }>(
  assistants: T[],
  computerId: string | undefined,
  assistantId?: string,
): T | undefined {
  if (assistantId) {
    const explicit = assistants.find(item => item.id === assistantId)
    if (explicit) return explicit
  }
  if (!computerId) return undefined
  return assistants.find(item => item.id === computerId || item.computerId === computerId)
}

/**
 * 把手动输入的地址合并进助理记录的 endpoints：
 * 新地址放最前（它是用户刚验证过可用的），其余去重保留。
 */
export function mergeManualEndpoint(endpoints: unknown, endpoint: string): string[] {
  const list = Array.isArray(endpoints) ? endpoints.filter(item => typeof item === 'string') : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [endpoint, ...list]) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
