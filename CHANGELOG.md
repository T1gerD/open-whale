# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [3.0.8] - 2026-11-12

真机反馈：配对页第二步里「局域网」和「公网隧道」都标着「（当前不可用）」，只有 Tailscale 能点。

### 修复

- **可选线路不再被当前连接方式过滤**（`src/page.mjs`）：按钮是否可点原来是按
  `#reachableEndpoints()` 算的，而那个列表已经按连接方式偏好过滤过。于是把默认方式切成
  「只走 Tailscale」以后，局域网按钮就被判成「没有地址」并禁用——用户再也切不回局域网，
  明明 `192.168.43.222:8787` 是通的（`netstat` 显示 8787 监听在 `0.0.0.0`）。
  现在改成按 `report.detected`（检测到的全部地址，不过滤）判断，模式只决定「显示/使用哪一类」，
  不决定「能不能选」。
- **不可用时写明原因**：局域网 → 「电脑可能只监听了本机回环」；Tailscale → 「电脑端未登录或未连接」；
  隧道 → 「电脑端未开启隧道，或没装 cloudflared」。原来是笼统的「当前不可用」，看不出是没装还是没开。
- **说清「可用地址」为什么只有一条**：默认方式不是 `auto` 时，地址列表标注
  「已按「只走 Tailscale」过滤，其它线路见下表」，并说明换一个方式就能用。
- 步骤二顶部加一行「当前默认连接方式」，避免把「过滤」误读成「不存在」。

### 测试

- `gateway.test.mjs` +2：mode=tailscale 且 lan/tunnel 都有地址时两个按钮都不得禁用、
  地址列表带过滤说明；只有 lan 地址时隧道按钮要带「没有隧道地址…」的具体原因。

## [3.0.7] - 2026-11-12

真机反馈：相册选图能连上了，但「点「从相册识别二维码」→ 弹窗里选『拍照』→ 拍电脑屏幕」仍然报
「这张图里没有找到二维码」。

### 修复

- **拍照这条路重做解码阶梯**（`lib/qr.mjs`）：原来的做法是「整幅缩到 1024 / 2048 再解」。
  截图和正对的照片没问题，但手机对着屏幕拍的照片里二维码常常只占画面 10% 甚至更小——
  缩到 1024 宽以后一个模块只剩 2～3 个像素，jsQR 必然认不出，「没有找到二维码」就是这么来的。
  现在按便宜到昂贵分四步，任一步成功就停：
  1. 整幅 1024（截图在这一步就够了，几十毫秒）；
  2. 整幅 2048（稍微远一点的照片）；
  3. 整幅 2048 + **直方图拉伸**（屏幕反光、暗光、白平衡偏掉的照片，二值化才分得开）；
  4. **3×3 原分辨率裁块**（相邻块重叠 12%，每块渲染到 ≤1400 px）——二维码只占画面一角时，
     相当于把那一角放大回「一个模块 6～8 px」，jsQR 才看得到。
- **超大原图先缩成「工作图」再处理**：手机原图 4000～8000 px，直接 `drawImage` 到小画布在移动端
  GPU 上会撞纹理上限（>4096 常常画出一片空白）。现在先用 `createImageBitmap(..., resizeQuality: 'high')`
  缩到长边 2400（区域平均，比 canvas 的一次双线性干净），后面的整幅与裁块都在这张图上做。
- **画布空白能被认出来**：所有尝试都解码出纯色像素时，提示改成「这张照片在浏览器里解码成了一片
  空白（常见于手机原图过大）」，而不是笼统的「没有找到二维码」。
- **`createImageBitmap` 失败时退回 `<img>`**：HEIC / 少见编码上 `createImageBitmap` 会直接抛错，
  而 `<img>` 用的是另一套解码器，常常还能读。另外统一传 `imageOrientation: 'from-image'`，
  先按 EXIF 把照片转正。
- **绑定页新增「拍照识别」按钮**（`capture="environment"`）：不再依赖相册选择器里那个「拍照」入口，
  点一下直接进系统相机，失败时也由本页给出提示。
- **失败提示带上照片信息**：`（照片 3024×4032 · 2.1 MB · image/jpeg）`。「没解出二维码」和
  「照片根本没解码出来」是两种完全不同的故障，真机反馈时带上这行就能定位。
- 重复识别同一张图不再重复下载 jsQR；识别失败只写 `console.debug`，不弹「页面出错」。

### 测试

- `qr.test.mjs` +10：解码阶梯顺序、小图不裁块、裁块边界/重叠/不放大、整幅失败退到裁块并报告所用块、
  空白画布的专属文案、`looksBlank`（含明暗交替图不被误判）、`stretchContrast`（不就地改调用方像素）、
  big-image 的 `createImageBitmap` 回退、失败结果带照片尺寸。
- 全量 `files=57 tests=973 pass=931 failed=1`（`dsh-bridge` 仍是环境基线，HEAD 复跑同样失败）。

## [3.0.6] - 2026-11-12

真机反馈三条：协议版本仍显示 3.0.0、每次都弹「页面出错」、相册选二维码仍然不可用。

### 修复

- **相册选二维码真的能用了**：`scanBitmapForQr` 调用 `env.jsQR` 时**没有 await**。浏览器实现是
  `async (...args) => (await loadJsQr())(...args)`（要先动态加载 250 KB 的 vendor 脚本），返回的是
  Promise，于是 `code.data` 恒为 `undefined`，每一张图都被判成「这张图里没有找到二维码」——
  电脑上（有 `BarcodeDetector`、走原生解码）能过，手机走 jsQR 就必失败，这就是「两边表现不一致」
  的原因。测试里 jsQR 是同步的，所以一直没被发现；新增用例把「异步 jsQR」钉住。
- **没有 `createImageBitmap` 的浏览器**（老 Safari / 部分 WebView）：`<img>` 兜底返回的是带
  `width/height` 的包装对象，之前直接喂给 `drawImage` / `BarcodeDetector` 会抛错。现在统一取
  `source`（真正的图片元素），并且不再在 `scanFile` 里重新包一层把它丢掉。
- **jsQR 的 vendor 路径改用模块自身地址解析**（`import.meta.url`）：页面是 `/openwhale/app`
  （无尾斜杠）还是 `/openwhale/app/`，`document.baseURI` 会解析出两个不同路径，其中一个是 404。
- **「页面出错：Script error.」不再打扰用户**：跨源脚本异常被浏览器脱敏成这一句，没有文件名、
  没有行号——它来自手机浏览器注入的脚本（鸿蒙/UC/QQ 浏览器的工具栏、广告拦截等），不是本站代码。
  现在识别到这种无位置的 `Script error.` 只写 console。真实错误仍然提示，并且**带上定位**
  （`页面出错：xxx（app.js:1234）`），同时落进「最近错误」列表。
- **启动失败不再只剩一句红条**：`boot()` 加了 catch，失败时把原因写进绑定页，并记进「最近错误」。
- **`history.replaceState` 加保护**：部分手机 WebView 在外部唤醒的页面上会抛 SecurityError，
  之前会在 boot 里抛断启动、页面停在绑定页。
- **版本显示不再混淆**：设置 → 关于新增「电脑端插件」一行（来自 `hello/ack` 的 `serverVersion`），
  协议一行标成「协议版本 3.0.0 · wire 格式，未变」；绑定页页脚写「协议 wire 3.0.0」。
  协议版本是**帧格式契约**，3.0.4/3.0.5/3.0.6 都没有改帧形状（只加了可选字段），所以它不动；
  产品和插件版本看「网页版版本」「电脑端插件」两行。
- 绑定页/错误提示新增 `.about-hint` 与 `.error-log` 样式。

### 测试

- `qr.test.mjs` +2：异步 jsQR 必须被 await、`<img>` 兜底必须把图片元素本身交给 `drawImage`。
- `renderer.test.mjs` +2：`Script error.` 过滤 + 错误定位、「boot 必须 catch」。
- 全量 `files=57 tests=962 pass=920 failed=1`（`dsh-bridge` 仍是环境基线，HEAD 复跑同样失败）。

## [3.0.5] - 2026-11-12

**扫码绑定的两个卡点：官方短码认不出来、设备上限打满还在发码。**（3.0.4 的同步层 / 渲染层 /
滚动层改动全部包含在本版内，这一版只加绑定修复。）

- **相册识别只认 `#p=`，认不出官方短码**：电脑上那张码是 `…/openwhale/app?s=<密钥>`（约 90 字符），
  而「从相册选二维码图片」走的 `parsePairingInput` 只认整段载荷 `#p=…`，于是提示
  「链接里没有找到绑定参数（#p=…）」，页面停在绑定页不动。现在 `readPairingFromBitmap` 支持
  `resolveText`：解析不出载荷时回同源 `/openwhale/pairing.json` 兑换一次并校验密钥一致；
  粘贴框也走同一个兑换函数（`payloadFromScannedText`），三条入口不再各写一套。
- **兑换失败不再卡在「正在识别…」**：过期、已被使用、设备已满、跨主机地址都会把真实原因
  显示在绑定页；跨主机时给出「请用它直接打开」的地址，因为同源限制下本页无法代它兑换。
- **设备上限（默认 5 台）**：`/openwhale/pairing.json` 会返回 409 与原因，二维码生成为空。
  本版不改上限，只保证绑定页看得见这句话——先解绑不用的设备再生成新码。

## [3.0.4] - 2026-11-12

**聊天显示流程重做：一个全序的同步层 + 一套 keyed 渲染 + 显式滚动跟随。**

真机上反馈的「发送后气泡延迟/先出现又消失」「工具行出来了正文空白/回复被吞」「画面上下跳」
看着是五个问题，实际是同一件事：同一份聊天列表被实时帧、会话快照、本地乐观消息、完成补拉
四条路径同时改写，且没有任何一条保证顺序。这一版不再补分支，而是收敛成三条单一路径。

### 修复

- **同步层：快照 + 重放缓冲（根治吞消息 / 回滚 / 回复消失）**。`ChatModel` 新增
  `idle → syncing → ready` 状态机：请求快照时记一个 generation，期间到达的实时帧先入
  buffer、不进消息列表；快照落地后 `resetTo(snapshot)` → 按到达顺序重放 buffer → ready。
  **已有底座**时，比已知水位更旧的快照（`head < cursor`）和旧 generation 的快照直接丢弃——
  「回复完成后被晚到的快照回滚（62 → 60）」在这一层物理上不再可能发生；**还没有底座**时
  旧水位的快照必须接收（此时它是唯一的历史来源，丢掉就等于长会话只剩刚发的一条），
  靠「快照只管 `<= head`、更新的实时消息接在后面」保证不重复。重连走 `session/sync(cursor)`，
  服务端回事件就重放、回快照就 reset + 重放；4 秒等不到响应则强制回 ready（旧电脑端/丢帧兜底）。
  同时删掉了「120 秒内同文本算同一条」「空快照不清空」这类时间启发式，去重只认
  `msgId` / `callId` / `hist_<seq>` 与「未确认（optimistic）+ 计数抵消」。
- **快照之后的消息按「到达序号」排序，不再按墙钟**：助手帧（`chat/message` / `chat/delta`）
  根本不带 `at`，本地填的是接收时刻，而用户消息带的是发送时刻；异步到达时两者交叉，会把
  回答排到提问前面。`ChatModel` 现在给每条消息发一个单调递增的 `arrival`，`tail` 段按它排，
  正好对应「按到达顺序重放 buffer」的语义；`messageOrderKey` 的四层（seq / 墙钟 / arrival /
  optimistic）各自只在自己的空间里比较，历史 `hist_<DSH seq>` 与插件事件日志 seq 永不跨空间比大小。
- **服务端快照水位与内容同一时间点**：`#deliverSessionState` 原先读完历史才取 `log.head`，
  watermark 比消息新，客户端把 cursor 设成它就会跳过「读历史之后、取 head 之前」落进日志的
  `chat/done`——这正是「正文空白/回复被吞」。现在先取 `head` 再读历史，宁可多重放一小段
  （按 seq 幂等）也不跳过任何一帧；`session/sync` 回传 `rid`，客户端据此丢弃旧代快照。
- **空占位不再吞 delta**：`chat/message` 的空文本只负责建出气泡，不再登记成「已收到全文」，
  后续 `chat/delta` 正常累积；`chat/done` 之前也不会被空占位「锁死」。
- **快照先标 DONE 时允许迟到正文补入**：助手正文只增不退——快照把回答标成 DONE 且正文为空
  时，迟到的 `chat/message` 可以补入；更短的文本永远不会覆盖已有正文。
- **一套 keyed DOM 差分替换整页重建**：渲染器维护 `Map<key, node>`，新增追加、删除移除、
  变化只 patch 自己；结构不变时流式只替换最后一条的 `.bubble-text`。删除 `appendLocalUserBubble`
  与 `messageSignature` 哈希跳过，发送/流式的成本是 O(变化量)，与历史长度无关。
- **长会话窗口**：初始只挂最近 30 条，顶部「加载更早」按 30 条递增加载并保持视口位置；
  不再靠「截断 6000 字 / 只显示 8 条工具」硬压。
- **发送先上屏、附件后台上传**：点发送立刻插入本地气泡（带附件名/大小）并同步渲染一次，
  再上传附件、补 `fileId`、发送。带图消息不再等 3–5 秒才出现；任何一步失败气泡都留着并带「重试」。
- **滚动改成一个显式状态**：只有真实手势（触摸移动/滚轮）能关闭跟随，程序滚动带 160ms
  静默窗口且用 instant，不再把自动跟随误判成「用户上滑」而把气泡留在屏幕外；发送后立即
 校正一次并在下一帧再校正；不跟随时显示「回到最新」。
- **气泡空白 bug**：`.bubble` 的 `white-space: pre-wrap` 会把模板缩进当正文，改为只在
  `.bubble-text` 上保留空白。`?v=304` 静态版本号一并升级，避免手机继续跑旧模块。
- **回放测试**：新增 `sync-replay.test.mjs`（11 项），把「快照 + 事件序列」喂给模型并断言
  消息数单调、assistant 正文不回退、done 非空、无重复消息 id；另有旧代快照丢弃、水位回退、
  无底座时接收旧水位快照、空占位吞 delta、DONE 补正文、未确认消息保留、到达顺序重放，
  以及「有底座后发出的提问（乐观 → echo）排在历史之后、回答之前」。另有 `renderer.test.mjs`
  （7 项）对渲染器做结构性断言：只有一套 keyed 渲染、流式只 patch `.bubble-text`、
  窗口 30 条 + 加载更早、`scroll-behavior: auto`、发送先上屏（`addLocalUserMessage` 早于上传）。

## [3.0.1] - 2026-11-10

**真机反馈修复：手机消息顺序、前后台在线状态、会话名、结构化提问显示；审批代理加固。**

### 修复

- **手机端消息顺序与电脑端一致**（用户真机反馈「电脑端顺序是对的」）：手机/网页版原先按墙钟
  `at` 排序，而 `chat/echo` 的 `at` 是网关收到补发消息的时刻——离线排队后重连补发的消息会被
  排到所有回复之后。现在按网关事件日志的单调 `seq` 排序（`hist_<seq>` 快照同样解析），`echo`
  的迟到 `at` 只补空缺不覆盖；只有整表都拿不到 seq（旧缓存/旧电脑端）时才退回 `at`，本地乐观
  消息永远最后、拿到 seq 后落位。持久化也保存 `seq`/`optimistic`，刷新不会重新洗牌。
- **手机切后台/锁屏不再谎报「在线」**：网页版心跳 `ping` 带上 `visible`，电脑端新增
  `devicePresence()`（`foreground`/`background`/`offline`，70s 新鲜度窗口），插件页显示
  **在线（前台）/ 在线（后台）/ 离线**，`/openwhale/health` 增加 `onlineDevices` /
  `foregroundDevices` / `backgroundDevices`。后台仍**算可用**：审批与提问照常推送，回到前台
  就能看到待办（转发资格没有改）。
- **会话名区分**：DSH 的 `readTitleSnapshots()` 返回的 `value.title` 是
  `SessionTitleSnapshot` **对象**（`title.title` 才是字符串），旧代码只认字符串，标题永远
  取不到，同一 cwd 的会话全显示成 `default-workspace`。现在兼容对象/字符串形状、`rejected`
  与按请求顺序兜底；没有真实标题时用 `cwd 末段 · id 后 6 位`，真实标题撞名按打开顺序
  确定性加 `#2/#3`。
- **结构化提问（`ask_user_question` / 计划审阅）在手机上显示题干并在答后留痕**：电脑端
  `#sanitizeQuestions` 现在校验并透传 `intent.display`（DSH 把本地化的人话放在
  `{question,detail,approve}`，`question` 可能为空），网页版按
  `question → intent.display.question → header → detail` 回退，永不渲染空题干；作答后
  可点卡片变成只读「提问 · 已回答」摘要（题目 + 所选答案），`question/resolved` 不再让
  聊天流里凭空少一条记录，刷新后仍能从 localStorage 恢复。
- **审批 signal 代理加固**（交接文档第六节第 3 项）：启动时跑一次**本地可验证、无副作用**的
  自检（合成 `AbortController` 走一遍转发链），并按 DSH 版本白名单（已实测 `0.2.2-rc.1`，
  同 `x.y.z` 家族匹配）记录状态；新增配置 **`experimentalDualApproval`**（默认开，显式
  `false` 关闭）：关闭/自检失败时**完全不写 `req.signal`**，退回「手机作答 + 桌面弹窗自己
  点掉」，手机卡片与先答先算不受影响。`bridge.approvalProxyStatus()` 提供给 health（部署后真机发现 `index.mjs` 的 bridge 适配层漏转发这个 seam，health 曾一直显示 `approvalProxy:null`；已修并加端到端 + 结构回归断言）。
- **手机重复气泡修复（真机反馈「同一句『看这个』出现两遍」）**：手机消息进入 DSH 日志时会带上插件注入的附件提示；历史快照重建时同一条消息拿到的是 `hist_<seq>` id，与本地气泡的 `usr_<msgId>` 不同 → 重连/切标签后多出一条蓝色气泡（第二遍还带路径原文）。现在电脑端记录「DSH 消息 id → 手机 msgId」，历史快照带 `msgId`+`seq` 并剥掉附件提示；网页版优先用 `usr_<msgId>` 合并本地气泡（保留附件卡 / mine / 干净文本），并对没有 `msgId` 的旧服务端快照按「同文本+时间接近」兜底去重。
- **手机会话工具集修复（真机：DSH 重启后手机助理“读图工具掉线”/读不了文件）**：插件创建手机会话时没写 `agentPreset`，DSH 重启后由插件 resume 时用 profile 默认预设恢复，请求前下发 34 条 `tool-removal`（`read_image`/`read`/`write`/`edit`/`ops_*`/`web_*` 全被移除，只剩 23 个插件/团队工具）；同一会话在桌面打开过（adopt 桌面 agent）时有 57 个工具。现在 `createSession` 显式写 `meta.agentPreset: 'standard'`，新手机会话恢复后即拥有全量工具。旧会话的 preset 被 DSH 视为“会话启动事实”锁定，需在桌面打开一次或新建会话。
- **切后台后不再立刻显示离线**：移动浏览器切后台会冻结并杀掉 WebSocket，网关原先“没有 socket 就离线”会显示成“离线”。现在记录设备最后状态，**后台断开后 10 分钟宽限期内仍显示「在线（后台）」**（health 计入 online/background 但 `connections` 仍只统计真实 socket），回前台重连立刻恢复「在线（前台）」，超时才真离线。
- **提问摘要卡自动收起 + 附件提示残留清理**（真机反馈）：已回答的「提问 · 已回答」摘要卡原先永久钉在聊天流下方，现在只做 12 秒即时反馈后自动收起（题目/答案仍在会话历史里）；手机聊天流里任何路径出现的「用户通过手机发来了…」附件提示都会被剥掉，回显消息按「同文本+时间接近」合并回本地气泡，旧缓存里的纯提示残留直接丢弃。
- **已关闭的会话刷新后不再复活**（真机：手机端删不掉已连接的会话，每回重启网页都会复现）：`closedSessions` 墓碑此前只存在内存里，刷新即丢；电脑端仍绑着旧会话，重连时推 `session/state` 全量快照，客户端就自动开标签把它弹回来。现在墓碑随标签一起落盘（localStorage，最多 16 个），恢复后已关闭会话的快照不再自动开标签，只有用户主动打开才解除。
- **跨标签单连接（重连风暴根治）**：网页版同一浏览器多开页面/标签时，每个页面各建一条 WS 互相顶掉（服务端日志全是「未收到 CLOSE 帧」，23:33 峰值 26 次/分）。新增 `webchat/lib/leader.mjs`：Web Locks（首选）→ BroadcastChannel 心跳 → solo 三级选主，follower 零连接待命，leader 关闭/隐藏后自动接管（bye 150ms、失联 4.5s、双 leader 按资历收敛）；所有重连入口加 leader guard；新增 10 项测试。
- **手机会话恢复桌面同款工具集（read_image 等）**：DSH Web 会话控制器在 `composeAgent` 里用 `agentPresets.mount(agentCtx, id)` 把 preset 绑到 agent 作用域；插件自己 `ctx.agents.create/resume` 绕过了这一步，所以手机会话只有 19~30 个宿主工具（报 `unknown tool "read_image"`），桌面 GUI 是 57 个。现在插件在 agent setup 里补调 `agentPresets.mount`（按会话已记录 preset，缺省 `standard`），新建与 **旧会话 resume** 都生效，无需桌面打开；失败只记日志不阻断发消息。新增 5 项测试。
- **preset 服务查找更稳**：`agentPresets` 优先从 setup 的 `agentCtx` 取（DSH 文档：agent.ctx 的普通 lookup 走 Host realm），插件根 ctx 兜底；新增 1 项测试。
- **会话列表隐藏空会话 + 按最近聊天排序**：手机「全部会话」里会出现「打开过但从未使用过」的新开会话（空会话，标题按 cwd 兜底）；现在 bridge 用 sessionQuery.listEvents 折叠每个会话的最近消息时间与 blank 状态，隐藏空会话，并按最近一次聊天时间倒序（summary 新增 updatedAt，30s 缓存 + 会话事件即时失效，读失败不隐藏）。
- **新建会话改为本地草稿**：手机点「新建会话」不再立刻 session/create，只在本地开一个 draft: 标签（发第一条消息时才创建），草稿不落盘、不参与 session/select/watch/snapshot，刷新即消失；发消息前创建成功后把标签换成真实 id 再发送。
- **会话状态指示（标签条 + 全部会话列表）**：会话名右侧统一显示状态——在线=绿点、正在回复=转圈（黄/蓝旋转）、等待审批或结构化提问=黄点（优先级最高）；未发送的本地草稿不显示状态。状态由 `ChatTabsModel.statusFor()` 统一计算，标签条签名随之刷新；原来的「在线」文字徽标与「!」审批角标移除。
- **工具流在切会话/熄屏后消失**：切标签、锁屏重连会收到 `session/state` 全量快照，而历史快照的助手消息 id 是 `hist_<seq>`、且不带 `tools` 字段，快照重建就把实时帧积累的工具流整段丢了。现在快照合并会按 `seq` → `callId` → 同文本找到本地旧消息，沿用它的 id 并保留 `tools`/`durationMs`/`truncated`；只有 `activeCall`、没有历史行的快照也会把工具流接回来。新增 1 项回归测试。
- **想排队的消息直接发出去了**：桌面/手机回合刚开始、还在跑工具（没有 assistant 正文）时，网关只在 message/delta 事件登记 activeCall，导致切标签/熄屏重连后的 session/state 快照里没有进行中回合；手机端误判空闲，消息直接投递。现在 typing 和 tool 事件也登记 activeCall（done/error 时清除），快照会带出「只有工具还没正文」的进行中回合并置 typing，手机重新显示忙碌态，发送会进入本地排队。新增 1 项网关回归测试。
- **移除审批卡片的绿色实验提示**：审批同时推到电脑端时，手机卡片里那行「电脑端也已弹出这条审批；在任意一端作答，另一端会自动收起（实验）」不再显示（双端可答已是稳定行为），卡片只保留工具名、原因和操作按钮。
- **设置页 Open Whale 区块重启后缺失**：客户端插件原先 `exports.inject = []`，DSH 客户端加载器不会等 `slots` 服务就绪，`apply` 在 boot 早期跑时 `ctx.get("slots")` 取不到服务、设置区块被静默跳过；重启一次插件后才注册成功。现在按官方设置插件契约声明 `inject = ["slots"]`，加载器会等 slots 就绪后再 apply，每次启动设置里都有 Open Whale。
- **协议清理**：`APPROVAL_TIMEOUT_MS` 标注 `@deprecated` / legacy（3.0.0 双端审批后已无
  「等手机 N 秒再转桌面」阶段，仅保留导出兼容）；`QuestionItem`/`QuestionDisplay` typedef
  补上 `intent.display` 与题干可能为空时的回退约定；`ping` 帧文档化可选 `visible`。

### 变更

- 版本号统一为 **3.0.1**（6 个 manifest / `PLUGIN_VERSION` / `WEBCHAT_VERSION` / `app.json`）；
  `PROTOCOL_VERSION` 保持 **3.0.0**（wire 未变）。`WEBCHAT_VERSION` bump 同时改变
  `sw.js?v=` 与 Service Worker 缓存名，https/PWA 用户刷新后自动换新壳。
- 测试：**54 个测试文件 / 933 项全绿**（v3.0.0 基线 855 项，新增 67 项）。

## [3.0.0] - 2026-10-30

**版本号统一为 3.0.0，并补上「提问」：手机现在既能批权限，也能回答 DSH 的结构化提问。**

### 新增

- **手机 / 网页版回答 DSH 的提问**（`ask_user_question`、计划审阅）：电脑端在 agent 的
  `user-questions/request` 瀑布里注册转发者，把一批问题（含选项、多选、详情、`plan-review`
  意图）转成 `question/ask` 推给在线手机；手机上是「选选项 + 其他文本」的表单，一次整批提交。
  - 阻塞式提问 90 秒没人答就交回桌面（`QUESTION_TIMEOUT_MS`）；`askTimed()` 的提问只用 **30 秒**
    （`QUESTION_TIMED_TIMEOUT_MS`，必须早于调用方自己的超时，否则桌面拿到的是过期等待），
    超时后仍接受补答
    （电脑端保留 5 分钟 `QUESTION_LATE_WINDOW_MS`，手机晚到的答案用
    `ctx.userQuestions.answer()` steer 进 agent）。
  - 答案按 DSH 规则校验：每个问题恰好一条、只能选电脑端给过的选项；未答的显式按「跳过」提交；
    单选题的「其他」覆盖选中项，多选题的「其他」与选中项并列。
  - 审批与提问并列排队、互不覆盖；后台标签里的提问会亮角标；断线后卡片自己收起。

### 变更

- **协议 3.0.0 新增 `questions-v1`**：`question/ask` / `question/reply` / `question/resolved`，
  以及 `QUESTION_*` 上限常量与 `normalizeQuestionAnswers()`。这些是在 1.3.0 之上的**纯增量**，
  2.4.x 客户端不声明该能力，就不会收到这类帧，其余帧格式不变。
- 全部 package 版本、`PLUGIN_VERSION`、`APP_VERSION`、`WEBCHAT_VERSION`、
  `PROTOCOL_VERSION` 统一为 `3.0.0`；插件内的 `src/protocol.mjs` 由脚本重新生成。
- 发版产物名相应变为 `dsh-openwhale-3.0.0.tgz` / `open-whale-3.0.0.apk`；
  版本统一后 tag 应为 `v3.0.0`。

### 修复（本版同时补上的稳定性问题）

- **接管桌面已打开的会话**：`selectSession` / `#ensureAgent` 的 live 分支现在会给接管到的
  agent 在其 scoped ctx 上补注册审批 / 提问转发者（`{prepend:true}`，同一 agent 只注册一次，
  release/dispose 解绑），修掉「手机续上桌面正在跑的会话时，审批与提问只在桌面弹」的缺口。
- **审批等待从 60 秒降到 20 秒**（`APPROVAL_TIMEOUT_MS`），并新增 `approvalTimeoutMs` /
  `questionTimeoutMs` / `questionTimedTimeoutMs` / `questionLateWindowMs` 四个插件配置项
  （审批 clamp 5s–120s），减少「手机在线但没人看」时桌面像卡住的窗口。
- **幂等表落盘**：`<dataDir>/dedupe.json`（启动加载、TTL/容量、去抖原子写、失败只记日志），
  插件重启后同一条重发不会再执行一次。
- **上传串行化 + 单句柄写入**：同一 uploadId 的 chunk 走 promise 链，start 打开 FileHandle、
  chunk 写到 `received` 偏移、end 排空后关闭再 rename；cancel/dispose 关闭句柄。
- **state 不再静默覆盖**：版本不符 / 损坏 / 不可读时先备份 `state.json.*.bak` 再新建。
- **电源时序**：宽限期只由一个本地 timer 承担，到点用 `shutdown /t 0` 执行（不再双倍延时）；
  `cancel` 清 timer 并执行 `shutdown /a`。
- **网关拆分**：绑定页 HTML 移到 `src/page.mjs`，文件分片 / 下载 token 移到 `src/files.mjs`
  （帧分发未动，行为不变）。
- **手机端消息可靠性**：ack 15 秒超时回退重试、`attempts>=8` 显示「重试用尽」、手动「重新发送」
  改用新 msgId（避免被幂等表吃掉）、端点候选去重 + 上限 + 连败淘汰。
- **Android 明文流量**：改为 `network_security_config.xml`（NSC 不支持 CIDR，私网 http 仍需
  全局允许；公网隧道只走 https/wss），保留 manifest 属性作 API 23 兜底。
- **工程门禁**：测试运行器不再只看摘要（摘要 + 非零退出码判红）并新增 `--self-test`；
  release 断言 tag == v${version}、`--frozen-lockfile`、`expo install --check` 失败即红、
  `npm pack --dry-run` 文件清单校验；新增 `scripts/check-docs.mjs`（版本 / 产物名 / 计数一致性）。

### 测试

- 52 个测试文件 / 822 项测试全绿（插件 15 / 384，其余见各包）；新增协议答案校验、插件转发
  （无手机 / 超时 / 迟到补答 / 接管 live agent）、幂等持久化、上传并发、state 备份、power 时序、
  手机端 ack 超时与端点池、runner 自检、文档一致性检查等用例；版本断言同步为 `3.0.0`。

## [2.4.1] - 2026-10-30

**修复网页版聊天页可以横向拖动、消息两边被切掉的问题。**

### 修复

- **超长代码行/路径把气泡撑出屏幕**：`.msg` 是 flex item，`min-width` 默认为
  `auto`（= 内容的 min-content）。一条 Windows 路径或命令行（例如
  `C:\Users\…\node_modules\cc-safety-net\dist\bin\cc-safety-net.js`）会让
  min-content 远宽于手机屏宽，`max-width: 86%` 被压过，气泡涨到 1000px 以上，
  `.message-area` 出现横向滚动条——手机上表现为「聊天页能左右拖、文字两边被切」。
  现在 `.msg` / `.bubble` / `.code-block` 都显式 `min-width: 0`，
  `.message-area` 与整页禁止横向滚动，长代码行改为在 `.code-block pre` 内自己滚动。
- 顺带约束 `img` / `video` / `iframe` / `table` 不超过气泡宽度，行内 `code`
  允许在任意字符处换行。
- 网页版缓存版本号随之更新（Service Worker 缓存名由协议版本 + 网页版版本派生），
  升级后不会继续用旧的 `styles.css`。

### 测试

- 新增 `packages/webchat/test/layout.test.mjs`：对样式表做结构性断言（禁止横向
  滚动、`min-width: 0`、代码块内部滚动、媒体不超宽），防止这类「纯 CSS 回归」
  再溜过去。

## [2.4.0] - 2026-10-30

**会话像 DSH 桌面侧边栏一样用：页内常驻标签条、多个会话同时跑、点一下就切换。**

### 新增

- **会话标签条**：手机与网页版的聊天页顶部常驻一条可滚动标签栏（标题 / 运行中圆点 /
  未读数 / 审批角标 / 关闭 × / ＋），点击即切换；标签与当前会话按助理持久化，重启自动恢复。
- **多会话同时进行**：切走的会话**不会被释放**，它的流式输出、工具活动和审批继续推给手机，
  在标签上表现为运行点与未读数；切回来立刻看到完整内容。
- **`session/watch` / `session/snapshot`**：客户端订阅后台标签的事件，并能在**不改变当前绑定**
  的情况下取某个标签的快照；电脑端只允许取「当前绑定或已订阅」的会话，防止手机枚举其它会话。
- 所有会话帧（`chat/delta`、`chat/done`、`chat/tool`、`chat/message`、`chat/echo`、
  `approval/ask`、`approval/resolved`）现在都带 `sessionId`，客户端据此把事件放进对应标签。
- 电脑端后台标签里的工具调用同样可以转到手机审批（不再要求它是当前标签）。

### 变更

- 协议升到 **1.3.0**（只增不改）：新增 `session-tabs-v1` 能力位、`session/watch`、
  `session/snapshot`；`session/state` 增加可选 `rid` / `active`。旧客户端不受影响。
- 打开标签上限：1 个活跃 + `SESSION_WATCH_LIMIT`（8）个后台订阅。

### 修复

- 切换会话不再释放旧会话的 agent（v2.3.0 会把切走的对话停掉，导致「切走再切回」的回合静默失败）。
- 断线重连后客户端会重新订阅标签、并对当前标签补一次快照，标签不再需要重新打开。

### 测试

- 48 个测试文件 / 747 项测试全绿；新增标签路由、未读/typing 状态机、标签持久化、
  watch 帧构造、后台快照（含 `not-allowed` 拒绝）、切换不释放 agent、解绑释放全部会话等用例。

## [2.3.0] - 2026-10-30

**回到纯粹的远程遥控器：删掉协作，手机能选/建会话，权限请求能在手机上作答。**

### 新增

- **会话选择器**：手机与网页版都能列出电脑上的 DSH 会话（标题、创建时间、是否正在运行），
  点一个就续上那个会话的历史，也可以「新建会话」。选中的会话写进设备绑定，重开应用自动恢复；
  电脑端同一会话正在运行时会直接接管现有 agent，不会重复创建。
- **手机上处理 DSH 权限请求**：电脑端把 `approval/request` 转发给在线手机（工具名 + 原因 +
  允许一次 / 拒绝）。60 秒没人答、手机离线或请求被中止时自动交回电脑弹窗，不会把一轮卡死。
  审批只授权这一次调用，**不改变沙箱边界**——工作目录之外的写入仍会被 DSH 拒绝。
- **插件页二维码**：绑定二维码从聊天输入框「+」里的 `/openwhale` 命令挪到
  **DSH 设置 → 插件 → Open Whale** 的插件页，页面内嵌配对页并提供「在浏览器中打开」。

### 移除

- **多人协作模式整体删除**：共享会话、`collab/set`、`collab/state`、在线成员
  （`session/participants`）、消息里的 `[昵称]` 前缀、手机端「我在对话里的昵称」设置。
  `chat/echo` 保留，但只发给同一台设备的其它连接（多窗口/竞速），不再跨设备广播。
- **聊天输入框「+」里的 openwhale 入口**（`/openwhale` 命令）删除。

### 变更

- 协议升到 **1.2.0**：删除 `collab/*`、`session/participants`，新增 `session/list`、
  `session/select`、`session/create`、`sessions`、`session/selected`、`approval/ask`、
  `approval/reply`、`approval/resolved`；能力位新增 `sessions-v1`、`approval-v1`。
  未知帧照旧忽略，v2.2 客户端仍能连接（协作开关变成静默无效）。
- 一台手机始终只驱动它当前绑定的那个 DSH 会话；同一台电脑上的多台手机可以各看各的，
  也可以各自选中同一个会话。

### 修复

- **安卓聊天页被键盘盖住**：`KeyboardAvoidingView` 在 Android 上改用 `height` 模式并补上
  标题栏偏移，`app.json` 显式声明 `softwareKeyboardLayoutMode: "resize"`，
  输入栏不再落在键盘下面。
- 网页版 `replaced` 断线不再永久停掉自动重连；Service Worker 缓存名从协议/版本派生，
  升级后不会出现 `app.js` 与 `lib/*.mjs` 混版。

### 测试

- 46 个测试文件 / 712 项测试全绿；新增会话列表/选择/新建、审批转发（含「无手机 → 交回桌面」
  与「超时 → 交回桌面」）、客户端会话切换与审批排队的用例。

## [2.2.1] - 2026-10-26

**修复 iOS / 网页版扫第二个二维码打不开的问题。**

### 修复

- **网页版二维码按地址分开生成**：v2.2.0 只渲染排序第一的地址，`auto` 模式下通常是
  Tailscale 的 `100.x`；没装/没连 Tailscale 的 iPhone 根本连不上，表现为「扫了打不开网页」。
  现在局域网、Tailscale、公网隧道各生成一个二维码，**局域网排最前**，每张都标注线路。
- **二维码改为短链接并自动绑定**：网页版二维码不再只是裸地址（之前扫码打开后还要手动粘贴
  配对内容），也不再往二维码里塞整段载荷。现在编码
  `/openwhale/app?s=<一次性配对密钥>`（约 90 个字符，iOS 相机一扫即中），网页端向同源
  `/openwhale/pairing.json` 兑换载荷并校验密钥一致后自动完成绑定。
- 配对页补充 iOS 提示：第一次访问局域网地址会询问「本地网络」权限，请选「允许」。

### 文档

- `docs/install.md` 增加「iPhone / 网页版连不上」排查：选局域网二维码、检查同一 Wi-Fi、
  iOS 本地网络权限、Windows 防火墙放行（插件端口 8787）。
- 版本号 2.2.1；安卓 versionCode 10、iOS buildNumber 2。

## [2.2.0] - 2026-10-26

**连接、协作与多端的整体升级。** 修掉 9 个用户反馈的问题与缺陷清单里的 10 条，新增鸿蒙/iOS
可用的网页版客户端与 Tailscale 专属连接方式，并首次把插件发布到 npm。

### 新增

- **Tailscale 成为独立连接方式**：不再混在「局域网」里。插件与手机端都能显式选择
  `自动 / 局域网 / Tailscale / 公网隧道`，`自动` 的顺序是「上次成功 → Tailscale → 局域网 →
  公网隧道」，不会再让公网隧道抢在直连前面。
- **网页版 / PWA 客户端（鸿蒙 NEXT、iOS、任意浏览器）**：插件在 `/openwhale/app` 提供一套
  零安装的网页客户端，用系统相机扫第二个二维码即可绑定；支持聊天、流式回复、附件、多端同步，
  可「添加到主屏幕」。这是本轮鸿蒙适配的交付形态（RNOH 尚未支持 RN 0.86，详见
  `docs/iOS-HarmonyOS.md`）。
- **iOS 出包配置**：`app.json` 补 iOS 段与权限文案，新增 `eas.json`、GitHub Actions 的
  iOS 模拟器构建工作流（未签名 .app，真机/TestFlight 需 Apple 账号）。
- **相册识图绑定**：扫码页新增「相册识图」，选一张二维码截图即可绑定；原生识别失败时用纯 JS
  解码兜底（华为等无 GMS 机型也能用）。
- **手动输入地址**：不扫码也能填 `host:port`，先探测 `/openwhale/health` 再保存；已配对设备
  可随时改地址。
- **分块上传**：手机发附件改为 512 KiB 分块 + 背压 + 进度 + 断点重试，单附件上限 32 MiB →
  **64 MiB**；上传落盘到会话工作目录内，修复「模型读不到手机发的图片」。
- **电脑 → 手机发文件**：配对页新增「发送到手机」，选一个文件即可在手机聊天里收到下载卡片
  （仅本机浏览器可操作）。
- **协作模式可见化**：手机端可开关协作模式，聊天页显示在线参与者，多人消息带昵称与
  `chat/echo` 回显。
- **长按菜单**：长按气泡可复制 / 重新发送 / 删除；长按代码块只复制代码。
- 手机端 UI 全面重做（WorkBuddy 风格的底部输入栏、状态胶囊、参与者头像条、深浅色、空态）。

### 修复

- **同一条消息被投递两次（AI 回复两遍）**：电脑端新增按 `(设备, msgId)` 的幂等表，手机离线
  队列的重发只会收到 `duplicate` ack，不再重复送入会话；bridge 层再加一道 `callId` 保护。
- **协作模式下回复文本重复拼接**：助手消息改为按 DSH 的 `messageId` 聚合并整条下发
  （`chat/message`），不再按设备循环追加；一条回复只渲染一次。
- **多设备同会话不同步**：新增 `chat/echo` 广播、会话事件日志与游标追赶
  （`session/state` / `session/events`）、在线成员（`session/participants`）。新加入或断线
  重连的手机能看到别人发的内容和正在生成的回复。
- **重启后不自动重连、且没有提示**：记住上次成功地址、前两个候选并发竞速、失败给出可操作
  文案（含尝试过的地址与「换连接方式 / 重新扫码」建议）。
- **重新绑定复用旧连接导致绑定超时**：配对时先销毁同 id 的旧连接、丢弃旧地址列表。
- 解绑提示里的电脑地址不再写死过期端口。
- 公网隧道不再是唯一"常规连接"：局域网默认可用，Tailscale 地址按独立类型参与排序。
- 会改变电脑状态的 HTTP 接口（协作开关、解绑、改名、发送文件、连接方式）限制为仅本机
  浏览器可写，避免经公网隧道被他人操作。

### 变更

- 协议升到 **1.1.0**：只增不改（能力协商 + 新帧），2.1.0 与 2.2.0 可以混用。
- 插件包开始携带网页版静态资源（`webchat/`），体积略增。
- 版本号全仓统一为 2.2.0。

### 优化

- **安装包重新瘦身**：新增 `plugins/withReleaseSize.js` config plugin，把「只发布 arm64
  （`reactNativeArchitectures=arm64-v8a`）+ R8/资源裁剪 + R8 keep 规则」写进 prebuild 生成工程。
  此前 `android/` 不进仓库，CI 重新 prebuild 会丢掉这些手工设置（首次 CI 构建的通用包 =
  126 MB、lib 带 4 个 ABI 合计 101 MB）；现在源码即事实来源，CI 与本地一致。
- 手机端分块上传/流式下载、连接竞速、会话事件日志都做了内存与背压上限，避免大文件/长会话
  把手机或电脑拖垮。

### 测试

- 43 个测试文件 / 656 项测试全绿（协议 31、插件 341、手机端 157、网页版 127），
  零依赖直接 `node scripts/run-tests.mjs` 运行。
- 真实装机验收：隔离 DSH 中安装打包产物后，`node scripts/verify-install.mjs` 的
  health / 二维码载荷 / 网页版静态资源 / Ed25519 绑定与签名 / 能力协商 / 会话同步 /
  幂等重发 全部通过；网页版在 headless Chrome 中完成绑定、在线、发消息与刷新重连。

### 已知限制

- iOS / 鸿蒙：本版交付网页版与 iOS 出包流水线；鸿蒙原生包需等 RNOH 支持 RN 0.86。
- npm：v2.2.0 发布时 npm 网页注册被 Cloudflare 按出口 IP 拦截，npm 包待补发（详见
  `docs/PUBLISHING.md` §3）；插件市场条目使用 GitHub Release 的 tarball，不受影响。
- 手机端审批仍与电脑端一致（DSH 原生弹窗），沙箱边界不变。

## [2.1.0] - 2026-10-25

版本号统一：本版内容与 1.0.8 完全一致，仅把版本标识从 `1.0.8` 统一为 `2.1.0`，
使 tag、产物文件名与源码中的版本号三者一致。

### 变更

- 源码、产物与 tag 三者版本号统一为 2.1.0
- 附件更名为 `open-whale-2.1.0.apk` / `dsh-openwhale-2.1.0.tgz`
- 安装包换用 39.7 MB 的 arm64-only 构建（原 CI 产物为 125 MB 通用包）

## [1.0.8] - 2026-10-24

**一台电脑可绑定多台手机，并支持多人协作。** 同时把安卓安装包体积压到原来的六成。

### 新增

- 一台电脑最多绑定 5 台手机（`MAX_DEVICES`），配对页展示已绑定设备与剩余名额
- 单台解绑：`POST /openwhale/unbind?deviceId=…`（不带参数仍是全量解绑）
- 设备昵称：`POST /openwhale/device-rename`，多人协作时消息带 `[昵称]` 前缀
- 多人协作模式：`GET/POST /openwhale/collaboration`，多台手机共用同一个会话；
  开关在运行时读取，切换后不需要重启插件
- 手机端「我在对话里的昵称」设置项

### 修复

- 打开会话时没有滚动到最后一条消息（历史异步加载 + 虚拟化列表导致只滚到中途）
- 解绑失败提示里的电脑地址写死了过期端口，改用固定端口 8787

### 优化

- 安卓安装包 66.7 MB → **39.7 MB**：只保留 arm64，并开启 R8 代码压缩与资源裁剪
  （配置与实测见 `docs/RELEASE-SIZE.md`；`android/` 是 prebuild 产物，不进仓库）
- 把 expo 系依赖的 `*` 换成实际解析到的具体版本，保证重新安装得到同一套依赖

## [1.0.7] - 2026-10-14

**首个带可安装产物的版本。** 电脑端插件安装包与安卓 APK 均由 GitHub Actions 构建并随
[Release](https://github.com/T1gerD/open-whale/releases/latest) 发布。

### 新增

- 发布流水线（`.github/workflows/release.yml`）：在 tag 上构建插件 tarball 与 APK，
  生成 `SHA256SUMS.txt`，并创建 GitHub Release
- `scripts/build-plugin-package.mjs`：可复现的插件打包（显式文件清单、标准 npm 布局、
  缺文件即失败）
- 安装包 tarball 的端到端验证：在隔离 `DSH_HOME` 中真实安装并启动，10/10 项通过
  （健康检查、二维码生成与手机侧校验、携带公钥、WebSocket 握手、设备绑定、用二维码公钥
  验签、聊天到达助手层、**已绑定设备免扫码重连**）

### 修复

这一版几乎全部工作都在「让别人的机器上也能构建成功」。以下每个问题都是 CI 实测出来的：

- **云隧道路径拼接**：`node:path.join` 按运行平台拼分隔符，而模块参数里的 `platform`
  是目标平台；在 Linux 上会构造出 `C:\cache/x` 这类混合路径，导致发现逻辑静默失败
- **大文件传输缺少背压**：整个文件灌入 socket 内部队列，macOS 上 700 KB 即超时；
  改为「发一帧 → 若缓冲则等 drain」
- **协议副本比对绑定 checkout 行尾**：Windows 的 CRLF 使哈希不一致；生成器与测试统一
  按内容（LF）判定，`sync --check` 同理
- **`android-actions/setup-android@v3` 已损坏**：它会安装早已移除的 `tools` 包；
  改用 runner 预装的 SDK
- **`babel-preset-expo` 版本号写错**：Expo SDK 是 57.0.28，而该 preset 的版本线是
  57.0.15；错误版本直接让 `pnpm install` 失败
- **`.mts` 未被剥离类型**：Metro 只把 `.ts`/`.tsx` 当 TypeScript，`export interface`
  在打包时报语法错误；最终在顶层 presets 加入 `@babel/preset-typescript`
  （`overrides` 写法会因 Metro 不传文件名而失败）
- 关闭握手回显被 RST 丢弃、升级前 HTTP 头被当作帧、非本插件 upgrade 路径连接悬挂、
  `gateway.close()` 永不返回

### 变更

- 仓库内所有版本号统一为 `1.0.7`（此前 tag 与产物名不一致）
- 通过 API 创建的 tag 不触发 `push` 事件，`release.yml` 因此支持手动传入 `tag`

## [1.0.0] - 2026-10-13

第一版。电脑端 DSH 插件 + 手机端 Expo 应用，两侧通过配对后的加密身份互相认证，
手机以个人助理聊天的方式远程使用电脑上的 DeepSeek Harness。

### 新增

**电脑端插件 `dsh-openwhale`**

- 为每台绑定手机建立一个专属 DSH 会话，与桌面正在进行的对话互不干扰
- 在该会话**自己的作用域**内注入「个人助理口语化语气」段落，桌面会话语气不受影响
- 展示一次性绑定二维码：浏览器页 `/openwhale`、DSH 命令 `/openwhale`（终端渲染）、PNG / SVG 端点
- HTTP + WebSocket 服务：帧路由、心跳、文件分片、一次性 HTTP 下载兜底
- 工具活动以状态行推送给手机，不混入助理正文
- 远程关机 / 重启：可取消的宽限窗口；`cancel` 在策略禁用关机后仍然可用
- 局域网唤醒代发（WOL 魔术包）与唤醒前置条件检查清单
- 可选公网隧道：cloudflared 快速隧道的完整生命周期管理（含限流识别与退避）

**手机端 `@openwhale/mobile`**

- 扫码绑定（expo-camera）、多助理列表、助理备注可改
- 之后打开应用无需再次扫码：用设备私钥签名完成重连
- 流式回复渲染、工具活动行、文件卡片与进度
- 离线待发队列、断线指数退避重连、多地址轮换
- 助理详情页的远程电源操作与唤醒引导

**协议 `@openwhale/protocol`**

- 帧词汇、配对载荷、握手签名、防重放、文本截断等共享契约
- 插件内的副本由脚本生成，一致性由测试与 CI 的 `--check` 保证

### 安全

- 二维码只含一次性、10 分钟有效的绑定密钥；绑定即失效，重发作废
- 长期凭据从不经网络传输：手机私钥保存在系统安全存储，电脑身份密钥保存在 `state.json`（0600）
- 已绑定设备以 Ed25519 签名握手认证，服务端用随机数防重放表拒绝重放
- 二维码携带电脑公钥，手机据此验证 `hello/ack`，可识别冒名顶替的隧道
- 一台电脑只能绑定一台手机：即使持有有效二维码，第二台设备也会被拒绝
- 手机只能拉取**本次对话中产出**的文件，不能请求电脑上的任意路径

### 修复（开发期间发现并修正，均已在源码中体现）

- 协议副本随「复制安装」失效：改为包内生成副本 + 一致性测试
- 已绑定设备无法重连（服务端用客户端无从得知的 nonce 验签）：改为客户端 nonce + 防重放表
- 二维码曾只携带 32 字节原始公钥，手机无法导入：改为完整 SPKI DER
- 手机会话未接线模型，导致每条消息都报 `{{model}}` 无值：补齐 inject 与四级回退
- `autoApproveTools` 曾用 guard 实现（guard 只能拒绝）：改为应答 `approval/request`
- 关闭握手回显被 RST 丢弃、升级前 HTTP 头被当作帧、非本插件 upgrade 路径连接悬挂、
  `gateway.close()` 永不返回

### 已知限制

- **远程开机受物理条件限制**：电脑关机后其自身无法唤醒自己，需要同一局域网内一台常开设备
  代发唤醒包，并且需在 BIOS 打开 Wake on Magic Packet、**关闭 Windows 快速启动**
- **手机 UI 与 Expo 原生模块未在真机验证**：开发环境没有 Android SDK；纯逻辑层有 88 项单测
- **暂无端到端加密**：公网模式依赖隧道提供的 TLS；中继方在技术上可见流量内容
- 快速隧道官方定位为测试用途：无可用性保证、域名每次重启会变、部分地区不稳定
- 手机端尚未实现：Wake-on-LAN 原生模块、后台保活、手机→电脑的大文件分块上传、iOS 上架

### 测试

- 382 项测试 / 24 个文件，零依赖即可运行：`node scripts/run-tests.mjs`
- 二维码用独立实现的解码器验证（格式信息、掩码、数据路径、Reed-Solomon 全零 syndrome）
- 端到端覆盖防冒充、防二维码重放、防单机双绑、附件落盘、大文件分片哈希一致
- 发布包（tarball）另行做了「安装后启动并完成绑定/对话/重连」的实测

[1.0.7]: https://github.com/T1gerD/open-whale/releases/tag/v1.0.7
[1.0.0]: https://github.com/T1gerD/open-whale/releases/tag/v1.0.0
