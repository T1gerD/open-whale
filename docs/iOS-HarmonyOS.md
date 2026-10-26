# iOS 与鸿蒙适配（v2.2.0）

> 本文回答三件事：**iOS 怎么出包/分发**、**鸿蒙（HarmonyOS NEXT）这条 RN 路线现在为什么走不通、
> 替代方案是什么**、**网页版（PWA）怎么用**。
>
> 结论只依赖下文的可点击来源。仓库里的验证状态：[x] 表示本机已跑通/已有测试，
> [~] 表示本机 Windows 无法真机验证（已写清验证方法），[ ] 表示待办。
>
> 相关文件：
> [`packages/mobile/app.json`](../packages/mobile/app.json)（iOS 配置）、
> [`packages/mobile/eas.json`](../packages/mobile/eas.json)（EAS profiles）、
> [`.github/workflows/ios.yml`](../.github/workflows/ios.yml)（模拟器 CI）、
> [`packages/webchat/`](../packages/webchat)（网页版/PWA 客户端）。

## 0. 结论速览

| 议题 | 结论 |
|---|---|
| iOS 代码配置 | 只差 `app.json` 的 `ios` 段（bundleIdentifier/buildNumber/权限文案/scheme）+ `eas.json`；**本仓库已补齐** |
| iOS 构建 | **必须 macOS**（Expo 官方不支持 Windows 本地构建）。首选 **EAS Build 云构建**；没有 Apple 账号时用 **GitHub Actions `macos-15` 出模拟器 .app** 做冒烟 |
| iOS 真机分发 | TestFlight / App Store 需要付费 Apple Developer Program（约 $99/年）；ad hoc 内测还需收集每台设备 UDID |
| 鸿蒙 RN 原生 | **`@react-native-oh/react-native-harmony` 没有 0.86**（最新 0.84.4，0.86 仍在路线图）；本项目 RN 0.86.3 + Expo SDK 57 **无法用 RNOH 原生跑鸿蒙** |
| 鸿蒙本月可用 | **网页版（PWA）+ 系统浏览器打开** 或 **DevEco Studio 里写一个 ArkTS `Web` 壳**（Windows 上就能出 HAP） |

## 1. iOS：代码侧配置（已完成）

`packages/mobile/app.json` 的 iOS 段：

```jsonc
"ios": {
  "bundleIdentifier": "dev.openwhale.app",
  "buildNumber": "1",              // 每次上传 TestFlight 必须递增；EAS production profile 会自动 +1
  "supportsTablet": false,
  "config": { "usesNonExemptEncryption": false }, // 免出口合规问答，少一轮审核往返
  "infoPlist": {
    "NSCameraUsageDescription": "…扫描电脑上的绑定二维码。",
    "NSPhotoLibraryUsageDescription": "…识别你截图里的绑定二维码。",
    "NSPhotoLibraryAddUsageDescription": "…把聊天里收到的图片保存到相册。",
    "NSLocalNetworkUsageDescription": "…访问局域网，连接同一 Wi-Fi 下的电脑。",
    "NSAppTransportSecurity": { "NSAllowsLocalNetworking": true } // 允许连局域网 http（插件只有 http/ws）
  }
}
```

同时 `expo.userInterfaceStyle` 从 `"dark"` 改为 `"automatic"`：手机端 UI 现在以浅色为主、
深色跟随系统，写死 dark 会让 iOS 上 `useColorScheme()` 永远返回 dark，浅色主题出不来。
根级 `scheme: "openwhale"` 保持不变（`openwhale://` 深链，未来扫码回跳 App 用）。

> 注意：`expo-image-picker` 插件配置需要 `packages/mobile/package.json` 里真的有这个依赖
> （手机端相册识图由 mobile-core 引入 `expo-image-picker`）；prebuild 时缺依赖会直接报错。

## 2. iOS：三条出包路径

### 2.1 EAS Build → TestFlight（推荐，正式分发）

前提：免费 Expo 账号 + **付费 Apple Developer Program**（TestFlight/App Store 必须）。
全程在 Windows 上执行，构建发生在 Expo 的 macOS 云端。

```bash
cd packages/mobile
pnpm dlx eas-cli@latest login          # 浏览器登录 Expo
pnpm dlx eas-cli@latest build -p ios --profile production
# 首次会引导生成/上传 iOS Distribution 证书与 provisioning profile（EAS 代管）
pnpm dlx eas-cli@latest submit -p ios --profile production
# 之后到 App Store Connect → TestFlight 添加测试员
```

`eas.json` 里的 profile：

| profile | 用途 | 需要 Apple 付费账号？ | 产物 |
|---|---|---|---|
| `development` | 开发客户端（模拟器），调原生模块 | 否 | 模拟器 .app / dev client |
| `simulator` | 模拟器专用冒烟 | **否** | 模拟器 .app |
| `preview` | ad hoc 真机内测（按 UDID 注册） | 是（+ UDID） | .ipa |
| `production` | TestFlight / App Store；`autoIncrement` | 是 | .ipa |

`submit.production.ios.ascAppId` 目前是占位 `0000000000`：在 App Store Connect 建好应用后，
填真实的 App Apple ID，或直接用交互式 `eas submit`。

### 2.2 GitHub Actions 模拟器冒烟（免费，无 Apple 账号）

工作流：[`.github/workflows/ios.yml`](../.github/workflows/ios.yml)

- runner：`macos-15`；步骤：`pnpm install` → `expo prebuild --platform ios` →
  `pod install` → `xcodebuild -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO` →
  把 `Debug-iphonesimulator/*.app` 打成 zip 上传 artifact。
- **触发条件**：
  1. `workflow_dispatch`：手动，任意分支；
  2. `pull_request`：改到 `packages/mobile/**` 或本工作流时；
  3. `push tag v*`：发版时留一份模拟器包。
  私有仓库 macOS 分钟按 Linux 的约 10 倍计费，所以没有用 `push: main` 全量触发。
- **产物**：`open-whale-ios-simulator-<sha>`（zip，内含未签名 `.app`）。
- **能验证什么**：`app.json` 配置、prebuild 生成的原生工程、CocoaPods 依赖、Xcode 编译是否通过。
- **不能做什么**：未签名 `.app` 只能装 macOS 上的 iOS Simulator，装不了真机，也不能上架。
- 在 macOS 上装模拟器包：

  ```bash
  unzip open-whale-ios-simulator-<sha>.zip
  xcrun simctl boot "iPhone 16" || open -a Simulator
  xcrun simctl install booted "Open Whale.app"
  xcrun simctl launch booted dev.openwhale.app
  ```

  真机安装需要签名（见 2.1 或 2.3），这是 iOS 平台的硬约束，不是配置问题。

### 2.3 本地 macOS 构建（团队没有 Mac 时仅作备用）

```bash
# macOS + Xcode 16+ + CocoaPods
cd packages/mobile
pnpm install
npx expo prebuild --platform ios --clean
cd ios && pod install
# 模拟器：
xcodebuild -workspace *.xcworkspace -scheme OpenWhale \
  -configuration Debug -sdk iphonesimulator -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
# 真机：用 Xcode 打开 .xcworkspace，登录 Apple ID，选择 Team 后 Run（免费账号 7 天有效）
```

Windows 上**不能**本地构建 iOS：Expo 官方文档明确本地构建只支持 macOS/Linux
（<https://docs.expo.dev/build-reference/local-builds/>）。

## 3. 鸿蒙（HarmonyOS NEXT）：为什么 RN 原生路线暂缓

### 3.1 硬门槛：RNOH 没有 0.86

| 事实（核验于 2026-10-26） | 数据 |
|---|---|
| 华为官方 RN 适配包 | `@react-native-oh/react-native-harmony` 最新 **0.84.4**（2026-09-24） |
| dist-tags | `0.84-rc: 0.84.4`、`0.82-stable: 0.82.30`、`0.77-stable`、`0.72-stable` —— **没有任何 0.86** |
| peerDependencies | `0.84.4 → react-native@0.84.1`（精确钉死） |
| 路线图 | 0.82 适配中、0.84（2026 Q2）、**0.86（Q3「规划中」，截至核验日未交付）** |
| 本项目 | Expo SDK 57 / **RN 0.86.3** |

来源：<https://www.npmjs.com/package/@react-native-oh/react-native-harmony>、
<https://gitcode.com/openharmony-RN/ohos_react_native>（路线图 `docs/zh-cn/roadmap.md`）。

结论：**要上 RN 原生鸿蒙，必须把 RN 降到 0.82.x 并等 RNOH 0.86**；而 Expo SDK 57 → 55 的降级
会连带 `expo-router` / `expo-sqlite` / React 19.2 全线回退，风险远大于收益。Expo 官方不支持鸿蒙；
社区 `expo-harmony` 目前只到 **Expo SDK 55 + RNOH 0.84.1**（<https://github.com/renbaoshuo/expo-harmony>）。

### 3.2 本月可行方案：网页版 PWA（推荐）或 ArkTS Web 壳

网页版客户端在 [`packages/webchat`](../packages/webchat)：零构建、原生 ESM，由插件在
`http://<电脑>:8787/openwhale/app` 静态提供。鸿蒙 NEXT 的浏览器（Chromium 内核）可以直接打开，
完成扫码绑定 → 聊天 → 收文件；也可以「添加到桌面」当 App 用。

> 为什么这条路成立：绑定的信任模型不依赖原生能力。密钥对在浏览器里生成（vendor tweetnacl），
> 首次用二维码里的一次性 `pairSecret` 绑定，之后用 Ed25519 签名 hello 重连；相册识图用
> `BarcodeDetector`（有则用）+ 纯 JS `jsQR` 兜底，都不需要原生模块。

**方案 A：直接用系统浏览器（0 开发量）**
1. 电脑上打开插件页 `http://<电脑IP>:8787/openwhale`；
2. 手机（鸿蒙）用**系统相机/浏览器扫码**扫页面上的「网页版」二维码；
3. 浏览器打开 `/openwhale/app#p=…` 自动绑定；菜单 →「添加到桌面」。

**方案 B：DevEco Studio 写一个 ArkTS `Web` 壳（3–5 人日，可出 HAP）**

Windows 上的 DevEco Studio 就能完成（无需 Mac）。最小工程改动：

```json5
// entry/src/main/module.json5（片段）
{
  "module": {
    "requestPermissions": [
      { "name": "ohos.permission.INTERNET" }
    ]
  }
}
```

```ts
// entry/src/main/ets/pages/Index.ets
import { webview } from '@kit.ArkWeb'

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController()

  build() {
    Column() {
      Web({
        // 把电脑插件页二维码里的完整地址贴进来，或运行时用扫码结果拼接：
        // `${baseUrl}/openwhale/app#p=${encodeURIComponent(payload)}`
        src: 'http://192.168.1.5:8787/openwhale/app',
        controller: this.controller,
      })
        .javaScriptAccess(true)   // 网页版需要 JS / ESM
        .domStorageAccess(true)   // 绑定身份与会话存在 localStorage
        .mixedMode(MixedMode.All) // http 页面内允许混合内容（调试期）
        .imageAccess(true)
        .onPageEnd(() => {
          // 可以在这里注入扫码结果，或监听 URL 变化
        })
    }
    .width('100%')
    .height('100%')
  }
}
```

注意事项（**待真机验证**，研究阶段标注过）：
- HarmonyOS NEXT 对明文 `http://` 是否默认拦截需要真机确认；若被拦，优先用
  Tailscale Serve 的 `https://` 地址（插件支持 Tailscale 一等公民），或在 DevEco 里配置
  应用级网络安全策略（`network_config`，参考华为「网络安全配置」文档）。
- 壳里没有系统相机权限时，可以让用户先把二维码截图存相册，再用网页版的「从相册识别二维码」。
- ArkWeb 同样受浏览器安全上下文约束：`http://` 下没有 Service Worker/离线壳，聊天功能不受影响。
- 上架华为应用市场需要应用资质审核（软著等），内测可用调试签名直接装真机。

### 3.3 不建议的路线（本版本）

- **RNOH 0.82 + 降级 Expo**：工作量大、回退风险高，且 0.86 发布后还要再改一次。
- **Taro / uni-app 重写**：UI 全量重写，且同样要吃鸿蒙构建链。
- **Flutter**：官方不支持鸿蒙，等于重写。

中期建议：等 RNOH 0.86 发布后，用 `expo-harmony` 类方案做 spike；网页版作为长期可用兜底。

## 4. 网页版使用说明（鸿蒙 / iOS / 任意浏览器）

### 4.1 首次绑定

1. 电脑与手机连到同一网络（同一 Wi-Fi，或都登录同一 Tailscale 账号；公网隧道最慢，最后选）。
2. 电脑打开 `<http://电脑IP>:8787/openwhale>`，找到「网页版」二维码。
3. 手机扫码打开 `http://<电脑>:8787/openwhale/app#p=…`：
   - 地址栏带 `#p=` → 自动解析并连接；
   - 也可以把链接/绑定 JSON 粘贴到输入框，或点「从相册识别二维码」选二维码截图。
4. 连接成功后页面会保留本机身份（localStorage），下次直接打开即自动重连。

### 4.2 添加到主屏幕

- **iOS Safari**：底部「分享」按钮 →「添加到主屏幕」→ 命名 Open Whale。之后从主屏幕打开是独立窗口。
- **鸿蒙 NEXT 浏览器**：右下角菜单 →「添加到桌面」。
- **Android Chrome**：菜单 →「安装应用 / 添加到主屏幕」。
- 说明：通过 `http://` 局域网地址打开时，浏览器不会注册 Service Worker（非安全上下文），
  即没有离线壳与安装横幅，但聊天、附件、相册识图都正常；用 https（Tailscale Serve）才完整 PWA。
  iOS 通过 Safari 手动「添加到主屏幕」在 http 下仍可用。

### 4.3 连不上时的排查顺序

1. 设置 → 连接：确认连接方式（自动/局域网/Tailscale/公网隧道）与当前地址；
   「测试地址」会请求 `GET /openwhale/health` 验证目标可达。
2. 手动地址输入 `电脑IP:8787`（可带 `http://`），添加后会自动重连。
3. 换网络路径：同一 Wi-Fi → Tailscale → 隧道。Tailscale 需要手机装 Tailscale 并登录同一账号。
4. 电脑端插件页重新生成二维码（10 分钟有效），手机重新扫码。
5. 网页版设置 →「解除绑定」后重新绑定可清掉本机旧身份。

## 5. 已知限制

- **真机验证缺口**：本机是 Windows，没有 iPhone / 鸿蒙真机，也没有 macOS；iOS 只验证到
  「配置 + CI 编译模拟器包」这一层，网页版只做了 Node 测试与桌面浏览器逻辑验证。
- **iOS 签名**：没有付费 Apple 账号就不能给别人装真机/发 TestFlight；模拟器 `.app` 不能装真机。
- **Expo Go 不能当交付方式**：本项目含自定义 config plugin 与（手机端后续引入的）相册识图原生模块，
  Expo Go 只适合临时验证纯 JS 页面。
- **网页版没有系统级推送**；iOS 后台会冻结页面，回到前台自动重连（设计如此）。
- **网页版存储**：聊天与设备身份在浏览器 localStorage；iOS 长期不用可能被系统清理，需要重新扫码。
  公共电脑上不要绑定。
- **鸿蒙原生（RNOH）**：等待上游 0.86；当前只能用 PWA/WebView 壳，体验不是原生。
- **明文 HTTP**：插件默认只提供 http/ws。iOS App 侧已加 `NSAllowsLocalNetworking`；
  鸿蒙 Web 壳的明文策略需真机确认。
- **UI 自动化**：网页版没有 E2E 浏览器测试（沙箱无 Chromium），只有纯逻辑单测；
  聊天 UI 的验收清单见 `packages/webchat/README.md`。

## 6. 验证清单

| 项 | 状态 | 怎么验证 |
|---|---|---|
| `app.json` iOS 段 / `eas.json` 合法 JSON(5) | [x] | `node -e "JSON.parse(...)"`（eas.json 注释用 JSON5） |
| iOS 模拟器 CI 能编译 | [~] | 推 tag 或手动跑 `.github/workflows/ios.yml`，取 artifact |
| EAS production 出 .ipa | [~] | 需要 Expo + Apple 付费账号：`eas build -p ios --profile production` |
| 网页版 Node 测试 | [x] | `node scripts/run-tests.mjs`（含 `packages/webchat/test/**`） |
| 网页版真机聊天/附件 | [~] | 按 `packages/webchat/README.md` 的「手动验证清单」在手机上走一遍 |
| 鸿蒙 ArkTS Web 壳 | [~] | DevEco Studio 新建空工程 → 上文片段 → 自动签名跑真机 |
| 鸿蒙明文 HTTP 策略 | [ ] | 真机验证；失败则改用 Tailscale https |

## 7. 来源

- Expo iOS 构建（macOS VM / fastlane / 产物路径）：<https://docs.expo.dev/build-reference/ios-builds/>
- EAS 模拟器 profile 不需要 Apple 账号：<https://docs.expo.dev/build-reference/simulators/>
- Windows 不支持本地 iOS 构建：<https://docs.expo.dev/build-reference/local-builds/>
- TestFlight / eas submit：<https://docs.expo.dev/submit/ios/>
- app.json iOS 键（bundleIdentifier/buildNumber/infoPlist）：<https://docs.expo.dev/versions/v57.0.0/config/app/#ios>
- GitHub Actions macOS runner 标签与计费：<https://docs.github.com/en/actions/reference/runners/github-hosted-runners>、
  <https://docs.github.com/en/billing/reference/actions-runner-pricing>
- Apple 会员类型（TestFlight 需付费）：<https://developer.apple.com/support/compare-memberships/>
- RNOH 版本/路线图：<https://www.npmjs.com/package/@react-native-oh/react-native-harmony>、
  <https://gitcode.com/openharmony-RN/ohos_react_native>
- 华为官网 RN 指南：<https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/react-native>
- ArkTS `Web` 组件：<https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-web>
- `expo-harmony`（SDK 55 + RNOH 0.84.1）：<https://github.com/renbaoshuo/expo-harmony>
- 相册识图与 jsQR 兜底结论：`_gh/research/R1-qr-crossplatform.md`（研究产出，不随仓库发布）
