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

其他有用的端点：

| 路径 | 用途 |
|---|---|
| `/openwhale/health` | 健康检查：电脑 ID、是否已绑定、当前连接数 |
| `/openwhale/info` | 电脑 ID、名称、公钥指纹、可用地址、绑定状态 |
| `/openwhale/pairing.json` | 二维码里的原始载荷（含一次性密钥，仅供本机取用） |
| `/openwhale/download?token=...` | 一次性文件下载（由 `file/meta` 帧下发） |

**二维码 10 分钟有效，且只能用一次。** 重新生成会让上一个立即失效。

## 四、手机端绑定

1. 按 [mobile-build.md](mobile-build.md) 出包并安装应用。
2. 打开应用 → 「添加助理」→ 扫码。
3. 应用会：校验二维码 → 生成自己的设备密钥（私钥进系统安全存储）→ 连接二维码里的地址 → 完成绑定并保存这台电脑。
4. 之后打开应用会自动用设备密钥重连，**不需要再扫码**。想解绑：助理详情页 → 解除绑定。

## 五、网络配置

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
- 自建反向隧道，或
- 用组网方案（如 Tailscale/ZeroTier）把手机和电脑放进同一个虚拟内网，再用局域网地址连接（二维码里的 `lan` 地址换成虚拟网段地址即可），或
- 用自己的域名 + cloudflared 命名隧道。

协议本身按「中继不可信」设计：身份验证与鉴权都在应用层，换中继不需要改协议。

## 六、验证安装是否成功

在电脑上另开一个终端：

```bash
node _recon/verify-real-install.mjs http://127.0.0.1:<端口>
```

它会依次检查：健康端点 → 二维码载荷可被手机侧解析 → WebSocket 握手 → 用真实 Ed25519 密钥完成绑定 → 用二维码里的公钥验证电脑签名 → 发一条消息并等待回复或明确错误。

全部 13 项通过即为安装成功。

## 七、排错

| 现象 | 原因与处理 |
|---|---|
| `dsh --dump-config` 里没有 openwhale | 安装到了别的 profile；确认 `--profile` 参数与你在用的 profile 一致 |
| DSH 启动日志出现 `openwhale (dsh-openwhale): failed to import` | 插件包被复制安装后仍引用了包外文件。检查是否有 `../../` 形式的导入（`packages/plugin/test/protocol-copy.test.mjs` 会守住这条） |
| 浏览器打不开 `/openwhale` | 端口不对，或 DSH 没重启；用启动日志里的实际 URL 和 token 前缀 |
| 页面提示「已绑定另一台手机」 | 一台电脑只能绑一台手机。先在手机端解绑，或在电脑端删除 `$DSH_HOME/openwhale/state.json` 里的设备（解绑后需重启） |
| 二维码扫了但提示已过期 | 10 分钟窗口过了，重新生成 |
| 手机提示连不上 | 先确认同网段、防火墙放行；再看 `/openwhale/info` 的 endpoints 是否包含手机能访问的地址（`127.0.0.1` 只能本机用） |
| 手机能连上但收不到回复 | 先看 `$DSH_HOME/openwhale/openwhale.log`。常见原因是电脑上的 DSH 账号失效，或 profile 里没有配置默认模型（手机会话需要一个可用的 provider/model；插件会依次从默认模型服务、profile 的 `agent-default-model`、活跃会话、本插件 `agentOptions` 里找） |
| 隧道地址变了 | 快速隧道的固有行为。手机端会轮换重连；若仍失败，重新生成二维码绑定，或改用组网方案 |
| 关机/重启没反应 | 确认 `allowRemoteShutdown: true`；非交互会话可能缺少关机权限，见 [remote-power.md](remote-power.md) |

## 八、数据放在哪

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/openwhale/state.json` | 电脑身份密钥、配对窗口、已绑定手机（权限 0600，原子写） |
| `$DSH_HOME/openwhale/openwhale.log` | 插件自己的日志（就绪、端口、隧道地址、配对/解绑、错误）——**排错先看这里** |
| `$DSH_HOME/openwhale/uploads/` | 手机发来的附件落盘位置 |
| DSH 会话日志 | 每台手机一个会话，id 形如 `ow-<hash>` |

> 为什么有独立日志文件：`ctx.logger` 不一定挂载了可用的输出端，而插件在"手机连不上"时最需要能看到自身状态。所以每条插件日志都同时写到 `openwhale.log`。

删除 `state.json` 等于让电脑"失忆"：所有手机都需要重新扫码绑定。
