import { diffStatFromOldNew } from "../../src/core/diffstat"
import { TOOL_OUTPUT_LIMIT, type HarnessEvent, type HarnessToolDiff, type HarnessToolKind, type HarnessToolStatus } from "../../src/core/events"

function toolKind(kind: unknown): HarnessToolKind {
  switch (kind) {
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

function toolStatus(status: unknown): HarnessToolStatus {
  switch (status) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    default:
      return "running"
  }
}

/** ACP ToolCallContent:文本块或 diff(旧文本对新建文件是 null,§4) */
type AcpContent = {
  type?: string
  text?: string
  path?: string
  oldText?: string | null
  newText?: string
}

type AcpUpdate = {
  sessionUpdate?: string
  content?: AcpContent | AcpContent[]
  toolCallId?: string
  kind?: unknown
  title?: string
  status?: unknown
  rawOutput?: unknown
}

/** §7:rawOutput → 输出全文。字符串直取(kimi 实测);对象取 content[] 文本拼接(omp 实测)。 */
function rawOutputText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw || undefined
  if (!raw || typeof raw !== "object") return undefined
  const content = (raw as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text ?? "") : ""))
    .join("")
  return text || undefined
}

/** §7:仅搜索类工具从输出文本提取首个链接;无链接降级为不发。 */
function searchUrl(kind: HarnessToolKind, text: string | undefined): string | undefined {
  if (kind !== "search" || !text) return undefined
  // 排除引号括号与中文句读,避免从结果文本里截出的链接拖着尾巴
  return /https?:\/\/[^\s"'<>()\]{}。,、;;::【】《>[]+/.exec(text)?.[0]
}

function contentText(content: AcpUpdate["content"]): string | undefined {
  return Array.isArray(content) ? undefined : content?.text
}

/** content[] 里 type:"diff" 项 → 单文件统计;无有效项返回 undefined(缺省降级) */
function diffStatsFromContent(content: AcpUpdate["content"]): HarnessToolDiff[] | undefined {
  if (!Array.isArray(content)) return undefined
  const diffs: HarnessToolDiff[] = []
  for (const item of content) {
    if (item?.type !== "diff") continue
    if (typeof item.path !== "string" || typeof item.newText !== "string") continue
    diffs.push({
      path: item.path,
      ...diffStatFromOldNew(item.oldText ?? null, item.newText),
    })
  }
  return diffs.length > 0 ? diffs : undefined
}

/** ACP update → Bento 统一事件。未知 update 保留为 metadata，避免静默丢协议信息。 */
export function translateAcpUpdate(value: unknown): HarnessEvent {
  const update = value as AcpUpdate
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return { type: "agent_message_chunk", text: contentText(update.content) ?? "" }
    case "agent_thought_chunk":
      return { type: "agent_thought_chunk", text: contentText(update.content) ?? "" }
    case "tool_call": {
      const diffs = diffStatsFromContent(update.content)
      return {
        type: "tool_started",
        id: update.toolCallId ?? "unknown",
        kind: toolKind(update.kind),
        title: update.title ?? update.toolCallId ?? "工具调用",
        status: toolStatus(update.status),
        ...(diffs ? { diffs } : {}),
      }
    }
    case "tool_call_update": {
      const diffs = diffStatsFromContent(update.content)
      const output = rawOutputText(update.rawOutput)
      const url = searchUrl(toolKind(update.kind), output)
      return {
        type: "tool_updated",
        id: update.toolCallId ?? "unknown",
        ...(update.title ? { title: update.title } : {}),
        ...(update.status ? { status: toolStatus(update.status) } : {}),
        ...(diffs ? { diffs } : {}),
        ...(output ? { output: output.slice(0, TOOL_OUTPUT_LIMIT) } : {}),
        ...(url ? { url } : {}),
      }
    }
    default:
      return { type: "metadata", name: update.sessionUpdate ?? "unknown", data: value }
  }
}
