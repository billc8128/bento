/**
 * 「总是允许」规则的项目级持久化(main 侧;driver 红线不写文件,规则经
 * HarnessStartOptions 注入、经 metadata 事件回报新增)。
 * 落点:<cwd>/.bento/permissions.json——写进项目目录是有意的(与 .claude/.codex
 * 同类),规则跟着项目走、可入版本库共享。
 */

import fs from "node:fs"
import path from "node:path"

export type PermissionRule = {
  harnessId: string
  /** 规则键:claude=工具名(如 "Bash") */
  rule: string
  createdAt: string
}

type RulesFile = {
  version: 1
  rules: PermissionRule[]
}

function rulesPath(cwd: string): string {
  return path.join(cwd, ".bento", "permissions.json")
}

export function loadPermissionRules(cwd: string): PermissionRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(rulesPath(cwd), "utf8")) as RulesFile
    return Array.isArray(parsed.rules) ? parsed.rules : []
  } catch {
    return []
  }
}

function savePermissionRules(cwd: string, rules: PermissionRule[]) {
  const file = rulesPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload: RulesFile = { version: 1, rules }
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

/** 新增规则(幂等);返回是否真的有变化 */
export function addPermissionRule(cwd: string, harnessId: string, rule: string): boolean {
  const rules = loadPermissionRules(cwd)
  if (rules.some((item) => item.harnessId === harnessId && item.rule === rule)) return false
  rules.push({ harnessId, rule, createdAt: new Date().toISOString() })
  savePermissionRules(cwd, rules)
  return true
}

export function removePermissionRule(cwd: string, harnessId: string, rule: string): boolean {
  const rules = loadPermissionRules(cwd)
  const next = rules.filter((item) => !(item.harnessId === harnessId && item.rule === rule))
  if (next.length === rules.length) return false
  savePermissionRules(cwd, next)
  return true
}

/** 规则面板用:给定项目目录集合,列出有规则的项 */
export function listPermissionRulesByProject(cwds: string[]): { cwd: string; rules: PermissionRule[] }[] {
  const seen = new Set<string>()
  const out: { cwd: string; rules: PermissionRule[] }[] = []
  for (const cwd of cwds) {
    if (seen.has(cwd)) continue
    seen.add(cwd)
    const rules = loadPermissionRules(cwd)
    if (rules.length > 0) out.push({ cwd, rules })
  }
  return out
}
