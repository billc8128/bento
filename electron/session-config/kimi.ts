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
 * kimi 1.x 布局变更(1.49.0 实测,kimi-cli 源码核实):
 *   - 配置与凭证搬到 share dir:config.toml 读 `$KIMI_SHARE_DIR/config.toml`
 *     (kimi_cli/config.py),OAuth token 读 `$KIMI_SHARE_DIR/credentials/kimi-code.json`
 *     (kimi_cli/auth/oauth.py:_credentials_dir = get_share_dir()/credentials);
 *   - 1.17.0 起 ACP session/new 与 prompt 强制检查 kimi 账户 token 存在性
 *     (_check_auth,仅本地文件存在 + 未过期检查,无服务端验证)。自定义 Provider
 *     的推理不消费该 token,因此隔离目录里放一份格式合法的占位 token 即可——
 *     与 api_key 占位同一手法,kimi 账户资源零使用;
 *   - config schema 变化:provider type "openai" → "openai_legacy",
 *     capabilities 不再接受 "tool_use"(只剩 thinking/image_in/video_in/always_thinking)。
 *   因此按版本写两份 config:share/(1.x,KIMI_SHARE_DIR)与 code/(0.x,KIMI_CODE_HOME)。
 *
 * 由此本 Adapter:
 *   prepare  = 全 Provider 注册表双版本 config + 占位 token + 每 Provider 独立 route;
 *   reconfigure = 租约内任意选择 live;
 *   dispose = 吊销本会话全部 routes;目录保留供 revive,彻底删除走 removeSessionState。
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

/**
 * 占位 OAuth token:仅满足 kimi 1.x ACP 的本地存在性检查(_check_token_usable
 * 只看 access_token 非空且未过期)。expires_at 固定远未来,refresh_token 为空。
 */
const PLACEHOLDER_TOKEN = {
  access_token: PLACEHOLDER_CREDENTIAL,
  refresh_token: "",
  expires_at: 4_102_444_800, // 2100-01-01
  scope: "",
  token_type: "Bearer",
  expires_in: 0,
}

type KimiConfigVersion = "v0" | "v1"

/** wireProtocol → Kimi [providers.*].type(0.x spike 实测;1.x openai 改名 openai_legacy)。 */
function kimiProviderType(wireProtocol: WireProtocol, version: KimiConfigVersion): string {
  if (wireProtocol === "anthropic-messages") return "anthropic"
  if (wireProtocol === "openai-responses") return "openai_responses"
  return version === "v1" ? "openai_legacy" : "openai"
}

/** Kimi 拒绝无正数 max_context_size 的模型(spike3 报错实测)。 */
function positiveContext(contextWindow: number | undefined): number {
  return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128_000
}

/**
 * 生成完整多 Provider config.toml。api_key 全部是占位凭证;真实鉴权在
 * ProviderRoutingService 的 loopback route 侧注入,密钥只存 safeStorage。
 * TOML 转义:provider alias 与 model id 的引号/反斜杠/控制字符。
 * v1(kimi ≥1.x):type=openai_legacy,capabilities 不含 tool_use(1.x 只认
 * thinking/image_in/video_in/always_thinking)。
 */
export function buildKimiSessionConfig(
  providers: Array<{ alias: string } & Pick<SessionProviderRuntime,
    "name" | "baseUrl" | "wireProtocol" | "models">>,
  defaultModelRef: PreparedModelRef,
  version: KimiConfigVersion = "v0",
): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const lines: string[] = [`default_model = "${escape(defaultModelRef.harnessModelId)}"`, ""]
  for (const provider of providers) {
    lines.push(`[providers.${JSON.stringify(provider.alias)}]`)
    lines.push(`type = "${kimiProviderType(provider.wireProtocol, version)}"`)
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
      // 0.x:agent 会话恒需要 tool_use;reasoning 模型追加 thinking。
      // 1.x:capabilities 只剩模态/思考标记,tool_use 已非法,仅 reasoning 模型标注。
      // 1.x 恒声明 image_in:它是本地准入门槛——模型没声明时带图 prompt 直接
      // Internal error("does not support required capability: image_in",实测);
      // 目录没有模态元数据,模型能否真看图交给上游裁决。
      if (version === "v0") {
        lines.push(model.reasoning === true
          ? 'capabilities = [ "thinking", "tool_use" ]'
          : 'capabilities = [ "tool_use" ]')
      } else if (model.reasoning === true) {
        lines.push('capabilities = [ "thinking", "image_in" ]')
      } else {
        lines.push('capabilities = [ "image_in" ]')
      }
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
    // 双版本布局:kimi 0.x 读 KIMI_CODE_HOME/config.toml;1.x 读
    // KIMI_SHARE_DIR/config.toml 并把 OAuth token 与门槛检查都放在 share dir。
    const codeDir = path.join(configDir, "code")
    const shareDir = path.join(configDir, "share")
    fs.mkdirSync(path.join(shareDir, "credentials"), { recursive: true, mode: 0o700 })
    fs.mkdirSync(codeDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(codeDir, "config.toml"),
      buildKimiSessionConfig(catalogProviders, selected, "v0"),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(shareDir, "config.toml"),
      buildKimiSessionConfig(catalogProviders, selected, "v1"),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(shareDir, "credentials", "kimi-code.json"),
      JSON.stringify(PLACEHOLDER_TOKEN),
      { mode: 0o600 },
    )

    const sessionKey = request.sessionKey
    const routing = this.routing
    let disposed = false
    return {
      sessionKey,
      harnessId: request.harnessId,
      env: { KIMI_CODE_HOME: codeDir, KIMI_SHARE_DIR: shareDir },
      strip: ["KIMI_MODEL_", "KIMI_API_KEY", "KIMI_BASE_URL"],
      configDir,
      selections,
      selected,
      revision: 1,
      async dispose() {
        // 只释放活跃资源(loopback routes);configDir 保留供 revive 复用同一
        // KIMI_CODE_HOME/KIMI_SHARE_DIR 恢复 Kimi native session。彻底删除走 removeSessionState。
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
