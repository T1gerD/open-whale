// Babel 配置。
//
// `babel-preset-expo` 负责绝大部分转换；这里额外补一件事：**让 `.mts` 也能被剥离类型**。
//
// 为什么需要：手机端的核心业务逻辑写成 `.mts`（纯 TypeScript，Node 原生就能做类型剥离，
// 因此那些逻辑可以零依赖地跑单测）。Metro 默认只把 `.ts`/`.tsx` 当作 TypeScript，
// `.mts` 走的是普通 JS 解析路径，于是 `export interface ...` 这类语法直接报
// `Unexpected token`——Android 打包（createBundleReleaseJsAndAssets）就是这样失败的。
//
// `metro.config.js` 已经注册了 `mts` 扩展名，这里补上对应的语法支持，两处是配套的。
module.exports = function babelConfig(api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        test: /\.mts$/,
        presets: [['@babel/preset-typescript', { allExtensions: true, isTSX: false }]],
      },
    ],
  }
}
