# Open Whale 🐳

把手机变成你这台电脑上的 DSH 的**个人助理**。

电脑上装 `dsh-openwhale` 插件，手机扫码绑定一次，之后就能像跟助理聊天一样远程使用电脑上的
DeepSeek Harness —— 口语化的回复、回复里的文件、远程关机/开机，都在这一个聊天窗口里。

**三种客户端，同一个插件**：

| 客户端 | 适合 | 安装方式 |
|---|---|---|
| 安卓应用（APK） | 安卓手机日常使用，体验最好 | 从 Release 下载安装 |
| **网页版 / PWA** | **鸿蒙 NEXT、iOS、任何手机浏览器**，零安装 | 浏览器打开 `http://<电脑>:8787/openwhale/app`，或扫插件页的第二个二维码；可「添加到主屏幕」 |
| iOS 应用 | 需要的用户自行出包 | `eas.json` + macOS 流水线，见 [docs/iOS-HarmonyOS.md](docs/iOS-HarmonyOS.md) |

```
┌────────────────────┐   扫码绑定（一次性）   ┌─────────────────────┐
│  安卓 / 网页版手机   │ ◀─────────────────── │   电脑上的插件        │
│                    │                       │   dsh-openwhale     │
│  多个助理           │   WebSocket 长连接     │                     │
│  聊天 / 文件 / 协作  │ ◀───────────────────▶ │  DSH 会话（协作可共享）│
└────────────────────┘                       └─────────────────────┘
        ▲                                              │
        └──── 局域网 · Tailscale · 公网隧道 ────────────┘
```

---

## 它解决什么

| 需求 | 实现方式 |
|---|---|
| 手机以聊天形式远程调用电脑上的 DSH | 插件为每台手机建一个 DSH 会话，手机消息经 WebSocket 送达，回复流式推回 |
| 回复像个人助理，不像程序 | 在该会话自己的作用域里注入「口语化个人助理」system prompt；桌面上的会话不受影响 |
| 回复里有文件时也要拿到文件 | 助手产出的文件被登记，手机按分片拉取，聊天里渲染成可点开的文件卡片 |
| **手机把照片/文件发给电脑** | **512 KiB 分块上传 + 背压 + 进度 + 断点重试，单附件上限 64 MiB**；落盘在会话工作目录内，AI 能直接读 |
| **电脑把文件发给手机** | 配对页「发送到手机」→ 手机上出现一次性下载卡片 |
| **多台手机同时用一个会话** | 协作模式：共享会话 + 消息回显 + 在线成员 + 断线追赶，谁说的都看得见 |
| 第一次绑定要扫电脑展示的二维码 | 插件展示二维码（浏览器页 / `/openwhale` 命令 / PNG / SVG），二维码里是**一次性、10 分钟有效**的绑定密钥 |
| **没法扫码时也能绑定** | 扫码页支持**相册识图**（选一张二维码截图）和**手动输入地址**（`host:port`，先探测 health 再保存） |
| 之后打开应用无需再次绑定 | 手机保存自己的 Ed25519 私钥；重连时用该私钥签名完成认证 |
| **连不上、连得慢** | 连接方式可选「自动 / 局域网 / Tailscale / 公网隧道」；自动模式顺序是**上次成功 → Tailscale → 局域网 → 公网隧道**，前两个候选并发竞速 |
| 一台电脑可以绑多台手机（上限 5 台） | 配对页展示已绑定设备，可单台改名、解绑 |
| 一台手机可绑多台电脑，显示为不同助理 | 手机端保存助理列表；备注本地可改并同步给电脑端 |
| 可远程关机 / 重启 | 电脑在线时可用，带可取消的宽限窗口 |
| 电脑关机时可远程开机 | **受物理限制**，见 [远程开关机](#远程开关机) |

---

## 目录结构

```
open-whale/
├── packages/
│   ├── protocol/          协议契约（唯一权威源，v1.1.0），含 31 项单测
│   ├── plugin/            DSH 电脑端插件（纯 ESM、零运行时依赖）
│   │   ├── src/
│   │   │   ├── index.mjs        cordis 插件入口：装配各部件、命令、路由
│   │   │   ├── dsh-bridge.mjs   手机 ↔ DSH 会话桥（会话、消息、事件、文件）
│   │   │   ├── gateway.mjs      HTTP + WebSocket 服务、鉴权、帧路由、会话事件日志
│   │   │   ├── upload.mjs       分块上传（背压、校验、落盘到工作目录）
│   │   │   ├── webchat.mjs      网页版静态资源服务（/openwhale/app）
│   │   │   ├── ws.mjs           自实现 RFC6455 服务端
│   │   │   ├── qr.mjs           自实现 QR 编码器（PNG/SVG/终端）
│   │   │   ├── state.mjs        电脑身份、配对窗口、已绑定手机（原子写）
│   │   │   ├── pairer.mjs       二维码载荷与可用性判断
│   │   │   ├── voice.mjs        个人助理语气 prompt section
│   │   │   ├── power.mjs        关机/重启/取消 + WOL 魔术包
│   │   │   ├── tunnel.mjs       cloudflared 快速隧道生命周期（可选）
│   │   │   ├── wol-proxy.mjs    局域网唤醒代发（可选）
│   │   │   └── protocol.mjs     ← 由 packages/protocol 生成的自包含副本
│   │   └── test/
│   ├── mobile/            Open Whale 手机应用（Expo / React Native / TS）
│   └── webchat/           网页版客户端（零构建、原生 ESM、PWA）
├── docs/
│   ├── install.md         安装与配置
│   ├── security.md        安全模型与威胁分析
│   ├── mobile-build.md    手机端本地出包（Android APK）
│   ├── iOS-HarmonyOS.md   iOS 出包与鸿蒙适配（网页版/ArkTS 壳）
│   └── remote-power.md    远程开关机的真实边界
└── scripts/run-tests.mjs  一次跑完所有包的测试
```

---

## 下载这一版

去 [Releases](https://github.com/T1gerD/open-whale/releases/latest) 下载（每个版本都带
`SHA256SUMS.txt` 可校验）：

| 文件 | 装到哪 | 怎么装 |
|---|---|---|
| `dsh-openwhale-2.2.0.tgz` | 电脑 | `dsh plugin --profile <你的profile> add ./dsh-openwhale-2.2.0.tgz`，然后重启 DSH |
| `dsh-openwhale.tgz` | 电脑 | 同上（固定名字的别名，脚本里用方便） |
| `open-whale-2.2.0.apk` | 安卓手机 | 允许「安装未知来源应用」后点击安装 |
| `open-whale.apk` | 安卓手机 | 同上（固定名字的别名） |

插件也发布在 npm 上，可以按包名安装（升级时 `dsh plugin` 的 `update` 同样适用）：

```bash
dsh plugin --profile desktop add dsh-openwhale
```

APK 由 GitHub Actions 在发布时构建（本仓库作者的环境里没有 JDK 与 Android SDK），用 debug
keystore 签名，**适合个人自用安装**；要出正式签名的包见 [docs/mobile-build.md](docs/mobile-build.md)。

自己打包插件：

```bash
node scripts/build-plugin-package.mjs            # → release/dsh-openwhale-2.2.0.tgz（含网页版）
node scripts/build-plugin-package.mjs --npm-dir  # → release/npm-package/（npm publish 用）
```

---

## 快速开始

### 1. 电脑端：装插件

从 Release 的 tarball 或 npm 安装：

```bash
dsh plugin --profile desktop add ./dsh-openwhale-2.2.0.tgz
# 或者
dsh plugin --profile desktop add dsh-openwhale
```

开发时可以直接装源码目录（改动只需重启 DSH）：

```bash
cd open-whale
dsh plugin --profile desktop add ./packages/plugin
```

（把 `desktop` 换成你实际使用的 profile 名。）装完重启 DSH。详细步骤与排错见 [docs/install.md](docs/install.md)。

### 2. 电脑端：拿到绑定二维码

浏览器打开 `http://127.0.0.1:<DSH端口>/openwhale`（插件固定端口是 `8787`，也可以直接开
`http://127.0.0.1:8787/openwhale`）。页面上有两个二维码：

- **手机 App 扫码**：给安卓应用扫；
- **网页版扫码（鸿蒙 / iOS / 任意浏览器）**：用**系统相机**扫，会直接打开网页版并自动绑定。

二维码有效期 10 分钟、**只能用一次**，绑定成功后立即失效。

### 3. 手机端：绑定

- **安卓**：安装 APK → 打开 → 扫第一个二维码（也支持相册识图 / 手动输入地址）。
- **鸿蒙 / iOS / 浏览器**：系统相机扫第二个二维码，或直接打开
  `http://<电脑地址>:8787/openwhale/app` 后在页面里粘贴配对内容。

### 4. 选择连接方式（建议）

配对页 / 手机设置里可以选：

| 方式 | 什么时候用 |
|---|---|
| 自动（默认） | 依次尝试「上次成功 → Tailscale → 局域网 → 公网隧道」，前两个并发竞速 |
| 局域网 | 手机和电脑在同一个 Wi-Fi |
| **Tailscale** | 两边都装了 Tailscale 并登录同一 tailnet；这是外网访问最稳的方式（固定 IP，不依赖公网隧道） |
| 公网隧道 | 没有 Tailscale、又不在同一网络时，用 cloudflared 临时隧道 |

> Tailscale 地址（`100.x.x.x`）现在是**独立的连接方式**，不再被当成局域网；自动模式会优先
> 用它，不会再让公网隧道抢在前面。

### 5. 之后

直接打开应用/网页即可，不需要再扫码。出问题时第一个该看的地方：
`$DSH_HOME/openwhale/openwhale.log`（插件自己的日志）。

---

## 远程连接怎么走

| 场景 | 方案 | 说明 |
|---|---|---|
| 手机与电脑在同一 Wi-Fi | 局域网直连（默认候选） | 插件监听 `0.0.0.0:8787`，二维码里带 `http://192.168.x.y:8787` |
| 两边不在同一网络，但有 Tailscale | **Tailscale（推荐）** | 固定 `100.x` 地址，不依赖公网隧道；插件与手机端都把它作为独立连接方式 |
| 没有 Tailscale | 公网隧道（`tunnelMode: quick`） | cloudflared 快速隧道。**注意**：官方定位是测试用，域名每次重启会变、部分地区不稳定 |
| 想完全不暴露端口 | 自建中继 + 电脑主动出站 | 协议按「中继不可信」设计：鉴权和身份验证都在应用层完成 |

自动模式下的优先级是「上次成功 → Tailscale → 局域网 → 公网隧道」；某个地址连不上会换下一个，
连续失败时手机端会告诉你在试哪些地址、建议换哪种连接方式。

云隧道不可用时，局域网/Tailscale 方案不受影响 —— 这条路径是刻意保证的（插件对可选部件全部容错）。

---

## 远程开关机

**关机 / 重启**：电脑在线时可用，默认 30 秒宽限窗口，期间手机或电脑都能取消。电脑端可一键禁用（禁用后仍允许取消）。

**开机**：电脑关机后自己什么都没在跑，任何跑在它上面的软件都不可能唤醒它。真正可行的路径只有三条：

1. 有一台**常开的设备**在同一局域网里替你发魔术包（插件内置「唤醒代理」，配置 `wol.targets`）；
2. 手机与目标电脑在**同一局域网**时，手机自己发广播；
3. 完全断电只能带外手段（智能插座 + 主板「来电自启」）。

并且需要在目标电脑上：BIOS 打开 Wake on Magic Packet、**关闭 Windows 快速启动**、网线连接。
详见 [docs/remote-power.md](docs/remote-power.md)。

---

## 安全

- 二维码里是**一次性**、10 分钟有效的绑定密钥；绑定成功即失效，截图外发无长期价值。
- 绑定后认证靠手机侧 Ed25519 私钥签名（私钥只在手机安全存储/浏览器本地，从不上传）。
- 二维码携带电脑公钥，手机可据此验证 `hello/ack` 的签名，冒名顶替的隧道会被识别。
- 重放的握手会被随机数防重放表拒绝。
- 手机只能读取本次对话中产出（或电脑主动发送）的文件，不能请求电脑上任意路径。
- **会改变电脑状态的 HTTP 接口**（协作开关、解绑、改名、发送文件、连接方式）只接受**本机
  loopback** 请求，因此即使配对页通过公网隧道打开，别人也无法远程改你的设置。
- 详见 [docs/security.md](docs/security.md)（含威胁分析与已知限制）。

---

## 测试

本项目不依赖任何第三方运行时库（QR 编码器、WebSocket、协议、状态层、上传层全部自实现），
因此测试可以直接跑，无需安装依赖：

```bash
cd open-whale
node scripts/run-tests.mjs          # 全部：43 个测试文件 / 656 项测试（v2.2.0 基线）
node scripts/run-tests.mjs qr       # 只跑文件名含 "qr" 的
node packages/mobile/scripts/check-syntax.mjs   # 手机端 TS 语法检查
```

> 测试运行器的实现不平凡，原因写在 `scripts/run-tests.mjs` 顶部的注释里：在这个沙箱环境中
> `node --test`、`node:test` 的 `run()` 流、以及 `process.exitCode` 都不可靠，所以运行器让每个
> 测试文件在自己的子进程里运行、把输出重定向到文件描述符（不用管道），再依据子进程自己打印的
> node:test 摘要判定成败。**缺失摘要一律算失败**。

测试覆盖（含手机端与网页版）：

| 包 | 覆盖内容 |
|---|---|
| `packages/protocol` | 帧词汇不冲突、配对载荷边界、**Tailscale/局域网/隧道分类与排序**、幂等缓存、会话事件日志与快照 |
| `packages/plugin` | QR 编码（含独立解码器验证）、RFC6455 帧/握手/分片、状态与防重放、网关（真实 socket）、幂等去重、助手消息去重、多端广播与会话同步、分块上传、DSH 会话桥、入口与模型选择、电源、隧道、唤醒代理、协议副本一致性、端到端 |
| `packages/mobile` | 配对、连接方式与竞速、消息 reducer（乱序/重复/多端同步）、离线队列幂等、上传状态机、相册识图纯逻辑、退避、base64、帧契约 |
| `packages/webchat` | 配对载荷解析、帧合并与去重、endpoint 排序 |

真实的装机验证（需要本机有 DSH）：

```bash
# 隔离环境，不动你正在用的 DSH_HOME
export DSH_HOME=<某个空目录>
dsh plugin --profile e2e add <本仓库>/packages/plugin
dsh --profile e2e --no-open
# 另开一个终端
node scripts/verify-install.mjs http://127.0.0.1:3080
```

该脚本会走完：读 health → 取二维码并按真实协议校验 → 打开网页版静态资源 → 用真实 Ed25519
密钥完成绑定 → 用二维码里的公钥验证电脑签名 → 能力协商 → 会话快照 → 发一条消息并验证
**同一 msgId 重发只受理一次**（v2.2.0 幂等性）。

---

## 已知限制

- **远程开机受物理条件限制**（见上），插件只能提供能力与检查清单。
- **快速隧道不适合长期使用**：无 uptime 保证、域名会变、部分地区不稳定。长期请用 Tailscale 或自建隧道。
- **鸿蒙原生应用**：RNOH 尚未支持 RN 0.86 / Expo SDK 57，本版交付的是**网页版 PWA**（可添加到
  主屏幕，体验接近原生）；鸿蒙原生壳可用 DevEco 的 ArkTS `Web` 组件包一层，见 [docs/iOS-HarmonyOS.md](docs/iOS-HarmonyOS.md)。
- **iOS**：本版提供 `app.json` iOS 配置、`eas.json` 与 GitHub Actions 模拟器构建流水线；真机安装 /
  TestFlight 需要 Apple 开发者账号（Expo 不支持在 Windows 本地构建 iOS）。
- 手机端 UI 与原生模块调用**尚未在真机回归**（开发环境没有 Android SDK/JDK）；出包由 GitHub
  Actions 完成。纯逻辑层有完整单测。
- 手机端**尚未实现**：后台保活、唤醒代理原生模块（目前只做引导）。
- 自动批准工具调用默认**关闭**（走 DSH 原有审批策略）；开启后手机发来的请求会跳过审批。

---

## 设计取舍（为什么这样做）

- **零依赖**：插件要靠一次复制就装进 profile，任何依赖树或构建步骤都会变成装机失败点。
  QR、WebSocket、协议、上传全部自带。
- **协议自包含**：`packages/protocol` 是唯一权威源，插件内 `src/protocol.mjs` 是生成副本，
  由 `test/protocol-copy.test.mjs` 保证不漂移。
- **协议只增不改**：v2.2.0 升到 1.1.0（能力协商 + 新帧），2.1.0 与 2.2.0 可混用，用户不必
  同时升级两端。
- **幂等靠客户端 id**：手机离线队列会重发，所以电脑端按 `(设备, msgId)` 去重；这是「同一条
  消息投递两次」的解。
- **多端同步靠事件日志**：每个会话一份有界事件日志 + 游标，新加入/断线的手机能追上进度；
  窗口失效时退化成快照。
- **音色只作用于手机会话**：用 agent 作用域的 prompt section，不影响桌面会话。
- **未知帧一律忽略**：电脑端和手机端可以独立升级。
