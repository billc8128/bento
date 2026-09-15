/**
 * App capability → Harness 启动面的唯一适配层。
 * AppRuntimeHost 和 SessionManager 都不感知某个 App/Harness 组合；新增 Harness
 * 只需在这里选择原生 MCP、stdio relay、extension 或明确 unsupported。
 */

import type { HarnessId, HarnessStartOptions } from "../drivers/types"
import type { AppSessionLease } from "./app-runtime-host"

type AppStartOptions = Pick<HarnessStartOptions, "mcpServers" | "appArgs" | "appEnv">
type HarnessAppAdapter = (lease: AppSessionLease) => AppStartOptions

const nativeMcp: HarnessAppAdapter = (lease) => ({ mcpServers: [lease.stdioRelay] })
const piExtension: HarnessAppAdapter = (lease) => ({
  appArgs: ["--extension", lease.piExtensionPath],
  appEnv: {
    BENTO_MCP_ENDPOINT: lease.endpoint,
    BENTO_MCP_TOKEN: lease.token,
  },
})

const ADAPTERS: Record<HarnessId, HarnessAppAdapter> = {
  "claude-code": nativeMcp,
  codex: nativeMcp,
  kimi: nativeMcp,
  opencode: nativeMcp,
  omp: nativeMcp,
  hermes: nativeMcp,
  trae: nativeMcp,
  pi: piExtension,
}

export function appStartOptions(harnessId: HarnessId, lease: AppSessionLease): AppStartOptions {
  const base = ADAPTERS[harnessId](lease)
  // agent browser 已在运行时,端点注入所有 harness 的会话环境,
  // CLI 型工具(agent-browser skill、Playwright 脚本)不经 MCP 也能发现它
  if (!lease.agentBrowserCdp) return base
  return {
    ...base,
    appEnv: { ...base.appEnv, BENTO_AGENT_BROWSER_CDP: lease.agentBrowserCdp },
  }
}
