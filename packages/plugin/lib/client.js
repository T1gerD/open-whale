// Open Whale — DSH Web 客户端插件（`settings.section` 区块）。
//
// 在 DSH 设置侧栏提供「Open Whale」区块：配对二维码、配对状态、入口链接。
// 宿主侧的 `/openwhale` 页面仍是唯一真相来源（二维码、已绑定设备、解绑、
// 连接方式、发文件），这里只做展示，不重复实现业务逻辑。
//
// 加载格式由 DSH 的客户端模块加载器（`window.__ModuleLoader__`）规定：工厂返回
// `{apply, inject}`；设置区块按 `dsh-client-ui-agent-preset` 的契约注册——
// `label` 必须是函数、`inject` 必须返回 props，否则设置页会静默跳过该 section。
//
// 3.0.0 起整段做防御：客户端 boot 会把任何 apply 抛错当成「entry failed」并中止
// 整个 Web 启动（"web boot: 1 entry did not activate"）。设置页只是锦上添花，
// 绝不能因为它把 DSH 挡在门外——工厂、apply、fetch、onClick 全部 try/catch。
window.__ModuleLoader__.load({
  id: 'dsh-openwhale',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 客户端加载器要求导出 apply；inject 置空数组避免被当成 pending。 */
    exports.inject = []

    try {
      var React = require('react')
      var useState = React.useState
      var useEffect = React.useEffect

      /** 设置区块槽位名（设置侧栏的「Open Whale」）。 */
      var SETTINGS_SLOT = 'settings.section'
      /** 宿主侧路由，与 gateway.mjs 的路由表一致（同源相对路径，桌面壳会代理）。 */
      var PAIRING_PATH = '/openwhale'
      var INFO_PATH = '/openwhale/info'
      var QR_PATH = '/openwhale/qr.png'

      /** 设计 token 都有兜底，DSH 换主题时不会变成透明块。 */
      var ACCENT = 'var(--dsw-alias-accent-primary, #4f7cff)'
      var ACCENT_SOFT = 'var(--dsw-alias-accent-soft, rgba(79, 124, 255, 0.14))'
      var BORDER = 'var(--dsw-alias-border-secondary, rgba(128, 128, 128, 0.24))'
      var SUCCESS = 'var(--dsw-alias-state-success-primary, #2e9e5b)'

      var styles = {
        root: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '560px' },
        card: {
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          padding: '18px',
          borderRadius: '14px',
          border: '1px solid ' + BORDER,
          background: 'var(--dsw-alias-bg-secondary, rgba(255, 255, 255, 0.02))',
          width: '100%',
          boxSizing: 'border-box',
        },
        head: { display: 'flex', alignItems: 'center', gap: '12px' },
        avatar: {
          width: '40px',
          height: '40px',
          borderRadius: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: '14px',
          letterSpacing: '0.5px',
          color: '#fff',
          background: 'linear-gradient(135deg, #4f7cff, #7b5cff)',
          flex: '0 0 auto',
        },
        headBody: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
        titleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        title: { margin: 0, fontSize: '15px', fontWeight: 650 },
        version: {
          fontSize: '10px',
          fontWeight: 600,
          padding: '1px 6px',
          borderRadius: '999px',
          color: ACCENT,
          background: ACCENT_SOFT,
          fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
        },
        meta: { margin: 0, fontSize: '12px', lineHeight: '17px', opacity: 0.65 },
        status: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.8, flex: '0 0 auto' },
        dot: { width: '7px', height: '7px', borderRadius: '999px', background: SUCCESS, display: 'inline-block' },
        dotOff: { width: '7px', height: '7px', borderRadius: '999px', background: '#c9a227', display: 'inline-block' },
        divider: { height: '1px', background: BORDER, border: 0, margin: 0, opacity: 0.7 },
        qrBox: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '10px',
          padding: '14px',
          borderRadius: '12px',
          border: '1px solid ' + BORDER,
          background: 'var(--dsw-alias-bg-primary, rgba(0, 0, 0, 0.12))',
        },
        // 二维码由宿主生成 PNG；居中固定白底，设置页的滚动容器不会把它裁掉。
        qr: {
          width: '100%',
          maxWidth: '240px',
          aspectRatio: '1 / 1',
          background: '#fff',
          padding: '10px',
          borderRadius: '10px',
          display: 'block',
          boxSizing: 'border-box',
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
        },
        caption: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.7, textAlign: 'center' },
        pairing: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.9, textAlign: 'center' },
        actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: 0 },
        primary: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          padding: '7px 14px',
          borderRadius: '8px',
          border: '1px solid ' + ACCENT,
          background: ACCENT,
          color: '#fff',
          fontSize: '13px',
          fontWeight: 600,
          textDecoration: 'none',
          cursor: 'pointer',
        },
        secondary: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          padding: '7px 14px',
          borderRadius: '8px',
          border: '1px solid ' + BORDER,
          background: 'transparent',
          color: 'inherit',
          fontSize: '13px',
          fontWeight: 500,
          cursor: 'pointer',
        },
        refresh: {
          marginLeft: 'auto',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: ACCENT,
          fontSize: '12px',
          cursor: 'pointer',
        },
        urls: { display: 'flex', flexDirection: 'column', gap: '4px', margin: 0 },
        url: { margin: 0, fontSize: '11px', opacity: 0.6, wordBreak: 'break-all' },
        link: { color: ACCENT, textDecoration: 'underline' },
        error: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
      }

      /**
       * 取某个 kind 的宿主地址（loopback / lan / tailscale），拼成配对页路径。
       * 没有对应端点时返回空串（调用方回退相对路径）。
       */
      function endpointUrl(info, kind) {
        var endpoints = info && Array.isArray(info.endpoints) ? info.endpoints : []
        for (var index = 0; index < endpoints.length; index += 1) {
          var endpoint = endpoints[index]
          if (!endpoint || endpoint.kind !== kind || typeof endpoint.url !== 'string' || endpoint.url === '') continue
          return String(endpoint.url).replace(/\/$/, '') + PAIRING_PATH
        }
        return ''
      }

      /** 复制文本：优先 navigator.clipboard，失败退回 textarea + execCommand。 */
      function copyText(text) {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text)
          }
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[openwhale] 剪贴板不可用：', error)
        }
        try {
          var area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[openwhale] 复制失败：', error)
        }
        return undefined
      }

      /**
       * 设置区块内容：身份 + 二维码 + 配对状态 + 动作。
       * 用宿主生成的 PNG（不再嵌套 iframe），设置页的滚动容器不会把它裁掉。
       */
      function OpenWhaleSection() {
        var stateHook = useState({ status: 'loading', info: null, error: '', fetchedAt: 0 })
        var state = stateHook[0]
        var setState = stateHook[1]
        var refreshHook = useState(0)
        var refreshTick = refreshHook[0]
        var setRefreshTick = refreshHook[1]
        var copiedHook = useState('')
        var copied = copiedHook[0]
        var setCopied = copiedHook[1]

        useEffect(function () {
          var alive = true
          try {
            fetch(INFO_PATH + '?t=' + String(Date.now()), { headers: { accept: 'application/json' } })
              .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status)
                return response.json()
              })
              .then(function (info) {
                if (alive) setState({ status: 'ready', info: info, error: '', fetchedAt: Date.now() })
              })
              .catch(function (error) {
                if (!alive) return
                var message = String((error && error.message) || error)
                setState({ status: 'error', info: null, error: message, fetchedAt: 0 })
              })
          } catch (error) {
            setState({ status: 'error', info: null, error: String((error && error.message) || error), fetchedAt: 0 })
          }
          return function () { alive = false }
        }, [refreshTick])

        var info = state.info
        var pairing = info && info.pairing
        var available = !pairing || pairing.available !== false
        // 配对页必须在本机回环地址打开才显示二维码（宿主的安全策略）；
        // 局域网地址只给手机直接开网页版用。
        var url = endpointUrl(info, 'loopback') || PAIRING_PATH
        var lanBase = endpointUrl(info, 'lan') || ''
        var phoneUrl = lanBase ? lanBase.replace(PAIRING_PATH, '') + '/openwhale/app' : ''
        var deviceCount = info && typeof info.pairedDevices === 'number' ? info.pairedDevices : 0
        var metaParts = []
        if (info && info.computerName) metaParts.push(String(info.computerName))
        if (info && info.connectionMode) metaParts.push('连接方式 ' + String(info.connectionMode))
        if (deviceCount > 0) metaParts.push('已绑定 ' + deviceCount + ' 台')
        var children = []

        // ── 头部：图标 + 名称/版本 + 状态 ─────────────────────────────
        children.push(React.createElement(
          'div',
          { key: 'head', style: styles.head },
          React.createElement('div', { style: styles.avatar, 'aria-hidden': 'true' }, 'OW'),
          React.createElement(
            'div',
            { style: styles.headBody },
            React.createElement(
              'div',
              { style: styles.titleRow },
              React.createElement('h3', { style: styles.title }, 'Open Whale'),
              info && info.version ? React.createElement('span', { style: styles.version }, 'v' + String(info.version)) : null,
            ),
            React.createElement('p', { style: styles.meta }, metaParts.length > 0 ? metaParts.join(' · ') : '手机遥控器插件'),
          ),
          React.createElement(
            'div',
            { style: styles.status },
            React.createElement('span', { style: available ? styles.dot : styles.dotOff }),
            React.createElement('span', null, state.status === 'error' ? '读取失败' : available ? '配对就绪' : '配对不可用'),
          ),
        ))
        children.push(React.createElement('hr', { key: 'divider', style: styles.divider }))

        // ── 二维码区 ────────────────────────────────────────────────
        if (state.status === 'error') {
          children.push(React.createElement(
            'p',
            { key: 'error', style: styles.error },
            '读取配对信息失败：' + state.error,
          ))
        }
        if (available) {
          children.push(React.createElement(
            'div',
            { key: 'qr', style: styles.qrBox },
            React.createElement('img', {
              src: state.fetchedAt ? QR_PATH + '?t=' + String(state.fetchedAt) : QR_PATH,
              style: styles.qr,
              alt: 'Open Whale 配对二维码',
            }),
            React.createElement(
              'p',
              { style: styles.caption },
              '用手机相机扫码；手机浏览器也可以直接打开网页版（无需安装 App）。',
            ),
            pairing && pairing.message
              ? React.createElement('p', { style: styles.pairing }, String(pairing.message))
              : null,
          ))
        } else {
          children.push(React.createElement(
            'p',
            { key: 'pairing-error', style: styles.error },
            (pairing && pairing.message) || '当前不能生成新的配对二维码。',
          ))
        }

        // ── 动作 ────────────────────────────────────────────────────
        children.push(React.createElement(
          'div',
          { key: 'actions', style: styles.actions },
          React.createElement(
            'a',
            {
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: styles.primary,
              onClick: function (event) {
                // 绝对 loopback 地址交给系统浏览器；相对回退才手动 window.open。
                try {
                  if (url !== PAIRING_PATH) return
                  event.preventDefault()
                  if (typeof window !== 'undefined' && window.open) window.open(url, '_blank', 'noopener')
                } catch (error) {
                  if (typeof console !== 'undefined') console.warn('[openwhale] 打开配对页失败：', error)
                }
              },
            },
            '在浏览器中打开配对页',
          ),
          phoneUrl
            ? React.createElement(
              'button',
              {
                type: 'button',
                style: styles.secondary,
                onClick: function () {
                  try {
                    var result = copyText(phoneUrl)
                    if (result && typeof result.then === 'function') {
                      result.then(function () { setCopied('phone') }, function () { setCopied('') })
                    } else {
                      setCopied('phone')
                    }
                    if (typeof setTimeout === 'function') setTimeout(function () { setCopied('') }, 1600)
                  } catch (error) {
                    if (typeof console !== 'undefined') console.warn('[openwhale] 复制手机地址失败：', error)
                  }
                },
              },
              copied === 'phone' ? '已复制' : '复制手机地址',
            )
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              style: styles.refresh,
              onClick: function () {
                try {
                  setState({ status: 'loading', info: state.info, error: '', fetchedAt: state.fetchedAt })
                  setRefreshTick(refreshTick + 1)
                } catch (error) {
                  if (typeof console !== 'undefined') console.warn('[openwhale] 刷新失败：', error)
                }
              },
            },
            state.status === 'loading' ? '刷新中…' : '刷新二维码',
          ),
        ))

        // ── 地址 ────────────────────────────────────────────────────
        children.push(React.createElement(
          'div',
          { key: 'urls', style: styles.urls },
          React.createElement('p', { style: styles.url }, '本机配对页：' + url),
          phoneUrl
            ? React.createElement(
              'p',
              { style: styles.url },
              '手机网页版：',
              React.createElement('a', { href: phoneUrl, target: '_blank', rel: 'noopener noreferrer', style: styles.link }, phoneUrl),
            )
            : null,
        ))

        return React.createElement(
          'div',
          { style: styles.root, 'data-plugin': 'dsh-openwhale' },
          React.createElement('div', { style: styles.card }, children),
        )
      }

      /**
       * 只注册设置区块。插件详情页（plugins.bundle.config）不再注册任何内容：
       * 二维码属于「设置 → Open Whale」，不该出现在插件说明里。
       * @param {any} ctx 客户端根上下文
       */
      function apply(ctx) {
        try {
          var slots = ctx && (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
          if (!slots) slots = ctx && ctx.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            if (typeof console !== 'undefined') console.warn('[openwhale] 客户端没有 slots 服务，设置区块不可用')
            return
          }
          slots.inject(SETTINGS_SLOT, function () {
            try {
              // 契约来自 dsh-client-ui-agent-preset：label 是函数，inject 返回 props。
              return slots.register(
                {
                  name: SETTINGS_SLOT,
                  id: 'openwhale',
                  order: 40,
                  label: function () { return 'Open Whale' },
                  inject: function () { return {} },
                },
                OpenWhaleSection,
              )
            } catch (error) {
              if (typeof console !== 'undefined') console.warn('[openwhale] 设置区块注册失败，已跳过：', error)
              return undefined
            }
          })
        } catch (error) {
          // 设置页不可用可以接受；把 DSH 带崩不可以。
          if (typeof console !== 'undefined') console.warn('[openwhale] 设置区块挂载失败，已跳过：', error)
        }
      }

      exports.apply = apply
    } catch (error) {
      if (typeof console !== 'undefined') console.warn('[openwhale] 客户端插件加载失败，已跳过：', error)
      exports.apply = function () {}
    }

    return module.exports
  },
})
