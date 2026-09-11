import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig, ProviderModel } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import { KimiBentoConfigAdapter, buildKimiSessionConfig } from "./kimi"
import { selectionKey, type SessionConfigLease, type SessionConfigRequest } from "./types"

let tempDirs: string[] = []
let upstreams: http.Server[] = []
let routings: ProviderRoutingService[] = []

afterEach(async () => {
  for (const routing of routings.splice(0)) routing.dispose()
  await Promise.all(upstreams.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

function track<T extends string>(dir: T): T {
  tempDirs.push(dir)
  return dir
}

async function mockUpstream(): Promise<{ baseUrl: string; lastAuth: () => string }> {
  let lastAuth = ""
  const server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization ?? ""
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  })
  upstreams.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, lastAuth: () => lastAuth }
}

function kimiUserConfig(id: string, baseUrl: string, models: ProviderModel[]): CustomProviderConfig {
  return {
    id,
    name: id,
    auth: { method: "apiKey" },
    runtimes: {
      kimi: {
        baseUrl,
        wireProtocol: "openai-chat",
        models: models.map((model) => ({ id: model.id, name: model.name })),
      },
    },
  }
}

type AdapterProvider = {
  providerId: string
  name: string
  baseUrl: string
  wireProtocol: "openai-chat" | "openai-responses" | "anthropic-messages"
  models: ProviderModel[]
}

async function fixture(providers: Array<{ id: string; key: string; models: ProviderModel[] }>) {
  const userData = track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-adapter-")))
  const store = new CustomProviderStore(userData, memorySecrets())
  const upstreams = []
  for (const { id, key, models } of providers) {
    const upstream = await mockUpstream()
    upstreams.push(upstream)
    store.upsert(kimiUserConfig(id, upstream.baseUrl, models), { "*": key })
  }
  const routing = new ProviderRoutingService(userData, () => store)
  routings.push(routing)
  const adapterProviders: AdapterProvider[] = providers.map(({ id, models }, index) => ({
    providerId: id,
    name: id,
    baseUrl: upstreams[index]!.baseUrl,
    wireProtocol: "openai-chat" as const,
    models,
  }))
  return { userData, store, routing, adapterProviders, upstreams }
}

function bentoRequest(sessionKey: string, providers: AdapterProvider[], overrides: Partial<SessionConfigRequest> = {}): SessionConfigRequest {
  return {
    sessionKey,
    harnessId: "kimi",
    cwd: os.tmpdir(),
    selected: { providerId: providers[0]!.providerId, modelId: providers[0]!.models[0]!.id },
    providers,
    ...overrides,
  }
}

describe("buildKimiSessionConfig", () => {
  it("写入全部 Provider/模型,type 映射正确,capabilities 按 reasoning 组合", () => {
    const config = buildKimiSessionConfig(
      [
        {
          alias: "bento-a",
          name: "A",
          baseUrl: "http://127.0.0.1:1/s/t-a",
          wireProtocol: "openai-chat",
          models: [
            { id: "m-a1", name: "A1", reasoning: true },
            { id: "m-a2", name: "A2", reasoning: false, contextWindow: 262144 },
          ],
        },
        {
          alias: "bento-b",
          name: "B",
          baseUrl: "http://127.0.0.1:1/s/t-b",
          wireProtocol: "anthropic-messages",
          models: [{ id: "m-b1", name: "B1", reasoning: false }],
        },
      ],
      { providerId: "user-a", modelId: "m-a1", harnessModelId: "bento-a/m-a1" },
    )
    expect(config).toContain('default_model = "bento-a/m-a1"')
    expect(config).toContain('[providers."bento-a"]')
    expect(config).toContain('type = "openai"')
    expect(config).toContain('[providers."bento-b"]')
    expect(config).toContain('type = "anthropic"')
    expect(config).toContain('[models."bento-a/m-a1"]')
    expect(config).toContain('[models."bento-a/m-a2"]')
    expect(config).toContain('max_context_size = 262144')
    expect(config).toContain('[models."bento-b/m-b1"]')
    expect(config.match(/max_context_size = \d+/g)).toHaveLength(3)
    // capabilities:恒 tool_use;reasoning 模型加 thinking
    expect(config.match(/capabilities = \[ "tool_use" \]/g)).toHaveLength(2)
    expect(config.match(/capabilities = \[ "thinking", "tool_use" \]/g)).toHaveLength(1)
    // 占位凭证,不是任何真实密钥
    expect(config).not.toContain("sk-")
    expect(config.match(/api_key = "[^"]*"/g)).toEqual([
      'api_key = "bento-session-route"',
      'api_key = "bento-session-route"',
    ])
  })

  it("v1 布局(kimi ≥1.x):type 改 openai_legacy,capabilities 不含 tool_use,恒带 image_in", () => {
    const config = buildKimiSessionConfig(
      [
        {
          alias: "bento-a",
          name: "A",
          baseUrl: "http://127.0.0.1:1/s/t-a",
          wireProtocol: "openai-chat",
          models: [
            { id: "m-a1", name: "A1", reasoning: true },
            { id: "m-a2", name: "A2", reasoning: false },
          ],
        },
      ],
      { providerId: "user-a", modelId: "m-a1", harnessModelId: "bento-a/m-a1" },
      "v1",
    )
    expect(config).toContain('type = "openai_legacy"')
    expect(config).not.toContain("tool_use")
    // image_in 是 kimi 1.x 的本地带图准入门槛,恒声明;能否看图由上游裁决
    expect(config.match(/capabilities = \[ "thinking", "image_in" \]/g)).toHaveLength(1)
    expect(config.match(/capabilities = \[ "image_in" \]/g)).toHaveLength(1)
  })
})

describe("KimiBentoConfigAdapter", () => {
  it("两个 Provider 三模型全写入,route 按 provider 别名确定性命中正确上游与密钥", async () => {
    const models = (suffix: string): ProviderModel[] => [
      { id: `m-${suffix}1`, name: `${suffix}1`, reasoning: false },
      { id: `m-${suffix}2`, name: `${suffix}2`, reasoning: false, contextWindow: 262144 },
    ]
    const { routing, adapterProviders, upstreams } = await fixture([
      { id: "user-alpha", key: "sk-real-alpha", models: models("a") },
      { id: "user-beta", key: "sk-real-beta", models: [{ id: "m-b1", name: "b1", reasoning: false }] },
    ])
    const adapter = new KimiBentoConfigAdapter("kimi", routing, track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-home-"))))
    const lease = await adapter.prepare(bentoRequest("sess-1", adapterProviders))

    const home = lease.env.KIMI_CODE_HOME!
    expect(home).toContain("kimi-bento-sess-1")
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8")
    expect(config).not.toContain("sk-real-alpha")
    expect(config).not.toContain("sk-real-beta")

    // kimi 1.x 布局:share dir 有 v1 config 与占位 token(过 ACP 登录门槛的本地检查)
    const share = lease.env.KIMI_SHARE_DIR!
    expect(share).toContain("kimi-bento-sess-1")
    expect(fs.readFileSync(path.join(share, "config.toml"), "utf8")).toContain('type = "openai_legacy"')
    const token = JSON.parse(fs.readFileSync(path.join(share, "credentials", "kimi-code.json"), "utf8"))
    expect(token).toMatchObject({ access_token: "bento-session-route" })
    expect(token.expires_at).toBeGreaterThan(Date.now() / 1000)

    expect(lease.selections.size).toBe(3)
    expect(lease.selected.harnessModelId).toMatch(/^bento-\w+\/m-a1$/)

    // alias → baseUrl 的确定性映射:selection harnessModelId 的前缀即 config 里的 provider 段
    const aliasOf = (providerIndex: number) =>
      lease.selections.get(selectionKey(adapterProviders[providerIndex]!.providerId, adapterProviders[providerIndex]!.models[0]!.id))!
        .harnessModelId.split("/")[0]!
    const baseUrlOf = (alias: string) => {
      const section = config.split(`[providers."${alias}"]`)[1] ?? ""
      return section.match(/base_url = "([^"]+)"/)?.[1]
    }

    await fetch(`${baseUrlOf(aliasOf(0))}/chat/completions`, { method: "POST", body: "{}" })
    expect(upstreams[0]!.lastAuth()).toBe("Bearer sk-real-alpha")
    await fetch(`${baseUrlOf(aliasOf(1))}/chat/completions`, { method: "POST", body: "{}" })
    expect(upstreams[1]!.lastAuth()).toBe("Bearer sk-real-beta")
    await lease.dispose()
  })

  it("跨 Provider reconfigure 返回 live;未知与跨 mode 返回 new-session", async () => {
    const { routing, adapterProviders } = await fixture([
      { id: "user-alpha", key: "sk-a", models: [{ id: "m-a1", name: "a1", reasoning: false }] },
      { id: "user-beta", key: "sk-b", models: [{ id: "m-b1", name: "b1", reasoning: false }] },
    ])
    const adapter = new KimiBentoConfigAdapter("kimi", routing, track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-home-"))))
    const lease: SessionConfigLease = await adapter.prepare(bentoRequest("sess-2", adapterProviders))

    const cross = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "m-b1" })
    expect(cross.mode).toBe("live")
    if (cross.mode === "live") {
      expect(cross.selection.providerId).toBe("user-beta")
      expect(cross.selection.harnessModelId).toMatch(/^bento-\w+\/m-b1$/)
    }
    const unknown = await adapter.reconfigure(lease, { providerId: "user-beta", modelId: "ghost" })
    expect(unknown).toMatchObject({ mode: "new-session" })
    const native = await adapter.reconfigure(lease, { providerId: "native-kimi", modelId: "kimi-code/k3" })
    expect(native).toMatchObject({ mode: "new-session" })
    await lease.dispose()
  })

  it("dispose 只吊销 routes 并保留隔离目录;removeSessionState 才删除;重复 dispose 幂等", async () => {
    const { routing, adapterProviders } = await fixture([
      { id: "user-alpha", key: "sk-a", models: [{ id: "m-a1", name: "a1", reasoning: false }] },
      { id: "user-beta", key: "sk-b", models: [{ id: "m-b1", name: "b1", reasoning: false }] },
    ])
    const userData = track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-home-")))
    const adapter = new KimiBentoConfigAdapter("kimi", routing, userData)
    const lease = await adapter.prepare(bentoRequest("sess-3", adapterProviders))
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    expect(routing.sessionsUsing("user-beta")).toBe(1)

    const home = lease.env.KIMI_CODE_HOME!
    await lease.dispose()
    await lease.dispose()

    // routes 吊销;目录与会话标记(config.toml)保留供 revive 复用
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
    expect(fs.existsSync(path.join(home, "config.toml"))).toBe(true)

    // 彻底删除:removeSessionState 清掉稳定 kimi-bento-<sessionKey> 目录
    await adapter.removeSessionState!("sess-3")
    expect(fs.existsSync(home)).toBe(false)
    // 幂等
    await adapter.removeSessionState!("sess-3")
    expect(fs.existsSync(home)).toBe(false)
  })

  it("Skills 投递:--skills-dir 传 curated + 项目级目录;主开关关闭只传项目级;无计划不传", async () => {
    const { routing, adapterProviders } = await fixture([
      { id: "user-alpha", key: "sk-a", models: [{ id: "m-a1", name: "a1", reasoning: false }] },
    ])
    const adapter = new KimiBentoConfigAdapter("kimi", routing, track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-home-"))))
    const curated = track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-curated-")))
    const projectDir = track(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-proj-")))

    const enabled = await adapter.prepare(bentoRequest("sess-sk-1", adapterProviders, {
      skills: { curatedRoot: curated, projectSkillDirs: [projectDir] },
    }))
    expect(enabled.args).toEqual([
      "--skills-dir", path.join(curated, "skills"),
      "--skills-dir", projectDir,
    ])

    // 主开关关闭:curatedRoot 缺省,项目级目录补传(--skills-dir 会替换项目级发现)
    const disabled = await adapter.prepare(bentoRequest("sess-sk-2", adapterProviders, {
      skills: { projectSkillDirs: [projectDir] },
    }))
    expect(disabled.args).toEqual(["--skills-dir", projectDir])

    // 未装配 SkillsService(main 缺省)时完全不传
    const absent = await adapter.prepare(bentoRequest("sess-sk-3", adapterProviders))
    expect(absent.args).toBeUndefined()
  })
})

describe("ProviderRoutingService route set 事务性", () => {
  it("第二个 provider 解析失败时:旧 token 保留,零新 token 泄漏", async () => {
    const { store, routing } = await fixture([
      { id: "user-alpha", key: "sk-a", models: [{ id: "m-a1", name: "a1", reasoning: false }] },
    ])
    // 先有健康 route set
    await routing.issueRouteSet("s", [{ providerId: "user-alpha", harnessId: "kimi" }])
    expect(routing.sessionsUsing("user-alpha")).toBe(1)

    // user-ghost 不存在 → 事务失败
    await expect(routing.issueRouteSet("s", [
      { providerId: "user-alpha", harnessId: "kimi" },
      { providerId: "user-ghost", harnessId: "kimi" },
    ])).rejects.toThrow(/供应商不存在/)
    // 旧 token 原样保留,没有部分签发
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    routing.revokeRoute("s")
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    void store
  })

  it("issueRoute 在既有 route set 之后调用会折叠为单 token", async () => {
    const { routing } = await fixture([
      { id: "user-alpha", key: "sk-a", models: [{ id: "m-a1", name: "a1", reasoning: false }] },
      { id: "user-beta", key: "sk-b", models: [{ id: "m-b1", name: "b1", reasoning: false }] },
    ])
    const set = await routing.issueRouteSet("s", [
      { providerId: "user-alpha", harnessId: "kimi" },
      { providerId: "user-beta", harnessId: "kimi" },
    ])
    expect(set.size).toBe(2)

    // 旧契约:issueRoute 先 revokeRoute 再签单条 → beta 的 token 一并失效
    await routing.issueRoute("s", "user-alpha", "kimi")
    expect(routing.sessionsUsing("user-alpha")).toBe(1)
    expect(routing.sessionsUsing("user-beta")).toBe(0)

    // 旧 token 失效:route set 时代的 baseUrl 现在 401
    const [, staleBeta] = [...set.values()]
    const response = await fetch(`${staleBeta.baseUrl}/chat/completions`, { method: "POST", body: "{}" })
    expect(response.status).toBe(401)
    routing.revokeRoute("s")
  })
})
