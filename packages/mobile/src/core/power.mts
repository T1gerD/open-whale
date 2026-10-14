// 远程电源（关机 / 重启 / 取消）与“唤醒”引导的纯逻辑。
//
// 语义来自 protocol 的 PowerRequestFrame / PowerStateFrame 与电脑端 power.mjs：
//  * 电脑端把 delaySeconds 收敛到 [5, 600]，默认 30；
//  * 取消不需要令牌（PowerManager 在 token 为空时也允许取消），
//    但 PowerStateFrame 里可能带回 cancelToken，我们保存下来以备将来校验；
//  * `wake` 动作电脑端**不支持**（会返回 failed），所以“远程开机”只做 UI + 引导，
//    绝不发一个注定被拒绝的帧。

import { POWER_REFUSAL } from './frames.mts'

export const DEFAULT_DELAY_SECONDS = 30
export const MIN_DELAY_SECONDS = 5
export const MAX_DELAY_SECONDS = 600

export type PowerAction = 'shutdown' | 'restart' | 'cancel' | 'wake'

export interface PowerState {
  /** idle：没有任何计划；pending：有倒计时；cancelled/refused/executed：终态。 */
  phase: 'idle' | 'pending' | 'cancelled' | 'refused' | 'executed'
  action?: 'shutdown' | 'restart'
  /** 剩余秒数（pending 时有效）。 */
  remainingSeconds?: number
  delaySeconds?: number
  cancelToken?: string
  requestedAt?: number
  executeAt?: number
  reason?: string
  message?: string
}

export function idlePowerState(): PowerState {
  return { phase: 'idle' }
}

/** 电脑端可能把 delaySeconds 收敛过；这里用同一套边界做本地预校验。 */
export function clampDelaySeconds(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DELAY_SECONDS
  return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(numeric)))
}

export interface PowerRequestFrame {
  t: 'power/request'
  rid: string
  action: PowerAction
  delaySeconds?: number
}

/** 组装 `power/request` 帧。cancel 不带 delaySeconds（带了对端也忽略）。 */
export function buildPowerRequest(action: PowerAction, rid: string, delaySeconds?: number): PowerRequestFrame {
  if (action === 'cancel' || action === 'wake') return { t: 'power/request', rid, action }
  return { t: 'power/request', rid, action, delaySeconds: clampDelaySeconds(delaySeconds) }
}

export interface PowerStateFrame {
  t?: string
  rid?: string
  action?: string
  accepted?: boolean
  delaySeconds?: number
  cancelToken?: string
  reason?: string
  message?: string
  /** 电脑端 PowerManager 额外带回来的字段（协议未声明，收到就用）。 */
  executeAt?: string
}

/**
 * 应用一次 `power/state`。
 * 取消成功时回到 idle；关机/重启被接受时进入 pending 并开始本地倒计时。
 */
export function applyPowerState(current: PowerState, frame: PowerStateFrame, now: number = Date.now()): PowerState {
  const action = frame.action
  if (frame.accepted === false) {
    return {
      phase: 'refused',
      action: action === 'restart' ? 'restart' : action === 'shutdown' ? 'shutdown' : undefined,
      reason: frame.reason,
      message: refusalMessage(frame.reason, frame.message),
      requestedAt: now,
    }
  }
  if (action === 'cancel') {
    return { phase: 'cancelled', message: frame.message || '已取消', requestedAt: now }
  }
  if (action === 'shutdown' || action === 'restart') {
    const delaySeconds = clampDelaySeconds(frame.delaySeconds ?? current.delaySeconds)
    const executeAt = parseIso(frame.executeAt) ?? now + delaySeconds * 1000
    return {
      phase: 'pending',
      action,
      delaySeconds,
      remainingSeconds: Math.max(0, Math.round((executeAt - now) / 1000)),
      cancelToken: frame.cancelToken ?? current.cancelToken,
      requestedAt: now,
      executeAt,
      message: frame.message,
    }
  }
  // action 为空或未知：只更新提示，不改变阶段（避免把倒计时误清掉）。
  return { ...current, message: frame.message }
}

/** 本地倒计时推进；归零时进入 executed（此时电脑多半已经离线）。 */
export function tickPower(state: PowerState, now: number = Date.now()): PowerState {
  if (state.phase !== 'pending') return state
  const remaining = state.executeAt === undefined ? state.remainingSeconds ?? 0 : Math.max(0, Math.round((state.executeAt - now) / 1000))
  if (remaining <= 0) {
    return {
      ...state,
      phase: 'executed',
      remainingSeconds: 0,
      message: state.action === 'restart' ? '电脑正在重启' : '电脑正在关机',
    }
  }
  return { ...state, remainingSeconds: remaining }
}

/** UI 文案：给人看的倒计时，不是日志。 */
export function formatCountdown(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/** 二次确认对话框文案（含倒计时，让用户知道自己还有多少时间反悔）。 */
export function confirmCopy(action: 'shutdown' | 'restart', delaySeconds: number = DEFAULT_DELAY_SECONDS): { title: string; message: string; confirm: string } {
  const verb = action === 'restart' ? '重启' : '关机'
  const delay = clampDelaySeconds(delaySeconds)
  return {
    title: `要远程${verb}这台电脑吗？`,
    message: `电脑会在 ${formatCountdown(delay)}后${verb}，期间可以在聊天页点“取消${verb}”。正在运行的任务会中断，电脑关机后手机将无法连接它。`,
    confirm: `${formatCountdown(delay)}后${verb}`,
  }
}

/** 取消入口的文案：必须在倒计时里一直可见。 */
export function cancelCopy(action?: 'shutdown' | 'restart'): string {
  return action === 'restart' ? '取消重启' : '取消关机'
}

/** 把 POWER_REFUSAL 映射成可执行的中文说明。 */
export function refusalMessage(reason: unknown, fallback?: string): string {
  switch (String(reason)) {
    case POWER_REFUSAL.UNSUPPORTED_PLATFORM:
      return '当前电脑不支持远程电源操作（可能是系统或权限限制）'
    case POWER_REFUSAL.NO_PRIVILEGE:
      return '电脑端没有执行关机/重启的权限'
    case POWER_REFUSAL.DISABLED_BY_POLICY:
      return '电脑端已在设置里禁止远程关机/重启'
    case POWER_REFUSAL.ALREADY_PENDING:
      return fallback || '电脑上已经有一个关机/重启计划，请先取消'
    case POWER_REFUSAL.FAILED:
      return fallback || '电脑端执行失败'
    default:
      return fallback || '操作被拒绝'
  }
}

/** 电脑端通过 `assistants` 帧告知允许哪些操作；缺省时保守地只允许取消。 */
export function normalizeAllowedActions(allowed: unknown): Array<'shutdown' | 'restart' | 'cancel'> {
  if (!Array.isArray(allowed)) return ['shutdown', 'restart', 'cancel']
  const valid = allowed.filter((value): value is 'shutdown' | 'restart' | 'cancel' =>
    value === 'shutdown' || value === 'restart' || value === 'cancel',
  )
  return valid.length > 0 ? Array.from(new Set(valid)) : ['cancel']
}

export function actionAllowed(allowed: unknown, action: 'shutdown' | 'restart' | 'cancel'): boolean {
  return normalizeAllowedActions(allowed).includes(action)
}

function parseIso(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
