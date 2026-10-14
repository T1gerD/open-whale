// 重连退避（纯逻辑）。
//
// 需求：1s→2s→…→30s 封顶，带抖动；App 回前台要能立刻重试（调用方把 attempt 归零）。
// 抖动用注入的 random，测试才能断言确定的上下界。

export interface BackoffOptions {
  /** 第一次重试等待，默认 1s。 */
  baseMs?: number
  /** 倍增因子，默认 2。 */
  factor?: number
  /** 封顶，默认 30s（低于运营商 NAT 常见的 30–60s 空闲回收窗口意义不大）。 */
  maxMs?: number
  /** 抖动比例，默认 ±20%。 */
  jitter?: number
  /** 兼容 protocol 的命名习惯，等价于 jitter。 */
  jitterRatio?: number
  /** 注入 [0,1) 随机数，测试用。 */
  random?: () => number
  /** 最多重试多少次后放弃（配合 UI 的手动重试）。 */
  maxAttempts?: number
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random' | 'jitter' | 'jitterRatio'>> = {
  baseMs: 1000,
  factor: 2,
  maxMs: 30_000,
  maxAttempts: 12,
}

function jitterRatioOf(options: BackoffOptions): number {
  const value = options.jitterRatio ?? options.jitter
  if (value === undefined) return 0.2
  return Math.min(Math.max(value, 0), 1)
}

/**
 * 第 attempt 次重试（attempt 从 0 开始）应等待的毫秒数。
 * 抖动是乘性的（`base * (1 ± jitter)`），这样封顶之后依然有抖动，
 * 多台设备同时掉线也不会整点齐步重连。
 */
export function nextBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF.baseMs
  const factor = options.factor ?? DEFAULT_BACKOFF.factor
  const max = options.maxMs ?? DEFAULT_BACKOFF.maxMs
  const ratio = jitterRatioOf(options)
  const random = options.random ?? Math.random
  const step = Math.min(base * Math.pow(factor, Math.max(0, Math.floor(attempt))), max)
  if (ratio === 0) return Math.round(step)
  const factorWithJitter = 1 + ratio * (random() * 2 - 1)
  // 抖动后仍不超过封顶，也不低于 1ms。
  return Math.max(1, Math.min(max, Math.round(step * factorWithJitter)))
}

/** 退避序列，用于文档/测试/调试面板展示。 */
export function backoffSequence(count: number, options: BackoffOptions = {}): number[] {
  const out: number[] = []
  for (let i = 0; i < Math.max(0, count); i++) out.push(nextBackoffMs(i, options))
  return out
}

/** 是否还允许自动重试（超过上限就只留手动“重连”按钮，避免无限空转耗电）。 */
export function isRetryAllowed(attempt: number, maxAttempts: number = DEFAULT_BACKOFF.maxAttempts): boolean {
  return attempt < maxAttempts
}
