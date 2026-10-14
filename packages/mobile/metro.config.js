// Metro 配置（monorepo + .mts 支持）。
//
// 三件事必须显式配置，否则这个包在仓库里跑不起来：
//  1. watchFolders：`packages/protocol` 在项目目录之外，Metro 默认不看外面；
//  2. extraNodeModules：把 `@openwhale/protocol` 直接指到协议的源码 .mjs，
//     这样协议不需要任何构建步骤（它本来就是纯 JS + JSDoc）；
//  3. sourceExts：核心纯逻辑用 `.mts`（Node 能原生做类型剥离，测试零依赖），
//     Metro 需要显式登记这个扩展名才能解析与转译。
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..', '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@openwhale/protocol': path.resolve(workspaceRoot, 'packages/protocol/src/index.mjs'),
}
config.resolver.sourceExts = Array.from(new Set([...config.resolver.sourceExts, 'mts']))

module.exports = config
