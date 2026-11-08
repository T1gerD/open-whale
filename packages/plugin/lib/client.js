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
        root: { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '100%' },
        frame: {
          width: '100%',
          height: '760px',
          minHeight: '640px',
          border: '1px solid ' + BORDER,
          borderRadius: '12px',
          background: '#0b1220',
        },
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
        openLink: {
          flex: '0 0 auto',
          fontSize: '13px',
          fontWeight: 600,
          color: ACCENT,
          textDecoration: 'none',
          padding: '4px 8px',
          borderRadius: '6px',
          background: ACCENT_SOFT,
        },
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
       * 设置区块：内嵌与浏览器相同的绑定向导，并在标题行放一个「在浏览器中打开」入口。
       *
       * 向导本身是服务端渲染的三步页面（App/网页版 → 局域网/Tailscale/隧道 → 扫码），
       * 这里只负责容器；入口用绝对 loopback 地址，桌面壳的 setWindowOpenHandler
       * 只对 http(s) 调用系统浏览器（相对地址会被 dsh-app 协议吞掉）。
       */
      function OpenWhaleSection() {
        var urlHook = useState({ url: '', mode: '' })
        var state = urlHook[0]
        var setState = urlHook[1]

        useEffect(function () {
          var alive = true
          try {
            fetch(INFO_PATH, { headers: { accept: 'application/json' } })
              .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status)
                return response.json()
              })
              .then(function (info) {
                if (!alive) return
                var endpoints = info && Array.isArray(info.endpoints) ? info.endpoints : []
                var loopback = endpoints.filter(function (item) { return item && item.kind === 'loopback' && typeof item.url === 'string' })[0]
                var lan = endpoints.filter(function (item) { return item && item.kind === 'lan' && typeof item.url === 'string' })[0]
                var base = (loopback && loopback.url) || (lan && lan.url) || ''
                setState({
                  url: base ? String(base).replace(/\/$/, '') + PAIRING_PATH : 'http://127.0.0.1:8787' + PAIRING_PATH,
                  mode: info && info.connectionMode ? String(info.connectionMode) : '',
                })
              })
              .catch(function () {
                if (alive) setState({ url: 'http://127.0.0.1:8787' + PAIRING_PATH, mode: '' })
              })
          } catch (error) {
            setState({ url: 'http://127.0.0.1:8787' + PAIRING_PATH, mode: '' })
          }
          return function () { alive = false }
        }, [])

        return React.createElement(
          'div',
          { style: styles.root, 'data-plugin': 'dsh-openwhale' },
          React.createElement(
            'div',
            { style: styles.head },
            React.createElement(
              'div',
              { style: styles.headBody },
              React.createElement('h3', { style: styles.title }, '手机配对'),
              React.createElement(
                'p',
                { style: styles.meta },
                '第 1 步选 App 或网页版，第 2 步选连接方式，第 3 步扫码。',
              ),
            ),
            state.url
              ? React.createElement(
                'a',
                {
                  href: state.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: styles.openLink,
                  title: state.url,
                },
                '在浏览器中打开 ↗',
              )
              : null,
          ),
          React.createElement('iframe', {
            src: PAIRING_PATH,
            style: styles.frame,
            title: 'Open Whale 绑定向导',
            loading: 'lazy',
          }),
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
