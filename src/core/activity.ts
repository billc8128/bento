/**
 * 回合活动(TurnActivity)的纯数据逻辑:timeline 解析、工具分组、运行态唯一
 * 状态来源。组件层(src/components/TurnActivity.tsx)只负责渲染,规则都收在这里,
 * 方便不挂 DOM 直接测(单标题来源、结束折叠、工具分组边界、无活动占位)。
 *
 * 运行中整个窗口只有一份状态标题(消息流末端、Composer 上方),数据全部来自这里;
 * 回合结束后 liveTurnState 返回 undefined,活动随消息折叠到 final 正文上方。
 */

import type { ActivityItem, Message, PlanItem, ToolCall } from "./types"

type AssistantMsg = Extract<Message, { role: "assistant" }>

type WorkItem = Extract<ActivityItem, { kind: "thinking" | "tool" }>

/** 渲染块:公开过程/用户引导作为阶段边界；其间的 thinking + tool 收进
 * 一个工作组。这样 agentic loop 中每次工具前的 thinking 不会把工具拆散，
 * 展开工作组后仍保留原始事件顺序。 */
export type ActivityBlock =
  | { id: string; kind: "progress" | "steer"; text: string }
  | { id: string; kind: "work"; items: WorkItem[] }

/** timeline 解析:新数据用结构化 activity;旧历史缺 activity 时回退
 * thinking + tools 聚合字段,顺序退化为 thinking 在前、工具在后。 */
export function resolveActivity(
  m: Pick<AssistantMsg, "thinking" | "tools" | "activity">,
): ActivityItem[] {
  if (m.activity?.length) return m.activity
  return [
    ...(m.thinking ? [{ id: "thinking", kind: "thinking" as const, text: m.thinking }] : []),
    ...(m.tools ?? []).map((tool, index) => ({
      id: `tool-${index}`,
      kind: "tool" as const,
      tool,
    })),
  ]
}

/** 把 timeline 折叠成过程段 + 工作段;progress/steer 会开始新的阶段,
 * 工作段内部按原顺序保留 thinking/tool。
 * 注意:不做增量缓存——draft.activity 的项会被原位改写(thinking 追加文本、
 * tool_updated 替换 tool),任何引用稳定性假设都会吞掉实时更新。 */
export function groupActivity(items: ActivityItem[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = []
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "thinking") {
      const last = blocks[blocks.length - 1]
      if (last?.kind === "work") last.items.push(item)
      else blocks.push({ id: item.id, kind: "work", items: [item] })
      continue
    }
    blocks.push({ id: item.id, kind: item.kind, text: item.text })
  }
  return blocks
}

/** 运行态回合的活动数据。running 为假时返回 undefined —— 消息流末端的
 * 活动块随之消失,同一批数据改由落定消息的折叠 trace 承接(默认一行摘要)。
 * running 为真但还没有 draft(回合刚开始、任何事件都没流出来)时返回空
 * 占位,UI 据此只显示一行「正在思考」,不再别处补状态标题。 */
export type LiveTurn = {
  activity: ActivityItem[]
  tools: ToolCall[]
  thinking?: string
  plan?: PlanItem[]
}

export function liveTurnState(messages: Message[], running: boolean): LiveTurn | undefined {
  if (!running) return undefined
  const draft = messages.findLast((m) => m.role === "assistant" && m.id === "draft")
  if (!draft || draft.role !== "assistant") return { activity: [], tools: [] }
  return {
    activity: resolveActivity(draft),
    tools: draft.tools ?? [],
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(draft.plan?.length ? { plan: draft.plan } : {}),
  }
}

/** 运行状态标题:由 timeline 最后一项决定;空 timeline 是无活动占位,
 * 恒为「正在思考」。这是运行中唯一的状态文案来源(单标题)。 */
export function liveStatus(turn: LiveTurn): { label: string } {
  const activityTools = turn.activity.flatMap((item) => item.kind === "tool" ? [item.tool] : [])
  if ([...turn.tools, ...activityTools].some((tool) => tool.status === "running")) {
    return { label: "正在使用工具" }
  }
  const last = turn.activity.at(-1)
  if (last?.kind === "steer") return { label: "已收到你的补充" }
  if (turn.activity.some((item) => item.kind === "tool" || item.kind === "progress")) {
    return { label: "正在工作" }
  }
  return { label: "正在思考" }
}

/** 落定后的一行摘要(默认折叠态标题)。 */
export function settledSummary(m: Pick<AssistantMsg, "thinking" | "tools" | "outcome">): string {
  const count = m.tools?.length ?? 0
  if (m.outcome) {
    const label = m.outcome === "cancelled" ? "已停止" : m.outcome === "error" ? "执行失败" : "上轮未完成"
    return count > 0 ? `${label} · ${count} 个工具` : label
  }
  return count > 0 ? `${m.thinking ? "思考并" : ""}使用了 ${count} 个工具` : "思考完成"
}

/** 工具组聚合状态:有一个在跑就是在跑,否则有失败报失败,全部落定才成功。 */
export function toolGroupStatus(tools: ToolCall[]): ToolCall["status"] {
  if (tools.some((t) => t.status === "running")) return "running"
  if (tools.some((t) => t.status === "failed")) return "failed"
  return "done"
}
