import { describe, expect, it, vi } from "vitest"

import type { HarnessRuntimeStatus } from "../src/core/harness"
import type { ProviderView } from "../src/core/provider"
import { AgentSelectionCatalog } from "./collaboration-catalog"

function provider(overrides: Partial<ProviderView> & Pick<ProviderView, "id" | "source">): ProviderView {
  return {
    id: overrides.id,
    name: overrides.id,
    source: overrides.source,
    connected: true,
    harnessIds: ["omp"],
    modelDiscovery: "ready",
    models: { omp: [{ id: "m", name: "Model", reasoning: true }] },
    ...overrides,
  }
}

describe("AgentSelectionCatalog", () => {
  it("harness_list 合并产品目录与真实 runtime 状态", async () => {
    const statuses: HarnessRuntimeStatus[] = [{
      harnessId: "omp",
      source: "managed",
      usable: true,
      fallbackAvailable: true,
      version: "1.2.3",
    }]
    const catalog = new AgentSelectionCatalog(
      { list: async () => [] },
      async () => statuses,
      () => "/workspace",
    )
    const harnesses = await catalog.listHarnesses()
    expect(harnesses.find((item) => item.id === "omp")).toMatchObject({
      name: "OMP",
      usable: true,
      source: "managed",
      version: "1.2.3",
      efforts: ["off", "auto"],
      defaultEffort: "auto",
    })
    expect(harnesses.find((item) => item.id === "codex")).toMatchObject({ usable: false })
  })

  it("model_list 只发布可执行 picker 选项，并沿用 native 优先的默认规则", async () => {
    const list = vi.fn(async () => [
      provider({
        id: "native-omp/runtime-omp-openai",
        source: "native",
        name: "OpenAI 本机",
        defaultModelIds: { omp: "native-model" },
        models: { omp: [{ id: "native-model", name: "Native Model", reasoning: true, efforts: ["auto"], defaultEffort: "auto" }] },
      }),
      provider({
        id: "user-zhipu",
        source: "user",
        name: "智谱",
        models: { omp: [{ id: "bento/glm", name: "GLM", reasoning: false }] },
      }),
      provider({ id: "runtime-omp-hidden", source: "runtime" }),
      provider({ id: "user-disconnected", source: "user", connected: false }),
    ])
    const catalog = new AgentSelectionCatalog(
      { list },
      async () => [],
      () => "/caller-workspace",
    )
    const models = await catalog.listModels({ callerSessionId: "caller", harnessId: "omp" })
    expect(list).toHaveBeenCalledWith({ harnessId: "omp", cwd: "/caller-workspace", discover: true })
    expect(models.map((model) => [model.providerId, model.modelId])).toEqual([
      ["native-omp/runtime-omp-openai", "native-model"],
      ["user-zhipu", "bento/glm"],
    ])
    expect(models[0]).toMatchObject({ default: true, providerDefault: true, defaultEffort: "auto" })
    expect(models[1]).toMatchObject({ default: false, efforts: [] })
  })

  it("resolveSelection 支持默认、Provider 默认和唯一 modelId，歧义时不猜", async () => {
    const catalog = new AgentSelectionCatalog(
      { list: async () => [
        provider({
          id: "user-a",
          source: "user",
          models: { omp: [
            { id: "same", name: "Same A", reasoning: true },
            { id: "a2", name: "A2", reasoning: true },
          ] },
          defaultModelIds: { omp: "a2" },
        }),
        provider({
          id: "user-b",
          source: "user",
          models: { omp: [{ id: "same", name: "Same B", reasoning: true }] },
        }),
      ] },
      async () => [],
      () => "/workspace",
    )

    await expect(catalog.resolveSelection({ callerSessionId: "c", harnessId: "omp" }))
      .resolves.toMatchObject({ providerId: "user-a", modelId: "a2" })
    await expect(catalog.resolveSelection({ callerSessionId: "c", harnessId: "omp", providerId: "user-a" }))
      .resolves.toMatchObject({ providerId: "user-a", modelId: "a2" })
    await expect(catalog.resolveSelection({ callerSessionId: "c", harnessId: "omp", modelId: "a2" }))
      .resolves.toMatchObject({ providerId: "user-a", modelId: "a2" })
    await expect(catalog.resolveSelection({ callerSessionId: "c", harnessId: "omp", modelId: "same" }))
      .resolves.toBeNull()
  })
})
