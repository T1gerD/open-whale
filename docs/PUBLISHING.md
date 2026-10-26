# 发布与上架流程（维护者用）

本文件记录 v2.2.0 的实际发布路径和一次性的上架操作，供以后照做。
所有命令都在仓库根目录执行（Windows / Git Bash 均可）。

## 0. 版本号一处改全仓

| 位置 | 字段 |
|---|---|
| 根 `package.json` / `packages/plugin/package.json` / `packages/protocol/package.json` | `version` |
| `packages/mobile/package.json` | `version` |
| `packages/mobile/app.json` | `expo.version`、`expo.android.versionCode`、`expo.ios.buildNumber` |
| `packages/webchat/package.json` | `version` |

插件与手机端的 `version` 必须一致（`release.yml` 会检查，不一致直接失败）。
协议版本 `PROTOCOL_VERSION` 是另一条线（只增不改；2.2.0 = 1.1.0）。

## 1. 发布前门禁（必须全绿才打 tag）

```bash
node scripts/run-tests.mjs                 # 43 文件 / 656+ 项（2.2.1 基线）
node packages/mobile/scripts/check-syntax.mjs
node packages/plugin/scripts/sync-protocol.mjs --check
node scripts/build-plugin-package.mjs --check
```

本机还可以做一次**真实装机验收**（隔离 DSH_HOME，不会动你正在用的 DSH）：

```bash
set DSH_HOME=C:\temp\ow-e2e
dsh plugin --profile e2e add .\release\dsh-openwhale-2.2.1.tgz
dsh --profile e2e --no-open --port 3987
node scripts/verify-install.mjs http://127.0.0.1:3987
```

`verify-install.mjs` 会验证：health / 配对载荷（真实协议解析）/ 网页版静态资源 /
Ed25519 绑定与 hello/ack 签名 / 能力协商 / 会话快照 / 幂等重发（同一 msgId 只受理一次）。

## 2. 打 tag 与发布（GitHub Actions 完成构建）

```bash
git tag v2.2.1
git push origin main
git push origin v2.2.1
```

- `tests` 工作流：三平台（ubuntu / windows / macos）× Node 22/24 跑全部测试与协议副本检查。
- `release` 工作流：在 tag 上构建
  - `dsh-openwhale-2.2.1.tgz` + 固定名 `dsh-openwhale.tgz`（插件，含网页版）
  - `open-whale-2.2.1.apk` + 固定名 `open-whale.apk`（debug keystore 签名的 arm64 包装配包）
  - `SHA256SUMS.txt`，并创建 GitHub Release（release body 取 `CHANGELOG.md`）
- `ios` 工作流：手动触发或 tag 时构建**未签名模拟器 .app**（真机/TestFlight 需要 Apple 账号走 EAS）。

> 本机没有 JDK / Android SDK，**不要**尝试本地出 APK；CI 是唯一构建通道。
> 如果 tag 需要重打：`git tag -f v2.2.1 && git push -f origin v2.2.1`。

## 3. npm 发布

```bash
node scripts/build-plugin-package.mjs --npm-dir
npm publish release/npm-package --access public
```

包名 `dsh-openwhale`；`repository` 字段指回本仓库，插件市场会自动把 npm 与条目关联。
CI 也支持自动发布：在仓库 Secrets 里配置 `NPM_TOKEN` 后，`release.yml` 的
“Publish to npm” 步骤会在 tag 构建成功后自动执行（没有该 secret 时静默跳过）。

> ⚠️ **2026-10-26 实测限制**：本次发布时 npm 网页注册被 Cloudflare 拦截
> （`www.npmjs.com` 返回 403 / “访问暂时受限”，提示所用出口 IP 与网络机器人相同），
> 因此 v2.2.0 的 npm 包**尚未发布**。补发只需在能正常访问 npmjs.com 的网络里：
> 1. 注册/登录 npm 账号（或已有账号直接登录）；
> 2. `npm login`；
> 3. `node scripts/build-plugin-package.mjs --npm-dir && npm publish release/npm-package --access public`。
>
> 插件市场条目的 `tarball:` 指向 GitHub Release，因此**没有 npm 包也能正常上架/安装**。

## 4. 上架 DSH 插件市场

插件市场 = [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的目录数据。条目文件已准备好：`docs/v2.2.0/marketplace-entry.yml`（monorepo 子包形式，
`category: remote`，`tarball:` 指向 Release 的固定名 tarball）。

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`；
2. 新建分支，把条目保存为 `data/plugins/T1gerD__open-whale--packages-plugin.yml`；
3. 向 `main` 开 PR（标题 `Add T1gerD/open-whale — Open Whale remote assistant for DSH`）。

CI 会检查 `dsh.bundle` 清单、条目数量（每 PR ≤ 3）、格式与 README 再生成；合并后市场
（dshmarket 插件）与 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 通常一天内出现。

## 5. 常见失败

| 现象 | 原因 / 处理 |
|---|---|
| release.yml “plugin and mobile versions differ” | 两处 `version` 不一致，按 §0 统一 |
| APK 构建失败在 `expo prebuild` | 新增原生依赖缺 config plugin，或 app.json 非法；本地跑 `npx expo prebuild --platform android` 复现 |
| APK 构建失败在 Gradle | 多为 Java/AGP/SDK 版本；看日志里 `SDK location not found` 是否 `local.properties` 没写 |
| 测试失败但本机全绿 | CI 是 Linux + Node 22/24；检查路径分隔符、大小写、行尾（本仓库 `src/protocol.mjs` 有 LF 约束） |
| npm 401/403 | 没有登录或 token 无 publish 权限；`npm whoami` 确认 |
| 市场 PR CI 说 `dsh.bundle` 找不到 | 条目必须指向 `packages/plugin` 子目录（monorepo 子包形式） |
