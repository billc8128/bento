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

type FinalizeOptions = {
  usage?: HarnessUsage
  outcome?: Extract<Message, { role: "assistant" }>["outcome"]
  /** 只有正常 turn_finished 才能把最后一段过程提升为 final。 */
  promoteProgress?: boolean
}

/** 思考段落的闭合:一旦有非 thinking 事件到来(说话/工具/补充/回合终结),上一段思考的流式事实上结束了,
 * 写死 durationMs = at - startedAtMs。流式中该字段不存在,live 行的「正在思考…」不受它影响。 */
function closeThinking(d: Draft, atMs: number) {
  const last = d.activity.at(-1)
  if (last?.kind === "thinking" && last.durationMs === undefined && last.startedAtMs !== undefined) {
    last.durationMs = atMs - last.startedAtMs
  }
}

function finalizeDraft(acc: Accumulator, atMs: number, options: FinalizeOptions = {}) {
  const d = acc.draft
  if (!d) return
  acc.draft = null
  // 回合已终结:未落定的工具事实上已死,强制改写为 failed,
  // 否则崩溃/中断会话的回放里永远挂着转动的 spinner。
  for (const tool of d.tools) {
    if (tool.status === "running") tool.status = "failed"
  }
  // 回合终结也是思考段落的闭合点:尾部那大段「正在思考」流式已死,写死耗时,不回放成永远在思考。
  closeThinking(d, atMs)
  // final = 最后一次工具活动之后的连续公开文本;工具前/工具间的文本已按
  // 工具边界切成 progress 留在 timeline。若回合没有独立 final(最后一段
  // 文本后面又开了新工具),把最后一段 progress 回退为 final,回答不能消失。
  let text = d.text
  let activity = d.activity
  if (options.outcome && text.trim()) {
    activity = [
      ...activity,
      { id: `progress-end-${acc.lastSeq}`, kind: "progress", text },
    ]
    text = ""
  } else if (options.promoteProgress !== false && !text.trim()) {
    for (let i = activity.length - 1; i >= 0; i--) {
      const item = activity[i]
      if (item.kind === "progress") {
        text = item.text
        activity = activity.slice(0, i).concat(activity.slice(i + 1))
        break
      }
    }
  }
  if (!text && !d.thinking && d.tools.length === 0 && activity.length === 0 && !d.plan?.length) return
  acc.messages.push({
    id: `a${acc.messages.length}`,
    role: "assistant",
    text,
    ...(d.thinking ? { thinking: d.thinking } : {}),
    ...(d.tools.length ? { tools: d.tools } : {}),
    ...(activity.length ? { activity } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    durationMs: atMs - d.startedAtMs,
    ...(d.plan?.length ? { plan: d.plan } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
  })
}

/** 工具边界:把当前累积的公开文本切成一段过程文字留在 timeline 里,
 * 让 final message 只装最后一次工具活动之后的文本。纯空白段丢弃。 */
function flushProgress(d: Draft, id: string) {
  if (!d.text.trim()) {
    d.text = ""
    return
  }
  d.activity.push({ id, kind: "progress", text: d.text })
  d.text = ""
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
      finalizeDraft(acc, atMs, { outcome: "interrupted", promoteProgress: false })
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
      finalizeDraft(acc, atMs, {
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.reason === "cancelled" || event.reason === "error"
          ? { outcome: event.reason }
          : {}),
        promoteProgress: event.reason !== "cancelled" && event.reason !== "error",
      })
      return
    case "notice":
      if (isSuccessfulResumeNotice(event.text)) return
      finalizeDraft(acc, atMs, { outcome: "error", promoteProgress: false })
      acc.messages.push({ id: `n${seq}`, role: "assistant", text: `⚠️ ${event.text}` })
      return
    case "agent_message_chunk": {
      // 公开文本:留在 draft.text 作为 final 候选;遇到下一个工具边界时
      // 由 flushProgress 切成 progress 留在 timeline,不混入 final message
      const draft = ensureDraft(acc, atMs)
      closeThinking(draft, atMs)
      draft.text += event.text
      return
    }
    case "agent_thought_chunk": {
      const draft = ensureDraft(acc, atMs)
      draft.thinking += event.text
      const last = draft.activity.at(-1)
      // 已闭合的思考段(durationMs 已写死)不能再被追加:思考 A → 说话 → 思考 B 时 speech 不产生
      // activity 项,若继续往 A 里拼,B 的时长会永久丢失(A 的 durationMs 已被说话闭合)。
      // 已闭合就开新段,buildPhases 合并相邻段时文本拼接、耗时求和。
      if (last?.kind === "thinking" && last.durationMs === undefined) last.text += event.text
      else draft.activity.push({ id: `thinking-${seq}`, kind: "thinking", text: event.text, startedAtMs: atMs })
      return
    }
    case "user_steer": {
      const draft = ensureDraft(acc, atMs)
      closeThinking(draft, atMs)
      draft.activity.push({
        id: `steer-${event.clientMessageId}`,
        kind: "steer",
        text: event.text,
      })
      return
    }
    case "tool_started": {
      const draft = ensureDraft(acc, atMs)
      closeThinking(draft, atMs)
      flushProgress(draft, `progress-${seq}`)
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
    case "approval_request": {
      // 审批是回合内嵌元素(同工具):pending 渲染为可点卡片
      const draft = ensureDraft(acc, atMs)
      closeThinking(draft, atMs)
      flushProgress(draft, `progress-${seq}`)
      draft.activity.push({
        id: `approval-${event.id}`,
        kind: "approval",
        approval: {
          id: event.id,
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          options: event.options,
          state: "pending",
        },
      })
      return
    }
    case "approval_resolved": {
      // 结算即折叠为静态记录:实时由渲染端决议驱动,回放按此折叠,永不悬挂
      const draft = acc.draft
      const item = draft?.activity.find(
        (entry) => entry.kind === "approval" && entry.approval.id === event.id,
      )
      if (item?.kind === "approval") {
        item.approval = {
          ...item.approval,
          state: { decision: event.decision, source: event.source },
        }
      }
      return
    }
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
      finalizeDraft(acc, atMs, { outcome: "interrupted", promoteProgress: false })
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
      if (u.content?.type === "text") {
        const draft = ensureDraft(acc, atMs)
        closeThinking(draft, atMs)
        draft.text += u.content.text
      }
      return
    case "agent_thought_chunk":
      if (u.content?.type === "text") {
        const text = u.content.text ?? ""
        const draft = ensureDraft(acc, atMs)
        draft.thinking += text
        const last = draft.activity.at(-1)
        // 同上新事件路径:已闭合的思考段不再被追加,开新段交给 buildPhases 求和
        if (last?.kind === "thinking" && last.durationMs === undefined) last.text += text
        else draft.activity.push({ id: `thinking-${r.seq}`, kind: "thinking", text, startedAtMs: atMs })
      }
      return
    case "tool_call": {
      const d = ensureDraft(acc, atMs)
      closeThinking(d, atMs)
      const toolCallId = u.toolCallId ?? "unknown"
      flushProgress(d, `progress-${r.seq}`)
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
  if (acc.draft) {
    finalizeDraft(acc, Date.parse(at), { outcome: "interrupted", promoteProgress: false })
  }
}
