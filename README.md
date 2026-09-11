<p align="center">
  <img src="public/bento-logo.png" alt="Bento logo" width="88" />
</p>

<h1 align="center">Bento</h1>

<p align="center"><strong>Your free agent workspace.</strong></p>

<p align="center">
  Run multiple coding-agent harnesses, models, and projects from one local-first desktop workspace.
</p>

<p align="center">
  <a href="https://bento-ai.app">Website</a> ·
  <a href="https://github.com/billc8128/bento/releases/download/v0.4.11/Bento-0.4.11-arm64.dmg">Download</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/billc8128/bento/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/billc8128/bento?style=flat-square&color=f9ad3b" /></a>
  <img alt="macOS Apple silicon" src="https://img.shields.io/badge/macOS-Apple%20silicon-24211d?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-desktop-47848f?style=flat-square&logo=electron&logoColor=white" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-f9ad3b?style=flat-square" /></a>
</p>

<p align="center">
  <img src="promo/site/assets/agents-frame.jpg" alt="Bento running multiple agent sessions in a desktop workspace" width="100%" />
</p>

> [!NOTE]
> Bento is under active development. The current release is **v0.4.11** for
> **Apple silicon Macs**. Expect the product and extension contracts to evolve.

## Why Bento?

Agent tools are powerful, but their sessions, models, permissions, and project context often live in separate terminals. Bento gives them one home without replacing the harnesses you already use.

- **One workspace, many harnesses** — switch between Pi, Codex, Claude Code, Kimi Code, OpenCode, OMP, Hermes, and Trae Code.
- **Real multi-agent work** — open agents side by side and delegate work across sessions and projects.
- **Your models and providers** — discover local credentials, connect supported providers, choose models, and pass reasoning settings to the underlying harness.
- **Workspace tools included** — keep chat, terminal, files, previews, and a browser in the same desktop layout.
- **Local-first state** — sessions, history, layouts, settings, and provider configuration stay on your machine.
- **A workspace you can shape** — split and rearrange panes, restore layouts, and choose from multiple complete visual themes.

## Supported harnesses

| Harness | Integration |
| --- | --- |
| Pi | Bundled RPC runtime |
| Codex | Native `app-server` driver |
| Claude Code | Bundled Claude Agent SDK runtime |
| Kimi Code | Agent Client Protocol (ACP) |
| OpenCode | Agent Client Protocol (ACP) |
| OMP | Agent Client Protocol (ACP) |
| Hermes | Agent Client Protocol (ACP) |
| Trae Code | Agent Client Protocol (ACP) |

Bento keeps the harness responsible for model behavior and authentication. Managed runtimes are bundled or downloaded at pinned versions where supported, and downloaded artifacts are verified before use.

## Install

[Download Bento v0.4.11 for macOS (Apple silicon)](https://github.com/billc8128/bento/releases/download/v0.4.11/Bento-0.4.11-arm64.dmg), open the DMG, and move Bento to Applications.

From v0.4.2 onward, an amber update icon appears beside the theme toggle when a new version is available. Clicking it downloads the update and restarts Bento automatically, ending any running tasks. Users on older versions need to install v0.4.2 manually once.

On first launch:

1. Start a general chat or choose a project folder.
2. Pick a harness.
3. Use an existing harness login or configure a provider in Bento.
4. Choose a model and start working.

Some harnesses and providers require their own account, subscription, API key, or network access. Bento does not provide model inference itself.

## Build from source

Requirements: **Node.js 24+**, **pnpm 10**, and an Apple silicon Mac for the current desktop target.

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm dev:web   # Browser-only UI preview
pnpm test      # Run the test suite
pnpm lint      # Run static checks
pnpm build     # Build the application
pnpm dist:dir  # Build release/mac-arm64/Bento.app
pnpm dist      # Build the arm64 DMG
```

## How it works

Bento is an Electron application with a React renderer. Each harness is adapted to a shared driver and event contract, so live output and local history follow the same rendering path. The main process owns harness runtimes, provider routing, local persistence, permissions, and workspace tools; the renderer owns the interface and layout.

```text
React workspace
      │
Electron main process
      │
Shared harness driver + event contract
      │
Pi · Codex · Claude Code · Kimi · OpenCode · OMP · Hermes · Trae
```

This is **local-first**, not necessarily offline: prompts and tool calls may still reach the model provider selected through your harness.

## Contributing

Issues and pull requests are welcome. For substantial behavior or architecture changes, please open an issue first so the direction can be agreed before implementation.

Before submitting a pull request:

```bash
pnpm test
pnpm lint
pnpm build
```

Keep changes focused, preserve existing session and provider contracts, and never commit credentials or private session data.

## License

Bento is available under the [MIT License](LICENSE).
