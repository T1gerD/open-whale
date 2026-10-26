# Open Whale v2.2.0 开发计划（交接用）

> 基线：v2.1.0（tag `v2.1.0`，391 测试全绿）。目标：修 9 个用户问题 + 缺陷清单 10 条，
> 发布 v2.2.0（GitHub Release / npm `dsh-openwhale` / DSH 插件市场）。
> 协议契约见同目录 `PROTOCOL-V2.md`（已冻结，Lead 维护）。

## 0. 硬约束

- **测试即验收**：改完跑 `node scripts/run-tests.mjs`，必须全绿；关键行为先写测试。
- 插件端 **零运行时依赖**（纯 Node ESM）；手机端只允许新增 Expo 官方模块。
- 不破坏协议兼容性（只增不改、未知帧忽略）。
- 注释用中文、风格照现有文件；不用 TypeScript 改插件（`.mjs` + JSDoc）。
- 不要改 `packages/protocol/src/index.mjs`（Lead 所有）；需要改协议先在群里说。
- 不要动 `_gh/research/**`（研究产出）以外的共享目录；各自写自己的 scope。
- Windows 环境，仓库在 `C:\Users\33502\Documents\open-whale`（**不在** DSH workspace 里，
  绝对路径访问；parent 没有 node_modules 污染）。

## 1. 用户问题 → 改动 → 验收

| # | 用户问题 | 改动 | 验收 |
|---|---|---|---|
| 1 | 扫码无法从相册输入二维码 | 手机端扫码页加「从相册选图」，解码后走同一 bind 流程（expo-image-picker + expo-image-manipulator + 纯 JS 解码，见研究结论） | 单测覆盖解码管线；真机操作路径可达 |
| 2 | 手机登录/使用 Tailscale 麻烦 | 手动地址输入 + health 预检 + 相册扫码 + 连接方式设置 + 自动竞速 + 失败可操作提示 + 记住上次地址 | 连接策略单测；`/openwhale/health` 探活可测 |
| 3 | 公网隧道优先于局域网/Tailscale，协作模式打不开 | 协议层 Tailscale 识别与排序；插件连接方式偏好（auto/lan/tailscale/tunnel，Tailscale 独立选项）；手机端同款设置；协作模式不再与传输方式耦合 | `orderEndpoints` 单测；插件页面有 Tailscale 独立开关 |
| 4 | 协作模式回复文本重复拼接 | bridge 按 assistant `messageId` 去重，`chat/message` 全文 upsert；手机端按 id 合并 | bridge 测试构造 attempt+message 同文本 → 只出现一次 |
| 5 | 同一条消息投递两次 | 电脑端 `IdempotencyCache(deviceId,msgId)`；重复 `chat/send` 回 ack 不投递；bridge 二次保护 | 测试：同 msgId 发两次 → `followup` 只调 1 次 |
| 6 | 多设备同会话不同步 | `chat/echo` 广播 + 全员助手帧广播 + `session/state` 快照 + `session/events` 追赶 + `session/participants` 在线条 + 手机端渲染他人消息 | 测试：两个假设备连同一会话，A 发消息 B 收到 echo、B 也能收到 delta/done |
| 7 | 适配鸿蒙 / iOS | iOS：app.json ios 段 + eas.json + macOS Actions 工作流 + 文档；鸿蒙/iOS 通用：插件内置 Web/PWA 客户端（`/openwhale/app`），系统相机扫码即用，可添加到主屏幕 | Web 客户端能完成绑定→连接→聊天→收文件；CI 有 iOS 构建工作流 |
| 8 | 手机发图模型读不到；传输体积小/慢 | 分块上传（512KiB/块，64MiB 上限，背压+进度+重试）；落盘到会话工作目录内；保留扩展名、给相对路径；图片可选压缩；下载分块更顺 | 上传状态机单测；路径在 cwd 内的集成测试 |
| 9 | UI/交互优化（参考 WorkBuddy） | 手机端视觉重做：底部输入栏、气泡分组、连接状态胶囊、参与者头像条、空态、长按菜单（复制/重发/删除）、文件卡片、深浅色 | 纯渲染层，无单测硬要求；跑通 syntax/typecheck |
| P2-9 | 长按无复制 | 长按菜单（expo-clipboard） | 组件实现 |
| P1-10 | 电脑→手机发文件 | `POST /openwhale/send-file`（仅 loopback 调用）+ 页面按钮 + `file/offered` 帧 + 手机下载卡片 | 路由测试 + 帧测试 |
| P0-1 | 重启后自动重连失败无提示 | 见 #2 | 重连策略测试 |
| P0-2 | 无手动地址入口 | 见 #2 | — |
| P0-6 | 重新绑定复用旧连接 | pair() 先销毁旧 link、清旧 endpoints；失败时显示尝试过的地址 | 测试：同 computerId 重复 pair 不复用旧对象 |
| P1-7 | https 强制第一 | 协议 `pickEndpoint`/`orderEndpoints` 已改 | 协议测试已加 |
| P1-8 | 解绑提示端口过期 | 统一 `8787` / 现端口 | 文案单测或替换 |
| P1-3 | 扫码无反应 | 相册 + 手动入口 + 二维码内容精简（epk 单字母）+ 连接失败可操作提示 | — |
| P1-4 | 隧道地址每次变 | Tailscale 作为推荐主通道（连接方式 auto 首选 Tailscale）+ 文档 | — |

## 2. 工作流（写作用域，避免冲突）

| 工作流 | 负责人 | 独占写作用域 |
|---|---|---|
| 协议 + 发布 + 集成 | Lead | `packages/protocol/**`、`scripts/build-plugin-package.mjs`、`.github/workflows/release.yml`、`CHANGELOG.md`、`README.md`、`docs/v2.2.0/**`、根 `package.json`、`packages/plugin/package.json`（仅包装配置） |
| 电脑端插件 | plugin-core | `packages/plugin/src/**`（除 protocol.mjs 生成物由脚本生成）、`packages/plugin/test/**`、`packages/plugin/scripts/**`、`packages/plugin/cordis.patch.yml`、`docs/install.md` |
| 手机端核心 | mobile-core | `packages/mobile/src/core/**`、`packages/mobile/src/services/**`、`packages/mobile/src/state/**`、`packages/mobile/src/protocol/**`、`packages/mobile/test/**`、`packages/mobile/package.json`、`packages/mobile/scripts/check-syntax.mjs` |
| 手机端 UI | mobile-ui | `packages/mobile/app/**`、`packages/mobile/src/ui/**`、`packages/mobile/src/ui/theme.ts` |
| 跨端（iOS/鸿蒙/Web） | webchat-platform | `packages/webchat/**`、`packages/mobile/app.json`、`packages/mobile/eas.json`、`.github/workflows/ios.yml`、`docs/iOS-HarmonyOS.md` |

依赖关系：mobile-ui 依赖 mobile-core 暴露的 store API（对外方法名尽量不变，需要新字段先沟通）；
webchat-platform 依赖 Lead 在 gateway 里加静态路由（Lead 先加，platform 只写 `packages/webchat`）；
plugin-core 依赖协议（已冻结，可开工）。

## 3. 测试与命令

```bash
cd C:/Users/33502/Documents/open-whale
node scripts/run-tests.mjs                 # 全部（必须全绿）
node scripts/run-tests.mjs packages/plugin # 单包
node packages/protocol/test/protocol.test.mjs
node packages/mobile/test/run.mjs
node packages/mobile/scripts/check-syntax.mjs
node packages/plugin/scripts/sync-protocol.mjs          # 协议副本同步（plugin-core 开工先跑）
node packages/plugin/scripts/sync-protocol.mjs --check  # CI 用
```

没有 Android SDK / JDK，**本机不能构建 APK**；APK 由 GitHub Actions 构建。
手机端类型检查需要先 `pnpm install`（可选，能装就装）。

## 4. 汇报格式（每个工作流收尾时）

1. 改了哪些文件（按目录）；
2. 新增/修改的测试与 `node scripts/run-tests.mjs` 真实输出摘要；
3. 没做完/有风险的点；
4. 需要 Lead 决策的事项（协议、跨组接口）。
