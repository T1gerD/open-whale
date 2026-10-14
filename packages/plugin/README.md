# dsh-openwhale

DeepSeek Harness 插件：让手机上的 **Open Whale** 应用以**个人助理聊天**的形式远程使用这台电脑上的 DSH。

- 展示一次性绑定二维码（浏览器页 / `/openwhale` 命令 / PNG / SVG）
- 为每台手机建立**专属 DSH 会话**，不干扰你桌面上的对话
- 在该会话作用域内注入**口语化个人助理语气**
- 把手机会话的**流式回复、工具活动、产出文件**推给手机
- 远程关机 / 重启（可取消宽限窗口）与局域网唤醒代发
- 可选公网隧道（cloudflared 快速隧道）

完整说明见仓库根 [README.md](../../README.md)；安装与排错见 [docs/install.md](../../docs/install.md)；
安全模型见 [docs/security.md](../../docs/security.md)。

## 安装

```bash
dsh plugin --profile <你的profile> add ./packages/plugin
```

然后重启 DSH，打开 `http://127.0.0.1:<DSH端口>/openwhale` 扫码。

## 设计要点

### 零运行时依赖

QR 编码器（`src/qr.mjs`）、WebSocket 服务端（`src/ws.mjs`）、线上协议（`src/protocol.mjs`）、
状态层、电源层全部自实现，只用 Node 内置模块。原因很实际：插件要靠**一次复制**装进 profile，
任何依赖树或构建步骤都会变成装机失败点。

### 协议副本是生成的

`packages/protocol` 是协议的**唯一权威源**（手机端也直接引用它）。插件内 `src/protocol.mjs`
是它的一份副本，由 `npm run sync:protocol` 生成，`test/protocol-copy.test.mjs` 保证不漂移。

**为什么必须有副本**：DSH 安装插件是**复制**包内容（pnpm `link:` 在 Windows 上表现为 Junction，
但打包/发布场景下是复制），任何 `../../` 形式的相对导入在装机后都会解析到包外并失败。
这个坑在真实装机中踩到过，所以现在有测试守着：
`test/protocol-copy.test.mjs` 会断言所有源码只从 `./protocol.mjs` 引入协议。

### 各模块职责

| 文件 | 职责 |
|---|---|
| `src/index.mjs` | cordis 插件入口：读配置、装配各部件、注册路由/命令、容错降级 |
| `src/dsh-bridge.mjs` | 手机 ↔ DSH 会话桥：建会话、发消息、把 `session/event` 映射成手机能懂的帧、登记文件 |
| `src/gateway.mjs` | HTTP + WebSocket 服务：鉴权、帧路由、文件分片、一次性下载令牌 |
| `src/ws.mjs` | RFC 6455 服务端：握手校验、帧编解码、分片重组、ping/pong、关闭握手 |
| `src/qr.mjs` | QR 编码器：v1-40、L/M/Q/H、8 种掩码自动择优、PNG/SVG/终端渲染 |
| `src/state.mjs` | 电脑身份（Ed25519）、配对窗口、已绑定手机；原子写 + 0600 |
| `src/pairer.mjs` | 二维码载荷构造与绑定可用性判断 |
| `src/voice.mjs` | 个人助理语气 prompt section（要短，且不牺牲准确性） |
| `src/power.mjs` | 关机/重启/取消 + WOL 魔术包 |
| `src/tunnel.mjs` | cloudflared 快速隧道生命周期（可选） |
| `src/wol-proxy.mjs` | 局域网唤醒代发（可选） |

### 容错降级

插件的可选部件全部容错，绑定二维码这条核心路径不依赖它们：

| 部件缺失 | 行为 |
|---|---|
| `@deepseek-ai/schemastery` 不可用 | 设置页没有字段，配置回落到内置默认值（不报错） |
| `@deepseek-ai/dsh-home-paths` 不可用 | 数据目录回落到 `$DSH_HOME/openwhale` |
| DSH web server 不可用 | 插件自己监听端口 |
| cloudflared 不可用 | 记录一条日志并继续，局域网方案不受影响。**不自动下载**二进制 |

## 测试

```bash
node test/run.mjs        # 或仓库根：node scripts/run-tests.mjs
```

不需要安装任何依赖。其中：

- `qr-decode.test.mjs` **独立实现解码侧**（定位格式信息、还原掩码、按标准走位读取码元、
  校验 RS 全零 syndrome、还原原文），用来证明生成的二维码真的可扫描，而不是只对结构打勾；
- `ws.test.mjs` 用真实 socket 跑握手、分片、异常帧；
- `e2e.test.mjs` 用真实 socket + 真实 Ed25519 签名，走完「扫码 → 绑定 → 聊天 → 流式回复 →
  工具活动 → 文件拉取 → 解绑」，并覆盖防冒充与防二维码重放。
