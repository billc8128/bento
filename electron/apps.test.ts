import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BROWSER_APP_ID } from "../src/core/apps"
import { AppsStore } from "./apps"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("AppsStore", () => {
  it("Browser MCP 默认开启并持久化显式关闭", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apps-"))
    dirs.push(dir)
    const changed = vi.fn()
    const store = new AppsStore(dir, changed)
    expect(store.isEnabled(BROWSER_APP_ID)).toBe(true)
    expect(store.list()[0]).toMatchObject({ id: "browser", enabled: true })

    store.setEnabled(BROWSER_APP_ID, false)
    expect(changed).toHaveBeenCalledOnce()
    expect(new AppsStore(dir).isEnabled(BROWSER_APP_ID)).toBe(false)
  })
})
