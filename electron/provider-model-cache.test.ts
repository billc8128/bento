import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ProviderModelCache } from "./provider-model-cache"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("ProviderModelCache", () => {
  it("跨实例保留模型发现结果", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-provider-cache-"))
    const cache = new ProviderModelCache(tempDir)
    cache.set("native:codex", { models: [{ id: "gpt-5.6-sol" }] })

    const reloaded = new ProviderModelCache(tempDir)
    expect(reloaded.get("native:codex")).toEqual({ models: [{ id: "gpt-5.6-sol" }] })
  })
})
