import { describe, expect, it } from "vitest"

import { defaultModelSelection, providersForModelPicker, type ProviderView } from "@/core/provider"
import { mergeProviderCatalogs } from "./provider-store"

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

  it("新会话按 canonical Provider/Model 去重，保留 native 名称与 Bento 独有模型", () => {
    const native: ProviderView = {
      id: "native-kimi/runtime-kimi-kimi-code",
      canonicalId: "kimi-code",
      name: "Kimi Code",
      source: "native",
      harnessIds: ["kimi"],
      connected: true,
      modelDiscovery: "ready",
      defaultModelIds: { kimi: "kimi-code/k3-256k" },
      models: {
        kimi: [
          { id: "kimi-code/k3", name: "Kimi K3", reasoning: true },
          { id: "kimi-code/k3-256k", name: "Kimi K3 256k", reasoning: true },
          { id: "kimi-code/kimi-for-coding", name: "Kimi K2.7 Coding", reasoning: true },
        ],
      },
    }
    const bento: ProviderView = {
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
          { id: "kimi-for-coding", name: "kimi-for-coding", reasoning: true },
          { id: "kimi-for-coding-highspeed", name: "Highspeed", reasoning: true },
        ],
      },
    }

    const result = providersForModelPicker([bento, native], "kimi")
    expect(result.map((provider) => [
      provider.id,
      provider.models.kimi?.map((model) => model.id),
    ])).toEqual([
      [native.id, ["kimi-code/k3", "kimi-code/k3-256k", "kimi-code/kimi-for-coding"]],
      [bento.id, ["kimi-for-coding-highspeed"]],
    ])
    expect(defaultModelSelection([bento, native], "kimi")).toEqual({
      providerId: native.id,
      modelId: "kimi-code/k3-256k",
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
