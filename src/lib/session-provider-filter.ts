/**
 * 会话内模型目录过滤(SESSION_CONFIG_ADAPTER_PLAN §9.2)。
 *
 * 活跃会话只能看到当前配置模式下真实可执行的选项:
 * - native 会话:只列 source=native 的当前 Harness 完整本机目录(含多个 native
 *   provider 分组,如 kimi-code 与 agent-plan)。
 * - Bento 会话:排除 native/runtime 来源。七个 Harness 都由完整注册表/稳定路由
 *   租约承载，因此活跃会话可列全部 Bento provider。
 * 新建会话不走此模式过滤，但会在模型目录层按 canonical Provider/model 去重。
 */

import type { HarnessId } from "@/core/harness"
import { dedupeProviderModels, type ProviderView } from "@/core/provider"

export type SessionProviderFilterOptions = {
  harnessId: HarnessId
  /** 当前会话 provider id(native 会话即 native-<harness>[/<canonical>])。 */
  providerId: string | null | undefined
}

/**
 * 按当前会话模式过滤 provider 目录。纯函数:不触 IO、不猜身份,
 * 只按 source 与结构化 provider id 过滤。
 */
export function providersForActiveSession(
  providers: ProviderView[],
  options: SessionProviderFilterOptions,
): ProviderView[] {
  const isNativeSession = options.providerId?.startsWith("native-") ?? false
  const compatible = isNativeSession
    ? providers.filter((provider) => provider.source === "native")
    : providers.filter((provider) => provider.source === "builtin" || provider.source === "user")
  const current = compatible.find((provider) => provider.id === options.providerId)
  const prioritized = current
    ? [current, ...compatible.filter((provider) => provider !== current)]
    : compatible
  return dedupeProviderModels(prioritized, options.harnessId)
}
