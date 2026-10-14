<!--
这份报告是 Open Whale 开发期间的内部调研产物，原样发布以便读者复核结论。
为保护隐私，文中本机绝对路径与本地账户名已替换为占位符（<local-path> / <user> / %DSH_INSTALL%）；
除此之外内容未做修改，包括「已验证 / 推断 / 未找到」的标注。

原始文件名：MOBILE-STACK.md
-->
# Open Whale 手机端技术选型与现成方案调研报告

> 调研日期：2026-10-13（所有版本号与日期均来自本次实际抓取的页面；抓取时间见各节标注）
> 范围：为一款手机端个人助理聊天 App（扫码绑定电脑上的 DSH 插件、多台电脑作为多个"助理"、文字与文件收发、远程开关机、互联网长连接）选定**可在 2026 年落地、依赖最少、可离线本地构建**的技术栈。
> 本文只做调研与选型，不含应用实现。

---

## 0. 结论速览（TL;DR）

| 决策点 | 结论 |
| --- | --- |
| 脚手架 | **Expo SDK 57（`expo@57.0.28`）+ CNG prebuild + Gradle 本地出包**；不用 RN CLI 裸工程，不用 Flutter |
| 扫码 | **`expo-camera@57.0.6`**（`CameraView` 的 `barcodeScannerSettings`）；`expo-barcode-scanner` **已停止发布新版本（停在 13.0.1）**，不要用 |
| 本地存储 | **`expo-sqlite@57.0.4`** 存多电脑/备注/消息历史；**`expo-secure-store@57.0.4`** 存长期私钥；不引入 MMKV |
| 文件 | **`expo-file-system@57.0.7`**（新 `File`/`Directory`/`Paths` API）+ **`expo-sharing@57.0.23`** + 可选 **`expo-intent-launcher@57.0.1`** |
| UDP / Wake-on-LAN | RN 环境**没有免原生模块的 UDP 方案**。两条路：(A) 自写一个内联 Expo Module（Kotlin，`expo-modules` inline modules）发魔术包；(B) 借鉴 WOLE 的做法由电脑端/局域网侧代理。`react-native-udp@4.1.7` 是 2023 年的老包，**不建议** |
| 加密 | **`tweetnacl@1.0.3`**（纯 JS，Ed25519 + XSalsa20-Poly1305 secretbox）+ **`@noble/curves@2.4.0`** + **`@noble/ciphers@2.4.0`**（审计过的纯 JS）。不用 `libsodium-wrappers`（WASM，RN 上要额外 polyfill） |
| 联网可达性 | 首选 **Tailscale/NetBird 组网**（零自建服务器，但两端需装客户端 App）；备选**自建 WebSocket relay**（真正开箱即用，但需要一台服务器）；**cloudflared quick tunnel 不适合**（HTTP-only 代理、每次重启换域名、无 uptime 保证） |
| 构建机要求 | 本机出 APK **必须**装 JDK + Android SDK；`eas build --local` 也仍要**登录 Expo 账号** |

---

## 1. 脚手架选择：Expo vs React Native CLI vs Flutter

### 1.1 当前版本现状（2026-10）

| 项目 | 版本 | 日期 | 来源 |
| --- | --- | --- | --- |
| Expo SDK 56 | SDK 56（RN 0.85 / React 19.2） | 2026-05-21 | [Expo changelog SDK 56](https://expo.dev/changelog/sdk-56) |
| Expo SDK 57 | SDK 57（RN 0.86 / React 19.2） | 2026-06-30；`expo@57.0.17` 于 2026-08-27 修 Hermes V1 回归 | [Expo changelog SDK 57](https://expo.dev/changelog/sdk-57) |
| `expo` 包最新 | **`expo@57.0.28`**（peer: `react-native@0.86.3`, `react@19.2.3`） | npm registry 抓取于 2026-10-13 | [registry.npmjs.org/expo](https://registry.npmjs.org/expo/latest) |
| React Native | 0.84（2026-02-11，Hermes V1 默认）→ 0.85（2026-04-07）→ 0.86（2026-06-11） | — | [RN 0.84 blog](https://reactnative.dev/blog/2026/02/11/react-native-0.84)、[RN releases](https://reactnative.dev/releases/overview) |
| React Native 节点要求 | **Node.js ≥ 22.11**（0.84 起） | 2026-02-11 | [RN 0.84 blog](https://reactnative.dev/blog/2026/02/11/react-native-0.84) |

> **重要**：Expo 官方在 SDK 56 的 changelog 里明确写了「SDK 56 有 Hermes V1 内存回归，**推荐升级到 SDK 57**」。SDK 57 是"最容易的一次升级"，且 `expo@57.0.9+` 修掉了内存问题、`expo@57.0.17+` 修掉了 dev 启动变慢的问题。**所以现在起新项目直接上 SDK 57，不要停在 56。**

### 1.2 针对 Open Whale 的这组需求，哪个最少折腾？

需求清单：二维码扫描（相机）· 文件下载/打开 · UDP 广播（WoL）· 局域网直连 · 后台保活。

| 需求 | Expo SDK 57 | RN CLI 裸工程 | Flutter |
| --- | --- | --- | --- |
| 相机 + 扫码 | ✅ `expo-camera` 一等公民，config plugin 自动写权限 | ⚠️ `react-native-vision-camera` 需自己配 gradle/权限 | ✅ `mobile_scanner` |
| 文件下载/打开 | ✅ `expo-file-system` 新 API（含 `downloadFileAsync`、`FileHandle`）+ `expo-sharing` | ⚠️ `react-native-fs`/`react-native-blob-util` 自行拼装 | ✅ `path_provider` + `open_filex` |
| UDP 广播（WoL） | ⚠️ 无官方模块，但 **SDK 56+ 支持 inline Expo Modules**，可以只写 20 行 Kotlin 内联 → 仍需 prebuild，但不需要发布 npm 包 | ⚠️ 同样需要自写 native module | ✅ `RawDatagramSocket` 是 Dart 标准库，**零原生代码** |
| 局域网直连 | ✅ RN 内置 `fetch`/`WebSocket` + `expo-network` 拿本机 IP | ✅ 同左 | ✅ |
| 后台保活 | ⚠️ `expo-background-task@57.0.21`（Android WorkManager 最小 15 分钟；iOS 由系统决定，可能只在你睡觉时跑）；真正"常驻"需前台服务（自写或 `expo-location` 类的 foreground service） | ⚠️ 同左，需自写 | ⚠️ 同左，需自写 |
| 本地出 APK | ✅ prebuild + `gradlew assembleRelease`，或 `eas build --local`（需登录） | ✅ 原生工程已就绪 | ✅ `flutter build apk` |
| 生态/文档/Agent 友好度 | ✅ 极高，官方提供 `.md` 版文档与 llms.txt | 中 | 中 |

**唯一让 Flutter 明显占优的是 UDP**（`RawDatagramSocket` 是 Dart 标准库，发 WoL 魔术包零原生代码）。但这是**单个功能点**的优势，而 Expo 在扫码、文件、权限、构建、文档、以及"参考现成开源项目最多"（见第 2 节：Happy 和 Paseo 都是 RN/Expo 系）上全面占优。

**推荐：Expo SDK 57。**

理由：
1. 五个需求里四个有官方一等公民模块，唯一缺的 UDP 可以用 SDK 56 起支持的 **inline module** 用 ~20 行 Kotlin 补上（[SDK 56 changelog: Inline modules](https://expo.dev/changelog/sdk-56)）。
2. **用户会自建 APK** —— Expo 的 CNG（Continuous Native Generation）+ `expo prebuild` 让 `android/` 目录完全可再生，无需把原生工程纳入版本管理，升级 SDK 只需跑一次 prebuild。
3. 第 2 节要参考的两个最大开源项目（Happy 24.1k★、Paseo 20.7k★）都走 RN 系，**协议与加密设计可以近乎照抄**，脚手架选型不会成为移植障碍。

### 1.3 Expo config plugin / dev build / EAS 本地构建现状

**结论：`eas build --local` 可行，但仍需要 Expo 账号；本机出包必须自备 JDK + Android SDK。**

来自官方文档（页面 `modificationDate: September 17, 2026`，抓取于 2026-10-13）[Run EAS Build locally](https://docs.expo.dev/build-reference/local-builds/)：

- 命令：`eas build --platform android --local`
- **前置条件（原文）**：`Run eas login, or alternatively, set EXPO_TOKEN using token-based authentication.` → **换句话说，`--local` 只是把构建过程放到你机器上跑，项目 `@account/slug` 仍需在 EAS 服务器上校验，必须登录或提供 token。不能完全匿名离线。**
- 官方列出的 **Limitations**（原文）：
  - 只能构建单一平台（`all` 不可用）
  - `eas.json` 里的 `node`/`yarn`/`fastlane`/`cocoapods`/`ndk`/`image` 字段**会被忽略**
  - **不支持缓存**
  - "Secret" 可见性的 EAS 环境变量不支持（需放本地环境变量）
  - **环境里的工具要自己装齐：Node/Yarn/npm、fastlane（仅 iOS）、CocoaPods（仅 iOS）、Android SDK 和 NDK**
  - **Windows 上官方不支持 local build**（可用 WSL，但"we do not officially test against this platform and do not support Windows"）

> ⚠️ **对 Open Whale 的直接含义**：既然用户在 Windows（本工作目录是 Windows），**不要走 `eas build --local`**。走 `npx expo prebuild` + `gradlew assembleRelease`，这条路径官方是支持的。

**推荐本地出包流程（Android 优先）：**

1. 装 JDK 17 + Android SDK（含 platform-tools / build-tools / cmdline-tools），设 `ANDROID_HOME`。
2. `npx expo prebuild --platform android`（SDK 57 起 **prebuild 默认会清空并重建 `android/`、`ios/`**，要保留改动需显式传 `--no-clean`，见 [SDK 57 changelog](https://expo.dev/changelog/sdk-57)）。
3. `cd android && ./gradlew assembleRelease` → 产物在 `android/app/build/outputs/apk/release/app-release.apk`。
4. 需要签名的正式包 → 配 `android/app/build.gradle` 的 `signingConfigs`；调试自用可直接用 debug keystore。参考官方 [Build APKs for Android Emulators and devices](https://docs.expo.dev/build-reference/apk/)。

**关键 `app.json` / `eas.json` 字段（示例骨架，字段名已核对文档）：**

```jsonc
// app.json
{
  "expo": {
    "name": "Open Whale",
    "slug": "open-whale",
    "android": {
      "package": "dev.openwhale.app",
      "permissions": ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"]
    },
    "plugins": [
      ["expo-camera", {
        "cameraPermission": "Allow $(PRODUCT_NAME) to scan the pairing QR code",
        "recordAudioAndroid": false,
        "barcodeScannerEnabled": true
      }],
      "expo-sqlite",
      "expo-secure-store",
      ["expo-file-system", { "enableFileSharing": true }]
    ]
  }
}
```

> `barcodeScannerEnabled` / `recordAudioAndroid` / `cameraPermission` 均为 `expo-camera` config plugin 的**实际字段名**，见 [expo-camera 文档](https://docs.expo.dev/versions/latest/sdk/camera/)。把 `recordAudioAndroid` 设为 `false` 可以不申请 `RECORD_AUDIO` 权限——纯扫码场景应该关掉它（最小权限）。

```jsonc
// eas.json（仅当以后要用 EAS 云构建时才有意义）
{
  "build": {
    "preview": { "distribution": "internal", "android": { "buildType": "apk" } },
    "production": {}
  }
}
```

> 注意：`android.buildType: "apk"` 才会产出 APK 而非 AAB，见 [Build APKs](https://docs.expo.dev/build-reference/apk/)。

---

## 2. 参考现成开源项目（5 个）

星标数取自 GitHub REST API `/repos/{owner}/{repo}` → `stargazers_count`，抓取于 2026-10-13。

### 2.1 对比表

| # | 项目 | ★（数级） | 技术栈 | 连接架构 | 最值得借鉴 |
| --- | --- | --- | --- | --- | --- |
| 1 | [slopus/happy](https://github.com/slopus/happy) | **24.1k**（2067 fork，MIT，TypeScript） | RN 系；lockfile 显示 [Expo SDK 55 / RN 0.83.1](https://github.com/slopus/happy/blob/main/pnpm-lock.yaml)（**抓取于 2026-10-13，可能已非最新**）；另有 desktop 版 | **自建 relay 服务器**（[slopus/happy-server](https://github.com/slopus/happy-server)，TypeScript，368★，**已 archived**，2026-02 最后推送）。手机与 CLI **都出站**连 relay；relay 只转发密文 | ① 完整的多层密钥体系；② "零往返认证"；③ 显式要求"server 保持 dumb，业务逻辑放 App" |
| 2 | [getpaseo/paseo](https://github.com/getpaseo/paseo) | **20.7k**（2439 fork，Apache-2.0/Other，TypeScript，topics 含 android/ios/mobile） | RN/Expo 系（有 fastlane、package-lock） | **自建/自托管 relay**（[getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay)，**Elixir + WebSocket**，103★，Apache-2.0，"distributed, protocol-compatible relay"）；有 docker 目录 | ① relay 的**语言无关协议**设计（官方称 protocol-compatible relay，可换实现）；② 桌面+手机+CLI 三端统一编排的目录结构 |
| 3 | [omnara-ai/omnara](https://github.com/omnara-ai/omnara) | **2.9k**（235 fork，Apache-2.0，主语言 Go） | Go 服务端 + 独立手机 App；YC S25 项目 | 服务端平台（可自托管），把 agent 会话托管在服务端，手机/终端/Web 多点接入 | ① "命令中心"式多端会话模型；② 把 agent 运行与 UI 解耦 |
| 4 | [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | **28.3k**（3034 fork，Apache-2.0，主语言 Rust） | Rust 本地服务 + Web/桌面 UI（**不是手机优先**） | 本地跑服务，浏览器/桌面 UI 直连；有单独的 `remote-v0.1.x` 远程分支/发布线 | ① **本机服务 + 浏览器前端**的最简架构，可作为"不做原生 App"的降级方案；② 任务看板式交互 |
| 5 | [blamechris/chroxy](https://github.com/blamechris/chroxy) | **7**（极小，MIT，JavaScript） | Node 服务（`@chroxy/server` 已发 npm）+ 客户端 | 自建 server，用于"监控会话、批准权限、远程编排 Claude Code / Gemini / Codex" | ① 小而完整的**权限审批（approve/deny）消息流**，正是 Open Whale 需要的"远程确认"模式；② 单仓库同时含 server 与 client 的目录组织 |

**补充参考（规模小但直接命中痛点）：**

- [Benjaminlooi/WOLE](https://github.com/Benjaminlooi/WOLE)（4★，MIT，主语言 Kotlin）——**"Android app & foreground service written with Expo + React Native that exposes a lightweight HTTP endpoint and relays Wake-on-LAN (WOL) packets"**。这是本次调研里**唯一一个用 Expo 做 WoL 的现成项目**，直接回答了第 3 节"Expo 上怎么发魔术包 + 怎么前台保活"。
- [cducote/remoteCC](https://github.com/cducote/remoteCC)（9★，JavaScript）——"A remote Claude Code terminal for approving changes on mobile app"。
- [Flux159/claude-code-go](https://github.com/Flux159/claude-code-go)（24★，MIT，TypeScript，2025-04 后停更）——"Mobile app and server for claude code"。

### 2.2 Happy 的具体设计点（最有价值，值得重点抄）

来源：[happy.engineering/docs/how-it-works](https://happy.engineering/docs/how-it-works/)、[happy.engineering/docs/security](https://happy.engineering/docs/security/)、[mintlify 自动生成版 E2E 文档](https://mintlify.wiki/slopus/happy/features/encryption)。

**三组件架构**：CLI（电脑，加密+上报）→ Relay Server（只存转发密文，"Keep the server dumb. Don't add server features."）→ Mobile App（解密+全部展示逻辑）。

**密钥层级（4 层）**：

| 密钥 | 生命周期 | 用途 |
| --- | --- | --- |
| `master_secret`（32B） | 每账号一次 | 根密钥，**永不出手机**；备份码 = base32 编码 |
| content key pair（Ed25519 风格） | 每账号一次 | 由 master 经 HMAC-SHA512 派生；**公钥**发给所有 CLI，用于包裹 DEK |
| session DEK / machine DEK（AES-256） | 每会话 / 每机器 | 加密实际内容；以 content **公钥**加密后**存服务器** |
| 临时密钥对 | 每次认证 | QR 配对时用，用完即弃 |

**配对流程（原文）**："Your computer shows a QR code with a one-time public key. Your phone scans it and sends back your account's public key, sealed so only your computer can open it."
→ **QR 里放的是电脑的「一次性公钥」+ 会话标识，不放长期密钥。**

**认证（"Zero Round-Trip Authentication"，原文）**：设备一次发送三件套 —— ① 自己选的随机 challenge ② 用自己私钥对 challenge 的签名 ③ 自己的公钥。服务器验签通过即发 token。**服务器只存公钥，永不接触私钥。**

**离线队列的设计理由（原文）**："Say you're on a train... Your phone loses signal all the time. But your computer at home stays connected to the server. It keeps sending updates... When your phone gets signal again, it catches up on everything it missed."
→ **离线补齐靠服务端存密文 blob，不靠手机端排队。** 这是 Open Whale 应采用的模型：**电脑端是常连的可靠一侧，手机是断续的一侧。**

**加密实现**：TweetNaCl（secretbox）+ AES-256-GCM；移动端密钥存 Keychain/Keystore。

### 2.3 Paseo 的设计点

- relay 用 **Elixir** 写且是 **WebSocket** 服务（repo topics: `elixir`, `paseo`, `relay`, `websocket`），Apache-2.0，**有 docker 目录** → 可自托管。
- 仓库结构把 `cli-client-id`、`paseo.json`、`public-docs/`、`packages/` 分离，说明它把**协议/协议文档**当成一等公民。Open Whale 也应先把消息协议（见 §3.8）写下来再写代码。
- ⚠️ **未验证**：`paseo.sh/docs/security` 与 `/docs/connectivity` 两次抓取均失败（`TypeError: fetch failed`），因此 Paseo 的端到端加密细节与"是否需要 tailscale/cloudflared"**本次未能核实**，建议后续单独查。

---

## 3. 库选型（确切包名 + 版本 + 是否免原生配置）

> 所有版本号来自 `https://registry.npmjs.org/<pkg>/latest` 实时抓取，日期 2026-10-13。`~`/`^` 前缀为包内声明，直接照抄即可。

### 3.0 版本总表

| 包 | 版本 | 用途 | 纯 JS？ | 需 prebuild？ |
| --- | --- | --- | --- | --- |
| `expo` | **57.0.28** | SDK 本体（RN 0.86.3 / React 19.2） | 否 | 是 |
| `expo-camera` | **57.0.6** | 相机 + 扫码 | 否 | 是（config plugin） |
| `expo-sqlite` | **57.0.4** | 本地 SQL 库 | 否 | 是（有 plugin） |
| `expo-secure-store` | **57.0.4** | Keychain/Keystore | 否 | 是 |
| `expo-file-system` | **57.0.7** | 文件读写/下载 | 否 | 是（有 plugin） |
| `expo-sharing` | **57.0.23** | 分享给其他 App | 否 | 是 |
| `expo-intent-launcher` | **57.0.1** | 拉起 Android Intent | 否 | 是 |
| `expo-network` | **57.0.2** | 拿本机 IP / 网络状态 | 否 | 是 |
| `expo-background-task` | **57.0.21** | 后台定时任务 | 否 | 是 |
| `@react-native-async-storage/async-storage` | **3.1.1** | KV 存储 | 否 | 是 |
| `react-native-mmkv` | **4.3.2** | 极快 KV（Nitro Modules） | 否 | **是，且需 `react-native-nitro-modules @0.35.9`** |
| `react-native-udp` | **4.1.7**（**2023-01 发布**） | UDP | 否 | 是，**但新架构支持存疑** |
| `qrcode`（电脑端 Node） | **1.5.4** | 生成二维码 PNG/SVG | ✅ 纯 JS | 不适用 |
| `tweetnacl` | **1.0.3** | Ed25519 / secretbox | ✅ 纯 JS | 否 |
| `@noble/curves` | **2.4.0** | Ed25519/X25519 等 | ✅ 纯 JS | 否 |
| `@noble/ciphers` | **2.4.0** | ChaCha20-Poly1305 / AES | ✅ 纯 JS | 否 |
| `libsodium-wrappers` | **0.8.4** | libsodium 全套 | ⚠️ WASM/asm.js | 需手写 polyfill |

### 3.1 二维码扫描

**`expo-barcode-scanner` 已废弃，不要用。**

证据：
1. npm 上 `expo-barcode-scanner` 最新版停在 **13.0.1**，发布于约 2024-04（`_npmOperationalInternal` 时间戳 `1713838092691` → 2024-04-23），**落后当前 SDK 57 达 44 个大版本号**：<https://registry.npmjs.org/expo-barcode-scanner/latest>
2. 官方文档 `https://docs.expo.dev/versions/latest/sdk/bar-code-scanner.md` 返回 **HTTP 404 + "No markdown exists for this path"**（抓取于 2026-10-13），而 SDK 57 文档树里**没有** BarCodeScanner 条目 → 该模块已从当前 SDK 文档中移除。

**用 `expo-camera@57.0.6`**（[文档](https://docs.expo.dev/versions/latest/sdk/camera/)）：

- 组件：`CameraView`，属性 `barcodeScannerSettings={{ barcodeTypes: ["qr"] }}`，回调 `onBarcodeScanned`。
- **更好的选择（Android）**：静态方法 `Camera.launchScanner()` —— Android 上走 **Google code scanner**、iOS 上走 `DataScannerViewController`（iOS 16+）。这是**系统级扫码 UI**，不需要在页面里嵌入 `CameraView`，也**不需要相机权限声明**（Google code scanner 由 Play Services 提供）。用 `Camera.isModernBarcodeScannerAvailable` 探测可用性。
- 还有 `Camera.scanFromURLAsync(url, ['qr'])` 可以从图片扫。
- **最小权限配置**：
  ```jsonc
  ["expo-camera", {
    "cameraPermission": "Allow $(PRODUCT_NAME) to scan the pairing QR code",
    "recordAudioAndroid": false,      // ← 不申请 RECORD_AUDIO
    "barcodeScannerEnabled": true
  }]
  ```
  Android 侧 `expo-camera` **会自动**往 `AndroidManifest.xml` 加 `android.permission.CAMERA`。文档原文：「This package automatically adds the `CAMERA` permission to your app.」`RECORD_AUDIO` 只有录带声视频才需要。
  注意：文档说明 `barcodeScannerEnabled: false` 在 Android 上**只有在从源码编译 expo-camera 时才生效**（预编译模块已含扫码库）；要省体积需把 `expo-camera` 加进 `package.json` 的 `buildFromSource`。

### 3.2 二维码生成（电脑端 DSH 插件，Node）

**`qrcode@1.5.4`**（npm 官方 latest，抓取 2026-10-13）：<https://registry.npmjs.org/qrcode/latest>

- MIT，`engines: node >=10.13.0`，依赖 `pngjs@^5.0.0`、`yargs@^15.3.1`、`dijkstrajs@^1.0.1`
- 同时提供 **PNG**（`toFile`/`toBuffer`）与 **SVG**（`toString(qr, {type:'svg'})`），还有 `qrcode` CLI 二进制
- 有 `browser` 字段，可跑在浏览器里；纯 JS，电脑端零原生依赖
- 仓库：<https://github.com/soldair/node-qrcode>

> 备选：Expo 官方还提供托管二维码服务 `https://qr.expo.dev/`，但电脑端既然已有 Node，本地生成更可控、不依赖网络。

### 3.3 本地持久化：`expo-sqlite` vs `async-storage` vs MMKV

| 方案 | 版本 | 适合 | 不适合 |
| --- | --- | --- | --- |
| **`expo-sqlite@57.0.4`** | 57.0.4，依赖 `await-lock@^2.2.2`，**导出 `./kv-store` 子路径** | 多电脑表、备注、**消息历史（分页、全文检索、索引）** | 极简单的几个开关值 |
| `@react-native-async-storage/async-storage@3.1.1` | 3.1.1（**3.x 已迁到 TurboModule**，`codegenConfig` 存在，`react-native-builder-bob` 构建） | 少量 KV（当前选中助理、UI 偏好） | 消息历史（整表读写、无查询能力） |
| `react-native-mmkv@4.3.2` | peer 依赖 **`react-native-nitro-modules@*`**（devDep 锁 0.35.9） | 需要极致读写速度的同步 KV | **多引入一个原生依赖链（Nitro）**，与"依赖最少"目标冲突 |

**推荐：`expo-sqlite@57.0.4` 做主力，`expo-secure-store@57.0.4` 存密钥。**

理由：
1. 消息历史是天然的**关系型**数据（助理表 / 会话表 / 消息表 / 附件表），AsyncStorage 无法查询分页。
2. `expo-sqlite` **额外提供 `expo-sqlite/kv-store`**（package.json `exports` 里有 `"./kv-store"`），等于**顺手拿到 KV 能力**，不必再加 AsyncStorage。
3. `expo-sqlite@57.0.4` 的 `exports` 里还有 `./localStorage/install`——可以给 web 端补 `localStorage` 垫片。
4. MMKV 4.x 走 Nitro Modules，**额外一个必须 prebuild 的原生依赖**，为了一个"快"字不值得。

### 3.4 文件下载与打开

**`expo-file-system@57.0.7` 的新 API 与旧 API 差异（关键，容易踩坑）**

来自 [官方文档](https://docs.expo.dev/versions/latest/sdk/filesystem/)（抓取 2026-10-13）：

- **新 API（默认入口）**：`import { File, Directory, Paths } from 'expo-file-system'`。面向对象：`new File(Paths.cache, 'x.txt')`、`file.create()`、`file.write()`、`file.textSync()`、`file.bytes()`、`file.copy()`、`file.move()`、`directory.list()`。
- **旧 API（顶层函数）全部标记 Deprecated，且文档明确写 "This method will throw in runtime"**：
  - `FileSystem.downloadAsync` ❌ → 用 `File.downloadFileAsync`
  - `FileSystem.readAsStringAsync` ❌ → 用 `new File(uri).text()`
  - `FileSystem.writeAsStringAsync` ❌ → 用 `new File(...).write()`
  - `FileSystem.getInfoAsync` ❌ → 用 `new File(...).info` / `.exists` / `.size`
  - `FileSystem.createDownloadResumable` ❌ → 用 `new FileSystem.DownloadTask(...)`（新版有 `pauseAsync`/`resumeAsync`/`savable()`/`fromSavable()`，支持断点续传）
  - `FileSystem.makeDirectoryAsync` ❌ → 用 `new Directory(...).create()`
- **仍可用旧 API 的逃生口**：`import * as FileSystem from 'expo-file-system/legacy'`（package.json 有 `./legacy` 导出）。
- **下载并保存的推荐写法**：
  ```ts
  const dir = new Directory(Paths.cache, 'downloads');
  dir.create({ idempotent: true, intermediates: true });
  const out = await File.downloadFileAsync(url, dir, { onProgress: p => ... });
  ```
- **OSS 存到用户可见目录**：Android 用 `file.contentUri`（`File` 的 Android-only 属性，"A content URI to the file that can be shared to external applications"）交给 Intent。

**打开文件（三件套）**：

- **`expo-sharing@57.0.23`** —— 系统分享面板，把文件交给能打开它的 App。跨平台、最省事。
- **`expo-intent-launcher@57.0.1`** —— Android 专用，直接 `ACTION_VIEW` 指定 mime type 打开。适合"点 PDF 直接开"。
- iOS 上想让自己出现在"文件"App 里：`expo-file-system` config plugin 设 `enableFileSharing: true`（对应 `UIFileSharingEnabled`）与 `supportsOpeningDocumentsInPlace: true`。

**推荐组合**：`expo-file-system@57.0.7`（下载/落盘）+ `expo-sharing@57.0.23`（交给系统）；仅当需要"点开即用默认 App"时再加 `expo-intent-launcher@57.0.1`。

### 3.5 UDP 广播（Wake-on-LAN 魔术包）★ 本报告最大的风险点

**明确回答：RN / Expo 环境没有免原生模块的 UDP 方案。**

- **Expo 官方没有 UDP 模块**。SDK 57 的模块清单里与网络相关的只有 `expo-network`（`57.0.2`，查询 IP/MAC/飞行模式，**不能发包**）和 `expo-server`（本机起 HTTP 服务，非 UDP）。参考 [Expo SDK 模块索引](https://docs.expo.dev/versions/latest/)。
- **`react-native-udp` 是 2023 年的老包**：npm 最新 `4.1.7`，`_npmOperationalInternal` 时间戳 `1674720300183` → **2023-01-26 发布**；`devDependencies` 里是 `react-native@^0.61.5` / `typescript@^4.1.3`（npm 抓取于 2026-10-13，见 <https://registry.npmjs.org/react-native-udp/latest>）。它是旧架构 bridge 时代的包，**没有 codegenConfig、没有 TurboModule 声明**，在 RN 0.86 的纯新架构（0.82 起新架构是唯一运行时）下**能否工作未验证，不应作为方案基础**。
- **第三方替代**：
  - `react-native-udp-turbo@0.1.4` —— 有 `codegenConfig`（`name: "UdpTurbo"`, `type: "modules"`），是 TurboModule 写法，**但包描述原文是 "for now only supports android"**，且 `devDependencies` 里 RN 是 `0.79.2`（未验证在 0.86 上可用）：<https://registry.npmjs.org/react-native-udp-turbo/latest>、<https://github.com/OwenRay/react-native-udp-turbo>
  - `expo-udp`（npm 上存在，**star/维护情况与 API 未验证**，同样不建议作为基础）

**最稳方案（推荐）：自写一个内联 Expo Module，约 20 行 Kotlin。**

SDK 56 起 Expo 支持 **inline modules**——"you can now define Expo modules directly within your project structure, alongside your JavaScript and TypeScript code... During prebuild, the iOS Xcode project is updated and the necessary options are set in the Android project, which lets us add inline modules to the build and autolink them automatically."（[SDK 56 changelog](https://expo.dev/changelog/sdk-56)，另有 [inline modules 参考](https://docs.expo.dev/modules/inline-modules-reference/)）

WoL 魔术包的语义非常简单：**6 字节 `0xFF` + 目标 MAC 重复 16 次 = 102 字节**，通过 UDP 发到广播地址（`255.255.255.255` 或子网定向广播）的 **端口 7 或 9**。Kotlin 侧核心就是一个 `DatagramSocket` + `setBroadcast(true)` + `send()`。

配套的 Android 侧硬性要求（必须有，否则广播发不出去）：
- 广播 UDP 在 Android 上**需要 `CHANGE_WIFI_MULTICAST_STATE`** 或退一步依靠定向子网广播；
- 若目标电脑已关机，**广播只能在局域网内发出** → 这就是"远程开机"必须让**电脑端插件或家里另一台常开设备**代发的原因（手机在 4G/5G 上无法直接广播到家里的局域网）。

**架构建议（重要）**：
> 把"发魔术包"这件事**按网络位置分流**。手机与电脑同一局域网 → 手机本地内联模块直接广播；手机在公网 → **由家里的常开设备代发**（DSH 插件所在机器如果已开机则无需代发；若目标机已关机，则必须有一台常开的小设备，例如树莓派/NAS，或依赖路由器自带 WoL 功能）。
>
> 现成参考实现：[Benjaminlooi/WOLE](https://github.com/Benjaminlooi/WOLE) —— "Android app & foreground service written with Expo + React Native that exposes a lightweight HTTP endpoint and relays Wake-on-LAN (WOL) packets to devices on the local Wi-Fi"。它同时解决了 **WoL 发包** 和 **前台服务保活** 两个问题，主语言 Kotlin，MIT。

### 3.6 WebSocket 长连接与断线重连

**RN 内置 `WebSocket` 在 SDK 57 下可用。** 证据与注意点：

- RN 0.84 把 `WebSocketInterceptor` 标为 **deprecated**（"Developer tools should use the Chrome DevTools Protocol (CDP) `Network` domain instead"）——**这只影响调试工具，不影响 App 里的 `WebSocket` 运行时**。见 [RN 0.84 blog](https://reactnative.dev/blog/2026/02/11/react-native-0.84)。
- Happy 与 Chroxy 都靠 WebSocket 通到 relay；Paseo 的 relay repo topics 直接是 `websocket`。**WebSocket 是这类产品的既成事实标准。**

**推荐做法：不引入第三方重连库，手写指数退避 + 心跳。**

理由：`react-native-websocket-service` 一类包体量小但维护不明；而这类产品**必须自己掌控重连语义**（重连后要 `resume` 拉取断连期间的密文 blob，而不是简单重放）。正确形态是：

```
连接 → 鉴权 → 上报 last_seen_seq → 服务器补发 [last_seen_seq+1, now] 的密文 → 进入实时流
```

指数退避建议：`1s, 2s, 4s, 8s, 15s, 30s` 封顶 + 抖动（±20%）；心跳 `ping` 每 25–30s（低于运营商 NAT 常见的 30–60s 空闲回收）；App 从后台回前台时（`AppState` 变 `active`）**立即主动重连一次**，不要等退避计时器。

**后台保活的真实能力边界**（[expo-background-task 文档](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/)，抓取 2026-10-13）：

- `expo-background-task@57.0.21` 底层是 Android **WorkManager** / iOS **BGTaskScheduler**。
- **Android：`minimumInterval` 最小 15 分钟**，且默认 12 小时一次。
- **iOS**：系统自行决定何时跑，可能只在你睡觉时跑（原文："On iOS, short intervals are often ignored—the system typically runs background tasks during specific windows, such as overnight."）
- **用户杀掉 App 时后台任务停止**；iOS 上从多任务里划掉就是完全终止。
- 结论：**`expo-background-task` 不能用来维持一条 WebSocket 长连接。** 它只能用来做"补拉遗漏消息"。
- 真正要"常驻"，Android 上需要**前台服务 + 常驻通知**（`expo-location`/`expo-task-manager` 系或自写 inline module；WOLE 就是这么做的）。产品上应接受"手机侧靠推送唤醒 + 重连补拉"，而不是追求永远在线。

### 3.7 本地构建 Android APK 是否需要 Android SDK / JDK

**需要。** 两条路径都要：

| 路径 | 需要 JDK | 需要 Android SDK/NDK | 需要 Expo 账号 | Windows 官方支持 |
| --- | --- | --- | --- | --- |
| `npx expo prebuild` + `gradlew assembleRelease` | ✅ | ✅ | ❌ | ✅ |
| `eas build --local` | ✅ | ✅（官方原文列出） | ✅（`eas login` 或 `EXPO_TOKEN`） | ❌（"we do not support Windows for local builds"） |

来源：[Run EAS Build locally](https://docs.expo.dev/build-reference/local-builds/)（`modificationDate: September 17, 2026`）。

**推荐流程（Windows 上可行性最高）**：
```powershell
npx expo install expo@latest --fix       # 或 npx expo install --fix
npx expo prebuild --platform android --clean
cd android
.\gradlew assembleRelease
# 产物: android\app\build\outputs\apk\release\app-release.apk
```
- SDK 57 起 `expo prebuild` **默认就是 clean 行为**（会清空并重建 `android/`、`ios/`），要增量改需显式 `--no-clean`（[SDK 57 changelog](https://expo.dev/changelog/sdk-57)）。
- 环境：**Node ≥ 22.11**（RN 0.85/0.86 硬性要求）、JDK 17、Android SDK（platform-tools、build-tools、cmdline-tools）、设 `ANDROID_HOME` 与 `local.properties`。
- 只要不是在跑 `eas build --local`，**完全不需要 Expo 账号，也完全离线**——这正是选 prebuild + gradlew 而非 EAS 的核心理由。

### 3.8 消息协议 schema（建议，非调研结论）

基于 Happy 的经验，建议定义**信封 + 载荷**两层，信封只由 relay 读取，载荷对 relay 全盲：

```ts
// 信封（relay 可见，仅路由所需的最少元数据）
type Envelope = {
  v: 1;
  deviceId: string;          // 电脑端协理 ID（公开）
  seq: number;               // 单调递增，用于断连补拉
  ts: number;                // 毫秒
  nonce: string;             // base64, 24B (secretbox)
  box: string;               // base64, 密文
  // 关键：不含任何可读的消息类型/内容，避免侧信道
};

// 载荷（仅两端可见）
type Payload =
  | { t: 'msg';      role: 'user'|'assistant'; text: string }
  | { t: 'file';     name: string; mime: string; size: number; sha256: string; chunkSeq: number; last: boolean }
  | { t: 'file.req'; sha256: string }             // 按需拉取文件内容
  | { t: 'approve';  reqId: string; decision: 'allow'|'deny' }  // 参考 chroxy
  | { t: 'power';    action: 'wol'|'shutdown' }
  | { t: 'ack';      upTo: number };
```

**离线队列放在电脑端 + relay，不放在手机端**——因为电脑是稳定一侧（Happy 明确论证过这一点）。

---

## 4. 安全

### 4.1 推荐方案：配对时交换长期公钥，之后 Ed25519 双向认证 + X25519 派生对称键

对"手机与电脑经公网直连"的场景，**不要试图自己发明协议**。照搬 Happy 已被 24k★ 项目验证过的结构：

1. **每台电脑生成一对长期密钥**（Ed25519 用于签名；X25519 用于密钥协商）。**私钥永不离开电脑**（存 `~/.dsh/access.key` 之类，chmod 600）。
2. **每台手机生成一对长期密钥**。私钥存 **`expo-secure-store`**（iOS Keychain / Android Keystore）。
3. **配对**：电脑显示 QR（见 §4.3），手机扫码后双方各自拿到对方**长期公钥**，并各自用自己私钥对"配对确认串"签名互验 → 完成**双向认证（mutual authentication）**，无需 CA。
4. **建立会话**：用 X25519 ECDH 派生共享密钥，或用长期密钥体系直接派生出每条会话的对称 DEK（Happy 的做法：DEK 随机生成，用对方**公钥**包裹后存服务器）。
5. **消息加密**：对称加密用 **XSalsa20-Poly1305（secretbox）** 或 **XChaCha20-Poly1305**。**每条消息独立随机 24 字节 nonce**，绝不重用。
6. **防重放**：信封带单调 `seq`，接收方丢弃 `seq ≤ last_seen` 的消息。
7. **拒绝服务/元数据**：信封不含可读消息类型（见 §3.8），避免 relay 侧信道。

### 4.2 RN 上可用的纯 JS 加密库（确切包名 + 版本）

| 包 | 版本 | 能力 | RN 可用性 | 评价 |
| --- | --- | --- | --- | --- |
| **`tweetnacl@1.0.3`** | 1.0.3（2020-02 发布，长期稳定） | `nacl.sign`（Ed25519）、`nacl.box`（X25519 + XSalsa20-Poly1305）、`nacl.secretbox`、`nacl.hash`、`randomBytes` | ✅ **纯 JS，`browser` 字段把 `crypto`/`buffer` 置 false**，不依赖 Node crypto。RN 里配合 `react-native-get-random-values` 或 `expo-crypto` 提供 `getRandomValues` | **首选**。零配置、零原生。Happy 用的就是它 |
| **`@noble/curves@2.4.0`** | 2.4.0，`engines: node >= 20.19.0`，依赖 `@noble/hashes@2.4.0`，有 SLSA provenance 与 npm attestations | Ed25519/X25519/secp256k1/P-256 等全套曲线 | ✅ 纯 JS（`"type": "module"`，ESM） | **推荐的现代替代**。审计过，有 provenance 签名 |
| **`@noble/ciphers@2.4.0`** | 2.4.0，`engines: node >= 20.19.0`，同样有 attestations | XChaCha20-Poly1305、ChaCha20-Poly1305、AES-GCM、Salsa20 | ✅ 纯 JS ESM | 与 `@noble/curves` 配套使用 |
| `libsodium-wrappers@0.8.4` | 0.8.4（依赖 `libsodium@^0.8.0`） | libsodium 全套 | ⚠️ **WASM/asm.js**，RN 上需要额外 polyfill 与打包配置；`browser` 字段已把 `fs/path/crypto/stream` 置 false，但仍有风险 | 不推荐用于 RN，除非你确实需要 Argon2 等 tweetnacl 没有的原语 |

**注意 `@noble/*` 2.x 是纯 ESM**（`"type": "module"`），Metro 对 ESM 的支持需要确认（**未验证**）。若遇到 Metro 解析问题，**`tweetnacl@1.0.3`（CJS）是最保险的退路**——它是 Happy 生产环境在用的库。

**随机数**：RN 没有 `crypto.getRandomValues`，必须提供 polyfill。`expo-crypto` 提供 `getRandomValues`，或使用 `react-native-get-random-values`（**该包的当前版本未在本次调研中核实**）。

### 4.3 QR 里应该放什么、不该放什么 ★

**结论：不要放长期密钥明文。QR 只放「一次性配对码 + 短期有效窗口」。**

**理由（为什么要短时一次性）：**

1. **相机画面会被别人看到。** QR 码在物理世界里是**可被旁观者拍照**的。放了长期私钥等于把电脑的永久身份贴在屏幕上，任何人拍到就能永久冒充。
2. **表情包/截图会扩散。** 用户会截图发群里——Happy 的用户文档里 QR 就是"你电脑上会显示一个二维码"。
3. **长期密钥一旦泄露无法"撤销单次"。** 只能吊销整台设备，用户体验极差；一次性码泄露影响面限于一次配对窗口。

**推荐 QR 载荷（Happy 的做法，原文）**："Your computer shows a QR code with a one-time public key."

```jsonc
{
  "v": 1,
  "type": "ow.pair",
  "relay": "wss://relay.example.com",   // 连接入口
  "room": "b7f3…",                       // 本次配对的一次性房间 ID（随机 128bit+）
  "pk":   "base64(ed25519_pub_32B)",     // 电脑的【长期公钥】—— 放公钥是安全的
  "eph":  "base64(x25519_eph_pub_32B)",  // 【一次性】临时公钥，配对后即弃
  "exp":  1750000000,                    // 过期时间戳（建议 120 秒）
  "sig":  "base64(ed25519_sig)"          // 电脑用自己的长期私钥对上面字段签名
}
```

**放进去是安全的**：公钥（`pk`）、临时公钥（`eph`）、relay 地址、一次性房间 ID、过期时间。这些被偷看都不致命，因为**要真正完成配对，扫码方必须证明自己持有对应的私钥**（用私钥对 challenge 签名）。

**绝不能放**：长期**私钥**、master secret、可用来直接解密历史消息的任何对称密钥、长期有效的 bearer token。

**短期窗口的具体实现**：
- 电脑生成一次性房间 ID + 临时密钥对，**TTL 120 秒**；
- 手机上送的配对请求必须携带房间 ID，服务器/电脑侧检查 **TTL + 一次性消费**（用完即删）；
- 配对成功后**立刻作废**该房间与临时密钥对（Happy 的措辞："Ephemeral keypair — ONCE/AUTH — Secure key exchange during QR auth — **Discarded immediately after**"）；
- 电脑端 UI 上显示**倒计时与"已取消/已配对"状态**，避免用户拍下一张已经失效的码。

**额外防线**（低成本高收益）：
- 配对成功后，两端**各自显示一个 6 位短校验码**（由双方公钥哈希派生），要求用户肉眼比对点击确认 → 抵抗中间人。
- 电脑端首次配对必须**有人在本机点击"允许"**，而不是扫到码就自动接受（防止有人对着你的屏幕远距离扫）。

---

## 5. 互联网可达性：手机和电脑都在公网时怎么连上

### 5.1 四种方案对比

| 方案 | 成本 | 需要什么 | 手机端要装额外 App？ | 真实限制 |
| --- | --- | --- | --- | --- |
| **(a) 自建 relay / 中继服务器** | 一台最便宜的 VPS（$3–5/月）+ 域名（可选） | 一台公网服务器，跑 Node/Go/Elixir 的 WebSocket 服务 | ❌ **不需要** | 你**必须有一台服务器**。但这是**唯一的"真正开箱即用"方案**——用户什么都不用装（对比 Tailscale 要装客户端） |
| **(b) Cloudflare Tunnel `cloudflared` 快速隧道** | $0 | 电脑上跑 `cloudflared` 二进制 | ❌ 不需要 | ❌ **不适合本场景**，见 §5.2 |
| **(c) Tailscale / ZeroTier / NetBird 组网** | $0（个人版） | 两端各装一个客户端 App | ✅ **需要**（手机+电脑都装） | 免费额度限制；**手机端要装 Tailscale App，这违背"依赖最少"**；依赖第三方控制平面 |
| **(d) 反向 WebSocket（电脑主动连手机/中继）** | 取决于中继 | 电脑永远出站连接 | ❌ | **电脑侧完全不需要开端口/公网 IP**，这是最强的穿透性；但"手机当中继"在移动网络下不可行（手机无公网入站），所以实际仍需一个公网中继 → 退化为 (a) |

### 5.2 Cloudflare Tunnel 快速隧道：为什么不适合（有官方原文）

来源：[Cloudflare Quick Tunnels 官方文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)，页面 `Last updated Sep 30, 2026`，本次抓取 2026-10-13。

**确认仍然免费且不需要账号**（原文）：

> "Quick Tunnels create a temporary `trycloudflare.com` URL for a local service. **You do not need a Cloudflare account or domain.**"

但官方同时给出**明确的定位与限制**（原文照录）：

> "**Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel.**"
>
> **Limitations**
> - Quick Tunnels have **no uptime guarantee**.
> - Each Quick Tunnel supports **up to 200 in-flight requests**. Additional requests return a `429` response.
> - Quick Tunnels **do not support Server-Sent Events (SSE)**.
> - Email authentication requires an interactive browser session. It does not support non-interactive clients.
> - **The hostname changes each time you create a Quick Tunnel.**

**对 Open Whale 的致命问题**：

1. **每次重启换域名** → 手机端保存的"助理地址"全部失效，用户每次开机都要重新扫码。这是产品级否决。
2. **无 uptime 保证** + 200 并发上限 → 不能承载长期 WebSocket + 文件传输。
3. **它是 HTTP(S) 代理**（`cloudflared tunnel --url http://localhost:8080` 要求一个本地 HTTP 服务）。它能代理 **WebSocket**（WebSocket 基于 HTTP Upgrade，这条**技术上可行但本次未在文档中核实**），但**不能承载原始 TCP/UDP**。这直接否掉了 (b) 作为「局域网 UDP 直连」的通道。
4. 即使配了具名 Tunnel 拿到稳定域名，那也**需要 Cloudflare 账号**，等于是把"依赖 Cloudflare 账号"换掉了"依赖自己的 VPS"，并没有更省事。

> ⚠️ 文档里还提到 `--allowed-mail` 可以做邮箱白名单（一次性 PIN，访问者无需 Cloudflare 账号），但原文明确说 "Email authentication requires an interactive browser session. **It does not support non-interactive clients.**" → **对 App 无用**，只适合人用浏览器打开。

### 5.3 Tailscale / ZeroTier / NetBird：免费额度与"是否要装 App"

**Tailscale 个人版（官方定价页，抓取 2026-10-13，[tailscale.com/pricing](https://tailscale.com/pricing)）**：

> **Personal** — "$0 **Free forever**" — **Unlimited user devices**、**Up to 6 users**、Up to 3 ACL groups、Up to 50 tagged resources、1,000 mins/month for ephemeral resources。

关键点：**设备数不限**（"Unlimited user devices"）——对 Open Whale 的"多台电脑作为多个助理"需求非常友好；限制是 **6 个用户**，个人自用完全够。

**但是（重要）**：Tailscale 的 Android/iOS 客户端是**独立的 VPN App**，它通过系统的 `VpnService`（Android）/ `NEPacketTunnelProvider`（iOS）工作。**这意味着手机端必须让用户额外安装 Tailscale App，并且接受一个设备级 VPN 配置。** 这会：
- 让"扫码即用"的体验变成"装两个 App 再扫码"；
- 与手机上其他 VPN 冲突（只能有一个活跃 VPN）；
- 让 iOS 审核/上架复杂度上升（要用 NetworkExtension entitlement）。

> **iOS 加分项的现实约束**：如果想在 iOS App 内**内嵌**组网能力，需要 `NEPacketTunnelProvider` + `com.apple.developer.networking.networkextension` entitlement。**本次未找到 Expo 官方支持的方案**；有第三方 Dart 包 `tailscale`（`danReynolds/tailscale_dart`，Flutter 用），RN 侧**未验证**。所以 iOS 上"免装额外 App 组网"基本不可行。

**NetBird**：开源且**可自托管**（[官方移动端文档](https://docs.netbird.io/get-started/install/mobile)），免费额度比 Tailscale 宽松（有第三方文章称其解决了 Tailscale 6 用户限制），同样**需要在手机上装 App**。可作为 Tailscale 的备选（避免厂商锁定，且能自托管控制平面）。

**ZeroTier**：定价页 <https://www.zerotier.com/pricing> —— **本次未成功抓取内容，免费额度未验证**，不写入结论。

### 5.4 「无需用户自备服务器即可开箱可用」的最佳方案排序

按"用户实际要付出多少"排序：

| 排名 | 方案 | 用户需要做什么 | 是否开箱即用 | 真实限制 |
| --- | --- | --- | --- | --- |
| **1** | **自建 relay + 官方托管一个公共实例**（推荐的产品形态） | 什么都不用做，扫码即用 | ✅ **是** | 你需要自掏一台 VPS 并长期维护；要做多租户隔离与限流。**这是唯一能让用户体验最好的方案** |
| **2** | **自建 relay（用户自己 Docker 一键起）** | 电脑上 `docker run` 一条命令 | ✅ 基本是 | 要求用户有 Docker；需要处理"我的 relay 地址是什么"的配置与二维码注入 |
| **3** | **Tailscale / NetBird 组网** | 手机**和**电脑各装一个 VPN 客户端并登录同一账号 | ⚠️ 半开箱（装两个 App + 一次登录） | 手机同时只能有一个 VPN；iOS 上无法内嵌；依赖第三方控制平面（NetBird 可自托管缓解） |
| **4** | **电脑端反向 WebSocket 连公共 relay** | 同上（本质是方案 1 的传输细节） | ✅ | 不是独立方案，是方案 1 的最优实现细节：**电脑只出站、不开端口** |
| **5** | **cloudflared quick tunnel** | 电脑上跑 cloudflared | ❌ **不是** | 域名每次都变、无 uptime 保证、200 并发、文档明说"for testing and development" |
| **6** | **纯局域网直连（同一 WiFi 下）** | 无需任何东西 | ✅ | 只在同一局域网有效；出门就用不了。**应作为快速路径与退化路径并存，而非唯一路径** |

### 5.5 推荐架构（综合）

```
                    ┌──────────────────────────────┐
                    │  Relay (WebSocket, 你自己托管) │
                    │  只转发密文，不知道内容          │
                    └───────┬──────────────┬───────┘
                            │ 出站 WSS      │ 出站 WSS
                  ┌─────────▼──────┐   ┌───▼─────────────────┐
                  │  手机 App       │   │  电脑 (DSH 插件)     │
                  │  (Expo SDK 57)  │   │  Node + qrcode       │
                  └─────────┬──────┘   └───┬─────────────────┘
                            │              │
                            │   局域网时：直连 / mDNS / UDP 广播
                            └──────────────┘
```

**三层连接策略（按优先级尝试）**：
1. **同一局域网** → 直连电脑的局域网 IP（`expo-network` 拿本机网段，直接 `ws://192.168.x.x:port`）。最快、不耗流量、且**只有这条路能发 WoL 广播**。
2. **双方都在公网** → 走自建 relay 的 WSS（电脑主动出站连接，**永不需要公网 IP 或端口转发**）。
3. **relay 不可达** → 退化到用户可选的 Tailscale 组网（进阶设置里提供，不设为默认）。

---

## 6. 推荐技术栈（含确切版本）

```
# ── 脚手架 ────────────────────────────────────────────────
expo@57.0.28                       # SDK 57 / React Native 0.86.3 / React 19.2
                                   # 需要 Node.js >= 22.11
# 构建方式: npx expo prebuild --platform android --clean
#           cd android && ./gradlew assembleRelease
# 不依赖 EAS 账号；不依赖网络（依赖装完后）

# ── 二维码 ───────────────────────────────────────────────
expo-camera@57.0.6                 # CameraView + barcodeScannerSettings={barcodeTypes:['qr']}
                                   # 优先用 Camera.launchScanner()（Android=Google code scanner）
                                   # 仅摄影权限；recordAudioAndroid: false
qrcode@1.5.4                       # 电脑端 Node 生成 PNG/SVG（纯 JS，MIT）

# ── 本地持久化 ────────────────────────────────────────────
expo-sqlite@57.0.4                 # 助理表/会话表/消息表/附件表；含 ./kv-store 子路径可当 KV 用
expo-secure-store@57.0.4           # 长期私钥 → iOS Keychain / Android Keystore
# 不引入 @react-native-async-storage/async-storage@3.1.1（expo-sqlite/kv-store 已覆盖）
# 不引入 react-native-mmkv@4.3.2（会拖入 react-native-nitro-modules，违背最小依赖）

# ── 文件 ─────────────────────────────────────────────────
expo-file-system@57.0.7            # 新 API: File / Directory / Paths；File.downloadFileAsync
                                   # 旧顶层函数已 deprecated 且 "will throw in runtime"
                                   # 逃生口: import * as FS from 'expo-file-system/legacy'
expo-sharing@57.0.23               # 交给系统"打开方式"
expo-intent-launcher@57.0.1        # 可选，仅 Android，ACTION_VIEW 直接打开

# ── 网络 ─────────────────────────────────────────────────
expo-network@57.0.2                # 本机 IP / 网段探测（判断是否同局域网）
（WebSocket 用 RN 内置，不引第三方重连库；自写指数退避 + 25s 心跳 + AppState 触发重连）
（relay 服务端建议 Node + ws，或直接复用 Paseo 的 Elixir relay 协议设计）

# ── UDP / Wake-on-LAN ────────────────────────────────────
# 无现成可用包。方案: 自写 inline Expo Module（Kotlin，DatagramSocket + setBroadcast(true)）
# 魔术包 = 6×0xFF + MAC×16 = 102 字节，UDP 端口 7 或 9，发往 255.255.255.255 或子网广播
# 参考实现: github.com/Benjaminlooi/WOLE (Expo + RN + Kotlin foreground service)
# 不要用 react-native-udp@4.1.7（2023-01 发布、无 TurboModule、新架构下未验证）

# ── 加密（全部纯 JS，无需 prebuild）────────────────────────
tweetnacl@1.0.3                    # Ed25519 签名 + XSalsa20-Poly1305 secretbox；Happy 生产在用
@noble/curves@2.4.0                # 现代替代（ESM；Metro 兼容性需实测）
@noble/ciphers@2.4.0               # XChaCha20-Poly1305 / AES-GCM
# 随机数: expo-crypto 的 getRandomValues（RN 无内置 crypto.getRandomValues）
# 不用 libsodium-wrappers@0.8.4（WASM，RN 上需额外 polyfill）

# ── 可选 / 进阶 ──────────────────────────────────────────
expo-background-task@57.0.21       # 仅用于"补拉遗漏消息"，最小间隔 15min，不能维持长连接
@react-native-community/netinfo    # （Expo 文档收录的第三方库）网络状态变化触发重连
```

**协议与安全（照搬 Happy 的已验证结构）**：

- 密钥层级：`master_secret`(手机本地,32B) → content keypair → session/machine DEK(AES-256)。
- 配对：电脑显示 QR，内含 **一次性公钥 + 一次性 room + TTL 120s + 电脑长期公钥 + 签名**；**不放任何私钥**。
- 认证：challenge-response（设备自选 challenge + 自签名 + 公钥，一次往返）。
- 加密：每条消息独立 24B nonce 的 secretbox / XChaCha20-Poly1305；`seq` 单调防重放。
- 信封不含可读类型字段；relay 保持 "dumb"。

---

## 7. 风险与替代方案

| # | 风险 | 严重度 | 触发条件 | 替代方案 |
| --- | --- | --- | --- | --- |
| R1 | **UDP / WoL 无免原生方案**，且手写 inline module 也需 prebuild | 🔴 高 | 一定发生 | ① 内联 Kotlin 模块（推荐）；② 若彻底不想碰原生 → **换 Flutter**（`RawDatagramSocket` 是标准库）；③ 或把 WoL 完全交给**电脑端/家里常开设备/路由器**代发，手机只发 HTTP 指令 |
| R2 | **手机在 4G/5G 时无法广播到家里局域网** | 🔴 高 | 用户在户外想远程开机 | 家里必须有一台**常开设备**（NAS/树莓派/已开机的另一台电脑）代发魔术包；或依赖路由器自带 WoL 功能（如 OpenWrt 的 `etherwake`）。**这是物理限制，无软件解法** |
| R3 | **`@noble/*` 2.x 是纯 ESM**，Metro 解析可能出问题 | 🟡 中 | 引入时 | 直接用 `tweetnacl@1.0.3`（CJS，Happy 生产验证） |
| R4 | **`expo-background-task` 无法维持长连接**（最小 15min，iOS 系统随意） | 🟡 中 | 期望"手机永远在线" | 改用「推送唤醒 + 回前台立即重连 + 服务端存密文补拉」（Happy 模型）。Android 上若要常驻需前台服务 + 常驻通知 |
| R5 | **iOS 加分项需要 Apple Developer 账号（$99/年）** | 🟡 中 | 要上 TestFlight/App Store | 只做 Android 自建 APK；iOS 用 `npx expo run:ios` 只在自己设备上跑 |
| R6 | **Tailscale 需要手机装额外 VPN App**，与"依赖最少"目标冲突 | 🟡 中 | 选 (c) 方案 | 优先做自建 relay（方案 a）作为默认；Tailscale 只作为进阶选项 |
| R7 | **自建 relay 意味着你要长期运维一台服务器** | 🟡 中 | 选 (a) 方案 | ① 用便宜 VPS；② 提供 Docker 一键自托管给愿意折腾的用户；③ 纯局域网模式作为无服务器兜底 |
| R8 | **Expo SDK 每年 3 次大版本**，升级有回归风险（SDK 56 就是活例子：Hermes V1 内存回归） | 🟡 中 | 每次 SDK 升级 | 钉死 `expo@57.0.28`；升级前读 changelog 的 "Known Regressions"；CNG 模式下 `android/` 可再生，回滚成本低 |
| R9 | **`expo-barcode-scanner` 生态里仍有教程/代码在用**，容易误引入 | 🟢 低 | 抄示例代码时 | 已确认该包停在 13.0.1、文档 404。只写 `expo-camera` |
| R10 | **`expo-file-system` 旧 API 会在运行时报错**（文档原文 "will throw in runtime"），不是警告 | 🟡 中 | 抄旧教程 | 全部改用 `File`/`Directory`/`Paths`；必须用旧的走 `expo-file-system/legacy` |
| R11 | **`react-native-udp@4.1.7` 在新架构下行为未验证** | 🟢 低（已规避） | 有人图省事引入 | 已明确不采用；`react-native-udp-turbo@0.1.4` 仅 Android 且未在 RN 0.86 验证 |
| R12 | **Paseo 的加密/连通性文档未能抓取**（`paseo.sh` 两次 fetch failed） | 🟢 低 | 想参考 Paseo 详细设计 | 改用 Happy 的文档（完整可读）；或后续直接在浏览器里看 paseo.sh/docs/security |

### 7.1 「我就是要最少原生代码」的极端替代路径

如果 R1（UDP 需原生）是不可接受的：

1. **WoL 全部外包给电脑端 / 家里常开设备**：手机永不发 UDP。手机只通过 relay 发一条 `{t:'power', action:'wol'}` 给那台常开设备，由它（Node 的 `dgram`，零原生）发魔术包。
   - 代价：家里必须有一台常开设备。
   - 收益：**手机端 100% 纯 Expo，零原生代码，甚至可以走 Expo Go 快速原型。**
2. **换 Flutter**：`RawDatagramSocket` 是 Dart 标准库，WoL 零原生代码。代价是放弃 Happy/Paseo 的可借鉴性（RN 系）与 Expo 的生态。
3. **WebView 里跑 WoL**：不可行，浏览器没有 UDP API。

### 7.2 未验证事项（诚实声明）

- Paseo 的端到端加密细节与连通性方案（`paseo.sh/docs/security`、`/docs/connectivity` **两次抓取均失败**）。
- Happy 手机 App 当前实际使用的 Expo SDK 版本（只抓到 lockfile 里的 `expo@55.0.8` / `react-native@0.83.1`，**可能已过时**）。
- `react-native-udp@4.1.7` 在 RN 0.86 新架构下是否能跑（无可靠证据，故规避）。
- `react-native-udp-turbo@0.1.4` 在 RN 0.86 上的可用性（包内 devDep 为 RN 0.79.2，仅有 Android 支持）。
- `@noble/curves`/`@noble/ciphers` 的 ESM 在 Metro（SDK 57 默认配置）下是否开箱可解析。
- `react-native-get-random-values` 的当前版本与维护状态。
- ZeroTier 免费额度（定价页抓取失败）。
- cloudflared Quick Tunnel 对 WebSocket 的支持（官方文档只列了"不支持 SSE"，未提 WebSocket，**推断可行但未证实**）。
- `expo-udp` 包的实际 API、维护状态与可用性。

---

## 8. 附：本次调研抓取来源汇总

**Expo / React Native**
- [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57)（2026-06-30）
- [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56)（2026-05-21）
- [React Native 0.84 release blog](https://reactnative.dev/blog/2026/02/11/react-native-0.84)（2026-02-11）
- [React Native releases overview](https://reactnative.dev/releases/overview)
- [Run EAS Build locally with --local flag](https://docs.expo.dev/build-reference/local-builds/)（页面更新 2026-09-17）
- [Build APKs for Android Emulators and devices](https://docs.expo.dev/build-reference/apk/)
- [expo-camera 文档](https://docs.expo.dev/versions/latest/sdk/camera/)
- [expo-file-system 文档](https://docs.expo.dev/versions/latest/sdk/filesystem/)
- [expo-background-task 文档 (v57)](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/)
- [Expo SDK 模块索引](https://docs.expo.dev/versions/latest/)
- [expo-barcode-scanner `.md` → 404](https://docs.expo.dev/versions/latest/sdk/bar-code-scanner.md)（证明该模块已从当前 SDK 移除）

**npm registry（版本证据，均抓取于 2026-10-13）**
- [expo](https://registry.npmjs.org/expo/latest) `57.0.28` · [expo-camera](https://registry.npmjs.org/expo-camera/latest) `57.0.6` · [expo-sqlite](https://registry.npmjs.org/expo-sqlite/latest) `57.0.4`
- [expo-file-system](https://registry.npmjs.org/expo-file-system/latest) `57.0.7` · [expo-sharing](https://registry.npmjs.org/expo-sharing/latest) `57.0.23` · [expo-intent-launcher](https://registry.npmjs.org/expo-intent-launcher/latest) `57.0.1`
- [expo-secure-store](https://registry.npmjs.org/expo-secure-store/latest) `57.0.4` · [expo-network](https://registry.npmjs.org/expo-network/latest) `57.0.2` · [expo-background-task](https://registry.npmjs.org/expo-background-task/latest) `57.0.21`
- [expo-barcode-scanner](https://registry.npmjs.org/expo-barcode-scanner/latest) `13.0.1`（已停更）
- [react-native-udp](https://registry.npmjs.org/react-native-udp/latest) `4.1.7`（2023-01） · [react-native-udp-turbo](https://registry.npmjs.org/react-native-udp-turbo/latest) `0.1.4`
- [react-native-mmkv](https://registry.npmjs.org/react-native-mmkv/latest) `4.3.2` · [async-storage](https://registry.npmjs.org/@react-native-async-storage/async-storage/latest) `3.1.1`
- [qrcode](https://registry.npmjs.org/qrcode/latest) `1.5.4` · [tweetnacl](https://registry.npmjs.org/tweetnacl/latest) `1.0.3` · [@noble/curves](https://registry.npmjs.org/@noble/curves/latest) `2.4.0` · [@noble/ciphers](https://registry.npmjs.org/@noble/ciphers/latest) `2.4.0` · [libsodium-wrappers](https://registry.npmjs.org/libsodium-wrappers/latest) `0.8.4`

**参考项目（星数经 GitHub API 核实，2026-10-13）**
- [slopus/happy](https://github.com/slopus/happy) 24,126★ · [happy-server](https://github.com/slopus/happy-server) 368★（archived）
- [getpaseo/paseo](https://github.com/getpaseo/paseo) 20,723★ · [paseo-relay](https://github.com/getpaseo/paseo-relay) 103★（Elixir/WebSocket）
- [omnara-ai/omnara](https://github.com/omnara-ai/omnara) 2,909★
- [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) 28,344★
- [blamechris/chroxy](https://github.com/blamechris/chroxy) 7★
- [Benjaminlooi/WOLE](https://github.com/Benjaminlooi/WOLE) 4★（Expo + RN + Kotlin，WoL + 前台服务）
- [cducote/remoteCC](https://github.com/cducote/remoteCC) 9★ · [Flux159/claude-code-go](https://github.com/Flux159/claude-code-go) 24★

**加密架构**
- [Happy: How It Works](https://happy.engineering/docs/how-it-works/)
- [Happy: Security & Encryption](https://happy.engineering/docs/security/)
- [Happy E2E Encryption（Mintlify 自动生成）](https://mintlify.wiki/slopus/happy/features/encryption)

**联网可达性**
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)（页面更新 2026-09-30）
- [Tailscale 定价](https://tailscale.com/pricing)
- [NetBird 移动客户端文档](https://docs.netbird.io/get-started/install/mobile)
- [ZeroTier 定价](https://www.zerotier.com/pricing)（**抓取失败，未验证**）
