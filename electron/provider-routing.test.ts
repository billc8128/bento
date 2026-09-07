import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CustomProviderConfig } from "../src/core/provider"
import { CustomProviderStore, type OAuthTokens, type SecretStore } from "./custom-providers"
import { ProviderRoutingService } from "./provider-routing"

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

const dirs: string[] = []
const servers: http.Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("ProviderRoutingService OAuth", () => {
  it("OpenAI OAuth 可经 Pi runtime 的 Responses 路由命中订阅后端", async () => {
    let seenPath = ""
    let seenAuthorization = ""
    let seenAccount = ""
    const upstream = http.createServer((request, response) => {
      seenPath = request.url ?? ""
      seenAuthorization = request.headers.authorization ?? ""
      seenAccount = String(request.headers["chatgpt-account-id"] ?? "")
      response.writeHead(200, { "content-type": "application/json" }).end("{}")
    })
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const oauthProxyUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-openai-pi-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.writeOAuthTokens("openai", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-1",
      oauthProxyUrl,
    })
    const routing = new ProviderRoutingService(dir, () => store)
    const route = await routing.issueRoute("session", "openai", "pi")
    const response = await fetch(`${route.baseUrl}/responses`, { method: "POST", body: "{}" })
    expect(response.status).toBe(200)
    expect(seenPath).toBe("/responses")
    expect(seenAuthorization).toBe("Bearer oauth-access")
    expect(seenAccount).toBe("account-1")
    routing.dispose()
  })

  it("Pi 的 OpenAI OAuth 目录复用隔离 Codex model/list 探针并清理临时租约", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-openai-models-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.writeOAuthTokens("openai", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-1",
    })
    const discoverCodex = vi.fn(async (_cwd: string, env?: NodeJS.ProcessEnv) => {
      expect(env?.CODEX_HOME).toContain("codex-home-discovery-")
      return {
        currentModelId: "gpt-5.6-sol",
        models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol", reasoning: true }],
      }
    })
    const routing = new ProviderRoutingService(dir, () => store, undefined, discoverCodex)

    await expect(routing.discoverProviderModels("openai", "pi", dir)).resolves.toMatchObject({
      result: {
        currentModelId: "gpt-5.6-sol",
        models: [{ id: "gpt-5.6-sol" }],
      },
    })
    expect(discoverCodex).toHaveBeenCalledOnce()
    expect(routing.sessionsUsing("openai")).toBe(0)
    expect(fs.readdirSync(path.join(dir, "providers")).some(
      (name) => name.startsWith("codex-home-discovery-"),
    )).toBe(false)
    routing.dispose()
  })

  it("Anthropic OAuth 目录来自隔离 SDK 初始化并清理临时租约", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-anthropic-models-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.writeOAuthTokens("anthropic", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const discoverClaude = vi.fn(async (
      _cwd: string,
      proxyEnv?: { env: Record<string, string> },
      preference?: string,
    ) => {
      expect(proxyEnv?.env.CLAUDE_CONFIG_DIR).toContain("cc-discovery-")
      expect(preference).toBe("managed")
      return { models: [{ id: "actual-claude", name: "Actual Claude", reasoning: true }] }
    })
    const routing = new ProviderRoutingService(
      dir,
      () => store,
      undefined,
      undefined,
      discoverClaude,
    )

    await expect(routing.discoverProviderModels("anthropic", "claude-code", dir))
      .resolves.toMatchObject({ result: { models: [{ id: "actual-claude" }] } })
    expect(routing.sessionsUsing("anthropic")).toBe(0)
    expect(fs.readdirSync(path.join(dir, "providers")).some(
      (name) => name.startsWith("cc-discovery-"),
    )).toBe(false)
    routing.dispose()
  })

  it("非发现目标返回空结果且不带错误,不误标失败", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-non-target-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const routing = new ProviderRoutingService(dir, () => store)

    await expect(routing.discoverProviderModels("user-relay", "codex", dir))
      .resolves.toEqual({ result: null })
    await expect(routing.discoverProviderModels("openai", "nonexistent-harness", dir))
      .resolves.toEqual({ result: null })
    routing.dispose()
  })

  it("OAuth 凭证缺失时账户发现按授权异常上报中文文案", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-no-token-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const routing = new ProviderRoutingService(dir, () => store)

    const outcome = await routing.discoverProviderModels("openai", "codex", dir)
    expect(outcome.result).toBeNull()
    expect(outcome.error).toContain("重新登录")
    routing.dispose()
  })

  it("发现探针抛错时按失败上报,提示运行时就绪后重试", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-rpc-fail-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.writeOAuthTokens("openai", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const discoverCodex = vi.fn(async () => {
      throw new Error("spawn codex ENOENT")
    })
    const routing = new ProviderRoutingService(dir, () => store, undefined, discoverCodex)

    const outcome = await routing.discoverProviderModels("openai", "codex", dir)
    expect(outcome.result).toBeNull()
    expect(outcome.error).toContain("运行时就绪")
    expect(outcome.error).toContain("spawn codex ENOENT")
    routing.dispose()
  })

  it("OAuth 账户目录为空时按失败上报,不静默当无发现", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-empty-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.writeOAuthTokens("openai", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const discoverCodex = vi.fn(async () => ({ models: [] }))
    const routing = new ProviderRoutingService(dir, () => store, undefined, discoverCodex)

    const outcome = await routing.discoverProviderModels("openai", "codex", dir)
    expect(outcome.result).toEqual({ models: [] })
    expect(outcome.error).toContain("空的模型列表")
    expect(routing.sessionsUsing("openai")).toBe(0)
    routing.dispose()
  })


  it("Codex config 把 model_provider 写在顶层并关闭 WebSocket", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-codex-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const routing = new ProviderRoutingService(dir, () => store)
    const { env } = routing.codexHomeEnv(
      "session-codex",
      { token: "route", baseUrl: "http://127.0.0.1:3210/s/route" },
      "user-codex-subscription",
    )
    const config = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8")
    expect(config.indexOf('model_provider = "bento"')).toBeLessThan(config.indexOf("[model_providers.bento]"))
    expect(config).toContain("requires_openai_auth = false")
    expect(config).toContain("supports_websockets = false")
    expect(env.OPENAI_API_KEY).toBe("bento-local-proxy")
    routing.disposeCodexHome("session-codex")
  })


  it("临期读取后台单飞刷新,并更新活跃路由的 token 与 Anthropic OAuth 头", async () => {
    let seenAuth = ""
    let seenBeta = ""
    const upstream = http.createServer((request, response) => {
      seenAuth = request.headers.authorization ?? ""
      seenBeta = String(request.headers["anthropic-beta"] ?? "")
      response.writeHead(200).end("ok")
    })
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-oauth-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const config: CustomProviderConfig = {
      id: "user-claude-subscription",
      name: "Claude 订阅",
      auth: {
        method: "oauth",
        oauth: {
          authorizeUrl: "https://claude.ai/oauth/authorize",
          tokenUrl: "https://console.anthropic.com/v1/oauth/token",
          clientId: "public-client",
          scopes: "oauth user:inference:llm",
        },
      },
      runtimes: {
        "claude-code": {
          baseUrl: "https://unused.example.com",
          wireProtocol: "anthropic-messages",
          models: [{ id: "claude-sonnet", name: "Claude Sonnet" }],
        },
      },
    }
    store.upsert(config)
    store.writeOAuthTokens(config.id, {
      accessToken: "old-access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 1_000,
      oauthProxyUrl: upstreamUrl,
      accountId: "account-stable",
    })

    let finishRefresh!: (tokens: OAuthTokens) => void
    const pendingRefresh = new Promise<OAuthTokens>((resolve) => { finishRefresh = resolve })
    const refresh = vi.fn(() => pendingRefresh)
    const routing = new ProviderRoutingService(dir, () => store, refresh)
    const routeA = await routing.issueRoute("session-a", config.id, "claude-code")
    await routing.issueRoute("session-b", config.id, "claude-code")
    expect(refresh).toHaveBeenCalledTimes(1)

    finishRefresh({ accessToken: "new-access", refreshToken: "refresh-2", expiresAt: Date.now() + 3_600_000 })
    await pendingRefresh
    await new Promise((resolve) => setImmediate(resolve))

    expect(await (await fetch(`${routeA.baseUrl}/v1/messages`)).text()).toBe("ok")
    expect(seenAuth).toBe("Bearer new-access")
    expect(seenBeta).toBe("OAuth-2025-04-20")
    expect(store.readOAuthTokens(config.id)).toMatchObject({
      accessToken: "new-access",
      accountId: "account-stable",
    })
    routing.dispose()
  })

  it("会话内切 provider 复用同一 loopback URL 并原子替换上游凭证", async () => {
    let seenAuth = ""
    const upstream = http.createServer((request, response) => {
      seenAuth = request.headers.authorization ?? ""
      response.writeHead(200).end("ok")
    })
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-switch-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const config = (id: string): CustomProviderConfig => ({
      id,
      name: id,
      auth: { method: "apiKey" },
      runtimes: {
        codex: {
          baseUrl,
          requestPath: "/responses",
          wireProtocol: "openai-responses",
          models: [{ id: "m", name: "M" }],
        },
      },
    })
    store.upsert(config("user-a"), { codex: "key-a" })
    store.upsert(config("user-b"), { codex: "key-b" })
    const routing = new ProviderRoutingService(dir, () => store)
    const route = await routing.issueRoute("session", "user-a", "codex")

    await fetch(`${route.baseUrl}/v1/responses`, { method: "POST", body: "{}" })
    expect(seenAuth).toBe("Bearer key-a")
    await routing.switchRoute("session", "user-b", "codex")
    await fetch(`${route.baseUrl}/v1/responses`, { method: "POST", body: "{}" })
    expect(seenAuth).toBe("Bearer key-b")
    routing.revokeProvider("user-b")
    expect((await fetch(`${route.baseUrl}/v1/responses`)).status).toBe(401)
    routing.dispose()
  })
})
