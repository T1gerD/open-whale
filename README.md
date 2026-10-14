# Open Whale 🐳

把手机变成你这台电脑上的 DSH 的**个人助理**。

电脑上装 `dsh-openwhale` 插件，手机上装 Open Whale 应用，扫一次二维码，之后打开应用就能像跟助理聊天一样远程调用电脑上的 DeepSeek Harness —— 它用口语化的人话回复你，产出文件会直接出现在聊天里，还能远程关机和（在满足条件时）远程开机。

```
┌──────────────┐   扫码绑定（一次性）   ┌───────────────────┐
│  Open Whale  │ ◀───────────────────── │  电脑上的插件      │
│   手机应用    │                        │  dsh-openwhale    │
│              │   WebSocket 长连接      │                  │
│  多个助理     │ ◀────────────────────▶ │  DSH 会话（每台手机一个）
│  聊天/文件    │   聊天 · 流式回复 · 文件  │  口语化语气注入     │
└──────────────┘                        └───────────────────┘
        ▲                                        │
        └──────── 互联网 / 局域网 ────────────────┘
```

---

## 它解决什么

| 需求 | 实现方式 |
|---|---|
| 手机以聊天形式远程调用电脑上的 DSH | 电脑端插件为每台手机建一个**专属 DSH 会话**，手机消息经 WebSocket 送达，回复流式推回 |
| 回复像个人助理，不像程序 | 在**该会话自己的作用域**里注入一段「口语化个人助理」system prompt；桌面上的会话不受影响 |
| 回复里有文件时也要拿到文件 | 助手产出的文件被登记，手机按分片拉取（另有一次性 HTTP 下载兜底），聊天里渲染成可点开的文件卡片 |
| 第一次绑定要扫电脑展示的二维码 | 插件展示二维码（浏览器页 / `/openwhale` 命令 / PNG / SVG），二维码里是**一次性、10 分钟有效**的绑定密钥 |
| 之后打开应用无需再次绑定 | 手机保存自己的 Ed25519 私钥；重连时用该私钥签名完成认证，不再需要二维码 |
| 一台电脑只能绑一台手机 | 电脑端强制：已绑定时，任何第二台设备（哪怕拿着有效二维码）都会被拒绝 |
| 一台手机可绑多台电脑，显示为不同助理，备注可改 | 手机端保存助理列表；备注本地可改，并会同步给电脑端 |
| 电脑关机时可远程开机 | **受物理限制**，见 [远程开关机](#远程开关机)；插件提供唤醒代理能力与前置条件检查清单 |
| 可远程关机 | 电脑在线时可用，带可取消的宽限窗口 |

---

## 目录结构

```
open-whale/
├── packages/
│   ├── protocol/          协议契约（唯一权威源），含 21 项单测
│   ├── plugin/            DSH 电脑端插件（纯 ESM、零运行时依赖）
│   │   ├── src/
│   │   │   ├── index.mjs        cordis 插件入口：装配各部件、命令、路由
│   │   │   ├── dsh-bridge.mjs   手机 ↔ DSH 会话桥（建会话、发消息、收事件、收文件）
│   │   │   ├── gateway.mjs      HTTP + WebSocket 服务、鉴权、帧路由、文件分片
│   │   │   ├── ws.mjs           自实现 RFC6455 服务端（帧编解码、握手、分片）
│   │   │   ├── qr.mjs           自实现 QR 编码器（v1-40、4 级纠错、8 种掩码、PNG/SVG/终端）
│   │   │   ├── state.mjs        电脑身份、配对窗口、已绑定手机（原子写 + 0600）
│   │   │   ├── pairer.mjs       二维码载荷与可用性判断
│   │   │   ├── voice.mjs        个人助理语气 prompt section
│   │   │   ├── power.mjs        关机/重启/取消（可取消宽限窗口）+ WOL 魔术包
│   │   │   ├── tunnel.mjs       cloudflared 快速隧道生命周期（可选）
│   │   │   ├── wol-proxy.mjs    局域网唤醒代发（可选）
│   │   │   ├── protocol.mjs     ← 由 packages/protocol 生成的自包含副本
│   │   └── test/               12 个测试文件
│   └── mobile/            Open Whale 手机应用（Expo / React Native / TS）
├── docs/
│   ├── install.md         安装与配置
│   ├── security.md        安全模型与威胁分析
│   ├── mobile-build.md    手机端本地出包（Android APK）
│   └── remote-power.md    远程开关机的真实边界
└── scripts/run-tests.mjs  一次跑完所有包的测试
```

---

## 下载这一版

去 [Releases](https://github.com/T1gerD/open-whale/releases/latest) 下载两个文件（每个版本都带 `SHA256SUMS.txt` 可校验）：

| 文件 | 装到哪 | 怎么装 |
|---|---|---|
| `dsh-openwhale-1.0.7.tgz` | 电脑 | `dsh plugin --profile <你的profile> add ./dsh-openwhale-1.0.7.tgz`，然后重启 DSH |
| `open-whale-1.0.7.apk` | 安卓手机 | 允许「安装未知来源应用」后点击安装；扫码绑定电脑 |

APK 由 GitHub Actions 在发布时构建（本仓库作者的环境里没有 JDK 与 Android SDK），用 debug keystore 签名，**适合个人自用安装**；要出正式签名的包见 [docs/mobile-build.md](docs/mobile-build.md)。

插件包同样可以自己打：

```bash
node scripts/build-plugin-package.mjs     # → release/dsh-openwhale-1.0.7.tgz
```

---

## 快速开始

### 1. 电脑端：装插件

从 Release 的 tarball 安装：

```bash
dsh plugin --profile desktop add ./dsh-openwhale-1.0.7.tgz
```

或者从源码目录安装（开发时更方便，改动只需重启 DSH）：

```bash
cd open-whale
dsh plugin --profile desktop add ./packages/plugin
```

（把 `desktop` 换成你实际使用的 profile 名。）装完重启 DSH。详细步骤与排错见 [docs/install.md](docs/install.md)。

### 2. 电脑端：拿到绑定二维码

任选一种：

- **浏览器**：打开 `http://127.0.0.1:<DSH端口>/openwhale`，页面上直接显示二维码；
- **命令**：在 DSH 里执行 `/openwhale`，终端里会打印二维码；
- **图片**：`/openwhale/qr.png` 或 `/openwhale/qr.svg`。

二维码有效期 10 分钟，**只能用一次**，绑定成功后立即失效。

### 3. 手机端：扫码绑定

安装 Open Whale 应用（见 [docs/mobile-build.md](docs/mobile-build.md) 自行出包），打开后点「添加助理」→ 扫描二维码。绑定成功后，这台电脑就出现在你的助理列表里。

### 4. 之后

直接打开应用即可，不需要再扫码。想改助理备注：助理详情页 → 重命名。

出问题时第一个该看的地方：`$DSH_HOME/openwhale/openwhale.log`（插件自己的日志）。

---

## 远程连接怎么走

| 场景 | 方案 | 说明 |
|---|---|---|
| 手机与电脑在同一 Wi-Fi | **局域网直连**（默认开启） | 插件监听 `0.0.0.0:8787`，二维码里带上 `http://192.168.x.y:8787` |
| 两边都在互联网上 | **公网隧道**（`tunnelMode: quick`） | 用 cloudflared 快速隧道把本地端口映射到 `https://xxx.trycloudflare.com`。**注意**：快速隧道官方定位是"测试用"，无可用性保证、域名每次重启会变、部分地区不稳定；长期使用建议自建反向隧道或改用组网（Tailscale 之类） |
| 想完全不暴露端口 | 你自建的中继 + 电脑主动出站 | 协议按「中继不可信」设计：鉴权与身份验证都在应用层完成，换中继不需要改协议 |

云隧道不可用时，局域网方案不受影响 —— 这条路径是刻意保证的（插件对可选部件全部容错）。

---

## 远程开关机

**关机 / 重启**：电脑在线时可用，默认 30 秒宽限窗口，期间手机或电脑都能取消。电脑端可一键禁用（禁用后仍允许取消）。

**开机**：这里有个绕不过去的物理事实 —— 电脑关机后，它自己就什么都没在跑了，**任何跑在它上面的软件都不可能唤醒它**。真正可行的路径只有三条：

1. 有一台**常开的设备**在同一局域网里替你发魔术包（插件内置了这个「唤醒代理」能力，配置 `wol.targets` 即可）；
2. 手机与目标电脑在**同一局域网**时，手机自己发广播；
3. 完全断电的场景只能用带外手段（智能插座 + 主板「来电自启」）。

并且需要在目标电脑上：BIOS 打开 Wake on Magic Packet、**关闭 Windows 快速启动**（否则普通关机是混合关机，网卡不会被 arm）、网线连接。详见 [docs/remote-power.md](docs/remote-power.md)。

---

## 安全

- 二维码里是**一次性**、10 分钟有效的绑定密钥，不是长期凭据；绑定成功即失效，截图外发无长期价值。
- 绑定后，认证靠手机侧 Ed25519 私钥签名（私钥只存在手机的安全存储里，从不上传）。
- 二维码同时携带电脑公钥，手机可据此验证 `hello/ack` 的签名，因此**冒名顶替的隧道**可以被识别。
- 重放的握手会被随机数防重放表拒绝。
- 手机只能读取**本次对话中产出**的文件，不能请求电脑上任意路径。
- 详见 [docs/security.md](docs/security.md)（含威胁分析与已知限制）。

---

## 测试

本项目**不依赖任何第三方运行时库**（QR 编码器、WebSocket、协议、状态层、电源层全部自实现），因此测试可以直接跑，无需安装依赖：

```bash
cd open-whale
node scripts/run-tests.mjs          # 全部 24 个测试文件、382 项测试
node scripts/run-tests.mjs qr       # 只跑文件名含 "qr" 的
```

> 测试运行器的实现不平凡，原因写在 `scripts/run-tests.mjs` 顶部的注释里：在这个沙箱环境中
> `node --test`、`node:test` 的 `run()` 流、以及 `process.exitCode` 都不可靠，所以运行器让每个
> 测试文件在自己的子进程里运行、把输出重定向到文件描述符（不用管道），再依据子进程自己打印的
> node:test 摘要判定成败。**缺失摘要一律算失败**——这是刻意的：早期版本曾把一个真实失败的套件
> 报成绿色，现在用「故意失败的探针」验证过它确实会报红。

测试覆盖（含手机端）：

| 包 | 文件数 | 覆盖内容 |
|---|---|---|
| `packages/protocol` | 1 | 帧词汇不冲突、配对载荷边界、时序安全比较、指纹格式化 |
| `packages/plugin` | 13 | QR 编码（含**独立解码器**验证）、RFC6455 帧/握手/分片/异常、状态与防重放、HTTP+WS 网关（真实 socket）、DSH 会话桥（含语气注入与自动批准接线）、入口与模型选择回退、电源、隧道、唤醒代理、协议副本一致性、**端到端** |
| `packages/mobile` | 11 | 配对、endpoint 轮换、消息 reducer（乱序/重复 delta）、离线队列、退避、base64、帧契约 |

其中 `packages/plugin/test/qr-decode.test.mjs` 会**重新实现解码侧**（定位格式信息、还原掩码、按标准走位读取码元、校验 RS 全零 syndrome、还原原文），用来证明生成的二维码真的能被扫描，而不是只对结构打勾。

真实的装机验证（需要本机有 DSH）：

```bash
# 隔离环境，不动你正在用的 DSH_HOME
set DSH_HOME=<某个空目录>
dsh rescue --from-default-profile web --dump-config
dsh plugin --profile rescue add <本仓库>/packages/plugin
dsh --profile rescue --no-open
# 另开一个终端
node _recon/verify-real-install.mjs http://127.0.0.1:3080
```

该脚本会走完：读 health → 取二维码 → 按手机的方式校验 → 建真实 WebSocket → 用真实 Ed25519 密钥完成绑定 → 用二维码里的公钥验证电脑签名 → 发一条消息并等待回复或明确错误。

---

## 已知限制

- **远程开机受物理条件限制**（见上），插件只能提供能力与检查清单，不能变魔术。
- **快速隧道不适合长期使用**：无 uptime 保证、域名会变、部分地区不稳定。长期使用请自建隧道或组网。
- 手机端 UI 与 Expo 原生模块调用**尚未在真机上跑过**（本仓库的开发环境没有 Android SDK）；纯逻辑层有 88 项单测覆盖。出包步骤见 [docs/mobile-build.md](docs/mobile-build.md)。
- 手机端**尚未实现**：Wake-on-LAN 原生模块（目前只做引导）、后台保活、手机 → 电脑的大文件分块上传。
- 自动批准工具调用默认**关闭**（走 DSH 原有审批策略）；开启后手机发来的请求会跳过审批，请自行权衡。

---

## 设计取舍（为什么这样做）

- **零依赖**：插件要靠一次复制就装进 profile，任何依赖树或构建步骤都会变成装机失败点。QR、WebSocket、协议全部自带。
- **协议自包含**：`packages/protocol` 是唯一权威源，插件内 `src/protocol.mjs` 是生成副本，由 `test/protocol-copy.test.mjs` 保证不漂移。原因：DSH 装插件是**复制**包内容，任何 `../../` 相对导入在装机后都会解析失败（这个坑已在真实装机中踩到并修掉）。
- **音色只作用于手机会话**：用 agent 作用域的 prompt section，而不是全局设置 —— 否则会把桌面会话的技术语气也一起改掉。
- **与会话隔离**：每台手机一个专属会话（`ow-<hash>`），不污染你桌面上正在进行的对话。
- **未知帧一律忽略**：手机端和电脑端可以独立升级，不会因为对端多了一种帧就崩。
