import { createAcpDriver } from "./acp"
import { claudeAgentSdkDriver } from "./claude-agent-sdk"
import { codexDriver } from "./codex"
import { piDriver } from "./pi"
import type { DriverId, HarnessDriver } from "./types"

const drivers = new Map<DriverId, HarnessDriver>([
  ["claude-code", claudeAgentSdkDriver],
  ["kimi", createAcpDriver("kimi")],
  ["opencode", createAcpDriver("opencode")],
  ["omp", createAcpDriver("omp")],
  ["hermes", createAcpDriver("hermes")],
  ["trae", createAcpDriver("trae")],
  ["pi", piDriver],
  ["codex", codexDriver],
])

export function getDriver(id: DriverId): HarnessDriver {
  const driver = drivers.get(id)
  if (!driver) throw new Error(`运行环境暂不可用: ${id}`)
  return driver
}
