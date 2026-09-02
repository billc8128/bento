import type { HarnessEvent, HarnessUsage } from "../../src/core/events"
import type { Effort, PromptInput } from "../../src/core/types"
import type { HarnessRuntimePreference } from "../harness-runtime"

export type HarnessId = "claude-code" | "kimi" | "codex" | "opencode" | "pi" | "omp" | "hermes"

/** 旧版本曾把 GLM Coding Plan 当成 Harness；仅保留用于恢复历史会话。 */
export type DriverId = HarnessId | "glm"

export type HarnessCapabilities = {
  modelSwitch: "none" | "new-session" | "live"
  effortSwitch: "none" | "new-session" | "live"
  /** 当前回合运行时是否接受即时用户引导。缺省按 none。 */
  steer?: "none" | "live"
}

export type HarnessMcpServer = {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

/** 上下文恢复能力由 driver 在 start() 内部消化(nativeSessionId 传入即尝试
 *  恢复,失败自行降级),不需要向宿主上报——曾经的 resume/contextRestore
 *  字段持久化后无任何消费者,已删。 */

export type HarnessStartOptions = {
  cwd: string
  /** native 配置偏好 PATH；Bento 隔离配置偏好固定 managed/bundled。 */
  runtimePreference?: HarnessRuntimePreference
  nativeSessionId?: string
  providerId?: string
  modelId?: string
  effort?: Effort
  /**
   * builtin/user provider 会话的路由 env(ProviderRoutingService 组装):claude-code
   * 是 ANTHROPIC_BASE_URL/AUTH_TOKEN + CLAUDE_CONFIG_DIR;driver 只合入
   * spawn env,不做任何路由准备(红线:driver 不写文件、不碰路由服务)。
   */
  proxyEnv?: { env: Record<string, string>; strip?: string[] }
  mcpServers?: HarnessMcpServer[]
  appArgs?: string[]
  appEnv?: Record<string, string>
}

export type HarnessConnection = {
  nativeSessionId: string
  capabilities: HarnessCapabilities
  prompt(input: string | PromptInput): Promise<{ stopReason?: string; usage?: HarnessUsage }>
  steer?(input: string | PromptInput): Promise<void>
  cancel(): Promise<void>
  close(): void
  onExit(callback: (code: number | null) => void): () => void
  setModel?(modelId: string): Promise<void>
  setEffort?(effort: Effort): Promise<void>
}

export type HarnessDriver = {
  id: DriverId
  start(
    options: HarnessStartOptions,
    emit: (event: HarnessEvent) => void,
    /** 测试注入点(prod 调用方不传)。driver 自己声明接受哪些依赖 */
    deps?: Record<string, unknown>,
  ): Promise<HarnessConnection>
}
