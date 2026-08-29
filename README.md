# Bento

Bento 是一个本地优先、可自定义的多 Agent 桌面工作台。它把不同 harness 的会话、
模型、推理强度、工具事件和历史记录收进同一个 Electron 界面。

当前版本为 v0.3.1，已包含：

- Claude Code、GLM、Kimi、OpenCode 的 ACP Driver
- 原生 Codex app-server Driver
- 模型与推理强度的真实下发、持久化和能力门控
- Codex、Kimi、OpenCode 固定版本二进制下载与 SHA-256 校验
- JSONL 会话日志、实时流与历史回放共用 reducer
- dockview 多会话分栏、布局持久化和五套主题

产品边界见 [`PRODUCT.md`](PRODUCT.md)，分层和扩展契约见
[`ARCHITECTURE.md`](ARCHITECTURE.md)。UI 开发必须遵守
[`DESIGN.md`](DESIGN.md) 中的视觉规范（字号/字体/颜色一律走 token）。

## 开发

要求 Node.js 24+ 与 pnpm 10。

```bash
pnpm install
pnpm dev       # Electron 桌面版
pnpm dev:web   # 纯浏览器 UI 预览
pnpm test
pnpm lint
pnpm build
```

## Harness 与二进制

- Claude Code / GLM 使用项目依赖中的 ACP adapter。
- Kimi / OpenCode 首次使用时从官方 Release 下载固定版本到 Bento 用户数据目录。
- Codex 使用受管 `codex` 二进制的 `app-server` 协议，不经过 ACP。
- 所有下载归档都在解压前验证固定 SHA-256。
- 开发或企业分发可用 `BENTO_CODEX_PATH`、`BENTO_KIMI_PATH`、
  `BENTO_OPENCODE_PATH` 覆盖受管路径。
- GLM 配置目录默认为 `~/.bento/claude-glm`，可用
  `BENTO_GLM_CONFIG_DIR` 覆盖。

## 打包

```bash
pnpm dist:dir  # release/mac-arm64/Bento.app
pnpm dist      # arm64 DMG
```

会话记录保存在 Electron `userData/sessions`，受管二进制保存在
`userData/binaries`。模型登录态仍由各 harness 自己管理。
