# 审批：双端展示、先答先算与 signal 代理加固（v3.0.0 行为，v3.0.1 加固）

本文只讲**审批**这一条 seam（`approval/request` 瀑布）。结构化提问（`ask_user_question` /
计划审阅）见 `docs/v3.0.0/QUESTIONS.md`；协议帧定义见 `packages/protocol/`。
「自检 + DSH 版本白名单 + `experimentalDualApproval` 开关」是 **v3.0.1** 加的加固
（见下文「三、启动自检与版本白名单」）；v3.0.0 只有 signal 代理本身。

## 一、行为契约

| 场景 | 行为 |
|---|---|
| 请求到达 | 立刻推手机卡片（`approval/ask`）+ 调 `next()` 唤起桌面原生弹窗，两端都能答 |
| 手机先答 | 手机结果生效（`approval/resolved`，`source=phone`）；**开启代理时**顺带 abort 代理 signal，桌面原生弹窗自动收起 |
| 电脑先答 | 桌面结果生效（`source=desktop`）；手机收到 `approval/resolved` 后收起卡片 |
| 手机不在线 | 桌面照常弹窗；手机连上后由 `pendingApprovals` 重放卡片，仍可作答（双端可答） |
| 代理不可用 / 关闭 | 手机作答仍然生效，只是**桌面留一个需要手动点掉的框**（不影响结果，也不占住指挥流程） |
| 请求被中止 | 原始 `AbortSignal` 的中止会转发给代理，桌面弹窗关闭，手机卡片按 `cancelled` 收起 |
| 不含 | 固定等待窗口、转桌面提醒、只读卡片、自动拒绝、停止本轮 |

「先答先算」由 `DshBridge.#onApprovalRequest` 的 `decisionPromise` 实现：两端谁先调用
`#settleApproval` 谁的结果进入瀑布，另一端的后续作答被丢弃（`answerApproval` 返回 `false`）。

## 二、为什么需要 signal 代理

手机先答后关掉桌面原生弹窗，靠的是把审批请求的 `req.signal` 换成插件自己的
`AbortController` 代理，再由 `answerApproval` abort 这个代理。它依赖两条 DSH 内部行为
（2026-11-10 在桌面版实测）：

1. `approval/request` 是 promise 瀑布，最终结果取我们返回的 promise，因此可以先 `next()` 再作答；
2. 前端 `ui-approval` 的 `PendingApproval` **只在自己被作答或 `request.signal` abort 时关闭**；
   审批服务决定之后既不会 abort signal，也不监听 `approval/decided`。

这是 hack，不是公开 API：DSH 升级可能让「写 `req.signal`」或「abort 传回前端」失效。
所以加了两道保险：**启动自检**与**版本白名单**。

## 三、加固一：启动自检（本地可验证、无副作用）

`DshBridge` 构造时跑一次 `runApprovalProxySelfCheck()`，只用新建的 `AbortController`
对象走一遍真实转发链，不碰 `ctx`、不改全局：

1. `AbortSignal` 支持 `addEventListener`；
2. 原始 signal 的 abort 能转发到代理 signal（停止/取消仍有效）；
3. 代理 signal 能写进一个普通对象的 `signal` 属性（审批请求就是这个形状）；
4. 代理 signal 自己 abort 后 `aborted` 可读（手机作答关弹窗走这条）。

结论写进 `openwhale.log`（一行中文），并落到 `bridge.approvalProxyStatus()`：

- 自检通过 → 启用代理；
- 自检失败 → **不抛**，整场退回「不代理」（桌面弹窗自己点掉），手机卡片与先答先算不受影响；
- 自检只能证明 JS 运行时这一侧；它证明不了 DSH 把 abort 传回前端，所以还需要白名单。

## 四、加固二：DSH 版本白名单

```js
export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.2-rc.1'])
```

- **已实测版本**：2026-11-10 桌面版 `0.2.2-rc.1`（updater 的 `pending/update-info.json`
  与 profile 里同批 `@deepseek-ai/*` 依赖都是该版本）跑通过「手机先答 → 桌面弹窗自动消失」。
- **家族匹配**：同一 `x.y.z` 家族的预发布/正式版共用同一份 `ui-approval` 实现，所以
  `0.2.2` 与 `0.2.2-rc.1` 都算已实测；跨小版本（如 `0.3.0`）不算。
- **命中白名单**：正常启用。
- **未命中（含版本读不到）**：**仍然启用**，但日志明确警告「未实测版本，代理可能失效」，
  且 `approvalProxyStatus().tested === false`，方便健康端点/排错时区分。

版本探测顺序（任何一步失败都继续下一步，全失败返回 `null`，绝不抛）：

1. 构造参数 `hostVersion`（测试注入）；
2. 环境变量 `OPENWHALE_DSH_VERSION`（排查/CI 用）；
3. 宿主上下文里可能暴露的位置（`ctx.get('app')` / `ctx.app` / `ctx.get('dsh')` / `ctx.dsh`）；
4. 宿主包清单（`app.asar` 内 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-base` 的 `package.json`）；
5. 桌面版根 `package.json`（`resources/app.asar/package.json`）。

读不到时的表现是 `hostVersion: null`、`tested: false`、reason「运行时 DSH 版本不可读」，
功能照常（这正是「不为读版本引入脆弱依赖」的取舍）。

## 五、配置项：`experimentalDualApproval`

| 值 | 行为 |
|---|---|
| `true`（默认，缺省也是它） | 启用 signal 代理（还需自检通过） |
| 显式 `false` | **完全不写 `req.signal`**：不做代理，桌面弹窗由用户自己点掉；手机卡片、`next()` 唤起桌面弹窗、「先答先算」全部保持 |
| 其他非法值（字符串/数字等） | 按默认 `true` 处理（`resolveDualApproval` 只认显式 `false`） |

它被列进 `volatilize()`，可以在 DSH 设置页热改（保存后插件重新 apply，重建 bridge）。
关闭时启动日志为：`approval: 实验性双端审批已关闭（experimentalDualApproval=false）→ …`。

## 六、日志关键字与降级路径

| 日志（`$DSH_HOME/openwhale/openwhale.log`） | 含义 |
|---|---|
| `代理自检通过（AbortController 转发链可用）；DSH <版本> 已实测` | 自检通过 + 白名单命中，代理可用 |
| `代理自检通过，但 DSH <版本> 未实测，代理可能失效` | 仍启用，建议跑冒烟 |
| `代理自检通过，但运行时 DSH 版本不可读，无法确认是否已实测` | 仍启用，状态里 `tested:false` |
| `代理自检失败（<原因>）→ 自动退回「不代理」模式` | 整场不代理；手机仍可作答 |
| `实验性双端审批已关闭（experimentalDualApproval=false）` | 配置关闭 |
| `signal 代理已启用（手机作答将关闭桌面弹窗）` | 单条请求装上代理 |
| `signal 代理不可用（req.signal 不可写），退回残框模式` | 该请求的 `req` 冻结/只读，降级但不抛 |
| `signal 代理失败，退回残框模式：<原因>` | 写 `req.signal` 抛错，同上 |
| `已 abort signal 代理，通知桌面关闭弹窗` | 手机作答触发了撤销（代理生效的直接证据） |

## 七、状态字段（`bridge.approvalProxyStatus()`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 本进程是否真的会写 `req.signal`（配置关闭或自检失败为 `false`） |
| `selfCheck` | `'passed'` \| `'failed'` \| `'skipped'` | `skipped` = 配置关闭，未跑自检 |
| `hostVersion` | string \| null | 探测到的 DSH 版本，读不到为 `null` |
| `tested` | boolean | 版本是否命中 `TESTED_DSH_VERSIONS`（含同家族） |
| `reason` | string | 一句中文结论，可直接展示/记日志 |

该方法返回全新的普通对象，不暴露内部状态；健康端点可以直接把它放进 `health` 响应。

## 八、升级 DSH 后的验证清单

1. 重启 DSH，看 `openwhale.log` 的第一条 approvals 日志：
   - `已实测` → 无需额外操作；
   - `未实测` / `不可读` → 继续下一步冒烟。
2. 手机连上、绑定会话，把审批策略设为 **ask**（`never` 会直接拒绝，测不出来）。
3. 触发一条需要审批的工具调用（如 `ops_bash`）：
   - 双端同时出现；
   - **手机先答** → 桌面弹窗自动消失（日志出现「已 abort signal 代理」）；
   - 再触发一条，**电脑先答** → 手机卡片自动收起。
4. 若第 3 步桌面弹窗没关：日志会显示「代理不可用/失败」，功能退回「桌面留框」，
   结果仍以先答先算为准。此时把 `experimentalDualApproval` 设为 `false` 可避免无效弹窗。
5. 冒烟通过后再把新版本号加进 `TESTED_DSH_VERSIONS`（注意家族匹配语义）。

## 九、已知限制与上游建议

- 代理失效/`req` 冻结时，手机先答会在电脑端留一个无效弹窗（点掉即可，不影响结果），
  且该弹窗会占用 DSH 输入区；这是降级代价，不是结果错误。
- 开关是为了「DSH 坏了还能用」，不要把它当成常态配置：关闭后手机作答不会关掉桌面弹窗。
- 彻底解决需要上游：让 `ui-approval` 监听 `approval/decided`（或审批服务提供撤回接口），
  插件侧就可以删掉 signal 代理这段 hack。建议对此提 issue/PR。
- 协议里的 `APPROVAL_TIMEOUT_MS` 已标 `@deprecated`（legacy）：双端模式不再有固定等待窗口，
  不要重新引入等待逻辑。
