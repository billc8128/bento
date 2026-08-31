import { describe, expect, it } from "vitest"

import { PI_CAPABILITIES, piModelRef, translatePiEvent } from "./pi"

describe("Pi capabilities", () => {
  it("与已实现的 set_model / set_thinking_level 保持一致", () => {
    expect(PI_CAPABILITIES).toEqual({ modelSwitch: "live", effortSwitch: "live" })
  })
})

describe("translatePiEvent", () => {
  it("翻译文本和思考增量", () => {
    expect(
      translatePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ type: "agent_message_chunk", text: "hello" })
    expect(
      translatePiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
      }),
    ).toEqual({ type: "agent_thought_chunk", text: "hmm" })
  })

  it("翻译工具生命周期", () => {
    expect(
      translatePiEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "grep",
      }),
    ).toEqual({
      type: "tool_started",
      id: "tool-1",
      kind: "search",
      title: "grep",
      status: "running",
    })
    expect(
      translatePiEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        result: "done",
        isError: false,
      }),
    ).toEqual({
      type: "tool_updated",
      id: "tool-1",
      status: "completed",
      detail: "done",
    })
  })
})

describe("translatePiEvent diff 统计(TRACE_DATA_PLAN §4)", () => {
  it("edit 的 args 是 {path, edits:[{oldText,newText}]},逐项聚合且 title 改为路径", () => {
    expect(
      translatePiEvent({
        type: "tool_execution_start",
        toolCallId: "tool-e1",
        toolName: "edit",
        args: {
          path: "/a.ts",
          edits: [
            { oldText: "keep\nold\nend", newText: "keep\nnew\nend" },
            { oldText: "gone", newText: "here\nagain" },
          ],
        },
      }),
    ).toEqual({
      type: "tool_started",
      id: "tool-e1",
      kind: "edit",
      title: "/a.ts",
      status: "running",
      diffs: [{ path: "/a.ts", added: 3, deleted: 2 }],
    })
  })

  it("write 的 content 全量 added", () => {
    expect(
      translatePiEvent({
        type: "tool_execution_start",
        toolCallId: "tool-w1",
        toolName: "write",
        args: { path: "/new.ts", content: "a\nb\n" },
      }),
    ).toEqual({
      type: "tool_started",
      id: "tool-w1",
      kind: "edit",
      title: "/new.ts",
      status: "running",
      diffs: [{ path: "/new.ts", added: 2, deleted: 0 }],
    })
  })

  it("无路径(read)title 保持工具名且不发 diffs;字段缺失降级", () => {
    expect(
      translatePiEvent({ type: "tool_execution_start", toolCallId: "tool-r1", toolName: "read" }),
    ).toEqual({
      type: "tool_started",
      id: "tool-r1",
      kind: "read",
      title: "read",
      status: "running",
    })
    expect(
      translatePiEvent({
        type: "tool_execution_start",
        toolCallId: "tool-e2",
        toolName: "edit",
        args: { path: "/b.ts" },
      }),
    ).toEqual({
      type: "tool_started",
      id: "tool-e2",
      kind: "edit",
      title: "/b.ts",
      status: "running",
    })
  })
})

describe("translatePiEvent 错误终态", () => {
  it("把扩展错误变成脱敏 notice", () => {
    expect(
      translatePiEvent({
        type: "extension_error",
        extensionPath: "/tmp/bento-pi-mcp.mjs",
        error: "request failed for 123e4567-e89b-12d3-a456-426614174000",
      }),
    ).toEqual({ type: "notice", text: "Pi 扩展错误:request failed for <redacted>" })
  })

  it("turn_end 的 error 停止原因翻译成 notice,并提取 JSON 里的 message", () => {
    expect(
      translatePiEvent({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: '401: {"code":"401","message":"令牌已过期或验证不正确"}',
        },
      }),
    ).toEqual({ type: "notice", text: "模型请求失败:401 令牌已过期或验证不正确" })
  })

  it("无法解析的错误原文保留", () => {
    expect(
      translatePiEvent({
        type: "turn_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "上游失联" },
      }),
    ).toEqual({ type: "notice", text: "模型请求失败:上游失联" })
  })

  it("正常完成与 user 消息终态不产生事件", () => {
    expect(
      translatePiEvent({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      }),
    ).toBeUndefined()
    expect(
      translatePiEvent({ type: "message_end", message: { role: "user", content: [] } }),
    ).toBeUndefined()
  })
})

describe("piModelRef", () => {
  it("解析 ProviderDiscoveryService 产出的 provider/model", () => {
    expect(piModelRef("anthropic/claude-sonnet")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
    })
    expect(() => piModelRef("bare-model")).toThrow(/provider\/model/)
  })
})

describe("translatePiEvent 工具输出(TRACE_DATA_PLAN §7 P3)", () => {
  it("result 已全量进 detail(对象走 JSON 序列化),不重复发 output", () => {
    expect(
      translatePiEvent({
        type: "tool_execution_end",
        toolCallId: "tool-9",
        result: { text: "第一行", rows: 3 },
        isError: false,
      }),
    ).toEqual({
      type: "tool_updated",
      id: "tool-9",
      status: "completed",
      detail: '{"text":"第一行","rows":3}',
    })
  })
})
