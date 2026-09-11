import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import {
  buildOpenCodeSessionConfig,
  normalizeBentoModelId,
  OpenCodeBentoConfigAdapter,
} from "./opencode"
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

describe("buildOpenCodeSessionConfig", () => {
  it("全部 Provider/模型写入;baseURL 即传入 route;apiKey 只引用 env 名;bento/ 前缀归一化", () => {
    const config = buildOpenCodeSessionConfig(
      [
        {
          providerId: "user-alpha", name: "Alpha", baseUrl: "http://127.0.0.1:1/s/t-a",
          wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "m-a2", name: "A2" }],
        },
        {
          providerId: "user-beta", name: "Beta", baseUrl: "http://127.0.0.1:1/s/t-b",
          wireProtocol: "anthropic-messages",
          models: [{ id: "bento/m-b1", name: "B1" }],
        },
      ],
      { providerId: "user-alpha", modelId: "m-a1", harnessModelId: "bento-x/m-a1" },
    )
    const parsed = JSON.parse(config) as {
      model: string
      provider: Record<string, { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }>
    }
    expect(Object.keys(parsed.provider)).toHaveLength(2)
    const totalModels = Object.values(parsed.provider)
      .reduce((sum, provider) => sum + Object.keys(provider.models).length, 0)
    expect(totalModels).toBe(3)
    expect(config).not.toContain("sk-")
    expect(parsed.provider[stableProviderAlias("user-alpha")]!.options.baseURL).toBe("http://127.0.0.1:1/s/t-a")
    expect(parsed.provider[stableProviderAlias("user-beta")]!.options.baseURL).toBe("http://127.0.0.1:1/s/t-b")
    // bento/ 前缀在配置里归一化
    expect(Object.keys(parsed.provider[stableProviderAlias("user-beta")]!.models)).toEqual(["m-b1"])
    expect(parsed.model).toBe(`${stableProviderAlias("user-alpha")}/m-a1`)
    expect(config).toContain("@ai-sdk/anthropic")
    expect(config).toContain("@ai-sdk/openai-compatible")
  })

  it("skillsPaths 写入 skills.paths 对象;空数组不写 skills 键", () => {
    const base = {
      providerId: "user-a",
      modelId: "m-a1",
      harnessModelId: "bento-a/m-a1",
    } as const
    const withSkills = JSON.parse(buildOpenCodeSessionConfig([], base, ["/curated/skills"])) as {
      skills?: { paths?: string[] }
    }
    expect(withSkills.skills).toEqual({ paths: ["/curated/skills"] })
    const withoutSkills = JSON.parse(buildOpenCodeSessionConfig([], base)) as {
      skills?: { paths?: string[] }
    }
    expect(withoutSkills.skills).toBeUndefined()
  })

  it("normalizeBentoModelId 剥离发布前缀", () => {
    expect(normalizeBentoModelId("bento/m1")).toBe("m1")
    expect(normalizeBentoModelId("m1")).toBe("m1")
  })
})

describe("OpenCodeBentoConfigAdapter", () => {
  /**
   * fixture:α=apiKey openai-chat(Bearer 真实 key);
   * β=auth:none anthropic-messages + requestPath + fixedHeaders(无鉴权值,fixed 头生效)。
   */
  async function fixture(): Promise<{
    userData: string
    routing: ProviderRoutingService
    seenAlpha: SeenRequest
    seenBeta: SeenRequest
  }> {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fixture-"))
    track(userData)
    const seenAlpha: SeenRequest = {}
    const seenBeta: SeenRequest = {}
    const baseA = await mockUpstream(seenAlpha)
    const baseB = await mockUpstream(seenBeta)
    const store = new CustomProviderStore(userData, memorySecrets())
    const alpha: CustomProviderConfig = {
      id: "user-alpha", name: "alpha", auth: { method: "apiKey" },
      runtimes: {
        opencode: {
          baseUrl: `${baseA}/v1`, wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1" }, { id: "m-a2", name: "A2" }],
        },
      },
    }
    const beta: CustomProviderConfig = {
      id: "user-beta", name: "beta", auth: { method: "none" },
      runtimes: {
        opencode: {
          baseUrl: baseB,
          wireProtocol: "anthropic-messages",
          requestPath: "/svc/v1/messages",
          auth: { inference: { header: "x-api-key", fixedHeaders: { "x-flag": "v1" } } },
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
    harnessId: "opencode"
    cwd: string
    selected: { providerId: string; modelId: string }
    providers: SessionProviderRuntime[]
  } {
    return {
      sessionKey,
      harnessId: "opencode",
      cwd: os.tmpdir(),
      selected: { providerId: "user-alpha", modelId: "bento/m-a1" },
      providers: [
        {
          providerId: "user-alpha", name: "alpha", baseUrl: "https://placeholder-a/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "m-a1", name: "A1", reasoning: false }, { id: "m-a2", name: "A2", reasoning: false }],
        },
        {
          providerId: "user-beta", name: "beta", baseUrl: "https://placeholder-b",
          wireProtocol: "anthropic-messages",
          models: [{ id: "bento/m-b1", name: "B1", reasoning: false }],
        },
      ],
    }
  }

  function baseUrlsByProvider(configText: string): Map<string, string> {
    const parsed = JSON.parse(configText) as {
      provider: Record<string, { options: { baseURL: string } }>
    }
    return new Map(Object.entries(parsed.provider).map(([alias, entry]) => [alias, entry.options.baseURL]))
  }

  it("双 mock upstream 命中正确凭证语义:α Bearer key;β auth:none 无鉴权值但 fixedHeaders 生效", async () => {
    const { routing, seenAlpha, seenBeta } = await fixture()
    const adapter = new OpenCodeBentoConfigAdapter(
      "opencode", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-1"))
    const configText = fs.readFileSync(lease.env.OPENCODE_CONFIG!, "utf8")

    // 注册表三模型;零明文密钥
    const totalModels = (configText.match(/"(m-a1|m-a2|m-b1)":/g) ?? []).length
    expect(totalModels).toBe(3)
    expect(configText).not.toContain("sk-real")

    // env 全是无权限占位符(真实凭证由 proxy 按 token 注入)
    const keyEnvs = Object.entries(lease.env).filter(([name]) => name.startsWith("BENTO_PROVIDER_KEY_"))
    expect(keyEnvs).toHaveLength(2)
    expect(keyEnvs.every(([, value]) => value === "bento-session-route")).toBe(true)

    // α 的 route:/chat/completions 直达上游,Bearer 真实 apiKey(proxy 注入)
    const bases = baseUrlsByProvider(configText)
    await fetch(`${bases.get(stableProviderAlias("user-alpha"))}/chat/completions`, {
      method: "POST", body: "{}",
    })
    expect(seenAlpha.url).toBe("/v1/chat/completions")
    expect(seenAlpha.auth).toBe("Bearer sk-real-alpha")

    // β 的 route(auth:none + requestPath + fixedHeaders):
    // 重写到 requestPath;不注入鉴权值;x-flag 固定头仍然生效
    await fetch(`${bases.get(stableProviderAlias("user-beta"))}/messages`, {
      method: "POST", body: "{}",
    })
    expect(seenBeta.url).toBe("/svc/v1/messages")
    expect(seenBeta.auth).toBeUndefined()
    expect(seenBeta.apiKeyHeader).toBeUndefined()
    expect(seenBeta.fixedFlag).toBe("v1")

    // dispose:routes 吊销、目录保留(resume 复用);removeSessionState 彻底删除
    await lease.dispose()
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
    const home = path.dirname(lease.env.OPENCODE_CONFIG!)
    expect(fs.existsSync(home)).toBe(true)

    await adapter.removeSessionState("sess-1")
    expect(fs.existsSync(home)).toBe(false)
  })

  it("跨 Provider/换模型 reconfigure live;未知与 native new-session", async () => {
    const { routing } = await fixture()
    const adapter = new OpenCodeBentoConfigAdapter(
      "opencode", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-"))),
    )
    const lease: SessionConfigLease = await adapter.prepare(sessionRequest("sess-2"))

    const cross = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "bento/m-b1" })
    expect(cross.mode).toBe("live")
    if (cross.mode === "live") expect(cross.selection.harnessModelId).toMatch(/^bento-[0-9a-z]+\/m-b1$/)

    const sameModelSwitch = await adapter.reconfigure(lease, { providerId: "user-alpha", modelId: "bento/m-a2" })
    expect(sameModelSwitch.mode).toBe("live")

    const unknown = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "ghost" })
    expect(unknown).toMatchObject({ mode: "new-session" })
    const native = await adapter.reconfigure(lease, { providerId: "native-opencode", modelId: "x" })
    expect(native).toMatchObject({ mode: "new-session" })
    await lease.dispose()
  })

  it("prepare 路由解析失败零泄漏:无目录残留、既有会话 routes 不受影响", async () => {
    const { userData, routing } = await fixture()
    const adapter = new OpenCodeBentoConfigAdapter(
      "opencode", routing,
      track(fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-"))),
    )
    const okLease = await adapter.prepare(sessionRequest("sess-ok"))

    // 幽灵 provider 使 issueRouteSet 事务失败
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
      fs.readdirSync(providersDir).filter((name) => name.startsWith("opencode-bento-sess-fail")),
    ).toHaveLength(0)
    // 健康会话不受影响
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    expect(routing.sessionsUsing("user-beta")).toBe(1)
    await okLease.dispose()
    await adapter.removeSessionState("sess-ok")
  })

  it("Skills 投递:skills.paths 指向 curated 根;主开关关闭不写 paths;两种情况都注入外部扫描禁用 env", async () => {
    const { routing } = await fixture()
    const adapter = new OpenCodeBentoConfigAdapter("opencode", routing, track(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-skills-"))))
    const curated = track(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-curated-")))

    const enabled = await adapter.prepare({
      ...sessionRequest("sess-sk-1"),
      skills: { curatedRoot: curated, projectSkillDirs: [] },
    } as Parameters<typeof adapter.prepare>[0])
    const enabledConfig = JSON.parse(fs.readFileSync(enabled.env.OPENCODE_CONFIG!, "utf8")) as {
      skills?: { paths: string[] }
    }
    expect(enabledConfig.skills).toEqual({ paths: [path.join(curated, "skills")] })
    expect(enabled.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1")
    await enabled.dispose()
    await adapter.removeSessionState("sess-sk-1")

    const disabled = await adapter.prepare({
      ...sessionRequest("sess-sk-2"),
      skills: { projectSkillDirs: [] },
    } as Parameters<typeof adapter.prepare>[0])
    const disabledConfig = JSON.parse(fs.readFileSync(disabled.env.OPENCODE_CONFIG!, "utf8")) as {
      skills?: { paths: string[] }
    }
    expect(disabledConfig.skills).toBeUndefined()
    expect(disabled.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1")
    await disabled.dispose()
    await adapter.removeSessionState("sess-sk-2")
  })
})
