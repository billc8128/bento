import { describe, expect, it } from "vitest"

import { TOOL_OUTPUT_LIMIT } from "../../src/core/events"
import { translateAcpUpdate } from "./acp-translator"

describe("translateAcpUpdate", () => {
  it("翻译文本与工具事件", () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toEqual({ type: "agent_message_chunk", text: "hello" })

    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        kind: "fetch",
        title: "网页",
        status: "pending",
      }),
    ).toEqual({
      type: "tool_started",
      id: "tool-1",
      kind: "search",
      title: "网页",
      status: "running",
    })
  })

  it("保留未知 ACP update", () => {
    expect(translateAcpUpdate({ sessionUpdate: "usage_update", tokens: 42 })).toEqual({
      type: "metadata",
      name: "usage_update",
      data: { sessionUpdate: "usage_update", tokens: 42 },
    })
  })
})

describe("translateAcpUpdate diff 统计(TRACE_DATA_PLAN §4)", () => {
  it("tool_call_update 的 content[] diff 项:oldText 非空走前后缀去重", () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "diff", path: "/a.ts", oldText: "keep\nold\nend", newText: "keep\nnew\nend" },
        ],
      }),
    ).toEqual({
      type: "tool_updated",
      id: "t1",
      status: "completed",
      diffs: [{ path: "/a.ts", added: 1, deleted: 1 }],
    })
  })

  it("oldText 为 null(新建文件)全量 added;多文件逐项透出", () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        content: [
          { type: "diff", path: "/new.ts", oldText: null, newText: "a\nb" },
          { type: "diff", path: "/b.ts", newText: "only" },
        ],
      }),
    ).toEqual({
      type: "tool_updated",
      id: "t2",
      diffs: [
        { path: "/new.ts", added: 2, deleted: 0 },
        { path: "/b.ts", added: 1, deleted: 0 },
      ],
    })
  })

  it("无 content 或无 diff 项时不发 diffs(缺省降级)", () => {
    expect(
      translateAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed" }),
    ).toEqual({ type: "tool_updated", id: "t3", status: "completed" })
    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t4",
        content: [{ type: "content", content: { type: "text", text: "普通输出" } }],
      }),
    ).toEqual({
      type: "tool_started",
      id: "t4",
      kind: "bash",
      title: "t4",
      status: "running",
    })
  })
})

describe("translateAcpUpdate 工具输出与搜索链接(TRACE_DATA_PLAN §7 P3)", () => {
  it("rawOutput 字符串直取为 output;search 类从输出提取首个链接", () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        kind: "search",
        status: "completed",
        rawOutput: "结果见 https://a.example/x?q=1。 更多",
      }),
    ).toEqual({
      type: "tool_updated",
      id: "t1",
      status: "completed",
      output: "结果见 https://a.example/x?q=1。 更多",
      url: "https://a.example/x?q=1",
    })
  })

  it("rawOutput 对象取 content[] 文本拼接(omp 形状);非 search 不发 url", () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        kind: "edit",
        status: "completed",
        rawOutput: { content: [{ type: "text", text: "Wrote " }, { type: "text", text: "2 bytes" }] },
      }),
    ).toEqual({
      type: "tool_updated",
      id: "t2",
      status: "completed",
      output: "Wrote 2 bytes",
    })
  })

  it("output 截断到 TOOL_OUTPUT_LIMIT(8KB)", () => {
    expect(
      translateAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t3",
        rawOutput: "x".repeat(TOOL_OUTPUT_LIMIT + 100),
      })?.output?.length,
    ).toBe(TOOL_OUTPUT_LIMIT)
  })
})

describe("translateAcpUpdate plan 透传(TRACE_DATA_PLAN §7 P4)", () => {
  it("plan update 保留为 metadata,reducer 依赖 name=plan 与 data.entries", () => {
    const update = {
      sessionUpdate: "plan",
      entries: [
        { content: "查文档", priority: "high", status: "completed" },
        { content: "改代码", priority: "high", status: "in_progress" },
      ],
    }
    expect(translateAcpUpdate(update)).toEqual({ type: "metadata", name: "plan", data: update })
  })
})
