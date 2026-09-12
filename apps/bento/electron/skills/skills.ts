/**
 * 全局 Skills 扫描 + 会话投递服务(main-only)。
 *
 * 扫描:~/.claude/skills、~/.agents/skills、~/.codex/skills、~/.kimi/skills、
 * ~/.config/agents/skills,解析每个 <name>/SKILL.md 的 frontmatter
 * (name 缺省取目录名);同名去重,优先级 ~/.claude > ~/.agents > ~/.codex >
 * ~/.kimi > ~/.config/agents,并记录每条 skill 的全部来源(UI badge 用)。
 *
 * 投递(会话 prepare 时物化;复制不软链,快照语义——新会话生效):
 *   claude   curated 根做成 local plugin(根下 .claude-plugin/plugin.json +
 *            skills/),driver 经 SDK plugins:[{type:'local',path}] 注入;
 *            settingSources=['project'] 不影响 local plugin skills 加载
 *            (调研:/tmp/skills-research.md §1)
 *   codex    复制进会话隔离 CODEX_HOME/skills(routed adapter)
 *   pi/omp   复制进 PI_CODING_AGENT_DIR/skills
 *   hermes   复制进 HERMES_HOME/skills(0.19.0 源码证实:get_skills_dir 跟随
 *            HERMES_HOME;external_dirs 默认空,无 ~/.agents 泄露)
 *   trae     复制进 TRAE_HOME/skills(traex 0.202.1 二进制证实:skills 根跟随
 *            TRAE_HOME)
 *   kimi     spawn args 追加 --skills-dir(会替换项目级发现,项目级目录需补传)
 *   opencode opencode.json 写 skills.paths + env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
 *
 * 开关状态:主进程只做内存缓存(renderer 经 skills:set 推送,localStorage 持久化
 * 在 renderer 侧——与 harness-preferences 同构)。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { SessionSkillsPlan } from "../session-config/types"
import type { GlobalSkill, SkillsPreferences } from "./skills-types"

export type { GlobalSkill, SkillsPreferences } from "./skills-types"

/** 扫描来源(顺序即去重优先级)。 */
export const SKILL_SOURCES = [
  { id: "claude", label: "~/.claude", relative: [".claude", "skills"] },
  { id: "agents", label: "~/.agents", relative: [".agents", "skills"] },
  { id: "codex", label: "~/.codex", relative: [".codex", "skills"] },
  { id: "kimi", label: "~/.kimi", relative: [".kimi", "skills"] },
  { id: "config-agents", label: "~/.config/agents", relative: [".config", "agents", "skills"] },
] as const

export type SkillSourceId = (typeof SKILL_SOURCES)[number]["id"]

/** renderer 可见的扫描结果(sources 为 label 列表,如 ["~/.claude","~/.agents"])。 */

/** 内部条目:dir 指向去重获胜来源的绝对路径(物化时的复制源)。 */
type SkillEntry = GlobalSkill & {
  dir: string
  source: SkillSourceId
}

/** 解析 SKILL.md frontmatter 的 name/description(单行标量;够用且不引 YAML 依赖)。 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return {}
  const out: { name?: string; description?: string } = {}
  let closed = false
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      closed = true
      break
    }
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, raw] = match
    const value = raw.trim().replace(/^["'](.*)["']$/, "$1").trim()
    if ((key === "name" || key === "description") && value && out[key] === undefined) {
      out[key] = value
    }
  }
  return closed ? out : {}
}

/** 扫描一个 skills 根下的条目目录;目录不存在或不可读返回空(容错)。 */
function scanSourceDir(root: string): Array<{ dirName: string; dir: string; frontmatter: { name?: string; description?: string } }> {
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: Array<{ dirName: string; dir: string; frontmatter: { name?: string; description?: string } }> = []
  for (const entry of names) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = path.join(root, entry.name)
    const skillFile = path.join(dir, "SKILL.md")
    let content: string
    try {
      content = fs.readFileSync(skillFile, "utf8")
    } catch {
      continue // 无 SKILL.md 的目录不是 skill
    }
    entries.push({ dirName: entry.name, dir, frontmatter: parseSkillFrontmatter(content) })
  }
  return entries
}

/** 扫描全部来源并按优先级去重;返回按 name 排序的列表。 */
export function scanSkills(homeDir: string = os.homedir()): SkillEntry[] {
  const byName = new Map<string, SkillEntry>()
  for (const source of SKILL_SOURCES) {
    const root = path.join(homeDir, ...source.relative)
    for (const item of scanSourceDir(root)) {
      const name = item.frontmatter.name?.trim() || item.dirName
      if (!name) continue
      const existing = byName.get(name)
      if (existing) {
        if (!existing.sources.includes(source.label)) existing.sources.push(source.label)
        continue
      }
      byName.set(name, {
        name,
        description: item.frontmatter.description?.trim() ?? "",
        sources: [source.label],
        dir: item.dir,
        source: source.id,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function normalizeSkillsPreferences(value: unknown): SkillsPreferences {
  const raw = (value ?? {}) as Partial<SkillsPreferences>
  return {
    allowGlobal: raw.allowGlobal !== false,
    disabledSkills: Array.isArray(raw.disabledSkills)
      ? raw.disabledSkills.filter((item): item is string => typeof item === "string")
      : [],
  }
}

/** cwd 向上到 git root 收集项目级 skills 目录(kimi 投递用;无 git root 时只看 cwd)。 */
export function discoverProjectSkillDirs(cwd: string): string[] {
  const chain: string[] = []
  let current = path.resolve(cwd)
  for (;;) {
    chain.push(current)
    if (fs.existsSync(path.join(current, ".git"))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const dirs: string[] = []
  // chain 本身就是 cwd → root 顺序,直接迭代即「就近优先」
  for (const dir of chain) {
    for (const rel of [".kimi", ".claude", ".codex", ".agents"]) {
      const candidate = path.join(dir, rel, "skills")
      if (fs.existsSync(candidate)) dirs.push(candidate)
    }
  }
  return dirs
}

/** claude local plugin 的最小 manifest(k68 只强制 name;version 便于辨识)。 */
export function buildClaudePluginManifest(): string {
  return `${JSON.stringify({
    name: "bento-skills",
    version: "1.0.0",
    description: "Bento curated global skills (session snapshot)",
  }, null, 2)}\n`
}

/**
 * 物化 curated 根:<root>/skills/<name>/… + <root>/claude-plugin/。
 * 复制不软链(dereference);先清空旧内容保证快照语义。
 */
export function materializeCuratedSkills(root: string, entries: Array<{ name: string; dir: string }>): string {
  fs.rmSync(root, { recursive: true, force: true })
  const skillsRoot = path.join(root, "skills")
  fs.mkdirSync(skillsRoot, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    fs.cpSync(entry.dir, path.join(skillsRoot, entry.name), { recursive: true, dereference: true })
  }
  const pluginRoot = path.join(root, "claude-plugin")
  fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true, mode: 0o700 })
  fs.cpSync(skillsRoot, path.join(pluginRoot, "skills"), { recursive: true })
  fs.writeFileSync(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    buildClaudePluginManifest(),
    { mode: 0o600 },
  )
  return root
}

export class SkillsService {
  private preferences: SkillsPreferences = { allowGlobal: true, disabledSkills: [] }

  constructor(
    private readonly userDataDir: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  /** renderer 的设置页展示用(不含内部 dir 字段)。 */
  scan(): GlobalSkill[] {
    return scanSkills(this.homeDir).map(({ name, description, sources }) => ({ name, description, sources }))
  }

  setPreferences(value: unknown): SkillsPreferences {
    this.preferences = normalizeSkillsPreferences(value)
    return this.preferences
  }

  getPreferences(): SkillsPreferences {
    return this.preferences
  }

  private sessionRoot(sessionKey: string): string {
    return path.join(this.userDataDir, "skills", sessionKey)
  }

  /** 会话 prepare 前调用:解析开关 → 物化 curated 根 → 发现项目级目录。 */
  async plan(request: { sessionKey: string; cwd: string }): Promise<SessionSkillsPlan> {
    const projectSkillDirs = discoverProjectSkillDirs(request.cwd)
    const prefs = this.preferences
    if (!prefs.allowGlobal) return { projectSkillDirs }
    const disabled = new Set(prefs.disabledSkills)
    const enabled = scanSkills(this.homeDir).filter((entry) => !disabled.has(entry.name))
    if (enabled.length === 0) return { projectSkillDirs }
    return {
      curatedRoot: materializeCuratedSkills(this.sessionRoot(request.sessionKey), enabled),
      projectSkillDirs,
    }
  }

  /** 会话状态彻底删除时同步清理物化目录(与 adapter.removeSessionState 同时机)。 */
  async removeSessionState(sessionKey: string): Promise<void> {
    await fs.promises.rm(this.sessionRoot(sessionKey), { recursive: true, force: true })
  }
}
