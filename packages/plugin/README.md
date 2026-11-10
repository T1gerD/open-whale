# dsh-openwhale

DeepSeek Harness 插件：让手机以**个人助理聊天**的形式远程使用这台电脑上的 DSH —— 扫码绑定一次，
之后聊天、发图片/文件、看回复流式输出，还能直接在手机上续上电脑上的任意 DSH 会话。

**配套客户端**：安卓 App、iOS 构建（EAS/CI 流水线）、以及**零安装的网页版/PWA**（鸿蒙 NEXT、
iOS Safari、任意手机浏览器都能用）。网页版由本插件自己提供，地址是
`http://<电脑地址>:8787/openwhale/app`。

- 一次性绑定二维码放在 **DSH 设置 → 插件 → Open Whale** 的插件页里（也可「在浏览器中打开」），
  10 分钟有效、只能用一次
- 手机列出电脑上的 DSH 会话，选一个续聊或新建；选中的会话在电脑端同步可见
- 在该会话作用域内注入**口语化个人助理语气**
- 手机消息流式回复、工具活动、产出文件推送；手机 → 电脑分块上传（64 MiB，带进度）
- 电脑 → 手机发文件（一次性下载链接）
- **手机处理权限请求**：DSH 要审批工具调用时，**电脑端与手机同时展示**，任意一端允许一次 / 拒绝，先答先算（手机先答时桌面弹窗自动关闭；信号代理不可用时退回残框模式）
- **连接方式可选择**：自动 / 局域网 / **Tailscale** / 公网隧道；`自动` 优先直连，公网隧道不抢占
- 远程关机 / 重启（可取消宽限窗口）与局域网唤醒代发
- 可选公网隧道（cloudflared 快速隧道）

完整说明见仓库 [README](https://github.com/T1gerD/open-whale#readme)；安装与排错见
[docs/install.md](https://github.com/T1gerD/open-whale/blob/main/docs/install.md)；
安全模型见 [docs/security.md](https://github.com/T1gerD/open-whale/blob/main/docs/security.md)。

## 安装

从 Release 的 tarball 安装：

```bash
dsh plugin --profile <你的profile> add ./dsh-openwhale-3.0.1.tgz
```

（npm 上的 `dsh-openwhale` 尚未发布，暂不要按包名安装。）

然后重启 DSH，打开 **DSH 设置 → 插件 → Open Whale** 显示二维码；也可以在浏览器里打开
`http://127.0.0.1:8787/openwhale`。

## v2.3.0 的主要变化

- **协作模式整体删除**：共享会话、在线成员、消息昵称前缀、手机端昵称设置都没有了。
  一台手机始终只驱动它当前绑定的那个 DSH 会话。
- **会话选择 / 新建**：`session/list` / `session/select` / `session/create`（协议 3.0.0）。
- **手机审批**：`approval/ask` / `approval/reply` / `approval/resolved`；双端同时展示、先答先算。
- **二维码入口**：删掉聊天输入框「+」里的 `/openwhale` 命令，改为客户端插件页
  （`lib/client.js` + `dsh.client`，内嵌配对页 + 「在浏览器中打开」）。
- 会改变电脑状态的 HTTP 接口（解绑、改名、发送文件、连接方式）**仅本机可写**。

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
