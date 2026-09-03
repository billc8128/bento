/**
 * Pi Bento Adapter(SESSION_CONFIG_ADAPTER_PLAN §6.4)。
 *
 * capability spike 结论(.spike-kimi/spike-pi.mjs,pi 0.84.3 本机版):
 *   - PI_CODING_AGENT_DIR 指向会话目录,模型文件是该目录根下的 models.json;
 *   - apiKey 的 `${VAR}` 环境引用会被解析,但为与 Kimi/OpenCode/OMP 一致,
 *     每个 Provider 走独立 loopback route,配置只写无权限占位 key;
 *   - RPC set_model 跨 Provider live(spike:请求命中切换后 provider 的 mock 上游)。
 *
 * models.json 保留 Pi 支持的 reasoning/contextWindow 字段。
 */

import fs from "node:fs"
import path from "node:path"

import type { HarnessId } from "../../src/core/harness"
import type { WireProtocol } from "../../src/core/provider"
import type { ProviderRoutingService } from "../provider-routing"
import { normalizeBentoModelId, stableProviderAlias } from "./alias"
// 供既有调用方继续从此模块取该工具。
export { normalizeBentoModelId }
import type {
  BentoModelSelection,
  PreparedModelRef,
  ReconfigureResult,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./types"
import { selectionKey } from "./types"

/** wireProtocol → models.json 的 api 字段。 */
function piApi(wireProtocol: WireProtocol): string {
  return wireProtocol === "openai-chat" ? "openai-completions" : wireProtocol
}

export type PiProviderInput = Pick<SessionConfigRequest["providers"][number],
  "providerId" | "name" | "baseUrl" | "wireProtocol" | "models">

/** 生成完整多 Provider models.json(baseURL=各自 route,apiKey=占位符)。 */
export function buildPiModelsJson(
  providers: Array<PiProviderInput & { alias: string }>,
): string {
  const registry: Record<string, unknown> = {}
  for (const provider of providers) {
    registry[provider.alias] = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: piApi(provider.wireProtocol),
      apiKey: "bento-session-route",
      models: provider.models.map((model) => {
        const id = normalizeBentoModelId(model.id)
        return {
          id,
          name: model.name || id,
          reasoning: model.reasoning === true,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        }
      }),
    }
  }
  return JSON.stringify({ providers: registry }, null, 2)
}

export class PiBentoConfigAdapter implements SessionConfigAdapter {

  constructor(
    readonly harnessId: HarnessId,
    private readonly routing: ProviderRoutingService,
    private readonly userDataDir: string,
  ) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    if (request.providers.length === 0) {
      throw new Error("没有可用的 Bento Provider,无法准备 Pi 会话配置")
    }

    // 每 Provider 独立 loopback route;auth/requestPath/fixedHeaders/OAuth 由 ProxyRoute 注入。
    const routeSet = await this.routing.issueRouteSet(
      request.sessionKey,
      request.providers.map((provider) => ({ providerId: provider.providerId, harnessId: request.harnessId })),
    )

    const selections = new Map<string, PreparedModelRef>()
    for (const provider of request.providers) {
      const alias = stableProviderAlias(provider.providerId)
      for (const model of provider.models) {
        const ref: PreparedModelRef = {
          providerId: provider.providerId,
          modelId: normalizeBentoModelId(model.id),
          harnessModelId: `${alias}/${normalizeBentoModelId(model.id)}`,
        }
        selections.set(selectionKey(ref.providerId, ref.modelId), ref)
      }
    }
    const selected = selections.get(selectionKey(
      request.selected.providerId,
      normalizeBentoModelId(request.selected.modelId),
    ))
    if (!selected) {
      this.routing.revokeRoute(request.sessionKey)
      throw new Error(
        `模型 ${request.selected.providerId}/${request.selected.modelId} 不在 Bento 注册表中`,
      )
    }

    const configDir = path.join(this.userDataDir, "providers", `pi-bento-${request.sessionKey}`)
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(configDir, "models.json"), buildPiModelsJson(
      request.providers.map((provider) => ({
        ...provider,
        baseUrl: routeSet.get(provider.providerId)?.baseUrl ?? "",
        alias: stableProviderAlias(provider.providerId),
      })),
    ), { mode: 0o600 })

    const sessionKey = request.sessionKey
    const routing = this.routing
    let disposed = false
    return {
      sessionKey,
      harnessId: request.harnessId,
      env: { PI_CODING_AGENT_DIR: configDir },
      strip: ["PI_CODING_AGENT_DIR"],
      configDir,
      selections,
      selected,
      revision: 1,
      async dispose() {
        // 只释放活跃 routes;目录保留供离线 resume 复用同一 PI_CODING_AGENT_DIR。
        if (disposed) return
        disposed = true
        routing.revokeRoute(sessionKey)
      },
    }
  }

  async reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult> {
    // 注册表内任意 Provider/模型 → RPC set_model live(spike 实证跨 provider)。
    const ref = lease.selections.get(selectionKey(
      next.providerId,
      normalizeBentoModelId(next.modelId),
    ))
    if (ref) return { mode: "live", selection: ref }
    const reason = "该模型不在当前 Bento 注册表中,需要新会话"
    return { mode: "new-session", reason }
  }

  async removeSessionState(sessionKey: string): Promise<void> {
    const configDir = path.join(this.userDataDir, "providers", `pi-bento-${sessionKey}`)
    await fs.promises.rm(configDir, { recursive: true, force: true })
  }
}
