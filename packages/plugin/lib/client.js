// Open Whale — DSH Web 客户端插件（插件页）。
//
// 这是聊天输入框「+」里那个 `/openwhale` 命令的替代品：v2.3.0 删掉了命令，
// 绑定二维码改在「DSH 设置 → 插件 → Open Whale」的插件页里显示。页面内容复用
// 宿主侧的 `/openwhale`（同一份配对页：二维码、已绑定设备、解绑、连接方式、
// 发送文件），所以这里只负责把它嵌进来，不重复实现任何逻辑。
//
// 加载格式由 DSH 的客户端模块加载器（`window.__ModuleLoader__`）规定，与官方
// 客户端插件一致：工厂返回 `{apply, inject}`，宿主用客户端根 ctx 调用 `apply`。
// 组件注册进 `plugins.bundle.config` 槽——该槽由插件管理页声明为 keyed/root，
// key 用包名（与渲染时的 `entryKey: pkg.name` 对齐）。
//
// 3.0.0 起这里**整段做防御**：客户端 boot 会把任何 apply 抛错当成「entry failed」
// 并直接中止整个 Web 启动（"web boot: 1 entry did not activate"）。设置页只是
// 锦上添花，绝不能因为它把 DSH 挡在门外，所以工厂和 apply 都包了 try/catch，
// slots 服务缺失、槽位接口变化、注册失败都只记一条 warning 后放弃。
window.__ModuleLoader__.load({
  id: 'dsh-openwhale',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 客户端加载器要求模块导出 apply；inject 置空数组避免被当成 pending。 */
    exports.inject = []

    try {
      var React = require('react')

      /**
       * 注册到「设置」侧边栏的 Open Whale 区块（`settings.section` 槽），
       * 而不是插件卡片里的说明位：用户要的是「设置 → Open Whale → 二维码」，
       * 二维码不该挤在插件详情（README/描述）里。
       */
      var SLOT = 'settings.section'
      /** 宿主侧配对页路径，与 gateway.mjs 的路由表一致。 */
      var PAIRING_PATH = '/openwhale'

      var styles = {
        root: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '560px' },
        hint: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.7 },
        frame: {
          width: '100%',
          height: '560px',
          minHeight: '420px',
          border: '1px solid var(--dsw-alias-border-secondary, rgba(128, 128, 128, 0.24))',
          borderRadius: '12px',
          background: '#0b1220',
        },
        actions: { display: 'flex', justifyContent: 'flex-end', margin: 0 },
        link: { fontSize: '13px', textDecoration: 'underline' },
      }

      /**
       * 插件页内容：内嵌宿主配对页 + 「在浏览器中打开」。
       * 不读取任何 slot props，因此槽位渲染参数变化也不会影响它。
       */
      function OpenWhalePluginPage() {
        return React.createElement(
          'div',
          { style: styles.root, 'data-plugin': 'dsh-openwhale' },
          React.createElement(
            'p',
            { style: styles.hint },
            '用手机上的 Open Whale 应用扫描下面的二维码完成绑定；已绑定的设备可以在这里改名或移除。',
          ),
          React.createElement('iframe', {
            src: PAIRING_PATH,
            style: styles.frame,
            title: 'Open Whale 配对页',
            loading: 'lazy',
          }),
          React.createElement(
            'p',
            { style: styles.actions },
            React.createElement(
              'a',
              { href: PAIRING_PATH, target: '_blank', rel: 'noopener noreferrer', style: styles.link },
              '在浏览器中打开',
            ),
          ),
        )
      }

      /**
       * 注册插件页。slots 服务可能通过 `ctx.get('slots')` 暴露（官方插件都这么取），
       * 也可能挂成属性；两种都试，拿不到就只警告、绝不抛错。
       * @param {any} ctx 客户端根上下文
       */
      function apply(ctx) {
        try {
          var slots = ctx && (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
          if (!slots) slots = ctx && ctx.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            if (typeof console !== 'undefined') console.warn('[openwhale] 客户端没有 slots 服务，插件页不可用')
            return
          }
          slots.inject(SLOT, function () {
            try {
              return slots.register(
                { name: SLOT, id: 'openwhale', order: 40, label: 'Open Whale' },
                OpenWhalePluginPage,
              )
            } catch (error) {
              if (typeof console !== 'undefined') console.warn('[openwhale] 设置区块注册失败，已跳过：', error)
              return undefined
            }
          })
        } catch (error) {
          // 设置页不可用可以接受；把 DSH 带崩不可以。
          if (typeof console !== 'undefined') console.warn('[openwhale] 插件页挂载失败，已跳过：', error)
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
