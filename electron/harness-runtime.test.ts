import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  assertHarnessCwd,
  harnessRuntimeStatus,
  localHarnessExecutable,
  resolveHarnessRuntime,
} from "./harness-runtime"

let tempDir = ""
const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
  delete process.env.BENTO_HERMES_PATH
  delete process.env.BENTO_PI_PATH
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("Harness runtime resolution", () => {
  it("在 spawn 前把无效 cwd 报成明确的目录错误", () => {
    expect(() => assertHarnessCwd(path.join(os.tmpdir(), "bento-cwd-does-not-exist")))
      .toThrow(/项目目录不存在或不可访问/)
  })

  it("优先识别 PATH 中的本机 CLI 并读取版本", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-runtime-test-"))
    const hermes = path.join(tempDir, "hermes")
    fs.writeFileSync(hermes, "#!/bin/sh\necho 'Hermes 9.9.9'\n")
    fs.chmodSync(hermes, 0o755)
    process.env.PATH = tempDir

    expect(localHarnessExecutable("hermes")).toEqual({ path: hermes, source: "local" })
    await expect(harnessRuntimeStatus("hermes")).resolves.toMatchObject({
      source: "local",
      version: "Hermes 9.9.9",
      usable: true,
    })
  })

  it("Hermes 缺失时标记为按需受管 fallback", async () => {
    process.env.PATH = ""
    await expect(harnessRuntimeStatus("hermes")).resolves.toMatchObject({
      source: "managed",
      usable: true,
      fallbackAvailable: true,
    })
  })

  it("把 PATH 中的相对目录解析成绝对可执行路径", () => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), ".bento-runtime-relative-"))
    const relativeDir = path.relative(process.cwd(), tempDir)
    const pi = path.join(tempDir, "pi")
    fs.writeFileSync(pi, "#!/bin/sh\n")
    fs.chmodSync(pi, 0o755)
    process.env.PATH = relativeDir

    expect(localHarnessExecutable("pi")?.path).toBe(pi)
  })

  it("显式覆盖失效时继续使用 PATH 中的 CLI", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-runtime-test-"))
    const pi = path.join(tempDir, "pi")
    fs.writeFileSync(pi, "#!/bin/sh\n")
    fs.chmodSync(pi, 0o755)
    process.env.PATH = tempDir
    process.env.BENTO_PI_PATH = path.join(tempDir, "missing-pi")

    expect(localHarnessExecutable("pi")).toEqual({ path: pi, source: "local" })
  })

  it("native 偏好 PATH，Bento 偏好 managed，显式覆盖始终最高", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-runtime-test-"))
    const local = path.join(tempDir, "pi")
    const override = path.join(tempDir, "pi-override")
    fs.writeFileSync(local, "#!/bin/sh\n")
    fs.writeFileSync(override, "#!/bin/sh\n")
    fs.chmodSync(local, 0o755)
    fs.chmodSync(override, 0o755)
    process.env.PATH = tempDir
    const managed = vi.fn(async () => "managed")

    await expect(resolveHarnessRuntime("pi", "local", (path) => path, managed))
      .resolves.toBe(local)
    expect(managed).not.toHaveBeenCalled()

    await expect(resolveHarnessRuntime("pi", "managed", (path) => path, managed))
      .resolves.toBe("managed")
    process.env.BENTO_PI_PATH = override
    await expect(resolveHarnessRuntime("pi", "managed", (path) => path, managed))
      .resolves.toBe(override)
  })

  it("managed 不可用时才退回 PATH 中的 CLI", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-runtime-test-"))
    const local = path.join(tempDir, "opencode")
    fs.writeFileSync(local, "#!/bin/sh\n")
    fs.chmodSync(local, 0o755)
    process.env.PATH = tempDir

    await expect(resolveHarnessRuntime(
      "opencode",
      "managed",
      (path) => path,
      async () => { throw new Error("download failed") },
    )).resolves.toBe(local)
  })
})
