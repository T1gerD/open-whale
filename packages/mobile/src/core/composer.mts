// 输入区右侧按钮的决策（与网页版同款，用户需求）：
//  * 正在生成且输入框为空 → 「停止」；
//  * 其余情况（含生成中但已输入文字）→ 「发送」，生成中的消息由电脑端排队。
// 抽成纯函数是为了让「发送 / 停止」这个反复出问题的判断有测试兜底。

export interface ComposerInput {
  streaming?: boolean
  hasText?: boolean
  hasAttachments?: boolean
  hasSession?: boolean
  sending?: boolean
}

export interface ComposerAction {
  showStop: boolean
  sendDisabled: boolean
}

export function composerAction(input: ComposerInput = {}): ComposerAction {
  const streaming = input.streaming === true
  const hasText = input.hasText === true
  const hasAttachments = input.hasAttachments === true
  const hasSession = input.hasSession !== false
  const sending = input.sending === true
  const empty = !hasText && !hasAttachments
  return {
    showStop: streaming && empty,
    sendDisabled: !hasSession || sending || empty,
  }
}
