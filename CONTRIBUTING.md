# 贡献指南

欢迎提交 issue 与 PR。这个项目有两个硬约束，先读它们能省下很多来回。

## 硬约束

### 1. 电脑端插件必须保持零运行时依赖

`packages/plugin` 不从 npm 拉任何东西。原因是 DSH 安装插件的方式是**把包复制进 profile**，
任何依赖树、构建步骤或包外相对导入都会变成用户侧的装机失败点。

这意味着：

- 需要新能力时，优先用 Node 内置模块自己实现（QR 编码器、WebSocket 服务端都是这么来的）；
- 确实无法避免时，在 PR 里说明为什么，并接受它可能被讨论。

### 2. `src/protocol.mjs` 是生成文件，不要手改

协议的权威源是 `packages/protocol/src/index.mjs`（手机端也直接引用它）。插件内需要一份副本，
因为拷贝安装后 `../../` 会解析失败。

改协议的正确流程：

```bash
# 1) 改权威源
vim packages/protocol/src/index.mjs
# 2) 重新生成插件内的副本
node packages/plugin/scripts/sync-protocol.mjs
# 3) 两个包的测试都要过
node scripts/run-tests.mjs
```

`packages/plugin/test/protocol-copy.test.mjs` 会断言副本与权威源逐字节一致，CI 也会跑
`sync-protocol.mjs --check`，所以忘记第 2 步会在测试里立刻暴露。

## 开发环境

- Node ≥ 20（本项目在 24 上开发）。**不需要 `pnpm install`**：除了手机端之外的所有测试都能直接跑。
- 手机端出包需要 JDK 17 + Android SDK，见 [docs/mobile-build.md](docs/mobile-build.md)。

```bash
node scripts/run-tests.mjs              # 全部 24 个测试文件
node scripts/run-tests.mjs packages/plugin   # 只跑插件
node scripts/run-tests.mjs qr                # 只跑文件名含 qr 的
```

## 提交前自检

1. `node scripts/run-tests.mjs` 全绿。
2. 改了协议 → 已重新生成副本。
3. 改了电脑端与手机端之间的帧 → 两边的帧契约测试都更新了（手机端有单独的契约测试）。
4. 新增的行为有测试覆盖；**测试要断言行为，不要断言实现细节**。
5. 涉及安全边界（鉴权、配对、文件访问）的改动，在 PR 描述里写清威胁模型。

## 测试风格

本项目对测试的要求偏高，因为最难发现的 bug 都出现在「测试通过但东西是坏的」这种情形：

- 端到端测试用**真实 socket、真实 Ed25519 签名、真实文件字节**，只把 DSH 会话换成替身（模型调用无法离线复现）；
- 二维码用**独立实现的解码器**验证（定位格式信息、还原掩码、走标准数据路径、校验 RS 全零 syndrome），而不是只对结构打勾；
- 测试客户端的帧编解码**自己实现**，不复用被测代码，否则一个双方共有的错误假设会让测试失去意义；
- 每个测试文件都能独立运行（`node <file>`），不依赖全局状态或执行顺序。

## 报 bug

请附上：

- `$DSH_HOME/openwhale/openwhale.log` 的相关片段（插件自己的日志，**先看这里**）；
- `GET /openwhale/health` 的输出；
- DSH 版本、插件版本、操作系统、是局域网还是隧道模式。

**不要**在 issue 里贴配对二维码、`pairing.json` 的内容或 `state.json`——前者含一次性绑定密钥，
后者含电脑的身份私钥。
