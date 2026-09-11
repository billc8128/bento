import { describe, expect, it } from "vitest"

import { isOpenCodeUpstream } from "./opencode-session"

describe("isOpenCodeUpstream", () => {
  it("命中 OpenCode Go/Zen 官方端点(含 models 子路径)", () => {
    expect(isOpenCodeUpstream("https://opencode.ai/zen")).toBe(true)
    expect(isOpenCodeUpstream("https://opencode.ai/zen/")).toBe(true)
    expect(isOpenCodeUpstream("https://opencode.ai/zen/v1")).toBe(true)
    expect(isOpenCodeUpstream("https://opencode.ai/zen/go")).toBe(true)
    expect(isOpenCodeUpstream("https://opencode.ai/zen/go/v1")).toBe(true)
    expect(isOpenCodeUpstream("https://opencode.ai/zen/go/v1/models")).toBe(true)
  })

  it("非 OpenCode 上游不误判", () => {
    expect(isOpenCodeUpstream("https://api.openai.com/v1")).toBe(false)
    expect(isOpenCodeUpstream("https://opencode.ai")).toBe(false)
    expect(isOpenCodeUpstream("https://opencode.ai/docs/go/")).toBe(false)
    expect(isOpenCodeUpstream("http://127.0.0.1:8080/zen/v1")).toBe(false)
    expect(isOpenCodeUpstream("not a url")).toBe(false)
    expect(isOpenCodeUpstream("")).toBe(false)
  })

  it("域名冒名不命中:子域与后缀伪装都排除", () => {
    expect(isOpenCodeUpstream("https://sub.opencode.ai/zen/v1")).toBe(false)
    expect(isOpenCodeUpstream("https://opencode.ai.evil.com/zen/v1")).toBe(false)
  })
})
