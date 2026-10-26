# 安装与配置

## 前置条件

- 电脑上已安装 **DeepSeek Harness**（本项目在 44.0.0 / CLI 0.2.0-rc.2 上验证通过），并且已经登录过账号（这样新建的会话才有可用模型）。
- 手机与电脑处于**同一 Wi-Fi**，或两台设备都能访问互联网。
- 插件本身**不需要任何依赖、也不需要构建**：它是纯 ESM 源码，靠复制即可安装。

## 一、安装插件

```bash
# 在你的 open-whale 仓库根目录
dsh plugin --profile <你的profile> add ./packages/plugin
```

`<你的profile>` 通常是 `desktop`（桌面版）或 `web`。查看已有 profile：

```bash
ls "$DSH_HOME/profiles"      # 默认 $DSH_HOME = ~/.dsh
```

安装后**重启 DSH**。校验它进入了配置树：

```bash
dsh --profile <你的profile> --dump-config | grep -A2 openwhale
```

应该能看到：

```
# == dsh-openwhale
- id: openwhale
```

> 用 `link:` 协议安装（pnpm 对本地目录就是这么做的）时，改源码只需重启 DSH 即可生效，不需要重新 add。

## 二、配置项

配置文件位置：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（由插件自带的 `cordis.patch.yml` 提供默认值，你可以在 profile 的 patch 层覆盖）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `host` | `Open Whale 电脑` | 电脑在手机上的显示名 |
| `enabled` | `true` | 是否启用远程连接 |
| `lanEnabled` | `true` | 是否监听局域网端口 |
| `port` | `8787` | 局域网监听端口 |
| `heartbeatMs` | `25000` | 心跳间隔 |
| `voice` | `personal-assistant` | 回复语气；设为 `off` 则保持 DSH 默认的技术语气 |
| `assistantName` | `助理` | 助理的名字（会写进语气提示） |
| `cwd` | 空 | 手机对话的工作目录；留空用当前工作区 |
| `allowRemoteShutdown` | `true` | 是否允许手机远程关机/重启（取消始终可用） |
| `shutdownDelaySeconds` | `30` | 关机宽限秒数，期间可取消 |
| `autoApproveTools` | `false` | 手机会话是否自动批准所有工具调用 |
| `collaboration` | `false` | 多人协作：多台手机共用一个对话并互相可见（也可在配对页/手机端随时切换） |
| `connectionMode` | `auto` | 连接方式偏好：`auto`（Tailscale → 局域网 → 隧道）、`lan`、`tailscale`、`tunnel`；也可在配对页选择，保存在 state.json |
| `tunnelMode` | `off` | `off` 或 `quick`（cloudflared 快速隧道） |
| `cloudflaredPath` | 空 | cloudflared 可执行文件路径；留空自动探测 |

覆盖示例（追加到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的数组里）：

```yaml
- id: openwhale
  name: 'dsh-openwhale'
  config:
    host: 书房电脑
    assistantName: 小鲸
    tunnelMode: quick
```

> 注意：patch 行是**整行替换 config**，不是深合并。覆盖时必须把想保留的字段一起写上。

## 三、生成绑定二维码

三种方式任选：

| 方式 | 怎么做 |
|---|---|
| 浏览器（推荐） | 打开 `http://127.0.0.1:<DSH端口>/openwhale`。端口从 DSH 启动日志里找，例如 `dsh web: http://127.0.0.1:3080/` |
| DSH 命令 | 在任意 DSH 会话里执行 `/openwhale`，终端会打印二维码和指纹 |
| 图片 | `http://127.0.0.1:<端口>/openwhale/qr.png`（或 `qr.svg`） |

配对页会同时显示**两个二维码**：左边是手机 App 的绑定二维码，右边是**网页版（PWA）地址**的二维码——鸿蒙 / iOS / 任意浏览器用系统相机扫右边那个就能直接打开聊天界面，不需要安装 App。

端点的访问范围（v2.2.0 起）：

| 路径 | 用途 | 谁能访问 |
|---|---|---|
| `/openwhale` | 配对页：二维码、连接方式、发送到手机、已绑定设备 | 任意（远程只读） |
| `/openwhale/health` | 健康检查：版本、电脑 ID、绑定/协作状态、连接方式、分类地址 | 任意（只读） |
| `/openwhale/info` | 电脑 ID、名称、公钥指纹、分类地址、绑定状态 | 任意（只读） |
| `/openwhale/pairing.json` | 二维码里的原始载荷（含一次性密钥） | 任意（只读） |
| `/openwhale/app` | 内置网页版 / PWA 客户端 | 任意（只读静态资源） |
| `/openwhale/connection-mode` | 查看/设置连接方式（`GET` / `POST ?mode=auto\|lan\|tailscale\|tunnel`） | POST 仅本机 |
| `/openwhale/send-file` | 电脑 → 手机发文件（`POST {path, name?}`） | **仅本机** |
| `/openwhale/unbind`、`/openwhale/device-rename`、`/openwhale/collaboration` | 解绑/改名/协作开关 | **仅本机** |
| `/openwhale/qr.png`、`/openwhale/qr.svg` | 二维码图片（含一次性密钥） | **仅本机** |

> 「仅本机」= 请求必须来自这台电脑的环回地址，且不能带 `x-forwarded-for` 等代理头。这样即使公网隧道把 `/openwhale` 暴露出去，拿到隧道 URL 的人也无法解绑手机、改协作开关或读取配对密钥；在远程打开的页面上，这些控件会显示为只读并提示回本机操作。

**二维码 10 分钟有效，且只能用一次。** 重新生成会让上一个立即失效。

## 四、手机端绑定

1. 按 [mobile-build.md](mobile-build.md) 出包并安装应用。
2. 打开应用 → 「添加助理」→ 扫码。
3. 应用会：校验二维码 → 生成自己的设备密钥（私钥进系统安全存储）→ 连接二维码里的地址 → 完成绑定并保存这台电脑。
4. 之后打开应用会自动用设备密钥重连，**不需要再扫码**。想解绑：助理详情页 → 解除绑定。

## 五、网络配置

### 连接方式：Tailscale 是一等公民（v2.2.0）

配对页新增「连接方式」区块，四个选项：

| 选项 | 含义 |
|---|---|
| `auto`（默认） | 按 **上次成功 → Tailscale → 局域网 → 公网隧道** 排序，手机优先走直连 |
| `lan` | 只保留局域网地址 |
| `tailscale` | 只保留 Tailscale 地址（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`、`*.ts.net`） |
| `tunnel` | 只保留公网隧道地址 |

**Tailscale 不再算作局域网**：v2.1.0 把 tailnet 地址归进 LAN，并把 `https` 隧道强行排在最前，导致「明明在同一 tailnet 却绕公网、协作模式打不开」。v2.2.0 由协议层给每个地址分类（`epk` 单字母随二维码下发），并严格按连接方式的优先级排序。

设置会持久化到 `state.json` 的 `connectionMode`，手机端也可以改。选择某个模式但没检测到该类地址时，页面会明确提示（例如「未检测到 Tailscale 地址」）。

Tailscale 的典型用法：电脑和手机都登录同一个 tailnet，电脑直接 `http://100.x.y.z:8787` 可达；不需要开公网隧道，也不受快速隧道域名变化影响。

### 同一局域网（默认，无需额外配置）

插件会在 `0.0.0.0:8787` 上监听，二维码里带 `http://<你的局域网IP>:8787`。手机连上同一 Wi-Fi 即可。

若 Windows 防火墙弹窗，请允许该端口或该程序。

### 互联网（公网隧道）

1. 安装 cloudflared（插件**不会**自动下载）：从 Cloudflare 官方发布页取 Windows 版可执行文件，放进任意目录。
2. 配置：

```yaml
- id: openwhale
  name: 'dsh-openwhale'
  config:
    tunnelMode: quick
    cloudflaredPath: C:\tools\cloudflared.exe
```

3. 重启 DSH。日志里会出现 `公网地址：https://xxx.trycloudflare.com`，二维码里也会带上它。

**快速隧道的真实限制**（官方文档口径）：仅适合测试与开发，无可用性保证，并发有上限，**每次重启域名都会变**（手机端会自动轮换地址重连，但这时旧二维码/旧地址会失效），部分地区网络不稳定。

长期使用建议：
- **优先用 Tailscale**（配对页把连接方式设为 `tailscale` 或 `auto`）：地址稳定、延迟低，也不必把端口暴露到公网；
- 自建反向隧道，或
- 用自己的域名 + cloudflared 命名隧道。

协议本身按「中继不可信」设计：身份验证与鉴权都在应用层，换中继不需要改协议。

## 六、多设备、协作模式与网页版

### 多台手机

一台电脑最多绑 5 台手机（`state.json` 里逐台记录）。配对页可以给每台设备改名或单独移除；手机端也可以自己解绑。设备之间默认**各自独立**：每台手机一个 DSH 会话，互不可见。

### 协作模式（多台手机共用一个对话）

在配对页或手机端切换「协作模式」：开启后所有已绑定手机落到**同一个会话**，能看到彼此的提问和 AI 的回复（消息带发送者昵称），回复不会重复拼接。切换会立即生效，不需要重启插件，也不需要重连；电脑端会广播 `collab/state` / `session/state` / `session/participants`。

### 网页版 / PWA

插件内置网页版客户端（`packages/webchat`，打包后是插件包内的 `webchat/`），通过 `/openwhale/app` 提供：鸿蒙、iOS、任意浏览器用系统相机扫配对页右侧二维码即可打开，也可以「添加到主屏幕」当 PWA 用。网页版与 App 共用协议，看到的是同一批会话。

## 七、验证安装是否成功

在电脑上另开一个终端：

```bash
node scripts/verify-install.mjs http://127.0.0.1:<端口>
```

它会依次检查：健康端点（版本/连接方式/分类地址）→ 二维码载荷可被真实协议解析器解析（含 `epk`/`web`/`mode`）→ `/openwhale/app/` 能提供网页版 → WebSocket 握手 + 真实 Ed25519 绑定 → 用二维码里的公钥验证 `hello/ack` 签名 → 能力协商与 `sessionId`/`serverVersion` → 会话快照 → 同 `msgId` 重发得到 `duplicate: true` 的 ack。

全部通过即为安装成功。

### 已知限制（v2.2.0）

- **会话事件日志在内存里**：每会话保留最近 400 条持久事件、快照最近 60 条。插件重启后事件序列从头开始，手机重连会拿到**全量快照**而不是逐条补发；离线超过窗口（400 条事件）的设备同理。客户端应按 `seq`/`msgId` 去重后合并，不会重复展示。
- **快照里的助手消息按「回合」聚合**（一轮回复一条，多个 message 用空行拼接），而不是每条 assistant message 一条；实时推送仍是逐条 `chat/message`。这是冻结协议里 `session/state` 的定义。
- **同一设备允许多条并发连接**（上限 3）：手机/网页会故意并发竞速两个连接地址，服务端不会互踢；超限时淘汰最旧的一条。多标签页也适用，重复帧由客户端按 `seq`/`msgId` 去重。
- **上传的临时文件**在空闲 3 分钟后清理；完成后的文件保留在工作目录的 `.openwhale/uploads/` 里，不随插件重启删除。

## 八、排错

| 现象 | 原因与处理 |
|---|---|
| `dsh --dump-config` 里没有 openwhale | 安装到了别的 profile；确认 `--profile` 参数与你在用的 profile 一致 |
| DSH 启动日志出现 `openwhale (dsh-openwhale): failed to import` | 插件包被复制安装后仍引用了包外文件。检查是否有 `../../` 形式的导入（`packages/plugin/test/protocol-copy.test.mjs` 会守住这条） |
| 浏览器打不开 `/openwhale` | 端口不对，或 DSH 没重启；用启动日志里的实际 URL 和 token 前缀 |
| 页面提示「已达绑定上限」 | 一台电脑最多绑 5 台手机。在配对页「已绑定设备」里移除不用的设备，或手机关联详情页解绑 |
| 手机上显示「连不上 / 一直转圈」但电脑在线 | 打开配对页确认「连接方式」与检测到的地址：用 Tailscale 时确认两端登录同一 tailnet；页面会把 Tailscale / 局域网 / 隧道地址分别列出，不要把 `127.0.0.1` 当成手机可达地址 |
| 扫码后手机收到的消息里图片/附件读不到 | v2.2.0 起附件落在**会话工作目录**的 `.openwhale/uploads/`（旧版在 `$DSH_HOME/openwhale/uploads`）。确认 `cwd` 配置正确、DSH 文件沙箱允许读该目录 |
| 同一条消息 AI 回复了两次 | v2.2.0 已按 `(deviceId, msgId)` 幂等；如果仍出现，看 `openwhale.log` 里 `重复消息` 或 `投递失败` 行，并确认手机端是 2.2.0 |
| 重启后手机能连上但收不到之前的消息 | 电脑端事件日志只保留最近 400 条、快照 60 条；超出窗口会推全量快照而不是补发。长时间离线属正常 |
| 二维码扫了但提示已过期 | 10 分钟窗口过了，重新生成 |
| 手机提示连不上 | 先确认同网段、防火墙放行；再看 `/openwhale/info` 的 endpoints 是否包含手机能访问的地址（`127.0.0.1` 只能本机用） |
| 手机能连上但收不到回复 | 先看 `$DSH_HOME/openwhale/openwhale.log`。常见原因是电脑上的 DSH 账号失效，或 profile 里没有配置默认模型（手机会话需要一个可用的 provider/model；插件会依次从默认模型服务、profile 的 `agent-default-model`、活跃会话、本插件 `agentOptions` 里找） |
| 隧道地址变了 | 快速隧道的固有行为。手机端会轮换重连；若仍失败，重新生成二维码绑定，或改用组网方案 |
| 关机/重启没反应 | 确认 `allowRemoteShutdown: true`；非交互会话可能缺少关机权限，见 [remote-power.md](remote-power.md) |

## 九、数据放在哪

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/openwhale/state.json` | 电脑身份密钥、配对窗口、已绑定手机（权限 0600，原子写） |
| `$DSH_HOME/openwhale/openwhale.log` | 插件自己的日志（就绪、端口、隧道地址、配对/解绑、错误）——**排错先看这里** |
| `<会话工作目录>/.openwhale/uploads/` | 手机发来的附件落盘位置（v2.2.0 起改到这里，保证 DSH 文件沙箱读得到；会话工作目录由 `cwd` 配置决定，默认是插件进程的当前目录） |
| DSH 会话日志 | 协作模式所有手机共用一个会话；非协作模式每台手机一个，id 形如 `ow-<hash>` |

> 为什么有独立日志文件：`ctx.logger` 不一定挂载了可用的输出端，而插件在"手机连不上"时最需要能看到自身状态。所以每条插件日志都同时写到 `openwhale.log`。

删除 `state.json` 等于让电脑"失忆"：所有手机都需要重新扫码绑定。
