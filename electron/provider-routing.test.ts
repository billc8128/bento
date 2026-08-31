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
      currentModelId: "gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol" }],
    })
    expect(discoverCodex).toHaveBeenCalledOnce()
    expect(routing.sessionsUsing("openai")).toBe(0)
    expect(fs.readdirSync(path.join(dir, "providers")).some(
      (name) => name.startsWith("codex-home-discovery-"),
    )).toBe(false)
    routing.dispose()
  })

  it("Pi 生成隔离 models.json，密钥只进进程环境", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-pi-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const config: CustomProviderConfig = {
      id: "user-deepseek",
      presetId: "deepseek",
      name: "DeepSeek",
      auth: { method: "apiKey" },
      runtimes: {
        pi: {
          baseUrl: "https://api.deepseek.com",
          wireProtocol: "openai-chat",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000 }],
        },
      },
    }
    store.upsert(config, { "*": "sk-secret" })
    const routing = new ProviderRoutingService(dir, () => store)
    const result = routing.piProviderEnv(config.id)
    const models = fs.readFileSync(path.join(result.env.PI_CODING_AGENT_DIR, "models.json"), "utf8")
    expect(result.env.BENTO_PROVIDER_KEY).toBe("sk-secret")
    expect(result.strip).toContain("PI_CODING_AGENT_DIR")
    expect(models).toContain('"api": "openai-completions"')
    expect(models).toContain('"id": "deepseek-chat"')
    expect(models).not.toContain("sk-secret")
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

  it("为 ACP harness 生成隔离配置，密钥仅通过环境变量注入", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routing-acp-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    const runtime = {
      baseUrl: "https://api.example.com/v1",
      wireProtocol: "openai-chat" as const,
      models: [{ id: "model-x", name: "Model X" }],
    }
    const config: CustomProviderConfig = {
      id: "user-acp",
      name: "ACP Provider",
      auth: { method: "apiKey" },
      runtimes: { kimi: runtime, opencode: runtime, omp: runtime, hermes: runtime },
    }
    store.upsert(config, { "*": "sk-acp-secret" })
    const routing = new ProviderRoutingService(dir, () => store)

    const kimi = routing.configuredHarnessEnv("s1", config.id, "kimi", "model-x")
    expect(kimi.env).toMatchObject({
      KIMI_MODEL_NAME: "model-x",
      KIMI_MODEL_API_KEY: "sk-acp-secret",
    })

    const openCode = routing.configuredHarnessEnv("s2", config.id, "opencode", "bento/model-x")
    const openCodeFile = fs.readFileSync(openCode.env.OPENCODE_CONFIG, "utf8")
    expect(openCodeFile).toContain("bento/model-x")
    expect(openCodeFile).not.toContain("sk-acp-secret")

    const omp = routing.configuredHarnessEnv("s3", config.id, "omp", "bento/model-x")
    const ompFile = fs.readFileSync(path.join(omp.env.OMP_HOME, "agent", "models.json"), "utf8")
    expect(ompFile).toContain('"id": "model-x"')
    expect(ompFile).not.toContain("sk-acp-secret")

    const hermes = routing.configuredHarnessEnv("s4", config.id, "hermes", "model-x")
    const hermesFile = fs.readFileSync(path.join(hermes.env.HERMES_HOME, "config.yaml"), "utf8")
    expect(hermesFile).toContain("${BENTO_PROVIDER_KEY}")
    expect(hermesFile).toContain('"api_mode": "chat_completions"')
    expect(hermesFile).not.toContain("sk-acp-secret")
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
