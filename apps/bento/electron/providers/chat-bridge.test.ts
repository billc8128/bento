import { describe, expect, it } from "vitest"

import { ChatToAnthropicStream, translateRequest, translateResponse } from "./chat-bridge"

describe("translateRequest", () => {
  it("system + user/assistant 文本消息翻译;纯文本 content 折叠成 string", () => {
    const request = translateRequest({
      model: "deepseek-chat",
      system: "你是助手",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: [{ type: "text", text: "在" }] },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
    })
    expect(request).toEqual({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "在" },
        { role: "user", content: "继续" },
      ],
      max_tokens: 1024,
    })
  })

  it("anthropic 专有字段剥掉;图片转 image_url;tools 翻译 input_schema→parameters", () => {
    const request = translateRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看图", cache_control: { type: "ephemeral" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      }],
      tools: [{ name: "get_weather", description: "查天气", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    })
    expect(request.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    }])
    expect(request.tools).toEqual([{
      type: "function",
      function: {
        name: "get_weather",
        description: "查天气",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    }])
  })
})

describe("ChatToAnthropicStream", () => {
  function sse(...frames: unknown[]): string {
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
  }

  it("文本增量翻译为 content_block_delta;[DONE] 补 stop 语义", () => {
    const stream = new ChatToAnthropicStream()
    const events = [
      ...stream.push(sse({ choices: [{ delta: { content: "你" } }] })),
      ...stream.push(sse({ choices: [{ delta: { content: "好" } }] })),
      ...stream.push("data: [DONE]\n\n"),
    ].join("\n")
    expect(events).toContain('"type":"content_block_delta"')
    expect(events).toContain('"text":"你"')
    expect(events).toContain('"text":"好"')
    expect(events).toContain('"type":"message_delta"')
    expect(events).toContain('"stop_reason":"end_turn"')
    expect(events).toContain('"type":"message_stop"')
  })

  it("tool_call 增量静默聚合,finish 帧一次性输出完整 input;finish_reason=tool_calls → tool_use", () => {
    const stream = new ChatToAnthropicStream()
    const accum = stream.push(sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] } }] },
    ))
    // 增量阶段不逐帧输出(claude 侧要完整 JSON 才能组 tool_use block)
    expect(accum).toEqual([])
    const events = stream.push(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })).join("\n")
    expect(events).toContain('"type":"content_block_start"')
    expect(events).toContain('"name":"read"')
    expect(events).toContain('"partial_json":"{\\"path\\":\\"a.txt\\"}"')
    expect(events).toContain('"stop_reason":"tool_use"')
    // 已收尾的流再喂 [DONE] 不重复发
    expect(stream.push("data: [DONE]\n\n")).toEqual([])
  })

  it("半行分片不炸:字节级 push 跨 chunk 拼接", () => {
    const stream = new ChatToAnthropicStream()
    const full = sse({ choices: [{ delta: { content: "ok" } }] })
    const mid = Math.floor(full.length / 2)
    const first = stream.push(full.slice(0, mid))
    const second = stream.push(full.slice(mid))
    expect(first).toEqual([])
    expect(second.join("\n")).toContain('"text":"ok"')
  })
})

describe("translateResponse", () => {
  it("非流式:文本 + tool_calls → content blocks;finish_reason 映射", () => {
    const response = translateResponse({
      model: "deepseek-chat",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "查一下",
          tool_calls: [{ id: "c1", function: { name: "read", arguments: "{\"path\":\"x\"}" } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    expect(response.content).toEqual([
      { type: "text", text: "查一下" },
      { type: "tool_use", id: "c1", name: "read", input: { path: "x" } },
    ])
    expect(response.stop_reason).toBe("tool_use")
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })
})
