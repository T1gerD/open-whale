# 手机端 Release 体积优化（2026-10-24）

> 背景：APK 曾经 128.9 MB，装到手机上“应用大小”超过 100 MB。这里是最终配置与实测结果。
> 注意：`packages/mobile/android/` 在 `.gitignore` 里（Expo prebuild 产物），所以下面的配置**不在仓库里**，需要在新机器上重新设置。

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
