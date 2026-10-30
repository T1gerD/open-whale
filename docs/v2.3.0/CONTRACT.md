# v2.3.0 契约（冻结）—— 远程遥控器

> 本文件是 v2.3.0 的唯一权威契约。协议源码已冻结在 `packages/protocol/src/index.mjs`
> （PROTOCOL_VERSION = `1.2.0`），任何一侧都**不要**改它；需要改先找 Lead。
> 插件内的副本已由 `node packages/plugin/scripts/sync-protocol.mjs` 同步。

## 0. 目标

Open Whale 回到「纯粹的远程遥控器」：

1. **删掉多人协作**：不存在共享会话、在线成员条、协作开关、消息里的 `[昵称]` 前缀、
   手机端「我在对话里的昵称」设置。每台手机始终只驱动它当前绑定的那个 DSH 会话。
2. **手机能处理 DSH 的权限请求**：电脑把 `approval/request` 转发到手机，手机作答。
3. **手机能选/建会话**：列出电脑上的 DSH 会话，选一个继续，或新建一个。
4. **聊天界面正好占满屏幕**（Android 软键盘不遮挡输入栏）。
5. **绑定二维码挪进插件页**：删掉聊天输入框「+」里的 openwhale 入口（即 `/openwhale`
   命令），改在 DSH 设置 → Open Whale 插件页里显示二维码，并提供「在浏览器中打开」。

## 1. 协议（已实现，勿改）

新增帧：

| 方向 | `t` | 载荷 |
|---|---|---|
| C→S | `session/list` | `{rid}` |
| C→S | `session/select` | `{rid, sessionId}` |
| C→S | `session/create` | `{rid}` |
| C→S | `approval/reply` | `{approvalId, outcome: 'allowed-once'\|'rejected'}` |
| S→C | `sessions` | `{rid?, current, sessions: SessionSummary[], truncated?}` |
| S→C | `session/selected` | `{rid?, ok, sessionId?, title?, sessionEpoch?, error?, message?}` |
| S→C | `approval/ask` | `{approvalId, toolName, reason?, displayReason?, callId?, expiresAt}` |
| S→C | `approval/resolved` | `{approvalId, outcome, source?}` |

`SessionSummary = {id, title, cwd?, createdAt, updatedAt?, live, current?}`。

删除帧/字段：`collab/set`、`collab/state`、`session/participants`；`hello/ack.collaboration`、
`session/state.collaboration`、`chat/send.speaker`。`chat/echo` 保留（只发给同一设备的
其它 socket，用于多窗口/竞速；协作语义已不存在）。

能力位：删除 `COLLAB`、`PARTICIPANTS`；新增 `SESSIONS: 'sessions-v1'`、
`APPROVAL: 'approval-v1'`。旧客户端不认新帧会自动忽略；新插件对旧客户端的
`collab/set` 不再回任何东西。

## 2. 电脑端语义

### 2.1 每设备一个可变的会话绑定

- `deviceSession: Map<deviceId, sessionId>`，替换原来的
  `store.sessionIdFor(deviceId)` + `store.sharedSessionId()` 方案。
- 新设备首次绑定：**新建**一个会话（等同 `session/create`），保持现在的默认体验。
- `session/list`：`ctx.sessionQuery.listSessions()` →
  过滤 `header.parentSession === undefined`（不要 subagent 会话）→ 标题用
  `ctx.sessionQuery.readTitleSnapshots(ids)`，没有标题时用 `cwd` 的最后一段或「新会话」；
  `updatedAt` 取 `readTitle` 里能拿到的值，拿不到就省略；按 `createdAt` 倒序。
  截断到 `SESSION_LIST_LIMIT`，`truncated: true`。
- `session/select`：
  - 会话不存在 → `session/selected {ok:false, error:'not-found'}`；
  - 已 live（`record.live === true` 或 `ctx.agents.get(id)` 有值）→ **不要**再 create/resume，
    复用现有 agent（`ctx.agents.get(id)`）即可，绝不产生第二个 agent；
  - 未 live → `ctx.agents.resume({ resumeSessionId })`；
  - 成功：更新 `deviceSession`、`sessionEpoch += 1`、回 `session/selected {ok:true,...}`，
    紧接着推 `session/state` 快照。
- `session/create`：新 `sessionId`（`crypto.randomUUID()` 即可，DSH 的 `SessionId` 是 brand
  string，插件侧不需要引入宿主包），`ctx.agents.create({sessionId, meta:{cwd: settings.cwd || 默认工作目录}, agentOptions, setup})`。
- 快照：`session/state` 应反映**该会话的历史**，而不只是插件进程内收到的增量。
  用 `ctx.sessionQuery.readSession(sessionId)`（`{header, events}`）+ 现有
  `SessionEventLog` 增量；把事件映射成 `{id, kind:'user'|'assistant', text, at, callId?}`
  （DSH 事件 kind 见 `packages/plugin/src/dsh-bridge.mjs` 里已有的 reducer），取最后
  `SESSION_SNAPSHOT_LIMIT` 条。读历史失败时要降级为当前日志，不能抛。

### 2.2 审批转发

- 在 `ctx.agents.create/resume` 的 `setup(agentCtx, agent)` 里注册：
  `agentCtx.on('approval/request', handler, { prepend: true })`。
- `handler(req, next)`：
  - 该 agent 没有在线手机 → `return next()`（交回桌面 UI）；
  - 有在线手机 → 发 `approval/ask`，等待手机 `approval/reply` 或
    `APPROVAL_TIMEOUT_MS` 或 `req.signal` 中止；
  - 手机答 `allowed-once` → 返回 `'allowed-once'`；`rejected` → `'rejected'`；
  - 超时/中止/没有手机 → `return next()`，并给已发的 ask 补一条
    `approval/resolved {outcome:'cancelled', source:'timeout'}`。
- 宿主约束（已核实）：`approval` 服务**没有超时**，手机不答会让工具调用一直挂着，所以
  上面的兜底超时是必须的；`prepend` 能抢在桌面 answerer 之前，但**不能绕过 `never` 策略**
  （`never` 会在 waterfall 之前直接 `rejected`）。返回 `allowed-once` 只授权这一次调用，
  **不会**提升沙箱模式——写工作目录外的文件仍会被 DSH 沙箱拒绝，这是设计边界。
- 转发只针对本插件自己创建/接管的 agent（`agent.ctx` 天然按 agent 过滤），不要监听全局。

### 2.3 插件页二维码（第 5 条）

- 删除 `index.mjs` 里 `/openwhale` 命令的注册（`commands.register`），这样聊天输入框
  「+」里不再有 openwhale 入口。
- 插件页：在 `package.json` 里声明 `dsh.client`（`platform: 'web'`），并让
  `exports` 暴露 `./client`；`lib/client.js` 用 `window.__ModuleLoader__.load({id, factory})`
  工厂格式，注册到 `plugins.bundle.config`（key 用包名 `dsh-openwhale`），组件里：
  - `<iframe src="/openwhale" />` 显示现有配对页（含二维码、已绑定设备、解绑）；
  - 一个「在浏览器中打开」链接指向 `/openwhale`（`target="_blank"`）。
- `scripts/build-plugin-package.mjs` 的文件清单要包含 `lib/client.js`（以及任何新增文件），
  `--check` 也要能对上新清单。
- 如果客户端 bundle 一次性做不完整：**先做宿主侧**（删命令 + `/openwhale` 页面里加一个
  「本页即插件页」的说明），并在报告里明确标注哪一块没做完，不要留半坏的注册代码。

## 3. 手机端（Expo）要求

- 删除：协作开关、参与者条/头像、`participants`/`collaboration` 状态、昵称设置与
  `[昵称]` 前缀、`collab` 相关 reducer 分支。
- 新增「会话」入口（聊天页标题栏或输入栏上方的一个胶囊）：打开会话列表
  （标题 + 相对时间 + 是否 live + 当前标记），可「新建会话」。选中/新建后走
  `session/select` / `session/create`，收到 `session/selected` + `session/state` 后
  整页替换消息。
- 审批：收到 `approval/ask` 时在聊天页显示一张卡片（工具名 + 原因 + 「允许一次」/
  「拒绝」），点按发 `approval/reply`；收到 `approval/resolved` 关闭卡片。
- 布局：聊天页必须正好占满可见区域。Android 上 `KeyboardAvoidingView` 不能再是
  `behavior: undefined`（edge-to-edge 下键盘会盖住输入栏）；用 `padding`
  （iOS）/ `height`（Android）+ 合适 `keyboardVerticalOffset`，并在 `app.json` 显式写
  `android.softwareKeyboardLayoutMode: "resize"`。列表 `contentContainerStyle` 底部留出
  输入栏高度，`insets.bottom` 只在输入栏内使用。

## 4. 网页版要求

与手机端一致（会话列表、新建、审批卡片、去掉协作/昵称）。网页里审批用页内卡片，不用
`window.confirm`。

## 5. 测试与验收

- `node scripts/run-tests.mjs` 必须全绿（沙箱里跑要给 `TEMP` 指到可写目录，见下）。
- 每个改动都要有测试：协议新增帧的编解码/校验、网关的 session/list|select|create、
  审批转发（含超时与委托）、客户端 reducer 的会话切换与审批卡片。
- 沙箱跑测试：`TEMP=<repo>/.test-tmp TMP=<repo>/.test-tmp node scripts/run-tests.mjs`。

## 6. 版本与文档

Lead 统一负责版本号（2.3.0）与 CHANGELOG/README；实现者不要各自 bump 版本。
