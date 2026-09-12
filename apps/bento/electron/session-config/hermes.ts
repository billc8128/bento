/**
 * Hermes Bento Adapter(SESSION_CONFIG_ADAPTER_PLAN §6.5)。
 *
 * capability spike 结论(.spike-kimi/hermes-spike.mjs,managed hermes-agent 0.19.0):
 *   - HERMES_HOME 指向会话目录,根 config.yaml 的 v12 `providers.<key>` 多 provider
 *     注册表被加载;entry 用 `api`(URL)+`transport`("chat_completions")+
 *     `api_key`+`default_model`+`models` 字典;active provider 需
 *     `model: {provider, default}` 显式激活;
 *   - 未知 provider key 被 Hermes 归一为 `custom:<slug>` 命名空间,set_model id
 *     格式为 `custom:<slug>:<model>`;
 *   - 跨 Provider session/set_model 同进程 live(spike:请求命中切换后 provider 的
 *     mock 上游与对应 api_key,PID 不变)。
 *
 * 每 Provider 独立 loopback route + 占位 api_key;真实鉴权由 proxy 注入。
 */

import fs from "node:fs"
import path from "node:path"

import type { HarnessId } from "../../src/core/harness"
import type { WireProtocol } from "../../src/core/provider"
import type { ProviderRoutingService } from "../providers/provider-routing"
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

export type HermesProviderInput = Pick<SessionConfigRequest["providers"][number],
  "providerId" | "name" | "wireProtocol" | "models">

/** wireProtocol → Hermes transport 名(沿用 legacy config 约定:responses 桥为 codex_responses)。 */
function hermesTransport(wireProtocol: WireProtocol): string {
  if (wireProtocol === "anthropic-messages") return "anthropic_messages"
  if (wireProtocol === "openai-responses") return "codex_responses"
  return "chat_completions"
}

/** set_model / model.provider 的命名空间 key(Hermes 归一规则)。 */
export function hermesProviderKey(providerId: string): string {
  return `custom:${stableProviderAlias(providerId)}`
}

/** 生成完整多 Provider config.yaml(base_url=各自 route,api_key=占位符)。 */
export function buildHermesSessionConfig(
  providers: Array<HermesProviderInput & { baseUrl: string }>,
  defaultRef: PreparedModelRef,
): string {
  const registry: Record<string, unknown> = {}
  for (const provider of providers) {
    const key = hermesProviderKey(provider.providerId)
    const models: Record<string, { name: string }> = {}
    for (const model of provider.models) {
      const id = normalizeBentoModelId(model.id)
      models[id] = { name: model.name || id }
    }
    const defaultKey = hermesProviderKey(defaultRef.providerId)
    const defaultId = normalizeBentoModelId(defaultRef.modelId)
    registry[key] = {
      name: provider.name,
      api: provider.baseUrl,
      transport: hermesTransport(provider.wireProtocol),
      api_key: "bento-session-route",
      default_model: key === defaultKey ? defaultId : Object.keys(models)[0] ?? "",
      ...(Object.keys(models).length > 0 ? { models } : {}),
    }
  }
  return JSON.stringify({
    model: {
      provider: hermesProviderKey(defaultRef.providerId),
      default: normalizeBentoModelId(defaultRef.modelId),
    },
    providers: registry,
  }, null, 2)
}

export class HermesBentoConfigAdapter implements SessionConfigAdapter {

  constructor(
    readonly harnessId: HarnessId,
    private readonly routing: ProviderRoutingService,
    private readonly userDataDir: string,
  ) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    if (request.providers.length === 0) {
      throw new Error("没有可用的 Bento Provider,无法准备 Hermes 会话配置")
    }

    // 每 Provider 独立 loopback route;auth/requestPath/fixedHeaders/OAuth 由 ProxyRoute 注入。
    const routeSet = await this.routing.issueRouteSet(
      request.sessionKey,
      request.providers.map((provider) => ({ providerId: provider.providerId, harnessId: request.harnessId })),
    )

    const selections = new Map<string, PreparedModelRef>()
    for (const provider of request.providers) {
      for (const model of provider.models) {
        const ref: PreparedModelRef = {
          providerId: provider.providerId,
          modelId: normalizeBentoModelId(model.id),
          harnessModelId: `${hermesProviderKey(provider.providerId)}:${normalizeBentoModelId(model.id)}`,
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

    const configDir = path.join(this.userDataDir, "providers", `hermes-bento-${request.sessionKey}`)
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(configDir, "config.yaml"), buildHermesSessionConfig(
      request.providers.map((provider) => ({
        ...provider,
        baseUrl: routeSet.get(provider.providerId)?.baseUrl ?? "",
      })),
      selected,
    ), { mode: 0o600 })

    // Skills 投递:复制进 HERMES_HOME/skills。已证实(hermes-agent 0.19.0 源码,
    // hermes_constants.py: get_skills_dir() = get_hermes_home()/"skills",
    // get_hermes_home 读 HERMES_HOME env)。另:hermes 的 external_dirs 配置默认
    // 为空,不会自动扫 ~/.agents/skills,勾选面完全受控。
    if (request.skills?.curatedRoot) {
      fs.cpSync(
        path.join(request.skills.curatedRoot, "skills"),
        path.join(configDir, "skills"),
        { recursive: true },
      )
    }

    const sessionKey = request.sessionKey
    const routing = this.routing
    let disposed = false
    return {
      sessionKey,
      harnessId: request.harnessId,
      env: { HERMES_HOME: configDir },
      strip: ["HERMES_HOME", "HERMES_INFERENCE_MODEL"],
      configDir,
      selections,
      selected,
      revision: 1,
      async dispose() {
        // 只释放活跃 routes;目录保留供离线 resume 复用同一 HERMES_HOME。
        if (disposed) return
        disposed = true
        routing.revokeRoute(sessionKey)
      },
    }
  }

  async reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult> {
    // 注册表内任意 Provider/模型 → session/set_model(`provider:model`)live(spike 实证)。
    const ref = lease.selections.get(selectionKey(
      next.providerId,
      normalizeBentoModelId(next.modelId),
    ))
    if (ref) return { mode: "live", selection: ref }
    const reason = "该模型不在当前 Bento 注册表中,需要新会话"
    return { mode: "new-session", reason }
  }

  async removeSessionState(sessionKey: string): Promise<void> {
    const configDir = path.join(this.userDataDir, "providers", `hermes-bento-${sessionKey}`)
    await fs.promises.rm(configDir, { recursive: true, force: true })
  }
}
