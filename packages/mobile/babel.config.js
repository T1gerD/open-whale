// Babel 配置：SDK 53 起 expo-router 不需要额外的 babel 插件，
// 这里只保留 babel-preset-expo，尽量少一层可出错的东西。
module.exports = function babelConfig(api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
  }
}
