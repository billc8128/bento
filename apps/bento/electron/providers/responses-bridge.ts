/**
 * OpenAI Responses ↔ OpenAI Chat Completions 协议桥(纯函数,零 IO)。
 *
 * 用于 wireProtocol:"openai-chat" 的 user provider 被 codex 使用时:codex
 * 发出的 responses 请求翻译成 chat 请求,响应(含 SSE 流)反向翻译回
 * responses 事件语义,codex 无感。Cindy 同款能力的 Bento 版。
 *
 * 范围纪律(与 chat-bridge 对齐):只翻译 Bento 实际消费的字段子集——
 *   请求: model/instructions/input(message·function_call·function_call_output)
 *         /tools/tool_choice/max_output_tokens/temperature/stream/reasoning.effort
 *   响应: output_text 增量 / function_call 增量 / usage / completed
 * reasoning item、include、store 等 responses 专有字段剥掉;
 * reasoning.effort 透传为 chat 的 reasoning_effort(Kimi 等吃这个字段)。
 */

type ChatMessage = Record<string, unknown>

type ResponsesItem = {
  type?: unknown
  role?: unknown
  content?: unknown
  call_id?: unknown
  name?: unknown
  arguments?: unknown
  output?: unknown
}

/** responses content parts → chat content;纯文本折叠成 string。 */
function toChatContent(content: unknown, textType: string): unknown {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: unknown[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const kind = (part as { type?: unknown }).type
    if (kind === textType || kind === "input_text" || kind === "output_text") {
      parts.push({ type: "text", text: String((part as { text?: unknown }).text ?? "") })
    } else if (kind === "input_image") {
      const url = (part as { image_url?: unknown }).image_url
      if (typeof url === "string") parts.push({ type: "image_url", image_url: { url } })
    }
    // refusal / annotations 等剥掉
  }
  const onlyText = parts.every(
    (part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text",
  )
  return onlyText ? parts.map((part) => (part as { text: string }).text).join("") : parts
}

export function translateResponsesRequest(body: {
  model?: unknown
  instructions?: unknown
  input?: unknown
  tools?: unknown
  tool_choice?: unknown
  max_output_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
  stream?: unknown
  reasoning?: unknown
}): Record<string, unknown> {
  const messages: ChatMessage[] = []
  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions })
  }
  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? (body.input as ResponsesItem[]) : []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const kind = item.type ?? "message"
    if (kind === "message") {
      const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user"
      messages.push({ role, content: toChatContent(item.content, role === "assistant" ? "output_text" : "input_text") })
    } else if (kind === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: String(item.call_id ?? ""),
          type: "function",
          function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "{}") },
        }],
      })
    } else if (kind === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? ""),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      })
    }
    // reasoning / item_reference 等剥掉
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((tool) => {
          if (!tool || typeof tool !== "object") return null
          const t = tool as { type?: unknown; name?: unknown; description?: unknown; parameters?: unknown }
          if (t.type !== "function") return null
          return {
            type: "function",
            function: {
              name: String(t.name ?? ""),
              description: String(t.description ?? ""),
              parameters: t.parameters ?? { type: "object" },
            },
          }
        })
        .filter(Boolean)
    : undefined

  let toolChoice: unknown
  if (typeof body.tool_choice === "string") toolChoice = body.tool_choice
  else if (body.tool_choice && typeof body.tool_choice === "object" && (body.tool_choice as { type?: unknown }).type === "function") {
    toolChoice = { type: "function", function: { name: String((body.tool_choice as { name?: unknown }).name ?? "") } }
  }

  const effort = body.reasoning && typeof body.reasoning === "object"
    ? (body.reasoning as { effort?: unknown }).effort
    : undefined

  return {
    model: String(body.model ?? ""),
    messages,
    ...(body.stream === true ? { stream: true } : {}),
    ...(typeof body.max_output_tokens === "number" ? { max_tokens: body.max_output_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof effort === "string" ? { reasoning_effort: effort } : {}),
  }
}

// ---------------------------------------------------------------------------
// 非流式:chat 响应 → responses 响应
// ---------------------------------------------------------------------------

function toResponsesUsage(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as Record<string, unknown>
  const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0
  const output = typeof u.completion_tokens === "number" ? u.completion_tokens : 0
  return { input_tokens: input, output_tokens: output, total_tokens: input + output }
}

function responseId(): string {
  return `resp_${Math.random().toString(36).slice(2)}`
}

export function translateChatToResponses(body: {
  choices?: unknown
  usage?: unknown
  model?: unknown
}): Record<string, unknown> {
  const choice = Array.isArray(body.choices) ? (body.choices as Record<string, unknown>[])[0] : undefined
  const message = (choice?.message ?? {}) as Record<string, unknown>
  const output: Record<string, unknown>[] = []
  if (typeof message.content === "string" && message.content) {
    output.push({
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    })
  }
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : []
  for (const raw of toolCalls) {
    const fn = (raw.function ?? {}) as Record<string, unknown>
    output.push({
      id: `fc_${Math.random().toString(36).slice(2)}`,
      type: "function_call",
      status: "completed",
      call_id: String(raw.id ?? ""),
      name: String(fn.name ?? ""),
      arguments: String(fn.arguments ?? "{}"),
    })
  }
  return {
    id: responseId(),
    object: "response",
    status: "completed",
    model: String(body.model ?? ""),
    output,
    usage: toResponsesUsage(body.usage),
  }
}

// ---------------------------------------------------------------------------
// SSE 反向翻译:chat 增量 → responses 事件流
// ---------------------------------------------------------------------------

type ToolCallState = {
  itemId: string
  callId: string
  name: string
  arguments: string
  outputIndex: number
}

export class ChatToResponsesStream {
  private buffer = ""
  private readonly id = responseId()
  private model = ""
  private started = false
  private finished = false
  /** 文本 message item:开流即建,遇 tool_call 或收尾时关闭 */
  private textItemId: string | null = null
  private text = ""
  private readonly toolCalls = new Map<number, ToolCallState>()
  private nextOutputIndex = 0
  private usage: Record<string, number> = {}

  /** 喂一段 chat SSE 原始文本,产出 responses 事件(完整 SSE 帧,含 \n\n)。 */
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

  private frame(type: string, payload: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  }

  private ensureStarted(model: unknown): string[] {
    if (this.started) return []
    this.started = true
    if (typeof model === "string") this.model = model
    const response = { id: this.id, object: "response", status: "in_progress", model: this.model, output: [] }
    return [
      this.frame("response.created", { response }),
      this.frame("response.in_progress", { response }),
    ]
  }

  private ensureTextItem(): string[] {
    if (this.textItemId) return []
    this.textItemId = `msg_${Math.random().toString(36).slice(2)}`
    const outputIndex = 0
    this.nextOutputIndex = Math.max(this.nextOutputIndex, 1)
    return [
      this.frame("response.output_item.added", {
        output_index: outputIndex,
        item: { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      this.frame("response.content_part.added", {
        item_id: this.textItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    ]
  }

  private closeTextItem(): string[] {
    if (!this.textItemId) return []
    const itemId = this.textItemId
    this.textItemId = null
    return [
      this.frame("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text: this.text }),
      this.frame("response.content_part.done", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      }),
      this.frame("response.output_item.done", {
        output_index: 0,
        item: {
          id: itemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: this.text, annotations: [] }],
        },
      }),
    ]
  }

  private translateDelta(delta: Record<string, unknown>): string[] {
    const events: string[] = []
    // usage-only 帧(choice 缺省)先存下,completed 时带上
    if (delta.usage && typeof delta.usage === "object") {
      this.usage = toResponsesUsage(delta.usage)
    }
    const choices = Array.isArray(delta.choices) ? (delta.choices as Record<string, unknown>[]) : []
    const choice = choices[0]
    if (!choice) return events
    events.push(...this.ensureStarted(delta.model))
    const d = (choice.delta ?? {}) as Record<string, unknown>

    if (typeof d.content === "string" && d.content) {
      events.push(...this.ensureTextItem())
      this.text += d.content
      events.push(this.frame("response.output_text.delta", {
        item_id: this.textItemId,
        output_index: 0,
        content_index: 0,
        delta: d.content,
      }))
    }

    if (Array.isArray(d.tool_calls)) {
      events.push(...this.ensureStarted(undefined))
      events.push(...this.closeTextItem())
      for (const raw of d.tool_calls as Record<string, unknown>[]) {
        const index = typeof raw.index === "number" ? raw.index : 0
        const fn = (raw.function ?? {}) as Record<string, unknown>
        const existing = this.toolCalls.get(index)
        if (existing) {
          if (typeof fn.arguments === "string" && fn.arguments) {
            existing.arguments += fn.arguments
            events.push(this.frame("response.function_call_arguments.delta", {
              item_id: existing.itemId,
              output_index: existing.outputIndex,
              delta: fn.arguments,
            }))
          }
        } else {
          const state: ToolCallState = {
            itemId: `fc_${Math.random().toString(36).slice(2)}`,
            callId: String(raw.id ?? `call_${index}`),
            name: String(fn.name ?? ""),
            arguments: typeof fn.arguments === "string" ? fn.arguments : "",
            outputIndex: this.nextOutputIndex++,
          }
          this.toolCalls.set(index, state)
          events.push(this.frame("response.output_item.added", {
            output_index: state.outputIndex,
            item: {
              id: state.itemId,
              type: "function_call",
              status: "in_progress",
              call_id: state.callId,
              name: state.name,
              arguments: "",
            },
          }))
        }
      }
    }

    if (choice.finish_reason) {
      events.push(...this.finish())
    }
    return events
  }

  finish(): string[] {
    if (this.finished) return []
    this.finished = true
    if (!this.started) return [] // 空流:什么都不发,上游错误路径自有响应
    const events: string[] = []
    events.push(...this.closeTextItem())
    const output: Record<string, unknown>[] = []
    if (this.text) {
      output.push({
        id: `msg_done`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      })
    }
    for (const [, call] of [...this.toolCalls.entries()].sort(([a], [b]) => a - b)) {
      events.push(this.frame("response.function_call_arguments.done", {
        item_id: call.itemId,
        output_index: call.outputIndex,
        arguments: call.arguments,
      }))
      const item = {
        id: call.itemId,
        type: "function_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      }
      events.push(this.frame("response.output_item.done", { output_index: call.outputIndex, item }))
      output.push(item)
    }
    this.toolCalls.clear()
    events.push(this.frame("response.completed", {
      response: {
        id: this.id,
        object: "response",
        status: "completed",
        model: this.model,
        output,
        usage: this.usage,
      },
    }))
    return events
  }
}
