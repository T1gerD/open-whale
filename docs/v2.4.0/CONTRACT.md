# v2.4.0 契约（冻结）—— 会话标签页

> 协议源码已冻结在 `packages/protocol/src/index.mjs`（PROTOCOL_VERSION = `1.3.0`，38 项单测）。
> 插件内副本已同步。**任何一侧都不要改协议**；需要改先找 Lead。

## 1. 目标（用户原话）

> 「请把会话做成 dsh 形式，可以同时进行多个会话，并可直接在页面内点击会话实现切换会话」

即：像 DSH 桌面侧边栏那样——

1. **页内常驻的会话标签条**（不是弹窗）：标题 + 运行中指示 + 未读数，点一下立刻切换；
2. **多个会话同时进行**：切走的会话里 agent 继续跑，流式输出和完成结果都还送到手机，
   标签上能看到「正在回复」和未读；
3. 刷新/重连后标签与当前会话都还在。

## 2. 协议（1.3.0，已实现）

| 方向 | 帧 | 载荷 |
|---|---|---|
| C→S | `session/watch` | `{sessionIds: string[]}`（≤ `SESSION_WATCH_LIMIT`=8；整体替换；不含当前活跃会话） |
| C→S | `session/snapshot` | `{rid, sessionId}` → 回 `session/state`（带同 `rid`，`active:false`） |
| S→C | 所有会话帧 | 新增 `sessionId` 字段：`chat/delta`、`chat/done`、`chat/tool`、`chat/message`、`chat/echo`、`approval/ask`、`approval/resolved` |
| S→C | `session/state` | 新增可选 `rid`、`active` |

能力位：`session-tabs-v1`。旧客户端不认新帧会被忽略；新客户端只在电脑端声明该能力时使用标签功能。

电脑端行为（已实现，客户端可直接依赖）：
- `session/select` 切走时**不释放**旧会话 agent；旧会话自动进入后台订阅（不需要客户端额外发 watch，但重连后客户端要自己发一次）。
- 后台会话的 `chat/delta`、`chat/done`、`chat/typing`、`chat/message`、审批帧都会照常推给订阅的设备，且带 `sessionId`。
- `session/snapshot` 只允许取「当前绑定或已订阅」的会话，其它会话回 `error{code:'not-allowed'}`。

## 3. 客户端数据模型（两端一致）

```ts
type SessionTab = {
  id: string            // DSH sessionId
  title: string
  live?: boolean        // 电脑端创建时是否在跑（session/list 的 live）
  unread: number        // 非当前标签期间收到的 user/assistant 消息数
  typing: boolean       // 收到 chat/typing active=true 且尚未 done/error
  lastAt: number        // 最近一次收到该会话事件的时间（ms）
}

state:
  tabs: string[]                          // 已打开的标签，顺序稳定（打开顺序）
  activeSessionId: string                 // 当前显示的标签
  chats: Record<string, ChatState>        // 每个标签自己的消息/游标/审批
  activity: Record<string, {typing, unread, lastAt}>
```

规则：
- **帧路由**：所有带 `sessionId` 的帧进 `chats[sessionId]`；没有 `sessionId` 的旧帧进 `activeSessionId`。
- **切换**：点标签 → `activeSessionId = id`；本地已有消息先渲染；随后发
  `session/select {sessionId}`（电脑回 `session/selected` + `session/state`），
  或（为了不打断正在跑的其它连接）发 `session/snapshot {rid, sessionId}` 只取状态。
  **推荐**：点已经打开过的标签用 `session/snapshot`，只有需要改变「消息发往哪个会话」时才发 `session/select`。
  简化实现可两帧都发（select 负责后续 chat/send 的目标，snapshot 负责状态）。
- **订阅**：连接建立（hello/ack）后、以及 tabs / activeSessionId 变化后，发
  `session/watch {sessionIds: tabs.filter(id => id !== activeSessionId)}`（自动截断到 8）。
- **未读/运行**：非当前标签收到 `chat/echo`/`chat/message` 时 `unread++`；收到
  `chat/typing active:true` 置 `typing=true`，收到 `chat/done`/`chat/error` 置 `false`；
  切到该标签时 `unread=0`。
- **持久化**：每个助理保存 `{tabs, activeSessionId}`（手机端 SQLite / 网页端 localStorage），
  重新打开应用恢复；`session/list` 里已不存在的 id 打开时丢弃并提示。
- **审批**：审批卡显示在它自己的标签里；其它标签有排队审批时，标签上给一个角标。
- **新建**：`session/create` 成功后把新 id 加进 tabs 并激活。

## 4. UI 要求

- **标签条常驻**：聊天页顶部（标题栏下方）一条可横向滚动的标签条；每个标签显示
  标题、运行中圆点、未读数字、关闭 ×；末尾一个 `+`。点击整行切换。
- 底部输入栏上方**不要**再放会话胶囊/会话选择入口（原 v2.3.0 的胶囊可以删掉或改为
  「全部会话」按钮打开完整列表，用于把没打开的会话加成标签）。
- 切换必须是**即时的**：先渲染该标签缓存的消息，再让快照补齐；不要出现整页 loading。
- 标签关闭：只关闭本地标签；如果关的是当前标签，切到相邻标签并 `session/select` 它。
- 会话列表（session/list）仍然保留：作为「打开新标签」的来源，多一个「打开」动作；
  已经打开的会话显示为已打开。

## 5. 验收

- 打开 A、切到 B：A 的回复继续流式进入 A 的标签（未读数 +1，标签上有运行点）；
  切回 A 能立刻看到完整回复。
- 断开重连后标签与当前会话恢复。
- 两个标签的审批请求分别显示在各自标签里，不互相覆盖。
- `node scripts/run-tests.mjs` 全绿（沙箱里用 `TEMP=<repo>/.test-tmp`）。
