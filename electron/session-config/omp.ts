/**
 * OMP Bento Adapter(SESSION_CONFIG_ADAPTER_PLAN §6.3)。
 *
 * capability spike 结论(.spike-kimi/,omp 本机版):
 *   - 隔离用 PI_CODING_AGENT_DIR 指向会话目录,模型文件是该目录根下的
 *     models.yml(不是 OMP_HOME,也不是 agent/models.json);
 *   - models.yml 的 apiKey 不解析 $VAR/${VAR} 环境引用(spike6:Bearer 字面量),
 *     因此每个 Provider 走独立 loopback route,配置只写无权限占位符;
 *   - 多 provider/model 全量注册表被 ACP 列出,setSessionConfigOption 跨 Provider
 *     live(spike6:请求命中切换后 provider 的 mock 上游)。
 */

import fs from "node:fs"
import path from "node:path"

import type { HarnessId } from "../../src/core/harness"
import type { WireProtocol } from "../../src/core/provider"
import type { ProviderRoutingService } from "../provider-routing"
import { normalizeBentoModelId, stableProviderAlias } from "./alias"
import type {
  BentoModelSelection,
  PreparedModelRef,
  ReconfigureResult,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./types"
import { selectionKey } from "./types"

// 供既有调用方继续从此模块取该工具。
export { normalizeBentoModelId }

/** wireProtocol → models.yml 的 api 字段(与 Pi 约定一致)。 */
function ompApi(wireProtocol: WireProtocol): string {
  return wireProtocol === "openai-chat" ? "openai-completions" : wireProtocol
}

export type OmpProviderInput = Pick<SessionConfigRequest["providers"][number],
  "providerId" | "name" | "baseUrl" | "wireProtocol" | "models">

/** JSON 双引号标量是合法 YAML 标量;避免手写转义。 */
function ymlScalar(value: string): string {
  return JSON.stringify(value)
}

/** 生成完整多 Provider models.yml(baseURL=各自 route,apiKey=占位符)。 */
export function buildOmpModelsYml(
  providers: Array<OmpProviderInput & { alias: string }>,
): string {
  const lines: string[] = ["providers:"]
  for (const provider of providers) {
    lines.push(`  ${provider.alias}:`)
    lines.push(`    name: ${ymlScalar(provider.name)}`)
    lines.push(`    baseUrl: ${ymlScalar(provider.baseUrl)}`)
    lines.push(`    api: ${ymlScalar(ompApi(provider.wireProtocol))}`)
    lines.push(`    apiKey: ${ymlScalar("bento-session-route")}`)
    if (provider.models.length > 0) {
      lines.push("    models:")
      for (const model of provider.models) {
        const id = normalizeBentoModelId(model.id)
        lines.push(`      - { id: ${ymlScalar(id)}, name: ${ymlScalar(model.name || id)} }`)
      }
    }
  }
  return `${lines.join("\n")}\n`
}

export class OmpBentoConfigAdapter implements SessionConfigAdapter {

  constructor(
    readonly harnessId: HarnessId,
    private readonly routing: ProviderRoutingService,
    private readonly userDataDir: string,
  ) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    if (request.providers.length === 0) {
      throw new Error("没有可用的 Bento Provider,无法准备 OMP 会话配置")
    }

    // 每 Provider 独立 loopback route;auth/requestPath/OAuth 由 ProxyRoute 注入。
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

    const configDir = path.join(this.userDataDir, "providers", `omp-bento-${request.sessionKey}`)
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(configDir, "models.yml"), buildOmpModelsYml(
      request.providers.map((provider) => ({
        ...provider,
        baseUrl: routeSet.get(provider.providerId)?.baseUrl ?? "",
        alias: stableProviderAlias(provider.providerId),
      })),
    ), { mode: 0o600 })

    // Skills 投递:复制进 PI_CODING_AGENT_DIR/skills(pi 把 <agentDir>/skills 当
    // user 级全局目录)。已知泄露:pi 无条件扫描真实 HOME 的 ~/.agents/skills,
    // 不跟随 PI_CODING_AGENT_DIR(pi 0.84.2 dist/core/package-manager.js 硬编码
    // join(homedir(),".agents","skills")),那部分不受 Bento 勾选面控制。
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
    // 注册表内任意 Provider/模型 → ACP setSessionConfigOption live(spike 实证)。
    const ref = lease.selections.get(selectionKey(
      next.providerId,
      normalizeBentoModelId(next.modelId),
    ))
    if (ref) return { mode: "live", selection: ref }
    const reason = "该模型不在当前 Bento 注册表中,需要新会话"
    return { mode: "new-session", reason }
  }

  async removeSessionState(sessionKey: string): Promise<void> {
    const configDir = path.join(this.userDataDir, "providers", `omp-bento-${sessionKey}`)
    await fs.promises.rm(configDir, { recursive: true, force: true })
  }
}
