/**
 * OpenCode Bento Adapter(SESSION_CONFIG_ADAPTER_PLAN §6.2,mode=bento)。
 *
 * capability spike 结论(.spike-kimi/spike-oc-omp.mjs,opencode 1.18.18 本机版):
 *   - OPENCODE_CONFIG 指向的 JSON 配置中多 provider/model 全量加载;
 *   - options.apiKey 的 `{env:VAR}` 引用被解析;
 *   - setSessionConfigOption 跨 Provider live,进程不重启。
 *
 * 每个 Provider 走独立 loopback route(与 Kimi 一致):config 的 baseURL 指向
 * 各自 token URL,apiKey 仍是独立 env 引用但值只放无上游权限的占位符。
 * 真实鉴权(apiKey/none/OAuth)、requestPath、fixedHeaders 全由
 * ProviderRoutingService 的 ProxyRoute 注入,密钥只存 safeStorage。
 */

import fs from "node:fs"
import path from "node:path"

import type { WireProtocol } from "../../src/core/provider"
import type { ProviderRoutingService } from "../provider-routing"
import type {
  BentoModelSelection,
  PreparedModelRef,
  ReconfigureResult,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./types"
import { modeOfSelection, selectionKey } from "./types"
import { normalizeBentoModelId, providerKeyEnvName, stableProviderAlias } from "./alias"

// 供既有调用方(pi 集成测试等)继续从此模块取该工具。
export { normalizeBentoModelId }

function npmPackage(wireProtocol: WireProtocol): string {
  if (wireProtocol === "anthropic-messages") return "@ai-sdk/anthropic"
  if (wireProtocol === "openai-responses") return "@ai-sdk/openai"
  return "@ai-sdk/openai-compatible"
}

export type OpenCodeProviderInput = Pick<SessionConfigRequest["providers"][number],
  "providerId" | "name" | "baseUrl" | "wireProtocol" | "models">

/** 生成完整多 Provider opencode.json(baseURL=各自 route,apiKey 只引用 env 名)。 */
export function buildOpenCodeSessionConfig(
  providers: Array<OpenCodeProviderInput & { baseUrl: string }>,
  defaultRef: PreparedModelRef,
): string {
  const registry: Record<string, unknown> = {}
  for (const provider of providers) {
    const alias = stableProviderAlias(provider.providerId)
    const models: Record<string, { name: string }> = {}
    for (const model of provider.models) {
      const id = normalizeBentoModelId(model.id)
      models[id] = { name: model.name || id }
    }
    registry[alias] = {
      npm: npmPackage(provider.wireProtocol),
      name: provider.name,
      options: { baseURL: provider.baseUrl, apiKey: `{env:${providerKeyEnvName(provider.providerId)}}` },
      models,
    }
  }
  return JSON.stringify({
    model: `${stableProviderAlias(defaultRef.providerId)}/${normalizeBentoModelId(defaultRef.modelId)}`,
    provider: registry,
  }, null, 2)
}

export class OpenCodeBentoConfigAdapter implements SessionConfigAdapter {
  readonly mode = "bento" as const

  constructor(
    readonly harnessId: OpenCodeBentoConfigAdapter["harnessId"],
    private readonly routing: ProviderRoutingService,
    private readonly userDataDir: string,
  ) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    if (request.mode !== "bento") {
      throw new Error("OpenCodeBentoConfigAdapter 只处理 bento 模式")
    }
    if (request.providers.length === 0) {
      throw new Error("没有可用的 Bento Provider,无法准备 OpenCode 会话配置")
    }

    // 每 Provider 独立 loopback route(事务性:全部解析成功才吊销旧 set);
    // requestPath/fixedHeaders/auth:none/OAuth 都由 resolveRoute 编进 ProxyRoute。
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

    const configDir = path.join(this.userDataDir, "providers", `opencode-bento-${request.sessionKey}`)
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    const file = path.join(configDir, "opencode.json")
    fs.writeFileSync(file, buildOpenCodeSessionConfig(
      request.providers.map((provider) => ({
        ...provider,
        baseUrl: routeSet.get(provider.providerId)?.baseUrl ?? "",
      })),
      selected,
    ), { mode: 0o600 })

    // env 只有占位凭证;真实密钥由 proxy 按 token 注入
    const env: Record<string, string> = { OPENCODE_CONFIG: file }
    for (const provider of request.providers) {
      env[providerKeyEnvName(provider.providerId)] = "bento-session-route"
    }

    const sessionKey = request.sessionKey
    const routing = this.routing
    let disposed = false
    return {
      sessionKey,
      harnessId: request.harnessId,
      mode: "bento",
      env,
      strip: ["OPENCODE_CONFIG", "BENTO_PROVIDER_KEY_"],
      configDir,
      selections,
      selected,
      revision: 1,
      async dispose() {
        if (disposed) return
        disposed = true
        routing.revokeRoute(sessionKey)
      },
    }
  }

  async reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult> {
    // 注册表内任意 Provider/模型 → ACP setSessionConfigOption live(spike 实证)。
    const ref = lease.selections.get(selectionKey(
      next.providerId,
      normalizeBentoModelId(next.modelId),
    ))
    if (ref) return { mode: "live", selection: ref }
    const reason = modeOfSelection(next) !== lease.mode
      ? "native↔Bento 模式之间切换需要新会话"
      : "该模型不在当前 Bento 注册表中,需要新会话"
    return { mode: "new-session", reason }
  }

  async removeSessionState(sessionKey: string): Promise<void> {
    const configDir = path.join(this.userDataDir, "providers", `opencode-bento-${sessionKey}`)
    await fs.promises.rm(configDir, { recursive: true, force: true })
  }
}
