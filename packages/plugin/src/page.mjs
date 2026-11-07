// 配对 / 插件页的 HTML 渲染（纯函数，无网络与状态副作用）。
//
// 这一块原来内联在 gateway.mjs 里：近 200 行模板串把帧分发和连接管理淹没了，
// 也让「改一行页面样式」变成 review 一个 2700 行文件的负担。拆出来后 gateway
// 只负责收集渲染所需的数据（当前连接方式、已绑定设备、在线状态等），页面本身
// 与传输层完全解耦。
import { MAX_DEVICES } from './state.mjs'
import { CONNECTION_MODE } from './protocol.mjs'

/** HTML 转义：页面上所有来自手机/用户的文本都必须经过它。 @param {unknown} value */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char)
}

/** 指纹展示：大写、每 4 位一组，最多 16 组。 @param {string} hex */
export function formatFp(hex) {
  return String(hex).toUpperCase().match(/.{1,4}/g)?.slice(0, 16).join(' ') ?? ''
}

/** 中文标签：连接方式选择项。 @param {string} mode */
export function connectionModeLabel(mode) {
  switch (mode) {
    case CONNECTION_MODE.AUTO: return '自动（Tailscale → 局域网 → 隧道）'
    case CONNECTION_MODE.LAN: return '只走局域网'
    case CONNECTION_MODE.TAILSCALE: return '只走 Tailscale（独立于局域网）'
    case CONNECTION_MODE.TUNNEL: return '只走公网隧道'
    default: return String(mode)
  }
}

/**
 * @typedef {object} PageDeps
 * @property {string} version            插件版本（展示用）
 * @property {string} mode               当前连接方式偏好
 * @property {{detected?: Record<string, string[]>}} report 连接方式报告
 * @property {Array<{id: string, label?: string, deviceName?: string}>} devices 已绑定设备
 * @property {(deviceId: string) => boolean} online 某设备当前是否在线
 * @property {string} computerName
 * @property {string} computerId
 * @property {string} fingerprint
 * @property {boolean} webClientAvailable 网页版静态资源是否就绪
 * @property {number} port
 */

/**
 * 渲染 `/openwhale` 绑定页（同时也是 DSH 设置里的插件页内容）。
 * @param {{payload: any, qr: any, webEntries: Array<{kind: string, label: string, url: string, qr: any}>, webUrl: string | undefined, endpoints: Array<{url: string, kind: string}>, local: boolean}} view
 * @param {PageDeps} deps
 * @returns {string} complete HTML document
 */
export function renderPageHtml(view, deps) {
  const { payload, qr, webEntries, webUrl, endpoints, local } = view
  const { version, mode, report, devices, online, computerName, computerId, fingerprint, webClientAvailable, port } = deps
  const boundDevices = devices ?? []
  const remaining = Math.max(0, MAX_DEVICES - boundDevices.length)
  const expiry = payload.ok ? new Date(payload.payload.expires).toLocaleString('zh-CN') : ''

  const kindLabel = { lan: '局域网', tailscale: 'Tailscale', tunnel: '公网隧道', loopback: '本机回环', unknown: '其它' }
  const addressList = endpoints.length
    ? endpoints.map(endpoint => `<li><code>${escapeHtml(endpoint.url)}</code> <span class="tag">${kindLabel[endpoint.kind] ?? endpoint.kind}</span></li>`).join('')
    : '<li>还没有可用地址（请开启局域网监听，或启动公网隧道）</li>'
  const detectedSection = ['tailscale', 'lan', 'tunnel', 'loopback']
    .map(kind => {
      const urls = report.detected?.[kind] ?? []
      return `<li><b>${kindLabel[kind]}地址</b>：${urls.length
        ? urls.map(url => `<code>${escapeHtml(url)}</code>`).join('、')
        : '<span class="hint">未检测到</span>'}</li>`
    })
    .join('')

  const deviceRows = boundDevices.length
    ? `<ul class="devs">${boundDevices.map(device => `<li><span>${escapeHtml(device.label ?? device.deviceName)}</span>${
      local
        ? `<span><button class="btn-sm" data-rename="${escapeHtml(device.id)}">改名</button> <button class="btn-sm" data-unbind="${escapeHtml(device.id)}">移除</button></span>`
        : `<span class="hint">${online(device.id) ? '在线' : '离线'}</span>`
    }</li>`).join('')}</ul>`
    : '<p class="hint">还没有绑定任何手机。用 Open Whale 应用扫描二维码即可绑定。</p>'

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Whale ${version} 绑定</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#0b1220;color:#e8eefc}
 .wrap{max-width:1000px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:0 0 10px}
 .sub{color:#93a4c8;margin-bottom:24px;font-size:14px}
 .grid{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}
 .col{flex:1;min-width:330px;display:flex;flex-direction:column;gap:18px}
 .card{background:#131c31;border:1px solid #24304d;border-radius:14px;padding:18px}
 .qr{background:#fff;padding:12px;border-radius:12px;line-height:0;display:inline-block}
 code{background:#0b1220;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}
 .fp{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#9ee7c0;word-break:break-all}
 .warn{color:#ffd479} .bad{color:#ff9a9a} .hint{color:#93a4c8;font-size:13px}
 ul{line-height:1.7;font-size:14px;margin:6px 0;padding-left:18px}
 .btn{background:#ef4444;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;margin-top:8px}
 .btn:hover{background:#dc2626} .btn[disabled]{background:#475569;cursor:not-allowed}
 .btn-sm{background:#334155;color:#e8eefc;border:0;border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer}
 .btn-sm:hover{background:#475569} .btn-sm[disabled]{opacity:.5;cursor:not-allowed}
 .devs{list-style:none;padding:0;margin:6px 0 2px}
 .devs li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 10px;background:#0b1220;border:1px solid #24304d;border-radius:8px;margin:6px 0;font-size:14px}
 .tag{display:inline-block;background:#1d4ed8;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px}
 .modes label{display:block;margin:6px 0;font-size:14px}
 .banner{background:#3b1d1d;border:1px solid #7f1d1d;color:#ffb4b4;border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:13px}
 input[type=text]{background:#0b1220;border:1px solid #24304d;border-radius:8px;color:#e8eefc;padding:8px 10px;font-size:14px;min-width:260px}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 .ok{color:#9ee7c0}
</style></head><body><div class="wrap">
<h1>Open Whale <span class="tag">v${version}</span></h1>
<div class="sub">用手机上的 Open Whale 应用扫描二维码绑定；也可以用手机浏览器直接打开网页版（无需安装应用）。</div>
<p class="hint">本页就是 DSH 设置 → 插件 → Open Whale 的插件页（同一份内容以内嵌 iframe 的方式显示）。</p>
${local ? '' : `<div class="banner">当前页面不是在这台电脑上打开的。为避免经公网隧道暴露管理能力，配对二维码与所有修改操作（改名/解绑/连接方式/发送文件）都请在本机浏览器操作：<code>http://127.0.0.1:${port}/openwhale</code></div>`}
<div class="grid">
  <div class="col" style="flex:0 0 auto">
    <div class="card">
      <h2>扫码绑定</h2>
      ${local
    ? (qr ? `<div class="qr">${qr.svg}</div>` : `<p class="bad">${escapeHtml(payload.message ?? '当前无法生成二维码')}</p>`)
    : `<p class="hint">配对二维码包含一次性绑定密钥，只在本机浏览器显示。请在电脑上打开 <code>http://127.0.0.1:${port}/openwhale</code> 扫码。</p>`}
      ${local && payload.ok ? `<p><b>二维码有效期</b>：${escapeHtml(expiry)}</p><p class="warn">二维码包含一次性绑定密钥，请勿截图外发；绑定成功后立即失效。</p>` : ''}
    </div>
    <div class="card">
      <h2>网页版 / PWA</h2>
      ${webEntries.length > 0 ? `
        <p class="hint">扫哪个用哪条线路：同一 Wi-Fi 选「局域网」；外网且手机装了 Tailscale 选「Tailscale」。扫码会自动打开网页版并完成绑定。</p>
        ${webEntries.map(entry => `
          <div class="web-entry">
            <p><b>${escapeHtml(entry.label)}</b> <span class="tag">${escapeHtml(entry.url.replace(/[?#].*$/, ''))}</span></p>
            <div class="qr">${entry.qr.svg}</div>
          </div>`).join('')}
        <p class="hint">${webClientAvailable
    ? '鸿蒙 / iOS / 任意浏览器可用；添加到主屏幕即为 PWA。iPhone 第一次访问局域网地址会询问「本地网络」权限，请选「允许」。'
    : '网页版客户端还没有打包进插件（缺少 webchat 目录）。'}</p>
      ` : webUrl ? `
        <p>手机浏览器打开：<br><code>${escapeHtml(webUrl)}</code></p>
        <p class="hint">二维码只在本机浏览器显示。</p>
      ` : '<p class="hint">还没有可用地址，无法生成网页版入口。</p>'}
    </div>
  </div>
  <div class="col">
    <div class="card">
      <h2>电脑</h2>
      <p><b>电脑名称</b>：${escapeHtml(computerName)}</p>
      <p><b>已绑定设备</b>：${boundDevices.length} 台 · 还可绑定 ${remaining} 台${remaining === 0 ? ' · <span class="bad">已达上限，需先移除不用的设备</span>' : ''}</p>
      ${deviceRows}
      <p><b>公钥指纹</b>：<span class="fp">${escapeHtml(formatFp(payload.ok ? payload.payload.fp : fingerprint))}</span></p>
      <p><b>可用地址</b>：</p><ul>${addressList}</ul>
    </div>
    <div class="card">
      <h2>连接方式</h2>
      <p class="hint">决定手机优先用哪条线路连这台电脑。自动模式按「上次成功 → Tailscale → 局域网 → 公网隧道」排序；<b>Tailscale 是独立选项，不再算作局域网</b>。</p>
      <div class="modes">
        ${['auto', 'lan', 'tailscale', 'tunnel'].map(value => `<label><input type="radio" name="connection-mode" value="${value}" ${mode === value ? 'checked' : ''} ${local ? '' : 'disabled'}> ${connectionModeLabel(value)}</label>`).join('')}
      </div>
      ${local ? '<button class="btn-sm" id="save-mode">保存连接方式</button>' : '<p class="hint">连接方式只能在本机浏览器修改。</p>'}
      <p><b>检测到的地址</b>：</p><ul>${detectedSection}</ul>
    </div>
    <div class="card">
      <h2>发送到手机</h2>
      ${local ? `
        <p class="hint">把本会话工作目录里的文件推送到所有已连接的手机（聊天里会出现文件卡片）。</p>
        <div class="row">
          <input type="text" id="send-file-path" placeholder="相对路径，例如 report.pdf">
          <button class="btn-sm" id="send-file-btn">发送</button>
        </div>
        <p id="send-file-result" class="hint"></p>
      ` : '<p class="hint">发送文件需要读取电脑上的路径，只允许在本机浏览器操作。</p>'}
    </div>
  </div>
</div>
<p class="hint">Open Whale v${version} · 电脑 ID <code>${escapeHtml(computerId)}</code> · 状态：${payload.ok ? 'ready' : 'blocked'}</p>
</div>
<script>
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  }
  document.getElementById('save-mode')?.addEventListener('click', async function (event) {
    var button = event.currentTarget
    var selected = document.querySelector('input[name=connection-mode]:checked')
    if (!selected) return
    button.disabled = true
    try {
      var response = await postJson('/openwhale/connection-mode?mode=' + encodeURIComponent(selected.value))
      if (!response.ok) throw new Error(await response.text())
      location.reload()
    } catch (error) {
      alert('保存失败：' + error.message)
      button.disabled = false
    }
  })
  document.getElementById('send-file-btn')?.addEventListener('click', async function (event) {
    var button = event.currentTarget
    var input = document.getElementById('send-file-path')
    var result = document.getElementById('send-file-result')
    var path = input.value.trim()
    if (!path) { alert('请填写文件路径'); return }
    button.disabled = true
    result.textContent = '正在发送…'
    try {
      var response = await postJson('/openwhale/send-file', { path: path })
      var body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.message || body.error || '发送失败')
      result.innerHTML = '已发送 <b>' + body.name + '</b>（' + body.size + ' 字节）'
    } catch (error) {
      result.textContent = '发送失败：' + error.message
    } finally {
      button.disabled = false
    }
  })
  document.querySelectorAll('[data-rename]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var id = button.getAttribute('data-rename')
      var name = prompt('给这台设备起个备注名（只用于配对页识别设备，不会出现在对话里）')
      if (!name) return
      button.disabled = true
      try {
        var response = await fetch('/openwhale/device-rename?deviceId=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(name), { method: 'POST' })
        if (!response.ok) throw new Error(await response.text())
        location.reload()
      } catch (error) {
        alert('改名失败：' + error.message)
        button.disabled = false
      }
    })
  })
  document.querySelectorAll('[data-unbind]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var id = button.getAttribute('data-unbind')
      if (!confirm('确定移除这台设备？移除后它需要重新扫码才能再连。')) return
      button.disabled = true
      try {
        var response = await fetch('/openwhale/unbind?deviceId=' + encodeURIComponent(id), { method: 'POST' })
        if (!response.ok) throw new Error(await response.text())
        location.reload()
      } catch (error) {
        alert('移除失败：' + error.message)
        button.disabled = false
      }
    })
  })
</script>
</body></html>`
}
