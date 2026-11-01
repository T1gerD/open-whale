# v3.0.0 契约：手机回答 DSH 的「提问」（questions）

> 协议源码已冻结在 `packages/protocol/src/index.mjs`（`PROTOCOL_VERSION = '3.0.0'`）。
> 本次只**新增**，已有帧/字段一律不改。插件内 `src/protocol.mjs` 由脚本同步。

## 背景

审批（`approval/request`）只管「允许/拒绝」；DSH 还有一条独立的 **结构化提问** seam：
`ctx.userQuestions`（`ask()` / `askTimed()`，工具 `ask_user_question`、计划审阅）。
两者形态不同：提问是「一批问题 + 选项 + 可选自定义文本」，答案必须**每个问题恰好一条**。

电脑端的拦截点与审批完全同构：

```
agentCtx.on('user-questions/request', handler, { prepend: true })
  handler(request, next) -> Promise<{ answers: [{id, selected: string[], custom?}] }>
```

`request = { questions, agent?, signal?, wait?: { callId, timed? } }`，
`questions = [{ id, question, detail?, header?, options?: [{label, description?}], multiSelect?, intent? }]`。
`askTimed()` 的问题在前台等待结束后仍可通过 `ctx.userQuestions.answer(agent, callId, answer)` 回答
（DSH 侧叫 continued question），所以手机晚答也要能生效。

## 协议（1.3.0 之上的纯增量）

| 方向 | 帧 | 载荷 |
|---|---|---|
| C→S | `question/reply` | `{ questionId, answers: [{id, selected: string[], custom?}] }` |
| S→C | `question/ask` | `{ sessionId, questionId, items: QuestionItem[], callId?, expiresAt, canAnswerLate? }` |
| S→C | `question/resolved` | `{ sessionId, questionId, outcome: 'answered'\|'timeout'\|'cancelled', source? }` |

能力位：`questions-v1`。常量：`QUESTION_TIMEOUT_MS = 90_000`、
`QUESTION_LATE_WINDOW_MS = 5 * 60_000`、`QUESTION_MAX_ITEMS = 10`、
`QUESTION_MAX_OPTIONS = 20`、`QUESTION_MAX_TEXT = 2000`；
纯函数 `normalizeQuestionAnswers(questions, value)` 负责「每个问题恰好一条 + 选项必须合法」。

`QuestionItem.intent` 原样透传：识别 `plan-review` 的客户端可以按「计划审批卡」渲染
（`intent.approve` 是表示同意的选项标签），不认识的客户端渲染普通选项即可。

## 电脑端行为（Lead 实现）

- 在 agent 的 `setup` 里注册 `user-questions/request`（`prepend: true`），与审批共用同一套
  「在线设备」判定（`gateway.approvalDevicesFor(sessionId)`，含后台标签订阅）。
- 没有在线手机 / 请求被中止 → `next()`（交回桌面 UI）。
- 有手机 → 发 `question/ask`，等 `question/reply`：
  - 收到合法批次 → 返回 `{answers}`；
  - 超时（`QUESTION_TIMEOUT_MS`）→ 记入「迟到可答」表（保留 `QUESTION_LATE_WINDOW_MS`），
    发 `question/resolved {outcome:'timeout'}`，并 `next()` 交回桌面；
  - 超时后手机才回：如果 `wait.callId` 存在且 agent 仍存活，调用
    `ctx.userQuestions.answer(agent, callId, answer)` 把答案 steer 进去，并广播
    `question/resolved {outcome:'answered', source:'phone-late'}`；
  - 中止 → `next()` + `question/resolved {outcome:'cancelled'}`。
- 答案必须经 `normalizeQuestionAnswers()` 清洗，绝不把垃圾丢给 DSH。

## 客户端要求（手机 + 网页版）

- **状态**：`questions: Record<sessionId, QuestionPrompt[]>`（按会话分开，多标签互不干扰；
  同一会话内多条排队，先答先出）。
  `QuestionPrompt = { questionId, sessionId, items, callId?, expiresAt, canAnswerLate, receivedAt }`。
- **帧处理**：`question/ask` 加入对应会话队列；`question/resolved` 移除。
- **UI**：聊天页（输入栏上方、审批卡下方）一张问题卡：
  - 每个问题显示 `header?` + `question` + `detail?`；
  - 有 `options`：单选用一组按钮，`multiSelect` 用多选；选中项高亮；
  - 每个问题都有「其他」输入框（`custom`）；单选时填了 custom 就把 `selected` 置空
    （DSH 规则：单选题 custom 覆盖选项），多选时 custom 与 selected 并列；
  - 「提交」把整批答案一次发 `question/reply`；没答的问题发 `{id, selected: []}`；
  - `expiresAt` 前显示倒计时；`canAnswerLate` 为假时到期禁用并自动收起；
  - 提交后乐观收起，收到 `question/resolved` 再清一次（幂等）。
- **降级**：电脑端没有 `questions-v1` 就不发这类帧，客户端自然什么都不显示。

## 验收

- `node scripts/run-tests.mjs` 全绿（沙箱用 `TEMP=<repo>/.test-tmp`）。
- 新增测试：协议（帧/能力/答案清洗）、插件（转发、超时交回、迟到答案、无手机交回）、
  两端 reducer/UI 模型（队列、单选 custom 覆盖、多选、跳过、过期）。
