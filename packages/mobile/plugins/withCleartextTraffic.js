// Open Whale 必须允许明文流量。
//
// 电脑端插件只提供 `http://` 与 `ws://`（局域网直连 `http://192.168.x.y:8787`、
// DSH Web 服务器 `http://127.0.0.1:<port>`）。Android 从 9.0（API 28）起
// **默认禁止明文流量**，而本应用 targetSdk ≥ 31 —— 于是 OkHttp 会在建立 TCP 之前
// 就拒绝所有连接，表现为：手机端一直「正在重连」，电脑端日志里却连一条连接都没有。
//
// Expo 的 release 模板不会设置 `android:usesCleartextTraffic`，所以必须在
// prebuild 阶段把它注入生成的 AndroidManifest.xml。
const { withAndroidManifest } = require('@expo/config-plugins')

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, cfg => {
    const manifest = cfg.modResults.manifest
    const application = manifest.application?.[0]
    if (!application) {
      throw new Error('withCleartextTraffic: AndroidManifest 里找不到 <application>')
    }
    application.$['android:usesCleartextTraffic'] = 'true'
    return cfg
  })
}
