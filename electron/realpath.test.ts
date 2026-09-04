import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { resolveRealPath } from "./realpath"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("resolveRealPath", () => {
  it("存在的目标直接 realpath", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rp-"))
    const resolved = resolveRealPath(tempDir)
    expect(resolved).toBe(fs.realpathSync(tempDir))
  })

  it("解开路径中间层的 symlink(逃逸场景)", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rp-link-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rp-out-"))
    // cwd 内一个指向外部目录的 symlink:字符串判定会误判为"工作区内"
    fs.symlinkSync(outside, path.join(tempDir, "innocent"))
    const resolved = resolveRealPath(path.join(tempDir, "innocent", "passwd"))
    expect(resolved).toBe(path.join(fs.realpathSync(outside), "passwd"))
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it("目标不存在时归一最近已存在祖先再拼回", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rp-new-"))
    const target = path.join(tempDir, "new-dir", "new-file.txt")
    expect(resolveRealPath(target)).toBe(path.join(fs.realpathSync(tempDir), "new-dir", "new-file.txt"))
  })

  it("相对路径不以进程 cwd 为基解析(fail-closed 原样返回)", () => {
    expect(resolveRealPath("etc/passwd")).toBe("etc/passwd")
  })
})
