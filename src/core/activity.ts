/**
 * 回合活动(TurnActivity)的纯数据逻辑:timeline 解析、阶段栈分组、运行态唯一
 * 状态来源。组件层(src/components/TurnActivity.tsx)只负责渲染,规则都收在这里,
 * 方便不挂 DOM 直接测(阶段栈边界、live 阶段判定、落定主行摘要、无活动占位)。
 *
 * 渲染模型是「阶段摘要栈」:连续 thinking 并成一段、连续 tool 并成一组,
 * progress/steer 独立成行;每个阶段一行,默认折叠、点击向下展开;进行中的阶段
 * (正在思考/正在使用工具)永远在栈末一行。回合结束后 liveTurnState 返回
 * undefined,活动随消息折叠到 final 正文上方的一行总折叠(已工作 Xm XXs)里。
 */

import type { ActivityItem, Message, PlanItem, ToolCall } from "./types"
import { formatDuration } from "./formatDuration"

type AssistantMsg = Extract<Message, { role: "assistant" }>

/** 阶段栈行(渲染的最小单元):连续 thinking 并成一段、连续 tool 并成一组;
 * progress/steer 是公开文字,独立成行、不参与折叠分组。thinking 段聚合整段耗时(合并的子段求和;
 * 都没有计时数据时为 undefined,标题回退到无时长文案)。 */
export type PhaseRow =
  | { id: string; kind: "thinking"; text: string; durationMs?: number }
  | { id: string; kind: "tools"; tools: ToolCall[] }
  | { id: string; kind: "progress" | "steer"; text: string }

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
 * 合并为一组,progress/steer 切段并独立成行。
 * 注意:不做增量缓存——draft.activity 的项会被原位改写(thinking 追加文本、
 * tool_updated 替换 tool),任何引用稳定性假设都会吞掉实时更新。 */
export function buildPhases(items: ActivityItem[]): PhaseRow[] {
  const rows: PhaseRow[] = []
  for (const item of items) {
    const last = rows[rows.length - 1]
    if (item.kind === "thinking") {
      if (last?.kind === "thinking") {
        last.text += item.text
        last.durationMs = mergeDurationMs(last.durationMs, item.durationMs)
      } else {
        rows.push({
          id: item.id,
          kind: "thinking",
          text: item.text,
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
        })
      }
      continue
    }
    if (item.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(item.tool)
      else rows.push({ id: item.id, kind: "tools", tools: [item.tool] })
      continue
    }
    rows.push({ id: item.id, kind: item.kind, text: item.text })
  }
  return rows
}

/** 阶段行标题。live = 这是正在进行中的阶段(栈末行),thinking 用它切换现在时/过去时;
 * tools 行的时态不看 live、由该行自身状态决定——栈末行被穿插的思考抢走时(livePhaseId 只管
 * 高亮),running 工具所在行不能说过去式(「已使用 N 个工具」的计数里还含着没落定的工具)。 */
export function phaseLabel(row: Extract<PhaseRow, { kind: "thinking" | "tools" }>, live: boolean): string {
  if (row.kind === "thinking") {
    if (live) return "正在思考…"
    return row.durationMs !== undefined ? `已思考 ${formatDuration(row.durationMs)}` : "已思考"
  }
  if (row.tools.some((tool) => tool.status === "running")) return "正在使用工具"
  return `已使用 ${row.tools.length} 个工具`
}

/** 阶段栈中正在进行的那一行:末段是 tools 且有工具在跑 → 工具阶段;
 * 末段是 thinking → 思考还在流式(思考刚结束、下一事件未到的间隙也算,
 * 与占位「正在思考」口径一致)。其他情况(末行是 progress/steer,或空栈)
 * 没有活跃工作段,调用方回退到 liveStatus 的兜底状态行。 */
export function livePhaseId(rows: PhaseRow[]): string | undefined {
  const last = rows.at(-1)
  if (last?.kind === "tools") {
    return last.tools.some((tool) => tool.status === "running") ? last.id : undefined
  }
  if (last?.kind === "thinking") return last.id
  return undefined
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

/** 兜底状态标题:阶段栈没有活跃工作段时(空栈、说话中、收到补充)的状态文案。
 * 有活跃工作段时状态由该阶段行自己承担(livePhaseId),不走这里。 */
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

/** 落定后的总折叠行标题:有耗时用「已工作 Xm XXs」;旧数据缺 durationMs 时
 * 回退到内容摘要。非正常终结(outcome)冠在前面,不伪装成完成态。 */
export function settledMasterLabel(
  m: Pick<AssistantMsg, "thinking" | "tools" | "outcome" | "durationMs">,
): string {
  if (m.durationMs === undefined) return settledSummary(m)
  const work = `已工作 ${formatDuration(m.durationMs)}`
  if (!m.outcome) return work
  const label = m.outcome === "cancelled" ? "已停止" : m.outcome === "error" ? "执行失败" : "上轮未完成"
  return `${label} · ${work}`
}

/** 落定后的内容摘要(缺 durationMs 的旧数据回退用)。 */
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
