import { describe, expect, it } from "vitest"

import type { HarnessId } from "../../src/core/harness"
import { SessionConfigRegistry } from "./registry"
import {
  parseSelectionKey,
  selectionKey,
  type SessionConfigAdapter,
} from "./types"

function stubAdapter(harnessId: HarnessId): SessionConfigAdapter {
  return {
    harnessId,
    prepare: async () => {
      throw new Error("stub")
    },
    reconfigure: async () => {
      throw new Error("stub")
    },
  }
}

describe("selectionKey 编解码", () => {
  it("编码后可无损解析,且不会被 `/` 前缀混淆", () => {
    const key = selectionKey("user-kimi-code", "kimi-for-coding/k3")
    expect(selectionKey("user-kimi-code", "kimi-for-coding/k3")).toBe(key)
    expect(parseSelectionKey(key)).toEqual({
      providerId: "user-kimi-code",
      modelId: "kimi-for-coding/k3",
    })
    expect(parseSelectionKey(selectionKey("native-omp/runtime-omp-cursor", "cursor/cursor-agent")))
      .toEqual({ providerId: "native-omp/runtime-omp-cursor", modelId: "cursor/cursor-agent" })
  })

  it("拒绝损坏与非字符串成员", () => {
    expect(parseSelectionKey("not json")).toBeNull()
    expect(parseSelectionKey('["only-one"]')).toBeNull()
    expect(parseSelectionKey('[1, "m"]')).toBeNull()
    expect(parseSelectionKey('["", "m"]')).toBeNull()
  })
})

describe("SessionConfigRegistry", () => {
  it("按 harnessId 注册并取用", () => {
    const registry = new SessionConfigRegistry()
    const kimi = stubAdapter("kimi")
    registry.register(kimi)
    expect(registry.get("kimi")).toBe(kimi)
    expect(registry.has("kimi")).toBe(true)
    expect(registry.has("pi")).toBe(false)
  })

  it("同 harnessId 重复注册报错;未注册取用报错", () => {
    const registry = new SessionConfigRegistry()
    registry.register(stubAdapter("kimi"))
    expect(() => registry.register(stubAdapter("kimi")))
      .toThrow(/重复注册: kimi/)
    expect(() => registry.get("pi")).toThrow(/没有 session-config adapter: pi/)
  })
})
