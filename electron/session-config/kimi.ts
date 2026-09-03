/**
 * Kimi Bento Adapter(SESSION_CONFIG_ADAPTER_PLAN §6.1)。
 *
 * capability spike 结论(.spike-kimi/,kimi 0.38.0 本机版):
 *   - KIMI_CODE_HOME 隔离生效,完整多 Provider [providers]/[models] 注册表
 *     被 ACP configOptions 全量列出;
 *   - config.toml 的 api_key 不解析 $VAR/${VAR} 环境引用(spike3:Bearer 字面量),
 *     因此真实凭证绝不能写进配置——每个 Provider 走独立 loopback route,
 *     config 里只写无上游权限的占位 session credential;
 *   - setSessionConfigOption 跨 Provider 切换 live,进程不重启(spike2:PID 不变,
 *     请求命中切换后 Provider 的 mock 上游)。
 *
 * 由此本 Adapter:
 *   prepare  = 全 Provider 注册表 config.toml + 每 Provider 独立 route;
 *   reconfigure = 租约内任意选择 live;
 *   dispose = 删目录 + 吊销本会话全部 routes。
 */

import fs from "node:fs"
import path from "node:path"

import type { HarnessId } from "../../src/core/harness"
import type { WireProtocol } from "../../src/core/provider"
import type { ProviderRoutingService } from "../provider-routing"
import { stableProviderAlias } from "./alias"
import type {
  BentoModelSelection,
  PreparedModelRef,
  ReconfigureResult,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
  SessionProviderRuntime,
} from "./types"
import { selectionKey } from "./types"

/** 占位凭证:满足 Kimi 的 Bearer 头要求,但对任何真实上游无权限。 */
const PLACEHOLDER_CREDENTIAL = "bento-session-route"

/** wireProtocol → Kimi [providers.*].type(spike 实测映射)。 */
function kimiProviderType(wireProtocol: WireProtocol): string {
  if (wireProtocol === "anthropic-messages") return "anthropic"
  if (wireProtocol === "openai-responses") return "openai_responses"
  return "openai"
}

/** Kimi 拒绝无正数 max_context_size 的模型(spike3 报错实测)。 */
function positiveContext(contextWindow: number | undefined): number {
  return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000
}

/**
 * 生成完整多 Provider config.toml。api_key 全部是占位凭证;真实鉴权在
 * ProviderRoutingService 的 loopback route 侧注入,密钥只存 safeStorage。
 * TOML 转义:provider alias 与 model id 的引号/反斜杠/控制字符。
 */
export function buildKimiSessionConfig(
  providers: Array<{ alias: string } & Pick<SessionProviderRuntime,
    "name" | "baseUrl" | "wireProtocol" | "models">>,
  defaultModelRef: PreparedModelRef,
): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const lines: string[] = [`default_model = "${escape(defaultModelRef.harnessModelId)}"`, ""]
  for (const provider of providers) {
    lines.push(`[providers.${JSON.stringify(provider.alias)}]`)
    lines.push(`type = "${kimiProviderType(provider.wireProtocol)}"`)
    lines.push(`base_url = "${escape(provider.baseUrl)}"`)
    lines.push(`api_key = "${PLACEHOLDER_CREDENTIAL}"`)
    lines.push("")
  }
  for (const provider of providers) {
    for (const model of provider.models) {
      lines.push(`[models.${JSON.stringify(`${provider.alias}/${model.id}`)}]`)
      lines.push(`provider = ${JSON.stringify(provider.alias)}`)
      lines.push(`model = "${escape(model.id)}"`)
      lines.push(`max_context_size = ${positiveContext(model.contextWindow)}`)
      if (model.name) lines.push(`display_name = "${escape(model.name)}"`)
      // agent 会话恒需要工具;reasoning 模型追加 thinking。
      const capabilities = model.reasoning === true
        ? 'capabilities = [ "thinking", "tool_use" ]'
        : 'capabilities = [ "tool_use" ]'
      lines.push(capabilities)
      lines.push("")
    }
  }
  return `${lines.join("\n")}\n`
}


export class KimiBentoConfigAdapter implements SessionConfigAdapter {

  constructor(
    readonly harnessId: HarnessId,
    private readonly routing: ProviderRoutingService,
    private readonly userDataDir: string,
  ) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    if (request.providers.length === 0) {
      throw new Error("没有可用的 Bento Provider,无法准备 Kimi 会话配置")
    }
    // 每 Provider 独立 loopback route:config 的 base_url 指向各自 token 路径。
    const routeSet = await this.routing.issueRouteSet(
      request.sessionKey,
      request.providers.map((provider) => ({ providerId: provider.providerId, harnessId: request.harnessId })),
    )

    const selections = new Map<string, PreparedModelRef>()
    const catalogProviders: Array<{ alias: string; name: string; baseUrl: string; wireProtocol: WireProtocol; models: SessionProviderRuntime["models"] }> = []
    for (const provider of request.providers) {
      const route = routeSet.get(provider.providerId)
      if (!route) {
        this.routing.revokeRoute(request.sessionKey)
        throw new Error(`供应商 ${provider.name} 路由签发失败`)
      }
      const alias = stableProviderAlias(provider.providerId)
      catalogProviders.push({
        alias,
        name: provider.name,
        baseUrl: route.baseUrl,
        wireProtocol: provider.wireProtocol,
        models: provider.models,
      })
      for (const model of provider.models) {
        const ref: PreparedModelRef = {
          providerId: provider.providerId,
          modelId: model.id,
          harnessModelId: `${alias}/${model.id}`,
        }
        selections.set(selectionKey(ref.providerId, ref.modelId), ref)
      }
    }
    const selected = selections.get(selectionKey(request.selected.providerId, request.selected.modelId))
    if (!selected) {
      this.routing.revokeRoute(request.sessionKey)
      throw new Error(
        `模型 ${request.selected.providerId}/${request.selected.modelId} 不在 Bento 注册表中`,
      )
    }

    const configDir = path.join(this.userDataDir, "providers", `kimi-bento-${request.sessionKey}`)
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(configDir, "config.toml"),
      buildKimiSessionConfig(catalogProviders, selected),
      { mode: 0o600 },
    )

    const sessionKey = request.sessionKey
    const routing = this.routing
    let disposed = false
    return {
      sessionKey,
      harnessId: request.harnessId,
      env: { KIMI_CODE_HOME: configDir },
      strip: ["KIMI_MODEL_", "KIMI_API_KEY", "KIMI_BASE_URL"],
      configDir,
      selections,
      selected,
      revision: 1,
      async dispose() {
        // 只释放活跃资源(loopback routes);configDir 保留供 revive 复用同一
        // KIMI_CODE_HOME 恢复 Kimi native session。彻底删除走 removeSessionState。
        if (disposed) return
        disposed = true
        routing.revokeRoute(sessionKey)
      },
    }
  }

  async removeSessionState(sessionKey: string): Promise<void> {
    const configDir = path.join(this.userDataDir, "providers", `kimi-bento-${sessionKey}`)
    await fs.promises.rm(configDir, { recursive: true, force: true })
  }

  async reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult> {
    // 注册表内任意 Provider/模型 → ACP setSessionConfigOption live(spike2 实证)。
    const ref = lease.selections.get(selectionKey(next.providerId, next.modelId))
    if (ref) return { mode: "live", selection: ref }
    // 未登记选择 → 不假切换。
    const reason = "该模型不在当前 Bento 注册表中,需要新会话"
    return { mode: "new-session", reason }
  }
}

/** 测试与后续注册用工厂;harnessId 固定 kimi。 */
export function createKimiBentoAdapter(
  routing: ProviderRoutingService,
  userDataDir: string,
): SessionConfigAdapter {
  return new KimiBentoConfigAdapter("kimi", routing, userDataDir)
}
