# Open Whale 远程开机 / 关机

> 这份文档说明「远程开机」和「远程关机」各自能做到什么程度、**做不到什么**、你需要准备什么，以及怎么一步步验证。
>
> 文中对每条结论标注了依据类型：
> - **〔官方〕** = 厂商/项目的正式文档
> - **〔厂商经验〕** = 名称随厂商不同的固件/驱动设置项，无统一官方来源
> - **〔社区〕** = 第三方实践或实测数字
> - **〔未验证〕** = 尚未在目标机上实测确认，**不要当成承诺**

---

## 一、先说最重要的一句话

**电脑真正关机后，它自己的进程不在运行。** 跑在这台电脑上的任何软件（包括 Open Whale 插件）都不可能唤醒它。

所以「远程开机」不是「让电脑自己醒过来」，而是：

```
手机  →  公网（隧道 / 组网）  →  局域网内一台常开设备  →  广播魔术包  →  目标电脑网卡  →  上电
```

**那台「局域网内的常开设备」是硬性要求，不是可选项。**
魔术包（Magic Packet）是**二层广播帧**，不会跨网段；Tailscale / ZeroTier 这类组网工具工作在**三层**，官方已明确说明它们**不能自己发送**魔术包，只能让你「登进」局域网里那台常开设备，由它来发。**〔官方〕**

因此 Open Whale 的「唤醒代理」（WakeProxy）是**给那台常开设备用的代发能力**，而不是「本机唤醒自己」的开关。

---

## 二、能做什么 / 不能做什么

### 能做

| 场景 | 可行性 | 依据 |
|---|---|---|
| 在电脑**在线**时远程**关机 / 重启**（带可取消的倒计时） | ✅ 可以 | 走系统 `shutdown`，见第五节 |
| 从**睡眠**（S3 / Modern Standby S0ix）唤醒 | ✅ 通常可以 | **〔官方〕** 微软：WOL 支持从 sleep 唤醒；S0ix 机型官方还要求**接入交流电源 + 有线以太网** |
| 从**显式休眠**（hibernate，S4）唤醒 | ✅ 可以 | **〔官方〕** 微软：Windows 只在 hybrid shutdown 时禁用 WOL，休眠不受影响 |
| 从**关闭快速启动后的关机**（S5）唤醒 | ❓ 取决于主板/网卡固件 | **〔官方〕** 微软承认「部分系统的固件与硬件可能在 Windows 不参与的情况下自行 arm 网卡」，但这是例外 |
| 让局域网内一台常开设备代发魔术包（本插件提供） | ✅ 可以 | Node 侧广播发送无障碍（实测 102 字节魔术包发送成功） |

### 不能做

| 场景 | 结论 | 依据 |
|---|---|---|
| 从**默认「关机」**唤醒（Windows 10/11 快速启动） | ❌ **官方明确不支持** | **〔官方〕** 见下 |
| 从**完全断电**（拔插头 / 关排插）唤醒 | ❌ WOL 无效，只能靠带外手段 | 常识 + **〔未验证〕** 带外方案 |
| 从互联网**直接把魔术包发给路由器公网 IP** | ❌ 基本不可行 | **〔官方〕** 需要 IP directed broadcast（企业网络特性），家用路由器多数不提供；网卡固件是否接受定向魔术包**〔未验证〕** |
| 靠 Tailscale / ZeroTier **自己**发广播 | ❌ 三层组网不能发二层广播 | **〔官方〕** |
| 从 Wi-Fi 唤醒**已关机**的电脑 | ❌ 基本不行（WoWLAN 通常只在睡眠下有效） | 见第五节 |
| 「发完之后自动确认它醒了」 | ❌ 无法确认 | 目标机关机时没有进程能回话；开机过程也没有可靠旁路信号 |

### 为什么默认「关机」唤醒不了 —— 微软官方原文要点 〔官方〕

来源：[Wake on LAN (WOL) behavior in Windows 10](https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/wake-on-lan-feature)（原 KB2776718，Last updated 2026-02-12）

- Windows 10/11 的默认「关机」是 **hybrid shutdown（快速启动）= S4**。
- 原文口径：**WOL from S4 or S5 is unsupported**；并且网卡是被**显式地不 arm**的，因为「用户期望关机状态零功耗」。
- 原文口径：**WOL 只在从 sleep（S3）唤醒，或用户显式进入 hibernate（S4）时受支持**。
- 关键细节：hybrid shutdown 与 hibernate 的**电源状态相同（都是 S4）**，但「Windows 只会在 hybrid shutdown 这一转换中显式禁用 WOL，休眠时不会」。
- 唯一的官方缝隙：**部分系统的固件/硬件可能自行 arm 网卡**，「即使 Windows 不参与这个过程」——但这属于例外，**〔未验证〕**。

官方给出的关闭方法（也是你**必须**做的一步）：
**控制面板 → 电源选项 → 选择电源按钮的功能 → 取消勾选「启用快速启动（推荐）」→ 保存。**
（文档同时注明「我们不推荐禁用 hybrid shutdown」——这是官方在权衡，你按自己的需求决定。）

### 关于 Modern Standby（S0ix）

- **〔官方〕** 微软 [Wake On LAN for Surface devices](https://learn.microsoft.com/en-us/surface/wake-on-lan-for-surface-devices)：Modern Standby 机型**可以**支持 WOL，但必须**接入交流电源**且使用**有线**以太网适配器/扩展坞。
- 该结论发布在 Surface 产品文档里，**其他品牌（例如 ThinkPad + Realtek 网卡）不在这个官方硬件清单内** → 具体机型**〔未验证〕**，需实机测试。

---

## 三、用户需要做的 4 件事

### 1. 在 BIOS/UEFI 里开启网卡唤醒 〔厂商经验〕

进入固件设置，找到并启用（**名称随厂商不同**）：

- `Wake on Magic Packet` / `Wake on LAN`
- `Power On By PCI-E` / `Resume by LAN`
- 有的机器还有 `ErP` / `Deep Sleep` 之类的省电项，**开启后会切断网卡待机供电，需要关闭**

同时确认物理前提：**关机后网卡仍获得待机供电（PME）** —— 这需要主板 + 电源 + 网卡三方都支持。

### 2. 关闭 Windows 快速启动 〔官方〕

**控制面板 → 电源选项 → 选择电源按钮的功能 → 取消勾选「启用快速启动（推荐）」→ 保存**（需要管理员）。

这是让「关机」不再是 hybrid shutdown 的**唯一官方途径**。

### 3. 准备一台常开、且与目标机同网段的有线唤醒代理 〔官方〕

可以是：树莓派 / NAS / 软路由 / 旧笔记本。它必须：

- **常开**（目标机关机时它还在运行）
- **和目标机在同一个广播域**（同一二层网段）
- **有线连接**

在它上面运行 Open Whale 插件（或任何能发魔术包的工具），并登记目标机的 MAC。

> 现成替代方案：**UpSnap**（自托管 WOL 面板，被 Tailscale 官方博客推荐）。若用 Docker 部署，注意需要 `network_mode: host` 才能摸到宿主机物理网卡。

### 4.（可选）针对完全断电场景的带外手段 〔未验证〕

智能插座 + 主板 BIOS 的「**来电自启 / Restore on AC Power Loss**」。这是常见做法，但本次调研**未取得权威文档来源**。企业场景可用 BMC / IPMI / vPro AMT。

---

## 四、远程唤醒：如何验证

### 4.1 先确认目标机的唤醒能力（在目标机上跑，无需管理员）

```powershell
# 已注册为唤醒源的设备：列表里应出现你的有线网卡
powercfg /devicequery wake_armed

# 可配置为唤醒源的设备
powercfg /devicequery wake_programmable

# 可用睡眠状态：若只有「S0 低电量待机 / 休眠 / 快速启动」而没有 S3，则不能套用「WOL 只在 S3 支持」这条
powercfg /a

# 快速启动是否开启：期望关闭后为 0；为 1 表示默认关机是 hybrid shutdown(S4)，官方不支持 WOL
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power').HiberbootEnabled

# 上次是谁唤醒的（排查用）
powercfg /lastwake
```

> 实测参考（2026-10-13，本机 ThinkPad）：`wake_armed` 里有 **Realtek PCIe GbE Family Controller**（网卡已 arm）；`powercfg /a` 显示**只有 S0 低电量待机**、**S1/S2/S3/混合睡眠均不可用**；`HiberbootEnabled = 1`（快速启动开着）。

### 4.2 需要管理员的检查（沙箱环境会拒绝访问）

```powershell
Get-NetAdapter | Format-Table Name, InterfaceDescription, Status, MacAddress, LinkSpeed

# WakeOnMagicPacket 是关键开关
Get-NetAdapter | ForEach-Object {
  Get-NetAdapterPowerManagement -Name $_.Name |
    Select-Object Name, WakeOnMagicPacket, WakeOnPattern
}

# 驱动高级属性里的 WOL 相关项（名称随厂商不同）
Get-NetAdapter | ForEach-Object {
  Get-NetAdapterAdvancedProperty -Name $_.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'Wake|Magic|WOL|Shutdown|Power' } |
    Select-Object DisplayName, DisplayValue
}
```

### 4.3 唯一可信的端到端验证流程（务必按顺序做对照实验）

1. 记下目标机**有线网卡 MAC** 和它所在网段的**广播地址**。
2. 在 BIOS 开启 Wake on Magic Packet；关闭快速启动。
3. **对照实验 A**：`shutdown /s /t 0`（快速启动仍开启）→ 等 30 秒 → 从代理发魔术包 → **大概率不醒**（符合官方结论）。
4. **对照实验 B**：关闭快速启动后 `shutdown /s /t 0` → 等 30 秒 → 发魔术包 → 看上不上电（固件层 arm 的例外路径）。
5. **对照实验 C**：`shutdown /h`（休眠 S4）→ 等 30 秒 → 发魔术包 → **官方支持路径，应当成功**。
6. **对照实验 D**：让机器进 Modern Standby（开始菜单睡眠/合盖）→ 发魔术包 → 验证 S0ix 是否支持。

> **只有 A–D 都实测过，才能对「远程开机能做到哪一步」下结论。** 在此之前请按「睡眠/休眠可唤醒、默认关机和断电不可唤醒」来预期。

### 4.4 用本插件的代理发一次包

代理侧（常开设备）登记并唤醒：

```js
import { WakeProxy, validateWakeTarget } from './packages/plugin/src/wol-proxy.mjs'

// 1) 校验参数（表单用）
validateWakeTarget({ label: '书房台式机', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.255' })
// → { ok: true, errors: [], normalized: { label, mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.255', port: 9 } }

// 2) 登记（通过插件传入的 StateStore 持久化，key = 'wol.targets'）
proxy.register({ label: '书房台式机', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.255' })

// 3) 唤醒：同一目标 3 秒内重复请求会被去重（reason: 'throttled'）
await proxy.wake('目标 id')            // 或 proxy.wake({ mac: 'AA:BB:CC:DD:EE:FF' })
// → { ok: true, mac, address, port, packetBytes: 102, confirmable: false }
```

也可以用系统工具对照（在代理上）：

```powershell
# Windows
node -e "const d=require('dgram').createSocket('udp4');d.bind(()=>{d.setBroadcast(true);const mac=Buffer.from(process.argv[1].split(':').map(x=>parseInt(x,16)));const p=Buffer.concat([Buffer.alloc(6,255),Buffer.concat(Array(16).fill(mac))]);for(const port of [9,7])d.send(p,0,p.length,port,'255.255.255.255',e=>console.log(port,e?('ERR '+e.message):'sent',p.length+'B'));setTimeout(()=>d.close(),500)})" "AA:BB:CC:DD:EE:FF"

# Linux（树莓派/NAS）
sudo apt install etherwake && sudo etherwake AA:BB:CC:DD:EE:FF
```

> ⚠️ 上面第一条命令会**真的唤醒目标机**。想只验证发送链路，先在插件里用 `sendWakeOnLan({ mac, dryRun: true })`，它只构造 102 字节包、不发网络包。

---

## 五、远程关机 / 重启

这是电脑**在线**时的能力，走系统 `shutdown`，带可取消的宽限期。

### 能做什么

- **关机 / 重启 / 取消**，默认 `shutdown /s /t <N>`，`N` 有安全区间（不会允许 0 秒，也拒绝荒唐的长值）。
- 手机端可以拿到倒计时与取消令牌。

### 官方约束 〔官方〕

来源：[shutdown | Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)（Last updated 2025-05-02）

- `/t` 有效范围 **0–315360000**，默认 **30**；**`/t` 大于 0 时隐含 `/f`**（到点会强制结束应用，可能丢未保存数据）。
- `/a` 必须**在超时窗口内、用一个新的独立命令行窗口**执行。
- 需要 **"Shut down the system"**（`SeShutdownPrivilege`）权限；不是管理员/没有该权限时会报 **错误 5** 或 **错误 1314**。
- **不使用 `/p`**：无警告、无超时、无法取消。

### 需要注意的坑

1. **权限**：以服务 / 计划任务 / WinRM / SSH 等**非交互会话**运行时，令牌里没有 `INTERACTIVE`，`shutdown.exe` 可能同时去要 `SeShutdownPrivilege` 和 `SeRemoteShutdownPrivilege` 而失败（错误 5 / 1314）。
   - 历史文档（**2006 年 XP 时代**，**〔未验证〕** 是否仍适用于现代 Windows）建议把「从远程系统强制关机」授予 **BATCH** 或 **SERVICE** 而不是 `INTERACTIVE`。
   - 修复路径：`secpol.msc` → 本地策略 → 用户权限分配 → **关闭系统** → 加入运行插件的账户。
2. **不要指望同步返回成功**：关机本身会切断你正在用的会话，调用方看不到返回码。正确设计是「发出计划 → 手机端倒计时/取消 → 断线后按重连结果确认」。
3. **先做干跑测试**（确认有无提权问题，无破坏性）：

   ```powershell
   shutdown /s /t 120 /c "Open Whale 关机权限探测" /d p:0:0
   Start-Sleep -Seconds 2
   shutdown /a
   ```

---

## 六、公网隧道（手机与电脑都联网时）

云电脑不开公网端口时，本插件用 **Cloudflare Quick Tunnel** 把本机回环服务暴露成一个 `https://<随机>.trycloudflare.com` 地址。

### 官方限制 〔官方〕

来源：[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)（Last updated 2026-09-30）

- 不需要 Cloudflare 账号或域名。
- **无可用性保证**。
- 每个 Quick Tunnel **最多 200 个在途请求**，超出返回 **429**。
- **不支持 Server-Sent Events（SSE）**。
- **域名每次创建都会变**。
- 「**任何拿到这个 URL 的人都能访问你的本地服务**」→ **URL 不是秘密**，鉴权必须在应用层。
- 定位是**测试与开发**；生产应使用具名隧道。

### 其他已知问题

- **创建频率限制**：**〔社区实测〕** 同一 IP 约 **20 次 / 30 分钟**会触发限流并持续 **25 分钟以上**；**已建立的隧道不受影响**。所以插件**不会**在崩溃循环里疯狂重启，而是做**指数退避**（1s → 2s → 4s → … → 上限 60s；被限流时退避更长），连续失败到阈值后停下并告知用户。
- **单条边缘连接**：**〔社区〕** Quick Tunnel 只有一条边缘连接，进程可能中途死亡，必须有 supervisor 重启。
- **中国大陆可达性**：**〔社区〕** 有报告称 Cloudflare 给隧道分配的一批特殊 IP 被 GFW 定向阻断，**移动网络最明显**，电信/联通视情况而定。`*.trycloudflare.com` 的实际可达性**〔未验证〕**，建议用你自己的运营商实测。
- **是否支持 WebSocket**：**〔官方〕**「Cloudflare Tunnel 整体完整支持 WebSocket」；但 Quick Tunnel 文档**没有单独声明** → 具体行为**〔未验证〕**。

### 关于 cloudflared 二进制

**插件不会自动下载 cloudflared。** 原因：npm 上的 `cloudflared` / `untun` 包会在 `postinstall` 阶段从 GitHub Releases 拉一个 **约 53 MB** 的二进制，在 `--ignore-scripts`、受限 CI 和中国大陆网络下极易失败；而且**本机实测出现过「悬空 shim」**——npm 的包装脚本还在，真正的二进制已经没了，运行它直接报 `Cannot find module`。

插件启动隧道时会按顺序查找并用 `--version` **实际验证**：

```
显式配置路径  →  环境变量 CLOUDFLARED_BIN  →  插件缓存目录  →  PATH
```

**每一项都必须能真正跑起来**（文件存在不算数，正是为了识别悬空 shim）。

推荐做法：手动下载 + 校验 + 指定环境变量。

```powershell
# 1) 下载（Windows x64）
$dir = "$env:LOCALAPPDATA\cloudflared"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dst = "$dir\cloudflared.exe"
Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $dst

# 2) 校验 SHA256（示例值为 2026.10.0 的官方哈希；换版本请以 GitHub Releases 的说明为准）
(Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
# 2026.10.0 期望值：86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c

# 3) 告诉插件二进制在哪，然后重启插件
$env:CLOUDFLARED_BIN = $dst
```

```powershell
# 验证二进制真的可用（这一步是关键，别只看文件是否存在）
& $env:CLOUDFLARED_BIN --version     # 期望：cloudflared version 2026.10.0 (built ...)

# PATH 上的 cloudflared 如果是 npm shim，务必单独验一次；失败说明它是悬空 shim
where.exe cloudflared
& (Get-Command cloudflared).Source --version
```

### 安全基线须知 〔官方〕

- 插件默认**只监听 `127.0.0.1`**，origin 不对局域网/公网开放（可用 `netstat -ano | Select-String ':8787'` 确认看到的是 `127.0.0.1:8787` 而不是 `0.0.0.0:8787`）。
- 隧道把密文终结在 Cloudflare 边缘 → **不叠加应用层加密时，边缘可见明文**。因此令牌/配对码/会话密钥绝不能进日志。
- Quick Tunnel 的**邮件 OTP 保护对手机 App 不可用**：**〔官方〕**「Email authentication requires an interactive browser session. It does not support non-interactive clients.」

---

## 七、常见失败与排查

| 现象 | 最可能的原因 | 怎么做 |
|---|---|---|
| 发了几次魔术包，机器毫无反应 | **快速启动还开着**（默认关机 = hybrid shutdown，NIC 被显式不 arm） | 关闭快速启动 → 重新做实验 A/B（第 4.3 节） |
| 同上，且 BIOS 里找不到 WOL 项 | 固件没开启 / 被 `ErP`、`Deep Sleep` 切断了网卡待机供电 | 在 BIOS 开启 Wake on Magic Packet 并关闭深度省电项 |
| 睡眠/休眠能醒，关机不行 | **这是官方定义的正常行为**，不是 Bug | 想从关机唤醒，只能依赖固件自行 arm 的例外路径（**〔未验证〕**） |
| 拔了插头/关了排插就唤不醒 | 完全断电时任何 WOL 都无效 | 用智能插座 + 主板「来电自启」（**〔未验证〕**） |
| 树莓派发了包，机器不醒 | 代理和目标**不在同一个广播域**（不同 VLAN / 网段） | 把代理接到同一网段；换该网段的**定向广播地址**（如 `192.168.1.255`）而不是 `255.255.255.255` |
| 代理自己也是 Wi-Fi 接入 | 广播未必落到目标机所在的有线网段 | 代理改用**有线**连接 |
| 目标机用 Wi-Fi | WoWLAN 通常只在睡眠下有效 | 改有线以太网 |
| `wake()` 返回 `throttled` | 3 秒内对同一目标重复点击（防刷爆网络） | 等提示的剩余秒数；去重是**按目标**的，不影响唤醒别的机器 |
| `wake()` 返回 `send-failed`（如 `EPERM`） | 广播权限被沙箱/系统策略拒绝 | 在代理上以正常权限运行；确认目标地址是广播地址 |
| 隧道没起来，日志说找不到 cloudflared | 二进制缺失，或 PATH 上是**悬空 shim** | 按第 6 节下载 + 校验 + 设 `CLOUDFLARED_BIN` |
| 隧道频繁重启 / 报 `429`、`error code: 1015` | Cloudflare 对**创建**做了每 IP 限流（**〔社区实测〕** ~20 次/30 分钟） | **停下来等 25 分钟以上**，不要反复手动重启；已建立的隧道不受影响 |
| 隧道地址每次都不一样 | Quick Tunnel 官方行为（每次创建主机名都变） | 需要固定域名请用 Cloudflare 具名隧道（需账号 + 域名） |
| 手机上连不上，但电脑本地正常 | 运营商/地区对 `*.trycloudflare.com` 不可达（**〔未验证〕**） | 换网络（例如切运营商热点）实测；或改用其他可达方案 |
| 关机命令报 **错误 5 / 1314** | 运行账户没有「关闭系统」权限（非交互会话尤其容易） | 用 `secpol.msc` 授予权限；或改由桌面会话中的助手进程执行 |
| 关掉倒计时后机器还是关了 | 系统级关机已经交给 OS，取消太晚 | `/a` 必须在超时窗口内执行；宽限期不要太短 |

---

## 八、未验证清单（诚实边界）

以下结论**尚未在目标机上实测**，不要作为承诺：

1. 关闭快速启动后，**本机能否从 S5 被固件层 arm 的网卡唤醒**。
2. **本机（S0ix-only，非 Surface 硬件清单）从 Modern Standby 能否被唤醒**。
3. `*.trycloudflare.com` 在**中国大陆三大运营商**的实际可达性。
4. Quick Tunnel 的**带宽上限、最长持续时间**（官方未给出）。
5. Quick Tunnel **是否支持 WebSocket**（只有「Cloudflare Tunnel 整体支持」的官方声明）。
6. 公网 → 路由器端口转发 → 主机单播 IP 发魔术包能否成功（取决于网卡固件）。
7. 智能插座 + 来电自启作为带外开机手段（**未取得权威文档来源**）。
8. 现代 Windows 的非交互会话里 `shutdown` 是否仍会同时请求两个特权（所依据的是 2006 年 XP 时代文档）。
9. 是否存在稳定查询「是否有挂起关机」的 CLI（因此插件自行维护 pending 状态）。
10. `woly-server` 之类第三方「云端下发 + LAN agent」项目的协议与鉴权细节（**仅作为架构参考，不建议依赖**）。
