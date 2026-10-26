# 手机端 Release 体积优化（2026-10-24）

> 背景：APK 曾经 128.9 MB，装到手机上“应用大小”超过 100 MB。这里是最终配置与实测结果。
>
> **v2.2.0 更新**：`packages/mobile/android/` 是 `.gitignore` 里的 prebuild 产物，手工改它
> 不会被 CI 继承——v2.2.0 首次 CI 构建又回到了 126 MB。现在这些设置由
> [`packages/mobile/plugins/withReleaseSize.js`](../packages/mobile/plugins/withReleaseSize.js)
> 这个 config plugin 在 prebuild 阶段写入（gradle properties 含 `reactNativeArchitectures=arm64-v8a`、
> release 的 `abiFilters`、R8 开关与 keep 规则），**源码即事实来源**，本地与 CI 行为一致。
> 注意只写 `abiFilters` 不够：实测 CI 产物仍带 4 个 ABI（lib 合计 101 MB），必须同时设置
> `reactNativeArchitectures`。下面保留 v2.1.0 的手工步骤
> 作为历史记录与对照。

## 最终配置

`packages/mobile/android/gradle.properties`：

```properties
# 1) 只保留 arm64（真机全是 64 位；x86/x86_64 是模拟器用，armeabi-v7a 是老 32 位机）
reactNativeArchitectures=arm64-v8a

# 2) 开启 R8 代码压缩与资源裁剪
android.enableMinifyInReleaseBuilds=true
android.enableShrinkResourcesInReleaseBuilds=true
```

`packages/mobile/android/app/proguard-rules.pro`（在模板原有两条 keep 之外补充）：

```proguard
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class expo.modules.** { *; }
-keep class expo.** { *; }
-keep class dev.openwhale.** { *; }
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod <methods>;
    @com.facebook.react.bridge.ReactProp <methods>;
}
-keep class com.facebook.hermes.unicode.** { *; }
-dontwarn com.facebook.hermes.**
```

## 实测结果

| 阶段 | APK | classes*.dex | 解压总量 |
| --- | --- | --- | --- |
| 最初（4 个 ABI，无 R8） | 128.9 MB | 48.9 MB | 153.7 MB |
| 去掉 x86 / x86_64 | 66.7 MB | 48.9 MB | 98.5 MB |
| 只保留 arm64 | 49.5 MB | 48.9 MB | 81.0 MB |
| **再开 R8（当前）** | **39.7 MB** | **20.7 MB** | **52.2 MB** |

手机上 `base.apk` 实际大小 41.6 MB。

## 回归测试（adb 实测，2026-10-24）

| 项 | 结果 |
| --- | --- |
| 冷启动 / 首页 | 通过 |
| 进入会话、历史渲染、滚动到末条 | 通过 |
| 发消息 → 电脑收到 → AI 回复显示 | 通过 |
| 打开设置页、保存昵称并同步到电脑 | 通过 |

## 尚未验证（换包或比赛前建议点一遍）

- 扫码绑定新设备
- 文件/图片收发
- 飞行模式下的离线队列与恢复重连
- 多设备同时在线

## 回滚

删掉上面两条 `android.enable*`，把 `reactNativeArchitectures` 改回 `arm64-v8a,armeabi-v7a`，重新 `assembleRelease` 即可。
