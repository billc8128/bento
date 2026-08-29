import { describe, expect, it } from "vitest"

import type { HarnessId } from "@/core/harness"
import type { ProviderView } from "@/core/provider"

import { providersForActiveSession } from "./session-provider-filter"

function view(overrides: Partial<ProviderView> & Pick<ProviderView, "id" | "source">): ProviderView {
  return {
    name: overrides.id,
    harnessIds: ["kimi" as HarnessId],
    connected: true,
    modelDiscovery: "ready",
    models: {},
    ...overrides,
  }
}

const kimiHarness = "kimi" as HarnessId

function kimiProviders(): ProviderView[] {
  return [
    view({
      id: "native-kimi",
      source: "native",
      models: {
        kimi: [
          { id: "kimi-code/kimi-for-coding", name: "K2.7 Coding", reasoning: true },
          { id: "agent-plan/kimi-k3", name: "Kimi K3 (Agent Plan)", reasoning: true },
        ],
      },
    }),
    view({
      id: "user-kimi-code",
      source: "user",
      models: { kimi: [{ id: "kimi-for-coding", name: "kimi-for-coding", reasoning: true }] },
    }),
    view({
      id: "moonshot",
      source: "runtime",
      connected: false,
      models: { kimi: [{ id: "kimi-code/k3", name: "K3", reasoning: true }] },
    }),
  ]
}

describe("providersForActiveSession", () => {
  it("native 会话只列当前 Harness 的完整 native 目录,agent-plan 可见", () => {
    const result = providersForActiveSession(kimiProviders(), {
      harnessId: kimiHarness,
      providerId: "native-kimi",
    })
    expect(result.map((provider) => provider.id)).toEqual(["native-kimi"])
    expect(result[0]?.models.kimi?.map((model) => model.id)).toEqual([
      "kimi-code/kimi-for-coding",
      "agent-plan/kimi-k3",
    ])
  })

  it("Kimi/OpenCode/OMP/Pi/Hermes Bento 会话列全部 Bento provider:native/runtime 排除,user 多 provider 同屏", () => {
    for (const harnessId of ["kimi", "opencode", "omp", "pi", "hermes"] as HarnessId[]) {
      const providers = [
        view({ id: "native-kimi", source: "native", models: { [harnessId]: [{ id: "kimi-code/kimi-for-coding", name: "K2.7 Coding", reasoning: true }] } }),
        view({ id: "user-a", source: "user", harnessIds: [harnessId], models: { [harnessId]: [{ id: "m-a", name: "A", reasoning: false }] } }),
        view({ id: "user-b", source: "user", harnessIds: [harnessId], models: { [harnessId]: [{ id: "m-b", name: "B", reasoning: false }] } }),
        view({ id: "moonshot", source: "runtime", connected: false, harnessIds: [harnessId] }),
      ]
      const result = providersForActiveSession(providers, {
        harnessId,
        providerId: "user-a",
      })
      expect(result.map((provider) => provider.id)).toEqual(["user-a", "user-b"])
      // native 目录与 runtime 来源不同屏
      expect(JSON.stringify(result)).not.toContain("K2.7 Coding")
    }
  })

  it("Claude/Codex Bento 会话列全部 Bento provider,native/runtime 排除", () => {
    const providers = [
      view({ id: "native-codex", source: "native", harnessIds: ["codex" as HarnessId], models: { codex: [{ id: "native", name: "Native", reasoning: true }] } }),
      view({ id: "openai", source: "builtin", harnessIds: ["codex" as HarnessId], models: { codex: [{ id: "oauth", name: "OAuth", reasoning: true }] } }),
      view({ id: "user-relay", source: "user", harnessIds: ["codex" as HarnessId], models: { codex: [{ id: "relay", name: "Relay", reasoning: true }] } }),
      view({ id: "moonshot", source: "runtime", harnessIds: ["codex" as HarnessId] }),
    ]
    const result = providersForActiveSession(providers, {
      harnessId: "codex" as HarnessId,
      providerId: "user-relay",
    })
    expect(result.map((provider) => provider.id)).toEqual(["user-relay", "openai"])
  })

  it("活跃会话在当前模式内去重，并优先保留当前 Provider 路由", () => {
    const providers = [
      view({
        id: "user-other-kimi",
        canonicalId: "kimi-code",
        source: "user",
        models: { kimi: [
          { id: "k3", name: "Other K3", reasoning: true },
          { id: "highspeed", name: "Highspeed", reasoning: true },
        ] },
      }),
      view({
        id: "user-current-kimi",
        canonicalId: "kimi-code",
        source: "user",
        models: { kimi: [{ id: "k3", name: "Current K3", reasoning: true }] },
      }),
    ]
    const result = providersForActiveSession(providers, {
      harnessId: "kimi",
      providerId: "user-current-kimi",
    })
    expect(result.map((provider) => [provider.id, provider.models.kimi?.map((model) => model.name)]))
      .toEqual([
        ["user-current-kimi", ["Current K3"]],
        ["user-other-kimi", ["Highspeed"]],
      ])
  })
})

describe("活跃会话模式边界", () => {
  it("Bento 会话在 canonical 去重之前先排除 native 来源", () => {
    expect(providersForActiveSession(kimiProviders(), {
      harnessId: kimiHarness,
      providerId: "user-kimi-code",
    }).map((provider) => provider.id)).toEqual(["user-kimi-code"])
  })
})
