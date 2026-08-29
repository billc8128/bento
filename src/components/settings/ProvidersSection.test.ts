import { describe, expect, it } from "vitest"

import type { ProviderView } from "@/core/provider"

import { nativeCanonicalId, providerFamilyId } from "./provider-grouping"

function native(id: string, harnessId: ProviderView["harnessIds"][number]): ProviderView {
  return {
    id,
    name: "fixture",
    source: "native",
    harnessIds: [harnessId],
    connected: true,
    modelDiscovery: "ready",
    models: {},
  }
}

describe("供应商设置分组", () => {
  it("把 Kimi CLI 的 moonshot 运行时归到 Kimi Code", () => {
    expect(nativeCanonicalId(native("native-kimi/moonshot", "kimi"))).toBe("kimi-code")
  })

  it("保留本机模型的真实 canonical provider", () => {
    expect(nativeCanonicalId(native(
      "native-opencode/runtime-opencode-zai-coding-plan-global",
      "opencode",
    ))).toBe("zai-coding-plan-global")
  })

  it("无法归因的 CLI 默认模型不伪装成供应商", () => {
    expect(nativeCanonicalId(native("native-pi", "pi"))).toBeNull()
  })

  it("不同 Base URL 的地区与套餐保持独立", () => {
    expect(providerFamilyId("zai-coding-plan-global")).toBe("zai-coding-plan-global")
    expect(providerFamilyId("zhipu-coding-plan-cn")).toBe("zhipu-coding-plan-cn")
    expect(providerFamilyId("moonshot-global")).toBe("moonshot-global")
  })
})
