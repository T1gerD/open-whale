// 客户端插件包（lib/client.js）的回归测试。
//
// DSH Web 的启动器会把客户端模块的 apply 抛错当成 "entry failed"，并直接中止
// 整个 Web 启动（用户看到「应用无法启动」）。3.0.0 就是这样被插件页挡在门外的：
// 旧代码直接读 `ctx.slots`，在没有该服务属性时抛错，整个 DSH 起不来。
//
// 这个测试用最小化的 __ModuleLoader__/React 替身加载真实文件，覆盖：
//  * 正常 slots 服务（ctx.get('slots')）；
//  * 没有 slots 服务；
//  * 老式 ctx.slots 属性；
//  * register / inject / ctx.get 抛错；
//  * require('react') 失败。
// 任何一条都不允许把异常抛给调用方。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(CLIENT_PATH, 'utf8')

/** 用替换掉 __ModuleLoader__/React 的全局环境执行 bundle，返回模块导出。 */
function loadBundle({ react = true } = {}) {
  let mod
  const React = { createElement: (...args) => ({ args }) }
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        assert.equal(id, 'dsh-openwhale')
        mod = factory(name => {
          if (name === 'react') {
            if (!react) throw new Error('react not available')
            return React
          }
          throw new Error(`unexpected require ${name}`)
        })
      },
    },
  }
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
  return mod
}

test('the client bundle exports apply and an empty inject list', () => {
  const mod = loadBundle()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, [])
})

test('apply registers the settings page through ctx.get("slots")', () => {
  const mod = loadBundle()
  let registered = 0
  const slots = {
    inject: (name, cb) => {
      assert.equal(name, 'plugins.bundle.config')
      cb()
    },
    register: () => {
      registered += 1
      return () => {}
    },
  }
  mod.apply({ get: name => (name === 'slots' ? slots : undefined) })
  assert.equal(registered, 1)
})

test('apply survives a missing slots service, old ctx.slots, and throwing slot APIs', () => {
  const mod = loadBundle()
  // 没有 slots：只警告
  assert.doesNotThrow(() => mod.apply({}))
  // 老式属性
  let registered = 0
  assert.doesNotThrow(() => mod.apply({
    slots: { inject: (_name, cb) => cb(), register: () => { registered += 1 } },
  }))
  assert.equal(registered, 1)
  // register 抛错
  assert.doesNotThrow(() => mod.apply({
    get: () => ({ inject: (_n, cb) => cb(), register: () => { throw new Error('slot api changed') } }),
  }))
  // inject 抛错
  assert.doesNotThrow(() => mod.apply({
    get: () => ({ inject: () => { throw new Error('boom') }, register: () => {} }),
  }))
  // ctx.get 抛错
  assert.doesNotThrow(() => mod.apply({ get: () => { throw new Error('no ctx') } }))
})

test('a broken react require degrades to a no-op plugin instead of failing boot', () => {
  const mod = loadBundle({ react: false })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, [])
  assert.doesNotThrow(() => mod.apply({}))
})
