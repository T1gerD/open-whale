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
// 绝不能因为它把 DSH 挡在门外——工厂、apply、query、onClick 全部 try/catch。
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

      var styles = {
        root: { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '560px' },
        card: {
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '16px',
          borderRadius: '12px',
          border: '1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, 0.24))',
          width: '100%',
        },
        title: { margin: 0, fontSize: '15px', fontWeight: 600 },
        hint: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.75 },
        qrWrap: { display: 'flex', justifyContent: 'center', padding: '4px 0' },
        // 二维码由宿主生成 PNG；按容器缩放，避免再出现 iframe 的双层滚动条。
        qr: {
          width: '100%',
          maxWidth: '300px',
          aspectRatio: '1 / 1',
          background: '#fff',
          borderRadius: '8px',
          display: 'block',
        },
        error: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #d9534f)' },
        actions: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap',
          margin: 0,
        },
        link: { fontSize: '13px', textDecoration: 'underline' },
        url: { fontSize: '11px', opacity: 0.6, wordBreak: 'break-all', margin: 0 },
      }

      /**
       * 取某个 kind 的宿主地址（loopback / lan / tailscale），拼成配对页路径。
       * 没有对应端点时回退相对路径（桌面壳会代理到宿主）。
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

      /**
       * 设置区块内容：二维码 + 配对状态 + 「在浏览器中打开配对页」。
       * 用宿主生成的 PNG（不再嵌套 iframe），设置页的滚动容器不会把它裁掉。
       */
      function OpenWhaleSection() {
        var stateHook = useState({ status: 'loading', info: null, error: '', fetchedAt: 0 })
        var state = stateHook[0]
        var setState = stateHook[1]

        useEffect(function () {
          var alive = true
          try {
            fetch(INFO_PATH, { headers: { accept: 'application/json' } })
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
        }, [])

        var info = state.info
        var pairing = info && info.pairing
        var available = !pairing || pairing.available !== false
        // 配对页必须在本机回环地址打开才显示二维码（宿主的安全策略）；
        // 局域网地址只给手机直接开网页版用。
        var url = endpointUrl(info, 'loopback') || PAIRING_PATH
        var lanBase = endpointUrl(info, 'lan') || ''
        var phoneUrl = lanBase ? lanBase.replace(PAIRING_PATH, '') + '/openwhale/app' : ''
        var children = [
          React.createElement('h3', { key: 'title', style: styles.title }, '扫码绑定手机'),
          React.createElement(
            'p',
            { key: 'hint', style: styles.hint },
            available
              ? '二维码只在本机浏览器显示。用手机相机扫码，或让手机浏览器直接打开下面的网页版地址。'
              : '当前不能生成新的配对二维码；已绑定设备仍可在配对页里管理。',
          ),
        ]

        if (state.status === 'error') {
          children.push(React.createElement(
            'p',
            { key: 'error', style: styles.error },
            '读取配对信息失败：' + state.error + '。可以直接打开下面的配对页。',
          ))
        }
        if (available) {
          children.push(React.createElement(
            'div',
            { key: 'qr', style: styles.qrWrap },
            React.createElement('img', {
              src: state.fetchedAt ? QR_PATH + '?t=' + String(state.fetchedAt) : QR_PATH,
              style: styles.qr,
              alt: 'Open Whale 配对二维码',
            }),
          ))
        } else if (pairing && pairing.message) {
          children.push(React.createElement('p', { key: 'pairing-error', style: styles.error }, String(pairing.message)))
        }
        children.push(React.createElement(
          'p',
          { key: 'actions', style: styles.actions },
          React.createElement(
            'a',
            {
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: styles.link,
              onClick: function (event) {
                // 相对链接在桌面壳里可能被拦；绝对 http 地址交给系统浏览器打开。
                try {
                  if (url !== PAIRING_PATH || typeof window === 'undefined' || !window.open) return
                  event.preventDefault()
                  var opened = window.open(url, '_blank', 'noopener')
                  if (!opened) window.location.href = url
                } catch (error) {
                  if (typeof console !== 'undefined') console.warn('[openwhale] 打开配对页失败：', error)
                }
              },
            },
            '在浏览器中打开配对页',
          ),
          info && info.computerName
            ? React.createElement('span', { key: 'name', style: styles.hint }, String(info.computerName))
            : null,
        ))
        children.push(React.createElement('p', { key: 'url', style: styles.url }, '本机配对页：' + url))
        if (phoneUrl) {
          children.push(React.createElement(
            'p',
            { key: 'phone', style: styles.url },
            '手机网页版：',
            React.createElement('a', {
              href: phoneUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: styles.link,
            }, phoneUrl),
          ))
        }

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
