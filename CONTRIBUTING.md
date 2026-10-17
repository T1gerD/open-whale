# 参与贡献

欢迎提交 issue 与 PR。

## 提交前

```bash
# 手机端核心逻辑单测
cd packages/mobile && node test/run.mjs
```

请确保测试全部通过。

## 约定

- 尽量把可测的业务逻辑放进 `packages/*/src/core/`（纯函数、无平台依赖）
- 平台相关代码收敛在 `src/services/`
- 提交信息请说明"为什么改"，而不只是"改了什么"

## 报告问题

请在 issue 中附上：

1. 手机型号与系统版本
2. 电脑操作系统与 DSH 版本
3. 使用的通路（公网隧道 / 局域网 / USB）
4. 插件日志中相关的片段（`%USERPROFILE%\.dsh\openwhale\openwhale.log`）
