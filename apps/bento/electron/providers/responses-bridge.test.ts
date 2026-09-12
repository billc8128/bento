import { describe, expect, it } from "vitest"

import { ChatToResponsesStream, translateChatToResponses, translateResponsesRequest } from "./responses-bridge"

describe("translateResponsesRequest", () => {
  it("instructions→system;三类 input item 翻译;纯文本 content 折叠成 string", () => {
    const request = translateResponsesRequest({
      model: "kimi-k3",
      instructions: "你是助手",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "读文件" }] },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{\"path\":\"a\"}" },
        { type: "function_call_output", call_id: "c1", output: "文件内容" },
        { type: "reasoning", summary: [] }, // 剥掉
      ],
    })
    expect(request).toEqual({
      model: "kimi-k3",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "读文件" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "文件内容" },
      ],
    })
  })

  it("string input 兜底为 user message;tools 只留 function 并平铺;专有字段剥离", () => {
    const request = translateResponsesRequest({
      model: "m",
      input: "你好",
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [
        { type: "function", name: "get_weather", description: "查天气", parameters: { type: "object" } },
        { type: "web_search_preview" }, // 非 function 剥掉
      ],
      max_output_tokens: 1024,
      temperature: 0.5,
      stream: true,
      reasoning: { effort: "high" },
    })
    expect(request.messages).toEqual([{ role: "user", content: "你好" }])
    expect(request.tools).toEqual([{
      type: "function",
      function: { name: "get_weather", description: "查天气", parameters: { type: "object" } },
    }])
    expect(request.max_tokens).toBe(1024)
    expect(request.stream).toBe(true)
    // reasoning.effort 透传为 chat 的 reasoning_effort(Kimi 吃这个字段)
    expect(request.reasoning_effort).toBe("high")
    expect(request).not.toHaveProperty("store")
    expect(request).not.toHaveProperty("include")
  })
})

describe("translateChatToResponses", () => {
  it("非流式:文本 + tool_calls → output items;usage 映射", () => {
    const response = translateChatToResponses({
      model: "kimi-k3",
      choices: [{
        message: {
          content: "查一下",
          tool_calls: [{ id: "c1", function: { name: "read", arguments: "{\"path\":\"x\"}" } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    expect(response.status).toBe("completed")
    const output = response.output as Record<string, unknown>[]
    expect(output[0]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "查一下" }],
    })
    expect(output[1]).toMatchObject({ type: "function_call", call_id: "c1", name: "read", arguments: "{\"path\":\"x\"}" })
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
  })
})

describe("ChatToResponsesStream", () => {
  function sse(...frames: unknown[]): string {
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
  }

  it("文本增量:created/in_progress 开局,output_text.delta 逐字,completed 带 usage 收尾", () => {
    const stream = new ChatToResponsesStream()
    const events = [
      ...stream.push(sse({ model: "m", choices: [{ delta: { content: "你" } }] })),
      ...stream.push(sse({ choices: [{ delta: { content: "好" } }] })),
      ...stream.push(sse({ usage: { prompt_tokens: 3, completion_tokens: 2 } })),
      ...stream.push("data: [DONE]\n\n"),
    ].join("")
    expect(events).toContain("event: response.created")
    expect(events).toContain("event: response.in_progress")
    expect(events).toContain("event: response.output_item.added")
    expect(events).toContain("event: response.content_part.added")
    expect(events).toContain('"type":"response.output_text.delta","item_id"')
    expect(events).toContain('"delta":"你"')
    expect(events).toContain('"delta":"好"')
    expect(events).toContain("event: response.output_text.done")
    expect(events).toContain("event: response.output_item.done")
    // usage-only 帧存到 completed 带上
    const completed = events.split("\n\n").find((frame) => frame.includes("response.completed") && frame.startsWith("event"))
    expect(completed).toContain('"input_tokens":3')
    expect(completed).toContain('"output_tokens":2')
  })

  it("tool_call:先关文本 item,再开 function_call item,arguments 增量累积,done 输出完整参数", () => {
    const stream = new ChatToResponsesStream()
    const events = [
      ...stream.push(sse({ model: "m", choices: [{ delta: { content: "看下" } }] })),
      ...stream.push(sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] } }] },
      )),
      ...stream.push(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })),
    ].join("")
    expect(events).toContain("event: response.output_text.done")
    expect(events).toContain('"type":"function_call","status":"in_progress"')
    expect(events).toContain("event: response.function_call_arguments.delta")
    expect(events).toContain('"arguments":"{\\"path\\":\\"a.txt\\"}"')
    expect(events).toContain("event: response.completed")
    // 已收尾再喂 [DONE] 不重复发
    expect(stream.push("data: [DONE]\n\n")).toEqual([])
  })

  it("半行分片不炸:字节级 push 跨 chunk 拼接;空流 finish 发空数组", () => {
    const stream = new ChatToResponsesStream()
    const full = sse({ model: "m", choices: [{ delta: { content: "ok" } }] })
    const mid = Math.floor(full.length / 2)
    expect(stream.push(full.slice(0, mid))).toEqual([])
    expect(stream.push(full.slice(mid)).join("")).toContain('"delta":"ok"')

    const empty = new ChatToResponsesStream()
    expect(empty.finish()).toEqual([])
  })
})
