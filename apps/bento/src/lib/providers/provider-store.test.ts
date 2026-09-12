import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defaultModelSelection, providersForModelPicker, type ProviderView } from "@/core/provider"
import { discoverAllProviderCatalogs, loadProviderCatalog, mergeProviderCatalogs } from "./provider-store"

function view(harnessId: "claude-code" | "codex", connected: boolean): ProviderView {
  return {
    id: "user-multi",
    name: "Multi",
    source: "user",
    harnessIds: [harnessId],
    connected,
    modelDiscovery: "ready",
    models: {
      [harnessId]: [{ id: `${harnessId}-model`, name: "Model", reasoning: false }],
    },
  }
}

describe("mergeProviderCatalogs", () => {
  it("同 provider 跨 runtime 合并时不暴露未连接 runtime 的模型", () => {
    const [provider] = mergeProviderCatalogs([
      view("claude-code", true),
      view("codex", false),
    ])
    expect(provider.connected).toBe(true)
    expect(provider.harnessIds).toEqual(["claude-code", "codex"])
    expect(provider.models["claude-code"]?.map((model) => model.id)).toEqual([
      "claude-code-model",
    ])
    expect(provider.models.codex).toEqual([])
  })

  it("模型选择器只接受 builtin/user，runtime 来源必须先经检测导入", () => {
    const runtime: ProviderView = {
      ...view("claude-code", true),
      id: "runtime-opencode-github-copilot",
      source: "runtime",
    }
    expect(providersForModelPicker([view("claude-code", true), runtime]).map((item) => item.id))
      .toEqual(["user-multi"])
  })

  it("新会话同 canonical 去重先到先得;后到 provider 的重复模型被覆盖", () => {
    const first: ProviderView = {
      id: "user-kimi-code",
      canonicalId: "kimi-code",
      name: "Kimi Code",
      source: "user",
      harnessIds: ["kimi"],
      connected: true,
      modelDiscovery: "ready",
      models: {
        kimi: [
          { id: "k3", name: "k3", reasoning: true },
          { id: "k3-256k", name: "k3-256k", reasoning: true },
        ],
      },
    }
    const second: ProviderView = {
      id: "user-kimi-code-alt",
      canonicalId: "kimi-code",
      name: "Kimi Code Alt",
      source: "user",
      harnessIds: ["kimi"],
      connected: true,
      modelDiscovery: "ready",
      models: {
        kimi: [
          { id: "k3", name: "k3", reasoning: true },
          { id: "kimi-for-coding-highspeed", name: "Highspeed", reasoning: true },
        ],
      },
    }

    const result = providersForModelPicker([first, second], "kimi")
    expect(result.map((provider) => [
      provider.id,
      provider.models.kimi?.map((model) => model.id),
    ])).toEqual([
      ["user-kimi-code", ["k3", "k3-256k"]],
      ["user-kimi-code-alt", ["kimi-for-coding-highspeed"]],
    ])
    expect(defaultModelSelection([first, second], "kimi")).toEqual({
      providerId: first.id,
      modelId: "k3",
    })
  })

  it("Harness 未配置默认模型时选择第一个可用真实模型", () => {
    const provider: ProviderView = {
      id: "user-any",
      canonicalId: "any",
      name: "Any",
      source: "user",
      harnessIds: ["pi"],
      connected: true,
      modelDiscovery: "ready",
      models: { pi: [{ id: "bento/model-a", name: "A", reasoning: false }] },
    }
    expect(defaultModelSelection([provider], "pi")).toEqual({
      providerId: "user-any",
      modelId: "bento/model-a",
    })
  })
})

describe("discoverAll 一次性发现纪律", () => {
  type Call = { harnessId: string; discover: boolean; refresh: boolean }

  function fakeWindow(respond: (call: Call) => ProviderView[]) {
    const calls: Call[] = []
    ;(globalThis as Record<string, unknown>).window = {
      bento: {
        listProviders: async (options: { harnessId: string; discover?: boolean; refresh?: boolean }) => {
          const call = {
            harnessId: options.harnessId,
            discover: options.discover === true,
            refresh: options.refresh === true,
          }
          calls.push(call)
          return respond(call)
        },
        onProvidersChanged: () => () => {},
      },
    }
    return calls
  }

  const userReady: ProviderView = {
    id: "user-multi",
    name: "Multi",
    source: "user",
    harnessIds: ["omp"],
    connected: true,
    modelDiscovery: "ready",
    models: { omp: [{ id: "bento/model-a", name: "A", reasoning: false }] },
  }
  const runtimeIdle: ProviderView = {
    id: "omp-runtime",
    name: "OMP 配置",
    source: "runtime",
    harnessIds: ["omp"],
    connected: false,
    modelDiscovery: "idle",
    models: {},
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as Record<string, unknown>).window
  })

  async function runDiscoverAll(cwd: string, current: "codex" | "omp" = "codex") {
    const task = discoverAllProviderCatalogs(current, cwd)
    await vi.advanceTimersByTimeAsync(3_000)
    await task
  }

  it("Harness 已有 ready 的 user Provider 时,discoverAll 仍触发其本机发现", async () => {
    const calls = fakeWindow(({ harnessId, discover }) =>
      harnessId === "omp" && !discover ? [userReady, runtimeIdle] : [],
    )
    const cwd = "t-user-ready"
    await loadProviderCatalog("omp", cwd)
    await runDiscoverAll(cwd)
    // 旧实现以 providers.some(ready) 误判 settled,这里必须仍然 spawn 发现
    expect(calls.filter((call) => call.harnessId === "omp" && call.discover)).toHaveLength(1)
  })

  it("current harness 同样受一次性纪律约束:连续两次只发现一次,refresh 例外", async () => {
    const calls = fakeWindow(({ harnessId, discover }) =>
      harnessId === "omp" && !discover ? [userReady, runtimeIdle] : [],
    )
    const cwd = "t-current-once"
    await loadProviderCatalog("omp", cwd)
    await runDiscoverAll(cwd, "omp")
    await runDiscoverAll(cwd, "omp")
    expect(calls.filter((call) => call.harnessId === "omp" && call.discover && !call.refresh))
      .toHaveLength(1)
    const refresh = discoverAllProviderCatalogs("omp", cwd, true)
    await vi.advanceTimersByTimeAsync(3_000)
    await refresh
    expect(calls.filter((call) => call.harnessId === "omp" && call.discover && call.refresh))
      .toHaveLength(1)
  })

  it("发现完成后重复 discoverAll 不再重复 spawn,refresh 例外", async () => {
    const calls = fakeWindow(({ harnessId, discover }) =>
      harnessId === "omp" && !discover ? [userReady, runtimeIdle] : [],
    )
    const cwd = "t-no-respawn"
    await loadProviderCatalog("omp", cwd)
    await runDiscoverAll(cwd)
    await runDiscoverAll(cwd)
    expect(calls.filter((call) => call.harnessId === "omp" && call.discover && !call.refresh))
      .toHaveLength(1)
    const refresh = discoverAllProviderCatalogs("codex", cwd, true)
    await vi.advanceTimersByTimeAsync(3_000)
    await refresh
    expect(calls.filter((call) => call.harnessId === "omp" && call.discover && call.refresh))
      .toHaveLength(1)
  })
})
