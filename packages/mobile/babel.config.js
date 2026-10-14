// Babel 配置。
//
// 手机端的核心业务逻辑写成 `.mts`（纯 TypeScript，Node 原生即可剥离类型，因此那些逻辑
// 可以零依赖跑单测）。Metro 默认只把 `.ts`/`.tsx` 当 TypeScript，`.mts` 会走普通 JS
// 解析路径，`export interface ...` 这类语法直接报 `Unexpected token`——Android 打包
// （createBundleReleaseJsAndAssets）就是这样失败的。
//
// 因此这里显式加上 `@babel/preset-typescript`。
//
// 两个必须注意的点：
//  * 放在**顶层 presets**，不能用 `overrides`：Metro 调用 Babel 的某些路径不传文件名，
//    带 `test` 的 override 会直接报 “Configuration contains string/RegExp pattern, but
//    no filename was passed to Babel”。
//  * 不设 `allExtensions`：默认情况下该 preset 只对 `.ts`/`.tsx`/`.mts` 这类文件生效，
//    `.js` 会跳过，因此不会和 `babel-preset-expo` 自带的 TypeScript 处理打架。
module.exports = function babelConfig(api) {
  api.cache(true)
  return {
    presets: ['@babel/preset-typescript', 'babel-preset-expo'],
  }
}
