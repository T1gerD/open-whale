// 连接策略：决定"哪一类地址"允许被用来连电脑。
//
// 产品定位（v2 调整）：
//  * **常规连接**只用公网隧道（https/wss）。普通用户不需要知道 IP、端口、USB 这些东西。
//  * **局域网直连**与 **USB 调试通道**属于「高级连接方式」，藏在设置里，默认关闭。
//  * **USB 通道**（`http://127.0.0.1` + `adb reverse`）只给内部人员测试用：
//    必须先打开「内部测试模式」，USB 开关才可用；关掉内部测试模式会连带关闭 USB。
//
// 这里的策略是**纯内存状态**，持久化由 app-store 用设置 KV 负责（避免这个模块
// 反向依赖数据库层）。连接层（connection.ts）每次建连都会读它。

export interface ConnectionPolicy {
  /** 允许局域网直连（`http://192.168.x.x` 这类地址）。 */
  allowLan: boolean
  /** 允许 USB 调试通道（`http://127.0.0.1`，靠 adb reverse 转发）。 */
  allowUsb: boolean
  /** 内部测试模式：只有打开它，USB 通道开关才生效。 */
  internalTestMode: boolean
}

export const DEFAULT_CONNECTION_POLICY: ConnectionPolicy = {
  allowLan: false,
  allowUsb: false,
  internalTestMode: false,
}

/** 持久化到设置 KV 时用的 key。 */
export const CONNECTION_POLICY_KEYS = {
  allowLan: 'connection.allowLan',
  allowUsb: 'connection.allowUsb',
  internalTestMode: 'connection.internalTestMode',
} as const

let current: ConnectionPolicy = { ...DEFAULT_CONNECTION_POLICY }

export function getConnectionPolicy(): ConnectionPolicy {
  return current
}

/**
 * 更新策略，并强制维持两条不变式：
 *  1. 内部测试模式关闭 → USB 通道一律关闭（防止内部开关被遗留在正式包里）；
 *  2. 想开 USB 必须先开内部测试模式（传 allowUsb 但没开测试模式时，USB 仍为关）。
 */
export function setConnectionPolicy(patch: Partial<ConnectionPolicy>): ConnectionPolicy {
  const next: ConnectionPolicy = { ...current, ...patch }
  if (!next.internalTestMode) next.allowUsb = false
  current = next
  return current
}

export function resetConnectionPolicy(): void {
  current = { ...DEFAULT_CONNECTION_POLICY }
}

/** 从 KV 里的 `'1'` / 其它字符串还原布尔值。 */
export function parsePolicyFlag(value: string | undefined | null): boolean {
  return value === '1' || value === 'true'
}

/** 布尔值写成 KV 字符串。 */
export function formatPolicyFlag(value: boolean): string {
  return value ? '1' : '0'
}
