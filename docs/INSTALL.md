# 安装

## 1. 电脑端

### 1.1 安装插件

在 DeepSeek Harness 的插件目录中安装 `dsh-openwhale`，然后在插件设置里启用它。

启用后插件会：

- 在 DSH 的 Web 服务上挂载 `/openwhale/*` 路由
- 启动 WebSocket 服务
- （可选）启动公网隧道

### 1.2 确认运行

```bash
curl http://127.0.0.1:19387/openwhale/health
```

期望返回：

```json
{ "ok": true, "plugin": "dsh-openwhale", "paired": false, "devices": [], "connections": 0 }
```

### 1.3 可选：启用公网隧道

默认只在本机可用。若希望手机在移动网络下也能连接，需要启用公网隧道：

1. 准备 `cloudflared`：
   - 放到 `%LOCALAPPDATA%\openwhale\cloudflared\cloudflared.exe`（Windows）
   - 或用环境变量 `CLOUDFLARED_BIN` 指定路径
   - 或加入系统 PATH
2. 把插件配置里的 `tunnelMode` 设为 `quick`
3. 重启 DSH

启用后插件日志会出现：

```
使用 cloudflared <version>（来源 cache）
公网地址：https://xxxx.trycloudflare.com
```

> 临时隧道的域名每次重启都会变化。固定域名支持在 V3 规划中。

---

## 2. 手机端

### 2.1 安装 App

从 Release 下载 APK 安装（Android），或从源码构建（见第 3 节）。

首次打开无需登录，也不需要账号。

### 2.2 配对

1. 电脑浏览器打开 `http://127.0.0.1:19387/openwhale`，页面上会显示二维码
2. 手机 App →「扫码添加电脑」→ 扫这个二维码
3. 看到「在线」即绑定成功

如果相机不方便，也可以用「手动粘贴」：在电脑上复制配对载荷文本，粘贴到 App 的输入框提交。

> 配对密钥是**一次性**的，10 分钟后失效。过期了重新打开配对页即可。

---

## 3. 从源码构建（可选）

### 前置

| 组件 | 版本 |
|---|---|
| Node.js | 20+ |
| JDK | 17 |
| Android SDK | platform 35 / build-tools 35.0.0 |
| NDK | 27.1.12297006 |
| CMake | 3.31.x |
| pnpm | 9.x |

> **Windows 用户请注意**：请把仓库放在尽可能短的路径下（例如 `C:\o`），
> 并让 Gradle 用户目录也在短路径（例如 `C:\g`）。长路径会导致原生模块编译失败。

### 构建

```bash
pnpm install
cd packages/mobile
pnpm exec expo prebuild
cd android
./gradlew assembleRelease
```

产物：`packages/mobile/android/app/build/outputs/apk/release/app-release.apk`

### 安装到手机

```bash
adb install -r app-release.apk
```

---

## 4. 验证安装

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 插件健康 | `GET /openwhale/health` | `ok: true` |
| 已绑定 | `health.paired` | `true` |
| 连接在线 | `health.connections` | `>= 1` |
| 手机界面 | App 首页 | 显示「在线」 |
| 端到端 | 发一条消息 | 数秒内收到回复 |
