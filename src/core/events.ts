/** 可持久化的统一会话事件。Driver 必须先把 vendor 事件翻译到这里。 */

import type { MessageOrigin } from "./collaboration"

export type HarnessToolKind = "read" | "edit" | "bash" | "search"
export type HarnessToolStatus = "running" | "completed" | "failed"
export const TOOL_OUTPUT_LIMIT = 8 * 1024

/** 一次 edit 的单文件增删统计。只存数字,不存 diff 全文。 */
export type HarnessToolDiff = {
  path: string
  added: number
  deleted: number
}

/** 一次回合的用量(TRACE_DATA_PLAN §7 P4)。各 driver 只透出 vendor 实际
 * 有的字段:ACP 的 usage_update 是上下文窗口 + 会话累计成本,没有逐回合
 * token 分解,只接 cost;Codex/Claude/Pi 有逐回合 token。 */
export type HarnessUsage = {
  inputTokens?: number
  outputTokens?: number
  /** 美元计价成本 */
  cost?: number
}

/** 审批卡片的通用决议:allow_always 的会话级记忆由各 driver 自己兑现
 *  (codex=acceptForSession、claude=会话内规则集、ACP=原生 allow_always)。 */
export type ApprovalDecision = "allow_once" | "allow_always" | "deny"

export type ApprovalDecisionSource = "user" | "cancel" | "session-close" | "unattended-auto"

export type ApprovalRequestEvent = {
  type: "approval_request"
  id: string
  title: string
  detail?: string
  options: { id: ApprovalDecision; label: string }[]
}

export type ApprovalResolvedEvent = {
  type: "approval_resolved"
  id: string
  decision: ApprovalDecision
  source: ApprovalDecisionSource
}

export type HarnessEvent =
  | {
      type: "user_message"
      text: string
      attachments?: Array<{ name: string; kind: "image" | "file" }>
      /** 跨 Session 消息的可信来源;缺省按 human 处理(历史兼容)。 */
      origin?: MessageOrigin
      /** Renderer 发起的待发送消息 id；真实入队后用于替换乐观队列气泡。 */
      clientMessageId?: string
    }
  | { type: "agent_message_chunk"; text: string }
  | { type: "agent_thought_chunk"; text: string }
  | { type: "user_steer"; text: string; clientMessageId: string }
  | {
      type: "tool_started"
      id: string
      kind: HarnessToolKind
      title: string
      status: HarnessToolStatus
      diffs?: HarnessToolDiff[]
    }
  | {
      type: "tool_updated"
      id: string
      title?: string
      status?: HarnessToolStatus
      detail?: string
      diffs?: HarnessToolDiff[]
      /** 工具输出全文(截断至 TOOL_OUTPUT_LIMIT,存在才可展开;TRACE_DATA_PLAN §7) */
      output?: string
      /** 搜索类工具的结果链接(存在才渲染为链接) */
      url?: string
    }
  | { type: "notice"; text: string }
  | { type: "turn_finished"; reason?: string; usage?: HarnessUsage }
  | { type: "metadata"; name: string; data: unknown }
  | ApprovalRequestEvent
  | ApprovalResolvedEvent

export type EventLogRecord = {
  seq: number
  at: string
  kind: "event"
  payload: HarnessEvent
}

/** v0.3 已落盘记录的兼容形态；只在 replay 边界读取，不再产生。 */
export type LegacyLogRecord = {
  seq: number
  at: string
  kind: string
  payload: unknown
}

export type LogRecord = EventLogRecord | LegacyLogRecord
