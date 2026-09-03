import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import { buildHermesSessionConfig, hermesProviderKey, HermesBentoConfigAdapter } from "./hermes"
import { normalizeBentoModelId } from "./alias"
import type { SessionConfigLease, SessionProviderRuntime } from "./types"

const tempDirs: string[] = []
const upstreams: http.Server[] = []
const routings: ProviderRoutingService[] = []

afterEach(() => {
  for (const routing of routings.splice(0)) routing.dispose()
  for (const server of upstreams.splice(0)) server.close()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function track<T extends string>(dir: T): T {
  tempDirs.push(dir)
  return dir
}

type SeenRequest = { url?: string; auth?: string; apiKeyHeader?: string; fixedFlag?: string }

async function mockUpstream(seen: SeenRequest): Promise<string> {
  const server = http.createServer((req, res) => {
    seen.url = req.url
    seen.auth = req.headers.authorization as string | undefined
    seen.apiKeyHeader = req.headers["x-api-key"] as string | undefined
    seen.fixedFlag = req.headers["x-flag"] as string | undefined
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  upstreams.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

describe("buildHermesSessionConfig", () => {
  it("providers key 为 custom:<alias>;model.provider/default 激活;transport 映射正确", () => {
    const yamlText = buildHermesSessionConfig(
      [
        {
          providerId: "user-alpha", name: "Alpha", baseUrl: "http://127.0.0.1:1/s/t-a",
          wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "bento/m-a2", name: "A2" }],
        },
        {
          providerId: "user-beta", name: "Beta", baseUrl: "http://127.0.0.1:1/s/t-b",
          wireProtocol: "openai-responses",
          models: [{ id: "m-b1", name: "B1" }],
        },
      ],
      { providerId: "user-alpha", modelId: "m-a1", harnessModelId: "custom:bento-x:m-a1" },
    )
    const parsed = JSON.parse(yamlText) as {
      model: { provider: string; default: string }
      providers: Record<string, { api: string; transport: string; api_key: string; default_model: string; models: Record<string, unknown> }>
    }
    const alphaKey = hermesProviderKey("user-alpha")
    const betaKey = hermesProviderKey("user-beta")
    // 命名空间:custom:<alias>
    expect(alphaKey).toMatch(/^custom:bento-[0-9a-z]+$/)
    expect(parsed.model).toEqual({ provider: alphaKey, default: "m-a1" })
    expect(parsed.providers[alphaKey]!.default_model).toBe("m-a1")
    // 非默认 provider 的 default_model 回落首个模型;bento/ 归一化
    expect(Object.keys(parsed.providers[betaKey]!.models)).toEqual(["m-b1"])
    expect(parsed.model.default).toBe("m-a1")
    // baseURL 即传入 route;api_key 占位
    expect(parsed.providers[alphaKey]!.api).toBe("http://127.0.0.1:1/s/t-a")
    expect(parsed.providers[alphaKey]!.api_key).toBe("bento-session-route")
    // transport 映射:chat → chat_completions;responses → codex_responses
    expect(parsed.providers[alphaKey]!.transport).toBe("chat_completions")
    expect(parsed.providers[betaKey]!.transport).toBe("codex_responses")
    expect(yamlText).not.toContain("sk-")
  })

  it("normalizeBentoModelId 剥离发布前缀", () => {
    expect(normalizeBentoModelId("bento/m1")).toBe("m1")
    expect(normalizeBentoModelId("m1")).toBe("m1")
  })
})

describe("HermesBentoConfigAdapter", () => {
  /**
   * fixture:α=apiKey openai-chat(Bearer 真实 key);
   * β=auth:none + requestPath + fixedHeaders(fixed 头生效、无鉴权值)。
   */
  async function fixture(): Promise<{
    userData: string
    routing: ProviderRoutingService
    seenAlpha: SeenRequest
    seenBeta: SeenRequest
  }> {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-fixture-"))
    track(userData)
    const seenAlpha: SeenRequest = {}
    const seenBeta: SeenRequest = {}
    const baseA = await mockUpstream(seenAlpha)
    const baseB = await mockUpstream(seenBeta)
    const store = new CustomProviderStore(userData, memorySecrets())
    const alpha: CustomProviderConfig = {
      id: "user-alpha", name: "alpha", auth: { method: "apiKey" },
      runtimes: {
        hermes: {
          baseUrl: baseA, wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "m-a2", name: "A2" }],
        },
      },
    }
    const beta: CustomProviderConfig = {
      id: "user-beta", name: "beta", auth: { method: "none" },
      runtimes: {
        hermes: {
          baseUrl: baseB,
          wireProtocol: "openai-chat",
          requestPath: "/svc/v1/completions",
          auth: { inference: { header: "x-unused", fixedHeaders: { "x-flag": "v1" } } },
          models: [{ id: "m-b1", name: "B1" }],
        },
      },
    }
    store.upsert(alpha, { "*": "sk-real-alpha" })
    store.upsert(beta)

    const routing = new ProviderRoutingService(userData, () => store)
    routings.push(routing)
    return { userData, routing, seenAlpha, seenBeta }
  }

  function sessionRequest(sessionKey: string): {
    sessionKey: string
    harnessId: "hermes"
    cwd: string
    selected: { providerId: string; modelId: string }
    providers: SessionProviderRuntime[]
  } {
    return {
      sessionKey,
      harnessId: "hermes",
      cwd: os.tmpdir(),
      selected: { providerId: "user-alpha", modelId: "bento/m-a1" },
      providers: [
        {
          providerId: "user-alpha", name: "alpha", baseUrl: "https://placeholder-a/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "bento/m-a1", name: "A1", reasoning: false }, { id: "bento/m-a2", name: "A2", reasoning: false }],
        },
        {
          providerId: "user-beta", name: "beta", baseUrl: "https://placeholder-b",
          wireProtocol: "openai-chat",
          models: [{ id: "bento/m-b1", name: "B1", reasoning: false }],
        },
      ],
    }
  }

  function routeBaseUrls(configText: string): Map<string, string> {
    const parsed = JSON.parse(configText) as {
      providers: Record<string, { api: string }>
    }
    return new Map(Object.entries(parsed.providers).map(([key, entry]) => [key, entry.api]))
  }

  it("双 mock upstream 经各自 route 命中正确凭证语义;env 只有 HERMES_HOME", async () => {
    const { routing, seenAlpha, seenBeta } = await fixture()
    const adapter = new HermesBentoConfigAdapter(
      "hermes", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-1"))

    expect(Object.keys(lease.env)).toEqual(["HERMES_HOME"])
    expect(lease.env.HERMES_HOME).toContain("hermes-bento-sess-1")
    const configText = fs.readFileSync(path.join(lease.env.HERMES_HOME!, "config.yaml"), "utf8")

    // 注册表三模型;零明文密钥
    expect((configText.match(/"m-a1"|"m-a2"|"m-b1"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(configText).not.toContain("sk-real")

    // 注册表三模型(selected 归一化命中);harnessModelId 为 custom:<alias>:<model> 三段式
    expect(lease.selections.size).toBe(3)
    const betaRef = lease.selections.get(JSON.stringify(["user-beta", "m-b1"]))!
    expect(betaRef.harnessModelId).toBe(`${hermesProviderKey("user-beta")}:m-b1`)

    // α route:chat/completions 直达上游,Bearer 真实 apiKey(proxy 注入)
    const bases = routeBaseUrls(configText)
    await fetch(`${bases.get(hermesProviderKey("user-alpha"))}/chat/completions`, { method: "POST", body: "{}" })
    expect(seenAlpha.url).toBe("/v1/chat/completions")
    expect(seenAlpha.auth).toBe("Bearer sk-real-alpha")

    // β(auth:none + requestPath + fixedHeaders):路径重写、无鉴权值、fixed flag 生效
    await fetch(`${bases.get(hermesProviderKey("user-beta"))}/completions`, { method: "POST", body: "{}" })
    expect(seenBeta.url).toBe("/v1/svc/v1/completions")
    expect(seenBeta.auth).toBeUndefined()
    expect(seenBeta.fixedFlag).toBe("v1")

    // dispose 吊销 routes、目录保留;removeSessionState 删除且幂等
    await lease.dispose()
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
    const home = lease.env.HERMES_HOME!
    expect(fs.existsSync(home)).toBe(true)

    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(home)).toBe(false)
    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(home)).toBe(false)
  })

  it("跨 Provider/换模型 reconfigure live;未知与 native new-session;set_model id 三段式", async () => {
    const { routing } = await fixture()
    const adapter = new HermesBentoConfigAdapter(
      "hermes", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-2"))

    const cross = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "bento/m-b1" })
    expect(cross.mode).toBe("live")
    if (cross.mode === "live") {
      expect(cross.selection.harnessModelId).toBe(`${hermesProviderKey("user-beta")}:m-b1`)
    }

    const switchModel = await adapter.reconfigure(lease, { providerId: "user-alpha", modelId: "bento/m-a2" })
    expect(switchModel.mode).toBe("live")

    const unknown = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "ghost" })
    expect(unknown).toMatchObject({ mode: "new-session" })
    const nativeSel = await adapter.reconfigure(lease, { providerId: "native-hermes", modelId: "x" })
    expect(nativeSel).toMatchObject({ mode: "new-session" })
    await lease.dispose()
  })

  it("prepare 路由解析失败零泄漏:无目录残留、既有会话 routes 不受影响", async () => {
    const { userData, routing } = await fixture()
    const adapter = new HermesBentoConfigAdapter(
      "hermes", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"))),
    )
    const okLease = await adapter.prepare(sessionRequest("sess-ok"))

    const broken = sessionRequest("sess-fail")
    broken.providers = [
      ...broken.providers,
      {
        providerId: "user-ghost", name: "ghost", baseUrl: "https://g.example.com/v1",
        wireProtocol: "openai-chat" as const, models: [{ id: "g1", name: "G1", reasoning: false }],
      },
    ]
    await expect(adapter.prepare(broken)).rejects.toThrow(/供应商不存在/)

    const providersDir = path.join(userData, "providers")
    expect(
      fs.readdirSync(providersDir).filter((name) => name.startsWith("hermes-bento-sess-fail")),
    ).toHaveLength(0)
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    expect(routing.sessionsUsing("user-beta")).toBe(1)
    await okLease.dispose()
    await adapter.removeSessionState("sess-ok")
  })
})
