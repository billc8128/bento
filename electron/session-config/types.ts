/**
 * SessionConfigAdapter 契约(SESSION_CONFIG_ADAPTER_PLAN §4)。
 * 会话配置只有 Bento 隔离配置一种模式;Adapter 把 Provider 注册表翻译成
 * 各 Harness 自己的配置面并签发租约(NATIVE_REMOVAL_PLAN)。
 */

import type { HarnessId } from "../../src/core/harness"
import type { ProviderModel, WireProtocol } from "../../src/core/provider"

/** Bento 侧的一次模型选择(结构化身份,不靠字符串截断)。 */
export type BentoModelSelection = {
  providerId: string
  modelId: string
}

/**
 * 一个 Provider 在目标 Harness 会话内的运行时描述。
 * credential 是 main 侧句柄(密钥本体只在 main,不进 renderer/日志/临时配置)。
 */
export type SessionProviderRuntime = {
  providerId: string
  name: string
  baseUrl: string
  wireProtocol: WireProtocol
  requestPath?: string
  headers?: Record<string, string>
  models: ProviderModel[]
  /** env 注入用密钥句柄;none 鉴权时缺省。 */
  credential?: CredentialHandle
}

export type CredentialHandle = {
  /** 解析出实际密钥(仅 main 侧调用;禁止序列化进 renderer)。 */
  resolve(): string | null
}

/** 一次活跃会话的配置请求。 */
export type SessionConfigRequest = {
  sessionKey: string
  harnessId: HarnessId
  cwd: string
  selected: BentoModelSelection
  /**
   * 全部对目标 Harness 兼容且已连接的 Bento Provider。
   * 携带完整注册表,不是只有当前选择。
   */
  providers: SessionProviderRuntime[]
}

/** 结构化 PreparedModelRef:选择 key 的编码/解码见 selectionKey/parseSelectionKey。 */
export type PreparedModelRef = {
  providerId: string
  modelId: string
  /** 该模型在本 Harness 里的 wire id(如 `bento-a/m1`、`bento/m1`)。 */
  harnessModelId: string
}

/**
 * 选择 key:不可歧义编码,禁止用去掉第一个 `/` 之类规则猜 Provider。
 */
export function selectionKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId])
}

export function parseSelectionKey(key: string): BentoModelSelection | null {
  try {
    const parsed = JSON.parse(key) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [providerId, modelId] = parsed
    if (typeof providerId !== "string" || typeof modelId !== "string") return null
    if (!providerId || !modelId) return null
    return { providerId, modelId }
  } catch {
    return null
  }
}

/**
 * 会话配置租约:启动所需的 env/strip/args/临时目录 + 选择映射。
 *
 * dispose() 只释放活跃资源(loopback routes、句柄),**不删除可恢复的会话状态**
 * (configDir):普通关闭与进程异常退出后 revive 需要复用同一目录恢复 Kimi
 * native session。彻底删除会话状态走 adapter.removeSessionState()。
 */
export type SessionConfigLease = {
  sessionKey: string
  harnessId: HarnessId
  /** 注入子进程的 env(密钥只在这里,配置文件只引用变量名)。 */
  env: Record<string, string>
  /** spawn 前需要剥离的宿主 env 前缀。 */
  strip: string[]
  args?: string[]
  /** 隔离临时目录;dispose 不删除,removeSessionState 才删除。 */
  configDir?: string
  /** 本租约生成的全部可选模型(Bento 全注册表)。 */
  selections: Map<string, PreparedModelRef>
  selected: PreparedModelRef
  /** 单调递增;restart 换新租约时 +1。 */
  revision: number
  dispose(): Promise<void>
}

/** 切换结果:live = 原进程内生效;restart = 需重启换租约;new-session = 必须新会话。 */
export type ReconfigureResult =
  | { mode: "live"; selection: PreparedModelRef }
  | { mode: "restart"; lease: SessionConfigLease }
  | { mode: "new-session"; reason: string }

export interface SessionConfigAdapter {
  harnessId: HarnessId
  prepare(request: SessionConfigRequest): Promise<SessionConfigLease>
  reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult>
  /**
   * 彻底删除该会话的持久配置状态(隔离目录等)。dispose 只释放活跃资源;
   * removeSession(含已下线的历史会话)与 start 失败时调用。
   */
  removeSessionState?(sessionKey: string): Promise<void>
}

