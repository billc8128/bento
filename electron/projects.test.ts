import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createProject } from "./projects"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("createProject", () => {
  it("在源文件夹下创建项目目录", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-project-test-"))
    const created = createProject(tempDir, "new-project")
    expect(created).toBe(path.join(tempDir, "new-project"))
    expect(fs.statSync(created).isDirectory()).toBe(true)
  })

  it("拒绝路径穿越和重复目录", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-project-test-"))
    expect(() => createProject(tempDir, "../escape")).toThrow("路径分隔符")
    fs.mkdirSync(path.join(tempDir, "exists"))
    expect(() => createProject(tempDir, "exists")).toThrow()
  })
})
