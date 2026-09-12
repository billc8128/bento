import { describe, expect, it } from "vitest"

import type { HarnessId } from "./harness"

import {
  compactModelName,
  defaultModelSelection,
  dedupeProviderModels,
  findProviderModel,
  providersForModelPicker,
  type ProviderView,
} from "./provider"

const providers: ProviderView[] = [{
  id: "openai",
  name: "OpenAI",
  source: "builtin",
  harnessIds: ["codex"],
  connected: true,
  modelDiscovery: "ready",
  models: { codex: [{ id: "runtime-model", name: "Runtime Model", reasoning: true }] },
}]

describe("Provider model identity", () => {
  it("紧凑标题移除 Harness 上报的 Provider 前缀", () => {
    expect(compactModelName({ id: "zai/glm-5.3", name: "Z.AI Coding Plan/GLM-5.3" }))
      .toBe("GLM-5.3")
    expect(compactModelName({ id: "glm-5-turbo", name: "GLM 5 Turbo" }))
      .toBe("GLM 5 Turbo")
  })

  it("新选择按 providerId + modelId 精确解析", () => {
    expect(findProviderModel(providers, "openai", "codex", "runtime-model")?.name)
      .toBe("Runtime Model")
  })

  it("旧会话缺 providerId 时只做显示兼容", () => {
    expect(findProviderModel(providers, undefined, "codex", "runtime-model")?.name)
      .toBe("Runtime Model")
  })
})

import {
  buildUserProvider,
  USER_PROVIDER_ID_RE,
  type CustomProviderConfig,
} from "./provider"

const userConfig: CustomProviderConfig = {
  id: "user-deepseek",
  name: "DeepSeek",
  auth: { method: "apiKey" },
  runtimes: {
    "claude-code": {
      baseUrl: "https://api.deepseek.com/anthropic",
      wireProtocol: "anthropic-messages",
      models: [
        { id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false },
        {
          id: "deepseek-reasoner",
          name: "DeepSeek Reasoner",
          reasoning: true,
          reasoningEfforts: ["low", "medium", "high"],
          defaultEffort: "high",
        },
      ],
    },
  },
}

describe("buildUserProvider", () => {
  it("展开成 source=user 的标准 ProviderView,模型挂在对应 harness 下", () => {
    const view = buildUserProvider(userConfig)
    expect(view.id).toBe("user-deepseek")
    expect(view.source).toBe("user")
    expect(view.harnessIds).toEqual(["claude-code"])
    expect(view.modelDiscovery).toBe("ready")
    const models = view.models["claude-code"] ?? []
    expect(models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"])
    expect(models[0].reasoning).toBe(false)
    expect(models[1]).toMatchObject({ efforts: ["low", "medium", "high"], defaultEffort: "high" })
  })

  it("未配置的 runtime 不出现在 harnessIds;reasoning 缺省按 false 不猜", () => {
    const view = buildUserProvider({
      ...userConfig,
      runtimes: {
        codex: {
          baseUrl: "https://api.deepseek.com",
          wireProtocol: "openai-chat",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        },
      },
    })
    expect(view.harnessIds).toEqual(["codex"])
    expect(view.models.codex?.[0].reasoning).toBe(false)
    expect(view.models.codex?.[0].efforts).toBeUndefined()
  })

  it("id 命名空间:user- 前缀必过,裸 openai/anthropic 必拒", () => {
    expect(USER_PROVIDER_ID_RE.test("user-my-relay")).toBe(true)
    expect(USER_PROVIDER_ID_RE.test("openai")).toBe(false)
    expect(USER_PROVIDER_ID_RE.test("anthropic")).toBe(false)
    expect(USER_PROVIDER_ID_RE.test("user-")).toBe(false)
    expect(USER_PROVIDER_ID_RE.test("user-With-Upper")).toBe(false)
  })

  it("user provider 不撞 runtime provider 的 findProviderModel 首命中", () => {
    const mixed = [...providers, buildUserProvider({
      ...userConfig,
      runtimes: {
        codex: {
          baseUrl: "x",
          wireProtocol: "openai-responses",
          models: [{ id: "runtime-model", name: "同名也串不了", reasoning: false }],
        },
      },
    })]
    expect(findProviderModel(mixed, "user-deepseek", "codex", "runtime-model")?.name)
      .toBe("同名也串不了")
    expect(findProviderModel(mixed, "openai", "codex", "runtime-model")?.name)
      .toBe("Runtime Model")
  })
})

describe("dedupeProviderModels / providersForModelPicker", () => {
  const omp = "omp" as HarnessId

  function view(overrides: Partial<ProviderView> & Pick<ProviderView, "id" | "source">): ProviderView {
    return {
      name: overrides.id,
      harnessIds: [omp],
      connected: true,
      modelDiscovery: "ready",
      models: {},
      ...overrides,
    }
  }

  /** OMP 新会话场景:Bento user 与另一 user provider 各有同 canonical 的 GLM。 */
  function ompProviders(): ProviderView[] {
    return [
      view({
        id: "user-zhipu-coding-plan-cn",
        source: "user",
        canonicalId: "zhipu-coding-plan-cn",
        models: { omp: [{ id: "bento/glm-5.3", name: "GLM-5.3", reasoning: true }] },
      }),
      view({
        id: "user-zhipu-coding-plan-cn-alt",
        source: "user",
        canonicalId: "zhipu-coding-plan-cn",
        models: { omp: [
          { id: "bento/glm-5.3", name: "GLM-5.3", reasoning: true },
          { id: "bento/glm-5.4", name: "GLM-5.4", reasoning: true },
        ] },
      }),
      view({
        id: "user-moonshot",
        source: "user",
        canonicalId: "moonshot-global",
        models: { omp: [{ id: "bento/kimi-k3", name: "Kimi K3", reasoning: true }] },
      }),
      view({ id: "omp-runtime", source: "runtime", connected: false }),
    ]
  }

  it("新会话同 canonical GLM 先到先得,后到的同名模型去掉、独有模型保留", () => {
    const result = providersForModelPicker(ompProviders(), omp)
    expect(result.map((provider) => provider.id)).toEqual([
      "user-zhipu-coding-plan-cn",
      "user-zhipu-coding-plan-cn-alt",
      "user-moonshot",
    ])
    const glm = result.flatMap((provider) => provider.models.omp ?? [])
      .filter((model) => model.id.includes("glm"))
    expect(glm.map((model) => model.id)).toEqual(["bento/glm-5.3", "bento/glm-5.4"])
  })

  it("dedupeProviderModels 先到先得,pinned provider 无条件提到最前", () => {
    const [zhipu, altZhipu] = ompProviders()
    const altFirst = dedupeProviderModels([altZhipu, zhipu], omp)
    expect(altFirst.flatMap((provider) => provider.models.omp ?? []).map((model) => model.id))
      .toEqual(["bento/glm-5.3", "bento/glm-5.4"])
    const pinned = dedupeProviderModels([altZhipu, zhipu], omp, {
      pinnedProviderId: "user-zhipu-coding-plan-cn",
    })
    expect(pinned.map((provider) => provider.id)).toEqual(["user-zhipu-coding-plan-cn", "user-zhipu-coding-plan-cn-alt"])
    expect(pinned.flatMap((provider) => provider.models.omp ?? []).map((model) => model.id))
      .toEqual(["bento/glm-5.3", "bento/glm-5.4"])
  })

  it("runtime 来源不进入新会话选择器", () => {
    expect(providersForModelPicker(ompProviders(), omp).some((provider) => provider.source === "runtime"))
      .toBe(false)
  })
})

describe("defaultModelSelection", () => {
  const omp = "omp" as HarnessId

  function view(overrides: Partial<ProviderView> & Pick<ProviderView, "id" | "source">): ProviderView {
    return {
      name: overrides.id,
      harnessIds: [omp],
      connected: true,
      modelDiscovery: "ready",
      models: {},
      ...overrides,
    }
  }

  const userGlm: ProviderView = view({
    id: "user-zhipu-coding-plan-cn",
    source: "user",
    canonicalId: "zhipu-coding-plan-cn",
    models: { omp: [{ id: "bento/glm-5.3", name: "GLM-5.3", reasoning: true }] },
  })
  const userMoonshot: ProviderView = view({
    id: "user-moonshot",
    source: "user",
    canonicalId: "moonshot-global",
    models: { omp: [
      { id: "bento/kimi-k3", name: "Kimi K3", reasoning: true },
      { id: "bento/kimi-k3-256k", name: "Kimi K3 256k", reasoning: true },
    ] },
  })

  it("目录第一项即默认", () => {
    expect(defaultModelSelection([userMoonshot, userGlm], omp)).toEqual({
      providerId: "user-moonshot",
      modelId: "bento/kimi-k3",
    })
  })

  it("第一项 Provider 上报的 defaultModelIds 优先于模型顺序", () => {
    const withDefault: ProviderView = {
      ...userMoonshot,
      defaultModelIds: { omp: "bento/kimi-k3-256k" },
    }
    expect(defaultModelSelection([withDefault, userGlm], omp)).toEqual({
      providerId: "user-moonshot",
      modelId: "bento/kimi-k3-256k",
    })
  })
})
