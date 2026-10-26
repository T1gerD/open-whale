// 竞速连接与失败文案（纯逻辑）。
//
// 需求（PROTOCOL-V2 §7 / PLAN 问题 2）：
//  1. 每次建连**并发竞速前两个候选**，谁先完成 hello/ack 用谁，另一个立即关闭；
//  2. 失败按地址阶梯换下一个；
//  3. 连续失败 N 次给可操作文案：列出尝试过的地址 + 建议换连接方式/重新扫码/手动输入；
//  4. 上次成功的地址优先（粘住），连续失败到阈值才轮换。
//
// connection.ts 只负责开 socket / 收发帧，所有「这一轮试哪几个地址、失败后轮到哪里、
// 文案怎么说」都在这里，因此可以在没有 RN 的机器上用 node --test 覆盖。

import { endpointKind, endpointKindLabel } from './endpoint.mts'

/** 连续失败多少次后不再粘住上次成功地址、开始轮换。 */
export const ENDPOINT_SWITCH_AFTER = 3

/** 每次竞速并发尝试的地址数（协议要求前两个）。 */
export const RACE_CANDIDATES = 2

export interface RetryState {
  /** 上次握手成功的地址。 */
  preferred?: string
  /** 上次成功以来连续失败的轮数。 */
  failures: number
  /** 地址轮换游标。 */
  cursor: number
  /** 本轮（或最近几轮）已尝试过的地址，用于失败文案，去重。 */
  tried: string[]
}

export function createRetryState(preferred?: string): RetryState {
  return { preferred, failures: 0, cursor: 0, tried: [] }
}

export interface RacePlan {
  /** 本轮要并发尝试的地址（1–2 个，按优先级）。 */
  endpoints: string[]
  state: RetryState
}

/**
 * 规划一轮竞速。
 *
 * - 有上一次成功的地址、且连续失败还没到阈值 → 把它放在第一位（粘住），
 *   第二位补阶梯里的下一个候选，这样慢地址不会吃掉整个超时预算；
 * - 否则从游标处取两个地址，游标前进，保证每个地址都有机会被尝试；
 * - `tried` 累积本轮地址，供连续失败后的可操作文案使用。
 */
export function planRace(
  ladder: string[],
  state: RetryState,
  options: { switchAfter?: number; candidates?: number } = {},
): RacePlan {
  const switchAfter = Math.max(1, options.switchAfter ?? ENDPOINT_SWITCH_AFTER)
  const wanted = Math.max(1, options.candidates ?? RACE_CANDIDATES)
  const unique = [...new Set(ladder.filter(item => typeof item === 'string' && item !== ''))]
  if (unique.length === 0) return { endpoints: [], state: { ...state, tried: state.tried } }

  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (!value || out.includes(value)) return
    out.push(value)
  }
  const sticky = typeof state.preferred === 'string' ? state.preferred : undefined
  const stick = sticky !== undefined && state.failures < switchAfter && unique.includes(sticky)
  if (stick) {
    push(sticky)
    // 粘住时第二位从游标处补一个「其它地址」，避免永远只试同一个；
    // 游标每轮前进，等真正需要轮换时不会又从头开始。
    for (let i = 0; i < unique.length && out.length < wanted; i++) {
      const candidate = unique[(state.cursor + i) % unique.length]
      if (candidate !== sticky) push(candidate)
    }
    state = { ...state, cursor: state.cursor + 1 }
  } else {
    let cursor = state.cursor
    // 已经失败到阈值：第一轮不要再把 state.preferred 放第一位，否则「轮换」等于没轮。
    if (unique.length > 1 && sticky !== undefined && unique[cursor % unique.length] === sticky) cursor += 1
    for (let i = 0; i < unique.length && out.length < wanted; i++) {
      push(unique[cursor % unique.length])
      cursor += 1
    }
    state = { ...state, cursor }
  }
  const tried = [...state.tried]
  for (const endpoint of out) if (!tried.includes(endpoint)) tried.push(endpoint)
  return { endpoints: out, state: { ...state, tried } }
}

/** 一轮竞速里所有候选都失败：累计失败数，保留 tried 供文案使用。 */
export function onRaceFailed(state: RetryState, endpoints: string[] = []): RetryState {
  const tried = [...state.tried]
  for (const endpoint of endpoints) if (!tried.includes(endpoint)) tried.push(endpoint)
  return { ...state, failures: state.failures + 1, tried }
}

/** 握手成功：记住地址、清零失败、重置轮换。 */
export function onRaceWon(state: RetryState, endpoint: string | undefined): RetryState {
  return {
    preferred: endpoint,
    failures: 0,
    cursor: 0,
    tried: [],
  }
}

export interface FailureReport {
  message: string
  hint: string
  /** 尝试过的地址（UI 可以直接列出来）。 */
  triedEndpoints: string[]
}

/**
 * 连续失败后的可操作文案。
 * @param state 重试状态（tried/failures）
 * @param options.mode 当前连接方式（影响建议内容）
 * @param options.maxAttempts 自动重连上限（到了就停止自动重连）
 */
export function failureReport(
  state: RetryState,
  options: { mode?: string; maxAttempts?: number } = {},
): FailureReport {
  const tried = [...new Set(state.tried)].filter(item => item !== '')
  const modeLabel = modeHint(options.mode)
  const triedText = tried.length > 0 ? `已尝试：${tried.map(describeTriedEndpoint).join('、')}。` : ''
  const mode = typeof options.mode === 'string' ? options.mode : 'auto'
  const suggestions = [`在设置里把连接方式改为「${mode === 'auto' ? 'Tailscale' : '自动'}」试试`, '重新扫描电脑上的二维码', '手动输入电脑地址（设置 → 手动连接）']
  return {
    message: `连续 ${Math.max(1, state.failures)} 次连接失败。${triedText}`,
    hint: `${modeLabel}${suggestions.join('；')}。`,
    triedEndpoints: tried,
  }
}

/** 地址 + 网络类型的紧凑描述（失败文案里不能只给一串 URL，用户看不懂）。 */
export function describeTriedEndpoint(endpoint: string): string {
  try {
    return `${endpoint}（${endpointKindLabel(endpointKind(endpoint))}）`
  } catch {
    return endpoint
  }
}

function modeHint(mode: unknown): string {
  switch (mode) {
    case 'lan':
      return '局域网直连不可用（手机和电脑可能不在同一个 Wi-Fi，或路由器开了 AP 隔离）。'
    case 'tailscale':
      return 'Tailscale 不可用（手机和电脑可能没有登录同一个 tailnet，或 Tailscale 处于关闭状态）。'
    case 'tunnel':
      return '公网隧道不可用（隧道地址可能已过期，电脑端插件可能没有运行）。'
    default:
      return '所有已知地址都连不上（电脑可能关机/休眠，或手机与电脑不在同一网络）。'
  }
}
