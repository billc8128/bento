/**
 * 权限裁决:三档权限 profile 的单一策略真源(docs/permission-management.md)。
 *
 * 纯函数、无 IO——renderer 与 driver 共用同一套判定,driver 只做参数翻译。
 * 只有 codex 的档位是 OS 沙箱强制的硬边界;claude/ACP 是工具集近似,
 * 看不到命令内部行为(Bash 放行 = curl 自由),UI 必须标注"非硬边界"。
 */

export type PermissionProfile = "restricted" | "standard" | "full"

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "standard"

export const PERMISSION_PROFILES: readonly {
  id: PermissionProfile
  name: string
  desc: string
}[] = [
  { id: "restricted", name: "受限", desc: "工作区内读写,禁网络,越界直接拒" },
  { id: "standard", name: "标准", desc: "工作区读写 + 网络放行,越界暂自动拒" },
  { id: "full", name: "放行", desc: "不设限,可写任意路径、可执行任意命令" },
]

/** 路径是否在工作区内(字符串层归一化)。symlink 逃逸由 electron 侧在调用前
 *  realpath 归一(electron/realpath.ts,claude/ACP 已接入;codex 是 OS 沙箱天然免疫)。 */
export function isPathInside(cwd: string, target: string): boolean {
  const normalize = (value: string) => {
    const unified = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return unified === "" ? "/" : unified
  }
  const root = normalize(cwd)
  const goal = normalize(target)
  if (!goal.startsWith("/")) return false // 相对路径无法判定,按越界处理
  return goal === root || goal.startsWith(`${root}/`)
}

// ---- claude:工具分类(canUseTool 只能看到工具名与参数,工具集近似) ----

export type ClaudeToolClass = "read" | "write-inside" | "write-outside" | "network" | "execute" | "other"

const CLAUDE_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead"])
const CLAUDE_WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"])
const CLAUDE_NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"])

export function classifyClaudeTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ClaudeToolClass {
  if (CLAUDE_READ_TOOLS.has(toolName)) return "read"
  if (CLAUDE_WRITE_TOOLS.has(toolName)) {
    // NotebookEdit 的路径字段是 notebook_path,不是 file_path
    const raw = input.file_path ?? input.notebook_path
    const filePath = typeof raw === "string" ? raw : ""
    return filePath && isPathInside(cwd, filePath) ? "write-inside" : "write-outside"
  }
  if (CLAUDE_NETWORK_TOOLS.has(toolName)) return "network"
  if (toolName.startsWith("mcp__")) return "other"
  return "execute"
}

/** 三态裁决:M2 起"越界"不再一律拒,标准档走审批卡问用户 */
export type PermissionTriage = "allow" | "ask" | "deny"

/** claude 档位裁决:受限只读+工作区内写、其余拒(不问);标准加网络/MCP,
 *  execute 与越界写走审批(有审批卡兜底,不再是 M1 的临时全拒) */
export function triageClaudeTool(
  profile: PermissionProfile,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionTriage {
  if (profile === "full") return "allow"
  const cls = classifyClaudeTool(toolName, input, cwd)
  if (cls === "read" || cls === "write-inside") return "allow"
  if (profile === "restricted") return "deny"
  if (cls === "network" || cls === "other") return "allow"
  return "ask"
}

// ---- ACP:按 toolCall.kind + locations 启发式判定 ----

export type AcpToolCallView = {
  kind?: string | null
  locations?: { path: string }[] | null
}

const ACP_READ_KINDS = new Set(["read", "search", "think"])

/** ACP 档位裁决:read/search/think + 工作区内 edit 恒放;restricted 其余拒;
 *  标准加 fetch,execute/越界 edit/未知 kind 走审批 */
export function triageAcpToolCall(
  profile: PermissionProfile,
  toolCall: AcpToolCallView,
  cwd: string,
): PermissionTriage {
  if (profile === "full") return "allow"
  const kind = toolCall.kind ?? "other"
  if (ACP_READ_KINDS.has(kind)) return "allow"
  if (kind === "edit") {
    const locations = toolCall.locations ?? []
    const inside = locations.length > 0 && locations.every((loc) => isPathInside(cwd, loc.path))
    if (inside) return "allow"
    return profile === "restricted" ? "deny" : "ask"
  }
  if (kind === "fetch") return profile === "restricted" ? "deny" : "allow"
  return profile === "restricted" ? "deny" : "ask"
}

// ---- codex:档位 → 沙箱参数(OS 沙箱硬边界) ----

export type CodexThreadPolicy = {
  sandbox: "read-only" | "workspace-write" | "danger-full-access"
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never"
}

/** thread/start 的基底策略:标准档起 on-request,越界走审批(M2) */
export function codexThreadPolicy(profile: PermissionProfile): CodexThreadPolicy {
  switch (profile) {
    case "restricted":
      return { sandbox: "workspace-write", approvalPolicy: "never" }
    case "standard":
      return { sandbox: "workspace-write", approvalPolicy: "on-request" }
    case "full":
      return { sandbox: "danger-full-access", approvalPolicy: "never" }
  }
}

/** turn/start 级覆盖(codex 0.149.1 实测支持):每回合随当前档位下发,
 *  会话中切档后续回合即生效。 */
export type CodexSandboxPolicy =
  | { type: "workspaceWrite"; networkAccess: boolean }
  | { type: "dangerFullAccess" }

export function codexSandboxPolicy(profile: PermissionProfile): CodexSandboxPolicy {
  switch (profile) {
    case "restricted":
      return { type: "workspaceWrite", networkAccess: false }
    case "standard":
      return { type: "workspaceWrite", networkAccess: true }
    case "full":
      return { type: "dangerFullAccess" }
  }
}
