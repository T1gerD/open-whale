// Open Whale 必须允许明文流量（http/ws）。
//
// 背景：电脑端插件只提供 `http://` 与 `ws://`（局域网直连 `http://192.168.x.y:8787`、
// Tailscale 的 `http://100.x.y.z:8787`、USB 的 `http://127.0.0.1:<port>`）。Android 从
// 9.0（API 28）起默认禁止明文流量，而本应用 targetSdk ≥ 31 —— 不显式放行的话，
// OkHttp 会在建立 TCP 之前就拒绝所有连接，表现为：手机端一直「正在重连」，
// 电脑端日志里却连一条连接都没有。
//
// 为什么不能做成「只允许私网 IP 明文」：
//   Android 的 network-security-config 只能按**主机名/IP 字面量**逐条放行
//   （`<domain>` 不支持 CIDR 网段），而用户电脑的局域网/公网 IP 是运行时才知道的，
//   不可能在打包时枚举。所以只能全局放行明文；真正的安全边界是：
//     * 隧道/公网地址都是 https/wss（二维码里给的就是 https，`wsUrlFor` 会升级成 wss）；
//     * 客户端合并候选地址时**只把 http 升级成 https，绝不反向降级**，
//       见 `src/core/endpoint.mts` 的 `mergeEndpointCandidates`；
//     * 明文只用于同一局域网 / Tailscale / USB 回环这几条本来就不可加密的路径。
//
// 因此这里输出一份显式的 network-security-config（把理由写在 XML 注释里，
// 打包产物里也看得见），同时保留 `android:usesCleartextTraffic` 作为 API < 24 的兜底。
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG_RES_PATH = ['app', 'src', 'main', 'res', 'xml', 'network_security_config.xml']

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<!--
  Open Whale 的明文流量策略（由 plugins/withCleartextTraffic.js 生成）。

  为什么全局允许明文：手机要直连电脑端插件，而插件只提供 http/ws：
    - 局域网   http://192.168.x.y:8787
    - Tailscale http://100.x.y.z:8787 或 http://<host>.<tailnet>.ts.net:8787
    - USB      http://127.0.0.1:<port>（adb reverse）
  这些地址在打包时不可知，且 Android 的 network-security-config 不支持 CIDR 网段
  （<domain> 只接受主机名/IP 字面量），无法表达「仅私网 IP 允许明文」。

  安全边界不在这一层：公网隧道地址一律是 https/wss，客户端合并候选地址时
  只把 http 升级成 https、绝不反向降级（core/endpoint.mts: mergeEndpointCandidates）。
  改这个文件之前请先读那段注释和 README 的「已知限制」。
-->
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`

function injectManifestAttributes(config) {
  return withAndroidManifest(cfg => {
    const manifest = cfg.modResults.manifest
    const application = manifest.application?.[0]
    if (!application) {
      throw new Error('withCleartextTraffic: AndroidManifest 里找不到 <application>')
    }
    // API 24+ 由 network-security-config 决定；这条属性是 API 23 的兜底。
    application.$['android:usesCleartextTraffic'] = 'true'
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config'
    return cfg
  })
}

function writeNetworkSecurityConfig(config) {
  return withDangerousMod(config, [
    'android',
    async cfg => {
      const projectRoot = cfg.modRequest?.platformProjectRoot
      if (!projectRoot) return cfg
      const target = path.join(projectRoot, ...CONFIG_RES_PATH)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, NETWORK_SECURITY_CONFIG, 'utf8')
      return cfg
    },
  ])
}

module.exports = function withCleartextTraffic(config) {
  return writeNetworkSecurityConfig(injectManifestAttributes(config))
}
