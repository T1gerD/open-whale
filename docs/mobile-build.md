# 手机端本地出包（Android APK）

手机应用在 [`packages/mobile`](../packages/mobile)。这里只讲**怎么把它装到手机上**；应用内部结构、测试与设计取舍见
[packages/mobile/README.md](../packages/mobile/README.md)。

技术路线：**Expo SDK 57 + CNG（prebuild）+ Gradle 本地出包**，不使用 EAS 云构建，也不需要 Expo 账号。

## 前置环境

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.11 | 本项目在 v24.21.0 上验证过 |
| JDK | 17 | Gradle 与 Android 工具链要求 |
| Android SDK | platform-tools、build-tools、cmdline-tools | 并设置环境变量 `ANDROID_HOME` |
| pnpm | 9.x | 本仓库是 pnpm workspace |

> `eas build --local` **不要用**：Expo 官方文档明确其不支持 Windows，且仍需登录 Expo 账号（或提供 `EXPO_TOKEN`）。上面的 prebuild + gradlew 路线官方支持、无需账号、可完全离线。

## 出包步骤（Windows）

```powershell
# 1) 仓库根：安装依赖
cd open-whale
pnpm install

# 2) 对齐版本（重要）
cd packages\mobile
npx expo install --fix

# 3) 生成原生工程
npx expo prebuild --platform android --clean

# 4) 出 release APK
cd android
.\gradlew assembleRelease
# 产物：android\app\build\outputs\apk\release\app-release.apk
```

### 为什么第 2 步是必须的

`packages/mobile/package.json` 中有一部分 Expo 包的版本写成了 `*`（`expo-router`、`expo-constants`、
`expo-linking`、`expo-status-bar`、`expo-crypto`、`expo-document-picker`、`react-native-screens`、
`react-native-safe-area-context`）。这些版本号在开发这台机器上**没有联网核实**，`*` 保证能装上，
`npx expo install --fix` 会把它们改写成 SDK 57 对应的确切版本。

## 安装到手机

```powershell
# 手机开启「USB 调试」并连接，或直接把 APK 拷进手机点击安装
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

首次安装需要在手机上允许「安装未知来源应用」。

## 调试

```powershell
cd packages\mobile
pnpm android        # 装一次 dev build（Expo Go 跑不了本项目，因为含自定义原生模块）
```

## 签名

- 自用调试：release APK 未配置签名时 Gradle 会用 debug keystore，能装能跑。
- 正式分发：在 `android/app/build.gradle` 里配置 `signingConfigs`，并妥善保管 keystore。

## 已知限制与未验证项

以下内容在开发环境（没有 Android SDK、没有真机）中**无法验证**，出包时请预留时间：

1. **UI 层与所有 Expo 原生模块调用都未在真机运行过**：`expo-camera`（扫码）、`expo-sqlite`、`expo-secure-store`、
   `expo-file-system`、`expo-sharing`、`expo-document-picker`。
2. `tsc --noEmit` 未跑过；Metro 对 `.mts` 与跨包 `@openwhale/protocol` alias 的解析未验证。
3. `expo-file-system` 新 API 的具体方法名（`File.write` / `base64` / `downloadFileAsync`）未在设备上确认。
4. **尚未实现**：Wake-on-LAN 原生模块（`src/core/wake.mts` 只做引导与规划，不发魔术包）、
   后台保活、手机 → 电脑的大文件分块上传、iOS 上架。
5. 若扫码失败，应用内提供「手动粘贴二维码内容」入口作为兜底。

## 纯逻辑测试（不需要 Android SDK）

核心逻辑（配对校验、消息 reducer、离线队列、退避、base64、帧契约等）是零依赖的 `.mts`，
用 Node 原生类型剥离即可跑：

```powershell
cd packages\mobile
node test\run.mjs          # 88 项
node scripts\check-syntax.mjs
```

这也是本项目在无 Android 环境下能给出的最强保证：**业务逻辑有测试，UI 与原生调用没有。**
