// 本地 config plugin 的「契约」测试 —— 用桩替换 @expo/config-plugins。
//
// 背景：`plugins/withCleartextTraffic.js` 曾经把 `withAndroidManifest(cfg => …)`
// 写成少一个参数的形式。`@expo/config-plugins` 的签名是
// `withAndroidManifest(config, action)`，少传 config 时回调被当成 config，
// 返回的对象里只剩 `{ mods }` —— `name` 与 `_internal.projectRoot` 双双丢失。
// 而 `withStaticPlugin` 在应用**后续**静态插件时会断言
// `config._internal.projectRoot` 存在，于是整个 app.json 的 plugins 数组处理中途抛
//
//   AssertionError [ERR_ASSERTION]: Unexpected: Config `_internal.projectRoot`
//   isn't defined by expo-cli, this is a bug.
//
// 报错文本指向 Expo 自己，实际根因在本地插件里，很容易被误判成上游 bug（这次就
// 让 v3.0.10 的 iOS 与 release 两个 job 同时变红）。所以这里不依赖真实的
// @expo/config-plugins（CI 的 tests job 不装依赖），而是把模块替换成桩，
// 断言两件事：
//   1. 每个导出 API 的第一个参数必须是 config 对象，不能是回调；
//   2. 插件处理完之后 config 仍然带着 `_internal.projectRoot`（以及 name 等字段）。
//
// 任何新写的本地插件都应满足这两条，否则 prebuild 会以「Expo 的 bug」的形式失败。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = fileURLToPath(new URL('../plugins/', import.meta.url))
const requireFromHere = createRequire(import.meta.url)

/** 记录每次调用，便于断言「第一个参数是 config 对象」。 */
const calls = []

/**
 * 桩：模拟 config-plugins 的 `with*` 一族。签名统一是 `(config, action)`，
 * 返回的对象必须保留传入 config 的全部字段（真实实现也是 `{ ...config, mods }`）。
 */
const stubConfigPlugins = new Proxy(
  {},
  {
    get(_target, name) {
      if (name === '__esModule') return false
      if (typeof name !== 'string') return undefined
      // 只暴露 `with…` 形式的 API，其它属性保持 undefined，免得插件误用不存在的导出。
      if (!name.startsWith('with')) return undefined
      const api = (config, action) => {
        // 真实 API 有两种形态：`withAndroidManifest(config, fn)` 与
        // `withDangerousMod(config, ['android', fn])`。两者都要落到 mods.android 下。
        const explicit = Array.isArray(action) ? action[0] : undefined
        const platform = explicit ?? (/Android|Gradle/.test(name) ? 'android' : undefined)
        calls.push({ api: name, config, action, platform })
        assert.equal(
          typeof config,
          'object',
          `${name}(config, action) 的第一个参数必须是 config 对象，实际是 ${typeof config}`,
        )
        assert.notEqual(config, null, `${name}(config, action) 的第一个参数不能是 null`)
        const mods = { ...(config.mods ?? {}) }
        if (platform) mods[platform] = { ...(mods[platform] ?? {}), [name]: action }
        else mods[name] = action
        return { ...config, mods }
      }
      return api
    },
  },
)

/** 在一个 `@expo/config-plugins` 被替换成桩的环境里加载插件。 */
function loadPluginWithStub(file) {
  const original = Module._load
  Module._load = function patched(request, ...rest) {
    if (request === '@expo/config-plugins') return stubConfigPlugins
    return original.call(this, request, ...rest)
  }
  try {
    const resolved = requireFromHere.resolve(file)
    delete requireFromHere.cache[resolved]
    return requireFromHere(resolved)
  } finally {
    Module._load = original
  }
}

const pluginFiles = readdirSync(pluginDir)
  .filter(name => name.endsWith('.js'))
  .sort()

/** 一份和 prebuild 里长得很像的 config：带 _internal.projectRoot 与 name。 */
function fakeConfig() {
  return {
    name: 'Open Whale',
    slug: 'open-whale',
    version: '0.0.0',
    plugins: [],
    _internal: {
      projectRoot: '/tmp/open-whale/packages/mobile',
      isDebug: false,
    },
  }
}

for (const file of pluginFiles) {
  test(`plugins/${file} 保留 config 的字段（含 _internal.projectRoot）`, () => {
    calls.length = 0
    const plugin = loadPluginWithStub(join(pluginDir, file))
    assert.equal(typeof plugin, 'function', `${file} 应导出一个插件函数`)

    const config = fakeConfig()
    const result = plugin(config)

    assert.equal(typeof result, 'object', `${file} 必须返回 config 对象`)
    assert.notEqual(result, null)
    assert.equal(result.name, config.name, `${file} 丢掉了 name`)
    assert.ok(
      result._internal && result._internal.projectRoot,
      `${file} 丢掉了 _internal.projectRoot —— 后面的静态插件会因此断言失败`,
    )
    // 至少调用了一个 with* API，否则插件其实什么也没登记。
    assert.ok(calls.length > 0, `${file} 没有调用任何 config-plugins API`)
    for (const call of calls) {
      assert.equal(
        typeof call.config,
        'object',
        `${file} 调用 ${call.api} 时把回调当成了 config —— 检查参数顺序`,
      )
    }
  })
}

test('withCleartextTraffic 把 mod 登记在 android 平台上', () => {
  calls.length = 0
  const plugin = loadPluginWithStub(join(pluginDir, 'withCleartextTraffic.js'))
  const result = plugin(fakeConfig())

  const apis = calls.map(call => call.api)
  assert.ok(apis.includes('withAndroidManifest'), `实际调用：${apis.join(', ')}`)
  assert.ok(apis.includes('withDangerousMod'), `实际调用：${apis.join(', ')}`)
  // manifest 属性与 res/xml 文件都只对 Android 有意义：不能挂到 ios 平台。
  for (const call of calls) {
    assert.equal(call.platform, 'android', `${call.api} 的平台应为 android，实际 ${call.platform}`)
  }
  assert.ok(result.mods?.android, 'android mods 未登记')
})

test('withReleaseSize 只改 release 相关的 gradle 配置', () => {
  calls.length = 0
  const plugin = loadPluginWithStub(join(pluginDir, 'withReleaseSize.js'))
  const result = plugin(fakeConfig())

  const apis = calls.map(call => call.api)
  for (const expected of ['withGradleProperties', 'withAppBuildGradle']) {
    assert.ok(apis.includes(expected), `缺少 ${expected}，实际调用：${apis.join(', ')}`)
  }
  assert.ok(result.mods?.android, 'android mods 未登记')
})
