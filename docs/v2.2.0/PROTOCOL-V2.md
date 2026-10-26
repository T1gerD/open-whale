# Open Whale 协议 1.1.0（v2.2.0 版）契约

> 本文是 v2.2.0 的**唯一协议契约**。权威实现是 `packages/protocol/src/index.mjs`
> （已冻结，由 Lead 维护，其他人不要改；插件里的 `packages/plugin/src/protocol.mjs`
> 是它生成的副本，跑 `node packages/plugin/scripts/sync-protocol.mjs` 同步）。
>
> 设计原则没变：**只增不改、未知帧双方都必须忽略**。所以 2.1.0 的手机配 2.2.0 的电脑、
> 或反过来都能用；新行为靠 `capabilities` 协商，不靠版本号比较。

## 0. 能力协商

`hello` 和 `hello/ack` 都带 `capabilities: string[]`（老版本没有该字段 = 没有能力）。
电脑端只能对**声明了对应 capability 的设备**发送新帧；老设备继续走老帧路径。

| capability | 含义 |
|---|---|
| `chat-echo-v1` | 广播 `chat/echo`（他人消息） |
| `chat-message-v1` | `chat/message` 按 `messageId` upsert 助手消息（修「回复重复拼接」） |
| `session-sync-v1` | `session/state` 快照 + `session/events` 游标追赶 |
| `participants-v1` | `session/participants` 在线成员 |
| `upload-v1` | `upload/*` 分块上传 |
| `collab-v1` | `collab/set` / `collab/state` |
| `file-offer-v1` | `file/offered` 电脑推文件到手机 |
| `endpoint-kinds-v1` | 二维码 / hello-ack 带分类地址（`epk` / `endpointList`） |

## 1. 绑定载荷（二维码 JSON）

新增字段（都可缺省，老插件不发）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `epk` | `string[]` | 与 `endpoints` 一一对应的单字母网络类型：`l` LAN、`t` Tailscale、`c` 公网隧道、`u` USB 回环、`x` 未知 |
| `web` | `string` | 网页版/PWA 客户端地址（鸿蒙、iOS、任意浏览器用），插件页面另出一个二维码 |
| `mode` | `string` | 生成这份载荷时使用的连接方式：`auto` / `lan` / `tailscale` / `tunnel` |

`parsePairingPayload` 已校验这些字段（格式非法直接拒绝，缺省放行）。
**二维码密度是真实风险**：`epk` 用单字母就是为了不把二维码撑大。

## 2. 连接方式（Tailscale 是一等公民，不再算作局域网）

导出：`CONNECTION_MODE`、`ENDPOINT_KIND`、`classifyEndpoint`、`isTailscaleHost`、
`endpointKindsForMode`、`orderEndpointCandidates`、`orderEndpoints`、`parseEndpointKinds`、
`encodeEndpointKinds`、`pickEndpoint(endpoints, preferred, options)`。

- Tailscale 识别三种形态：`100.64.0.0/10`、IPv6 ULA `fd7a:115c:a1e0::/48`、`*.ts.net`。
- `auto` 的优先级：**上次成功 > Tailscale > 局域网 > 公网隧道 > 未知**（loopback 仅显式允许）。
  旧实现的「https 永远第一」就是这次要修的根因，`pickEndpoint` 已同步改掉。
- 显式模式只保留该类地址；列表为空时手机端要给出可操作提示（文案见 §7）。

## 3. 帧清单（v2.2.0 新增）

### 客户端 → 电脑

| 帧 | 字段 | 说明 |
|---|---|---|
| `chat/send` | `rid`, `msgId?`, `callId?`, `text`, `speaker?`, `files?[]` | `msgId` = 幂等键（老客户端缺省回落到 `rid`/`callId`）；`files` 元素二选一：`{uploadId}`（新）或 `{name,mime,dataBase64}`（老） |
| `chat/cancel` | `callId` | 不变 |
| `session/sync` | `rid?`, `cursor?` | 请求补发；`cursor` 为已应用到的事件序号 |
| `upload/start` | `uploadId`, `name`, `size`, `mime?`, `sha256?` | 开始分块上传 |
| `upload/chunk` | `uploadId`, `seq`, `dataBase64` | 必须等 `upload/progress.nextSeq` 再发下一块（背压） |
| `upload/end` | `uploadId`, `sha256?` | 收尾校验 |
| `upload/cancel` | `uploadId` | 取消并清理临时文件 |
| `collab/set` | `rid`, `on: boolean` | 手机切换协作模式（需 `collab-v1`） |

### 电脑 → 客户端

| 帧 | 字段 | 说明 |
|---|---|---|
| `chat/echo` | `msgId`, `rid?`, `callId?`, `deviceId`, `speaker?`, `text`, `files?`, `at`, `seq?` | 会话内**所有**设备收到（含发送者，客户端按 `usr_<msgId>` 去重）。修「看不到别人消息」 |
| `chat/message` | `callId`, `messageId`, `index`, `text`, `seq?` | 助手消息按 `messageId` upsert（`text` 是全文，替换而非追加）。修「回复重复拼接」 |
| `chat/delta` | `callId`, `seq`, `text`, `messageId?` | 保留；只在没有 `chat/message` 能力时使用 |
| `chat/done` | `callId`, `text`, `files?`, `durationMs?`, `truncated?`, `seq?` | 权威全文；客户端覆盖式收尾 |
| `session/state` | `sessionId`, `sessionEpoch`, `head`, `snapshot{messages[],activeCall?}`, `collaboration` | 首次连接 / 会话切换 / 游标失效时的全量快照 |
| `session/events` | `sessionId`, `from`, `head`, `events[]` | `seq > cursor` 的持久事件回放 |
| `session/participants` | `sessionId`, `collaboration`, `participants[{deviceId,name,online}]` | 在线成员（协作头像条） |
| `collab/state` | `on`, `sessionId`, `sessionEpoch` | 协作开关变更广播 |
| `upload/ready` | `uploadId`, `chunkBytes`, `maxBytes` | 允许切块大小 |
| `upload/progress` | `uploadId`, `nextSeq`, `received` | 背压信号（每块确认） |
| `upload/done` | `uploadId`, `fileId`, `name`, `size`, `mime?`, `path?`, `sha256?` | 落盘成功，可把 `fileId` 放进 `chat/send.files[]` |
| `upload/error` | `uploadId`, `code`, `message` | 失败 |
| `file/offered` | `fileId`, `name`, `size`, `mime?`, `url?`, `from?`, `seq?` | 电脑 → 手机推文件卡片 |

**幂等规则（电脑端必须实现）**：按 `dedupeKey(deviceId, msgId)` 走 `IdempotencyCache`
（TTL 30 分钟、上限 2048）。重复的 `chat/send` 必须回 `chat/ack`（`duplicate: true`）而**不再**
投递进 AI 会话。手机端离线队列会故意重发，这是修「同一条消息投递两次」的关键。

**助手消息去重（bridge 必须实现）**：同一轮里按 DSH 的 assistant `messageId` 聚合，
`assistant/attempt` 与 `assistant/message` 同 id 只算一次；每条消息 emit 一次
`chat/message`（全文替换），`turn/end` 时 `chat/done.text` = 去重后拼接。

## 4. 会话事件日志与追赶

电脑端内存里每个会话一个 `SessionEventLog`（`limit=400`、`snapshotLimit=60`）：

- 持久事件：`chat/echo`、`chat/message`、`chat/done`、`file/offered`；`chat/delta`/`chat/tool`
  实时发但不入日志（重连后由 `chat/message` + `chat/done` 补全）。
- `hello` 带 `cursor`（上次已应用的最大 `seq`）：能回放就发 `session/events`，回放不了就发
  `session/state` 快照。
- 会话切换（协作模式开关）→ `sessionEpoch + 1`、`session/state` 重发、`chat/echo` 等继续。

## 5. 上传与落盘

- 分块：`UPLOAD_CHUNK_BYTES = 512 KiB`；单附件 `MAX_UPLOAD_BYTES = 64 MiB`；每条消息最多
  `MAX_UPLOAD_ATTACHMENTS = 8` 个。
- 落盘目录必须在**手机对话的工作目录内**（`<cwd>/.openwhale/uploads/`），否则 DSH 的文件
  沙箱读不到 —— 这是「模型有时读不到手机图片」的根因。
- 图片要保留原始扩展名（`photo.jpg` 不能变成 `photo`），消息文本里给**相对 cwd 的路径**并
  明确指出这是图片文件（助手可用 read 工具读取）。
- 上传空闲 `UPLOAD_IDLE_TIMEOUT_MS = 3 分钟` 清理临时文件；落盘用「临时名 → 完成后 rename」。

## 6. 多端广播

- `pushEvent` 由「发给单个 deviceId」升级为「发给会话内所有在线设备」：
  `chat/echo`/`chat/message`/`chat/delta`/`chat/done`/`chat/tool`/`chat/typing`/`chat/error` 都广播；
  `assistants`、`power/state` 等设备级帧仍单发。
- 会话归属由 `sessionIdFor(deviceId)` 决定（协作模式统一为 `store.sharedSessionId()`）。
- 连上/断开时向同会话广播 `session/participants`。

## 7. 手机端连接行为（实现要求）

1. 端点顺序：上次成功 →（auto 时）Tailscale → 局域网 → 隧道；新连接前**并发竞速前两个候选**
   （谁先握手成功用谁，另一个关掉），避免慢地址吃掉超时预算。
2. 连接方式设置：`自动 / 局域网 / Tailscale / 公网隧道` 四项，持久化到每个助理记录；
   选择非 auto 时该模式下无地址要明确提示（如「没有检测到 Tailscale 地址，请确认手机与电脑
   都登录了同一 tailnet」）。
3. 连续重连失败要给出可操作文案（含尝试过的地址列表 + 「去设置里换连接方式 / 重新扫码」）。
4. 手动连接：输入 `host:port`（可带 `http://`）→ 先 `GET /openwhale/health` 校验 → 保存；
   扫码失败页要直接给出「相册选图」「手动输入」两个入口。
5. 相册扫码：从相册选图 → 解码二维码 → 与相机扫码走**同一条** `bind()` 流程。

## 8. 兼容性矩阵

| 手机 | 电脑 | 结果 |
|---|---|---|
| 2.1.0 | 2.2.0 | 能用；无 echo/sync/chat-message，回复重复问题仍存在（老端限制） |
| 2.2.0 | 2.1.0 | 能用；新帧全部不发（电脑不声明能力），手机自动降级到 delta |
| 2.2.0 | 2.2.0 | 全部新能力 |
