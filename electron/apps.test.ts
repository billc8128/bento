import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BROWSER_APP_ID } from "../src/core/apps"
import { AppsStore, type AppSecretStore } from "./apps"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function memorySecrets(): AppSecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

describe("AppsStore", () => {
  it("Browser 默认开启；用户 App 配置持久化而凭证只进 secret store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apps-"))
    dirs.push(dir)
    const changed = vi.fn()
    const secrets = memorySecrets()
    const store = new AppsStore(dir, secrets, changed)
    expect(store.isEnabled(BROWSER_APP_ID)).toBe(true)

    store.upsert({
      name: "GitHub",
      transport: { type: "stdio", command: "npx", args: ["-y", "github-mcp"] },
      env: { GITHUB_TOKEN: "secret-token" },
    })
    expect(store.list()).toMatchObject([
      { id: "browser", source: "builtin", enabled: true },
      {
        id: "user-github",
        source: "user",
        transport: "stdio",
        hasSecrets: true,
        connection: { type: "stdio", command: "npx", args: ["-y", "github-mcp"] },
      },
    ])
    expect(store.enabledRuntimeApps()[0]).toMatchObject({
      id: "user-github",
      env: { GITHUB_TOKEN: "secret-token" },
    })
    expect(fs.readFileSync(path.join(dir, "apps.json"), "utf8")).not.toContain("secret-token")

    store.setEnabled("user-github", false)
    expect(store.enabledRuntimeApps()).toEqual([])
    store.remove("user-github")
    expect(store.list()).toHaveLength(1)
    expect(changed).toHaveBeenCalled()
  })

  it("新建时拒绝覆盖同名 App，显式编辑会保留未重填的凭证", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apps-edit-"))
    dirs.push(dir)
    const store = new AppsStore(dir, memorySecrets())
    store.upsert({
      name: "GitHub",
      transport: { type: "stdio", command: "npx", args: ["github-mcp"] },
      env: { GITHUB_TOKEN: "secret-token" },
    })

    expect(() => store.upsert({
      name: "GitHub",
      transport: { type: "stdio", command: "bunx", args: ["github-mcp"] },
    })).toThrow(/已存在/)
    expect(() => store.upsert({
      id: "user-missing",
      name: "Missing",
      transport: { type: "stdio", command: "bunx", args: [] },
    })).toThrow(/不存在/)

    store.upsert({
      id: "user-github",
      name: "GitHub MCP",
      transport: { type: "stdio", command: "bunx", args: ["github-mcp"] },
    })
    expect(store.list()[1]).toMatchObject({
      id: "user-github",
      name: "GitHub MCP",
      connection: { type: "stdio", command: "bunx", args: ["github-mcp"] },
      hasSecrets: true,
    })
    expect(store.enabledRuntimeApps()[0].env).toEqual({ GITHUB_TOKEN: "secret-token" })

    store.upsert({
      id: "user-github",
      name: "GitHub MCP",
      transport: { type: "http", url: "https://example.com/mcp" },
      clearSecrets: true,
    })
    expect(store.list()[1]).toMatchObject({ transport: "http", hasSecrets: false })
    expect(store.enabledRuntimeApps()[0]).toMatchObject({ env: {}, headers: {} })
  })

  it("远程 App 只允许 HTTPS 或 loopback HTTP", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apps-url-"))
    dirs.push(dir)
    const store = new AppsStore(dir, memorySecrets())
    expect(() => store.upsert({
      name: "Unsafe",
      transport: { type: "http", url: "http://example.com/mcp" },
    })).toThrow(/HTTPS/)
    expect(() => store.upsert({
      name: "Embedded secret",
      transport: { type: "http", url: "https://user:pass@example.com/mcp" },
    })).toThrow(/不能包含/)
    expect(() => store.upsert({
      name: "Local",
      transport: { type: "http", url: "http://127.0.0.1:3000/mcp" },
    })).not.toThrow()
  })
})
