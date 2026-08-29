import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  vi.resetModules()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
})

afterEach(() => vi.unstubAllGlobals())

describe("folder preferences", () => {
  it("持久化置顶、别名与侧栏隐藏，并支持重新显示", async () => {
    const preferences = await import("./folder-preferences")
    const cwd = "/workspace/creative"

    preferences.toggleFolderPin(cwd)
    preferences.renameFolder(cwd, "创意")
    preferences.hideFolder(cwd)

    let saved = JSON.parse(values.get("bento.folder-preferences")!)
    expect(saved).toEqual({ pinned: [cwd], hidden: [cwd], aliases: { [cwd]: "创意" } })

    preferences.showFolder(cwd)
    saved = JSON.parse(values.get("bento.folder-preferences")!)
    expect(saved.hidden).toEqual([])
  })
})
