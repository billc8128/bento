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

import type { CustomProviderConfig } from "../src/core/provider"
import type { OAuthTokens, CustomProviderStore } from "./custom-providers"
import { RouteRegistry, startLocalModelProxy, type LocalModelProxy, type ProxyRoute } from "./model-proxy"
import { refreshOAuthToken } from "./oauth-runner"
import { discoverCodexModels } from "./drivers/codex"
import { discoverClaudeModels } from "./drivers/claude-agent-sdk"
import type { ProviderDiscoveryResult } from "./provider-discovery"

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
  private readonly oauthRefreshes = new Map<string, Promise<void>>()

  constructor(
    private readonly userDataDir: string,
    private readonly providers: () => CustomProviderStore,
    private readonly refreshToken: typeof refreshOAuthToken = refreshOAuthToken,
    private readonly discoverCodex: typeof discoverCodexModels = discoverCodexModels,
    private readonly discoverClaude: typeof discoverClaudeModels = discoverClaudeModels,
  ) {}

  private refreshOAuthInBackground(
    providerId: string,
    descriptor: Extract<CustomProviderConfig["auth"], { method: "oauth" }>["oauth"],
    current: OAuthTokens,
  ): void {
    if (!current.refreshToken || this.oauthRefreshes.has(providerId)) return
    const refresh = this.refreshToken(descriptor, current.refreshToken).then((next) => {
      if (!next) {
        this.routes.updateProvider(providerId, { apiKey: "bento-oauth-refresh-failed" })
        return
      }
      const merged = {
        ...next,
        ...(next.oauthProxyUrl ? {} : current.oauthProxyUrl ? { oauthProxyUrl: current.oauthProxyUrl } : {}),
        ...(next.accountId ? {} : current.accountId ? { accountId: current.accountId } : {}),
      }
      this.providers().writeOAuthTokens(providerId, merged)
      this.routes.updateProvider(providerId, {
        apiKey: merged.accessToken,
        ...(merged.oauthProxyUrl ? { baseUrl: merged.oauthProxyUrl } : {}),
      })
    }).finally(() => {
      this.oauthRefreshes.delete(providerId)
    })
    this.oauthRefreshes.set(providerId, refresh)
  }

  private async ensureProxy(): Promise<LocalModelProxy> {
    if (this.proxy) return this.proxy
    this.starting ??= startLocalModelProxy(this.routes).then((proxy) => {
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
    const route = await this.resolveRoute(providerId, harnessId)
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
      route: await this.resolveRoute(providerId, harnessId),
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
    this.routes.issue(token, await this.resolveRoute(providerId, harnessId))
  }

  private tokensOf(sessionKey: string): Set<string> {
    let tokens = this.tokensBySession.get(sessionKey)
    if (!tokens) {
      tokens = new Set()
      this.tokensBySession.set(sessionKey, tokens)
    }
    return tokens
  }

  private async resolveRoute(providerId: string, harnessId: string): Promise<ProxyRoute> {
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
        this.refreshOAuthInBackground(providerId, config.auth.oauth, tokens)
      }
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

  /** 多少个会话还占着该 provider 的路由(删除确认文案用;每会话至多计一次)。 */
  sessionsUsing(providerId: string): number {
    let count = 0
    for (const tokens of this.tokensBySession.values()) {
      if ([...tokens].some((token) => this.routes.resolve(token)?.providerId === providerId)) count += 1
    }
    return count
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
      ].join("\n"),
    )
    return { env: { CODEX_HOME: home, OPENAI_API_KEY: "bento-local-proxy" } }
  }

  async discoverProviderModels(
    providerId: string,
    harnessId: string,
    cwd: string,
  ): Promise<ProviderDiscoveryResult | null> {
    const config = this.providers().getProviderConfig(providerId)
    if (!config?.runtimes[harnessId as keyof typeof config.runtimes] ||
      (providerId !== "openai" && providerId !== "anthropic")) {
      return null
    }
    const sessionKey = `discovery-${randomUUID()}`
    if (providerId === "openai") {
      // OpenAI OAuth 是账户级目录。固定 managed Codex 负责 model/list，
      // 结果再由 Provider Registry 投影给所有 Responses-compatible Harness。
      const route = await this.issueRoute(sessionKey, providerId, "codex")
      const proxyEnv = this.codexHomeEnv(sessionKey, route, providerId)
      try {
        return await this.discoverCodex(cwd, proxyEnv.env, { runtimePreference: "managed" })
      } finally {
        this.revokeRoute(sessionKey)
        this.disposeCodexHome(sessionKey)
      }
    }

    // Anthropic OAuth 同样只接受 SDK 初始化返回的账户真实目录。
    const route = await this.issueRoute(sessionKey, providerId, "claude-code")
    const isolated = this.claudeCodeEnv(route)
    const configDir = this.claudeCodeConfigDir(sessionKey)
    try {
      return await this.discoverClaude(cwd, {
        env: { ...isolated.env, CLAUDE_CONFIG_DIR: configDir },
        strip: isolated.strip,
      }, "managed")
    } finally {
      this.revokeRoute(sessionKey)
      fs.rmSync(configDir, { recursive: true, force: true })
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
