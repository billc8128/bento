/**
 * Anthropic Messages ↔ OpenAI Chat Completions 协议桥(纯函数,零 IO)。
 *
 * 用于 wireProtocol:"openai-chat" 的 user provider:claude-code 发出的
 * anthropic-messages 请求翻译成 openai chat 请求,响应(含 SSE 流)反向
 * 翻译回 anthropic 语义,claude-code 无感。
 *
 * 范围纪律(方案 v2):只翻译 Bento 实际消费的字段子集——
 *   请求: model/messages/system/max_tokens/temperature/stream/tools/tool_choice
 *   响应: 文本增量 / tool_call 增量 / finish_reason / usage / stop 原因
 * thinking(budget_tokens)不映射(reasoning 一律 false 的模型不发它);
 * 图片输入按 openai image_url 透传;cache_control 等 anthropic 专有字段剥掉。
 */

export type AnthropicMessage = {
  role: "user" | "assistant"
  content: unknown
}

type OpenAiChatRequest = {
  model: string
  messages: unknown[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  tools?: unknown[]
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { text?: unknown }).type === "text"
          ? String((block as { text: unknown }).text ?? "")
          : "",
      )
      .join("")
  }
  return ""
}

function isImageBlock(block: unknown): block is { source: { type: string; media_type: string; data: string } } {
  return Boolean(
    block && typeof block === "object" &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { source?: unknown }).source === "object",
  )
}

/** anthropic content blocks → openai content 数组;纯文本折叠成 string。 */
function toOpenAiContent(content: unknown): unknown {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return textOf(content)
  const parts: unknown[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const kind = (block as { type?: unknown }).type
    if (kind === "text") parts.push({ type: "text", text: String((block as { text?: unknown }).text ?? "") })
    else if (kind === "image" && isImageBlock(block)) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      })
    } else if (kind === "tool_use") {
      parts.push({
        role: "assistant" as const,
        tool_calls: [{
          id: (block as { id?: unknown }).id ?? "",
          type: "function",
          function: {
            name: String((block as { name?: unknown }).name ?? ""),
            arguments: JSON.stringify((block as { input?: unknown }).input ?? {}),
          },
        }],
      })
    }
    // tool_result / thinking / cache_control 持有者:文本折叠已处理,其余剥掉
  }
  const onlyText = parts.every((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
  return onlyText ? parts.map((part) => (part as { text: string }).text).join("") : parts
}

export function translateRequest(body: {
  model?: unknown
  messages?: unknown
  system?: unknown
  max_tokens?: unknown
  temperature?: unknown
  stream?: unknown
  tools?: unknown
}): OpenAiChatRequest {
  const messages: unknown[] = []
  if (body.system !== undefined) messages.push({ role: "system", content: toOpenAiContent(body.system) })
  for (const message of Array.isArray(body.messages) ? (body.messages as AnthropicMessage[]) : []) {
    const content = toOpenAiContent(message.content)
    if (message.role === "assistant") messages.push({ role: "assistant", content })
    else messages.push({ role: "user", content })
  }
  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((tool) => tool && typeof tool === "object" ? {
          type: "function",
          function: {
            name: String((tool as { name?: unknown }).name ?? ""),
            description: String((tool as { description?: unknown }).description ?? ""),
            parameters: (tool as { input_schema?: unknown }).input_schema ?? { type: "object" },
          },
        } : null)
        .filter(Boolean)
    : undefined
  return {
    model: String(body.model ?? ""),
    messages,
    ...(body.stream === true ? { stream: true } : {}),
    ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  }
}

// ---------------------------------------------------------------------------
// SSE 反向翻译:openai chat 增量 → anthropic 事件流
// ---------------------------------------------------------------------------

/** 聚合中的 tool_call 增量(按 index)。 */
type ToolCallAccumulator = {
  id: string
  name: string
  arguments: string
}

export class ChatToAnthropicStream {
  private buffer = ""
  private index = 0
  private readonly toolCalls = new Map<number, ToolCallAccumulator>()
  private messageStarted = false
  private finished = false

  /** 喂一段 openai SSE 原始字节,产出 anthropic 事件(JSON 行数组,不含换行)。 */
  push(chunk: string): string[] {
    this.buffer += chunk
    const events: string[] = []
    while (true) {
      const lineEnd = this.buffer.indexOf("\n")
      if (lineEnd === -1) break
      const line = this.buffer.slice(0, lineEnd).trim()
      this.buffer = this.buffer.slice(lineEnd + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") {
        events.push(...this.finish())
        continue
      }
      let delta: Record<string, unknown>
      try {
        delta = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue // 半行/心跳
      }
      events.push(...this.translateDelta(delta))
    }
    return events
  }
  private ensureStart(): void {
    this.messageStarted = true
  }

  private translateDelta(delta: Record<string, unknown>): string[] {
    const choices = Array.isArray(delta.choices) ? (delta.choices as Record<string, unknown>[]) : []
    const choice = choices[0]
    if (!choice) {
      // usage-only 帧:转发为 anthropic message_delta
      if (delta.usage && typeof delta.usage === "object") {
        return [this.event({ type: "message_delta", delta: { stop_reason: null }, usage: toAnthropicUsage(delta.usage) })]
      }
      return []
    }
    const d = (choice.delta ?? {}) as Record<string, unknown>
    const events: string[] = []
    if (typeof d.content === "string" && d.content) {
      this.ensureStart()
      events.push(this.event({
        type: "content_block_delta",
        index: this.index,
        delta: { type: "text_delta", text: d.content },
      }))
    }
    if (Array.isArray(d.tool_calls)) {
      for (const raw of d.tool_calls as Record<string, unknown>[]) {
        const index = typeof raw.index === "number" ? raw.index : 0
        const fn = (raw.function ?? {}) as Record<string, unknown>
        const existing = this.toolCalls.get(index)
        if (existing) {
          if (typeof fn.arguments === "string") existing.arguments += fn.arguments
        } else {
          this.toolCalls.set(index, {
            id: String(raw.id ?? `tool_${index}`),
            name: String(fn.name ?? ""),
            arguments: typeof fn.arguments === "string" ? fn.arguments : "",
          })
        }
      }
    }
    if (choice.finish_reason) {
      events.push(...this.finish(choice.finish_reason))
    }
    return events
  }

  finish(finishReason?: string): string[] {
    if (this.finished) return []
    this.finished = true
    const events: string[] = []
    for (const [, call] of [...this.toolCalls.entries()].sort(([a], [b]) => a - b)) {
      this.ensureStart()
      events.push(this.event({
        type: "content_block_start",
        index: this.index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      }))
      let input: unknown = {}
      try {
        input = JSON.parse(call.arguments || "{}")
      } catch {
        input = { _raw: call.arguments }
      }
      events.push(this.event({
        type: "content_block_delta",
        index: this.index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      }))
      events.push(this.event({ type: "content_block_stop", index: this.index }))
      this.index += 1
    }
    this.toolCalls.clear()
    // [DONE] 无 finish_reason = 正常收尾;finish_reason 缺认 end_turn
    const stopReason = finishReason === "tool_calls"
      ? "tool_use"
      : finishReason === "length"
        ? "max_tokens"
        : "end_turn"
    events.push(this.event({ type: "message_delta", delta: { stop_reason: stopReason }, usage: {} }))
    events.push(this.event({ type: "message_stop" }))
    return events
  }

  private event(payload: Record<string, unknown>): string {
    return `event: ${String(payload.type)}\ndata: ${JSON.stringify({ type: payload.type, ...payload })}`
  }
}

function toAnthropicUsage(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as Record<string, unknown>
  return {
    input_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
  }
}

/** 非流式:openai chat 响应 → anthropic messages 响应。 */
export function translateResponse(body: {
  choices?: unknown
  usage?: unknown
  model?: unknown
}): Record<string, unknown> {
  const choice = Array.isArray(body.choices) ? (body.choices as Record<string, unknown>[])[0] : undefined
  const message = (choice?.message ?? {}) as Record<string, unknown>
  const content: Record<string, unknown>[] = []
  if (typeof message.content === "string" && message.content)
    content.push({ type: "text", text: message.content })
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : []
  for (const raw of toolCalls) {
    const fn = (raw.function ?? {}) as Record<string, unknown>
    let input: unknown = {}
    try {
      input = JSON.parse(String(fn.arguments ?? "{}"))
    } catch {
      input = { _raw: fn.arguments }
    }
    content.push({ type: "tool_use", id: String(raw.id ?? ""), name: String(fn.name ?? ""), input })
  }
  const stopReason = choice?.finish_reason === "tool_calls"
    ? "tool_use"
    : choice?.finish_reason === "length"
      ? "max_tokens"
      : "end_turn"
  return {
    id: `chatm-${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: String(body.model ?? ""),
    content,
    stop_reason: stopReason,
    usage: toAnthropicUsage(body.usage),
  }
}
