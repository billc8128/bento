import fs from "node:fs"
import { describe, expect, it } from "vitest"

import { resolvePiRpcEntry } from "./pi-rpc-entry"

describe("resolvePiRpcEntry", () => {
  it("使用 package 的 ESM export 解析实际 RPC 入口", () => {
    const entry = resolvePiRpcEntry()
    expect(entry).toMatch(/pi-coding-agent\/dist\/rpc-entry\.js$/)
    expect(fs.existsSync(entry)).toBe(true)
  })
})
