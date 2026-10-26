// 只发布 arm64 的 release 包，并打开 R8 代码/资源压缩。
//
// 背景：`android/` 是 prebuild 产物、不进仓库，所以 CI 用 `expo prebuild` 重新生成
// 工程时不会带上「v2.1.0 手工瘦身」的那些 gradle 改动 —— 于是 CI 打出来的 APK 是
// 全 ABI + 未压缩的通用包（v2.2.0 首次 CI 构建 = 126 MB）。这个 config plugin 把
// 瘦身设置写进生成的工程，让「源码」重新成为唯一事实来源：
//
//  1. gradle properties
//       android.enableMinifyInReleaseBuilds=true      → release 打开 R8
//       android.enableShrinkResourcesInReleaseBuilds=true → 删除无用资源
//  2. release buildType 的 `ndk.abiFilters` 只保留 `arm64-v8a`
//
// 只作用于 **release** buildType：debug 包保留全部 ABI，模拟器/开发机不受影响。
// 代价是 release APK 不能装 x86_64 模拟器；真要模拟器调试请装 debug 包。
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require('@expo/config-plugins')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

/** 该插件对 app/build.gradle 的期望改动，导出以便测试断言。 */
const RELEASE_ABI_FILTERS = 'arm64-v8a'

/** 需要写入的 gradle properties（键 → 值）。 */
const RELEASE_GRADLE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  // 关键：RN/Expo 的 native 库按这个属性决定**打包哪些 ABI**。只写
  // buildType.release.ndk.abiFilters 是不够的 —— 实测 CI 产物仍然带全部 4 个 ABI
  // （lib 合计 101 MB）。这个属性同时决定编译与打包的 ABI 集合。
  // 代价：debug 包也只剩 arm64，x86_64 模拟器需要时临时改回。
  reactNativeArchitectures: 'arm64-v8a',
}

/**
 * R8 的 keep 规则。
 *
 * 这套规则来自 v2.1.0 手工瘦身并实测可用的配置（见 docs/RELEASE-SIZE.md）；模板自带的
 * proguard 规则只覆盖 RN 的一部分，Expo modules 与 Hermes 的反射入口需要显式保留，
 * 否则 release 包可能启动即崩（而 CI 没有真机回归，只能在规则上保守）。
 */
const PROGUARD_RULES = `
# --- Open Whale (v2.2.0, injected by plugins/withReleaseSize.js) ---
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
`

function withReleaseGradleProperties(config) {
  return withGradleProperties(config, cfg => {
    const props = cfg.modResults
    const upsert = (key, value) => {
      const existing = props.find(item => item.type === 'property' && item.key === key)
      if (existing) {
        existing.value = value
        return
      }
      props.push({ type: 'property', key, value })
    }
    for (const [key, value] of Object.entries(RELEASE_GRADLE_PROPERTIES)) upsert(key, value)
    return cfg
  })
}

function withArm64ReleaseOnly(config) {
  return withAppBuildGradle(config, cfg => {
    let contents = cfg.modResults.contents
    if (contents.includes('abiFilters')) {
      // 已经有人（或未来的 RN 模板）设置了；不要重复注入。
      cfg.modResults.contents = contents
      return cfg
    }
    // 生成的模板是 `buildTypes { debug { … } release { … } }`，release 前面还夹着
    // debug 块，所以不能用一个「buildTypes 紧跟 release」的正则。先定位 buildTypes，
    // 再在它的后半段里替换**第一个** `release {` —— 那就是 release buildType。
    const buildTypesAt = contents.indexOf('buildTypes')
    if (buildTypesAt < 0) {
      throw new Error(
        'withReleaseSize: 没在 app/build.gradle 里找到 `buildTypes`，' +
          '无法只对 release 限定 ABI —— 请更新这个插件。',
      )
    }
    const head = contents.slice(0, buildTypesAt)
    const tail = contents.slice(buildTypesAt)
    const injected = tail.replace(/(\brelease\s*\{)/, match => {
      return `${match}
            // 只发布 arm64（绝大多数手机）；debug 构建仍保留全部 ABI。
            ndk {
                abiFilters "${RELEASE_ABI_FILTERS}"
            }`
    })
    if (injected === tail) {
      throw new Error(
        'withReleaseSize: 在 buildTypes 之后没找到 `release {`，' +
          '无法只对 release 限定 ABI —— 请更新这个插件。',
      )
    }
    cfg.modResults.contents = head + injected
    return cfg
  })
}

module.exports = function withReleaseSize(config) {
  const withRules = withDangerousMod(config, [
    'android',
    cfg => {
      const file = join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro')
      const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (!current.includes('Open Whale (v2.2.0, injected by plugins/withReleaseSize.js)')) {
        appendFileSync(file, PROGUARD_RULES)
      }
      return cfg
    },
  ])
  return withArm64ReleaseOnly(withReleaseGradleProperties(withRules))
}

module.exports.RELEASE_ABI_FILTERS = RELEASE_ABI_FILTERS
module.exports.RELEASE_GRADLE_PROPERTIES = RELEASE_GRADLE_PROPERTIES
module.exports.PROGUARD_RULES = PROGUARD_RULES
