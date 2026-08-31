/**
 * Agent 协作基础设施(Core 侧类型与纯函数)。
 *
 * 定义 docs/agent-collaboration.md 中的协作协议:Workspace 寻址、Session 投影、
 * 消息来源、工具输入输出与稳定错误码。本文件不 import 任何 UI 或 Electron,
 * main 侧实现在 electron/collaboration-service.ts。
 */

import type { Effort, SessionScope } from "./types"
import type { HarnessId } from "./harness"

export type WorkspaceRef =
  | { scope: "chat" }
  | { scope: "project"; cwd: string }

export type SessionRuntimeStatus = "sleeping" | "idle" | "working"

export type UiPlacement = "auto" | "right" | "down"

export type UiDirection = "left" | "right" | "above" | "below"

/**
 * 当前可见 Session 的空间邻接关系。它是 UI 的瞬时投影，不是持久化领域模型；
 * Agent 先把“右侧/上方”等指代解析成 sessionId，再使用 session_* 工具协作。
 */
export type UiSessionAdjacency = {
  sessionId: string
  neighbors: Partial<Record<UiDirection, string>>
}

export type UiSessionRect = {
  sessionId: string
  left: number
  top: number
  width: number
  height: number
}

export type UiCommand =
  | {
      type: "show-session"
      sessionId: string
      anchorSessionId?: string
      placement: UiPlacement
      focus: boolean
    }
  | { type: "hide-session"; sessionId: string }
  | { type: "focus-session"; sessionId: string }

export type UiPresence = {
  visibleSessionIds: string[]
  focusedSessionId: string | null
  layoutMode: "managed" | "free"
  adjacency: UiSessionAdjacency[]
}

export type UiShowOptions = {
  anchorSessionId?: string
  placement?: UiPlacement
  focus?: boolean
}

export type CollaborationSession = {
  id: string
  title: string
  workspace: WorkspaceRef
  harnessId: HarnessId
  providerId: string
  modelId: string
  effort?: Effort
  runtime: SessionRuntimeStatus
  updatedAt: string
  lastSeq: number
}

export type MessageOrigin =
  | { kind: "human" }
  | {
      kind: "session"
      sessionId: string
      title: string
      harnessId: HarnessId
    }

export type SessionMessage = {
  seqStart: number
  seqEnd: number
  at: string
  role: "user" | "assistant" | "notice"
  text: string
  origin?: MessageOrigin
}

// ---------- workspace 投影 ----------

/** 历史事件缺 origin 时按 human 回放。 */
export const HUMAN_ORIGIN: MessageOrigin = { kind: "human" }

export function normalizeOrigin(origin?: MessageOrigin): MessageOrigin {
  return origin ?? HUMAN_ORIGIN
}

export function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef): boolean {
  if (a.scope !== b.scope) return false
  if (a.scope === "chat" && b.scope === "chat") return true
  return (
    a.scope === "project" &&
    b.scope === "project" &&
    a.cwd === b.cwd
  )
}

export function workspaceKey(workspace: WorkspaceRef): string {
  return workspace.scope === "chat" ? "chat" : `project:${workspace.cwd}`
}

export type WorkspaceSummary = {
  workspace: WorkspaceRef
  sessionCount: number
  workingCount: number
}

/** 把 Session 列表按 scope/cwd 归并成只读 Workspace 投影。 */
export function summarizeWorkspaces(
  sessions: CollaborationSession[],
): WorkspaceSummary[] {
  const byKey = new Map<string, WorkspaceSummary>()
  for (const session of sessions) {
    const key = workspaceKey(session.workspace)
    let entry = byKey.get(key)
    if (!entry) {
      entry = { workspace: session.workspace, sessionCount: 0, workingCount: 0 }
      byKey.set(key, entry)
    }
    entry.sessionCount += 1
    if (session.runtime === "working") entry.workingCount += 1
  }
  return [...byKey.values()]
}

// ---------- 工具输入输出 ----------

export type RuntimeSnapshotResult = {
  selfSessionId: string
  workspaces: WorkspaceSummary[]
  sessions: CollaborationSession[]
  ui: { available: boolean } & UiPresence
  revision: number
}

export type UiNeighborInput = {
  direction: UiDirection
  /** 缺省从调用者自身开始，也可显式查询任一可见 Session。 */
  fromSessionId?: string
}

export type UiNeighborResult = {
  fromSessionId: string
  direction: UiDirection
  session: CollaborationSession | null
}

export type SessionListInput = {
  scope?: SessionScope
  cwd?: string
  runtime?: SessionRuntimeStatus
}

export type SessionListResult = {
  selfSessionId: string
  sessions: CollaborationSession[]
}

export function filterSessions(
  sessions: CollaborationSession[],
  input: SessionListInput,
): CollaborationSession[] {
  return sessions.filter((session) => {
    if (input.scope && session.workspace.scope !== input.scope) return false
    if (input.cwd) {
      // 只要传了 cwd 就按 project cwd 过滤,不要求同时传 scope。
      if (session.workspace.scope !== "project" || session.workspace.cwd !== input.cwd) {
        return false
      }
    }
    if (input.runtime && session.runtime !== input.runtime) return false
    return true
  })
}

export type SessionCreateInput = {
  title?: string
  prompt?: string

  scope?: SessionScope
  cwd?: string
  harnessId?: HarnessId
  providerId?: string
  modelId?: string
  effort?: Effort

  show?: boolean
  placement?: "auto" | "right" | "down"
  focus?: boolean

  wait?: boolean
  timeoutMs?: number
}

export type SessionCreatePromptOutcome =
  | "not_requested"
  | "accepted"
  | "settled"
  | "failed"

export type SessionCreateResult = {
  session: CollaborationSession
  prompt: SessionCreatePromptOutcome
  /** show 命令结果:queued=已投递;hidden=show:false;unavailable=无桥或投递失败 */
  ui: "queued" | "hidden" | "unavailable"
  reply?: SessionMessage
  error?: { code: string; message: string }
}

export type SessionSendInput = {
  targetSessionId: string
  text: string
  wait?: boolean
  timeoutMs?: number
}

export type SessionSendResult = {
  targetSessionId: string
  status: "accepted" | "settled"
  acceptedSeq: number
  reply?: SessionMessage
}

export type SessionReadInput = {
  targetSessionId: string
  afterSeq?: number
  limit?: number
  includeTools?: boolean
}

export type SessionReadResult = {
  sessionId: string
  messages: SessionMessage[]
  nextSeq: number
  truncated: boolean
}

export const DEFAULT_READ_LIMIT = 20
export const MAX_READ_LIMIT = 50

export type SessionWaitInput = {
  targetSessionId: string
  until?: "working" | "settled" | "next_message"
  afterSeq?: number
  timeoutMs?: number
}

export type SessionWaitResult = {
  session: CollaborationSession
  matched: "working" | "settled" | "next_message"
  lastSeq: number
}

// ---------- 错误语义 ----------

export type CollaborationErrorCode =
  | "caller_not_found"
  | "self_target"
  | "session_not_found"
  | "session_busy"
  | "session_unavailable"
  | "workspace_not_found"
  | "selection_unavailable"
  | "session_created_prompt_failed"
  | "ui_unavailable"
  | "ui_session_not_visible"
  | "invalid_input"
  | "timeout"

const DEFAULT_MESSAGES: Record<CollaborationErrorCode, string> = {
  caller_not_found: "调用者 Session 不存在",
  self_target: "目标不能是调用 Session 自身",
  session_not_found: "目标 Session 不存在或已删除",
  session_busy: "目标 Session 正在运行中,请稍后再试",
  session_unavailable: "目标 Session 无法恢复运行时",
  workspace_not_found: "引用的 Workspace 不存在",
  selection_unavailable: "指定的 Provider/Model 当前不可执行",
  session_created_prompt_failed: "Session 已创建,但首个 Prompt 执行失败",
  ui_unavailable: "当前没有可接收 UI 命令的窗口",
  ui_session_not_visible: "起始 Session 当前不在可见布局中",
  invalid_input: "输入参数不合法",
  timeout: "等待超时",
}

export class CollaborationError extends Error {
  readonly code: CollaborationErrorCode

  constructor(code: CollaborationErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code])
    this.name = "CollaborationError"
    this.code = code
  }
}

/** envelope 里的 title 归一成单行并限长,防换行伪造消息头。 */
function sanitizeTitle(title: string): string {
  const singleLine = title.replace(/\s+/g, " ").replace(/\[|\]/g, "").trim()
  if (singleLine.length <= 40) return singleLine
  return `${singleLine.slice(0, 39)}…`
}

/** 跨 Session 消息的最小可读 envelope,不落 JSONL。 */
export function buildEnvelope(origin: MessageOrigin, text: string): string {
  if (origin.kind !== "session") return text
  const shortId = origin.sessionId.slice(0, 8)
  return `[Bento message from "${sanitizeTitle(origin.title)}" / session ${shortId}]\n\n${text}`
}

// ---------- UI 空间投影 ----------

const UI_DIRECTIONS: UiDirection[] = ["left", "right", "above", "below"]

/**
 * 从实际可见区域计算每个 Session 在四个方向上的最近邻。
 * 优先选择与起点在垂直/水平投影上相交的候选，再比较边缘距离；这样在不规则
 * Dockview 树中，“右侧”会指向同一行的面板，而不是更近但斜下方的面板。
 */
export function deriveUiAdjacency(rects: UiSessionRect[]): UiSessionAdjacency[] {
  const centerX = (rect: UiSessionRect) => rect.left + rect.width / 2
  const centerY = (rect: UiSessionRect) => rect.top + rect.height / 2
  const right = (rect: UiSessionRect) => rect.left + rect.width
  const bottom = (rect: UiSessionRect) => rect.top + rect.height

  function candidateScore(
    source: UiSessionRect,
    candidate: UiSessionRect,
    direction: UiDirection,
  ): [number, number, number, number] | null {
    const horizontal = direction === "left" || direction === "right"
    const forward = direction === "right"
      ? centerX(candidate) - centerX(source)
      : direction === "left"
        ? centerX(source) - centerX(candidate)
        : direction === "below"
          ? centerY(candidate) - centerY(source)
          : centerY(source) - centerY(candidate)
    if (forward <= 0.5) return null

    const perpendicularGap = horizontal
      ? Math.max(0, candidate.top - bottom(source), source.top - bottom(candidate))
      : Math.max(0, candidate.left - right(source), source.left - right(candidate))
    const primaryGap = direction === "right"
      ? Math.max(0, candidate.left - right(source))
      : direction === "left"
        ? Math.max(0, source.left - right(candidate))
        : direction === "below"
          ? Math.max(0, candidate.top - bottom(source))
          : Math.max(0, source.top - bottom(candidate))
    const perpendicularCenterDistance = horizontal
      ? Math.abs(centerY(candidate) - centerY(source))
      : Math.abs(centerX(candidate) - centerX(source))

    return [perpendicularGap === 0 ? 0 : 1, primaryGap, perpendicularGap, perpendicularCenterDistance]
  }

  function compareScore(a: number[], b: number[]): number {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i]
    }
    return 0
  }

  return rects.map((source) => {
    const neighbors: Partial<Record<UiDirection, string>> = {}
    for (const direction of UI_DIRECTIONS) {
      let best: { sessionId: string; score: number[] } | null = null
      for (const candidate of rects) {
        if (candidate.sessionId === source.sessionId) continue
        const score = candidateScore(source, candidate, direction)
        if (!score) continue
        if (!best || compareScore(score, best.score) < 0) {
          best = { sessionId: candidate.sessionId, score }
        }
      }
      if (best) neighbors[direction] = best.sessionId
    }
    return { sessionId: source.sessionId, neighbors }
  })
}
