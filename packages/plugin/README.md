# dsh-openwhale

DeepSeek Harness 插件：让手机以**个人助理聊天**的形式远程使用这台电脑上的 DSH —— 扫码绑定一次，
之后聊天、发图片/文件、看回复流式输出，多台手机还能在同一个会话里协作。

**配套客户端**：安卓 App、iOS 构建（EAS/CI 流水线）、以及**零安装的网页版/PWA**（鸿蒙 NEXT、
iOS Safari、任意手机浏览器都能用）。网页版由本插件自己提供，地址是
`http://<电脑地址>:8787/openwhale/app`。

- 一次性绑定二维码（浏览器页 / `/openwhale` 命令 / PNG / SVG），10 分钟有效、只能用一次
- 为手机建立**专属 DSH 会话**（协作模式可共享），不干扰桌面上的对话
- 在该会话作用域内注入**口语化个人助理语气**
- 手机消息流式回复、工具活动、产出文件推送；手机 → 电脑分块上传（64 MiB，带进度）
- 电脑 → 手机发文件（一次性下载链接）
- **连接方式可选择**：自动 / 局域网 / **Tailscale** / 公网隧道；`自动` 优先直连，公网隧道不抢占
- 远程关机 / 重启（可取消宽限窗口）与局域网唤醒代发
- 可选公网隧道（cloudflared 快速隧道）

完整说明见仓库 [README](https://github.com/T1gerD/open-whale#readme)；安装与排错见
[docs/install.md](https://github.com/T1gerD/open-whale/blob/main/docs/install.md)；
安全模型见 [docs/security.md](https://github.com/T1gerD/open-whale/blob/main/docs/security.md)。

## 安装

从 npm 安装（推荐）：

```bash
dsh plugin --profile <你的profile> add dsh-openwhale
```

或从 Release 的 tarball 安装：

```bash
dsh plugin --profile <你的profile> add ./dsh-openwhale-2.2.0.tgz
```

然后重启 DSH，打开 `http://127.0.0.1:8787/openwhale`（或 DSH 端口下的 `/openwhale`）扫码。

## v2.2.0 的主要变化

- **连接**：Tailscale 成为独立连接方式（不再混在「局域网」里）；`自动` 顺序改为
  「上次成功 → Tailscale → 局域网 → 公网隧道」；修掉「公网隧道被强制优先」的判定 bug。
- **多端同步**：`chat/echo` 广播 + 会话事件日志/游标追赶 + 在线成员，新加入或断线的手机能
  看到别人发的内容与正在生成的回复。
- **去重**：按 `(设备, msgId)` 幂等，离线队列重发不会再让 AI 回两遍；助手消息按 DSH
  `messageId` 聚合，修掉协作模式下的回复重复拼接。
- **上传**：512 KiB 分块 + 背压 + 进度 + 断点重试；落盘到会话工作目录内，AI 能读到手机发的图片。
- **网页版**：插件内置 `/openwhale/app`，鸿蒙/iOS 浏览器可用，可添加到主屏幕。
- **协议 1.1.0**：只增不改，2.1.0 客户端可与 2.2.0 插件混用（能力协商决定新帧）。
- 会改变电脑状态的 HTTP 接口（协作开关、解绑、改名、发送文件、连接方式）**仅本机可写**。

## 设计要点

### 零运行时依赖

QR 编码器（`src/qr.mjs`）、WebSocket 服务端（`src/ws.mjs`）、线上协议（`src/protocol.mjs`）、
状态层、上传层、电源层全部自实现，只用 Node 内置模块。原因很实际：插件要靠**一次复制**装进
profile，任何依赖树或构建步骤都会变成装机失败点。

### 协议副本是生成的

`packages/protocol` 是协议的**唯一权威源**（手机端/网页版也直接引用它）。插件内 `src/protocol.mjs`
是它的一份副本，由 `npm run sync:protocol` 生成，`test/protocol-copy.test.mjs` 保证不漂移。

**为什么必须有副本**：DSH 安装插件是复制包内容，任何 `../../` 形式的相对导入在装机后都会解析到
包外并失败。这个坑在真实装机中踩到过，所以现在有测试守着。

### 网页版静态资源

`webchat/` 目录是零构建的网页版客户端（原生 ESM，无打包步骤）。插件在 `/openwhale/app`
提供它：开发时读仓库 `packages/webchat`，npm/打包安装时读包内 `webchat/`。

### 只信任应用层

隧道/中继一律不可信：鉴权靠手机侧 Ed25519 私钥签名，`hello/ack` 带电脑签名与二维码指纹可校验，
重放由随机数防重放表拒绝。
