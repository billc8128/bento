import { describe, expect, it } from "vitest"

import { providerFamilyId } from "./provider-grouping"

describe("供应商设置分组", () => {
  it("不同 Base URL 的地区与套餐保持独立", () => {
    expect(providerFamilyId("zai-coding-plan-global")).toBe("zai-coding-plan-global")
    expect(providerFamilyId("zhipu-coding-plan-cn")).toBe("zhipu-coding-plan-cn")
    expect(providerFamilyId("moonshot-global")).toBe("moonshot-global")
    expect(providerFamilyId("xai-oauth")).toBe("xai")
  })
})
