/**
 * ProviderRoutingService(main 侧):Claude/Codex builtin + user provider 会话路由准备。
 *
 * 职责(kimi review #1/#4/#6:driver 保持「不写文件」,准备动作全收在这):
 *   - 启动/持有 LocalModelProxy(app 生命周期一个)
 *   - token 生命周期挂 session key:每次 driver start(含 ensureLive revive
 *     重 spawn)调 issueRoute 重签发;stopLive/removeSession 调 revokeRoute
 *   - claude-code 隔离:每 provider 一个 CLAUDE_CONFIG_DIR(userData/providers/
 *     cc-<id>/,空目录即可——SDK 在无登录态时纯走 env),spawn env 注入
 *     ANTHROPIC_BASE_URL=代理地址 + ANTHROPIC_AUTH_TOKEN=占位
 *   - 读 safeStorage 密钥组装 ProxyRoute;密钥不存在时抛错(会话创建期失败,
 *     不留到运行期)
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CustomProviderConfig } from "../../src/core/provider"
import type { CustomProviderStore } from "./custom-providers"
import { RouteRegistry, startLocalModelProxy, type LocalModelProxy, type ProxyRoute } from "./model-proxy"
import { isOpenCodeUpstream, OPENCODE_SESSION_HEADER } from "../sessions/opencode-session"
import { refreshOAuthToken } from "./oauth-runner"
import { discoverCodexModels } from "../drivers/codex"
import { discoverClaudeModels } from "../drivers/claude-agent-sdk"
import type { BuiltinDiscoveryResult, ProviderDiscoveryResult } from "./provider-discovery"

/** 把 builtin 账户发现的底层错误归类成设置页可行动的中文文案。 */
function builtinDiscoveryErrorMessage(providerName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/尚未授权|未授权|未登录|登录|授权|401|403|unauthorized|forbidden|invalid_grant/i.test(message)) {
    return `${providerName} 授权状态异常,请断开后重新登录再试(${message})`
  }
  return `${providerName} 模型发现失败,请稍后重试;首次使用需等待内置运行时就绪(${message})`
}

export type SessionRoute = {
  token: string
  baseUrl: string // 注入给 harness 的 base URL(http://127.0.0.1:<port>/s/<token>)
}

export class ProviderRoutingService {
  private readonly routes = new RouteRegistry()
  /** sessionKey → 该会话持有的全部 loopback token(多 Provider route set)。 */
  private readonly tokensBySession = new Map<string, Set<string>>()
  private proxy: LocalModelProxy | null = null
  private starting: Promise<LocalModelProxy> | null = null
  private readonly oauthRefreshes = new Map<string, Promise<boolean>>()

  constructor(
    private readonly userDataDir: string,
    private readonly providers: () => CustomProviderStore,
    private readonly refreshToken: typeof refreshOAuthToken = refreshOAuthToken,
    private readonly discoverCodex: typeof discoverCodexModels = discoverCodexModels,
    private readonly discoverClaude: typeof discoverClaudeModels = discoverClaudeModels,
    private readonly isOpenCode: (baseUrl: string) => boolean = isOpenCodeUpstream,
    /** 凭证死透时回调(受影响会话 key 列表):main 侧注入会话时间线提示。 */
    private readonly onReauthRequired: (providerName: string, sessionKeys: string[]) => void = () => {},
  ) {}

  /**
   * OAuth 刷新(按 provider 单飞):主动(签发时临期)与被动(代理收到
   * 上游 401)共用同一条路径。成功→写回 store 并原地更新全部活跃路由的
   * apiKey(并发的同会话请求自动用上新凭证),resolve true;无 refreshToken
   * 或刷新失败→路由 key 置占位符,resolve false。
   */
  private refreshOAuth(providerId: string): Promise<boolean> {
    const inflight = this.oauthRefreshes.get(providerId)
    if (inflight) return inflight
    const config = this.providers().getProviderConfig(providerId)
    const current = this.providers().readOAuthTokens(providerId)
    if (!config || config.auth.method !== "oauth" || !current?.refreshToken) {
      return Promise.resolve(false)
    }
    const refresh = this.refreshToken(config.auth.oauth, current.refreshToken).then((next) => {
      if (!next.ok) {
        // unauthorized=凭证死透(别处登出/授权撤销):清登录态+吊销路由,
        // resolveRoute 既有的「尚未授权」抛错接管新建会话,活跃会话的重试
        // 拿到代理对未知 token 的干净 401(session_expired)快速失败;
        // network/invalid-response=临时(畸形响应不等于凭证死了,保守不清)。
        if (next.kind === "unauthorized") {
          this.invalidateOAuth(providerId, config.name)
        } else {
          this.routes.updateProvider(providerId, { apiKey: "bento-oauth-refresh-failed" })
        }
        return false
      }
      const nextTokens = next.tokens
      const merged = {
        ...nextTokens,
        ...(nextTokens.oauthProxyUrl ? {} : current.oauthProxyUrl ? { oauthProxyUrl: current.oauthProxyUrl } : {}),
        ...(nextTokens.accountId ? {} : current.accountId ? { accountId: current.accountId } : {}),
      }
      this.providers().writeOAuthTokens(providerId, merged)
      this.routes.updateProvider(providerId, {
        apiKey: merged.accessToken,
        ...(merged.oauthProxyUrl ? { baseUrl: merged.oauthProxyUrl } : {}),
      })
      return true
    }).catch(() => {
      this.routes.updateProvider(providerId, { apiKey: "bento-oauth-refresh-failed" })
      return false
    })
    const tracked = refresh.finally(() => {
      this.oauthRefreshes.delete(providerId)
    })
    this.oauthRefreshes.set(providerId, tracked)
    return tracked
  }

  /** 代理收到上游 401 的回调:仅 OAuth provider 可自愈,其余直接透传。 */
  private readonly onUpstreamUnauthorized = (route: ProxyRoute, failedApiKey: string): Promise<boolean> => {
    const config = this.providers().getProviderConfig(route.providerId)
    if (!config || config.auth.method !== "oauth") return Promise.resolve(false)
    // 并发 401 的迟到者:本请求是用旧 key 发的,凭证已被其他请求的刷新
    // 原地轮换(updateProvider 语义)——无需再刷,直接用新 key 重试。
    if (route.apiKey !== failedApiKey) return Promise.resolve(true)
    return this.refreshOAuth(route.providerId)
  }

  /** 凭证死透收敛:标记(重新登录前只通知一次)→ 清登录态(onChange 广播
   * providers:changed,设置页切换到「登录已失效」警告态)→ 吊销路由 →
   * 会话时间线提示。不 kill 正在跑的会话进程,让它自然失败。 */
  private invalidateOAuth(providerId: string, providerName: string): void {
    const notified = this.providers().needsReauth(providerId)
    const sessionKeys = notified ? [] : this.sessionsOnProvider(providerId)
    // 先清(清凭证+复位旧标记+广播)后置位:webContents.send 异步投递,
    // renderer 重拉的 IPC 必然晚于本同步块,拉到的列表已带上新标记。
    this.providers().clearOAuthTokens(providerId)
    if (!notified) {
      this.providers().markNeedsReauth(providerId)
      this.onReauthRequired(providerName, sessionKeys)
    }
    this.revokeProvider(providerId)
  }

  private refreshOAuthInBackground(providerId: string): void {
    void this.refreshOAuth(providerId)
  }

  private async ensureProxy(): Promise<LocalModelProxy> {
    if (this.proxy) return this.proxy
    this.starting ??= startLocalModelProxy(this.routes, {
      onUnauthorized: this.onUpstreamUnauthorized,
    }).then((proxy) => {
      this.proxy = proxy
      return proxy
    })
    return this.starting
  }

  /**
   * 为 (sessionKey, providerId, harnessId) 签发单条路由(旧契约):
   * 先吊销该会话全部既有 token,再签发新的——同 session 重复调用后只剩
   * 一个有效 token,revive 重 spawn 的旧 token 立即作废。
   */
  async issueRoute(sessionKey: string, providerId: string, harnessId: string): Promise<SessionRoute> {
    const route = await this.resolveRoute(providerId, harnessId, sessionKey)
    const proxy = await this.ensureProxy()
    this.revokeRoute(sessionKey)
    const token = randomUUID()
    this.routes.issue(token, route)
    this.tokensOf(sessionKey).add(token)
    return { token, baseUrl: `http://127.0.0.1:${proxy.port}/s/${token}` }
  }

  /**
   * route set:同一 sessionKey 一次为多个 provider 各签发独立 token/baseUrl
   * (多 Provider Bento 租约用)。事务性:先把全部 ProxyRoute 解析成功,再整体
   * 吊销旧 set 并签发新 set;任何一条解析失败都不动旧 token,无部分泄漏。
   */
  async issueRouteSet(
    sessionKey: string,
    entries: Array<{ providerId: string; harnessId: string }>,
  ): Promise<Map<string, SessionRoute>> {
    const resolved = await Promise.all(entries.map(async ({ providerId, harnessId }) => ({
      providerId,
      route: await this.resolveRoute(providerId, harnessId, sessionKey),
    })))
    const proxy = await this.ensureProxy()
    this.revokeRoute(sessionKey)
    const result = new Map<string, SessionRoute>()
    for (const { providerId, route } of resolved) {
      const token = randomUUID()
      this.routes.issue(token, route)
      this.tokensOf(sessionKey).add(token)
      result.set(providerId, { token, baseUrl: `http://127.0.0.1:${proxy.port}/s/${token}` })
    }
    return result
  }

  async switchRoute(sessionKey: string, providerId: string, harnessId: string): Promise<void> {
    // 单 route 会话(claude-code/codex)的语义:复用本会话既有 loopback URL,
    // 原子替换其指向的上游。多 token route set 不走此路径(各 provider 已有
    // 独立 token,切换由 Adapter 直接下发对应 baseUrl)。
    const [token] = this.tokensBySession.get(sessionKey) ?? []
    if (!token) throw new Error("会话路由不存在,无法切换供应商")
    this.routes.issue(token, await this.resolveRoute(providerId, harnessId, sessionKey))
  }

  private tokensOf(sessionKey: string): Set<string> {
    let tokens = this.tokensBySession.get(sessionKey)
    if (!tokens) {
      tokens = new Set()
      this.tokensBySession.set(sessionKey, tokens)
    }
    return tokens
  }

  /**
   * @param sessionKey 持久化会话标识(session record 的 key,app 重启/离线
   * resume 不变);OpenCode 上游直接拿它做 x-opencode-session 亲和 ID。
   */
  private async resolveRoute(providerId: string, harnessId: string, sessionKey?: string): Promise<ProxyRoute> {
    const config = this.providers().getProviderConfig(providerId)
    if (!config) throw new Error(`供应商不存在: ${providerId}`)
    const runtime = config.runtimes[harnessId as keyof CustomProviderConfig["runtimes"]]
    if (!runtime) throw new Error(`供应商 ${config.name} 未配置 ${harnessId} runtime`)

    let apiKey: string
    let baseUrl = runtime.baseUrl
    let headerOverrides: Record<string, string> | undefined
    if (config.auth.method === "none") {
      apiKey = ""
    } else if (config.auth.method === "apiKey") {
      const stored = this.providers().readKey(providerId, harnessId)
      if (!stored) throw new Error(`供应商 ${config.name} 缺少 API key,请到设置页补填`)
      apiKey = stored
    } else {
      const tokens = this.providers().readOAuthTokens(providerId)
      if (!tokens || (tokens.expiresAt <= Date.now() && !tokens.refreshToken))
        throw new Error(`供应商 ${config.name} 尚未授权,请到设置页登录`)
      apiKey = tokens.accessToken
      baseUrl = tokens.oauthProxyUrl ?? runtime.baseUrl
      if (runtime.wireProtocol === "anthropic-messages") {
        headerOverrides = { "anthropic-beta": "OAuth-2025-04-20" }
      } else if (
        tokens.accountId &&
        (config.id === "openai" || baseUrl.includes("chatgpt.com/backend-api/codex"))
      ) {
        headerOverrides = {
          "chatgpt-account-id": tokens.accountId,
          originator: "codex_cli_rs",
        }
      }
      if (tokens.expiresAt - Date.now() < 5 * 60 * 1_000) {
        this.refreshOAuthInBackground(providerId)
      }
    }

    // OpenCode Go/Zen(issue #3):上游强制 x-opencode-session——按最终
    // baseUrl 判定(OAuth 的 oauthProxyUrl 覆写后),值直接用持久化的
    // sessionKey(本身是随机 UUID):重签发/切模型/app 重启后恢复会话,
    // ID 都稳定,正好满足「每会话一个稳定 ID」。
    if (sessionKey && this.isOpenCode(baseUrl)) {
      headerOverrides = { ...headerOverrides, [OPENCODE_SESSION_HEADER]: sessionKey }
    }

    return {
      providerId,
      agent: harnessId,
      baseUrl,
      ...(runtime.requestPath ? { requestPath: runtime.requestPath } : {}),
      wireProtocol: runtime.wireProtocol,
      apiKey,
      // auth:none 不注入鉴权值,但 runtime.inference 的 fixedHeaders 仍作为
      // 固定上游头生效(与 apiKey/oauth 分支同构)。
      ...(config.auth.method === "none"
        ? runtime.auth?.inference
          ? { auth: runtime.auth.inference }
          : {}
        : runtime.auth?.inference
          ? { auth: runtime.auth.inference }
          : config.auth.method === "oauth"
            ? { auth: { header: "Authorization", prefix: "Bearer " } }
            : runtime.wireProtocol === "anthropic-messages"
              ? { auth: { header: "x-api-key" } }
              : { auth: { header: "Authorization", prefix: "Bearer " } }),
      ...(headerOverrides ? { headerOverrides } : {}),
    }
  }

  /** 吊销该会话持有的全部 token(route set 整体回收)。 */
  revokeRoute(sessionKey: string): void {
    const tokens = this.tokensBySession.get(sessionKey)
    if (!tokens) return
    for (const token of tokens) this.routes.revoke(token)
    this.tokensBySession.delete(sessionKey)
  }

  revokeProvider(providerId: string): void {
    for (const [sessionKey, tokens] of this.tokensBySession) {
      for (const token of tokens) {
        if (this.routes.resolve(token)?.providerId === providerId) tokens.delete(token)
      }
      if (tokens.size === 0) this.tokensBySession.delete(sessionKey)
    }
    this.routes.revokeProvider(providerId)
  }

  /** 还占着该 provider 路由的会话 key(死透通知注入用;须在吊销前收集)。 */
  private sessionsOnProvider(providerId: string): string[] {
    const keys: string[] = []
    for (const [sessionKey, tokens] of this.tokensBySession) {
      if ([...tokens].some((token) => this.routes.resolve(token)?.providerId === providerId)) keys.push(sessionKey)
    }
    return keys
  }

  /** 多少个会话还占着该 provider 的路由(删除确认文案用;每会话至多计一次)。 */
  sessionsUsing(providerId: string): number {
    return this.sessionsOnProvider(providerId).length
  }

  /**
   * claude-code 隔离 spawn env:整目录隔离 + 代理注入
   * + strip ANTHROPIC_(坑 2:宿主环境同名变量会覆盖端点)。
   */
  claudeCodeEnv(sessionRoute: SessionRoute): { env: Record<string, string>; strip: string[] } {
    return {
      env: {
        ANTHROPIC_BASE_URL: sessionRoute.baseUrl,
        ANTHROPIC_AUTH_TOKEN: "bento-local-proxy",
      },
      strip: ["ANTHROPIC_"],
    }
  }

  /** 每 provider 一个隔离的 CLAUDE_CONFIG_DIR(空目录;SDK 无登录态时纯走 env)。 */
  claudeCodeConfigDir(providerId: string): string {
    const dir = path.join(this.userDataDir, "providers", `cc-${providerId}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }



  /**
   * codex 隔离:per-session 临时 CODEX_HOME(会话级——config.toml 的
   * model_provider 指向本会话代理地址),写 auth.json + config.toml;
   * disposeCodexHome 在 stopLive 时清理目录。
   */
  codexHomeEnv(sessionKey: string, sessionRoute: SessionRoute, providerId: string): {
    env: Record<string, string>
  } {
    const home = path.join(this.userDataDir, "providers", `codex-home-${sessionKey}`)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "bento-local-proxy" }),
    )
    const base = sessionRoute.baseUrl.replace(/\/+$/, "")
    fs.writeFileSync(
      path.join(home, "config.toml"),
      [
        'model_provider = "bento"',
        "",
        "[model_providers.bento]",
        `name = "Bento (${providerId})"`,
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        'env_key = "OPENAI_API_KEY"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        "",
        // codex 只对「OpenAI actor 授权」的 provider 注册 image_generation 等
        // hosted tools(spec_plan.rs image_generation_available);非空
        // x-openai-actor-authorization 头即可过这道门。该头只在本地过门控,
        // model-proxy 的 STRIP_INBOUND 会在出栈前剥掉,不会泄漏到真实上游。
        "[model_providers.bento.http_headers]",
        'x-openai-actor-authorization = "bento-local-proxy"',
        "",
      ].join("\n"),
    )
    return { env: { CODEX_HOME: home, OPENAI_API_KEY: "bento-local-proxy" } }
  }

  async discoverProviderModels(
    providerId: string,
    harnessId: string,
    cwd: string,
  ): Promise<BuiltinDiscoveryResult> {
    const config = this.providers().getProviderConfig(providerId)
    if (!config?.runtimes[harnessId as keyof typeof config.runtimes] ||
      (providerId !== "openai" && providerId !== "anthropic")) {
      return { result: null }
    }
    try {
      const sessionKey = `discovery-${randomUUID()}`
      let result: ProviderDiscoveryResult
      if (providerId === "openai") {
        // OpenAI OAuth 是账户级目录。固定 managed Codex 负责 model/list，
        // 结果再由 Provider Registry 投影给所有 Responses-compatible Harness。
        const route = await this.issueRoute(sessionKey, providerId, "codex")
        const proxyEnv = this.codexHomeEnv(sessionKey, route, providerId)
        try {
          result = await this.discoverCodex(cwd, proxyEnv.env, { runtimePreference: "managed" })
        } finally {
          this.revokeRoute(sessionKey)
          this.disposeCodexHome(sessionKey)
        }
      } else {
        // Anthropic OAuth 同样只接受 SDK 初始化返回的账户真实目录。
        const route = await this.issueRoute(sessionKey, providerId, "claude-code")
        const isolated = this.claudeCodeEnv(route)
        const configDir = this.claudeCodeConfigDir(sessionKey)
        try {
          result = await this.discoverClaude(cwd, {
            env: { ...isolated.env, CLAUDE_CONFIG_DIR: configDir },
            strip: isolated.strip,
          }, "managed")
        } finally {
          this.revokeRoute(sessionKey)
          fs.rmSync(configDir, { recursive: true, force: true })
        }
      }
      // OAuth 账户目录为空不是正常状态(多为运行时就绪前的探针异常),
      // 按失败上报,不能静默当"无发现"。
      if (result.models.length === 0) {
        return {
          result,
          error: `${config.name} 返回了空的模型列表,请稍后重试;首次使用需等待内置运行时就绪`,
        }
      }
      return { result }
    } catch (error) {
      return { result: null, error: builtinDiscoveryErrorMessage(config.name, error) }
    }
  }

  disposeCodexHome(sessionKey: string): void {
    fs.rmSync(path.join(this.userDataDir, "providers", `codex-home-${sessionKey}`), {
      recursive: true,
      force: true,
    })
  }

  dispose(): void {
    this.routes.revokeAll()
    this.tokensBySession.clear()
    this.proxy?.close()
    this.proxy = null
    this.starting = null
    this.oauthRefreshes.clear()
  }
}
