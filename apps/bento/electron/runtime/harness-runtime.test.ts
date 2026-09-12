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

  it("PATH 有本机 CLI 时上报 managed 首选来源,本机安装转 localInstall 附注", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-runtime-test-"))
    const hermes = path.join(tempDir, "hermes")
    fs.writeFileSync(hermes, "#!/bin/sh\necho 'Hermes 9.9.9'\n")
    fs.chmodSync(hermes, 0o755)
    process.env.PATH = tempDir

    expect(localHarnessExecutable("hermes")).toEqual({ path: hermes, source: "local" })
    // 上报的是首选执行来源(managed),PATH 安装只是附注,会话不使用它;
    // 附注不探测版本(UI 不展示,spawn --version 白花时间)
    await expect(harnessRuntimeStatus("hermes")).resolves.toMatchObject({
      source: "managed",
      usable: true,
      fallbackAvailable: true,
      localInstall: { path: hermes },
    })
  })

  it("Hermes 缺失时标记为按需受管 fallback,无可退 PATH 安装", async () => {
    process.env.PATH = ""
    const status = await harnessRuntimeStatus("hermes")
    expect(status).toMatchObject({ source: "managed", usable: true, fallbackAvailable: false })
    expect(status.localInstall).toBeUndefined()
  })

  it("claude-code 无 PATH 回退:本机安装只作 localInstall 附注", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-runtime-cc-"))
    const claude = path.join(tempDir, "claude")
    fs.writeFileSync(claude, "#!/bin/sh\n")
    fs.chmodSync(claude, 0o755)
    process.env.PATH = tempDir

    const status = await harnessRuntimeStatus("claude-code")
    expect(status).toMatchObject({ source: "bundled", usable: true, fallbackAvailable: false })
    expect(status.localInstall?.path).toBe(claude)
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

  it("local 偏好 PATH，managed 偏好受管，显式覆盖始终最高", async () => {
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
