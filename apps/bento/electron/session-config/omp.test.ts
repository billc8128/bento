import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../providers/custom-providers"
import { ProviderRoutingService } from "../providers/provider-routing"
import { buildOmpModelsYml, normalizeBentoModelId, OmpBentoConfigAdapter } from "./omp"
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

type SeenRequest = { url?: string; auth?: string; fixedFlag?: string }

async function mockUpstream(seen: SeenRequest): Promise<string> {
  const server = http.createServer((req, res) => {
    seen.url = req.url
    seen.auth = req.headers.authorization as string | undefined
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

describe("buildOmpModelsYml", () => {
  it("providers 根映射 + 每 alias baseUrl/api/apiKey/models;api 按 wireProtocol 派生", () => {
    const yml = buildOmpModelsYml([
      {
        providerId: "user-alpha", name: "Alpha", baseUrl: "http://127.0.0.1:1/s/t-a", alias: "bento-a",
        wireProtocol: "openai-chat",
        models: [{ id: "m-a1", name: "A1" }, { id: "bento/m-a2", name: "A2" }],
      },
      {
        providerId: "user-beta", name: "Beta", baseUrl: "http://127.0.0.1:1/s/t-b", alias: "bento-b",
        wireProtocol: "anthropic-messages",
        models: [{ id: "m-b1", name: "B1" }],
      },
    ])
    expect(yml.startsWith("providers:\n")).toBe(true)
    expect(yml).toContain("  bento-a:")
    expect(yml).toContain("  bento-b:")
    expect(yml).toContain(`baseUrl: ${JSON.stringify("http://127.0.0.1:1/s/t-a")}`)
    // openai-chat → openai-completions;anthropic-messages 原样
    expect(yml).toContain(`api: ${JSON.stringify("openai-completions")}`)
    expect(yml).toContain(`api: ${JSON.stringify("anthropic-messages")}`)
    // 占位凭证;三个模型全部登记且 bento/ 前缀归一化
    expect(yml).toContain(`apiKey: ${JSON.stringify("bento-session-route")}`)
    expect(yml.match(/- \{ id:/g)).toHaveLength(3)
    expect(yml).toContain('- { id: "m-a2"')
  })

  it("normalizeBentoModelId 剥离发布前缀", () => {
    expect(normalizeBentoModelId("bento/m1")).toBe("m1")
    expect(normalizeBentoModelId("m1")).toBe("m1")
  })
})

describe("OmpBentoConfigAdapter", () => {
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
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fixture-"))
    track(userData)
    const seenAlpha: SeenRequest = {}
    const seenBeta: SeenRequest = {}
    const baseA = await mockUpstream(seenAlpha)
    const baseB = await mockUpstream(seenBeta)
    const store = new CustomProviderStore(userData, memorySecrets())
    const alpha: CustomProviderConfig = {
      id: "user-alpha", name: "alpha", auth: { method: "apiKey" },
      runtimes: {
        omp: {
          baseUrl: `${baseA}/v1`, wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "m-a2", name: "A2" }],
        },
      },
    }
    const beta: CustomProviderConfig = {
      id: "user-beta", name: "beta", auth: { method: "none" },
      runtimes: {
        omp: {
          baseUrl: baseB,
          wireProtocol: "openai-chat",
          requestPath: "/svc/v1/completions",
          auth: { inference: { header: "x-flag-unused", fixedHeaders: { "x-flag": "v1" } } },
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
    harnessId: "omp"
    cwd: string
    selected: { providerId: string; modelId: string }
    providers: SessionProviderRuntime[]
  } {
    return {
      sessionKey,
      harnessId: "omp",
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

  function ymlBaseUrls(yml: string): Map<string, string> {
    return new Map(
      [...yml.matchAll(/^  (bento-[0-9a-z]+):\n[\s\S]*?baseUrl: ("[^"]+")/gm)]
        .map((match) => [match[1], JSON.parse(match[2]) as string] as const),
    )
  }

  it("双 mock upstream 经各自 route 命中正确凭证语义;env 只有 PI_CODING_AGENT_DIR", async () => {
    const { routing, seenAlpha, seenBeta } = await fixture()
    const adapter = new OmpBentoConfigAdapter(
      "omp", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-1"))

    // 隔离:PI_CODING_AGENT_DIR + 根目录 models.yml(spike 约定),非 OMP_HOME
    expect(Object.keys(lease.env)).toEqual(["PI_CODING_AGENT_DIR"])
    expect(lease.env.PI_CODING_AGENT_DIR).toContain("omp-bento-sess-1")
    const ymlPath = path.join(lease.env.PI_CODING_AGENT_DIR!, "models.yml")
    const yml = fs.readFileSync(ymlPath, "utf8")
    expect(yml).not.toContain("sk-real")

    // 注册表三模型(wire id = alias/裸模型名);selected 归一化 key 命中
    expect(lease.selections.size).toBe(3)
    const alphaRef = lease.selections.get(JSON.stringify(["user-alpha", "m-a1"]))!
    expect(alphaRef.harnessModelId).toBe(`${stableProviderAlias("user-alpha")}/m-a1`)

    // α 的 route → Bearer 真实 apiKey(proxy 注入);β → requestPath 重写 + fixed flag、无鉴权值
    const bases = ymlBaseUrls(yml)
    await fetch(`${bases.get(stableProviderAlias("user-alpha"))}/chat/completions`, { method: "POST", body: "{}" })
    expect(seenAlpha.url).toBe("/v1/chat/completions")
    expect(seenAlpha.auth).toBe("Bearer sk-real-alpha")

    await fetch(`${bases.get(stableProviderAlias("user-beta"))}/completions`, { method: "POST", body: "{}" })
    expect(seenBeta.url).toBe("/svc/v1/completions")
    expect(seenBeta.auth).toBeUndefined()
    expect(seenBeta.fixedFlag).toBe("v1")

    // dispose 吊销 routes、目录保留;removeSessionState 删除且幂等
    await lease.dispose()
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
    expect(fs.existsSync(lease.env.PI_CODING_AGENT_DIR!)).toBe(true)

    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(lease.env.PI_CODING_AGENT_DIR!)).toBe(false)
    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(lease.env.PI_CODING_AGENT_DIR!)).toBe(false)
  })

  it("跨 Provider/换模型 reconfigure live;未知与 native new-session;bento/ 归一化", async () => {
    const { routing } = await fixture()
    const adapter = new OmpBentoConfigAdapter(
      "omp", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-2"))

    const cross = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "bento/m-b1" })
    expect(cross.mode).toBe("live")
    if (cross.mode === "live") expect(cross.selection.harnessModelId).toMatch(/^bento-[0-9a-z]+\/m-b1$/)

    const switchModel = await adapter.reconfigure(lease, { providerId: "user-alpha", modelId: "bento/m-a2" })
    expect(switchModel.mode).toBe("live")

    const unknown = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "ghost" })
    expect(unknown).toMatchObject({ mode: "new-session" })
    const nativeSel = await adapter.reconfigure(lease, { providerId: "native-omp", modelId: "x" })
    expect(nativeSel).toMatchObject({ mode: "new-session" })
    await lease.dispose()
  })

  it("prepare 路由解析失败零泄漏", async () => {
    const { userData, routing } = await fixture()
    const adapter = new OmpBentoConfigAdapter(
      "omp", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-"))),
    )
    const okLease = await adapter.prepare(sessionRequest("sess-ok"))

    const broken = sessionRequest("sess-fail")
    broken.providers = [
      ...broken.providers,
      { providerId: "user-ghost", name: "ghost", baseUrl: "https://g.example.com/v1", wireProtocol: "openai-chat" as const, models: [{ id: "g1", name: "G1", reasoning: false }] },
    ]
    await expect(adapter.prepare(broken)).rejects.toThrow(/供应商不存在/)

    const providersDir = path.join(userData, "providers")
    expect(fs.readdirSync(providersDir).filter((name) => name.startsWith("omp-bento-sess-fail")))
      .toHaveLength(0)
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    expect(routing.sessionsUsing("user-beta")).toBe(1)
    await okLease.dispose()
    await adapter.removeSessionState("sess-ok")
  })

  it("Skills 投递:curated 内容复制进 PI_CODING_AGENT_DIR/skills;关闭时不复制", async () => {
    const { routing } = await fixture()
    const adapter = new OmpBentoConfigAdapter(
      "omp", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "omp-skills-"))),
    )
    const curated = track(fs.mkdtempSync(path.join(os.tmpdir(), "omp-curated-")))
    fs.mkdirSync(path.join(curated, "skills/my-skill"), { recursive: true })
    fs.writeFileSync(path.join(curated, "skills/my-skill/SKILL.md"), "---\nname: my-skill\n---\n")

    const on = await adapter.prepare({
      ...sessionRequest("sess-sk-1"),
      skills: { curatedRoot: curated, projectSkillDirs: [] },
    } as Parameters<typeof adapter.prepare>[0])
    expect(
      fs.readFileSync(path.join(on.env.PI_CODING_AGENT_DIR!, "skills/my-skill/SKILL.md"), "utf8"),
    ).toContain("name: my-skill")
    await on.dispose()
    await adapter.removeSessionState("sess-sk-1")

    const off = await adapter.prepare({
      ...sessionRequest("sess-sk-2"),
      skills: { projectSkillDirs: [] },
    } as Parameters<typeof adapter.prepare>[0])
    expect(fs.existsSync(path.join(off.env.PI_CODING_AGENT_DIR!, "skills"))).toBe(false)
    await off.dispose()
    await adapter.removeSessionState("sess-sk-2")
  })
})
