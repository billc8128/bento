/** 可持久化的统一会话事件。Driver 必须先把 vendor 事件翻译到这里。 */

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

export type HarnessEvent =
  | {
      type: "user_message"
      text: string
      attachments?: Array<{ name: string; kind: "image" | "file" }>
    }
  | { type: "agent_message_chunk"; text: string }
  | { type: "agent_thought_chunk"; text: string }
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
