import { countContentLines, diffStatFromOldNew } from "../../src/core/diffstat"
import type { HarnessEvent, HarnessToolDiff, HarnessToolKind } from "../../src/core/events"

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

function toolKind(name: string): HarnessToolKind {
  const lower = name.toLowerCase()
  if (lower.includes("read")) return "read"
  if (lower.includes("write") || lower.includes("edit") || lower.includes("delete")) return "edit"
  if (lower.includes("grep") || lower.includes("glob") || lower.includes("search") || lower.includes("web"))
    return "search"
  return "bash"
}

function toolDetail(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text) : ""))
    .join("")
  return text || undefined
}

/** Agent SDK 消息 → Bento 统一事件。一个实例只服务一个 turn，保存流式 block 状态。 */
export class ClaudeAgentTranslator {
  private readonly toolIds = new Set<string>()
  private sawStreamText = false
  private sawStreamThinking = false

  translate(message: SDKMessage): HarnessEvent[] {
    if (message.type === "stream_event") return this.translateStream(message.event as unknown)
    if (message.type === "assistant") return this.translateAssistant(message as unknown)
    if (message.type === "user") return this.translateUser(message as unknown)
    if (message.type === "system" && message.subtype === "init") {
      return [{
        type: "metadata",
        name: "claude/session_init",
        data: {
          sessionId: message.session_id,
          model: message.model,
          claudeCodeVersion: message.claude_code_version,
        },
      }]
    }
    // tool_progress 的 elapsed→detail 映射已删(TRACE_DATA_PLAN §4):耗时
    // 改由 reducer 按 at 差统一计算,detail 留给输出摘要。
    return []
  }

  private translateStream(value: unknown): HarnessEvent[] {
    const event = value as {
      type?: string
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; thinking?: string }
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      this.sawStreamText = true
      return [{ type: "agent_message_chunk", text: event.delta.text ?? "" }]
    }
    if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
      this.sawStreamThinking = true
      return [{ type: "agent_thought_chunk", text: event.delta.thinking ?? "" }]
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const id = event.content_block.id ?? "unknown"
      this.toolIds.add(id)
      const name = event.content_block.name ?? "工具调用"
      return [{ type: "tool_started", id, kind: toolKind(name), title: name, status: "running" }]
    }
    return []
  }

  private translateAssistant(value: unknown): HarnessEvent[] {
    const message = value as {
      error?: string
      message?: { content?: Array<Record<string, unknown>> }
    }
    const events: HarnessEvent[] = []
    if (message.error) events.push({ type: "notice", text: `Claude: ${message.error}` })
    for (const block of message.message?.content ?? []) {
      if (block.type === "text" && !this.sawStreamText) {
        events.push({ type: "agent_message_chunk", text: String(block.text ?? "") })
      } else if (block.type === "thinking" && !this.sawStreamThinking) {
        events.push({ type: "agent_thought_chunk", text: String(block.thinking ?? "") })
      } else if (block.type === "tool_use") {
        const id = String(block.id ?? "unknown")
        const name = String(block.name ?? "工具调用")
        const input = (block.input ?? {}) as Record<string, unknown>
        const title = typeof input.file_path === "string" ? input.file_path : name
        const diffs = this.toolDiffs(name, input)
        if (this.toolIds.has(id)) {
          // 流式已发 started:补发 tool_updated 带统计与真实目标(§4)
          events.push({ type: "tool_updated", id, title, ...(diffs ? { diffs } : {}) })
          continue
        }
        this.toolIds.add(id)
        events.push({
          type: "tool_started",
          id,
          kind: toolKind(name),
          title,
          status: "running",
          ...(diffs ? { diffs } : {}),
        })
      }
    }
    return events
  }

  /** §4:Edit 双形态(单组 old/new_string 或 edits[])/Write 全量 added;
   * MultiEdit 已从现行 CLI 移除仅防御保留;NotebookEdit 字段形态不同,不出统计。 */
  private toolDiffs(name: string, input: Record<string, unknown>): HarnessToolDiff[] | undefined {
    const path = typeof input.file_path === "string" ? input.file_path : undefined
    if (!path) return undefined
    if (name === "Write") {
      if (typeof input.content !== "string") return undefined
      return [{ path, added: countContentLines(input.content), deleted: 0 }]
    }
    if (name === "Edit" || name === "MultiEdit") {
      const edits = Array.isArray(input.edits) ? input.edits : [input]
      let added = 0
      let deleted = 0
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue
        const { old_string, new_string } = edit as Record<string, unknown>
        if (typeof old_string !== "string" || typeof new_string !== "string") continue
        const stat = diffStatFromOldNew(old_string, new_string)
        added += stat.added
        deleted += stat.deleted
      }
      return added + deleted > 0 ? [{ path, added, deleted }] : undefined
    }
    return undefined
  }

  private translateUser(value: unknown): HarnessEvent[] {
    const message = value as { message?: { content?: string | Array<Record<string, unknown>> } }
    const content = message.message?.content
    if (!Array.isArray(content)) return []
    return content.flatMap((block): HarnessEvent[] => {
      if (block.type !== "tool_result") return []
      // §7:tool_result 文本已全量进 detail,output 只在比 detail 更全时才接;
      // 当前 detail 就是全量输出,不重复接线(扩充输出面板留给 ACP/Codex 这类丢弃方)。
      const detail = toolDetail(block.content)
      return [{
        type: "tool_updated",
        id: String(block.tool_use_id ?? "unknown"),
        status: block.is_error === true ? "failed" : "completed",
        ...(detail ? { detail } : {}),
      }]
    })
  }
}
