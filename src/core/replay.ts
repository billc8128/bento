/**
 * 事件日志 → 消息流的 reducer(ARCHITECTURE.md §9 v0.3):
 * 实时流式与历史回放共用这一条代码路径,禁止各写一份。
 * 纯函数,无 UI、无 IO。
 */

import type { HarnessEvent, HarnessToolDiff, HarnessUsage, LogRecord } from "./events"
import type { ActivityItem, Message, PlanItem, ToolCall } from "./types"

export type { LogRecord } from "./events"

/** ACP ToolKind → 本地四类图标的映射,未知一律当 bash */
function toolKind(k: unknown): ToolCall["kind"] {
  switch (k) {
    case "read":
      return "read"
    case "edit":
    case "delete":
    case "move":
      return "edit"
    case "search":
    case "fetch":
      return "search"
    default:
      return "bash"
  }
}

function toolStatus(s: unknown): ToolCall["status"] {
  switch (s) {
    case "completed":
      return "done"
    case "failed":
      return "failed"
    default:
      return "running"
  }
}

type Draft = {
  text: string
  thinking: string
  tools: ToolCall[]
  toolIndex: Map<string, number>
  activity: ActivityItem[]
  /** 首个进入 draft 的事件时间(epoch ms),回合 durationMs 的起点 */
  startedAtMs: number
  /** 回合计划清单(ACP plan 事件整体替换,§7 P4) */
  plan?: PlanItem[]
}

/** §3.3:合并工具更新;status 进入终态且存在 startedAtMs 时以 at 差写 durationMs;
 * diffs/output/url 两侧事件同样透传,后者覆盖前者(§3.1、§7) */
function mergeToolUpdate(
  tool: ToolCall,
  update: { status?: unknown; title?: string; detail?: string; diffs?: HarnessToolDiff[]; output?: string; url?: string },
  atMs: number,
): ToolCall {
  const status = update.status !== undefined ? toolStatus(update.status) : tool.status
  const startedAtMs = tool.startedAtMs
  return {
    ...tool,
    status,
    ...(update.title ? { target: update.title } : {}),
    ...(update.detail ? { detail: update.detail } : {}),
    ...(update.diffs ? { diffs: update.diffs } : {}),
    ...(update.output ? { output: update.output } : {}),
    ...(update.url ? { url: update.url } : {}),
    ...(status !== "running" && startedAtMs !== undefined
      ? { durationMs: atMs - startedAtMs }
      : {}),
  }
}

export type Accumulator = {
  lastSeq: number
  messages: Message[]
  draft: Draft | null
}

export function createAccumulator(): Accumulator {
  return { lastSeq: 0, messages: [], draft: null }
}

function ensureDraft(acc: Accumulator, atMs: number): Draft {
  if (!acc.draft) {
    acc.draft = { text: "", thinking: "", tools: [], toolIndex: new Map(), activity: [], startedAtMs: atMs }
  }
  return acc.draft
}

function finalizeDraft(acc: Accumulator, atMs: number, usage?: HarnessUsage) {
  const d = acc.draft
  if (!d) return
  acc.draft = null
  // 回合已终结:未落定的工具事实上已死,强制改写为 failed,
  // 否则崩溃/中断会话的回放里永远挂着转动的 spinner。
  for (const tool of d.tools) {
    if (tool.status === "running") tool.status = "failed"
  }
  if (!d.text && !d.thinking && d.tools.length === 0) return
  acc.messages.push({
    id: `a${acc.messages.length}`,
    role: "assistant",
    text: d.text,
    ...(d.thinking ? { thinking: d.thinking } : {}),
    ...(d.tools.length ? { tools: d.tools } : {}),
    ...(d.activity.length ? { activity: d.activity } : {}),
    durationMs: atMs - d.startedAtMs,
    ...(d.plan?.length ? { plan: d.plan } : {}),
    ...(usage ? { usage } : {}),
  })
}

const SUCCESSFUL_RESUME_NOTICES = new Set([
  "会话已恢复(resume),上下文延续",
  "会话已恢复(load),上下文延续",
  "会话已恢复(Codex thread/resume),上下文延续",
])

function isSuccessfulResumeNotice(text: string | undefined): boolean {
  return Boolean(text && SUCCESSFUL_RESUME_NOTICES.has(text))
}

function applyEvent(acc: Accumulator, event: HarnessEvent, seq: number, atMs: number) {
  switch (event.type) {
    case "user_message":
      finalizeDraft(acc, atMs)
      acc.messages.push({
        id: `u${seq}`,
        role: "user",
        text: event.text,
        ...(event.attachments?.length ? { attachments: event.attachments } : {}),
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.clientMessageId ? { clientMessageId: event.clientMessageId } : {}),
      })
      return
    case "turn_finished":
      finalizeDraft(acc, atMs, event.usage)
      return
    case "notice":
      if (isSuccessfulResumeNotice(event.text)) return
      finalizeDraft(acc, atMs)
      acc.messages.push({ id: `n${seq}`, role: "assistant", text: `⚠️ ${event.text}` })
      return
    case "agent_message_chunk":
      ensureDraft(acc, atMs).text += event.text
      return
    case "agent_thought_chunk": {
      const draft = ensureDraft(acc, atMs)
      draft.thinking += event.text
      const last = draft.activity.at(-1)
      if (last?.kind === "thinking") last.text += event.text
      else draft.activity.push({ id: `thinking-${seq}`, kind: "thinking", text: event.text })
      return
    }
    case "user_steer":
      ensureDraft(acc, atMs).activity.push({
        id: `steer-${event.clientMessageId}`,
        kind: "steer",
        text: event.text,
      })
      return
    case "tool_started": {
      const draft = ensureDraft(acc, atMs)
      draft.toolIndex.set(event.id, draft.tools.length)
      const tool: ToolCall = {
        kind: event.kind,
        target: event.title,
        detail: "",
        status: toolStatus(event.status),
        startedAtMs: atMs,
        ...(event.diffs ? { diffs: event.diffs } : {}),
      }
      draft.tools.push(tool)
      draft.activity.push({ id: event.id, kind: "tool", tool })
      return
    }
    case "tool_updated": {
      const draft = acc.draft
      const index = draft?.toolIndex.get(event.id)
      if (draft && index !== undefined) {
        const tool = mergeToolUpdate(draft.tools[index], event, atMs)
        draft.tools[index] = tool
        const activity = draft.activity.find((item) => item.kind === "tool" && item.id === event.id)
        if (activity?.kind === "tool") activity.tool = tool
      }
      return
    }
    case "metadata":
      applyMetadata(acc, event, atMs)
      return
  }
}

/** §7 P4:ACP plan 事件整体替换当前回合的计划清单;其余 metadata 照旧不渲染。
 * 旧会话没有 plan 事件,对应字段缺席即自动隐藏。 */
function applyMetadata(acc: Accumulator, event: Extract<HarnessEvent, { type: "metadata" }>, atMs: number) {
  if (event.name !== "plan") return
  const entries = (event.data as { entries?: unknown } | undefined)?.entries
  if (!Array.isArray(entries)) return
  const items: PlanItem[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const { content, status } = entry as { content?: unknown; status?: unknown }
    if (typeof content !== "string" || !content) continue
    items.push({ content, status: status === "completed" || status === "in_progress" ? status : "pending" })
  }
  if (items.length > 0) ensureDraft(acc, atMs).plan = items
}

/* v0.3 落盘的 ACP 原始 update 形状宽松,读取面收敛到这一个类型 */
type LegacyUpdatePayload = {
  text?: string
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  kind?: unknown
  status?: unknown
  title?: string
  toolCallId?: string
}

export function applyRecord(acc: Accumulator, r: LogRecord) {
  if (r.seq <= acc.lastSeq) return // 回放与实时衔接时的去重
  acc.lastSeq = r.seq
  const atMs = Date.parse(r.at)
  if (r.kind === "event") {
    applyEvent(acc, r.payload as HarnessEvent, r.seq, atMs)
    return
  }
  const p = r.payload as LegacyUpdatePayload

  switch (r.kind) {
    case "user_message":
      finalizeDraft(acc, atMs)
      acc.messages.push({ id: `u${r.seq}`, role: "user", text: p.text ?? "" })
      return
    case "turn_end":
      finalizeDraft(acc, atMs)
      return
    case "notice":
      if (isSuccessfulResumeNotice(p.text)) return
      finalizeDraft(acc, atMs)
      acc.messages.push({ id: `n${r.seq}`, role: "assistant", text: `⚠️ ${p.text}` })
      return
    case "update":
      break
    default:
      return // meta 等
  }

  const u = p
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content?.type === "text") ensureDraft(acc, atMs).text += u.content.text
      return
    case "agent_thought_chunk":
      if (u.content?.type === "text") {
        const text = u.content.text ?? ""
        const draft = ensureDraft(acc, atMs)
        draft.thinking += text
        const last = draft.activity.at(-1)
        if (last?.kind === "thinking") last.text += text
        else draft.activity.push({ id: `thinking-${r.seq}`, kind: "thinking", text })
      }
      return
    case "tool_call": {
      const d = ensureDraft(acc, atMs)
      const toolCallId = u.toolCallId ?? "unknown"
      d.toolIndex.set(toolCallId, d.tools.length)
      const tool: ToolCall = {
        kind: toolKind(u.kind),
        target: u.title ?? toolCallId,
        detail: "",
        status: toolStatus(u.status),
        startedAtMs: atMs,
      }
      d.tools.push(tool)
      d.activity.push({ id: toolCallId, kind: "tool", tool })
      return
    }
    case "tool_call_update": {
      const d = acc.draft
      const toolCallId = u.toolCallId
      const i = d && toolCallId !== undefined ? d.toolIndex.get(toolCallId) : undefined
      if (d && i !== undefined) {
        const tool = mergeToolUpdate(d.tools[i], u, atMs)
        d.tools[i] = tool
        const activity = d.activity.find((item) => item.kind === "tool" && item.id === toolCallId)
        if (activity?.kind === "tool") activity.tool = tool
      }
      return
    }
    default:
      return // plan / usage_update / available_commands_update … v0.3 先不渲染
  }
}

/** 当前可渲染的消息列表:已定稿的 + 正在流式的草稿 */
export function messagesOf(acc: Accumulator): Message[] {
  if (!acc.draft) return acc.messages
  const d = acc.draft
  return [
    ...acc.messages,
    {
      id: "draft",
      role: "assistant",
      text: d.text,
      ...(d.thinking ? { thinking: d.thinking } : {}),
      ...(d.tools.length ? { tools: d.tools } : {}),
      ...(d.activity.length ? { activity: d.activity } : {}),
      ...(d.plan?.length ? { plan: d.plan } : {}),
    },
  ]
}

/**
 * 回放终界(TRACE_DATA_PLAN §3.3):应用崩溃/强退的会话尾部回合没有任何
 * 终点事件,历史回放的 trailing draft 永不 finalize,spinner 照转。调用方
 * (live-store 历史加载完成)须先确认该会话确实已死:renderer 非 running
 * 且 main 侧非 live 双条件。`at` 为收尾时刻,M1 起用于回合 durationMs。
 */
export function finalizeTrailing(acc: Accumulator, at: string) {
  if (acc.draft) finalizeDraft(acc, Date.parse(at))
}
