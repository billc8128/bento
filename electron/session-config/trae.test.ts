import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { parse as parseToml } from "smol-toml"

import type { CustomProviderConfig } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import { buildTraeSessionConfig, traeModelName, TraeBentoConfigAdapter } from "./trae"
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

type TraeModelsEntry = {
  name: string
  open_ai?: { base_url: string; api_key: string; model: string }
  claude?: { base_url: string; api_key: string; model: string }
}

describe("buildTraeSessionConfig", () => {
  it("完整多 Provider 注册表:open_ai/claude section 按 wire 映射,base 补 /v1,占位凭证", () => {
    const toml = buildTraeSessionConfig(
      [
        {
          providerId: "user-alpha", wireProtocol: "openai-chat",
          models: [{ id: "m-a1" }, { id: "bento/m-a2" }],
          baseUrl: "http://127.0.0.1:1/s/t-a",
        },
        {
          providerId: "user-beta", wireProtocol: "anthropic-messages",
          models: [{ id: "m-b1" }],
          baseUrl: "http://127.0.0.1:1/s/t-b",
        },
      ],
      "m-a1",
    )
    const parsed = parseToml(toml) as { model: string; models: TraeModelsEntry[] }
    expect(parsed.model).toBe("m-a1")
    expect(parsed.models).toHaveLength(3)

    const a1 = parsed.models.find((entry) => entry.name === traeModelName("user-alpha", "m-a1"))!
    expect(a1.open_ai).toEqual({
      base_url: "http://127.0.0.1:1/s/t-a/v1",
      api_key: "bento-session-route",
      model: "m-a1",
    })
    // bento/ 前缀归一
    const a2 = parsed.models.find((entry) => entry.name === traeModelName("user-alpha", "bento/m-a2"))!
    expect(a2.open_ai!.model).toBe("m-a2")
    // anthropic wire → claude section
    const b1 = parsed.models.find((entry) => entry.name === traeModelName("user-beta", "m-b1"))!
    expect(b1.claude).toEqual({
      base_url: "http://127.0.0.1:1/s/t-b/v1",
      api_key: "bento-session-route",
      model: "m-b1",
    })
    expect(toml).not.toContain("sk-")
  })

  it("openai-responses wire 不生成 section(不受支持)", () => {
    const toml = buildTraeSessionConfig(
      [
        {
          providerId: "user-r", wireProtocol: "openai-responses",
          models: [{ id: "m-r1" }],
          baseUrl: "http://127.0.0.1:1/s/t-r",
        },
      ],
      "m-r1",
    )
    expect(toml).not.toContain("[[models]]")
  })
})

describe("TraeBentoConfigAdapter", () => {
  /**
   * fixture:α = apiKey openai-chat(Bearer 真实 key);
   * β = apiKey anthropic-messages(x-api-key 真实 key + fixed header)。
   */
  async function fixture(): Promise<{
    userData: string
    routing: ProviderRoutingService
    seenAlpha: SeenRequest
    seenBeta: SeenRequest
  }> {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "trae-fixture-"))
    track(userData)
    const seenAlpha: SeenRequest = {}
    const seenBeta: SeenRequest = {}
    const baseA = await mockUpstream(seenAlpha)
    const baseB = await mockUpstream(seenBeta)
    const store = new CustomProviderStore(userData, memorySecrets())
    const alpha: CustomProviderConfig = {
      id: "user-alpha", name: "alpha", auth: { method: "apiKey" },
      runtimes: {
        trae: {
          baseUrl: baseA, wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "m-a2", name: "A2" }],
        },
      },
    }
    const beta: CustomProviderConfig = {
      id: "user-beta", name: "beta", auth: { method: "apiKey" },
      runtimes: {
        trae: {
          baseUrl: baseB, wireProtocol: "anthropic-messages",
          auth: { inference: { header: "x-api-key", fixedHeaders: { "x-flag": "v1" } } },
          models: [{ id: "m-b1", name: "B1" }],
        },
      },
    }
    store.upsert(alpha, { "*": "sk-real-alpha" })
    store.upsert(beta, { "*": "sk-real-beta" })

    const routing = new ProviderRoutingService(userData, () => store)
    routings.push(routing)
    return { userData, routing, seenAlpha, seenBeta }
  }

  function sessionRequest(sessionKey: string, wireBeta: "anthropic-messages" | "openai-responses" = "anthropic-messages"): {
    sessionKey: string
    harnessId: "trae"
    cwd: string
    selected: { providerId: string; modelId: string }
    providers: SessionProviderRuntime[]
  } {
    return {
      sessionKey,
      harnessId: "trae",
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
          wireProtocol: wireBeta,
          models: [{ id: "m-b1", name: "B1", reasoning: false }],
        },
      ],
    }
  }

  function readModels(lease: SessionConfigLease): TraeModelsEntry[] {
    const configDir = lease.env.TRAE_HOME!
    const toml = fs.readFileSync(path.join(configDir, "traecli.toml"), "utf8")
    return (parseToml(toml) as { model: string; models: TraeModelsEntry[] }).models
  }

  it("env 隔离三件套;注册表三模型;配置零明文密钥;目录权限 0700/0600", async () => {
    const { routing } = await fixture()
    const adapter = new TraeBentoConfigAdapter(
      "trae", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"))),
    )
    const lease = await adapter.prepare(sessionRequest("sess-1"))

    expect(Object.keys(lease.env).sort()).toEqual(["TRAECLI_HOME", "TRAE_ACP_BACKEND", "TRAE_HOME"])
    expect(lease.env.TRAE_ACP_BACKEND).toBe("app-server")
    expect(lease.env.TRAE_HOME).toContain("trae-bento-sess-1")
    expect(lease.env.TRAECLI_HOME).toBe(lease.env.TRAE_HOME)
    expect(lease.strip).toEqual(["TRAE_HOME", "TRAECLI_HOME", "TRAE_ACP_BACKEND"])
    expect(lease.configDir).toBe(lease.env.TRAE_HOME)

    const models = readModels(lease)
    expect(models).toHaveLength(3)
    // 选中的是归一化后的 slug
    expect(lease.selected).toMatchObject({ providerId: "user-alpha", modelId: "m-a1" })
    // harnessModelId = [[models]].name(ACP model configOption 的值)
    expect(lease.selected.harnessModelId).toBe(traeModelName("user-alpha", "m-a1"))

    const configText = fs.readFileSync(path.join(lease.env.TRAE_HOME!, "traecli.toml"), "utf8")
    expect(configText).not.toContain("sk-real")
    const stat = fs.statSync(lease.env.TRAE_HOME!)
    expect(stat.mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(lease.env.TRAE_HOME!, "traecli.toml")).mode & 0o777).toBe(0o600)
    await lease.dispose()
    await adapter.removeSessionState("sess-1")
  })

  it("真实代理路由:chat→Bearer 注入,anthropic→x-api-key+fixed header;路径形状 /v1/*", async () => {
    const { seenAlpha, seenBeta } = await fixture()
    const adapter = new TraeBentoConfigAdapter(
      "trae", routings[0]!,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"))),
    )
    const lease = await adapter.prepare(sessionRequest("sess-2"))
    const models = readModels(lease)

    // α(openai-chat):traecli 请求 {base_url}/chat/completions;base 已带 /v1
    const a1 = models.find((entry) => entry.name === traeModelName("user-alpha", "m-a1"))!
    await fetch(`${a1.open_ai!.base_url}/chat/completions`, { method: "POST", body: "{}" })
    expect(seenAlpha.url).toBe("/v1/chat/completions")
    expect(seenAlpha.auth).toBe("Bearer sk-real-alpha")

    // β(anthropic-messages):traecli 请求 {base_url}/messages;上游收 /v1/messages
    const b1 = models.find((entry) => entry.name === traeModelName("user-beta", "m-b1"))!
    await fetch(`${b1.claude!.base_url}/messages`, { method: "POST", body: "{}" })
    expect(seenBeta.url).toBe("/v1/messages")
    expect(seenBeta.apiKeyHeader).toBe("sk-real-beta")
    expect(seenBeta.fixedFlag).toBe("v1")

    // dispose 只吊销 routes,目录保留供 resume
    await lease.dispose()
    expect(routings[0]!.sessionsUsing("user-alpha")).toBe(0)
    expect(routings[0]!.sessionsUsing("user-beta")).toBe(0)
    expect(fs.existsSync(lease.env.TRAE_HOME!)).toBe(true)
    await fetch(`${a1.open_ai!.base_url}/chat/completions`, { method: "POST", body: "{}" }).then(
      (res) => res.json(),
    )
    // 吊销后再打 route:上游不应再被命中(seenAlpha.url 保持 dispose 前的值)
    expect(seenAlpha.url).toBe("/v1/chat/completions")
    await adapter.removeSessionState("sess-2")
    expect(fs.existsSync(lease.env.TRAE_HOME!)).toBe(false)
    // 幂等
    await adapter.removeSessionState("sess-2")
    expect(fs.existsSync(lease.env.TRAE_HOME!)).toBe(false)
  })

  it("跨 Provider/换模型 reconfigure live;注册表外 new-session;responses wire prepare 拒绝", async () => {
    const { routing } = await fixture()
    const adapter = new TraeBentoConfigAdapter(
      "trae", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"))),
    )
    const lease = await adapter.prepare(sessionRequest("sess-3"))

    const cross = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "m-b1" })
    expect(cross.mode).toBe("live")
    if (cross.mode === "live") {
      expect(cross.selection.harnessModelId).toBe(traeModelName("user-beta", "m-b1"))
    }
    const sameProvider = await adapter.reconfigure(lease, { providerId: "user-alpha", modelId: "bento/m-a2" })
    expect(sameProvider.mode).toBe("live")
    const unknown = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "ghost" })
    expect(unknown).toMatchObject({ mode: "new-session" })
    await lease.dispose()

    // openai-responses provider:如实拒绝,不静默降级
    const broken = sessionRequest("sess-resp", "openai-responses")
    await expect(adapter.prepare(broken)).rejects.toThrow(/不受 Trae 支持/)
    await adapter.removeSessionState("sess-3")
  })

  it("selected 不在注册表:吊销 route 并抛错;名字冲突:抛错", async () => {
    const { routing } = await fixture()
    const adapter = new TraeBentoConfigAdapter(
      "trae", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"))),
    )
    const missing = sessionRequest("sess-missing")
    missing.selected = { providerId: "user-alpha", modelId: "ghost" }
    await expect(adapter.prepare(missing)).rejects.toThrow(/不在 Bento 注册表/)
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    await adapter.removeSessionState("sess-missing")

    // 名字冲突:同 provider 两个模型归一后同名(bento/ 前缀剥离后一致)
    const collide = sessionRequest("sess-collide")
    collide.providers = [
      {
        providerId: "user-alpha", name: "alpha", baseUrl: "https://placeholder-a/v1",
        wireProtocol: "openai-chat",
        models: [
          { id: "m-a1", name: "A1", reasoning: false },
          { id: "bento/m-a1", name: "A1 dup", reasoning: false },
        ],
      },
    ]
    await expect(adapter.prepare(collide)).rejects.toThrow(/冲突/)
    await adapter.removeSessionState("sess-collide")
  })
})
