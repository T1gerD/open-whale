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
 * @property {(deviceId: string) => boolean} online 某设备当前是否在线（旧口径，保留兼容）
 * @property {(deviceId: string) => 'foreground'|'background'|'offline'} [presence]
 *           某设备的前后台状态（在线细分：前台=用户正在看，后台=锁屏/切走了但仍可用）
 * @property {string} computerName
 * @property {string} computerId
 * @property {string} fingerprint
 * @property {boolean} webClientAvailable 网页版静态资源是否就绪
 * @property {number} port
 */

/**
 * 设备在线状态文案（前/后台/离线）。
 *
 * 「在线（后台）」不是离线：锁屏/切后台的手机仍能收到审批与提问，只是用户
 * 此刻没在看页面。文案要把这层差别说清楚，避免用户以为手机关掉了连接。
 * @param {'foreground'|'background'|'offline'|undefined} state
 * @returns {string}
 */
export function devicePresenceLabel(state) {
  switch (state) {
    case 'foreground': return '在线（前台）'
    case 'background': return '在线（后台）'
    default: return '离线'
  }
}

/**
 * 渲染 `/openwhale` 绑定页（同时也是 DSH 设置里的插件页内容）。
 * @param {{payload: any, qr: any, webEntries: Array<{kind: string, label: string, url: string, qr: any}>, webUrl: string | undefined, endpoints: Array<{url: string, kind: string}>, local: boolean}} view
 * @param {PageDeps} deps
 * @returns {string} complete HTML document
 */
export function renderPageHtml(view, deps) {
  const { payload, qr, webEntries, webUrl, endpoints, local } = view
  const { version, mode, report, devices, online, presence, computerName, computerId, fingerprint, webClientAvailable, port } = deps
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

  // 设备状态：两种视图都显示。local 视图保留改名/移除按钮，状态和按钮同排。
  const presenceOf = deviceId => {
    if (typeof presence === 'function') return presence(deviceId)
    // 兼容只传 online() 的旧调用方（外部渲染入口 / 旧测试）：只能区分在线/离线。
    return online(deviceId) ? 'foreground' : 'offline'
  }
  const deviceRows = boundDevices.length
    ? `<ul class="devs">${boundDevices.map(device => {
      const state = presenceOf(device.id)
      const status = `<span class="presence is-${state === 'foreground' ? 'fg' : state === 'background' ? 'bg' : 'off'}">${devicePresenceLabel(state)}</span>`
      return `<li><span>${escapeHtml(device.label ?? device.deviceName)}</span><span class="dev-actions">${status}${
        local
          ? ` <button class="btn-sm" data-rename="${escapeHtml(device.id)}">改名</button> <button class="btn-sm" data-unbind="${escapeHtml(device.id)}">移除</button>`
          : ''
      }</span></li>`
    }).join('')}</ul>`
    : '<p class="hint">还没有绑定任何手机。用 Open Whale 应用扫描二维码即可绑定。</p>'

  // 向导第二步：线路能不能点，要看**检测到的地址**（report.detected），
  // 不能看 endpoints —— 后者已经按当前连接方式偏好过滤过。
  //
  // 之前用的是 endpoints，于是出现一个死锁：把默认方式切成「只走 Tailscale」
  // 之后，endpoints 里只剩 Tailscale，局域网按钮就被标成「当前不可用」并禁用，
  // 用户再也切不回局域网。可选线路本来就不该被当前选择限制。
  const detectedKinds = new Set(
    Object.entries(report.detected ?? {})
      .filter(([kind, urls]) => kind !== 'loopback' && Array.isArray(urls) && urls.length > 0)
      .map(([kind]) => kind),
  )
  const hasKind = kind => detectedKinds.has(kind) || endpoints.some(endpoint => endpoint.kind === kind)
  // 不可用时要说清「为什么」：是没装/没登录，还是电脑端根本没启用。
  const unavailableWhy = {
    lan: '没检测到局域网地址：电脑可能只监听了本机回环。',
    tailscale: '没检测到 Tailscale 地址：电脑端 Tailscale 未登录或未连接。',
    tunnel: '没有隧道地址：电脑端未开启隧道，或没装 cloudflared。',
  }
  const modeList = [
    { kind: 'lan', title: '局域网', desc: '手机和电脑同一个 Wi-Fi；最省事、延迟最低。' },
    { kind: 'tailscale', title: 'Tailscale', desc: '外网也能连；手机需安装并登录同一 Tailscale 账号。' },
    { kind: 'tunnel', title: '公网隧道', desc: '公网 HTTPS 地址；无需装 Tailscale，但需要有隧道进程。' },
  ]
  const modeButtons = modeList.map(item => {
    const usable = hasKind(item.kind) && local
    return `<button class="choice" data-mode="${item.kind}" ${usable ? '' : 'disabled'}>`
      + `<b>${item.title}${hasKind(item.kind) ? '' : '（当前不可用）'}</b>`
      + `<span>${item.desc}</span>`
      + `${usable ? '' : `<span class="why">${unavailableWhy[item.kind] ?? '当前没有该线路的地址。'}${local ? '' : '（远程打开时不可修改）'}</span>`}`
      + '</button>'
  }).join('')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Whale ${version} 绑定</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#0b1220;color:#e8eefc}
 .wrap{max-width:1000px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:0 0 10px}
 .sub{color:#93a4c8;margin-bottom:24px;font-size:14px}
 .card{background:#131c31;border:1px solid #24304d;border-radius:14px;padding:18px;margin-bottom:18px}
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
 .dev-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
 .presence{font-size:13px}
 .presence.is-fg{color:#9ee7c0}
 .presence.is-bg{color:#ffd479}
 .presence.is-off{color:#93a4c8}
 .tag{display:inline-block;background:#1d4ed8;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px}
 .banner{background:#3b1d1d;border:1px solid #7f1d1d;color:#ffb4b4;border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:13px}
 input[type=text]{background:#0b1220;border:1px solid #24304d;border-radius:8px;color:#e8eefc;padding:8px 10px;font-size:14px;min-width:260px}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 .ok{color:#9ee7c0}
 .steps{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px;font-size:13px;color:#64748b}
 .steps b{color:#e8eefc}
 .choice-row{display:flex;gap:12px;flex-wrap:wrap}
 .choice{flex:1 1 240px;text-align:left;background:#131c31;border:1px solid #24304d;border-radius:12px;padding:16px;color:#e8eefc;cursor:pointer;font:inherit}
 .choice:hover{border-color:#3b82f6}
 .choice[disabled]{opacity:.45;cursor:not-allowed}
 .choice b{display:block;font-size:15px;margin-bottom:4px}
 .choice span{color:#93a4c8;font-size:13px;line-height:1.5}
 .choice .why{display:block;margin-top:6px;color:#ffd479;font-size:12px}
 .back{background:#334155;color:#e8eefc;border:0;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;margin-top:12px}
 .back:hover{background:#475569}
 .web-entry{margin-top:10px}
</style></head><body><div class="wrap">
<h1>Open Whale <span class="tag">v${version}</span></h1>
<div class="sub">第一次连接：选绑定方式 → 选连接方式 → 扫码。之后手机端会记住这次用的连接方式，也可以在手机设置里改。</div>
${local ? '' : `<div class="banner">当前页面不是在这台电脑上打开的。为避免经公网隧道暴露管理能力，配对二维码与所有修改操作（改名/解绑/连接方式/发送文件）都请在本机浏览器操作：<code>http://127.0.0.1:${port}/openwhale</code></div>`}
<div class="steps">
  <b id="step-tag">第 1 步 · 选择绑定方式</b>
  <span>·</span><span>第 2 步 · 选择连接方式</span>
  <span>·</span><span>第 3 步 · 扫码</span>
</div>

<section id="step1">
  <div class="card">
    <h2>选择绑定方式</h2>
    <p class="hint">首次连接用哪种方式？绑定后仍可在手机端设置里改成别的线路。</p>
    <div class="choice-row">
      <button class="choice" data-bind="app" ${local ? '' : 'disabled'}>
        <b>App 绑定</b><span>已安装 Open Whale 应用：扫码后在应用中确认即可完成绑定。</span>
      </button>
      <button class="choice" data-bind="web" ${local ? '' : 'disabled'}>
        <b>网页版绑定</b><span>用手机浏览器直接打开网页版（无需安装）；iPhone 首次访问会询问「本地网络」，请选允许。</span>
      </button>
    </div>
  </div>

  <div class="card">
    <h2>电脑</h2>
    <p><b>电脑名称</b>：${escapeHtml(computerName)}</p>
    <p><b>已绑定设备</b>：${boundDevices.length} 台 · 还可绑定 ${remaining} 台${remaining === 0 ? ' · <span class="bad">已达上限，需先移除不用的设备</span>' : ''}</p>
    ${deviceRows}
    <p><b>公钥指纹</b>：<span class="fp">${escapeHtml(formatFp(payload.ok ? payload.payload.fp : fingerprint))}</span></p>
    <p><b>可用地址</b>${mode === 'auto' ? '' : `（已按「${escapeHtml(connectionModeLabel(mode))}」过滤，其它线路见下表）`}：</p><ul>${addressList}</ul>
    <p class="hint">检测到的地址：</p><ul>${detectedSection}</ul>
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
</section>

<section id="step2" hidden>
  <div class="card">
    <h2>选择第一次连接方式</h2>
    <p class="hint">这一步选定的线路会保存为默认连接方式；手机端设置里仍可修改。灰色表示电脑上确实没有这类地址（原因写在按钮里）。</p>
    <p class="hint">当前默认连接方式：<b>${escapeHtml(connectionModeLabel(mode))}</b>${mode === 'auto' ? '' : '——上方的「可用地址」只列这一类，其他线路的地址仍然存在，换一个方式即可。'}</p>
    <div class="choice-row">${modeButtons}</div>
    <p class="hint" id="mode-note"></p>
    <button class="back" id="back1">← 上一步</button>
    <button class="back" id="redetect">重新检测线路</button>
  </div>
</section>

<section id="step3" hidden>
  <div class="card">
    <h2>扫码绑定</h2>
    <p class="hint" id="step3-hint"></p>
    <div id="app-qr">
      <img class="app-qr" data-kind="lan" src="/openwhale/qr.png?mode=lan" alt="局域网配对二维码" hidden>
      <img class="app-qr" data-kind="tailscale" src="/openwhale/qr.png?mode=tailscale" alt="Tailscale 配对二维码" hidden>
      <img class="app-qr" data-kind="tunnel" src="/openwhale/qr.png?mode=tunnel" alt="公网隧道配对二维码" hidden>
      <p class="warn">二维码包含一次性绑定密钥，请勿截图外发；绑定成功后立即失效。</p>
      <p class="hint">二维码有效期：${escapeHtml(expiry)}</p>
    </div>
    <div id="web-qr" hidden>
      ${webEntries.map(entry => `
        <div class="web-entry" data-kind="${entry.kind}" hidden>
          <p><b>${escapeHtml(entry.label)}</b> <span class="tag">${escapeHtml(entry.url.replace(/[?#].*$/, ''))}</span></p>
          <div class="qr">${entry.qr.svg}</div>
        </div>`).join('')}
      <p class="hint">扫码会自动打开网页版并完成绑定；同一 Wi-Fi 选局域网，外网且手机装了 Tailscale 选 Tailscale。</p>
      ${webEntries.length === 0 ? '<p class="bad">网页版客户端还没有就绪（缺少 webchat 或没有可用地址）。</p>' : ''}
    </div>
    <p class="bad" id="step3-error" hidden></p>
    <button class="back" id="back2">← 重新选择</button>
  </div>
</section>

<p class="hint">Open Whale v${version} · 电脑 ID <code>${escapeHtml(computerId)}</code> · 状态：${payload.ok ? 'ready' : 'blocked'}</p>
</div>
<script>
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  }
  var wizard = { binding: null, mode: null }
  var modeNames = { lan: '局域网', tailscale: 'Tailscale', tunnel: '公网隧道' }
  function show(step) {
    document.getElementById('step1').hidden = step !== 1
    document.getElementById('step2').hidden = step !== 2
    document.getElementById('step3').hidden = step !== 3
    document.getElementById('step-tag').textContent = step === 1 ? '第 1 步 · 选择绑定方式' : step === 2 ? '第 2 步 · 选择连接方式' : '第 3 步 · 扫码'
  }
  function setError(message) {
    var node = document.getElementById('step3-error')
    node.textContent = message || ''
    node.hidden = !message
  }
  function renderQr() {
    setError('')
    var app = wizard.binding === 'app'
    document.getElementById('app-qr').hidden = !app
    document.getElementById('web-qr').hidden = app
    var hint = app ? '用手机上的 Open Whale 扫描下面的二维码。' : '用手机相机扫描下面的二维码，会打开网页版并自动完成绑定。'
    document.getElementById('step3-hint').textContent = hint + ' 连接方式：' + (modeNames[wizard.mode] || '')
    if (app) {
      document.querySelectorAll('.app-qr').forEach(function (img) {
        img.hidden = img.getAttribute('data-kind') !== wizard.mode
      })
      return
    }
    var shown = false
    document.querySelectorAll('#web-qr .web-entry').forEach(function (entry) {
      var on = entry.getAttribute('data-kind') === wizard.mode
      entry.hidden = !on
      if (on) shown = true
    })
    if (!shown) setError('这条线路还没有网页版二维码：请先在电脑上启用该线路，或换一个连接方式。')
  }
  document.querySelectorAll('[data-bind]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.disabled) return
      wizard.binding = button.getAttribute('data-bind')
      show(2)
    })
  })
  document.querySelectorAll('[data-mode]').forEach(function (button) {
    button.addEventListener('click', async function () {
      if (button.disabled) return
      wizard.mode = button.getAttribute('data-mode')
      // 第一次连接所用方式保存为默认；手机端仍可在设置里覆盖。
      try {
        var response = await postJson('/openwhale/connection-mode?mode=' + encodeURIComponent(wizard.mode))
        if (!response.ok) throw new Error(await response.text())
      } catch (error) {
        document.getElementById('mode-note').textContent = '保存默认连接方式失败（不影响本次扫码）：' + error.message
      }
      renderQr()
      show(3)
    })
  })
  document.getElementById('back1')?.addEventListener('click', function () { show(1) })
  document.getElementById('redetect')?.addEventListener('click', function () { location.reload() })
  document.getElementById('back2')?.addEventListener('click', function () { show(2) })
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
