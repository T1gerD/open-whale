// 竞速连接的「谁算数」状态机（纯逻辑）。
//
// 背景（Lead 用真实插件复现的 bug）：客户端同时竞速两个地址、两个 socket 用同一个
// deviceId 各自完成 hello/ack 时，电脑端「同 deviceId 新连接踢旧连接」可能把客户端
// 刚选中的胜出连接踢掉；若客户端把每次被踢都当成普通断线，就会 1 秒一轮无限重连。
//
// 这个模块只回答三个问题（不碰 socket，可被 node --test 覆盖）：
//  1. 这一轮里哪个 attempt 的 hello/ack 算「胜出」（同一 generation 只认第一个）；
//  2. 某个 attempt 的 close/error 该不该处理（旧轮次/落选者的迟到事件一律忽略）；
//  3. 胜出连接刚建立就被关掉时，是「立刻重连」还是「连续抖动退避」还是「直接失败」。
//
// 规则：
//  * 每轮 `beginRound` 生成新的 generation，旧 generation 的一切事件都作废；
//  * 同一轮只有第一个通过校验的 hello/ack 能被 `adopt`，落选者即使晚到 ack 也不能覆盖；
//  * 胜出连接存活不足 RAPID_FLAP_MS 就断开 → 记一次 flap，按 flap 次数做退避
//    （2s/4s/8s/16s…），连续 MAX_RAPID_FLAPS 次判定为「被反复替换/踢掉」并失败，
//    给出可操作文案，绝不进入 1 秒重连死循环；
//  * 存活超过 RAPID_FLAP_MS 再断开 = 正常掉线，退避清零、按普通重连处理。

/** 胜出连接活多久以内算「刚建立就断」的抖动。 */
export const RAPID_FLAP_MS = 3_000

/** 连续抖动多少次后停止自动重连（约 2+4+8+16=30s，正好覆盖电脑端重启/切换窗口）。 */
export const MAX_RAPID_FLAPS = 5

/** 电脑端「被新连接替换」时 close 的提示（gateway 里是 1000 + replaced by…）。 */
const REPLACED_RE = /replac|替换|supersed/i

export interface CloseInfo {
  code?: number
  reason?: string
}

export interface RaceAttemptMeta {
  id: number
  endpoint: string
}

export interface RaceRound {
  generation: number
  attempts: RaceAttemptMeta[]
}

export type AckVerdict = 'won' | 'lost' | 'stale'

export type CloseVerdict =
  | { kind: 'stale' }
  | { kind: 'loser' }
  | {
      /** 正常掉线：按普通退避重连，flap 计数清零。 */
      kind: 'reconnect'
      backoffAttempt: number
      lastError: string
    }
  | {
      /** 刚建立就被断（含被替换）：按 flap 次数退避，不立即重连。 */
      kind: 'flap'
      flapCount: number
      backoffAttempt: number
      lastError: string
      hint: string
    }
  | {
      /** 连续抖动到上限：停止自动重连，给可操作文案。 */
      kind: 'fail'
      flapCount: number
      lastError: string
      hint: string
    }

/** 电脑端是否明确告知「这条连接被替换了」。 */
export function isReplacedClose(close: CloseInfo): boolean {
  const reason = typeof close.reason === 'string' ? close.reason : ''
  return REPLACED_RE.test(reason)
}

/**
 * 一轮竞速的记账器。连接层每轮：
 *   beginRound(candidates) → startAttempt(meta) → markAck(...) → adopt(...)
 * 关闭回调里只调 `resolveClose`，按返回值决定是否调度重连。
 */
export class RaceTracker {
  /** 当前轮次；旧轮次的事件一律 stale。 */
  generation = 0
  /** 当前轮胜出的 attempt id。 */
  winnerId: number | undefined
  /** 胜出连接建立（hello/ack 通过）的时刻。 */
  connectedAt: number | undefined
  /** 连续「刚建立就断」的次数。 */
  flapCount = 0
  private nextId = 1

  beginRound(endpoints: string[]): RaceRound {
    this.generation += 1
    this.winnerId = undefined
    this.connectedAt = undefined
    const attempts = endpoints.map(endpoint => ({ id: this.nextId++, endpoint }))
    return { generation: this.generation, attempts }
  }

  /** 这一轮是否还是当前轮（回调里先判它，旧 socket 的迟到事件直接丢）。 */
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  /** 某个 attempt 是否就是当前胜出者。 */
  isWinner(generation: number, id: number): boolean {
    return this.isCurrent(generation) && this.winnerId === id
  }

  /**
   * hello/ack 校验通过：同一轮只有第一个能赢；落选者返回 'lost'（调用方应关闭它）。
   */
  markAck(generation: number, id: number): AckVerdict {
    if (!this.isCurrent(generation)) return 'stale'
    if (this.winnerId !== undefined) return 'lost'
    this.winnerId = id
    return 'won'
  }

  /** 胜出者正式接管连接：记录建立时刻（用于区分「刚连上就断」和正常掉线）。 */
  adopt(generation: number, id: number, now: number): boolean {
    if (!this.isCurrent(generation) || this.winnerId !== id) return false
    this.connectedAt = now
    return true
  }

  /**
   * 某条连接关闭（客户端主动关的不会走到这里——回调已被摘掉）。
   * @param close 服务端给的 close code/reason
   * @param now 当前时间
   * @param lastError 调用方已有的错误文案（没有就兜底）
   */
  resolveClose(generation: number, id: number, close: CloseInfo, now: number, lastError?: string): CloseVerdict {
    if (!this.isCurrent(generation)) return { kind: 'stale' }
    if (this.winnerId !== id) return { kind: 'loser' }
    // 胜出者已关闭：清掉，允许下一轮重新竞速。
    this.winnerId = undefined
    const lifetime = this.connectedAt !== undefined ? Math.max(0, now - this.connectedAt) : 0
    this.connectedAt = undefined
    const replaced = isReplacedClose(close)
    const baseError = lastError ?? '连接已断开'
    if (!replaced && lifetime >= RAPID_FLAP_MS) {
      // 稳定在线过再掉线：正常重连，抖动计数清零。
      this.flapCount = 0
      return { kind: 'reconnect', backoffAttempt: 0, lastError: baseError }
    }
    this.flapCount += 1
    const lastFlapError = replaced
      ? '连接刚建立就被电脑端替换（可能另一台设备/网页版正在使用同一设备身份）'
      : `连接刚建立就断开（第 ${this.flapCount} 次）`
    if (this.flapCount >= MAX_RAPID_FLAPS) {
      return {
        kind: 'fail',
        flapCount: this.flapCount,
        lastError: lastFlapError,
        hint: replaced
          ? '电脑端把本机连接替换掉了：请关闭其他正在使用同一绑定的手机/网页版，或在本机和电脑上重新扫码绑定。'
          : '连接反复建立后立即断开：请检查网络是否稳定、电脑端插件是否刚重启，稍后再试；也可以在设置里换一种连接方式。',
      }
    }
    return {
      kind: 'flap',
      flapCount: this.flapCount,
      // 用 flap 次数当退避指数：2s → 4s → 8s → 16s，不会 1 秒一圈空转。
      backoffAttempt: this.flapCount,
      lastError: lastFlapError,
      hint: replaced
        ? '如果另一台设备正在使用同一绑定，请先关闭它；否则点「重连」或重新扫码。'
        : '正在自动重试；如果一直失败，可以在设置里换连接方式或手动输入地址。',
    }
  }

  /** 本轮某个非胜出候选失败（socket close/error）：用于判断整轮是否失败。 */
  isActiveRoundFailed(): boolean {
    return false
  }

  /** 重置（用户手动重连/停止时）。 */
  reset(): void {
    this.generation += 1
    this.winnerId = undefined
    this.connectedAt = undefined
    this.flapCount = 0
  }
}
