/**
 * 回合活动(TurnActivity)的纯数据逻辑:timeline 解析、阶段栈分组、运行态唯一
 * 状态来源。组件层(src/components/TurnActivity.tsx)只负责渲染,规则都收在这里,
 * 方便不挂 DOM 直接测(阶段栈边界、live 阶段判定、落定主行摘要、无活动占位)。
 *
 * 渲染模型是「阶段摘要栈」:连续 thinking 并成一段、连续 tool 并成一组,
 * progress 独立成行。live 回合里,已完成的 thinking/tools 阶段收进顶部
 * 一行聚合(liveAggregate,实时计数、点击展开完整栈),进行中的阶段与
 * progress/approval 留在流里;回合结束后 liveTurnState 返回
 * undefined,活动随消息折叠到 final 正文上方的一行总折叠(已工作 Xm XXs)里。
 * steer(回合中补充)不进阶段栈:replay 把它拆成真实 user message。
 */

import type { ActivityItem, ApprovalRequest, Message, PlanItem, ToolCall } from "./types"
import { formatDuration } from "./formatDuration"
import { loadPreference, resolveLocale, translate } from "@/lib/i18n/core"

type AssistantMsg = Extract<Message, { role: "assistant" }>

type TFn = (key: string, vars?: Record<string, string | number>) => string

/** 组件应把 useT() 的 t 显式传入;非组件调用方缺省时按已存语言偏好查表。 */
const defaultT: TFn = (key, vars) => translate(resolveLocale(loadPreference()), key, vars)

/** 阶段栈行(渲染的最小单元):连续 thinking 并成一段、连续 tool 并成一组;
 * progress 是公开文字,独立成行、不参与折叠分组;approval 是审批卡片,独立成行。
 * thinking 段聚合整段耗时(合并的子段求和;
 * 都没有计时数据时为 undefined,标题回退到无时长文案)。streaming = 合并的最后一个子段还没闭合
 * (durationMs 未写死),即思考还在流式——合并后 durationMs 可能已有部分和,不能拿它判 live。 */
export type PhaseRow =
  | { id: string; kind: "thinking"; text: string; durationMs?: number; streaming?: boolean }
  | { id: string; kind: "tools"; tools: ToolCall[] }
  | { id: string; kind: "progress"; text: string }
  | { id: string; kind: "approval"; approval: ApprovalRequest }

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

/** 合并两个可选时长:都有就相加(相邻 thinking 子段并成一段时),只有一边有就保留那一边,都没有就没有。 */
function mergeDurationMs(a?: number, b?: number): number | undefined {
  return a === undefined ? b : b === undefined ? a : a + b
}

/** 把 timeline 折成阶段栈:连续 thinking 合并为一段(text 拼接、耗时求和)、连续 tool
 * 合并为一组,progress 切段并独立成行。
 * 注意:不做增量缓存——draft.activity 的项会被原位改写(thinking 追加文本、
 * tool_updated 替换 tool),任何引用稳定性假设都会吞掉实时更新。 */
export function buildPhases(items: ActivityItem[]): PhaseRow[] {
  const rows: PhaseRow[] = []
  for (const item of items) {
    const last = rows[rows.length - 1]
    if (item.kind === "thinking") {
      // streaming = 有计时起点但还没闭合(live reducer 恒写 startedAtMs;旧数据两个字段都缺,不算流式)
      const streaming = item.startedAtMs !== undefined && item.durationMs === undefined
      if (last?.kind === "thinking") {
        last.text += item.text
        last.durationMs = mergeDurationMs(last.durationMs, item.durationMs)
        last.streaming = streaming ? true : undefined
      } else {
        rows.push({
          id: item.id,
          kind: "thinking",
          text: item.text,
          durationMs: item.durationMs,
          streaming: streaming ? true : undefined,
        })
      }
      continue
    }
    if (item.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(item.tool)
      else rows.push({ id: item.id, kind: "tools", tools: [item.tool] })
      continue
    }
    if (item.kind === "approval") {
      rows.push({ id: item.id, kind: "approval", approval: item.approval })
      continue
    }
    rows.push({ id: item.id, kind: item.kind, text: item.text })
  }
  return rows
}

/** 阶段行标题。live = 这是正在进行中的阶段(栈末行),thinking 用它切换现在时/过去时;
 * tools 行的时态不看 live、由该行自身状态决定——栈末行被穿插的思考抢走时(livePhaseId 只管
 * 高亮),running 工具所在行不能说过去式(「已使用 N 个工具」的计数里还含着没落定的工具)。 */
export function phaseLabel(
  row: Extract<PhaseRow, { kind: "thinking" | "tools" }>,
  live: boolean,
  t: TFn = defaultT,
): string {
  if (row.kind === "thinking") {
    if (live) return t("activity.thinkingLive")
    return row.durationMs !== undefined
      ? t("activity.thoughtWithDuration", { duration: formatDuration(row.durationMs) })
      : t("activity.thought")
  }
  if (row.tools.some((tool) => tool.status === "running")) return t("activity.usingTools")
  return t("activity.usedTools", { count: row.tools.length })
}

/** 阶段栈中正在进行的那一行:末段是 tools 且有工具在跑 → 工具阶段;
 * 末段是未闭合的 thinking → 思考还在流式(或刚结束、下一事件未到的间隙)。
 * 末段 thinking 已闭合(streaming 为空,被说话闭合)说明 agent 正在输出正文——思考行落定成
 * 「已思考 Xs」,状态交给 liveStatus 的兜底行,不再把「正在思考…」钉在流式正文上面。
 * 其他情况(末行是 progress,或空栈)没有活跃工作段,调用方回退到 liveStatus。 */
export function livePhaseId(rows: PhaseRow[]): string | undefined {
  const last = rows.at(-1)
  if (last?.kind === "tools") {
    return last.tools.some((tool) => tool.status === "running") ? last.id : undefined
  }
  if (last?.kind === "thinking") return last.streaming ? last.id : undefined
  return undefined
}

/** live 回合的聚合行:已完成(闭合)的 thinking/tools 阶段收进 trace 块顶部一行,
 * 实时计数、点击展开回看完整栈。未闭合的流式 thinking、仍含 running 工具的
 * tools 行(哪怕栈末行已被穿插思考抢走)以及 progress/approval 都留在
 * 流里,不进聚合——审批卡可交互、旁白是公开内容。
 * thinkingMs 聚合所有闭合 thinking 段的耗时(沿用 mergeDurationMs:只有部分段
 * 有计时也给出已知部分的和);全部缺计时则缺席,标题回退无时长文案。 */
export type LiveAggregate = {
  /** 收进聚合的已完成阶段(时间序) */
  rows: PhaseRow[]
  thinkingCount: number
  thinkingMs?: number
  toolCount: number
  failedCount: number
}

export function liveAggregate(rows: PhaseRow[]): LiveAggregate {
  const agg: LiveAggregate = { rows: [], thinkingCount: 0, toolCount: 0, failedCount: 0 }
  for (const row of rows) {
    if (row.kind === "thinking" && !row.streaming) {
      agg.rows.push(row)
      agg.thinkingCount += 1
      agg.thinkingMs = mergeDurationMs(agg.thinkingMs, row.durationMs)
      continue
    }
    if (row.kind === "tools" && !row.tools.some((tool) => tool.status === "running")) {
      agg.rows.push(row)
      agg.toolCount += row.tools.length
      agg.failedCount += row.tools.filter((tool) => tool.status === "failed").length
    }
  }
  return agg
}

/** 运行态回合的活动数据。running 为假时返回 undefined —— 消息流末端的
 * 活动块随之消失,同一批数据改由落定消息的总折叠 trace 承接(默认一行摘要)。
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

/** 兜底状态标题:阶段栈没有活跃工作段时(空栈、说话中)的状态文案。
 * 有活跃工作段时状态由该阶段行自己承担(livePhaseId),不走这里。
 * 末段思考已被说话闭合(durationMs 写死)= agent 正在输出正文,正文在下方流式,
 * 状态行如实说「正在回复」,不再假装还在思考。 */
export function liveStatus(turn: LiveTurn, t: TFn = defaultT): { label: string } {
  const activityTools = turn.activity.flatMap((item) => item.kind === "tool" ? [item.tool] : [])
  if ([...turn.tools, ...activityTools].some((tool) => tool.status === "running")) {
    return { label: t("activity.usingTools") }
  }
  const last = turn.activity.at(-1)
  // 审批 hold 中的回合没有工具在跑、没有文本在流——如实说在等用户
  if (last?.kind === "approval" && last.approval.state === "pending") {
    return { label: t("activity.waitingApproval") }
  }
  if (last?.kind === "thinking" && last.durationMs !== undefined) return { label: t("activity.replying") }
  if (turn.activity.some((item) => item.kind === "tool" || item.kind === "progress")) {
    return { label: t("activity.working") }
  }
  return { label: t("activity.thinking") }
}

type TurnOutcome = NonNullable<AssistantMsg["outcome"]>

function outcomeLabel(outcome: TurnOutcome, t: TFn): string {
  return outcome === "cancelled"
    ? t("activity.stopped")
    : outcome === "error"
      ? t("activity.runFailed")
      : t("activity.unfinished")
}

/** 落定后的总折叠行标题:有耗时用「已工作 Xm XXs」;旧数据缺 durationMs 时
 * 回退到内容摘要。非正常终结(outcome)冠在前面,不伪装成完成态。 */
export function settledMasterLabel(
  m: Pick<AssistantMsg, "thinking" | "tools" | "outcome" | "durationMs">,
  t: TFn = defaultT,
): string {
  if (m.durationMs === undefined) return settledSummary(m, t)
  const work = t("activity.worked", { duration: formatDuration(m.durationMs) })
  if (!m.outcome) return work
  return t("activity.outcomeWork", { outcome: outcomeLabel(m.outcome, t), work })
}

/** 落定后的内容摘要(缺 durationMs 的旧数据回退用)。 */
export function settledSummary(
  m: Pick<AssistantMsg, "thinking" | "tools" | "outcome">,
  t: TFn = defaultT,
): string {
  const count = m.tools?.length ?? 0
  if (m.outcome) {
    const label = outcomeLabel(m.outcome, t)
    return count > 0 ? t("activity.outcomeTools", { outcome: label, count }) : label
  }
  if (count === 0) return t("activity.thinkingDone")
  return t(m.thinking ? "activity.thoughtAndUsedTools" : "activity.usedToolsSummary", { count })
}

/** 工具组聚合状态:有一个在跑就是在跑,否则有失败报失败,全部落定才成功。 */
export function toolGroupStatus(tools: ToolCall[]): ToolCall["status"] {
  if (tools.some((t) => t.status === "running")) return "running"
  if (tools.some((t) => t.status === "failed")) return "failed"
  return "done"
}

/** kimi ACP adapter 实证的 tool target 动作前缀清单(真实会话日志 102 个带前缀 title 实测),按长度降序、首个命中即停——
 * "Reading " 若在 "Reading media: " 前命中,会把 "Reading media: foo.png" 半剥成 "media: foo.png",所以长前缀在前。 */
const TARGET_VERB_PREFIXES = [
  "Launching coder agent: ",
  "Reading output of task ",
  "Starting background: ",
  "Reading media: ",
  "Stopping task ",
  "Fetching: ",
  "Running: ",
  "Reading ",
  "Editing ",
  "Writing ",
]

/** kimi ACP adapter 会给 tool target 带动作前缀("Running: "、"Reading "…),展示层动词自带,需剥掉。
 * 其他 harness 的 target 不带前缀,函数对它们是恒等。 */
export function cleanToolTarget(target: string): string {
  for (const prefix of TARGET_VERB_PREFIXES) {
    if (target.startsWith(prefix)) return target.slice(prefix.length)
  }
  return target
}
