import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ModelVisibilityStore } from "./model-visibility"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("ModelVisibilityStore", () => {
  it("持久化内置供应商的模型可见性", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-model-visibility-"))
    const store = new ModelVisibilityStore(tempDir)
    store.set("openai", [{ modelId: "gpt-5.4", enabled: false }])
    expect(store.isEnabled("openai", "gpt-5.4")).toBe(false)

    const reloaded = new ModelVisibilityStore(tempDir)
    expect(reloaded.isEnabled("openai", "gpt-5.4")).toBe(false)
    expect(reloaded.isEnabled("native-codex", "gpt-5.4")).toBe(false)
    reloaded.set("native-codex", [{ modelId: "gpt-5.4", enabled: true }])
    expect(reloaded.isEnabled("openai", "gpt-5.4")).toBe(true)
  })

  it("兼容旧版按 provider 保存的隐藏清单", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-model-visibility-"))
    const dir = path.join(tempDir, "providers")
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "model-visibility.json"), JSON.stringify({
      openai: ["gpt-5.5"],
      anthropic: ["claude-opus"],
    }))
    const store = new ModelVisibilityStore(tempDir)
    expect(store.isEnabled("native-codex", "gpt-5.5")).toBe(false)
    expect(store.isEnabled("native-claude-code", "claude-opus")).toBe(false)
  })
})
