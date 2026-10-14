# Open Whale 手机端（`@openwhale/mobile`）

配套 `dsh-openwhale` 电脑插件使用：电脑上显示二维码 → 手机扫码绑定 → 之后以**个人助理聊天**
的形式远程使用电脑上的 DeepSeek Harness。一台手机可以绑定多台电脑，每台电脑就是一个"助理"。

技术栈按 `_recon/MOBILE-STACK.md` 的结论选型：**Expo SDK 57 + CNG prebuild + Gradle 本地出包**，
不依赖 EAS 云构建，也不需要 Expo 账号。

---

## 1. 目录结构

```
packages/mobile/
├── app/                          # expo-router 路由（只负责画界面与交互）
│   ├── _layout.tsx               # 根布局：挂 AppProvider、注册路由、启动期协议断言
│   ├── index.tsx                 # 助理列表（多台电脑，在线状态 / 待发送 / 传输中）
│   ├── scan.tsx                  # 扫码绑定（expo-camera）+ 手动粘贴二维码内容
│   ├── settings.tsx              # 全局设置 / 关于 / 已知限制
│   └── assistant/[id]/
│       ├── index.tsx             # 聊天页（流式、活动行、文件卡片、离线待发）
│       └── settings.tsx          # 备注名、远程电源、唤醒引导、连接信息、解绑
├── src/
│   ├── core/                     # ★ 零依赖纯逻辑（TypeScript，.mts），全部有单测
│   │   ├── base64.mts            # base64/base64url + 手写 UTF-8
│   │   ├── keys.mts              # Ed25519 公钥 → SPKI DER、deviceId 形状
│   │   ├── endpoint.mts          # endpoint 解析、ws:// 推导、重连地址阶梯
│   │   ├── frames.mts            # 协议帧名/常量的**镜像**（由测试核对）
│   │   ├── pairing.mts           # 二维码校验、hello/ack 判定、hello 帧组装
│   │   ├── reducer.mts           # 聊天状态机（delta 聚合 / 工具行 / 文件流 / 断线恢复）
│   │   ├── outbox.mts            # 离线队列（重发、去重、放弃边界）
│   │   ├── backoff.mts           # 重连退避 1s→…→30s + 抖动
│   │   ├── files.mts             # 文件名消毒、体积、进度、分块累计
│   │   ├── power.mts             # 关机/重启倒计时、取消、拒绝原因文案
│   │   └── wake.mts              # 唤醒代理规划与引导文案
│   ├── protocol/
│   │   ├── types.ts              # 帧类型定义（镜像 protocol，字段以 protocol 为准）
│   │   └── runtime.ts            # 唯一的 `@openwhale/protocol` 导入点 + 启动期契约断言
│   ├── services/                 # 依赖 Expo/RN 的适配层（不做业务判断）
│   │   ├── crypto.ts             # tweetnacl + expo-crypto：密钥对与签名
│   │   ├── secure.ts             # expo-secure-store：设备私钥与身份
│   │   ├── db.ts                 # expo-sqlite：schema 与仓储
│   │   ├── transfers.ts          # expo-file-system + expo-sharing：落盘与打开
│   │   ├── attachments.ts        # expo-document-picker：选附件
│   │   ├── wake.ts               # 唤醒代理 HTTP 请求
│   │   └── connection.ts         # WebSocket 连接：握手、心跳、退避重连、地址轮换
│   ├── state/
│   │   ├── app-store.ts          # 业务编排：连接 + reducer + SQLite + 文件服务
│   │   └── store.tsx             # React 粘合（useSyncExternalStore）
│   └── ui/                       # 主题与基础组件
├── scripts/check-syntax.mjs      # 零依赖语法/可擦除性检查（见第 2 节）
└── test/                         # node:test 单测（*.test.mjs）
```

**分层规则**：`app/` 里只有渲染与交互；`src/state/app-store.ts` 是业务编排；`src/core/` 是
零依赖纯逻辑；`src/services/` 只做 I/O 适配。任何"如果……就……"的判断都不写进组件。

---

## 2. 跑测试（不需要 Android SDK，也不需要装任何依赖）

核心逻辑写成 **`.mts`**（纯 TypeScript），测试写成 **`.mjs`**（纯 JS）。Node 24 会原生剥离
`.mts` 里的类型注解，所以：

```powershell
cd packages/mobile
node test/run.mjs
```

实测输出（Node v24.21.0，零 `node_modules`）：

```
=== backoff.test.mjs
=== base64.test.mjs
=== endpoint.test.mjs
=== files.test.mjs
=== frames.test.mjs
=== keys.test.mjs
=== outbox.test.mjs
=== pairing.test.mjs
=== power.test.mjs
=== reducer.test.mjs
=== wake.test.mjs
ℹ tests 88
ℹ pass 88
ℹ fail 0
mobile test run OK (11 个测试文件)
```

仓库根目录的 `node scripts/run-tests.mjs` 也会带上这些用例（它扫描 `packages/**/*.test.mjs`）。

另外有一个零依赖的语法检查（同样不需要装依赖）：

```powershell
cd packages/mobile
node scripts/check-syntax.mjs
# 语法检查通过：30 个文件（22 个做了类型剥离解析，8 个 .tsx 只做了分隔符配对）
```

它对 `.ts`/`.mts` 用 Node 的类型剥离器做**完整解析**，并保证 `src/core/**` 只用可擦除语法；
Node 的剥离器不支持 JSX，所以 `.tsx` 只做 `{} () []` 配对检查（真正的 JSX/类型检查需要 tsc）。

为什么不用 `node --test test/`：`node --test` 会为每个文件起子进程并通过管道收集输出，
在受限沙箱里会被拒（EPERM）；`test/run.mjs` 在同一进程里 import 每个测试文件，用的是同一套
`node:test` 断言与报告。两种方式在普通机器上都可以。

约定（重要）：
- `src/core/*.mts` **只能**用可擦除的 TypeScript 语法（不用 `enum`、`namespace`、构造函数参数属性），
  否则 Node 的类型剥离会失败。
- `src/core/*.mts` **不 import 任何 npm 包**。需要协议函数时由调用方注入（`PairingDeps`），
  测试注入的是 `packages/protocol/src/index.mjs` 的**真实实现**，因此不存在"镜像实现漂移"。
- `test/*.test.mjs` 本身是 JS，不能写类型注解（`.mjs` 不会被剥离类型）。

类型检查（需要先装依赖，本机没有装）：

```powershell
pnpm install
cd packages/mobile && pnpm typecheck     # tsc --noEmit，strict + allowImportingTsExtensions
```

---

## 3. 本地构建 APK（Windows，无 EAS 账号）

前置：Node ≥ 22.11、JDK 17、Android SDK（platform-tools / build-tools / cmdline-tools），
并设置 `ANDROID_HOME`。

```powershell
# 1) 在仓库根安装依赖（pnpm workspace）
pnpm install

# 2) 把 package.json 里未验证的 Expo 包版本对齐到 SDK 57 推荐版本
cd packages/mobile
npx expo install --fix

# 3) 生成原生工程（SDK 57 起 prebuild 默认就是 clean 行为）
npx expo prebuild --platform android --clean

# 4) 出 release APK
cd android
.\gradlew assembleRelease
# 产物：android\app\build\outputs\apk\release\app-release.apk
```

- `npx expo install --fix` 是**必须**的一步：`package.json` 里带 `*` 的包（`expo-router`、
  `expo-constants`、`expo-linking`、`expo-status-bar`、`expo-crypto`、`expo-document-picker`、
  `react-native-screens`、`react-native-safe-area-context`）的版本号我在这台机器上**没有联网核实**，
  `*` 保证能装上，`--fix` 会改写为 SDK 57 对应的确切版本。
- 调试自用可以直接用 debug keystore；正式签名在 `android/app/build.gradle` 配 `signingConfigs`。
- 不要用 `eas build --local`：官方在 Windows 上不支持，而且仍然要登录 Expo 账号。
- 开发调试：`pnpm start` 后用 Expo Go 无法运行（本项目含自定义原生模块）→ 需要 `pnpm android`
  先装一次 dev build。

---

## 4. 关键设计

### 4.1 存储 schema（expo-sqlite，`openwhale.db`）

| 表 | 关键列 | 为什么这样设计 |
| --- | --- | --- |
| `assistants` | `id`(电脑 id) / `name` / `fingerprint` / `endpoints`(JSON) / `preferred_endpoint` / `power_allowed` / `wake_proxy_url` / `wake_mac` | 需要按"最后连接时间"排序、按在线状态过滤，所以用显式列 |
| `messages` | `id` / `assistant_id` / `at` / `payload`(JSON) | 读法永远是"按助理取整段历史"，显式展开十几个字段只会和 reducer 的类型漂移；`(assistant_id, at)` 建索引 |
| `transfers` | `file_id` / `assistant_id` / `updated_at` / `payload` | 文件卡片要能跨重启恢复（含已落盘的本地路径） |
| `outbox` | `assistant_id` / `payload` | 未确认消息必须跨进程重启恢复，否则断网重发就丢了 |
| `settings` | `key` / `value` | 简单本地偏好 |

消息主键是**确定性**的：用户消息 `usr_<rid>`、助手消息 `msg_<callId>`，所以重连后重复收到的帧
不会造出第二条，写库可以直接 upsert。私钥（32 字节 Ed25519 seed）只在
`expo-secure-store`（Android Keystore / iOS Keychain），按设备 id 分区。

### 4.2 reducer 设计（`src/core/reducer.mts`）

- **状态**：`messages` + `callIndex`(callId→消息 id) + `transfers` + `typing` + `lastSeq` +
  `deltaBuffers` + `gapCount`，全部可 JSON 往返。
- **delta 聚合**：`seq <= lastSeq` 视为重复/迟到丢弃；`seq > lastSeq + 1` 先缓存、等缺口补齐后
  连续 flush（乱序也能正确拼接）；`chat/done` 的完整文本是权威值，覆盖正文并把该 callId 的序号
  推到上限，之后任何迟到的 delta 都会被丢弃。
- **工具行**：`chat/tool` 只累积成 assistant 消息里的 `activity[]`（按 `toolCallId:phase` 去重），
  **绝不**写进 `text`——"正在读取文件…"不是助理说的话。
- **文件**：reducer 只记进度与状态，字节通过 `effects`（`file-chunk` / `file-complete` /
  `file-abort`）交给服务层；`Uint8Array` 不进 React 状态树。分块序号必须严格连续，跳变即判定失败
  （宁可失败也不产出坏文件），重复分块丢弃，`file/end` 时字节数不足即失败。
- **断线恢复**：断线把仍在流式的消息标 `interrupted`（保留 `streaming`，因为同一次回答可能继续）；
  重启后 `hydrateChat` 用持久化的 `deltaSeq` 恢复 `lastSeq`，所以已收到的增量不会被重复追加。

### 4.3 重连策略（`src/core/backoff.mts` + `src/services/connection.ts`）

- 地址阶梯：**上次成功的地址 → https 隧道 → 其余地址**，每次失败换下一个（轮换，不会一直卡在死地址）。
- 等待时间：`1s → 2s → 4s → 8s → 16s → 30s` 封顶，带 ±20% 抖动（多设备不会齐步重连）；
  超过 12 次自动重试后停下，只保留手动"重连"。
- 心跳：`hello/ack.heartbeatMs` 决定周期（收敛到 5–120 秒），电脑端静默超过 2.5 个周期就主动重连，
  避免半死 TCP 假装在线。
- App 回到前台（`AppState` 变 `active`）立刻重试一次，不等退避计时器。

### 4.4 离线队列（`src/core/outbox.mts`）

未确认消息在重连后按入队顺序重发，同一个 `rid`/`callId` 只保留一条；每条最多自动重发 3 次，
超过后由用户在气泡上手动点"重试"；断线时把"飞行中"的条目退回 pending，否则它们会永远卡住。

⚠️ 已知风险：电脑端**没有** `chat/send` 去重，重发有可能被电脑端当成两条新消息执行。当前策略是
"同一 rid 只重发、有次数上限、失败交给用户决定"，README 与汇报里都记了这一点。

### 4.5 文件收发

- **接收**（电脑 → 手机）：`chat/done.files[]` → 卡片"点按下载" → `file/fetch` → `file/meta`
  → `file/chunk*` → `file/end`。分块在服务层按序拼接后一次写入应用私有目录，
  再用 `expo-sharing` 交给系统打开。进度、取消（`file/cancel`）都在卡片上。
- **发送**（手机 → 电脑）：`expo-document-picker` 选文件 → base64 进 `chat/send.files`，
  上限 **8 MB**（协议里附件是整包 base64，大文件会一次性吃内存）；超过就明确拒绝并给出替代建议。
  大文件分块上传**未实现**（协议没有手机→电脑的分块帧）。

---

## 5. 未验证 / 未实现清单

### 5.1 代码写了但**没有在真机/真电脑上跑过**（本机没有 Android SDK，也没有装依赖）

- 整个 UI 层、Expo 模块调用（相机、SQLite、SecureStore、File/Directory/Paths、Sharing、
  DocumentPicker）都没有运行过，只做了静态审查。
- `pnpm typecheck`（`tsc --noEmit`）没有跑过（`node_modules` 不存在）。
- `expo-file-system` 新 API 的 `File.write(bytes)` / `File.base64()` / `File.downloadFileAsync`
  方法名按官方文档写，若真机上名字不同，改 `src/services/transfers.ts` 与
  `src/services/attachments.ts` 各一处即可。
- `expo-camera` 的 `CameraView` + `onBarcodeScanned` 未实测；`Camera.launchScanner()`
  （系统级扫码，不需要相机权限）没有采用。
- Metro 对 `.mts` 的解析（已在 `metro.config.js` 里登记 `sourceExts`）未实测；
  `@openwhale/protocol` 的跨包 alias（`extraNodeModules`）也未实测。
- 键盘避让、滚动到底部、深色主题在小屏上的观感都没看过。
- 分块拼装在内存里完成（受 `MAX_ASSEMBLY_BYTES = 48 MB` 保护），真正的流式落盘没做。

### 5.2 根本没做

- **协议里没有 WOL 帧，"远程开机"不是一个按钮**：只做了唤醒入口 + 配置引导。手机无法在
  4G/5G 下向家里局域网发 UDP 广播，RN 也没有免原生模块的 UDP 能力，所以没有内联 Kotlin 模块，
  也没有伪造 `power/request {action:'wake'}`（电脑端会直接拒绝它）。
  电脑端仓库里已经有 `wol-proxy.mjs`（`WakeProxy` 能发魔术包，纯 Node dgram），但在本次交付时
  它还没有对外暴露 HTTP 路由；手机端的"唤醒代理地址"就是为它（或用户自建的等价脚本）预留的，
  支持的占位符：`{computerId}` / `{id}` / `{mac}` / `{name}`。
- HTTP 一次性下载路径（`file/meta.downloadPath`）写好了但默认关闭（`PREFER_HTTP_DOWNLOAD = false`）。
- 后台保活 / 推送唤醒：`expo-background-task` 最小间隔 15 分钟，维持不了长连接，所以没接。
- 手机 → 电脑的大文件分块上传；多选附件（当前一次一个）。
- iOS 上架相关的一切（需要 Apple Developer 账号）。

### 5.3 需要电脑端配合才能完成的行为（跨包不一致，已在 `packages/mobile` 侧容忍）

1. **已绑定设备的重新握手**（阻塞级）：`gateway.mjs` 校验的签名原文是
   `openwhale-hello:${session.nonce}`，而 `session.nonce` 是**服务端**在连接建立时生成、
   认证成功后才在 `hello/ack` 里下发的——手机在发 `hello` 时拿不到它，因此按当前电脑端实现，
   **已绑定设备无法通过签名校验**（会收到 `bad-signature` 然后被断开），也就是"重开 App 直接恢复连接"
   这条产品需求在电脑端修复前走不通。手机端的实现见 `src/core/pairing.mts#helloSignatureMessage`：
   默认签自己的 nonce，一旦电脑端在握手前下发挑战值（或把校验改成用 `frame.nonce`），
   客户端只需传入 `serverNonce`，不需要改协议。
2. **二维码里只有指纹（`fp`），没有电脑公钥**：`hello/ack.proof` 因此**无法被手机验签**，
   手机只能做指纹比对（已实现，不一致直接断连）。
3. `devicePublicKey` 的编码：protocol typedef 只说"base64url 编码的 Ed25519 公钥"，而电脑端
   `state.mjs#verifyDeviceSignature` 用 `{format:'der', type:'spki'}` 导入——手机端因此发
   **44 字节 SPKI DER**（`src/core/keys.mts` 有单测证明它能被 Node crypto 导入并验签）。
4. `power/request` 的 `cancelToken`：protocol 的 typedef 里没有这个字段，电脑端
   `gateway.mjs#handlePower` 也没把手机传来的令牌转给 `PowerManager`；好消息是
   `PowerManager.cancel()` 允许不带令牌，所以"取消"功能是通的。
5. cloudflared 快速隧道每次重启换域名 → 手机保存的地址失效；官方明确说它只适合测试。
   手机端做了地址轮换与并集更新，但**不能**修好"域名变了"这件事。
