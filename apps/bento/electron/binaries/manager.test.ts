import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { BinaryManager, placeCodexCodeModeHost, sha256File } from "./manager"
import type { BinaryProgress } from "./progress"

let tempDir = ""

afterEach(() => {
  delete process.env.BENTO_CODEX_PATH
  delete process.env.BENTO_CODEX_CODE_MODE_HOST_PATH
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("BinaryManager", () => {
  it("优先使用显式覆盖的可执行文件", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-binary-test-"))
    const binary = path.join(tempDir, "codex")
    fs.writeFileSync(binary, "#!/bin/sh\n")
    fs.chmodSync(binary, 0o755)
    process.env.BENTO_CODEX_PATH = binary

    await expect(new BinaryManager(tempDir).ensure("codex")).resolves.toBe(binary)
    await expect(new BinaryManager(tempDir).installed("codex")).resolves.toBe(binary)
  })

  it("计算文件 SHA-256", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-hash-test-"))
    const file = path.join(tempDir, "fixture")
    fs.writeFileSync(file, "bento")
    const expected = createHash("sha256").update("bento").digest("hex")
    await expect(sha256File(file)).resolves.toBe(expected)
  })

  it("把 code-mode host 安装到 Codex 同目录并设为可执行", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-codex-host-test-"))
    const codex = path.join(tempDir, "codex")
    const source = path.join(tempDir, "downloaded-host")
    fs.writeFileSync(codex, "codex")
    fs.writeFileSync(source, "host")

    const sibling = await placeCodexCodeModeHost(codex, source)
    expect(sibling).toBe(path.join(tempDir, "codex-code-mode-host"))
    expect(fs.readFileSync(sibling, "utf8")).toBe("host")
    expect(fs.statSync(sibling).mode & 0o111).not.toBe(0)
  })

  it("临时目录创建失败时发送 error 终止进度", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-progress-test-"))
    const blockedRoot = path.join(tempDir, "not-a-directory")
    fs.writeFileSync(blockedRoot, "blocked")
    const progress: BinaryProgress[] = []
    const manager = new BinaryManager(
      blockedRoot,
      "darwin-arm64",
      (event) => progress.push(event),
    )

    await expect(manager.ensure("codex")).rejects.toThrow()
    expect(progress.map((event) => event.phase)).toEqual(["downloading", "error"])
  })
})
