import { createHash } from "node:crypto"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  BinaryManager,
  configureBinaryManager,
  installBinaryUpdate,
  managedBinary,
  managedBinaryIfInstalled,
  placeCodexCodeModeHost,
  sha256File,
} from "./manager"
import { BINARY_MANIFEST } from "./manifest"
import { writeHarnessUpdates } from "./updates-store"
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

  it("安装非 baked 版本:静默下载 + installs 记录后运行时解析优先走新版本", async () => {
    // 模拟 userData:binaries 子目录给 manager,providers 子目录放更新记录
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-binary-update-"))
    tempDir = userDir
    // 超过 1MB 才会触发进度合并上报(manager 按 1MB 粒度回调)
    const payload = Buffer.concat([
      Buffer.from("#!/bin/sh\necho omp-18.1.0\n"),
      Buffer.alloc(1_100_000, 0x61),
    ])
    const sha256 = createHash("sha256").update(payload).digest("hex")
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/omp-darwin-arm64`
      const globalProgress: BinaryProgress[] = []
      configureBinaryManager(userDir, (event) => globalProgress.push(event))
      const fractions: number[] = []
      const target = await installBinaryUpdate("omp", {
        version: "18.1.0",
        artifact: { ...BINARY_MANIFEST.omp.platforms["darwin-arm64"]!, url, sha256 },
      }, (fraction) => fractions.push(fraction))
      expect(target).toContain(path.join("omp", "18.1.0"))
      expect(fs.readFileSync(target, "utf8")).toContain("omp-18.1.0")
      // 更新下载不进全局 binary:progress(行内进度回调才收得到)
      expect(globalProgress).toEqual([])
      expect(fractions.length).toBeGreaterThan(0)

      // 未记录 installs 前,无参解析仍走 baked pin(未安装 → null)
      await expect(managedBinaryIfInstalled("omp")).resolves.toBeNull()
      writeHarnessUpdates(userDir, {
        installs: { omp: { version: "18.1.0", url, sha256 } },
        latest: {},
      })
      // 已更新版本 > baked pin:解析直接命中已安装的新版本目录
      await expect(managedBinaryIfInstalled("omp")).resolves.toBe(target)
      await expect(managedBinary("omp")).resolves.toBe(target)
    } finally {
      server.close()
    }
  })
})
