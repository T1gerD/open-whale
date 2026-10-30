# Open Whale 网页版客户端（PWA）

鸿蒙 NEXT / iOS Safari / 任意移动浏览器都能用的**零构建**网页版：
插件把本目录当作静态文件在 `/openwhale/app` 下提供（插件端路由按 `packages/plugin`
的规格实现），浏览器用原生 ES Module 直接加载，没有打包器、没有 CDN、没有运行时依赖。

```
packages/webchat/
├── index.html             # 应用外壳（绑定页 + 聊天页 + 设置弹层）
├── app.js                 # 入口：UI（含会话标签条）、连接生命周期、附件、设置
├── styles.css             # 移动优先样式，深/浅色
├── manifest.webmanifest   # PWA 清单（添加到主屏幕）
├── sw.js                  # 离线壳 Service Worker（module worker，按协议版本分缓存，不缓存聊天）
├── lib/                   # 纯逻辑，可在 node --test 里直接 import
│   ├── bytes.mjs          # base64 / base64url / utf8 / 体积格式化
│   ├── protocol.mjs       # 协议常量镜像（由测试与真实 protocol 比对）
│   ├── endpoints.mjs      # 地址分类/排序/竞速选路（协议镜像）
│   ├── pairing.mjs        # 绑定链接 / JSON / 裸 base64url 解析
│   ├── keys.mjs           # Ed25519 身份、SPKI DER、hello 签名、ack 验签
│   ├── messages.mjs       # ChatModel（单会话合并）+ ChatTabsModel（多标签路由/未读/审批）
│   ├── upload.mjs         # 附件传输选择 + 分块上传背压状态机
│   ├── connection.mjs     # WebSocket 竞速 / 退避重连 / 心跳
│   ├── storage.mjs        # localStorage 持久化（标签 / 设置 / 离线队列）
│   └── qr.mjs             # 相册图片二维码识别（BarcodeDetector + jsQR）
├── vendor/                # 本地化的第三方库（保留 LICENSE 文件）
│   ├── tweetnacl.min.js   # 1.0.3，Unlicense
│   ├── jsqr.js            # jsQR 1.4.0，Apache-2.0
│   └── package.json       # 仅让 Node 测试按 CommonJS 加载 vendor UMD
├── icons/                 # PWA / apple-touch 图标（tools/make-icons.mjs 生成）
├── tools/make-icons.mjs   # 零依赖 PNG 图标生成器（一次性产物，不参与运行时）
├── test/                  # node --test 纯逻辑测试
└── README.md
```

## 如何联调（本机没有真机时）

1. 在仓库根跑测试：`node scripts/run-tests.mjs`（会自动发现 `packages/webchat/test/*.test.mjs`）。
2. 启动插件（任选其一）：
   - 正常安装：按 `docs/install.md` 把插件装进 DSH 并启用；
   - 开发模式：按插件 README 用 `dsh` 加载 `packages/plugin`。
   插件会在 `http://<电脑IP>:8787/openwhale` 出配对页。
3. 电脑上打开配对页，页面上的**第二个二维码**就是网页版地址
   （形如 `http://192.168.1.5:8787/openwhale/app#p=<base64url(绑定JSON)>`）。
4. 手机与电脑在同一 Wi-Fi / Tailscale 后，手机浏览器打开该地址：
   - 地址栏带 `#p=` 时会自动解析并连接；
   - 也可以把链接或绑定 JSON 粘贴到绑定页输入框；
   - 还可以点「从相册识别二维码」选一张二维码截图（BarcodeDetector 优先，jsQR 兜底）。
5. 成功绑定后请**收藏这个页面**并添加到主屏幕（iOS：分享 → 添加到主屏幕；
   鸿蒙：浏览器菜单 → 添加到桌面）。之后打开即自动重连。

调试时用到的手动地址：设置 → 连接 → 手动地址（`192.168.1.5:8787`），
「测试地址」会请求 `GET /openwhale/health` 校验；连接方式可切
自动 / 局域网 / Tailscale / 公网隧道。

### 手动验证清单（网页版专属）

- [ ] `#p=` 链接自动绑定；二维码过期时提示「二维码已过期」而不是静默失败
- [ ] 绑定成功后刷新页面能自动重连（签名 hello，不再用配对 secret）
- [ ] 断网再恢复：横幅显示重连，消息离线排队，恢复后自动发出且电脑端只收到一条
- [ ] 顶部标签条常驻：每个标签显示标题 / 运行点 / 未读数 / 审批角标 / 关闭 ×，末尾有「+」和「全部会话」
- [ ] 打开 A、切到 B：A 的回复继续流式进入 A 的标签（未读 +1、有运行点），切回 A 立刻看到完整回复
- [ ] 「全部会话」里能打开更多标签（已打开的显示「已打开」并直接切过去），最多 9 个；刷新/重连后标签与当前会话恢复
- [ ] 电脑上触发权限请求：当前标签内出现审批卡片（工具名 / 原因 / 允许一次 / 拒绝），
      作答后卡片消失；带 `expiresAt` 时有倒计时，超时提示交回电脑；连续两条请求会排队；
      其它标签有审批时标签上出现「!」角标
- [ ] 电脑端 AI 回复流式显示，结束后全文与电脑端一致（无重复拼接）
- [ ] 发送 3 MB 图片：进度条上升、电脑端落盘到会话工作目录、模型能读到
- [ ] 电脑推文件到手机（`file/offered`）：出现文件卡片，点击能下载
- [ ] 深色/浅色切换、iOS 键盘弹起时输入框不被遮挡
- [ ] 主屏幕图标 / 离线壳（仅在 https 或 localhost 下 Service Worker 生效）

## 与协议的关系

`packages/protocol/src/index.mjs` 是唯一权威。浏览器里不能 import 插件包内路径，
所以 `lib/protocol.mjs`、`lib/endpoints.mjs`、`lib/pairing.mjs` 是协议的精简镜像；
`test/protocol-mirror.test.mjs` 会：

1. 逐项 deepEqual 镜像常量与真实协议常量；
2. 用同一批载荷比对 `parsePairingPayload` 的返回值（含错误文案）；
3. 用同一批地址比对排序结果。

协议一改，测试立刻变红——这是镜像机制唯一可接受的安全网。

## 本机已做的联调验证

除了 Node 单测，还用 **headless Chrome + 临时假网关**（脚本未入库）做过一轮端到端验证：

- 假网关用仓库里 `packages/plugin/src/ws.mjs` 提供真实 WebSocket 端点，
  用 `node:crypto` 扮演电脑端，**严格校验浏览器 hello 里的 Ed25519 签名并回带 proof**；
- 浏览器侧（Chrome headless）用 `#p=` 链接完成首次绑定，并验证：
  连接状态变「已连接」、`session/state` 快照渲染、
  `chat/message` 同 messageId 全文替换（无重复拼接）、`chat/done` 覆盖、
  `file/offered` 文件卡片、`sessions` → `session/selected` → `session/state` 的会话切换
  与 `approval/ask` 审批卡片；
- 再用**同一个浏览器 profile 去掉 `#p=` 刷新**，验证「签名 hello 重连 + 快照补齐」；
- 控制台零未捕获异常。

另外与**真实插件（隔离 DSH 实例，端口 3987）**做过一次真机等效联调：
用 `pairing.json` 的 payload 生成 `#p=` 链接，headless Chrome 通过 CDP 驱动：

- 页面 **763ms 进入在线**（`局域网 · http://<ip>:8787`），双地址竞速稳定，
  不再出现「每秒重连」死循环；
- 自动输入并发送一条消息 → 本地用户气泡出现；电脑端因 DSH 未登录回错误（预期行为），
  助手气泡显示错误文案；
- 保持在线 6 秒无掉线、零未捕获异常。

> 竞速加固：同一 deviceId 的两条竞速 socket 都会完成 hello/ack。连接管理器在收到第一个
> ack 后等 400ms「确认窗口」再定 winner；若窗口内 winner 被服务端以
> `replaced by a newer connection` 顶掉，就改用另一条已 ack 的 socket，而不是整轮重连。
> 已在线后若再被同一设备的新连接替换，则按**更长的指数退避自动重连**（不会每秒互相顶掉），
> 横幅同时给出提示；`stop()`（用户主动断开）之后不再自动重连。

真机（鸿蒙/iOS）联调仍需按上面的手动验证清单执行。

> v2.4.0 的会话标签条（多会话并行、未读/运行点、审批角标、关闭/新建标签）的数据层
> （`ChatTabsModel`）与帧路由已由 `test/tabs.test.mjs` 覆盖，但**还没有真机联调**：
> 需要在浏览器里按上面的清单验证「A 在后台流式、切回不丢」这类真实时序。

## 已知限制

- **Service Worker / 安装提示需要安全上下文**：通过 `http://<局域网IP>:8787` 打开时
  浏览器不注册 SW（没有离线壳，manifest 安装提示也可能不出现），但聊天、附件、
  相册识图（jsQR 路径）都正常；用 Tailscale Serve 的 https 地址或 localhost 才完整。
- **离线壳需要 module worker 支持**（Chromium 91+ / Safari 16.4+ / Firefox 114+）：
  `sw.js` 直接 import `lib/protocol.mjs` 的版本号来给缓存命名，避免版本号写死后与新
  前端混用。更老的浏览器注册会失败（被 catch 掉），在线聊天不受影响，只是没有离线壳。
- iOS 的「添加到主屏幕」在 http 上可用，但独立窗口模式下 localStorage 可能被系统清理，
  需要重新扫码；公共电脑不要绑定。
- 网页版没有系统级推送；页面在后台时 iOS 会冻结 JS，回到前台自动重连。
- 相册识图受图片清晰度影响；失败时会提示换图，也可以直接用系统相机扫码打开链接。
- 聊天记录只保存在本浏览器（localStorage），不同浏览器/设备之间不共享。页面刷新只
  缓存**当前标签**的消息；其它标签切过去时会用 `session/snapshot` 重新取一次。
- 标签条最多同时打开 9 个会话（`SESSION_WATCH_LIMIT + 1`：当前会话 + 8 个后台订阅），
  因为电脑端不会为一个设备订阅更多后台会话；老电脑端（没有 `session-tabs-v1`）退化成
  单标签，切换会话会替换页面内容。
- 单个附件上限 64 MiB；网页版对超大文件的分块下载做了 32 MiB 保护（超过请用电脑取回）。

## 测试与语法检查

```bash
node scripts/run-tests.mjs            # 全仓测试（含本目录）
node --check packages/webchat/app.js  # 单文件语法
node packages/webchat/tools/make-icons.mjs  # 重新生成图标（改了图标才需要）
```
