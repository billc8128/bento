import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  addPermissionRule,
  listPermissionRulesByProject,
  loadPermissionRules,
  removePermissionRule,
} from "./permission-rules"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("permission-rules 项目级持久化", () => {
  it("增删查与幂等", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rules-"))
    expect(loadPermissionRules(tempDir)).toEqual([])

    expect(addPermissionRule(tempDir, "claude-code", "Bash")).toBe(true)
    expect(addPermissionRule(tempDir, "claude-code", "Bash")).toBe(false) // 幂等
    expect(addPermissionRule(tempDir, "kimi", "Bash")).toBe(true)
    expect(loadPermissionRules(tempDir).map((r) => `${r.harnessId}:${r.rule}`))
      .toEqual(["claude-code:Bash", "kimi:Bash"])

    // 写入的是项目内 .bento/permissions.json,且权限收紧
    const file = path.join(tempDir, ".bento", "permissions.json")
    expect(fs.existsSync(file)).toBe(true)
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600")

    expect(removePermissionRule(tempDir, "claude-code", "Bash")).toBe(true)
    expect(removePermissionRule(tempDir, "claude-code", "Bash")).toBe(false)
    expect(loadPermissionRules(tempDir).map((r) => r.harnessId)).toEqual(["kimi"])
  })

  it("listPermissionRulesByProject 只列有规则的项目并去重", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rules-list-"))
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rules-empty-"))
    addPermissionRule(tempDir, "claude-code", "Edit")
    const groups = listPermissionRulesByProject([tempDir, other, tempDir])
    expect(groups).toHaveLength(1)
    expect(groups[0].cwd).toBe(tempDir)
    expect(groups[0].rules.map((r) => r.rule)).toEqual(["Edit"])
    fs.rmSync(other, { recursive: true, force: true })
  })
})
