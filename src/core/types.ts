/**
 * 领域类型(无头 core)。本目录不允许 import 任何 UI。
 */

import type { ApprovalDecision, ApprovalDecisionSource, HarnessToolDiff, HarnessUsage } from "./events"
import type { MessageOrigin } from "./collaboration"

export type Effort = "off" | "auto" | "low" | "medium" | "high" | "max"
export type SessionScope = "chat" | "project"

export type PromptAttachment = {
  name: string
  path: string
  mimeType: string
  size: number
  kind: "image" | "file"
}

export type PromptInput = {
  text: string
  attachments: PromptAttachment[]
}

export function normalizePromptInput(input: string | PromptInput): PromptInput {
  return typeof input === "string" ? { text: input, attachments: [] } : input
}

export const EFFORTS: { id: Effort; label: string; hint: string }[] = [
  { id: "off", label: "不推理", hint: "直接回答，不进行额外思考" },
  { id: "auto", label: "自动", hint: "由 Harness 按任务判断" },
  { id: "low", label: "低", hint: "抢速度,适合改一行、查文件" },
  { id: "medium", label: "中", hint: "日常默认" },
  { id: "high", label: "高", hint: "跨文件重构、疑难排查" },
  { id: "max", label: "极限", hint: "最慢,留给真正卡住的问题" },
]

/** 回合计划清单条目(来自 ACP plan 事件,TRACE_DATA_PLAN §7 P4) */
export type PlanItem = {
  content: string
  status: "pending" | "in_progress" | "completed"
}

export type ToolCall = {
  kind: "read" | "edit" | "bash" | "search"
  target: string
  detail: string
  status: "done" | "running" | "failed"
  /** 工具开始的 epoch ms(来自事件 at) */
  startedAtMs?: number
  /** 落定后的耗时 ms;running 时不存在 */
  durationMs?: number
  /** 单文件增删统计(edit 类工具,存在才渲染) */
  diffs?: HarnessToolDiff[]
  /** 工具输出全文(截断 8KB,存在才可展开;TRACE_DATA_PLAN §7) */
  output?: string
  /** 搜索类工具的结果链接(存在才渲染为链接) */
  url?: string
}

/** 审批卡片:pending 时渲染为可点决议卡,结算后折叠为静态记录(回放语义) */
export type ApprovalRequest = {
  id: string
  title: string
  detail?: string
  options: { id: ApprovalDecision; label: string }[]
  state: "pending" | { decision: ApprovalDecision; source: ApprovalDecisionSource }
}

export type ActivityItem =
  | {
      id: string
      kind: "thinking"
      text: string
      /** 本段思考开始的 epoch ms(首个 thought chunk 事件的 at);回放/实时同一条路径写入 */
      startedAtMs?: number
      /** 段落闭合(下一个非 thinking 事件到来)后的耗时 ms;流式中不存在 */
      durationMs?: number
    }
  /** 助手公开过程文字(工具调用前/工具之间),按工具边界切分;最后一次
   * 工具活动后的连续文本才是 final,过程段留在 timeline 里可折叠查看 */
  | { id: string; kind: "progress"; text: string }
  | { id: string; kind: "tool"; tool: ToolCall }
  | { id: string; kind: "steer"; text: string }
  | { id: string; kind: "approval"; approval: ApprovalRequest }

export type Message =
  | { id: string; role: "user"; text: string; attachments?: { name: string; kind: "image" | "file" }[]; origin?: MessageOrigin; clientMessageId?: string }
  | {
      id: string
      role: "assistant"
      text: string
      tools?: ToolCall[]
      thinking?: string
      /** thinking/tool/steer 按真实事件顺序排列；旧历史缺失时 UI 回退旧字段。 */
      activity?: ActivityItem[]
      /** 非正常终结原因；缺省表示收到正常 turn_finished。 */
      outcome?: "cancelled" | "error" | "interrupted"
      /** 回合耗时 ms:本回合首个事件到最后一个事件(turn_finished / 下一个 user_message) */
      durationMs?: number
      /** 回合计划清单(来自 metadata 的 plan 事件,存在才渲染) */
      plan?: PlanItem[]
      /** 回合用量(turn_finished 带出,存在才渲染;TRACE_DATA_PLAN §7 P4) */
      usage?: HarnessUsage
    }
