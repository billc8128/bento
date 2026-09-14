import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  compareBinaryVersions,
  harnessUpdatesFile,
  readHarnessUpdates,
  writeHarnessUpdates,
} from "../binaries/updates-store"
import {
  fetchGithubLatest,
  fetchPypiLatest,
  fetchTraeLatest,
  HarnessUpdatesService,
} from "./harness-updates"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-harness-updates-"))
  dirs.push(dir)
  return dir
}

/** 按 URL 路由的 fake fetch:GitHub API / PyPI / trae CDN 三种形状。 */
function fakeFetch(routes: Record<string, unknown | (() => Response)>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    for (const [prefix, payload] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue
      if (typeof payload === "function") return payload()
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
}

describe("compareBinaryVersions", () => {
  it("剥 rust-v/v 前缀后相等不算更新", () => {
    expect(compareBinaryVersions("rust-v0.153.4", "0.153.4")).toBe(0)
    expect(compareBinaryVersions("v18.0.4", "18.0.4")).toBe(0)
  })
  it("剥 -tob 后缀后按数字元组比较", () => {
    expect(compareBinaryVersions("0.202.1-tob", "0.204.1-tob")).toBeLessThan(0)
    expect(compareBinaryVersions("0.153.4", "0.155.1")).toBeLessThan(0)
    expect(compareBinaryVersions("1.18.21", "1.19.0")).toBeLessThan(0)
  })
  it("元组长度不齐时按缺位 0 比较(1.49.0 ≡ 1.49)", () => {
    expect(compareBinaryVersions("1.49.1", "1.49")).toBeGreaterThan(0)
    expect(compareBinaryVersions("1.49.0", "1.49")).toBe(0)
  })
})

describe("上游响应解析", () => {
  it("GitHub releases/latest:tag 剥前缀、资产按名匹配、digest 剥 sha256: 前缀;缺失 digest 则 sha 留空(TOFU)", async () => {
    const fetchImpl = fakeFetch({
      "https://api.github.com/repos/openai/codex/releases/latest": {
        tag_name: "rust-v0.155.1",
        assets: [
          { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz", digest: "sha256:aa11" },
          { name: "codex-code-mode-host-aarch64-apple-darwin.tar.gz", browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-code-mode-host-aarch64-apple-darwin.tar.gz" },
          { name: "unrelated-asset" },
        ],
      },
    })
    const release = await fetchGithubLatest("openai/codex", [
      { binary: "codex", name: "codex-aarch64-apple-darwin.tar.gz" },
      { binary: "codex-code-mode-host", name: "codex-code-mode-host-aarch64-apple-darwin.tar.gz" },
    ], fetchImpl)
    expect(release).toMatchObject({
      version: "0.155.1",
      artifacts: [
        { binary: "codex", sha256: "aa11" },
        { binary: "codex-code-mode-host", url: expect.stringContaining("codex-code-mode-host") },
      ],
    })
    expect(release!.artifacts[1].sha256).toBeUndefined()
  })

  it("GitHub 缺少期望资产时判为检查失败(null)", async () => {
    const fetchImpl = fakeFetch({
      "https://api.github.com/repos/can1357/oh-my-pi/releases/latest": {
        tag_name: "v18.1.0",
        assets: [{ name: "omp-linux-x86_64" }],
      },
    })
    await expect(fetchGithubLatest("can1357/oh-my-pi", [
      { binary: "omp", name: "omp-darwin-arm64" },
    ], fetchImpl)).resolves.toBeNull()
  })

  it("trae CDN:latest 失败退 fallback.json,取 macos-aarch64 产物", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("v2/latest.json")) return new Response("boom", { status: 500 })
      if (url.endsWith("v2/fallback.json")) {
        return new Response(JSON.stringify({
          version: "0.204.1-tob",
          artifacts: [
            { platform: "macos-x86_64", url: "https://lf-cdn.trae.com.cn/x86.gz", sha256: "x" },
            { platform: "macos-aarch64", url: "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.204.1-tob/traex-macos-aarch64.gz", sha256: "bb22" },
          ],
        }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }) as unknown as typeof fetch
    await expect(fetchTraeLatest(fetchImpl)).resolves.toMatchObject({
      version: "0.204.1-tob",
      artifacts: [{ binary: "trae", sha256: "bb22" }],
    })
  })

  it("PyPI JSON API 取 info.version;404 返回 null", async () => {
    const ok = fakeFetch({ "https://pypi.org/pypi/hermes-agent/json": { info: { version: "0.21.0" } } })
    await expect(fetchPypiLatest("hermes-agent", ok)).resolves.toBe("0.21.0")
    const missing = fakeFetch({})
    await expect(fetchPypiLatest("hermes-agent", missing)).resolves.toBeNull()
  })
})

describe("updates store", () => {
  it("读写往返 + 原子写不留 tmp;损坏文件按空状态读", () => {
    const dir = tempDir()
    writeHarnessUpdates(dir, {
      installs: { trae: { version: "0.204.1-tob", url: "https://lf-cdn.trae.com.cn/a.gz", sha256: "bb22" } },
      latest: { codex: "0.155.1" },
      checkedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(readHarnessUpdates(dir)).toMatchObject({
      installs: { trae: { version: "0.204.1-tob" } },
      latest: { codex: "0.155.1" },
    })
    expect(fs.readdirSync(path.dirname(harnessUpdatesFile(dir)))).toEqual(["harness-updates.json"])
    fs.writeFileSync(harnessUpdatesFile(dir), "{corrupted")
    expect(readHarnessUpdates(dir)).toEqual({ installs: {}, latest: {} })
  })
})

describe("HarnessUpdatesService", () => {
  const routes = {
    "https://api.github.com/repos/openai/codex/releases/latest": {
      tag_name: "rust-v0.155.1",
      assets: [
        { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-aarch64-apple-darwin.tar.gz", digest: "sha256:aa11" },
        { name: "codex-code-mode-host-aarch64-apple-darwin.tar.gz", browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-code-mode-host-aarch64-apple-darwin.tar.gz" },
      ],
    },
    "https://pypi.org/pypi/hermes-agent/json": { info: { version: "0.21.0" } },
  }

  it("check:结果落盘(重启后提示不丢),上游失败的 harness 保留旧 latest", async () => {
    const dir = tempDir()
    writeHarnessUpdates(dir, { installs: {}, latest: { kimi: "1.49.0" } })
    const service = new HarnessUpdatesService(dir, () => {}, fakeFetch(routes))
    await service.check()
    const state = readHarnessUpdates(dir)
    expect(state.latest.codex).toBe("0.155.1")
    expect(state.latest.hermes).toBe("0.21.0")
    expect(state.latest.kimi).toBe("1.49.0") // GitHub 404 → 保留旧值
    expect(state.checkedAt).toBeTruthy()
    const codex = service.status().find((row) => row.harnessId === "codex")
    expect(codex).toMatchObject({ current: "0.153.4", latest: "0.155.1", state: "available" })
    const kimi = service.status().find((row) => row.harnessId === "kimi")
    expect(kimi).toMatchObject({ state: "current" })
  })

  it("hermes 更新只换 pin(无下载),install 落盘后状态 updated", async () => {
    const dir = tempDir()
    const events: string[] = []
    const service = new HarnessUpdatesService(dir, () => events.push("changed"), fakeFetch(routes))
    await service.check()
    await service.update("hermes")
    const state = readHarnessUpdates(dir)
    expect(state.installs.hermes).toEqual({ version: "0.21.0" })
    expect(service.status().find((row) => row.harnessId === "hermes")).toMatchObject({
      current: "0.21.0",
      state: "updated",
    })
    expect(events.length).toBeGreaterThan(0)
    service.dispose()
  })

  it("二进制更新失败(下载域非白名单)进 failed,可重试", async () => {
    const dir = tempDir()
    const badHost = fakeFetch({
      "https://api.github.com/repos/openai/codex/releases/latest": {
        tag_name: "rust-v0.155.1",
        assets: [
          { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "https://evil.example.com/codex.tar.gz", digest: "sha256:aa11" },
          { name: "codex-code-mode-host-aarch64-apple-darwin.tar.gz", browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.155.1/host.tar.gz" },
        ],
      },
    })
    const service = new HarnessUpdatesService(dir, () => {}, badHost)
    await service.update("codex")
    expect(service.status().find((row) => row.harnessId === "codex")).toMatchObject({ state: "failed" })
    expect(readHarnessUpdates(dir).installs.codex).toBeUndefined()
    service.dispose()
  })
})
