import { describe, expect, it, vi } from "vitest"

import { modelsForProvider, type CustomProviderConfig, type ProviderView } from "../../src/core/provider"
import { ProviderDiscoveryService } from "./provider-discovery"
import type { ProviderModelCache } from "./provider-model-cache"
import { enrichConfiguredModelsFromDiscovery, ProviderRegistry } from "./providers"

describe("ProviderRegistry", () => {
  it("OpenAI OAuth 未完成账户发现前不发布静态模型", async () => {
    const registry = new ProviderRegistry(undefined, (config) => config.id === "openai")
    for (const harnessId of ["codex", "pi", "omp", "hermes", "kimi", "opencode"] as const) {
      const providers = await registry.list({ harnessId, cwd: "/tmp" })
      expect(providers.find((provider) => provider.id === "openai")).toMatchObject({
        connected: true,
        modelDiscovery: "idle",
        models: { [harnessId]: [] },
      })
    }
  })

  it("OpenAI OAuth 动态账户目录复用于全部 Responses Harness，并保持各自 wire id", async () => {
    let calls = 0
    const registry = new ProviderRegistry(
      new ProviderDiscoveryService([]),
      (config) => config.id === "openai",
      async () => {
        calls += 1
        return {
          result: {
            currentModelId: "gpt-5.6-sol",
            models: [
              { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", reasoning: true },
              { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", reasoning: true },
              { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", reasoning: true },
            ],
          },
        }
      },
    )

    await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    for (const harnessId of ["pi", "omp", "opencode", "kimi", "hermes"] as const) {
      const providers = await registry.list({ harnessId, cwd: "/tmp", discover: true })
      const openai = providers.find((provider) => provider.id === "openai")!
      const prefix = ["pi", "omp", "opencode"].includes(harnessId) ? "bento/" : ""
      expect(openai.models[harnessId]?.map((model) => model.id)).toEqual([
        `${prefix}gpt-5.6-sol`,
        `${prefix}gpt-5.6-terra`,
        `${prefix}gpt-5.6-luna`,
      ])
      expect(openai.defaultModelIds?.[harnessId]).toBe(`${prefix}gpt-5.6-sol`)
    }
    await expect(registry.resolveSelection({
      harnessId: "pi",
      cwd: "/tmp",
      providerId: "openai",
      modelId: "bento/gpt-5.6-terra",
    })).resolves.toEqual({ providerId: "openai", modelId: "bento/gpt-5.6-terra" })
    expect(calls).toBe(1)
  })

  it("OpenAI OAuth 账户目录跨 cwd 与 Harness 复用", async () => {
    const discovery = {
      currentModelId: "gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol", reasoning: true }],
    }
    const persistentCache = {
      get: vi.fn((key: string) => key === "builtin-account\0openai" ? discovery : undefined),
      set: vi.fn(),
    } as unknown as ProviderModelCache
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      undefined,
      undefined,
      persistentCache,
    )

    const codex = await registry.list({ harnessId: "codex", cwd: "/project-a" })
    const pi = await registry.list({ harnessId: "pi", cwd: "/project-b" })
    expect(codex.find((provider) => provider.id === "openai")?.models.codex).toMatchObject([
      { id: "gpt-5.6-sol" },
    ])
    expect(pi.find((provider) => provider.id === "openai")?.models.pi).toMatchObject([
      { id: "bento/gpt-5.6-sol" },
    ])
  })

  it("同一已配置供应商用本机发现充实已配置模型的元数据,但不增补未配置模型", () => {
    const configured: ProviderView = {
      id: "user-zhipu-coding-plan-cn",
      canonicalId: "zhipu-coding-plan-cn",
      name: "智谱 GLM Coding Plan",
      source: "user",
      harnessIds: ["pi"],
      connected: true,
      modelDiscovery: "ready",
      models: { pi: [{ id: "bento/glm-5.3", name: "GLM 5.3", reasoning: false }] },
    }
    const discovered: ProviderView = {
      id: "runtime-pi-zhipu-coding-plan-cn",
      canonicalId: "zhipu-coding-plan-cn",
      name: "智谱 GLM Coding Plan",
      source: "runtime",
      harnessIds: ["pi"],
      connected: true,
      modelDiscovery: "ready",
      models: { pi: [
        { id: "glm-coding-plan/glm-5.3", name: "GLM 5.3", reasoning: true },
        { id: "glm-coding-plan/glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true },
      ] },
    }

    const [merged] = enrichConfiguredModelsFromDiscovery([configured], [discovered], "pi")
    expect(merged?.id).toBe(configured.id)
    // 已配置模型:reasoning 等元数据被本机发现充实;未配置的 glm-5.3-flash 不进目录
    expect(merged?.models.pi).toEqual([
      { id: "bento/glm-5.3", name: "GLM 5.3", reasoning: true },
    ])
  })

  it("builtin OAuth 不借本机 CLI 目录补模型", () => {
    const builtin: ProviderView = {
      id: "anthropic",
      canonicalId: "anthropic",
      name: "Anthropic",
      source: "builtin",
      authMethod: "oauth",
      harnessIds: ["claude-code"],
      connected: true,
      modelDiscovery: "idle",
      models: { "claude-code": [] },
    }
    const runtime: ProviderView = {
      ...builtin,
      id: "runtime-claude-code",
      source: "runtime",
      modelDiscovery: "ready",
      models: { "claude-code": [{ id: "runtime-only", name: "Runtime", reasoning: true }] },
    }

    expect(enrichConfiguredModelsFromDiscovery([builtin], [runtime], "claude-code"))
      .toEqual([builtin])
  })

  it("本机 ACP CLI 的发现结果按真实供应商分组透传为 runtime 候选,保留各自默认模型", async () => {
    const discovery = new ProviderDiscoveryService([{
      id: "opencode-runtime",
      name: "OpenCode 配置",
      harnessId: "opencode",
      discover: async () => ({
        currentModelId: "anthropic/claude-sonnet",
        models: [
          { id: "anthropic/claude-sonnet", name: "Claude Sonnet", reasoning: true },
          { id: "openai/gpt-5.4", name: "GPT-5.4", reasoning: true },
        ],
      }),
    }])
    const registry = new ProviderRegistry(discovery)

    const providers = await registry.list({ harnessId: "opencode", cwd: "/tmp", discover: true })
    const runtime = providers.filter((provider) => provider.source === "runtime")
    expect(runtime.map((provider) => provider.name)).toEqual(["Anthropic API", "OpenAI API"])
    expect(runtime[0]?.models.opencode?.map((model) => model.id)).toEqual(["anthropic/claude-sonnet"])
    expect(runtime[0]?.defaultModelIds?.opencode).toBe("anthropic/claude-sonnet")
    expect(runtime[1]?.models.opencode?.map((model) => model.id)).toEqual(["openai/gpt-5.4"])
  })

  it("同一模型配在两个 plan 下时 runtime 候选各自成行", async () => {
    const discovery = new ProviderDiscoveryService([{
      id: "omp-runtime",
      name: "OMP 配置",
      harnessId: "omp",
      discover: async () => ({
        currentModelId: "zhipu-coding-plan/glm-5.3",
        models: [
          { id: "zhipu-coding-plan/glm-5.3", name: "GLM 5.3", reasoning: true },
          { id: "ark-coding-plan/glm-5.3", name: "GLM 5.3", reasoning: true },
        ],
      }),
    }])
    const registry = new ProviderRegistry(discovery)

    const providers = await registry.list({ harnessId: "omp", cwd: "/tmp", discover: true })
    const runtime = providers.filter((provider) => provider.source === "runtime")
    expect(runtime.map((provider) => provider.name)).toEqual([
      "智谱 GLM Coding Plan",
      "火山方舟 Agent Plan",
    ])
    expect(runtime.map((provider) => provider.models.omp?.[0]?.id)).toEqual([
      "zhipu-coding-plan/glm-5.3",
      "ark-coding-plan/glm-5.3",
    ])
  })

  it("历史 native provider id 不再可解析,阻止旧会话恢复", async () => {
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => ({ result: { models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true }] } }),
    )
    await expect(registry.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      providerId: "native-codex",
      modelId: "gpt-5.4",
    })).resolves.toBeNull()
    expect((await registry.list({ harnessId: "codex", discover: true })).some(
      (provider) => provider.id.startsWith("native-"),
    )).toBe(false)
  })

  it("builtin provider 连接态来自凭证判定,账户发现前不发布模型", async () => {
    const registry = new ProviderRegistry()
    const [provider] = await registry.list({ harnessId: "codex" })
    expect(provider).toMatchObject({
      id: "openai",
      source: "builtin",
      connected: false,
      modelDiscovery: "idle",
    })
    expect(provider.models.codex).toEqual([])
  })

  it("内置供应商关闭的模型保留在管理目录但不进入选择器", async () => {
    const registry = new ProviderRegistry(
      undefined,
      () => true,
      async () => ({
        result: { models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true }] },
      }),
      (_providerId, modelId) => modelId !== "gpt-5.4",
    )
    const [provider] = await registry.list({ harnessId: "codex", discover: true })
    expect(provider.models.codex?.[0]?.enabled).toBe(false)
    expect(modelsForProvider(provider, "codex")).toEqual([])
  })

  it("已连接 builtin OpenAI 用 Codex model/list 替换静态身份卡并缓存", async () => {
    let calls = 0
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => {
        calls += 1
        return {
          result: {
            currentModelId: "gpt-runtime-default",
            models: [
              { id: "gpt-runtime-default", name: "Runtime Default", reasoning: true },
              { id: "gpt-runtime-fast", name: "Runtime Fast", reasoning: true },
            ],
          },
        }
      },
    )

    const [discovered] = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    const [cached] = await registry.list({ harnessId: "codex", cwd: "/tmp" })
    expect(discovered.models.codex?.map((model) => model.id)).toEqual([
      "gpt-runtime-default",
      "gpt-runtime-fast",
    ])
    expect(discovered.defaultModelIds?.codex).toBe("gpt-runtime-default")
    expect(cached).toEqual(discovered)
    await expect(registry.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      providerId: "openai",
      modelId: "gpt-runtime-fast",
    })).resolves.toEqual({ providerId: "openai", modelId: "gpt-runtime-fast" })
    expect(calls).toBe(1)
  })

  it("builtin 账户发现带错误时标 failed 并透出文案,不写入缓存", async () => {
    let calls = 0
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => {
        calls += 1
        return { result: null, error: "OpenAI 模型发现失败,请稍后重试;首次使用需等待内置运行时就绪" }
      },
    )

    const [failed] = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    expect(failed).toMatchObject({ id: "openai", modelDiscovery: "failed" })
    expect(failed.discoveryError).toContain("运行时就绪")
    // 失败不进缓存:下一次 discover 会重新尝试,而不是被空结果钉死。
    const [again] = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    expect(again.modelDiscovery).toBe("failed")
    expect(calls).toBe(2)
  })

  it("builtin OAuth 账户目录为空时标 failed,不静默回 idle", async () => {
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => ({ result: { models: [] }, error: "OpenAI 返回了空的模型列表,请稍后重试" }),
    )

    const [provider] = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    expect(provider.modelDiscovery).toBe("failed")
    expect(provider.discoveryError).toContain("空的模型列表")
  })

  it("非发现目标(discoverBuiltin 返回 null)保持 idle,不标 failed", async () => {
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => null,
    )

    const [provider] = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    expect(provider).toMatchObject({ id: "openai", modelDiscovery: "idle" })
    expect(provider.discoveryError).toBeUndefined()
  })

  it("discoverBuiltin 自身抛错也标 failed,不让整个列表请求失败", async () => {
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => {
        throw new Error("unexpected routing crash")
      },
    )

    const [provider] = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    expect(provider).toMatchObject({
      id: "openai",
      modelDiscovery: "failed",
      discoveryError: "unexpected routing crash",
    })
  })

  it("runtime provider 未发现时未连接,发现服务成功后发布模型并缓存", async () => {
    let calls = 0
    const discovery = new ProviderDiscoveryService([{
      id: "moonshot",
      name: "Moonshot",
      harnessId: "kimi",
      discover: async () => {
        calls += 1
        return {
          currentModelId: "real-default",
          models: [{ id: "real-default", name: "Real Default", reasoning: true }],
        }
      },
    }])
    const registry = new ProviderRegistry(discovery)
    const [idle] = await registry.list({ harnessId: "kimi" })
    expect(idle).toMatchObject({ connected: false, modelDiscovery: "idle", models: {} })
    const [first] = await registry.list({ harnessId: "kimi", discover: true })
    const [second] = await registry.list({ harnessId: "kimi", discover: true })
    expect(first.models.kimi).toEqual([
      { id: "real-default", name: "Real Default", reasoning: true, enabled: true },
    ])
    expect(first.defaultModelIds?.kimi).toBe("real-default")
    expect(first.connected).toBe(true)
    expect(second).toEqual(first)
    expect(calls).toBe(1)
  })

  it("Pi/OMP 返回 provider/model 时按 canonical provider 拆分，不再混成一个 CLI 来源", async () => {
    const discovery = new ProviderDiscoveryService([{
      id: "pi-runtime",
      name: "Pi 配置",
      harnessId: "pi",
      discover: async () => ({
        models: [
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", reasoning: false },
          { id: "moonshotai/kimi-k2", name: "Kimi K2", reasoning: true },
        ],
      }),
    }])
    const providers = await discovery.list({ harnessId: "pi", cwd: "/tmp", discover: true })
    expect(providers.map((provider) => [provider.id, provider.name])).toEqual([
      ["runtime-pi-deepseek", "DeepSeek"],
      ["runtime-pi-moonshot-global", "Kimi / Moonshot Global"],
    ])
  })

  it("Kimi configuredKeys 接线后 kimi-code 与 agent-plan 两个 canonical group 都保留", async () => {
    const discovery = new ProviderDiscoveryService(
      [{
        id: "moonshot",
        name: "Kimi Code",
        harnessId: "kimi",
        discover: async () => ({
          currentModelId: "kimi-code/k3",
          models: [
            { id: "kimi-code/k3", name: "K3", reasoning: true },
            { id: "agent-plan/kimi-k3", name: "Kimi K3 (Agent Plan)", reasoning: true },
            { id: "moonshotai/moonshot-v1-auto", name: "Catalog Noise", reasoning: true },
          ],
        }),
      }],
      undefined,
      (harnessId) => (harnessId === "kimi" ? ["kimi-code", "agent-plan"] : []),
    )
    const providers = await discovery.list({ harnessId: "kimi", cwd: "/tmp", discover: true })
    expect(providers.map((provider) => [provider.id, provider.name, provider.models.kimi?.length])).toEqual([
      ["runtime-kimi-kimi-code", "Kimi Code", 1],
      ["runtime-kimi-volcengine-agent-plan", "火山方舟 Agent Plan", 1],
    ])
    expect(providers[0]?.defaultModelIds?.kimi).toBe("kimi-code/k3")
  })

  it("接线 configuredKeys 后滤掉 CLI 未配置的目录噪声,无前缀模型保留", async () => {
    const discovery = new ProviderDiscoveryService(
      [{
        id: "omp-runtime",
        name: "OMP 配置",
        harnessId: "omp",
        discover: async () => ({
          currentModelId: "ark-coding-plan/auto",
          models: [
            { id: "ark-coding-plan/auto", name: "Auto", reasoning: true },
            { id: "glm-coding-plan/glm-5.3", name: "GLM 5.3", reasoning: true },
            { id: "github-copilot/gpt-5", name: "GPT-5", reasoning: true },
            { id: "opencode-zen/fast", name: "Fast", reasoning: true },
            { id: "cli-custom", name: "CLI Custom", reasoning: true },
          ],
        }),
      }],
      undefined,
      (harnessId) => (harnessId === "omp" ? ["ark-coding-plan", "glm-coding-plan"] : []),
    )
    const providers = await discovery.list({ harnessId: "omp", cwd: "/tmp", discover: true })
    expect(providers.map((provider) => [provider.name, provider.models.omp?.length])).toEqual([
      ["火山方舟 Agent Plan", 1],
      ["智谱 GLM Coding Plan", 1],
      ["OMP 配置", 1],
    ])
    expect(providers[0]?.defaultModelIds?.omp).toBe("ark-coding-plan/auto")
  })

  it("会话选择只解析已连接且确实提供模型的唯一 provider", async () => {
    const disconnected = new ProviderRegistry()
    await expect(disconnected.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      modelId: "gpt-5.4",
    })).resolves.toBeNull()

    const connected = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => ({ result: { models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true }] } }),
    )
    await expect(connected.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      modelId: "gpt-5.4",
    })).resolves.toEqual({ providerId: "openai", modelId: "gpt-5.4" })
  })

  it("显式 Bento provider 校验直接走注册表与缓存,不做任何本机发现", async () => {
    const discovery = {
      currentModelId: "gpt-5.4",
      models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true }],
    }
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      undefined,
      undefined,
      {
        get: vi.fn((key: string) => key === "builtin-account\0openai" ? discovery : undefined),
        set: vi.fn(),
      } as unknown as ProviderModelCache,
    )

    await expect(registry.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      providerId: "openai",
      modelId: "gpt-5.4",
    })).resolves.toEqual({ providerId: "openai", modelId: "gpt-5.4" })
  })
})

const userConfig: CustomProviderConfig = {
  id: "user-relay",
  name: "My Relay",
  auth: { method: "apiKey" },
  runtimes: {
    "claude-code": {
      baseUrl: "https://relay.example.com",
      wireProtocol: "anthropic-messages",
      models: [{ id: "claude-x", name: "Claude X", reasoning: false }],
    },
  },
}

describe("ProviderRegistry user providers", () => {
  it("Pi runtime 发布 bento/model wire id", async () => {
    const piConfig: CustomProviderConfig = {
      id: "user-deepseek",
      name: "DeepSeek",
      auth: { method: "apiKey" },
      runtimes: {
        pi: {
          baseUrl: "https://api.deepseek.com",
          wireProtocol: "openai-chat",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        },
      },
    }
    const registry = new ProviderRegistry(undefined, () => true)
    registry.setUserProviders([piConfig])
    const providers = await registry.list({ harnessId: "pi", cwd: "/tmp" })
    const user = providers.find((provider) => provider.id === piConfig.id)
    expect(user?.models.pi?.map((model) => model.id)).toEqual(["bento/deepseek-chat"])
  })

  it("user provider 与 builtin provider 统一发布,连接态来自凭证判定", async () => {
    const registry = new ProviderRegistry(undefined, (config) => config.id === "user-relay")
    registry.setUserProviders([userConfig])
    const providers = await registry.list({ harnessId: "claude-code", discover: true })
    expect(providers.map((p) => p.id)).toEqual(["anthropic", "user-relay"])
    const user = providers[1]!
    expect(user).toMatchObject({ source: "user", connected: true, modelDiscovery: "ready" })
    expect(user.models["claude-code"]?.map((m) => m.id)).toEqual(["claude-x"])
  })

  it("未配置该 harness 的 user provider 不出现在别的 harness 列表里", async () => {
    const registry = new ProviderRegistry()
    registry.setUserProviders([userConfig])
    const providers = await registry.list({ harnessId: "codex" })
    expect(providers.map((p) => p.id)).toEqual(["openai"])
  })

  it("CRUD 变更后 setUserProviders 即时生效(同 registry 实例)", async () => {
    const registry = new ProviderRegistry()
    registry.setUserProviders([])
    expect(await registry.list({ harnessId: "claude-code" })).toHaveLength(1)
    registry.setUserProviders([userConfig])
    expect(await registry.list({ harnessId: "claude-code" })).toHaveLength(2)
  })

  it("同一 user provider 按 runtime 分别判定连接态", async () => {
    const multi: CustomProviderConfig = {
      ...userConfig,
      runtimes: {
        ...userConfig.runtimes,
        codex: {
          baseUrl: "https://relay.example.com/v1",
          wireProtocol: "openai-responses",
          models: [{ id: "codex-model", name: "Codex Model" }],
        },
      },
    }
    const registry = new ProviderRegistry(
      undefined,
      (_config, harnessId) => harnessId === "claude-code",
    )
    registry.setUserProviders([multi])
    const claude = (await registry.list({ harnessId: "claude-code" }))[1]!
    const codex = (await registry.list({ harnessId: "codex" }))[1]!
    expect(claude).toMatchObject({ connected: true, harnessIds: ["claude-code"] })
    expect(codex).toMatchObject({ connected: false, harnessIds: ["codex"] })
    expect(claude.models.codex).toBeUndefined()
    expect(codex.models["claude-code"]).toBeUndefined()
  })
})
