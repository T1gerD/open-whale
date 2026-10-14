// Human-readable guidance appended to the system prompt of phone-driven
// conversations.
//
// Why this file exists at all: the same model, asked the same question from a
// desktop IDE, is expected to answer like a program ("Done. 3 files changed...
// `src/a.ts:12`"). On a phone that reads as robotic. The product requirement is a
// personal assistant that talks the way a competent friend would — so the voice
// is injected as a scoped prompt section on the phone's agent only, never as a
// global setting that would also rewrite desktop conversations.
//
// Design notes:
//  * Kept short on purpose. Long persona prompts dilute the task instructions and
//    are the usual cause of "the assistant forgot what I asked".
//  * It never asks the model to invent facts, and explicitly keeps file paths and
//    numbers exact — "conversational" must not mean "less accurate".
//  * Tool activity is described as things *it is doing*, because on the phone the
//    tool rows are rendered separately from the reply text.

/** Stable name so a re-registration replaces rather than stacks. */
export const VOICE_SECTION_NAME = 'openwhale:voice'

/**
 * Order 100 places this after the harness identity (-1000) and the deployment
 * persona prefix (0), but well before the task-specific instructions that are
 * appended last. Prompt sections are concatenated in ascending order.
 */
export const VOICE_SECTION_ORDER = 100

/**
 * The prompt text for the personal-assistant voice.
 * @param {{ assistantName?: string, language?: string }} [options]
 * @returns {string}
 */
export function assistantVoiceSection(options = {}) {
  const name = options.assistantName ?? '助理'
  return [
    `# 对话语气（Open Whale 手机端）`,
    ``,
    `你正在通过手机上的 Open Whale 应用与用户对话，此时你是一位名叫「${name}」的个人助理，不是在终端里汇报工作的程序。`,
    ``,
    `- 用自然、口语化的中文回答，像熟悉用户的朋友一样说话；不要用「任务已完成」「操作成功」这类程序化措辞。`,
    `- 先直接回答用户关心的结论，再补充必要细节；不要复述工具调用过程，也不要把输出写成日志或清单堆砌。`,
    `- 长度随问题而定：闲聊一两句就够，复杂问题可以展开，但不要为了简短而省略关键结论。`,
    `- 不确定时直接说不确定，并说明你查证到哪里；绝不编造文件内容、命令输出或数字。`,
    `- 涉及路径、文件名、命令、代码、数字、报错信息时，保持逐字准确，并用反引号或代码块标出，方便用户在手机上复制。`,
    `- 需要用户做选择或补充信息时，直接问一个具体问题，不要输出表格或长篇选项。`,
    `- 如果这次回答里会产出文件（报告、图片、表格等），用一句话告诉用户文件是什么，文件本身由应用直接展示给用户。`,
  ].join('\n')
}

/**
 * Sentence appended when the phone asked something and the answer is being
 * truncated by the transport, so the assistant can warn the user itself.
 */
export const TRUNCATION_NOTICE = '（内容较长，手机上只显示了开头部分；完整内容可以在电脑上查看。）'
