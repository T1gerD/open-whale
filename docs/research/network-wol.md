<!--
这份报告是 Open Whale 开发期间的内部调研产物，原样发布以便读者复核结论。
为保护隐私，文中本机绝对路径与本地账户名已替换为占位符（<local-path> / <user> / %DSH_INSTALL%）；
除此之外内容未做修改，包括「已验证 / 推断 / 未找到」的标注。

原始文件名：NETWORK-WOL.md
-->
# 网络可达性与远程电源方案调研报告

- **调研日期**：2026-10-13（本机时区 +08:00）
- **调研对象**：Windows 上的 Node.js 后台进程（DeepSeek Harness 插件），需让手机 App 从互联网安全连入，并支持远程开机/关机
- **调研方式**：`web_search` / `web_fetch` 抓取实际页面 + 在本机（Windows / Node v24.21.0）实测命令
- **产出范围**：只做调研，不含开发
- **本机环境实测**：Windows，用户 `<host>\<user>`，Node **v24.21.0**，进程 `IsAdmin=False`，`whoami /priv` 仅列出 `SeChangeNotifyPrivilege`

> **可信度标注约定**
> - 「官方文档」= 厂商/项目自己的正式文档、官方博客、官方源码
> - 「社区经验」= 博客、论坛、第三方项目源码中的实践与实测数字
> - 「未验证」= 本次未能从页面取得确证，或未能在真机复现
> - 所有版本号、限制值、日期均来自本次实际抓取的页面

---

## 0. 首要结论：先纠正一个错误前提

任务描述里的既有证据是：

> `<local-path>` 存在（某个已安装的插件带了这个依赖），说明 cloudflared 二进制在当前用户环境里可能已经可用。

**这个前提在本机为假。** 该路径存在，但它只是 npm 生成的**转发脚本（shim）**，并不包含二进制。实测结果：

| 检查项 | 命令 | 本机实测结果 |
|---|---|---|
| shim 文件存在 | `Get-Item ...\.bin\cloudflared` | 存在，**1195 字节**（纯文本 shell 脚本），配套 `cloudflared.CMD` 208 字节、`cloudflared.ps1` 845 字节 |
| shim 指向的目标 | — | `node_modules/cloudflared/lib/cloudflared.js` |
| 目标是否存在 | `Test-Path ...\node_modules\cloudflared\lib\cloudflared.js` | **False**（`node_modules\cloudflared` 目录整体不存在） |
| 运行 shim | `& ...\.bin\cloudflared.CMD --version` | **exit=1**，`Error: Cannot find module '...\node_modules\cloudflared\lib\cloudflared.js'` |
| pnpm store | `Get-ChildItem node_modules\.pnpm \| ? Name -like '*cloudflar*'` | **无匹配** |
| PATH 上是否有 | `where.exe cloudflared` | **未找到** |
| 是否已有缓存二进制 | `Test-Path $env:TEMP\node-untun` | **False** |
| 是否已有命名隧道配置 | `Test-Path $env:USERPROFILE\.cloudflared\config.yml` | **False** |

**结论**：本机是一个**悬空 shim（dangling shim）**状态——包曾被安装过并留下 shim，但包体与 `cloudflared.exe` 都已不在。因此**不能**假设 `cloudflared` 开箱可用；插件必须在运行时具备「检测 → 获取 → 校验 → 缓存」这条完整链路，或者引导用户手动指定二进制（见第 8 节命令清单与第 10 节推荐 a）。

---

## 1. Cloudflare Quick Tunnel（无账号快速隧道）2026 现状

### 1.1 是否仍支持、域名形态

**仍然支持**，且是官方推荐的无账号开发方式。

- 官方文档 [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)（**Last updated Sep 30, 2026**，页面 JSON-LD `dateModified: 2026-09-30`）明确写：
  - 「Quick Tunnels create a temporary `trycloudflare.com` URL for a local service. You do not need a Cloudflare account or domain.」
  - 命令：`cloudflared tunnel --url http://localhost:8080`
  - 「Anyone with the URL can access your local service. The URL stops working when you stop the `cloudflared` process.」
- 分配域名形态确实为 `https://<随机词>.trycloudflare.com`。生产代码中的实测样例：
  - `cloudflared` npm 包 README 输出样例：`LINK: https://mailto-davis-wilderness-facts.trycloudflare.com`
  - [untun README](https://unpkg.com/untun@0.2.2/README.md)：`✔ Tunnel ready at https://unjs-is-awesome.trycloudflare.com`

### 1.2 官方限制（来自 Quick Tunnels 文档，逐条对应原文）

| 限制 | 官方原文要点 |
|---|---|
| 无可用性保证 | 「Quick Tunnels have no uptime guarantee.」 |
| 并发（in-flight 请求） | 「Each Quick Tunnel supports up to **200 in-flight requests**. Additional requests return a **429** response.」 |
| 不支持 SSE | 「Quick Tunnels do **not support Server-Sent Events (SSE)**.」 |
| 主机名不固定 | 「The hostname **changes each time** you create a Quick Tunnel.」 |
| 邮件鉴权不适用于非交互客户端 | 「Email authentication requires an interactive browser session. It does **not support non-interactive clients**.」 |
| 定位 | 「Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel.」 |

**带宽上限**：Quick Tunnels 文档**未给出任何带宽数值** → **未验证**。
相关的官方口径是 [Tunnels FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)（**Last updated Sep 16, 2026**）里关于大文件/流媒体的说明：public hostname 路由下，Free/Pro/Business 套餐受 service-specific terms 约束，**不得用于分发视频和其他大文件**（需改用付费服务如 Stream）。这是套餐条款层面的限制，不是速率数字。

**时长上限**：官方只承诺「no uptime guarantee」，**未给出最长时间** → **未验证**。

### 1.3 WebSocket 支持

- **官方（对 Cloudflare Tunnel 整体）**：[Tunnels FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) 原文：「Does Cloudflare Tunnel support Websockets? **Yes. Cloudflare Tunnel has full support for Websockets.**」（同页还有 gRPC 支持的说明）
- **针对 Quick Tunnel 的单独声明**：Quick Tunnels 文档的限制清单里**只排除了 SSE，没有排除 WebSocket** → 可合理推断 WebSocket 可用，但**官方没有针对 quick tunnel 单独写一句「支持 WebSocket」** → 标为「官方整体声明 + 对 quick tunnel 的具体行为**未验证**」。建议在真机上用 `wss://` 做一次端到端实测。

### 1.4 如何在 stdout/stderr 里解析分配到的 URL（含生产用正则）

**这是本次调研最实用的产出**：两个真实项目在生产代码里的解析逻辑（源码可直接核对）。

**(a) untun 0.2.2**（[dist/_chunks/cloudflared.mjs](https://unpkg.com/untun@0.2.2/dist/_chunks/cloudflared.mjs)）——**同时**监听子进程 `stdout` 与 `stderr`：

```js
// untun 0.2.2 实际源码
const urlRegex = /\|\s+(https?:\/\/\S+)/;          // URL：匹配日志框线 "|  https://xxx.trycloudflare.com  |"
const connRegex = /connection[ =]([\da-z-]+)/i;    // 连接 id
const ipRegex = /ip=([\d.]+)/;                     // 边缘 IP
const locationRegex = /location=([A-Z]+)/;         // 边缘机房，例如 tpe01
const indexRegex = /connIndex=(\d)/;               // 连接序号
// 四个都匹配到才算 "connected"
```

**(b) osmosis-sdk-python**（[osmosis_ai/eval/local/tunnel.py](https://github.com/Osmosis-AI/osmosis-sdk-python/blob/ecbe6e73e4bd789e13f1df776c0bd22476dac5f2/osmosis_ai/eval/local/tunnel.py)，经 GitHub Contents API 读取源码）——**只读 `stderr`**（`stdout=DEVNULL, stderr=PIPE`）：

```python
_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
_CONNECTION_REGISTERED_MARKER = "Registered tunnel connection"
_START_TIMEOUT_SEC = 30.0
# 已知失败信号（用于给出可读报错，而不是让用户死在 exit code 上）
_RATE_LIMIT_MARKERS = ("429 Too Many Requests", "error code: 1015",
                       "failed to unmarshal quick tunnel")
```

**日志样本形态**（由上述正则反推 + 官方 CLI 输出的通用形态，逐字原文**未验证**）：

```
2026-10-13T10:00:00Z INF +--------------------------------------------------------------------------------------------+
2026-10-13T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-13T10:00:00Z INF |  https://<random-words>.trycloudflare.com                                                  |
2026-10-13T10:00:00Z INF +--------------------------------------------------------------------------------------------+
2026-10-13T10:00:00Z INF Registered tunnel connection connIndex=0 connection=xxxxxxxx-... ip=198.41.200.193 location=tpe01
```

对应的连接成功对象样例来自 `cloudflared` npm README：

```
CONN: {
  id: 'df1b8330-44ea-4ecb-bb93-8a32400f6d1c',
  ip: '198.41.200.193',
  location: 'tpe01'
}
```

**工程建议（来自上述两处源码的实战做法）**：

1. **两路都监听**：untun 同时挂 `stdout` 和 `stderr`；只挂一路在某些版本/平台上会读不到 URL。
2. **必须持续 drain**：osmosis 注释原文——「The pipe must be drained for the child's lifetime — a full pipe would block cloudflared — so this task outlives the URL parse.」**不持续读取管道会把 cloudflared 卡死**，这是很容易踩的坑。
3. **必须设超时与「就绪」二次判据**：osmosis 用 30s 超时 + `Registered tunnel connection` 标记；并注明「Registration is sufficient readiness」。
4. **警惕假 URL**：社区 issue 标题显示曾有人把 `https://api.trycloudflare.com` 误当成公共 URL（[EvoScientist/EvoScientist issue #593](https://github.com/EvoScientist/EvoScientist/issues/593)，仅依据标题，正文**未验证**）。所以正则要**限定为 `https://<host>.trycloudflare.com` 且排除 `api.` 前缀**。
5. **避免命名隧道配置劫持**：osmosis 显式传 `--config <os.devnull>`，注释原文——「Quick tunnels are unsupported when a default config file (`~/.cloudflared/config.yml`, typically from a named-tunnel setup) exists; pinning an explicitly empty config keeps a user's named-tunnel installation from hijacking the run.」在 Windows 上等价于 `--config NUL`。本机实测目前没有该配置文件，但用户装过命名隧道后就会出现。
6. **传 `--no-autoupdate`**：两个项目都传了，避免 cloudflared 在运行中自我更新导致行为突变。

### 1.5 稳定性与「被墙」情况（中国大陆可用性）

**官方立场**：Quick Tunnels 文档只说「no uptime guarantee」，**没有任何地区可用性承诺** → 中国大陆可用性**官方无数据**。

**社区证据 1（稳定性）**：
- osmosis 源码注释原文：「Quick tunnels run a **single edge connection**, so the child can die mid-run; the supervisor watches `CloudflaredTunnel.wait` and halts dispatch with a clear error instead of letting pending rollouts hang.」→ **单条边缘连接**，进程可能中途死亡，必须有 supervisor 重启。
- 相关上游 issue（标题可见，正文**未验证**）：[cloudflared issue #1313 — QUIC tunnels unstable, torn with error="Incoming request ended abruptly: context canceled"](https://github.com/cloudflare/cloudflared/issues/1313)、[app-cloudflared issue #845 — Tunnel connection fails repeatedly with "timeout: no recent network activity"](https://github.com/homeassistant-apps/app-cloudflared/issues/845)。这两条说明隧道连接中断是长期存在的社区抱怨。

**社区证据 2（创建频率限制，实测数字）**：
- osmosis 源码注释原文：「Cloudflare rate-limits quick-tunnel **creation** per source IP (measured: **~20 tunnels inside 30 minutes** tripped it for **25+ minutes**; already-running tunnels keep serving). cloudflared surfaces the 429 only as log lines and a cryptic unmarshal error before exiting, so the lines are the signal.」
- → **社区实测**：同 IP 30 分钟内约 20 次创建会被限流并持续 25 分钟以上；**已建立的隧道不受影响**。官方文档**未提及**这条限制。

**社区证据 3（中国大陆可达性）**：
- 中文博客（**2026-04-20**）[⚠️ Cloudflare 这是在配合 GFW 吗？分配特殊 IP 遭精准阻断](https://zblog.hqyman.cn/post/19648.html) 称：Cloudflare 会给 Workers、Pages、**Cloudflare Tunnel 隧道**分配一批特殊 IP（文中列出 `104.21.96.1`、`104.21.32.1`、`104.21.16.1`、`104.21.64.1`、`104.21.80.1`、`104.21.48.1`、`104.21.112.1`），而 GFW 会针对这批 IP 阻断，导致站点无法访问；「**其中移动的阻断最为明显，而电信和联通的阻断基本看脸**」；给出的应对是「套优选 IP / SaaS 回源」。
- 该文为**社区经验**（非官方，且是个人博客转述），但它直接指向 Cloudflare Tunnel 这一路径，说明**在中国大陆走 Cloudflare 隧道存在实际的、按运营商差异化的阻断风险**。
- **`*.trycloudflare.com` 域名本身在中国大陆的可达性：未验证**（需要真机 + 多运营商实测，见第 8 节）。

**工程结论**：Quick Tunnel 适合作为「开箱即用的默认」，但**不能作为唯一路径**——它无 uptime 保证、单连接易断、域名每次变、创建有速率限制、在中国大陆部分运营商可能不可达。这正是第 4 节和第 10 节讨论「是否内置出站中继」的依据。

---

## 2. npm 包现状（包名 / 版本 / 是否需要外网二进制 / license）

数据来源：`registry.npmjs.org` 实际返回的 packument 与 `unpkg.com` 实际源码。

### 2.1 `cloudflared`（JacobLinCool/node-cloudflared）

| 项目 | 事实 | 来源 |
|---|---|---|
| 最新版本 | **0.7.3** | registry `dist-tags.latest` |
| 发布时间 | **2026-08-10T22:44:11.727Z** | registry `time` 字段 |
| license | **MIT** | registry `license` |
| 是否需要外网二进制 | **需要** | 见下 |
| 安装机制 | 包内不含二进制；`bin` = `./lib/cloudflared.js`，`postinstall` = `node scripts/postinstall.mjs && node lib/cloudflared.js bin install` | registry 0.7.3 `scripts` / `bin` |
| `postinstall.mjs` 干什么 | **只负责构建**：`if (!fs.existsSync(path.resolve(__dirname,"..","lib"))) execSync("npm run build")` | [scripts/postinstall.mjs](https://unpkg.com/cloudflared@0.7.3/scripts/postinstall.mjs) |
| 谁来下载二进制 | `bin install` 子命令（CLI），或库函数 `install()` | [lib/install.js](https://unpkg.com/cloudflared@0.7.3/lib/install.js) |
| 下载源 | `RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/"`；Windows x64 文件名 `cloudflared-windows-amd64.exe` | [lib/constants.js](https://unpkg.com/cloudflared@0.7.3/lib/constants.js) + install.js |
| 版本选择 | `CLOUDFLARED_VERSION = process.env.CLOUDFLARED_VERSION \|\| "latest"` | constants.js |
| 二进制默认落点 | `DEFAULT_CLOUDFLARED_BIN = <pkg>/bin/cloudflared.exe`（win32） | constants.js |
| **可跳过/覆盖下载** | **可以**：`let bin = process.env.CLOUDFLARED_BIN \|\| DEFAULT_CLOUDFLARED_BIN;`，另有 `use(executable)` 运行时覆盖 | constants.js |
| 库 API | `install(to, version)`、`bin`、`use(executable)`、`Tunnel.quick()`（EventEmitter，事件 `url` / `connected` / `exit`）、`service` | README（registry `readme`） |
| README 明确说明 | 「This tool will automatically install the latest version of `cloudflared` (or `CLOUDFLARED_VERSION` env var if exists) at the first time.」 | README |

**关键工程含义**：
- `postinstall` 会**真的去 GitHub Releases 下载二进制**（通过 `bin install` 链）。53 MB 级别（见 2.4），在中国大陆或 CI 环境里很容易失败/超时。
- `npm install --ignore-scripts` 能**跳过**下载，但插件随后必须自己提供二进制路径 → **`CLOUDFLARED_BIN` 环境变量就是官方留出的这道门**。这是本报告推荐 a 的技术支点。
- 注意版本差异：0.7.0 / 0.7.1 的 postinstall 是 `bin install latest`，0.7.3 是 `bin install`（不带参数，默认取 `CLOUDFLARED_VERSION`）。

### 2.2 `untun`（unjs）

| 项目 | 事实 | 来源 |
|---|---|---|
| 最新版本 | **0.2.2** | `registry.npmjs.org/untun/latest` |
| license | **MIT** | 同上 |
| 定位 | 「Tunnel your local HTTP(s) server to the world! **Powered by Cloudflare Quick Tunnels**」 | 同上 / README |
| 是否需要外网二进制 | **需要**（不是纯 JS） | 源码见下 |
| 二进制来源 | GitHub Releases，`RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/"` | [dist/_chunks/cloudflared.mjs](https://unpkg.com/untun@0.2.2/dist/_chunks/cloudflared.mjs) |
| 版本 | **硬编码固定 `CLOUDFLARED_VERSION = process.env.CLOUDFLARED_VERSION \|\| "2026.7.2"`** | 同上 |
| 二进制落点 | `path.join(tmpdir(), "node-untun", "cloudflared.<ver>.exe")`（Windows） | 同上 |
| 是否需用户接受条款 | **需要**：二进制缺失时打印 Cloudflare License/Terms/Privacy 提示，要求 `acceptCloudflareNotice` / `UNTUN_ACCEPT_CLOUDFLARE_NOTICE` / 交互确认，否则 `log("Skipping tunnel setup.", "error")` 并返回 | [dist/index.mjs](https://unpkg.com/untun@0.2.2/dist/index.mjs) |
| API | `startTunnel({url,port,hostname,protocol,verifyTLS,acceptCloudflareNotice,extraArgs})` → `{getURL(), close()}`；CLI `npx untun@latest tunnel http://localhost:3000` | README + dist/index.mjs |
| 血统 | 「cloudflared integration based on a fork of JacobLinCool/node-cloudflared」 | README |

**关键工程含义**：untun **不是**「纯 JS 替代」，它和 `cloudflared` 一样要下载 53 MB 外部二进制，而且**版本被钉在 2026.7.2**（比当前最新的 2026.10.0 旧 3 个月），还**要求接受条款**（交互式或不设环境变量就静默跳过）。作为「开箱即用」的默认依赖，它比 `cloudflared` 更差；但它的**正则与解析实现**值得直接借鉴（见 1.4）。

### 2.3 `localtunnel`

| 项目 | 事实 | 来源 |
|---|---|---|
| 最新版本 | **2.0.2** | `registry.npmjs.org/localtunnel/latest` |
| license | **MIT** | 同上 |
| 是否需要外网二进制 | **不需要**（**纯 JS**） | 依赖仅 `axios@0.21.4`、`debug@4.3.2`、`yargs@17.1.1`、`openurl@1.1.1` |
| 依赖的第三方服务 | 公共服务器 `localtunnel.me`（`bin` = `bin/lt.js`，描述 "Expose localhost to the world"） | 同上 |
| 最后发布 | registry `_npmOperationalInternal.tmp` 时间戳 `1631982224766` ≈ **2021-09-18** | 同上 |
| engines | `node >= 8.3.0` | 同上 |

**关键工程含义**：它是**唯一**「不需要外部二进制、安装即可用」的候选，符合任务「尽量不依赖 postinstall」的诉求；但代价是把可用性押在**第三方免费公共服务器 `localtunnel.me`** 上，且 **2021 年后未再发布**（维护停滞）。→ 只能作为**可选降级路径**，不能当默认。`localtunnel.me` 当前服务状态与限制**未验证**。

### 2.4 其他候选与「未找到」的包

| 名称 | 事实 | 来源 |
|---|---|---|
| `@aidenlx/cloudflared` | **npm registry 返回 HTTP 404 Not Found** → 该包名在 npm 上**不存在或已下架** | `registry.npmjs.org/@aidenlx%2Fcloudflared/latest` |
| `pinggy` | **不是 npm 库形态**，是 SSH 反向隧道**服务**（官网 <https://pinggy.io/>）。免费/付费额度与时长**未验证**（本次只取到 `pinggy.io/llms.txt`，未取得确切限制数字） | 搜索+官网 |
| `bore`（ekzhang/bore） | MIT，Rust，**11,530 stars**，`pushed_at` **2026-02-04**，公共中继 `bore.pub`。需外部二进制 | [GitHub API](https://api.github.com/repos/ekzhang/bore) |
| `zrok`（openziti/zrok） | **Apache-2.0**，Go，**4,773 stars**，`pushed_at` **2026-10-08**，官网 zrok.io（有免费公共实例）。需外部二进制 | [GitHub API](https://api.github.com/repos/openziti/zrok) |
| `frp` / `chisel` / `rathole` / `sish` / `pgrok` | 本次**未逐个核实**版本与 license → **未验证**，不作结论 | — |

**cloudflared 二进制本体的官方事实（基准数据）**：

- 最新 release：**2026.10.0**，`published_at` **2026-10-05T17:43:45Z**（来源 [GitHub Releases API](https://api.github.com/repos/cloudflare/cloudflared/releases/latest)）
- Windows x64 资产：`cloudflared-windows-amd64.exe`，**55,365,048 字节（≈52.8 MB）**，`download_count` 213,705
- 官方 SHA256：`86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c`
- 官方 [Downloads 页](https://developers.cloudflare.com/tunnel/downloads/)（**Last updated Sep 11, 2026**）提示：「Instances of `cloudflared` do not automatically update on Windows. You will need to perform manual updates.」
- 支持策略（同页）：「Cloudflare supports versions of `cloudflared` that are **within one year** of the most recent release.」

→ **52.8 MB 的 GitHub Releases 下载**是这条路径最大的工程摩擦点（中国大陆尤其）。

---

## 3. Reverse 连接架构（电脑主动出站 → 手机连中继）

### 3.1 Happy Coder（slopus/happy，原 happy-coder）

| 项目 | 事实 | 来源 |
|---|---|---|
| 定位 | CLI 已进入维护模式，新功能在 Happy 桌面应用；服务端开源 | [Self-Hosting 文档](https://happy.engineering/docs/guides/self-hosting/) |
| 服务端规模 | 「The server is about **12,000 lines** of TypeScript. You can read it yourself to verify it just forwards encrypted messages.」 | 同上 |
| 自建要求 | Docker 镜像 `happy-server`；端口 **3005**；必须设 **`HANDY_MASTER_SECRET`**（32 字节 hex，`openssl rand -hex 32`）；数据在 `/data`（内嵌 PGlite）；可选自己的 Postgres / Redis | 同上 |
| 客户端配置 | 手机：首个界面齿轮 → **Server** → 填 `http://your-server:3005`；CLI：`HAPPY_SERVER_URL` | 同上 |
| 生产 HTTPS | 文档给 Caddy 反代示例（`reverse_proxy localhost:3005`） | 同上 |

**密钥体系与端到端加密**（[Security & Encryption 文档](https://happy.engineering/docs/security/)）：

- **Layer 1 — MASTER SECRET（32 字节）**：账户级，**只在手机/浏览器**，`❌ Never sent to server ❌ Never seen by CLIs`；备份码即它的 base32 形式。
- **Layer 2 — CONTENT KEY PAIR**：由 master secret 经 **HMAC-SHA512 derive**；content secret key 只在手机（`❌ Never leaves mobile`），content public key 共享给所有 CLI。
- **Layer 3 — DEK（Data Encryption Key，32 字节随机 AES-256）**：
  - **SESSION DEK**：每会话随机，用 content public key 加密后存服务器 → 用于加密会话消息与元数据；
  - **MACHINE DEK**：每 CLI 机器随机，同样加密后存服务器，**本机存于 `~/.happy/access.key`** → 加密机器名/状态/偏好。
- **EPHEMERAL KEYPAIR**：`[ONCE/AUTH]`，「Secure key exchange during **QR auth**」，用完即弃。
- **服务器可见范围**：官方给出「Server compromised → Attacker gains: encrypted DEKs, encrypted content, metadata；Cannot access: decrypted DEKs, any content, keys」。即**中继只做盲转发**。
- **共享机制（设计亮点）**：要分享会话时不重新加密内容，只把 **32 字节的 DEK 用对方 public key 重新加密**（「KEY INSIGHT: Session content never re-encrypted!」）。
- **认证**：官方称 「No account needed - Authentication uses **cryptographic proofs**」。
- **仍会外流的流量**（文档明确列出，很有参考价值）：模型厂商 API 直连、**Expo 推送**（通知含会话标题明文）、PostHog 分析、可选 GitHub 登录/ElevenLabs/RevenueCat。

**对本插件的意义**：Happy 是「**有账号体系 + 长期主密钥 + 每会话 DEK + 中继盲转发**」这一路线的完整参考实现，代价是**必须有一台自己的服务器**（与「不依赖自备服务器」冲突）。

### 3.2 chroxy（blamechris/chroxy）

| 项目 | 事实 | 来源 |
|---|---|---|
| license / 活跃度 | **MIT**；**7 stars**；`pushed_at` **2026-10-13T06:02:39Z**（非常活跃）；语言 JavaScript | [GitHub API](https://api.github.com/repos/blamechris/chroxy) |
| 数据路径 | `Mobile App / Desktop <-> **Cloudflare Tunnel** <-> WebSocket Server <-> Session Provider <-> AI CLI` | [Architecture 文档](https://www.blamechris.com/chroxy-docs/architecture)（Jun 06, 2026） |
| 关键区分 | **服务器跑在用户自己的开发机上**，用 Cloudflare Tunnel 暴露 —— 这是「本机监听 + 隧道」，**不是**「出站到自建中继」 | [Security 文档](https://www.blamechris.com/chroxy-docs/security)（Jun 06, 2026） |
| 隧道角色 | Tunnel 被明确标为 **Untrusted（Transport）**；两端各自为 **Trusted** | 同上（给出 ASCII 信任边界图） |
| 协议校验 | WebSocket 消息用 **Zod** schema 校验（`ws-schemas.js`） | Architecture |
| 协议版本 | `auth_ok` 携带 `protocolVersion`（**当前为 2**），breaking change 时递增以优雅降级 | Architecture |
| 消息清单 | C→S：`auth`、`key_exchange`、`create_session`、`switch_session`、`destroy_session`、`input`、`interrupt`、`set_model`、`set_permission_mode`、`permission_response`、文件/git/历史操作、`budget` 等；S→C：`auth_ok`/`auth_fail`、`key_exchange_ok`、`stream_start`/`stream_delta`/`stream_end`、`permission_request`/`permission_resolved`、`server_shutdown`/`server_status` 等 | Architecture |
| 广播范围 | 分 session-scoped 与 global 两类；客户端靠 `subscribe_sessions` 订阅非活动会话 | Architecture |
| 重连状态机 | `disconnected -> connecting -> connected / reconnecting / server_restarting`（Zustand store） | Architecture |

**加密与鉴权（[Security 文档](https://www.blamechris.com/chroxy-docs/security) 逐条）**：

1. **认证**：客户端用**预共享 API token** 认证；服务器回 `auth_ok` 并带 `encryption: 'required'`（或 `--no-encrypt` 时为 `'disabled'`）。
2. **密钥交换**：双方各自生成**临时 X25519** 密钥对（`nacl.box.keyPair()`）；客户端发 `key_exchange`，服务器回 `key_exchange_ok` 带自己的公钥。
3. **共享密钥**：双方调 `nacl.box.before(...)`，做 **Curve25519 DH + HSalsa20** 派生 32 字节对称密钥。
4. **加密**：后续消息用 **XSalsa20-Poly1305**（TweetNaCl secretbox）密封。
5. **安全属性**：密钥**每连接临时** → **前向保密**；**不落盘**；密钥交换窗口内服务器缓存出站消息且**绝不降级为明文**——若加密已启用，pending 阶段出现任何非 `key_exchange` 消息就**断开客户端**。

**三类令牌（权威的权限分级参考）**：

| 令牌 | 签发者 | 权限范围 |
|---|---|---|
| Primary API token | `chroxy init` / `TokenManager` 轮换 | **完整会话权限 —— 等价于主机本地访问** |
| Pairing-bound session token | `PairingManager` 消费一次性配对 ID 时签发 | **绑定到恰好一个会话**；会话范围处理器若目标不符则拒绝 |
| Per-session hook secret | `CliSession` 构造时（**32 随机字节**） | 仅一个会话 + CLI 权限钩子回调端点（`POST /permission`） |

**配对流程（可直接借鉴）**：配对 ID 显示为 **QR 码，60 秒单次使用 TTL**；客户端扫码后发 `{ type: 'pair', pairingId }`，服务器签发**新的 32 字节 session token（24h TTL，内存中）**；**primary token 从不上网**。令牌存储：服务器端优先 OS keychain，回退 `~/.chroxy/config.json`；手机端用 `expo-secure-store`。

### 3.3 woly-server（kaonis/woly-server）

| 项目 | 事实 | 来源 |
|---|---|---|
| license | **Apache-2.0** | [GitHub API](https://api.github.com/repos/kaonis/woly-server)（`license.spdx_id`；LICENSE 文件 11,358 字节） |
| 创建 / 最后推送 | created **2026-02-08**；`pushed_at` **2026-10-05T14:51:30Z** | 同上 |
| 描述（原文） | 「WoLy server monorepo — **node agent + C&C backend + shared protocol**」 | 同上 |
| 规模/成熟度 | TypeScript，**2 stars**，**47 open issues**，1 fork | 同上 |
| 仓库结构（API 目录清单） | `apps/`、`packages/`、`docs/`、`scripts/`、`docker-compose.yml`、`SECURITY_AUDIT.md`、`IMPROVEMENTS.md`、`AGENTS.md`、`LICENSE`、`NOTICE` | [Contents API](https://api.github.com/repos/kaonis/woly-server/contents/) |

**架构判读**：描述里的 **「C&C backend + node agent」** 正是「**云端下发 WOL 唤醒包**」的标准形态——一个命令控制后端 + 一个部署在局域网内的 node agent，agent 负责在 LAN 内发魔术包。

> **诚实标注**：我**未能读到 README 正文**（`raw.githubusercontent.com`、`cdn.jsdelivr.net`、`r.jina.ai` 在本环境均被阻断，README 大小 14,831 字节）。因此它的**具体鉴权方式、协议字段、加密方案、agent 与后端的通信方式全部为「未验证」**。
> **成熟度判断**：2 stars / 47 open issues / 单人项目 → **不建议直接把插件押在它上面**，但它的**架构分层值得作为设计参考**。

### 3.4 协议设计要点清单（综合 Happy + chroxy 的可复用模式）

1. **配对（首次接入）**
   - 生成**短 TTL、单次使用**的 pairingId（chroxy：QR + **60s** single-use）。
   - 配对只用于**换取长期凭据**；长期凭据 = **32 随机字节**（chroxy session token）。
   - **主凭据绝不上线**（chroxy 的 primary token 从不经网络传输）。
2. **设备鉴权**
   - 连接后**第一条必须是 `auth`**；失败回 `auth_fail` 并断开。
   - 优于「直接发共享密钥」的做法是 **challenge-response**：服务器发 nonce，客户端用配对时获得的密钥做 HMAC 签名；或 Happy 式的 **cryptographic proofs**。
   - 令牌分级：**操作员级 / 会话级 / 单会话钩子密钥**三档（chroxy 的表格），避免一把钥匙开所有门。
3. **路由到具体设备**
   - 中继需要一个**路由键**：`accountId` / `machineId` / `deviceId` / `sessionId`，消息信封带 `deviceId`，中继按 `device:<id>` 维护连接表。
   - 广播要分范围：**session-scoped vs global**（chroxy），避免把 A 设备的输出推给 B 设备。
   - 若中继只做**盲转发**（Happy 模式），它**不需要解密**，但**必须能看到 deviceId/sessionId 等路由元数据**——这是「盲转发」与「可路由」的边界，设计时要明确写下来。
4. **端到端加密**
   - **最低可行**：单连接**临时 X25519** → `nacl.box.before()`（Curve25519 DH + HSalsa20）→ **XSalsa20-Poly1305** secretbox（chroxy 的完整四步）。
   - **更强的密钥分层**：账户级 master secret（永不出设备）→ HMAC-SHA512 派生内容密钥对 → 每会话/每机器的随机 AES-256 DEK，服务器只存被公钥加密的 DEK（Happy）。好处是**分享/轮换只需重加密 32 字节 DEK**。
   - **绝不允许降级**：密钥交换未完成前拒绝明文（chroxy 直接断开违规客户端）。
5. **长连接韧性**
   - 显式重连状态机（chroxy：`disconnected → connecting → connected / reconnecting / server_restarting`）。
   - 心跳/ping-pong + 空闲超时；配合 supervisor 做指数退避重启（因为 quick tunnel **单边缘连接**易断）。
6. **信任边界必须写进文档**
   - chroxy 明确画了「本机=可信 / 隧道=不可信 / 手机=可信」，并据此在应用层加密。
   - 若采用本机监听 + 隧道暴露，**Cloudflare 边缘在应用层未加密时可见明文**——所以 E2E 加密不能省。

### 3.5 「是否值得内置出站中继模式」的架构判读

**关键事实对比**：

| 路线 | 代表 | 是否需自备服务器 | URL 是否稳定 | 穿透严苛网络 | 开发成本 |
|---|---|---|---|---|---|
| 本机监听 + Quick Tunnel | chroxy / untun / 本报告推荐 a | **不需要** | **不稳定**（每次变） | 一般（部分地区不可达） | 低 |
| 本机监听 + Named Tunnel | 同上 | 需 CF 账号 + 域名 | 稳定 | 一般 | 中 |
| **出站到自建中继** | **Happy** | **需要**（Docker + 3005 + master secret） | **稳定** | 好 | **高**（约 12k 行 TS 级别的参考实现） |
| 出站到公共中继 | bore.pub / zrok | 不需要（用公共的） | 半稳定 | 好 | 中（要外部二进制） |

**判读**：出站中继的**唯一不可替代价值**是「**稳定入口 + 强穿透**」。它与「尽量不让用户自备服务器」直接冲突。因此正确姿势是**把它做成可选的高级模式**，而不是默认（见第 10 节推荐 b）。

---

## 4. Wake-on-LAN over Internet（从手机远程唤醒已关机的 Windows）

### 4.1 为什么「公网直接发魔术包」基本不成立

- 权威依据（**官方**）：Tailscale 官方博客 [Make a dedicated Wake-on-LAN server with Tailscale](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)（**August 19, 2025**）原文：
  - 「WoL packets are **broadcast on the data link layer, or Layer 2**.」
  - 「Tailscale operates on the network layer (**Layer 3**)... Tailscale **can't send WoL packets** (sometimes called "Magic Packets") over a Layer 2 connection, **even if you have enabled subnet routing** and it _feels_ like you're on your local network」——并链到长期存在的上游讨论 [tailscale/tailscale#306](https://github.com/tailscale/tailscale/issues/306)。
  - 「Just keep in mind that **devices needing a wake-up have to be on the same local network, and connected by ethernet**.」
- **推论**：L2 广播帧不会被路由跨越子网。因此「从互联网往家里路由器的公网 IP 发 UDP 9，让路由器广播到 LAN」这一步需要一个非常特殊的特性——**IP directed broadcast**（把发往子网广播地址的单播 IP 包在最后一跳转成广播）。
  - Cisco 有专门的官方文档说明这是**需要显式配置的交换机/路由器特性**：[Configure SD-Access Silent Host with IP Directed Broadcast Feature](https://www.cisco.com/c/en/us/support/docs/cloud-systems-management/catalyst-center/225850-configure-sd-access-silent-host-with-ip.pdf)、[Catalyst Layer 3 Switch for Wake-On-LAN Support Across VLANs Configuration Example](http://www.cisco.com/application/pdf/paws/91672/catl3-wol-vlans.pdf)。→ 属**企业网络**能力，**家用路由器多数不提供**。
  - 「向路由器公网 IP 做端口转发（UDP 9 → 目标主机单播 IP）」能否生效**取决于网卡固件是否接受定向魔术包** → **未验证**，且不应作为设计基础。
- **DDNS 只解决「地址会变」，完全不解决「广播不可路由」**。这是两件独立的事。

### 4.2 真正可行的三条路径及其真实条件

**路径 1：局域网内有一台常开设备做代理（最稳、最通用）**

- 条件（官方博客给出）：一台**常开**、**有线连接**、**与目标机同局域网**的设备（树莓派/旧笔记本/NAS/软路由），在上面跑发魔术包的工具。
  - 工具示例（官方博客）：`sudo apt install etherwake` → `sudo etherwake AA:11:BB:22:CC:33`
  - 或部署 Web 面板 **UpSnap**（[seriousm4x/UpSnap](https://github.com/seriousm4x/UpSnap)）：自托管 webapp，提供浏览器仪表盘发 WOL，能记住设备内网 IP、能扫描网络、也支持关机操作。
- 手机如何到达这台代理：
  - **Tailscale + Tailscale Serve / MagicDNS**：把 UpSnap 以 `https://upsnap` 之类的 MagicDNS 名发布到整个 tailnet（官方博客 Option 3，并配了 [tailscale-dev/upsnap-docker-example](https://github.com/tailscale-dev/upsnap-docker-example)）。注意 Docker 需要 `network_mode: host` 才能摸到宿主机物理 LAN 口（官方明确指出）。
  - 或走本报告的隧道方案（把 UpSnap 端口用 cloudflared 暴露出去）。
- **关键认知纠正**：**Tailscale/ZeroTier 自己不能发 WOL 广播**。它们只是让你从外网「登进」LAN 内那台常开机器，由那台机器发广播。官方博客整篇就是在讲这件事。
- 社区同类做法：[Sage73/android-wol-guide](https://github.com/Sage73/android-wol-guide)（用闲置 Android 手机 + Termux + Tailscale 做 WOL 中继）。

**路径 2：组网 VPN + 子网路由 + 代理发广播**

- 与路径 1 本质相同：VPN（L3）把你带进 LAN，但**魔术包仍需 LAN 内某个 L2 端点发出**。
- 真实条件：Tailscale 需开 [subnet router](https://tailscale.com/kb/1019/subnets) 才能访问 LAN 网段（但**这不会让 tailnet 具备发 L2 广播的能力**，官方已明确）。

**路径 3：带外手段（不依赖被唤醒主机与网卡 WOL）**

- 智能插座 + 主板 BIOS 的「**Restore on AC Power Loss / 来电自启**」组合：远程切断再恢复供电即可开机。
  - → 这是**常见做法**，但本次**未取得官方文档来源** → 标为**未验证**。
- 企业级：主板 BMC / IPMI / vPro AMT 带外管理（**未验证**具体机型支持）。
- 网卡侧替代：**WoWLAN**（WiFi 网卡的 WOL）——部分笔记本支持，但通常仅在**睡眠**状态下有效（**未验证**）。

### 4.3 S5（完全关机）下网卡是否保持供电（PME）——**决定性问题**

这是本次调研最重要的官方结论，来自 Microsoft 官方支持文档 [Wake on LAN (WOL) behavior in Windows 10](https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/wake-on-lan-feature)（原 KB 2776718，**Last updated 2026-02-12**，适用于 Windows 10 1903 / 1809 / Windows 7 SP1）：

- **Windows 7**：默认关机 = 经典关机状态 **S5**，所有设备进入最低功耗状态 **D3**。**WOL from S5 isn't officially supported**。但原文补充：「some network adapters **can be left armed** for waking if enough residual power is available. So waking from S5 is possible on some systems **if enough residual power is supplied to the network adapter**, even though the system is in the S5 state and devices are in D3.」
- **Windows 10（同样适用于 Windows 11 的默认行为）**：默认关机 = **hybrid shutdown（Fast Startup）= S4**，所有设备进入 **D3**。原文：
  > 「In this scenario, **WOL from S4 or S5 is unsupported**. Network adapters are **explicitly not armed** for WOL in these cases, because users expect zero power consumption and battery drain in the shutdown state.」
  - 「So WOL is supported only from **sleep (S3)**, or when the user **explicitly requests to enter hibernate (S4)** state.」
  - 「Although the target system power state is the same between hybrid shutdown and hibernates (S4), **Windows will only explicitly disable WOL when it's a hybrid shutdown transition**, and not during a hibernate transition.」
- **官方留的唯一缝隙**（原文注释）：
  > 「the firmware and hardware on some systems may support arming Network Interface Cards (NIC) for wake from S4 or S5, **even though Windows isn't involved in the process**.」
- 官方给的关闭方法：控制面板 → 电源选项 → **选择电源按钮的功能** → 取消勾选「**启用快速启动（推荐）**」→ 保存。（文档同时注明「We don't recommend that you disable the hybrid shutdown (S4) state.」）

**BIOS/固件要求**：需要在固件里启用「**Wake on Magic Packet**」/「**Power On By PCI-E**」（具体名称随厂商而变；本次**未取得统一官方来源**，属业界通行设置项 → 标为**社区/厂商经验**）。物理前提是**网卡在 S5 仍获得待机供电（PME）**，即主板 + 电源 + 网卡三方都支持并在固件中开启。

### 4.4 Modern Standby（S0ix）情形

- **官方**：Microsoft [Wake On LAN for Surface devices](https://learn.microsoft.com/en-us/surface/wake-on-lan-for-surface-devices)（**Last updated 2026-07-14**，适用于 Windows 10/11）原文：
  - 「Surface devices are capable of Wake On LAN (WOL) from **Modern Standby** (also known as Connected Standby).」
  - 「To support WOL, Surface devices must be **plugged into AC power** and use a **Surface Ethernet adapter or docking device that is connected to a wired network**.」
  - 「WOL works **by default** for Surface devices in Modern Standby mode running Windows 10 version 1607 or later. **No other IT configuration is required**」（Surface Studio 2 除外）。
  - 另有专门小节：「**To wake from hibernation (S4) or shutdown (S5)**」——指引到特定扩展坞（Surface Dock 2 / Surface Thunderbolt 4 Dock）的专门文档。→ 说明 **S4/S5 唤醒是硬件相关的例外**，不是普适能力。
  - 唤醒原理（同页，可直接引用）：「a wake request (**magic packet**) that contains the **MAC address** of the target device. The destination NIC compares the MAC address with its own before waking up the device. If the MAC address **doesn't match**, the NIC won't wake up the device.」
- 更底层参考：[Modern standby wake sources](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby-wake-sources)（文档中引用，本次**未抓取正文**）。

### 4.5 本机实测证据（2026-10-13）

| 检查 | 命令 | 实测结果 | 含义 |
|---|---|---|---|
| 已 arm 的唤醒源 | `powercfg /devicequery wake_armed` | `HID-compliant mouse`、**`Realtek PCIe GbE Family Controller`** | 有线网卡**当前已被 arm 为唤醒源** → 硬件/固件层面具备 WOL 能力 |
| 可配置为唤醒源的设备 | `powercfg /devicequery wake_programmable` | 列出 **Realtek PCIe GbE Family Controller**（另有 HID 鼠标/触摸板等） | 该网卡**可被配置**为唤醒源 |
| 可用睡眠状态 | `powercfg /a` | **仅**：待机（**S0 低电量待机**）连接的网络、休眠、快速启动。**S1/S2/S3/混合睡眠均不可用**（「系统固件不支持」；S3 因支持 S0 低电量待机而被禁用） | 这是 **Modern Standby (S0ix) 机型**，**没有经典 S3** → 官方关于「WOL 仅支持从 sleep (S3)」的表述在本机**不能直接套用**，需按 S0ix 路径判断 |
| 快速启动是否开启 | `(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power').HiberbootEnabled` | **1** | **快速启动已启用** → 默认「关机」走 **hybrid shutdown (S4)**，按官方文档 **WOL 不受支持** |
| 网卡电源管理细节 | `Get-NetAdapterPowerManagement` | **拒绝访问**（`Get-NetAdapter` 报 `0x80041003` PermissionDenied） | 本会话受限，需在**普通（非沙箱）管理员** PowerShell 里查 |
| Node 能否发 UDP 广播魔术包 | 见第 8 节命令（用全零伪 MAC，无害） | **成功**，`send to 255.255.255.255:9 -> OK, bytes=102` | Node 侧实现无障碍（102 字节 = 6×0xFF + 16×6 字节 MAC，符合魔术包格式） |

**综合判断（本机）**：
- ✅ **从休眠（用户显式 hibernate，S4）唤醒** → 官方支持路径（需网卡 arm，本机网卡已 arm）。
- ⚠️ **从 Modern Standby（S0ix）唤醒** → Surface 官方文档证明 S0ix 机型可支持，但**本机是 ThinkPad + Realtek**，不在该官方硬件清单内 → **必须实机验证**。
- ❌ **从「快速启动关机」唤醒** → 官方明确**不受支持**（NIC 被显式不 arm）。除非关闭快速启动并依赖「固件/硬件自行 arm」这条官方承认的例外 → **未验证**。
- ❌ **完全断电（拔电/断电后）** → 任何 WOL 都无效，只能靠路径 3 的带外手段。

### 4.6 「云端下发 WOL 唤醒包」的开源实现

- **`kaonis/woly-server`**：本报告 3.3 节已核实的元数据（Apache-2.0，created 2026-02-08，pushed 2026-10-05，描述 = 「node agent + C&C backend + shared protocol」，含 `docker-compose.yml`）**支持**存在「云端下发 + LAN 内 agent 发包」这一架构模式。README 正文**未验证**，成熟度低（2 stars / 47 open issues）。
- **`seriousm4x/UpSnap`**：自托管 WOL Web 面板，被 Tailscale 官方博客推荐——是**路径 1** 的现成实现（浏览器仪表盘发 WOL，支持关机操作）。
- **`wakeonlan` 类工具**：`etherwake`（官方博客示例）等，纯发包工具，需自己解决「谁来跑它」的问题。
- **`tailscale-dev/upsnap-docker-example`**：Tailscale 官方团队提供的 UpSnap + Tailscale sidecar 组合示例。

---

## 5. Windows 远程关机/重启（从本机 Node 进程安全关机）

### 5.1 官方命令与参数（[shutdown | Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)，**Last updated 2025-05-02**）

适用：Windows Server 2025/2022/2019/2016、**Windows 11、Windows 10**、Azure Local 2311.2+。

| 参数 | 官方语义（要点摘录） |
|---|---|
| `/s` | 关闭计算机 |
| `/r` | 关机后重启 |
| `/g` | 完全关机并重启；重启后若启用 ARSO 会自动登录并锁屏，再重启已注册应用 |
| `/sg` | 同上，但先关机 |
| **`/a`** | **中止挂起的系统关机**。官方强调：「This must be run as a **separate command in a new command prompt window** during the time-out period (for example, `shutdown /a`).」可与 `/fw` 组合以清除挂起的固件启动 |
| `/p` | **只对本地**计算机立即断电，**无超时无警告**；只能与 `/d` 或 `/f` 同用；若机器不支持 power-off，则表现为关机但**电源保持通着** |
| `/h` | 进入休眠（需已启用休眠）；可与 `/f` 同用 |
| `/hybrid` | 关机并**为快速启动做准备**；必须与 `/s` 同用 |
| `/fw` | 与关机选项组合后，下次重启进入固件界面 |
| `/f` | **强制关闭应用而不警告用户**；官方警告「might result in loss of unsaved data」 |
| `/m \\<computername>` | 指定目标计算机 |
| **`/t <xxx>`** | 关机前超时秒数。**有效范围 0–315360000（10 年），默认 30**。官方注：「**If the timeout period is greater than 0, the `/f` parameter is implied.**」 |
| `/d [p\|u:]xx:yy` | 记录重启/关机原因（p=计划，u=用户自定义，xx 主因 <256，yy 次因 <65536） |
| `/c "<comment>"` | 自定义原因注释，**最多 512 字符**，需双引号 |
| `/e` | 在关机事件跟踪器里记录意外关机原因 |
| `/i` | 显示远程关机对话框（必须是第一个参数，其余参数被忽略） |

**权限要求（官方 Remarks 原文）**：
> 「Users must be assigned the **Shut down the system** user right to shut down a local or remotely administered computer that is using the **shutdown** command.」
> 「Users must be members of the **Administrators** group to annotate an unexpected shutdown...」

（「Shut down the system」即 **`SeShutdownPrivilege`**。）

**官方示例（可直接抄）**：

```
shutdown /r /t 60 /c "Reconfiguring myapp.exe" /f /d p:4:1
shutdown.exe /s /t 600 /d p:0:0 /e /c "Scheduled maintenance"
shutdown /a                                  # 取消（必须新开窗口，在超时窗口内）
```

### 5.2 陷阱一：后台/非交互会话可能缺少 `SeShutdownPrivilege`（**最关键**）

微软官方存档博客 [Workaround for Shutdown.exe LUA bug](https://learn.microsoft.com/en-us/archive/blogs/aaron_margosis/workaround-for-shutdown-exe-lua-bug)（Aaron Margosis，**Last updated 2006-01-27** → **历史文档，针对 Windows XP 时代**，需在真机复核）原文：

> 「when something other than "logoff" is specified, Shutdown.exe tries to enable **both** the `SeShutdownPrivilege` ("Shut down the system") **and** the `SeRemoteShutdownPrivilege` ("Force shutdown from a remote system"), **even if local shutdown or reboot is all that is being requested**. On XP, Users have `SeShutdownPrivilege` by default, but they don't have `SeRemoteShutdownPrivilege`.」
> 官方 workaround：给 **`INTERACTIVE`** 授予 `SeRemoteShutdownPrivilege`（本地安全设置 → 安全设置 → 本地策略 → 用户权限分配 → 「从远程系统强制关机」→ 添加 `INTERACTIVE`）。作者补充安全性依据：「The "INTERACTIVE" SID appears in the user's token **only in the interactive logon session**. Remotely invoked code does not have INTERACTIVE in its token.」

**对后台 Node 进程的直接含义**（作者在评论区明确回答）：
> 「A program started from the task scheduler with **no one logged on** will (I'm quite sure) **not have INTERACTIVE in its token**. You could try granting the privilege to the user account... You might also try granting the privilege to "**BATCH**" instead of "INTERACTIVE"... If that doesn't work, "**SERVICE**" might.」

→ 即：**服务 / 计划任务 / WinRM / SSH 等非交互会话的 token 里没有 `INTERACTIVE`**。若 `shutdown.exe` 在该上下文里坚持同时启用两个特权，就会失败。失败表现（社区普遍报告，见下）：
- 错误 **5**（拒绝访问 / Access is denied）
- 错误 **1314**（「A required privilege is not held by the client」/「客户端不持有必需的权限」）

**本机实测（本会话）**：

| 检查 | 命令 | 结果 |
|---|---|---|
| 令牌特权列表 | `whoami /priv` | **只列出 `SeChangeNotifyPrivilege`**，**没有 `SeShutdownPrivilege`** |
| 是否管理员 | `WindowsPrincipal.IsInRole(Administrator)` | **False** |
| 用户 | `WindowsIdentity.GetCurrent().Name` | `<host>\<user>` |
| shutdown.exe 是否存在 | `Get-Command shutdown.exe` | `C:\WINDOWS\system32\shutdown.exe` |

> ⚠️ **重要限定**：本会话运行在 DSH 的文件沙箱里，该 token 状态**不一定**等同于插件在用户桌面会话中真实的 token。**必须在插件真实运行上下文里复测**（命令见第 8 节 4 组）。
>
> 但如果复测结果相同（无 `SeShutdownPrivilege`），则**插件直接调用 `shutdown` 一定会失败**，必须走「申请权限」或「委托给一个高权助手」。

### 5.3 陷阱二：SSH/会话隔离下的 shutdown

- `/a` 的官方要求本身就制造了一个结构性难题：**必须在超时窗口内、用一个新的独立进程执行**。如果发起关机的进程同时负责取消，它必须在关机倒数期间持续存活（不会被自己的关机逻辑带走）。
- 通过 SSH / 远程会话调用 `shutdown` 的额外风险：
  1. 即使成功，**关机本身会切断你正在使用的会话**，因此调用方**看不到返回码**——不能靠同步返回判断成败，必须由**对端（手机）在断线后或重连后确认**。
  2. 非交互会话可能缺特权（见 5.2）。
  3. 远程关机（`/m`）还叠加网络与管理权限问题：社区长期报告错误 5；StackOverflow 讨论指向 `LocalAccountTokenFilterPolicy` 等 UAC 远程限制（[SO: Windows 7 remote shutdown Access denied(5)](https://stackoverflow.com/posts/16526680/revisions)）。历史经验还包括 XP Home 的「简单文件共享」导致远程连接以 Guest 认证而无法管理（见上述 Margosis 博文评论区）。**本地关机场景一般不需要 `/m`**。
- 结论：**不要设计成「发完 shutdown 等它返回成功」**，而要设计成「**发出计划 → 手机端轮询/重连确认 → 提供取消窗口**」。

### 5.4 推荐的安全关机做法

1. **永远带延迟窗口，不要用 `/p`**：
   ```
   shutdown /s /t 60 /c "Remote request from mobile app" /d p:0:0
   ```
   `/p` 是「无超时无警告」，一旦误触无法取消；`/s /t N` 才有取消窗口。
2. **注意 `/t > 0` 隐含 `/f`**（官方明说）→ 意味着到点会**强杀应用**。若要避免丢数据，要么接受这一点，要么在应用层先优雅停服再关机。
3. **取消用 `/a`，且必须是独立进程**：
   ```
   shutdown /a
   ```
   官方要求「new command prompt window」+ 超时窗口内。插件应把「取消」实现为**独立子进程调用**，不要复用被关机逻辑占用的进程。
4. **自己维护 pending 状态机**：Windows 没有稳定的「查询是否已有挂起关机」CLI（**未验证**）。所以插件应自行记录 `{planned, deadline, reason}`，并据此在 UI 上显示倒计时与取消按钮。
5. **双重确认**：关机是高危操作，至少要求「手机端二次确认」+「可选 PIN/密码」；重启与关机分开确认文案。
6. **权限获取路径**（若复测确认缺特权）：
   - 用管理员把运行账户加入「**关闭系统**」用户权限（`secpol.msc` → 本地策略 → 用户权限分配 → 关闭系统）；
   - 若插件以**服务/计划任务**身份运行，按历史文档考虑 `SeRemoteShutdownPrivilege` 的归属对象应为 **BATCH** 或 **SERVICE** 而非 `INTERACTIVE`；
   - 或设计成「插件发出请求 → 由用户桌面会话里的小助手进程执行」。
7. **不要用 `/f`**，除非用户明确要求强制关闭。
8. **重启优先用 `/r`**；若要「完全重启」用 `/g`（注意其 ARSO 自动登录语义）。

---

## 6. 安全基线（监听/隧道暴露的 Node HTTP+WebSocket 服务）

### 6.1 绑定位置：默认只绑 `127.0.0.1`

- **chroxy 的官方设计**就是「服务器只在本机，靠 Cloudflare Tunnel 暴露」（[Architecture](https://www.blamechris.com/chroxy-docs/architecture)）——本机端口不对公网开放。
- **Cloudflare 官方也推荐把 origin 锁死**。[Tunnels FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) 原文（How can origin servers be secured when using Tunnel?）：Tunnel 能暴露位于 NAT/防火墙后的应用，因此「you can keep your web server **otherwise completely locked down**」，并给出自检方法：
  ```
  netcat -zv [your-server's-ip-address] 80
  netcat -zv [your-server's-ip-address] 443
  # 期望看到: [ip-address] 443 (https): Connection refused
  ```
- **取舍**：
  - **只绑 127.0.0.1 + 隧道** → 攻击面 = 隧道域名；需要隧道可用；**推荐作为默认**。
  - **直接监听 0.0.0.0** → 公网直听会被全网扫描（本项目端口一旦暴露，几小时内必有攻击流量），且失去「隧道可随时关闭」的开关能力。**仅适用于**已组网（Tailscale/ZeroTier）或明确只在 LAN 内使用的场景。
  - 折中：**同时支持**，但默认必须安全（只绑回环），0.0.0.0 需要用户显式开启 + 明确告警。

### 6.2 TLS 终结位置

- **隧道模式**：TLS 在 **Cloudflare 边缘**终结；本机 ↔ 边缘是 cloudflared 主动发起的出站隧道。因此**本机不需要证书**（零证书运维）。**代价**：若不叠加应用层加密，**边缘/传输层可见明文**。
- **chroxy 明确把 Cloudflare Tunnel 标为 `Untrusted (Transport)`** 并因此在其上再加一层 X25519 + secretbox（见 3.2）——这是把这个取舍处理正确的方式。
- **自建中继模式**：TLS 需在**中继/自建服务器**上终结（Happy 自建文档给的是 Caddy 自动证书 + `reverse_proxy localhost:3005`）。
- **推荐结论**：**把端到端加密做在应用层**，不依赖传输层。这样无论走隧道、公共中继还是自建中继，明文的暴露边界都只在两端设备。

### 6.3 令牌与鉴权

| 项目 | 建议 | 依据 |
|---|---|---|
| 令牌长度 | **`crypto.randomBytes(32)`（256 bit）** | **本机实测**：Node v24.21.0 下 `randomBytes(32)` 返回 64 个 hex 字符（32 字节）；chroxy 的 session token / hook secret 均为 **32 随机字节** |
| 常量时间比较 | **`crypto.timingSafeEqual(a, b)`** | **本机实测**：等长且相同 → `true`；**长度不同会抛 `RangeError`，`code = ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`** |
| 比较的正确写法 | 先校验长度（长度不是秘密），或**双方各自做 HMAC-SHA256 后比较等长的 32 字节摘要** | 由上述抛错行为推得；避免「长度不同直接抛异常」变成拒绝服务/信息泄漏 |
| 配对 | **一次性、短 TTL、单次使用**的 pairingId；QR 展示 | chroxy：**60s single-use TTL**；换取 **32 字节 session token（24h TTL，内存中）** |
| 令牌分级 | 操作员级 / 会话级 / 单会话钩子密钥三档 | chroxy 的三类令牌表（primary = 等价本地访问，session = 绑定单会话，hook = 单会话） |
| 令牌存储 | 服务端优先 OS keychain，回退受限权限文件；手机端用安全存储 | chroxy：keychain 优先，回退 `~/.chroxy/config.json`；手机端 `expo-secure-store` |
| 认证失败 | 限速/失败计数/可选封禁 | Happy 自建文档建议 fail2ban 防暴力破解 |
| 主凭据 | **绝不上网**（只在本地生成、只在配对时用一次性凭据换取） | chroxy：primary token 从不上网 |

### 6.4 速率限制与资源限制

- **隧道层**：Quick Tunnel 自身有 **200 in-flight 请求上限**，超出返回 **429**（官方）。**但这不能防暴力破解**——它只在并发超过 200 时才触发。
- **必须在应用层自建限速**：
  - 每 IP / 每 token 的**认证尝试**次数与退避（防 token 爆破）；
  - 每设备的**高危命令**速率（关机/重启/开机请求必须有冷却时间与去重）；
  - **请求体大小上限**、**连接数上限**、**单连接消息速率上限**。
- WebSocket 层：**ping/pong 保活 + 空闲超时**（配合 quick tunnel 单连接易断的现实）。
- 隧道创建频率：**社区实测同 IP 约 20 次/30 分钟会被限流 25+ 分钟**（osmosis 注释）→ 插件**不要**在崩溃循环里疯狂重启隧道，必须做**指数退避**。

### 6.5 日志与密钥卫生

- **绝不能进日志**：token、配对码、会话密钥、`HANDY_MASTER_SECRET` 类主密钥、私钥、完整 Authorization 头。
- **必须有日志**：分配到的隧道 URL（这是要给用户扫码/复制的功能输出）。
- **风险提醒（官方原文）**：Quick Tunnels 文档明说「**Anyone with the URL can access your local service.**」→ **不能把 URL 当秘密**，鉴权必须在应用层。
- 可选的额外一层：Quick Tunnels 新增 `--allowed-mail` 邮件 OTP 保护（官方文档 Sep 30, 2026 版）。**但对手机 App 不可用**——官方明说「Email authentication requires an interactive browser session. It does **not support non-interactive clients**.」（该能力的发布公告见 Cloudflare 博客 [Protected Quick Tunnels](https://blog.cloudflare.com/protected-quick-tunnels/)，正文未抓取。）
- 其他加固：
  - 校验 `Host` / `Origin`，拒绝非预期来源；
  - 错误响应不回显内部细节（栈、路径、版本）；
  - 进程以最小权限运行（本机实测当前进程 `IsAdmin=False`，方向正确）；
  - 关闭不需要的 HTTP 方法；对 WebSocket 升级请求同样要求鉴权（不要只保护 HTTP 路由）。

---

## 7. 本次调研中「未验证」的清单（诚实边界）

1. `*.trycloudflare.com` 在中国大陆**三大运营商的实际可达性**——只有社区博客描述 GFW 阻断 Cloudflare 特殊 IP，**未做真机验证**。
2. Quick Tunnel 的**带宽上限、最长持续时间**——官方文档**未给出**。
3. Quick Tunnel **是否支持 WebSocket**——只有「Cloudflare Tunnel 整体支持 WebSocket」的官方声明，**没有针对 quick tunnel 的单独声明**。
4. `--allowed-mail`（Protected Quick Tunnels）的**稳定性和可用地区**——只读了官方文档的描述。
5. `woly-server` 的**协议、鉴权、agent 与后端通信细节**——README 正文抓取失败（`raw.githubusercontent.com`/`jsdelivr`/`r.jina.ai` 在本环境被阻断）。
6. `pinggy` 的**免费额度/时长/端口限制**——未取得确切数字。
7. `frp` / `chisel` / `rathole` / `sish` / `pgrok` 的**版本、license、免费公共实例**——本次未逐个核实。
8. `localtunnel.me` 公共服务的**当前可用性与限制**——未验证（包本身 2021 年后未发布）。
9. **公网 → 路由器端口转发 → 主机单播 IP 发魔术包**能否成功——取决于网卡固件，**未验证**。
10. 本机（ThinkPad + Realtek）**从 S0ix 是否能被 WOL 唤醒**——Surface 文档证明 S0ix 机型**可以**，但本机不在该硬件清单内，需实机测试。
11. 关闭快速启动后，本机**能否从 S5 被固件层 arm 的网卡唤醒**——官方承认「部分系统 firmware/hardware 可能支持，Windows 不参与」，**未验证**。
12. **智能插座 + 来电自启**作为带外开机手段——常见做法，但**未取得权威文档来源**。
13. `shutdown` 在**现代 Windows 的非交互会话**里是否仍会同时请求两个特权（Margosis 博文是 **2006 年 XP 时代**文档）——需在目标机复测。
14. Windows 是否存在**稳定查询「pending shutdown」**的 CLI——未验证（因此建议自维护状态）。

---

## 8. 可直接执行的验证命令清单（PowerShell / Node）

> 标注了「**本会话实测**」的项，结果来自 2026-10-13 在目标机上的实际执行。标「需管理员/非沙箱」的命令在本会话被沙箱拒绝（`Get-NetAdapter` 报 `0x80041003 拒绝访问`），必须在普通管理员 PowerShell 中运行。

### 8.1 cloudflared 可用性验证

```powershell
# --- 1) 现状盘点（普通用户即可） ---
$base = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
Test-Path "$base\cloudflared\lib\cloudflared.js"        # 本会话: False  → npm 包体缺失
Test-Path "$base\cloudflared\bin\cloudflared.exe"       # 本会话: False  → 二进制缺失
where.exe cloudflared                                  # 本会话: 未找到
Test-Path "$env:TEMP\node-untun"                       # 本会话: False  → untun 无缓存
Test-Path "$env:USERPROFILE\.cloudflared\config.yml"   # 本会话: False  → 无命名隧道配置（好）

# --- 2) shim 是否真的可用（本会话: exit=1, Cannot find module） ---
& "$base\.bin\cloudflared.CMD" --version

# --- 3) 若已有二进制，直接验版本 ---
& "$env:CLOUDFLARED_BIN" --version      # 期望形如 cloudflared version 2026.10.0 (built ...)
& "$env:CLOUDFLARED_BIN" tunnel --help | Select-Object -First 20
```

```powershell
# --- 4) 手工获取 + 完整性校验（推荐：首次运行时按需下载到用户目录） ---
$dir = "$env:LOCALAPPDATA\cloudflared"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dst = "$dir\cloudflared.exe"
Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $dst
$h = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
$h
# 2026.10.0 的官方期望值（来自 GitHub Releases API 的 body）：
# 86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c
if ($h -ne '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c') { Write-Warning "哈希不匹配：要么版本已更新，要么下载被污染" }
$env:CLOUDFLARED_BIN = $dst      # ← 插件应读取这个环境变量来定位二进制
```

```powershell
# --- 5) 用 --ignore-scripts 安装 npm 包（跳过 postinstall 的下载） ---
npm i -g cloudflared --ignore-scripts
# 之后必须自行提供二进制（例如 4) 的 $env:CLOUDFLARED_BIN），否则 shim 会失败
```

### 8.2 启动 Quick Tunnel 并解析 URL

```powershell
# --- 1) 先在另一个窗口/后台起一个本地服务（只绑回环） ---
node -e "require('http').createServer((q,s)=>s.end('ok')).listen(8787,'127.0.0.1',()=>console.log('listening 127.0.0.1:8787'))"

# --- 2) 启动 Quick Tunnel ---
#     --config NUL : 防止 ~/.cloudflared/config.yml 劫持 quick tunnel（社区做法，osmosis 用 os.devnull）
#     --no-autoupdate : 防止运行中自更新
& $env:CLOUDFLARED_BIN tunnel --config NUL --url http://127.0.0.1:8787 --no-autoupdate
```

```js
// --- 3) Node 侧解析（两个正则都来自生产项目源码，建议两路都监听 stdout 与 stderr） ---
// untun 0.2.2 用法（匹配日志框线 "|  https://xxx.trycloudflare.com  |"）
const BOXED = /\|\s+(https?:\/\/\S+)/;
// osmosis 用法（只读 stderr；限定 host 且天然排除 api.trycloudflare.com）
const PLAIN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// 就绪判据（osmosis）：出现这行才算真正连通
const READY = "Registered tunnel connection";
// 已知失败信号（osmosis 收集；拿到它们要给出可读报错，而不是死在 exit code 上）
const LIMIT = ["429 Too Many Requests", "error code: 1015", "failed to unmarshal quick tunnel"];

// 关键工程约束（来自 osmosis 源码注释）：
//   · 必须在子进程整个生命周期内持续 drain stdout/stderr，否则管道写满会把 cloudflared 卡死
//   · 必须设启动超时（osmosis 用 30s），并在超时后杀进程
//   · 必须做 supervisor + 指数退避重启（quick tunnel 只有单条边缘连接，会中途死掉）
```

```powershell
# --- 4) 从公网侧确认可达（把域名换成上一步解析到的） ---
Invoke-WebRequest "https://<分配到的>.trycloudflare.com/" -Method Head -TimeoutSec 15
# 中国大陆多运营商验证（分别用移动/电信/联通的手机热点或代理测）
Test-NetConnection "<分配到的>.trycloudflare.com" -Port 443
Resolve-DnsName "<分配到的>.trycloudflare.com"
```

### 8.3 WOL 网卡能力验证

```powershell
# --- 1) 无需管理员 ---
powercfg /devicequery wake_armed
#   本会话实测: HID-compliant mouse / Realtek PCIe GbE Family Controller   ← 网卡已 arm

powercfg /devicequery wake_programmable
#   本会话实测: 含 Realtek PCIe GbE Family Controller                      ← 网卡可配置为唤醒源

powercfg /a
#   本会话实测: 仅 S0 低电量待机(Modern Standby) + 休眠 + 快速启动；S1/S2/S3/混合睡眠均不可用

(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power').HiberbootEnabled
#   本会话实测: 1   ← 快速启动已开启 ⇒ 默认“关机”= hybrid shutdown (S4)，官方不支持 WOL

powercfg /devicequery wake_from_S3_supported    # 本机无 S3，此项参考意义有限
powercfg /lastwake                              # 上次是谁唤醒的（排查用）
powercfg /waketimers                            # 有无定时唤醒器
```

```powershell
# --- 2) 需管理员 / 非沙箱（本会话被拒绝: 0x80041003） ---
Get-NetAdapter | Format-Table Name, InterfaceDescription, Status, MacAddress, LinkSpeed

# 逐网卡查电源管理（WakeOnMagicPacket 是关键开关）
Get-NetAdapter | ForEach-Object {
  Write-Host "--- $($_.Name)"
  Get-NetAdapterPowerManagement -Name $_.Name |
    Select-Object Name, WakeOnMagicPacket, WakeOnPattern, DeviceSleepOnDisconnect, SelectiveSuspend
}

# 查驱动高级属性里的 WOL 相关项（名称随厂商不同: Wake on Magic Packet / Shutdown WOL / Power On By PCI-E）
Get-NetAdapter | ForEach-Object {
  Get-NetAdapterAdvancedProperty -Name $_.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'Wake|Magic|WOL|Shutdown|Power' } |
    Select-Object Name, DisplayName, DisplayValue
}
```

```powershell
# --- 3) 关闭快速启动（WOL 前置条件；官方方法的前置判断） ---
# 官方路径: 控制面板 → 电源选项 → 选择电源按钮的功能 → 取消“启用快速启动(推荐)” → 保存
# 命令行等价（需管理员）:
powercfg /hibernate on
# 然后手工在 GUI 里取消勾选“启用快速启动”。改注册表 HiberbootEnabled=0 亦可，但官方推荐 GUI。
# 验证:
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power').HiberbootEnabled   # 期望变成 0
```

```powershell
# --- 4) 实测发广播魔术包（把 MAC 换成目标机真实网卡；⚠️ 这条会真的唤醒目标机） ---
node -e "const d=require('dgram').createSocket('udp4');d.bind(()=>{d.setBroadcast(true);const mac=Buffer.from(process.argv[1].split(':').map(x=>parseInt(x,16)));const p=Buffer.concat([Buffer.alloc(6,255),Buffer.concat(Array(16).fill(mac))]);for(const port of [9,7])d.send(p,0,p.length,port,'255.255.255.255',e=>console.log(port,e?('ERR '+e.message):'sent',p.length+'B'));setTimeout(()=>d.close(),500)})" "AA:BB:CC:DD:EE:FF"

# 子网定向广播（某些环境比 255.255.255.255 更有效；把 x 换成你的网段广播地址）
node -e "/* 同上，把 '255.255.255.255' 换成 '192.168.1.255' 或该网段的定向广播地址 */"
```

```powershell
# --- 5) 唯一可信的端到端验证流程（关机后能否唤醒） ---
#  a. 记下目标机 MAC 与其所在网段的广播地址
#  b. 在 BIOS 里开启 Wake on Magic Packet / Power On By PCI-E，并关闭 Windows 快速启动
#  c. 第一次对照实验：shutdown /s /t 0  (快速启动仍开启) → 30s 后发魔术包 → 大概率不醒（符合官方结论）
#  d. 第二次实验：关闭快速启动后 shutdown /s /t 0 → 30s 后发魔术包 → 看是否上电（固件层 arm 的例外路径）
#  e. 第三次实验：shutdown /h（休眠 S4）→ 30s 后发魔术包 → 官方支持路径，应当成功
#  f. 第四次实验：让机器进 Modern Standby（合盖/开始菜单睡眠）→ 发魔术包 → 验证 S0ix 是否支持
#  → 只有 (c)(d)(e)(f) 全部实测过，才能对用户承诺“远程开机能做到哪一步”
```

### 8.4 shutdown 权限验证

```powershell
# --- 1) 权限现状（普通用户） ---
whoami /priv | Select-String -Pattern 'Shutdown'
#   本会话实测: 无任何 Shutdown 特权（只有 SeChangeNotifyPrivilege）

whoami /groups | Select-String -Pattern 'Administrators|管理员'
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
#   本会话实测: False

(Get-Command shutdown.exe).Source        # 本会话实测: C:\WINDOWS\system32\shutdown.exe
shutdown /? | Select-Object -First 8     # 确认 /t 范围 0-315360000、默认 30
```

```powershell
# --- 2) 干跑测试：只测试“能否计划”，随后立即取消（无破坏性，但请确认无其他关机计划） ---
shutdown /s /t 120 /c "DSH shutdown privilege probe" /d p:0:0
# 期望: 弹出/记录“将在 120 秒后关闭”。若报 5 或 1314 → 权限不足，见下面 3)
Start-Sleep -Seconds 2
shutdown /a
# 期望: “计划的关闭已取消。”
```

```powershell
# --- 3) 权限不足时的修复（需管理员） ---
secpol.msc
#   本地策略 → 用户权限分配 → “关闭系统” → 添加运行插件的账户
#   若插件以服务/计划任务身份运行：
#     历史文档建议把 SeRemoteShutdownPrivilege（“从远程系统强制关机”）授给 BATCH 或 SERVICE，
#     而不是 INTERACTIVE（因为非交互会话 token 里没有 INTERACTIVE）
#   也可用 ntrights / secedit 脚本化：
#   secedit /export /cfg "$env:TEMP\sec.inf"   →  编辑 SeShutdownPrivilege 行  →  secedit /configure /db secedit.sdb /cfg "$env:TEMP\sec.inf"

# --- 4) 在插件的真实运行上下文里复测（最重要！） ---
#   如果是服务/计划任务/WinRM/SSH，请在该上下文里跑 whoami /priv 和 2) 的干跑
#   本会话观察到的“只有 SeChangeNotifyPrivilege”可能是沙箱产物，不能直接外推
```

### 8.5 安全基线自检

```powershell
# --- 1) 密码学原语可用性（本会话已实测） ---
node -e "const c=require('crypto');console.log('node',process.version);console.log('randomBytes(32) ->',c.randomBytes(32).toString('hex').length,'hex chars');try{c.timingSafeEqual(Buffer.alloc(1),Buffer.alloc(2))}catch(e){console.log('len mismatch ->',e.name,e.code)}"
#   本会话输出: node v24.21.0 / randomBytes(32) -> 64 hex chars / len mismatch -> RangeError ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
```

```powershell
# --- 2) 确认只监听回环（而不是 0.0.0.0） ---
netstat -ano | Select-String ':8787'
#   期望: TCP 127.0.0.1:8787 ... LISTENING
#   若看到 0.0.0.0:8787 或 [::]:8787 → 已暴露到局域网/公网，需改绑

Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, State, OwningProcess

# --- 3) 从另一台机器确认 origin 未对局域网开放（Cloudflare 官方建议的自检思路） ---
Test-NetConnection 192.168.x.x -Port 8787      # 期望 TcpTestSucceeded : False
```

```powershell
# --- 4) 日志卫生自检：确认你的日志里没有敏感串 ---
Select-String -Path "$env:LOCALAPPDATA\<your-plugin>\logs\*.log" -Pattern 'token|secret|pairingId|Authorization|Bearer' -SimpleMatch
#   期望: 无匹配（或仅匹配到“已脱敏”的占位符）
```

---

## 9. 关键事实速查表

| 问题 | 结论 | 性质 |
|---|---|---|
| Quick Tunnel 2026 是否仍免账号可用 | **是**，官方文档 Last updated **2026-09-30** | 官方 |
| 域名形态 | `https://<随机>.trycloudflare.com` | 官方 |
| Quick Tunnel 并发上限 | **200 in-flight 请求**，超出 **429** | 官方 |
| Quick Tunnel 支持 SSE | **不支持** | 官方 |
| Quick Tunnel 支持 WebSocket | **Cloudflare Tunnel 整体支持**；quick tunnel 未单独声明 | 官方（整体）/ 未验证（具体） |
| Quick Tunnel 带宽/时长上限 | **官方未给出** | 未验证 |
| Quick Tunnel 创建频率限制 | 同 IP **~20 次/30 分钟**触发限流 **25+ 分钟** | 社区实测 |
| Quick Tunnel 稳定性 | **单条边缘连接**，会中途死亡，需 supervisor | 社区（源码注释） |
| 中国大陆可达性 | Cloudflare 特殊 IP 被定向阻断，**移动最严重** | 社区 |
| cloudflared 最新版 | **2026.10.0**（2026-10-05），Windows x64 exe **52.8 MB** | 官方 |
| npm `cloudflared` 最新版 | **0.7.3**（2026-08-10），MIT，**需 postinstall 下载二进制** | 官方（registry） |
| npm `cloudflared` 能否跳过下载 | **能**：`CLOUDFLARED_BIN` 环境变量覆盖二进制路径 | 官方源码 |
| `untun` 最新版 | **0.2.2**，MIT，**仍需下载二进制**（固定 **2026.7.2**），需接受条款 | 官方（registry+源码） |
| `localtunnel` 最新版 | **2.0.2**（2021-09-18 后未再发布），MIT，**纯 JS 无二进制** | 官方（registry） |
| `@aidenlx/cloudflared` | **npm 404 Not Found** | 官方（registry） |
| WOL 从 S5（Windows 7 语义） | 官方不支持；部分网卡靠残余供电可 armed | **官方** |
| WOL 从 S4/S5（Windows 10/11 默认关机） | **官方明确不支持**，NIC 被**显式不 arm** | **官方（最关键）** |
| WOL 从 hibernation (S4) | **支持**（Windows 只在 hybrid shutdown 时禁用 WOL） | **官方** |
| WOL 从 Modern Standby (S0ix) | **可支持**（Surface 官方：AC 供电 + 有线以太网） | 官方（限 Surface 硬件清单） |
| 关闭快速启动的方法 | 控制面板 → 电源选项 → 选择电源按钮的功能 → 取消勾选 | 官方 |
| Tailscale/ZeroTier 能否自己发 WOL 广播 | **不能**（L3 vs L2），只能协助你登进 LAN 内代理 | 官方（Tailscale 博客 2025-08-19） |
| 公网直接发魔术包 | 需 **IP directed broadcast**（企业网络特性），家用路由器多数不支持 | 官方（Cisco 文档）+ 未验证（家用） |
| shutdown `/t` 范围 | **0–315360000**，默认 **30**；**>0 时隐含 `/f`** | 官方 |
| shutdown `/a` 的要求 | **超时窗口内 + 新的独立命令窗口** | 官方 |
| shutdown 权限 | 需 **"Shut down the system"**（`SeShutdownPrivilege`） | 官方 |
| 非交互会话的 shutdown 风险 | token 无 `INTERACTIVE` → 可能缺特权（错误 5 / 1314）；建议授 BATCH/SERVICE | 官方（2006 历史文档）+ 本机实测无特权 |
| 本机（目标机）现状 | cloudflared **不可用**（悬空 shim）；S0ix-only **无 S3**；**快速启动开启**；有线网卡**已 wake_armed**；进程**非管理员且无 SeShutdownPrivilege** | **本机实测** |
| Happy Coder 加密 | master secret(32B) → HMAC-SHA512 → content keypair → AES-256 session/machine DEK；中继盲转发 | 官方文档 |
| chroxy 加密 | 预共享 token 认证 → 临时 X25519 → HSalsa20 → XSalsa20-Poly1305；60s 单次配对；三类令牌 | 官方文档 |
| woly-server | Apache-2.0，2026-02-08 创建，2026-10-05 推送，2 stars，C&C 后端 + node agent | 官方（GitHub API）；README 细节未验证 |

---

## 10. 明确推荐

### (a) 电脑端暴露服务的最佳默认方案

**默认 = 只绑 `127.0.0.1` + cloudflared Quick Tunnel（自管二进制）**，具体做法：

1. **默认只监听 `127.0.0.1`**（与 chroxy、untun、osmosis 一致；Cloudflare 官方也建议锁死 origin）。`0.0.0.0` 作为需要用户显式开启并告警的高级选项。
2. **不要把 `cloudflared` npm 包放进依赖链靠 postinstall 下载**。理由（本机实测 + 官方源码）：
   - 本机已经出现**悬空 shim** → 依赖它的插件会直接崩；
   - postinstall 会去 **GitHub Releases 拉 52.8 MB**，在中国大陆/受限 CI 环境极易失败；
   - `postinstall` 在很多托管环境里被 `--ignore-scripts` 禁用。
3. **改用「首次运行时按需获取 + 校验 + 缓存 + 环境变量注入」**：
   - 检测顺序：`CLOUDFLARED_BIN` → 用户配置路径 → `%LOCALAPPDATA%\cloudflared\cloudflared.exe` → PATH；
   - 缺失时用 `Invoke-WebRequest`/`https` 下载并用**官方 SHA256 校验**（本节 8.1 命令 4），版本号写进缓存文件名以便升级；
   - 下载源**默认 GitHub Releases，但允许用户配置镜像**（`RELEASE_BASE` 级别的可配置项）；
   - **不要让下载失败阻断插件启动** —— 降级到「仅局域网/仅本机可用」并给出清晰提示。
4. **隧道启动的必备细节**（全部来自实际源码/官方文档）：
   - `--config NUL`（防止命名隧道配置劫持 quick tunnel）；
   - `--no-autoupdate`；
   - URL 解析**两套正则都试**并**同时监听 stdout+stderr**：`/\|\s+(https?:\/\/\S+)/` 与 `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`；
   - **持续 drain 管道**（否则会把 cloudflared 卡死）；
   - 30s 启动超时 + `Registered tunnel connection` 二次判据；
   - supervisor + **指数退避**重启（应对单连接中断与「~20 次/30 分钟」的创建限流）；
   - 识别并翻译失败信号：`429 Too Many Requests` / `error code: 1015` / `failed to unmarshal quick tunnel`。
5. **应用层安全不外包给传输层**：32 字节随机 token + `timingSafeEqual`（**先比长度或先做 HMAC 摘要**，避免 `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`）+ 60s 单次配对 + 操作员/会话/钩子三档令牌 + 应用层限速 + 日志脱敏。条件允许时叠加 chroxy 式的 **临时 X25519 + XSalsa20-Poly1305** 端到端加密。
6. **可选降级路径**：`localtunnel`（**纯 JS、无二进制**，最符合「不依赖 postinstall」），但必须明确告知用户它依赖第三方公共服务 `localtunnel.me` 且 2021 年后未更新 → **仅作为手动备选，不做默认**。

**不建议**把 `untun` 当默认：它同样要下载 52 MB 二进制，还把版本钉在 **2026.7.2**，并且**要求接受 Cloudflare 条款**（不设环境变量就静默跳过）——比 `cloudflared` 更难做到「开箱即用」。

### (b) 是否值得内置出站中继模式

**值得内置，但必须定位为「可选高级模式」，且默认关闭。**

- **不该当默认**的原因：出站中继的完整参考实现（Happy）需要**一台有公网 IP 的服务器**（Docker + 端口 **3005** + `HANDY_MASTER_SECRET`），这与「尽量不让用户自备服务器」的核心目标正面冲突。Happy 官方给出的「服务器约 12,000 行 TypeScript」也说明这不是一个小功能。
- **值得内置**的原因（都是本次调研确认的 Quick Tunnel 硬伤）：
  1. **主机名每次变**（官方）→ 用户每次都要重新配对/扫码；
  2. **无 uptime 保证**（官方）+ **单边缘连接易断**（社区源码注释）；
  3. **创建有速率限制**（社区实测 ~20 次/30 分钟）；
  4. **部分地区不可达**（中国大陆社区证据）；
  5. **Quick Tunnel 不支持 SSE**（官方）→ 若将来要做服务端推送，会受限。
- **落地建议**：
  - 定义一个 **`tunnel provider` 抽象接口**（`start()` → `url` / `ready` / `onExit` / `stop()`），默认实现 = `cloudflared-quick`；
  - 预留 `named-tunnel`（需 CF 账号 + 域名，换来稳定域名）、`self-hosted-relay`（Happy 式盲转发 + E2E）、`localtunnel`（零二进制降级）三个可选实现；
  - **协议层现在就按「中继是可替换的、且不可信」来设计**：消息信封带 `deviceId`/`sessionId`（路由用），内容用客户端 E2E 密钥加密（这样换成自建中继时**不需要改协议**）。
  - 借鉴 chroxy 的**三类令牌**与**60s 单次配对 QR**、Happy 的**master secret → DEK 分层**——这两套已经在生产里被验证过。

### (c) 远程开机在当前约束下能做到什么程度、需要用户做什么

**最重要的结论：如果电脑处于「真正的关机」状态，电脑上的插件根本没在运行——任何基于该插件的出站中继或本地服务都不可能完成唤醒。远程开机必须依赖一个独立于被唤醒主机的第三方。**

**官方事实（决定性）**：Windows 10/11 的**默认关机是 hybrid shutdown（Fast Startup）= S4**，在这种状态下 Microsoft 官方文档明确写 **WOL from S4 or S5 is unsupported**，且 NIC 被**显式地不 arm**（因为用户期望关机零功耗）。WOL **只**在 **sleep (S3)** 或用户**显式 hibernate (S4)** 时受支持。官方留的唯一缝隙是「**部分系统的固件/硬件可能自行 arm 网卡**，即使 Windows 不参与」。

**本机实测叠加约束**：`powercfg /a` 显示**只有 S0 低电量待机（Modern Standby）**，**S1/S2/S3/混合睡眠全部不可用**；`HiberbootEnabled = 1`（快速启动开启）；有线网卡 Realtek PCIe GbE **已 wake_armed**。→ 本机**没有经典 S3**，所以「WOL 只在 S3 下支持」这条对我们要么不适用、要么需要走 S0ix 路径；而 Surface 官方文档证明 **S0ix 机型可以支持 WOL**（AC 供电 + 有线以太网），但那是 Surface 硬件清单，本机需实机验证。

**能做到的程度（分级）**：

| 场景 | 可行性 | 依据 |
|---|---|---|
| 从 **休眠（显式 hibernate, S4）** 唤醒 | ✅ **官方支持路径**（需网卡 arm；本机已 arm） | MS 官方 KB2776718 |
| 从 **Modern Standby（合盖/睡眠）** 唤醒 | ⚠️ **很可能可以，但需实机验证**（本机是 S0ix-only，非 Surface 硬件清单） | MS Surface 官方文档（同类）+ 未验证（本机） |
| 从 **快速启动关机** 唤醒 | ❌ **官方不支持**；仅剩「固件层自行 arm」的例外 → 未验证 | MS 官方 KB2776718 |
| 从 **关闭快速启动后的 S5** 唤醒 | ❓ **取决于主板/网卡固件**，未验证 | MS 官方承认存在该例外 |
| **完全断电**后开机 | ❌ WOL 无效 → 只能靠带外手段 | 常识 + 未验证（带外方案） |
| **公网直接发魔术包到路由器** | ❌ 基本不可行（需 IP directed broadcast，家用路由器多不支持） | Tailscale 官方 + Cisco 官方 |

**需要用户做什么（必须前置的 4 件事）**：

1. **BIOS/固件**：开启「**Wake on Magic Packet**」/「**Power On By PCI-E**」（名称随厂商不同），并确认网卡在 S5 仍获待机供电（PME）。
2. **Windows**：**关闭快速启动**（控制面板 → 电源选项 → 选择电源按钮的功能 → 取消勾选「启用快速启动」）。这是让「关机」不再是 hybrid shutdown 的唯一官方途径。
3. **必须在局域网里准备一台常开且有线连接的唤醒代理**（树莓派 / NAS / 软路由 / 旧笔记本，或闲置 Android + Termux）。**这是硬性要求**，因为：
   - Tailscale / ZeroTier 工作在 **L3**，官方明确说它们**不能**自己发 L2 广播（[Tailscale 官方博客](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)）；
   - 公网魔术包无法跨越子网（除非企业级 IP directed broadcast）。
   - 可直接用现成实现：[UpSnap](https://github.com/seriousm4x/UpSnap)（Tailscale 官方博客推荐）+ [tailscale-dev/upsnap-docker-example](https://github.com/tailscale-dev/upsnap-docker-example)；或自己写一个极小的 HTTP 端点（手机请求 → 代理发魔术包，Node 实现无障碍：**本机实测广播发送成功**）。
4. **（可选，用于完全断电场景）带外手段**：智能插座 + 主板「**来电自启（Restore on AC Power Loss）**」。→ 常见做法，但**未取得权威文档来源，未验证**；企业场景可用 BMC/IPMI/vPro。

**对插件的设计含义（重要）**：
- 把「远程开机」实现为「**手机 → 中继/代理 → LAN 内发魔术包**」，而**不是**假装本机能唤醒已关机的自己。手机端的「开机」按钮在电脑离线时**必然**要打到一个**不在这台电脑上**的地址。
- UI 必须清楚表达：**「远程开机需要先配置一个局域网唤醒代理」**，并提供一个「**代理配置向导**」（输入代理地址 + token + 目标 MAC），以及第 8.3 节 5) 的**端到端验证流程**引导用户逐项确认。
- 关机/重启则是**电脑在线时**的能力，走第 5 节的 `shutdown /s /t N` + 取消窗口 + 权限复测方案。

---

## 附：本文主要引用来源

**Cloudflare 官方**
- [Quick Tunnels（Last updated Sep 30, 2026）](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Tunnels FAQ（Last updated Sep 16, 2026）](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)
- [Downloads（Last updated Sep 11, 2026）](https://developers.cloudflare.com/tunnel/downloads/)
- [cloudflared Releases API（2026.10.0，2026-10-05）](https://api.github.com/repos/cloudflare/cloudflared/releases/latest)
- [Protected Quick Tunnels（Cloudflare 博客公告）](https://blog.cloudflare.com/protected-quick-tunnels/)

**Microsoft 官方**
- [Wake on LAN (WOL) behavior in Windows 10（Last updated 2026-02-12，KB2776718）](https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/wake-on-lan-feature)
- [Wake On LAN for Surface devices（Last updated 2026-07-14）](https://learn.microsoft.com/en-us/surface/wake-on-lan-for-surface-devices)
- [shutdown | Microsoft Learn（Last updated 2025-05-02）](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)
- [Workaround for Shutdown.exe LUA bug（Last updated 2006-01-27，历史文档）](https://learn.microsoft.com/en-us/archive/blogs/aaron_margosis/workaround-for-shutdown-exe-lua-bug)
- [Modern standby wake sources](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/modern-standby-wake-sources)

**Tailscale 官方**
- [Make a dedicated Wake-on-LAN server with Tailscale（August 19, 2025）](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)
- [Subnet routers](https://tailscale.com/kb/1019/subnets) · [tailscale/tailscale#306](https://github.com/tailscale/tailscale/issues/306)

**npm registry / unpkg（包元数据与源码原文）**
- [`registry.npmjs.org/cloudflared`](https://registry.npmjs.org/cloudflared) · [lib/constants.js](https://unpkg.com/cloudflared@0.7.3/lib/constants.js) · [lib/install.js](https://unpkg.com/cloudflared@0.7.3/lib/install.js) · [scripts/postinstall.mjs](https://unpkg.com/cloudflared@0.7.3/scripts/postinstall.mjs)
- [`registry.npmjs.org/untun/latest`](https://registry.npmjs.org/untun/latest) · [README](https://unpkg.com/untun@0.2.2/README.md) · [dist/index.mjs](https://unpkg.com/untun@0.2.2/dist/index.mjs) · [dist/_chunks/cloudflared.mjs](https://unpkg.com/untun@0.2.2/dist/_chunks/cloudflared.mjs)
- [`registry.npmjs.org/localtunnel/latest`](https://registry.npmjs.org/localtunnel/latest)
- `registry.npmjs.org/@aidenlx%2Fcloudflared/latest` → **404 Not Found**

**项目文档与源码（社区/项目官方）**
- [Happy Coder — Security & Encryption](https://happy.engineering/docs/security/) · [Self-Hosting](https://happy.engineering/docs/guides/self-hosting/)
- [chroxy — Architecture](https://www.blamechris.com/chroxy-docs/architecture) · [Security & Encryption](https://www.blamechris.com/chroxy-docs/security) · [GitHub API](https://api.github.com/repos/blamechris/chroxy)
- [kaonis/woly-server — GitHub API](https://api.github.com/repos/kaonis/woly-server) · [Contents API](https://api.github.com/repos/kaonis/woly-server/contents/)
- [Osmosis-AI/osmosis-sdk-python — tunnel.py](https://github.com/Osmosis-AI/osmosis-sdk-python/blob/ecbe6e73e4bd789e13f1df776c0bd22476dac5f2/osmosis_ai/eval/local/tunnel.py)
- [ekzhang/bore — GitHub API](https://api.github.com/repos/ekzhang/bore) · [openziti/zrok — GitHub API](https://api.github.com/repos/openziti/zrok)
- [seriousm4x/UpSnap](https://github.com/seriousm4x/UpSnap) · [tailscale-dev/upsnap-docker-example](https://github.com/tailscale-dev/upsnap-docker-example)

**社区经验**
- [⚠️ Cloudflare 这是在配合 GFW 吗？分配特殊 IP 遭精准阻断（2026-04-20）](https://zblog.hqyman.cn/post/19648.html)
- [cloudflared issue #1313（QUIC 隧道不稳定）](https://github.com/cloudflare/cloudflared/issues/1313) · [app-cloudflared issue #845（连接反复超时）](https://github.com/homeassistant-apps/app-cloudflared/issues/845)
- [Sage73/android-wol-guide](https://github.com/Sage73/android-wol-guide)

**Cisco 官方（IP directed broadcast）**
- [Configure SD-Access Silent Host with IP Directed Broadcast Feature](https://www.cisco.com/c/en/us/support/docs/cloud-systems-management/catalyst-center/225850-configure-sd-access-silent-host-with-ip-directed-broadcast.pdf)
- [Catalyst Layer 3 Switch for Wake-On-LAN Support Across VLANs](http://www.cisco.com/application/pdf/paws/91672/catl3-wol-vlans.pdf)
