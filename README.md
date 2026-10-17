# Open Whale

> 手机，成为你电脑上 AI 的遥控器。

Open Whale 让你用手机驱动电脑上的 [DeepSeek Harness][dsh]。扫码绑定后，像聊天一样发一句指令，
电脑上的 AI 就会真的开始干活——读代码、改文件、执行命令——并把过程和结果实时推回手机。

手机负责"发指令、看结果"，电脑负责"算力和执行"。

[dsh]: https://github.com/deepseek-ai

---

## 为什么需要它

- **能力在电脑，人不在电脑。** AI 编程工具的执行能力依赖本地环境（文件、工具链、依赖），
  手机拿不到这些，所以手机端 AI 只能聊天，不能干活。
- **远程桌面是错配的方案。** 把整块屏幕搬到手机上，操作精度差、流量大，而且不是"让电脑干活"的交互。
- **把电脑暴露到公网风险高。** 开端口、配内网穿透，普通用户做不完，也缺少设备级鉴权。

Open Whale 的做法是：**电脑主动出站连一条加密长连接，手机沿着同一条连接发指令。**
不开入站端口，不用配路由器。

---

## 特性

| | |
|---|---|
| **一步扫码绑定** | 电脑显示二维码，手机扫一下即可，也可手动粘贴配对载荷 |
| **真实执行** | 指令交给电脑上的 AI 执行，不是手机端的"假装对话" |
| **会话隔离** | 每台手机一个独立会话，不影响桌面端正在做的事 |
| **三级通路** | 公网隧道 / 局域网直连 / USB 调试通道，按网络环境自动选择 |
| **断网不丢消息** | 本地待发队列，重连后按序重发 |
| **设备级安全** | Ed25519 设备密钥 + 单次配对密钥（10 分钟过期） |

---

## 组成

```
packages/
├── plugin/     DeepSeek Harness 插件（电脑端）
└── mobile/     手机 App（React Native + Expo）
```

| 部分 | 运行位置 | 职责 |
|---|---|---|
| `packages/plugin` | 电脑，DSH 内 | 配对页、WebSocket 服务、为每台手机建独立会话、双向转发 |
| `packages/mobile` | 手机 | 扫码配对、设备签名、连接管理、离线队列、聊天与文件 UI |

---

## 快速开始

1. **电脑**：安装并启用 `dsh-openwhale` 插件，确认健康检查通过：

   ```bash
   curl http://127.0.0.1:19387/openwhale/health
   ```

2. **手机**：安装 Open Whale App，打开后点「扫码添加电脑」。

3. **绑定**：用手机扫电脑上 `http://127.0.0.1:19387/openwhale` 页面的二维码。

4. **开始用**：发一条消息试试。

详细步骤见 [docs/INSTALL.md](docs/INSTALL.md) 与 [docs/USAGE.md](docs/USAGE.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 安装与首次配置 |
| [docs/USAGE.md](docs/USAGE.md) | 日常使用与常见问题 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、协议与安全模型 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

---

## 系统要求

- **电脑**：DeepSeek Harness 桌面端（Windows / macOS）
- **手机**：Android 9+ 或 iOS 14+
- **可选**：`cloudflared`（启用公网隧道，让手机在移动网络下也能连）

---

## 状态

V2，可用于日常使用。已知限制与后续规划见 [CHANGELOG.md](CHANGELOG.md) 与 V3 路线图。

---

## 许可证

[MIT](LICENSE)
