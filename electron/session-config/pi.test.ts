import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import { buildPiModelsJson, normalizeBentoModelId, PiBentoConfigAdapter } from "./pi"
import type { SessionConfigLease, SessionProviderRuntime } from "./types"
import { stableProviderAlias } from "./alias"

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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

describe("buildPiModelsJson", () => {
  it("providers 根映射 + reasoning/contextWindow 保留 + bento/ 前缀归一化 + 占位 key", () => {
    const json = buildPiModelsJson([
      {
        providerId: "user-alpha", name: "Alpha", baseUrl: "http://127.0.0.1:1/s/t-a", alias: "bento-a",
        wireProtocol: "openai-chat",
        models: [
          { id: "bento/m-a1", name: "A1", reasoning: true },
          { id: "bento/m-a2", name: "A2", reasoning: false, contextWindow: 262144 },
        ],
      },
      {
        providerId: "user-beta", name: "Beta", baseUrl: "http://127.0.0.1:1/s/t-b", alias: "bento-b",
        wireProtocol: "anthropic-messages",
        models: [{ id: "m-b1", name: "B1", reasoning: false }],
      },
    ])
    expect(json.startsWith('{\n  "providers"')).toBe(true)
    expect(json).toContain('"apiKey": "bento-session-route"')
    // openai-chat → openai-completions;anthropic-messages 原样
    expect(json).toContain('"api": "openai-completions"')
    expect(json).toContain('"api": "anthropic-messages"')
    // Pi 支持字段保留;bento/ 归一化
    expect(json).toContain('"reasoning": true')
    expect(json).toContain('"contextWindow": 262144')
    expect(json.match(/"id": "(m-\w+)"/g)).toEqual([
      '"id": "m-a1"', '"id": "m-a2"', '"id": "m-b1"',
    ])
    expect(json).not.toContain("sk-")
  })

  it("normalizeBentoModelId 剥离发布前缀", () => {
    expect(normalizeBentoModelId("bento/m1")).toBe("m1")
    expect(normalizeBentoModelId("m1")).toBe("m1")
  })
})

describe("PiBentoConfigAdapter", () => {
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
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fixture-"))
    track(userData)
    const seenAlpha: SeenRequest = {}
    const seenBeta: SeenRequest = {}
    const baseA = await mockUpstream(seenAlpha)
    const baseB = await mockUpstream(seenBeta)
    const store = new CustomProviderStore(userData, memorySecrets())
    const alpha: CustomProviderConfig = {
      id: "user-alpha", name: "alpha", auth: { method: "apiKey" },
      runtimes: {
        pi: {
          baseUrl: `${baseA}/v1`, wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "m-a2", name: "A2" }],
        },
      },
    }
    const beta: CustomProviderConfig = {
      id: "user-beta", name: "beta", auth: { method: "none" },
      runtimes: {
        pi: {
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
    harnessId: "pi"
    cwd: string
    mode: "bento"
    selected: { providerId: string; modelId: string }
    providers: SessionProviderRuntime[]
  } {
    return {
      sessionKey,
      harnessId: "pi",
      cwd: os.tmpdir(),
      mode: "bento",
      selected: { providerId: "user-alpha", modelId: "bento/m-a1" },
      providers: [
        {
          providerId: "user-alpha", name: "alpha", baseUrl: "https://placeholder-a/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "bento/m-a1", name: "A1", reasoning: false }, { id: "bento/m-a2", name: "A2", reasoning: false, contextWindow: 262144 }],
        },
        {
          providerId: "user-beta", name: "beta", baseUrl: "https://placeholder-b",
          wireProtocol: "openai-chat",
          models: [{ id: "bento/m-b1", name: "B1", reasoning: false }],
        },
      ],
    }
  }

  function jsonBaseUrls(json: string): Map<string, string> {
    const parsed = JSON.parse(json) as {
      providers: Record<string, { baseUrl: string }>
    }
    return new Map(Object.entries(parsed.providers).map(([alias, entry]) => [alias, entry.baseUrl]))
  }

  it("双 mock upstream 命中正确凭证语义:α Bearer 真实 key;β requestPath 重写 + fixed 头无鉴权值", async () => {
    const { routing, seenAlpha, seenBeta } = await fixture()
    const adapter = new PiBentoConfigAdapter(
      "pi", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-1"))
    const jsonText = fs.readFileSync(lease.env.OPENCODE_CONFIG ?? path.join(lease.env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")

    // env 只有 PI_CODING_AGENT_DIR;注册表三模型;零明文密钥
    expect(Object.keys(lease.env)).toEqual(["PI_CODING_AGENT_DIR"])
    expect(lease.env.PI_CODING_AGENT_DIR).toContain("pi-bento-sess-1")
    const totalModels = (jsonText.match(/"id": "/g) ?? []).length
    expect(totalModels).toBe(3)
    expect(jsonText).not.toContain("sk-real")
    expect(lease.selections.size).toBe(3)

    // α 的 route:/chat/completions 直达上游,Bearer 真实 apiKey(proxy 注入)
    const bases = jsonBaseUrls(jsonText)
    await fetch(`${bases.get(stableProviderAlias("user-alpha"))}/chat/completions`, {
      method: "POST", body: "{}",
    })
    expect(seenAlpha.url).toBe("/v1/chat/completions")
    expect(seenAlpha.auth).toBe("Bearer sk-real-alpha")

    // β 的 route(auth:none + requestPath + fixedHeaders):重写路径、无鉴权值、fixed flag 在
    await fetch(`${bases.get(stableProviderAlias("user-beta"))}/completions`, {
      method: "POST", body: "{}",
    })
    expect(seenBeta.url).toBe("/svc/v1/completions")
    expect(seenBeta.auth).toBeUndefined()
    expect(seenBeta.fixedFlag).toBe("v1")

    // dispose 吊销 routes、目录保留;removeSessionState 删除且幂等
    await lease.dispose()
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
    const home = lease.env.PI_CODING_AGENT_DIR!
    expect(fs.existsSync(home)).toBe(true)

    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(home)).toBe(false)
    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(home)).toBe(false)
  })

  it("跨 Provider/换模型 reconfigure live;未知与 native new-session;harnessModelId 为 alias/model", async () => {
    const { routing } = await fixture()
    const adapter = new PiBentoConfigAdapter(
      "pi", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-2"))

    const cross = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "bento/m-b1" })
    expect(cross.mode).toBe("live")
    if (cross.mode === "live") expect(cross.selection.harnessModelId).toMatch(/^bento-[0-9a-z]+\/m-b1$/)

    const switchModel = await adapter.reconfigure(lease, { providerId: "user-alpha", modelId: "bento/m-a2" })
    expect(switchModel.mode).toBe("live")

    const unknown = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "ghost" })
    expect(unknown).toMatchObject({ mode: "new-session" })
    const nativeSel = await adapter.reconfigure(lease, { providerId: "native-pi", modelId: "x" })
    expect(nativeSel).toMatchObject({ mode: "new-session", reason: expect.stringContaining("native↔Bento") })
    await lease.dispose()
  })

  it("prepare 路由解析失败零泄漏:无目录残留、既有会话 routes 不受影响", async () => {
    const { userData, routing } = await fixture()
    const adapter = new PiBentoConfigAdapter(
      "pi", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"))),
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
      fs.readdirSync(providersDir).filter((name) => name.startsWith("pi-bento-sess-fail")),
    ).toHaveLength(0)
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    expect(routing.sessionsUsing("user-beta")).toBe(1)
    await okLease.dispose()
    await adapter.removeSessionState("sess-ok")
  })
})
