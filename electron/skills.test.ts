import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  discoverProjectSkillDirs,
  materializeCuratedSkills,
  parseSkillFrontmatter,
  scanSkills,
  SkillsService,
} from "./skills"

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function track<T extends string>(dir: T): T {
  tempDirs.push(dir)
  return dir
}

/** 在 home 下造一个 skill:<root>/<name>/SKILL.md(可省略 frontmatter)。 */
function makeSkill(home: string, root: string, name: string, frontmatter?: string, body = "do it") {
  const dir = path.join(home, root, name)
  fs.mkdirSync(dir, { recursive: true })
  const content = frontmatter === undefined ? body : `---\n${frontmatter}\n---\n\n${body}`
  fs.writeFileSync(path.join(dir, "SKILL.md"), content)
  return dir
}

function makeHome(): string {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-home-")))
}

describe("parseSkillFrontmatter", () => {
  it("解析 name/description(含引号形式),忽略未知字段", () => {
    expect(parseSkillFrontmatter(
      "---\nname: my-skill\ndescription: \"Do the thing, when asked\"\nlicense: MIT\n---\n\nbody",
    )).toEqual({ name: "my-skill", description: "Do the thing, when asked" })
  })

  it("无 frontmatter 或残缺围栏返回空对象", () => {
    expect(parseSkillFrontmatter("# Just markdown\n")).toEqual({})
    expect(parseSkillFrontmatter("---\nname: never-closed\n")).toEqual({})
  })
})

describe("scanSkills", () => {
  it("跨来源扫描 + 同名去重(优先级 claude > agents > codex > kimi > config-agents)+ 来源合并", () => {
    const home = makeHome()
    makeSkill(home, ".claude/skills", "shared", "name: shared\ndescription: claude wins")
    makeSkill(home, ".agents/skills", "shared", "name: shared\ndescription: agents copy")
    makeSkill(home, ".codex/skills", "shared", "name: shared\ndescription: codex copy")
    makeSkill(home, ".codex/skills", "only-codex", "description: 只在 codex")
    makeSkill(home, ".kimi/skills", "kimi-skill", "name: renamed\ndescription: frontmatter name 优先")

    const entries = scanSkills(home)
    const shared = entries.find((entry) => entry.name === "shared")!
    expect(shared.description).toBe("claude wins")
    expect(shared.dir).toBe(path.join(home, ".claude/skills/shared"))
    expect(shared.source).toBe("claude")
    expect(shared.sources).toEqual(["~/.claude", "~/.agents", "~/.codex"])

    // name 缺省取目录名;frontmatter name 与目录名不一致时以 frontmatter 为准
    const onlyCodex = entries.find((entry) => entry.name === "only-codex")!
    expect(onlyCodex.sources).toEqual(["~/.codex"])
    const kimi = entries.find((entry) => entry.name === "renamed")!
    expect(kimi.source).toBe("kimi")

    // 按 name 排序
    expect(entries.map((entry) => entry.name)).toEqual([...entries.map((entry) => entry.name)].sort())
  })

  it("缺失来源目录/无 SKILL.md 的目录/坏文件一律容错跳过", () => {
    const home = makeHome()
    // 只有 .claude 存在,其余四个来源缺失
    makeSkill(home, ".claude/skills", "good", "name: good\ndescription: ok")
    fs.mkdirSync(path.join(home, ".claude/skills/not-a-skill"), { recursive: true }) // 无 SKILL.md
    fs.writeFileSync(path.join(home, ".claude/skills/loose.md"), "x") // 散落文件不算
    const entries = scanSkills(home)
    expect(entries.map((entry) => entry.name)).toEqual(["good"])
    expect(entries[0]!.sources).toEqual(["~/.claude"])
  })
})

describe("materializeCuratedSkills", () => {
  it("复制不软链:skills/<name> 内容一致,claude-plugin 布局完整", () => {
    const home = makeHome()
    makeSkill(home, ".claude/skills", "alpha", "name: alpha\ndescription: a", "ALPHA BODY")
    // ~/.claude 下是 symlink 指向 ~/.agents——物化必须解引用
    fs.symlinkSync(
      path.join(home, ".agents/skills/bravo"),
      path.join(home, ".claude/skills/bravo"),
    )
    makeSkill(home, ".agents/skills", "bravo", "name: bravo\ndescription: b", "BRAVO BODY")
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-root-")))

    const entries = scanSkills(home)
    materializeCuratedSkills(root, entries)

    expect(fs.readFileSync(path.join(root, "skills/alpha/SKILL.md"), "utf8")).toContain("ALPHA BODY")
    const bravoStat = fs.lstatSync(path.join(root, "skills/bravo"))
    expect(bravoStat.isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(root, "skills/bravo/SKILL.md"), "utf8")).toContain("BRAVO BODY")

    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "claude-plugin/.claude-plugin/plugin.json"), "utf8"),
    ) as { name: string }
    expect(manifest.name).toBe("bento-skills")
    expect(fs.existsSync(path.join(root, "claude-plugin/skills/alpha/SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(root, "claude-plugin/skills/bravo/SKILL.md"))).toBe(true)
  })

  it("快照语义:重复物化同 root 先清空旧内容", () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-root2-")))
    fs.mkdirSync(path.join(root, "skills/stale"), { recursive: true })
    const home = makeHome()
    makeSkill(home, ".claude/skills", "fresh", "name: fresh\ndescription: f")

    materializeCuratedSkills(root, scanSkills(home))
    expect(fs.existsSync(path.join(root, "skills/stale"))).toBe(false)
    expect(fs.existsSync(path.join(root, "skills/fresh/SKILL.md"))).toBe(true)
  })
})

describe("discoverProjectSkillDirs", () => {
  it("cwd 向上到 git root 收集 .kimi/.claude/.codex/.agents skills,git root 之上不收", () => {
    const base = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-proj-")))
    const repo = path.join(base, "repo")
    const nested = path.join(repo, "packages/app")
    fs.mkdirSync(path.join(nested, ".claude", "skills"), { recursive: true })
    fs.mkdirSync(path.join(repo, ".agents", "skills"), { recursive: true })
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
    fs.mkdirSync(path.join(base, ".kimi", "skills"), { recursive: true }) // git root 之上:不收

    expect(discoverProjectSkillDirs(nested)).toEqual([
      path.join(nested, ".claude/skills"),
      path.join(repo, ".agents/skills"),
    ])
  })

  it("无 git root 时只看 cwd 本层", () => {
    const base = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-nogit-")))
    fs.mkdirSync(path.join(base, ".codex", "skills"), { recursive: true })
    expect(discoverProjectSkillDirs(base)).toEqual([path.join(base, ".codex/skills")])
  })
})

describe("SkillsService", () => {
  it("plan:默认全启用并物化 curated 根;禁用项不进快照;主开关关闭不物化但项目级目录照常", async () => {
    const home = makeHome()
    makeSkill(home, ".claude/skills", "alpha", "name: alpha\ndescription: a")
    makeSkill(home, ".claude/skills", "beta", "name: beta\ndescription: b")
    const userData = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-userdata-")))
    const project = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-cwd-")))
    fs.mkdirSync(path.join(project, ".claude", "skills"), { recursive: true })
    const service = new SkillsService(userData, home)

    // 默认 allowGlobal=true:curatedRoot 物化,两个 skill 都在
    const planOn = await service.plan({ sessionKey: "s1", cwd: project })
    expect(planOn.curatedRoot).toBeDefined()
    expect(fs.existsSync(path.join(planOn.curatedRoot!, "skills/alpha/SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(planOn.curatedRoot!, "skills/beta/SKILL.md"))).toBe(true)
    expect(planOn.projectSkillDirs).toEqual([path.join(project, ".claude/skills")])

    // 禁用 beta:新会话快照里没有 beta(alpha 仍在)
    service.setPreferences({ allowGlobal: true, disabledSkills: ["beta"] })
    const planOff = await service.plan({ sessionKey: "s2", cwd: project })
    expect(fs.existsSync(path.join(planOff.curatedRoot!, "skills/alpha/SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(planOff.curatedRoot!, "skills/beta"))).toBe(false)

    // 主开关关闭:不物化(curatedRoot 缺省),项目级目录仍返回
    service.setPreferences({ allowGlobal: false, disabledSkills: [] })
    const planDisabled = await service.plan({ sessionKey: "s3", cwd: project })
    expect(planDisabled.curatedRoot).toBeUndefined()
    expect(planDisabled.projectSkillDirs).toEqual([path.join(project, ".claude/skills")])
  })

  it("removeSessionState 清理物化目录;scan() 不泄漏内部 dir 字段", async () => {
    const home = makeHome()
    makeSkill(home, ".claude/skills", "alpha", "name: alpha\ndescription: a")
    const userData = track(fs.mkdtempSync(path.join(os.tmpdir(), "bento-skills-userdata2-")))
    const service = new SkillsService(userData, home)
    expect(service.scan()).toEqual([
      { name: "alpha", description: "a", sources: ["~/.claude"] },
    ])
    const plan = await service.plan({ sessionKey: "s1", cwd: userData })
    expect(fs.existsSync(plan.curatedRoot!)).toBe(true)
    await service.removeSessionState("s1")
    expect(fs.existsSync(plan.curatedRoot!)).toBe(false)
  })
})
