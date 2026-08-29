import { describe, expect, it } from "vitest"

import { PROVIDER_PRESETS } from "./provider-presets"
import { PROVIDER_SOURCES, PROVIDER_SOURCE_COUNT } from "./provider-sources"

describe("provider catalog", () => {
  it("完整覆盖五仓库 127 个原始 provider id", () => {
    expect(PROVIDER_SOURCE_COUNT).toBe(127)
    expect(new Set(PROVIDER_SOURCES.map((entry) => entry.sourceId)).size).toBe(127)
  })

  it("每个 canonical provider 恰好有一个目录定义", () => {
    const canonicalIds = new Set(PROVIDER_SOURCES.map((entry) => entry.canonicalId))
    expect(new Set(PROVIDER_PRESETS.map((preset) => preset.id)).size).toBe(PROVIDER_PRESETS.length)
    expect(new Set(PROVIDER_PRESETS.map((preset) => preset.id))).toEqual(canonicalIds)
    expect(PROVIDER_PRESETS).toHaveLength(94)
    expect(PROVIDER_PRESETS.filter((preset) => preset.directConnect)).toHaveLength(75)
  })

  it("每个目录项都保留来源和文档，直连项至少有一个 runtime", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.sourceIds.length, preset.id).toBeGreaterThan(0)
      expect(preset.docsUrl, preset.id).toMatch(/^https?:\/\//)
      if (preset.directConnect) {
        expect(Object.keys(preset.runtimes).length, preset.id).toBeGreaterThan(0)
        expect(preset.runtimes.pi, `${preset.id} 缺少 Pi runtime`).toBeDefined()
        for (const runtime of Object.values(preset.runtimes)) {
          expect(runtime?.baseUrl, preset.id).toMatch(/^https?:\/\//)
          if (runtime?.requestPath) expect(runtime.requestPath, preset.id).toMatch(/^\//)
        }
        if (preset.auth.method === "apiKey") {
          expect(preset.auth.inference.header.trim(), preset.id).not.toBe("")
        }
      }
    }
  })
})
