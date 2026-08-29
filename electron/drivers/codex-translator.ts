import { countContentLines, diffStatFromUnifiedDiff } from "../../src/core/diffstat"
import { TOOL_OUTPUT_LIMIT, type HarnessEvent, type HarnessToolDiff, type HarnessToolKind, type HarnessToolStatus } from "../../src/core/events"

type JsonObject = Record<string, unknown>

function itemKind(type: unknown): HarnessToolKind | undefined {
  switch (type) {
    case "commandExecution":
    case "collabToolCall":
      return "bash"
    case "fileChange":
      return "edit"
    case "webSearch":
      return "search"
    case "mcpToolCall":
    case "imageView":
      return "read"
    default:
      return undefined
  }
}

function itemTitle(item: JsonObject) {
  if (typeof item.command === "string") return item.command
  if (Array.isArray(item.command)) return item.command.join(" ")
  if (typeof item.query === "string") return item.query
  if (typeof item.path === "string") return item.path
  if (typeof item.tool === "string") {
    return typeof item.server === "string" ? `${item.server}/${item.tool}` : item.tool
  }
  const changes = item.changes as Array<{ path?: string }> | undefined
  return changes?.[0]?.path ?? String(item.type ?? "工具调用")
}

function itemStatus(status: unknown): HarnessToolStatus {
  if (status === "failed" || status === "declined") return "failed"
  if (status === "completed") return "completed"
  return "running"
}

/** §7:item/completed 的输出全文;exitCode 非 0 时末尾追加 exit code 行。 */
function itemOutput(item: JsonObject): string | undefined {
  const parts: string[] = []
  if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) parts.push(item.aggregatedOutput)
  if (typeof item.exitCode === "number" && item.exitCode !== 0) parts.push(`exit code ${item.exitCode}`)
  const text = parts.join("\n")
  return text ? text.slice(0, TOOL_OUTPUT_LIMIT) : undefined
}

/** §7:仅搜索类工具透出 action 里的链接;缺字段降级为不发。 */
function itemUrl(kind: HarnessToolKind, item: JsonObject): string | undefined {
  if (kind !== "search") return undefined
  const action = item.action as JsonObject | undefined
  return typeof action?.url === "string" && action.url ? action.url : undefined
}

/** FileUpdateChange = { path, kind: {type: "add"|"delete"|"update", move_path?}, diff }。
 * kind 缺失/未知的文件跳过——宁缺勿错。 */
function fileChangeDiffs(item: JsonObject): HarnessToolDiff[] | undefined {
  const changes = item.changes as JsonObject[] | undefined
  if (!Array.isArray(changes)) return undefined
  const diffs: HarnessToolDiff[] = []
  for (const change of changes) {
    if (typeof change.path !== "string" || typeof change.diff !== "string") continue
    const kindType = (change.kind as JsonObject | undefined)?.type
    if (kindType === "add") {
      diffs.push({ path: change.path, added: countContentLines(change.diff), deleted: 0 })
    } else if (kindType === "delete") {
      diffs.push({ path: change.path, added: 0, deleted: countContentLines(change.diff) })
    } else if (kindType === "update") {
      diffs.push({ path: change.path, ...diffStatFromUnifiedDiff(change.diff) })
    }
  }
  return diffs.length > 0 ? diffs : undefined
}

/** Codex app-server notification → Bento 统一事件。 */
export function translateCodexNotification(method: string, params: JsonObject): HarnessEvent[] {
  if (method === "item/agentMessage/delta") {
    return [{ type: "agent_message_chunk", text: String(params.delta ?? "") }]
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    return [{ type: "agent_thought_chunk", text: String(params.delta ?? "") }]
  }
  if (method === "error") {
    const error = params.error as { message?: string } | undefined
    return [{ type: "notice", text: error?.message ?? "Codex 运行失败" }]
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item as JsonObject | undefined
    if (!item) return []
    const kind = itemKind(item.type)
    if (!kind) return []
    const id = String(item.id ?? "unknown")
    if (method === "item/started") {
      return [{
        type: "tool_started",
        id,
        kind,
        title: itemTitle(item),
      status: itemStatus(item.status),
      }]
    }
    const diffs = kind === "edit" ? fileChangeDiffs(item) : undefined
    const output = itemOutput(item)
    const url = itemUrl(kind, item)
    return [{
      type: "tool_updated",
      id,
      title: itemTitle(item),
      status: item.status === undefined ? "completed" : itemStatus(item.status),
      ...(diffs ? { diffs } : {}),
      ...(output ? { output } : {}),
      ...(url ? { url } : {}),
    }]
  }
  return [{ type: "metadata", name: method, data: params }]
}
