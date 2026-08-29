import { describe, expect, it } from "vitest"

import { modelsForProvider, type ProviderView } from "../src/core/provider"
import { ProviderDiscoveryService } from "./provider-discovery"
import { mergeDiscoveredModelsIntoConfigured, ProviderRegistry } from "./providers"

describe("ProviderRegistry", () => {
  it("同一已配置供应商合入本机发现模型，但保留 Bento Provider 身份", () => {
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
      id: "native-pi/runtime-pi-zhipu-coding-plan-cn",
      canonicalId: "zhipu-coding-plan-cn",
      name: "智谱 GLM Coding Plan",
      source: "native",
      harnessIds: ["pi"],
      connected: true,
      modelDiscovery: "ready",
      models: { pi: [
        { id: "glm-coding-plan/glm-5.3", name: "GLM 5.3", reasoning: true },
        { id: "glm-coding-plan/glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true },
      ] },
    }

    const [merged] = mergeDiscoveredModelsIntoConfigured([configured], [discovered], "pi")
    expect(merged?.id).toBe(configured.id)
    expect(merged?.models.pi).toEqual([
      { id: "bento/glm-5.3", name: "GLM 5.3", reasoning: true },
      { id: "bento/glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true },
    ])
  })

  it("本机 CLI 尚未发现真实模型时不发布默认哨兵", async () => {
    const registry = new ProviderRegistry(
      undefined,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "local",
        command: `/usr/local/bin/${harnessId}`,
        version: "1.0.0",
        usable: true,
        fallbackAvailable: true,
      }),
    )
    const providers = await registry.list({ harnessId: "pi" })
    expect(providers.some((provider) => provider.source === "native")).toBe(false)
    expect(JSON.stringify(providers)).not.toContain("__native_default__")
  })

  it("本机 ACP CLI 的发现结果按真实供应商分组透传,保留各自默认模型", async () => {
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
    const registry = new ProviderRegistry(
      discovery,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "local",
        usable: true,
        fallbackAvailable: true,
      }),
    )

    const providers = await registry.list({ harnessId: "opencode", cwd: "/tmp", discover: true })
    const native = providers.filter((provider) => provider.source === "native")
    expect(native.map((provider) => provider.name)).toEqual(["Anthropic API", "OpenAI API"])
    expect(native[0]?.models.opencode?.map((model) => model.id)).toEqual(["anthropic/claude-sonnet"])
    expect(native[0]?.defaultModelIds?.opencode).toBe("anthropic/claude-sonnet")
    expect(native[1]?.models.opencode?.map((model) => model.id)).toEqual(["openai/gpt-5.4"])
  })

  it("同一模型配在两个 plan 下时各自成行", async () => {
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
    const registry = new ProviderRegistry(
      discovery,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "local",
        usable: true,
        fallbackAvailable: true,
      }),
    )

    const providers = await registry.list({ harnessId: "omp", cwd: "/tmp", discover: true })
    const native = providers.filter((provider) => provider.source === "native")
    expect(native.map((provider) => provider.name)).toEqual([
      "智谱 GLM Coding Plan",
      "火山方舟 Agent Plan",
    ])
    expect(native.map((provider) => provider.models.omp?.[0]?.id)).toEqual([
      "zhipu-coding-plan/glm-5.3",
      "ark-coding-plan/glm-5.3",
    ])
  })

  it("当前项未上报时选择分组中的第一个真实模型", async () => {
    const discovery = new ProviderDiscoveryService([{
      id: "pi-runtime",
      name: "Pi 配置",
      harnessId: "pi",
      discover: async () => ({
        models: [{ id: "openai/gpt-5.4", name: "GPT-5.4", reasoning: true }],
      }),
    }])
    const registry = new ProviderRegistry(
      discovery,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "local",
        usable: true,
        fallbackAvailable: true,
      }),
    )

    const providers = await registry.list({ harnessId: "pi", cwd: "/tmp", discover: true })
    const group = providers.find((provider) => provider.name === "OpenAI API")
    expect(group?.models.pi?.map((model) => model.id)).toEqual(["openai/gpt-5.4"])
    expect(group?.defaultModelIds?.pi).toBe("openai/gpt-5.4")
    expect(JSON.stringify(providers)).not.toContain("__native_default__")
    await expect(registry.resolveSelection({
      harnessId: "pi",
      cwd: "/tmp",
      providerId: "native-pi",
      modelId: "__native_default__",
    })).resolves.toEqual({
      providerId: group!.id,
      modelId: "openai/gpt-5.4",
    })
  })

  it("本机 Codex 使用 app-server model/list 发布实际模型", async () => {
    const registry = new ProviderRegistry(
      undefined,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "local",
        usable: true,
        fallbackAvailable: true,
      }),
      async () => ({
        currentModelId: "gpt-5.4",
        models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true }],
      }),
    )

    const providers = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    const native = providers.find((provider) => provider.id === "native-codex")
    expect(native?.models.codex?.map((model) => model.id)).toEqual(["gpt-5.4"])
    expect(native?.defaultModelIds?.codex).toBe("gpt-5.4")
  })

  it("本机 Claude Code 发布 CLI 公开的稳定模型别名", async () => {
    const registry = new ProviderRegistry(
      undefined,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "local",
        usable: true,
        fallbackAvailable: true,
      }),
    )

    const providers = await registry.list({ harnessId: "claude-code", cwd: "/tmp", discover: true })
    const native = providers.find((provider) => provider.id === "native-claude-code")
    expect(native?.models["claude-code"]?.map((model) => model.id)).toEqual([
      "fable",
      "opus",
      "sonnet",
    ])
    expect(native?.defaultModelIds?.["claude-code"]).toBe("fable")
  })

  it("本机 CLI 删除后，旧 native 会话允许受管 fallback 恢复", async () => {
    const registry = new ProviderRegistry(
      undefined,
      undefined,
      undefined,
      async (harnessId) => ({
        harnessId,
        source: "managed",
        usable: true,
        fallbackAvailable: true,
      }),
    )
    await expect(registry.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      providerId: "native-codex",
      modelId: "gpt-5.4",
    })).resolves.toEqual({
      providerId: "native-codex",
      modelId: "gpt-5.4",
    })
    expect((await registry.list({ harnessId: "codex" })).some(
      (provider) => provider.id === "native-codex",
    )).toBe(false)
  })

  it("builtin provider 连接态来自凭证判定,模型来自身份卡", async () => {
    const registry = new ProviderRegistry()
    const [provider] = await registry.list({ harnessId: "codex" })
    expect(provider).toMatchObject({
      id: "openai",
      source: "builtin",
      connected: false,
      modelDiscovery: "ready",
    })
    expect(provider.models.codex?.map((model) => model.id)).toEqual(["gpt-5.4"])
  })

  it("内置供应商关闭的模型保留在管理目录但不进入选择器", async () => {
    const registry = new ProviderRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (_providerId, modelId) => modelId !== "gpt-5.4",
    )
    const [provider] = await registry.list({ harnessId: "codex" })
    expect(provider.models.codex?.[0]?.enabled).toBe(false)
    expect(modelsForProvider(provider, "codex")).toEqual([])
  })

  it("同一模型在 OAuth 与本机 CLI 来源之间共享可见性", async () => {
    const registry = new ProviderRegistry(
      undefined,
      () => true,
      async () => ({
        currentModelId: "gpt-5.5",
        models: [{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true }],
      }),
      async (harnessId) => ({
        harnessId,
        source: "local",
        usable: true,
        fallbackAvailable: true,
      }),
      async () => ({
        currentModelId: "gpt-5.5",
        models: [{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true }],
      }),
      (_providerId, modelId) => modelId !== "gpt-5.5",
    )
    const providers = await registry.list({ harnessId: "codex", cwd: "/tmp", discover: true })
    const native = providers.find((provider) => provider.source === "native")!
    const oauth = providers.find((provider) => provider.id === "openai")!
    expect(native.models.codex?.[0]?.enabled).toBe(false)
    expect(oauth.models.codex?.[0]?.enabled).toBe(false)
    expect(modelsForProvider(native, "codex")).toEqual([])
  })

  it("已连接 builtin OpenAI 用 Codex model/list 替换静态身份卡并缓存", async () => {
    let calls = 0
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      async () => {
        calls += 1
        return {
          currentModelId: "gpt-runtime-default",
          models: [
            { id: "gpt-runtime-default", name: "Runtime Default", reasoning: true },
            { id: "gpt-runtime-fast", name: "Runtime Fast", reasoning: true },
          ],
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

    const connected = new ProviderRegistry(undefined, (config) => config.id === "openai")
    await expect(connected.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      modelId: "gpt-5.4",
    })).resolves.toEqual({ providerId: "openai", modelId: "gpt-5.4" })
  })

  it("显式 Bento provider 校验不启动本机 runtime 发现", async () => {
    let runtimeReads = 0
    const registry = new ProviderRegistry(
      undefined,
      (config) => config.id === "openai",
      undefined,
      async () => {
        runtimeReads += 1
        throw new Error("不应读取本机 runtime")
      },
    )

    await expect(registry.resolveSelection({
      harnessId: "codex",
      cwd: "/tmp",
      providerId: "openai",
      modelId: "gpt-5.4",
    })).resolves.toEqual({ providerId: "openai", modelId: "gpt-5.4" })
    expect(runtimeReads).toBe(0)
  })
})

import type { CustomProviderConfig } from "../src/core/provider"

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
    const codexRegistry = new ProviderRegistry()
    codexRegistry.setUserProviders([userConfig])
    const providers = await codexRegistry.list({ harnessId: "codex" })
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
