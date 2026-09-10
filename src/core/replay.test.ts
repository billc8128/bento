import { describe, expect, it } from "vitest"

import { applyRecord, createAccumulator, finalizeTrailing, messagesOf } from "./replay"

const at = "2026-08-24T00:00:00.000Z"
const T = Date.parse(at)

describe("replay", () => {
  it("按事件顺序保留 thinking、tool 与 steer 时间线", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "agent_thought_chunk", text: "先分析" } },
      { seq: 2, at, kind: "event", payload: { type: "tool_started", id: "t1", kind: "search", title: "搜索资料", status: "running" } },
      { seq: 3, at, kind: "event", payload: { type: "agent_thought_chunk", text: "再判断" } },
      { seq: 4, at, kind: "event", payload: { type: "user_steer", text: "先做移动端", clientMessageId: "c1" } },
    ] as const
    for (const record of records) applyRecord(acc, record)
    expect(messagesOf(acc)[0]).toMatchObject({
      activity: [
        { kind: "thinking", text: "先分析" },
        { kind: "tool", tool: { target: "搜索资料" } },
        { kind: "thinking", text: "再判断" },
        { kind: "steer", text: "先做移动端" },
      ],
    })
  })

  it("用户附件元数据进入消息流但不包含本地路径", () => {
    const acc = createAccumulator()
    applyRecord(acc, {
      seq: 1,
      at,
      kind: "event",
      payload: {
        type: "user_message",
        text: "看一下",
        attachments: [{ name: "report.pdf", kind: "file" }],
      },
    })
    expect(messagesOf(acc)).toEqual([{
      id: "u1",
      role: "user",
      text: "看一下",
      attachments: [{ name: "report.pdf", kind: "file" }],
    }])
  })

  it("把统一事件流投影成消息并更新工具状态", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "user_message", text: "修一下" } },
      { seq: 2, at, kind: "event", payload: { type: "agent_thought_chunk", text: "先看代码" } },
      {
        seq: 3,
        at,
        kind: "event",
        payload: {
          type: "tool_started",
          id: "t1",
          kind: "read",
          title: "src/App.tsx",
          status: "running",
        },
      },
      {
        seq: 4,
        at,
        kind: "event",
        payload: { type: "tool_updated", id: "t1", status: "completed" },
      },
      { seq: 5, at, kind: "event", payload: { type: "agent_message_chunk", text: "好了" } },
      { seq: 6, at, kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const

    for (const record of records) applyRecord(acc, record)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "修一下" },
      {
        id: "a1",
        role: "assistant",
        text: "好了",
        thinking: "先看代码",
        tools: [
          { kind: "read", target: "src/App.tsx", detail: "", status: "done", startedAtMs: T, durationMs: 0 },
        ],
        activity: [
          { id: "thinking-2", kind: "thinking", text: "先看代码", startedAtMs: T, durationMs: 0 },
          { id: "t1", kind: "tool", tool: { kind: "read", target: "src/App.tsx", detail: "", status: "done", startedAtMs: T, durationMs: 0 } },
        ],
        durationMs: 0,
      },
    ])
  })

  it("继续兼容 v0.3 的 ACP 原始日志并按 seq 去重", () => {
    const acc = createAccumulator()
    const record = {
      seq: 1,
      at,
      kind: "update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "旧历史" },
      },
    }
    applyRecord(acc, record)
    applyRecord(acc, record)

    expect(messagesOf(acc)).toMatchObject([
      { role: "assistant", text: "旧历史" },
    ])
  })
})

describe("permission metadata 不终结 draft(TRACE_DATA_PLAN §3.4 P0 回归)", () => {
  it("metadata 照常落盘但不渲染,其后的 tool_updated 正常命中并落定", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "user_message", text: "改一下" } },
      { seq: 2, at, kind: "event", payload: { type: "agent_thought_chunk", text: "想想" } },
      {
        seq: 3,
        at,
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "edit", title: "Edit", status: "running" },
      },
      // canUseTool/requestPermission 改道后的 permission 事件
      {
        seq: 4,
        at,
        kind: "event",
        payload: { type: "metadata", name: "permission/auto_approved", data: { toolName: "Edit" } },
      },
      {
        seq: 5,
        at,
        kind: "event",
        payload: { type: "tool_updated", id: "t1", title: "src/App.tsx", status: "completed" },
      },
      { seq: 6, at, kind: "event", payload: { type: "agent_message_chunk", text: "改好了" } },
      { seq: 7, at, kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const

    for (const record of records) applyRecord(acc, record)

    // 旧实现(notice 拆 draft)下这里会是两条 assistant 消息且工具永远 running
    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "改一下" },
      {
        id: "a1",
        role: "assistant",
        text: "改好了",
        thinking: "想想",
        tools: [{ kind: "edit", target: "src/App.tsx", detail: "", status: "done", startedAtMs: T, durationMs: 0 }],
        activity: [
          { id: "thinking-2", kind: "thinking", text: "想想", startedAtMs: T, durationMs: 0 },
          { id: "t1", kind: "tool", tool: { kind: "edit", target: "src/App.tsx", detail: "", status: "done", startedAtMs: T, durationMs: 0 } },
        ],
        durationMs: 0,
      },
    ])
  })
})

describe("finalize 强制 running→failed(错误路径回放一致性)", () => {
  it("历史日志中的成功恢复提示静默，恢复失败提示仍保留", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "notice", text: "会话已恢复(resume),上下文延续" } },
      { seq: 2, at, kind: "notice", payload: { text: "会话已恢复(Codex thread/resume),上下文延续" } },
      { seq: 3, at, kind: "event", payload: { type: "notice", text: "原会话无法恢复,已开新上下文续接" } },
    ] as const

    for (const record of records) applyRecord(acc, record)

    expect(messagesOf(acc)).toEqual([
      { id: "n3", role: "assistant", text: "⚠️ 原会话无法恢复,已开新上下文续接" },
    ])
  })

  it("错误 notice 先终结 draft 时,未落定的工具改写为 failed 且无重复错误消息", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "user_message", text: "跑一个长任务" } },
      {
        seq: 2,
        at,
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "bash", title: "sleep 100", status: "running" },
      },
      // 落盘的 driver 错误 notice——错误消息只来自这里
      { seq: 3, at, kind: "event", payload: { type: "notice", text: "Claude: overloaded" } },
      { seq: 4, at, kind: "event", payload: { type: "turn_finished", reason: "error" } },
    ] as const

    for (const record of records) applyRecord(acc, record)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "跑一个长任务" },
      {
        id: "a1",
        role: "assistant",
        text: "",
        tools: [{ kind: "bash", target: "sleep 100", detail: "", status: "failed", startedAtMs: T }],
        activity: [{ id: "t1", kind: "tool", tool: { kind: "bash", target: "sleep 100", detail: "", status: "failed", startedAtMs: T } }],
        outcome: "error",
        durationMs: 0,
      },
      { id: "n3", role: "assistant", text: "⚠️ Claude: overloaded" },
    ])
  })
})

describe("finalizeTrailing 回放终界(TRACE_DATA_PLAN §3.3)", () => {
  it("崩溃会话的 trailing draft 收尾:running 强制 failed 且不再是 draft", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "user_message", text: "继续" } },
      { seq: 2, at, kind: "event", payload: { type: "agent_thought_chunk", text: "想想" } },
      {
        seq: 3,
        at,
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" },
      },
    ] as const
    for (const record of records) applyRecord(acc, record)

    // 收尾前:trailing draft 原样吐出,spinner 照转
    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "继续" },
      {
        id: "draft",
        role: "assistant",
        text: "",
        thinking: "想想",
        tools: [{ kind: "read", target: "a.ts", detail: "", status: "running", startedAtMs: T }],
        activity: [
          { id: "thinking-2", kind: "thinking", text: "想想", startedAtMs: T, durationMs: 0 },
          { id: "t1", kind: "tool", tool: { kind: "read", target: "a.ts", detail: "", status: "running", startedAtMs: T } },
        ],
      },
    ])

    finalizeTrailing(acc, at)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "继续" },
      {
        id: "a1",
        role: "assistant",
        text: "",
        thinking: "想想",
        tools: [{ kind: "read", target: "a.ts", detail: "", status: "failed", startedAtMs: T }],
        activity: [
          { id: "thinking-2", kind: "thinking", text: "想想", startedAtMs: T, durationMs: 0 },
          { id: "t1", kind: "tool", tool: { kind: "read", target: "a.ts", detail: "", status: "failed", startedAtMs: T } },
        ],
        outcome: "interrupted",
        durationMs: 0,
      },
    ])
  })

  it("没有 trailing draft 时收尾是无害的 no-op", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at, kind: "event", payload: { type: "user_message", text: "hi" } })
    finalizeTrailing(acc, at)
    expect(messagesOf(acc)).toEqual([{ id: "u1", role: "user", text: "hi" }])
  })
})

describe("at 差计时(TRACE_DATA_PLAN §3.3 M1)", () => {
  function atOffset(ms: number) {
    return new Date(T + ms).toISOString()
  }

  it("tool_updated 终态时以 at - startedAtMs 写 durationMs", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "查一下" } },
      {
        seq: 2,
        at: atOffset(1_000),
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "search", title: "grep foo", status: "running" },
      },
      {
        seq: 3,
        at: atOffset(5_200),
        kind: "event",
        payload: { type: "tool_updated", id: "t1", status: "completed" },
      },
      { seq: 4, at: atOffset(5_200), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const assistant = messagesOf(acc)[1]
    expect(assistant && assistant.role === "assistant" && assistant.tools?.[0]).toMatchObject({
      startedAtMs: T + 1_000,
      durationMs: 4_200,
    })
  })

  it("同 tick(at 相同)durationMs 为 0,交给 formatDuration 的 <0.1s 下限", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "user_message", text: "hi" } },
      {
        seq: 2,
        at,
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" },
      },
      {
        seq: 3,
        at,
        kind: "event",
        payload: { type: "tool_updated", id: "t1", status: "completed" },
      },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const assistant = messagesOf(acc)[1]
    expect(assistant && assistant.role === "assistant" && assistant.tools?.[0]?.durationMs).toBe(0)
  })

  it("回合 durationMs = 首个 draft 事件到 turn_finished 的 at 差", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } },
      { seq: 2, at: atOffset(300), kind: "event", payload: { type: "agent_thought_chunk", text: "想" } },
      {
        seq: 3,
        at: atOffset(2_000),
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" },
      },
      {
        seq: 4,
        at: atOffset(9_000),
        kind: "event",
        payload: { type: "tool_updated", id: "t1", status: "completed" },
      },
      { seq: 5, at: atOffset(12_000), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const assistant = messagesOf(acc)[1]
    expect(assistant && assistant.role === "assistant" && assistant.durationMs).toBe(11_700)
    expect(assistant && assistant.role === "assistant" && assistant.tools?.[0]?.durationMs).toBe(7_000)
  })

  it("draft 未定稿时(messagesOf 的 draft)没有 durationMs", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } })
    applyRecord(acc, { seq: 2, at: atOffset(500), kind: "event", payload: { type: "agent_thought_chunk", text: "想" } })

    expect(messagesOf(acc).at(-1)).toMatchObject({ id: "draft" })
    expect(messagesOf(acc).at(-1)).not.toHaveProperty("durationMs")
  })

  it("legacy 路径同样按 at 差计时(v0.3 会话也能显示耗时)", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "user_message", payload: { text: "旧会话" } },
      {
        seq: 2,
        at: atOffset(400),
        kind: "update",
        payload: { sessionUpdate: "tool_call", toolCallId: "t1", kind: "read", title: "a.ts", status: "in_progress" },
      },
      {
        seq: 3,
        at: atOffset(1_100),
        kind: "update",
        payload: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      },
      { seq: 4, at: atOffset(1_500), kind: "turn_end", payload: {} },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const assistant = messagesOf(acc)[1]
    expect(assistant && assistant.role === "assistant" && assistant.tools?.[0]).toMatchObject({
      status: "done",
      startedAtMs: T + 400,
      durationMs: 700,
    })
    expect(assistant && assistant.role === "assistant" && assistant.durationMs).toBe(1_100)
  })
})

describe("工具输出与搜索链接透传(TRACE_DATA_PLAN §7 P3)", () => {
  const atOffset = (ms: number) => new Date(T + ms).toISOString()

  it("tool_updated 的 output/url 透传到 ToolCall,后者覆盖前者", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "搜一下" } },
      {
        seq: 2,
        at: atOffset(10),
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "search", title: "web", status: "running" },
      },
      {
        seq: 3,
        at: atOffset(20),
        kind: "event",
        payload: {
          type: "tool_updated",
          id: "t1",
          status: "completed",
          output: "第一版输出",
          url: "https://a.example/x",
        },
      },
      {
        seq: 4,
        at: atOffset(30),
        kind: "event",
        payload: { type: "tool_updated", id: "t1", output: "更全的输出" },
      },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const assistant = messagesOf(acc)[1]
    expect(assistant && assistant.role === "assistant" && assistant.tools?.[0]).toEqual({
      kind: "search",
      target: "web",
      detail: "",
      status: "done",
      startedAtMs: T + 10,
      durationMs: 20,
      output: "更全的输出",
      url: "https://a.example/x",
    })
  })

  it("没有 output/url 的事件不产生字段,旧会话回放自动隐藏", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } })
    applyRecord(acc, {
      seq: 2,
      at: atOffset(10),
      kind: "event",
      payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" },
    })
    applyRecord(acc, {
      seq: 3,
      at: atOffset(20),
      kind: "event",
      payload: { type: "tool_updated", id: "t1", status: "completed" },
    })

    const tool = messagesOf(acc)[1]
    expect(tool && tool.role === "assistant" && tool.tools?.[0]).not.toHaveProperty("output")
    expect(tool && tool.role === "assistant" && tool.tools?.[0]).not.toHaveProperty("url")
  })
})

describe("tool_updated 的 detail 透传(合并语义回归)", () => {
  const atOffset = (ms: number) => new Date(T + ms).toISOString()

  it("detail 写入 ToolCall,后续更新覆盖;缺 detail 的更新保留旧值", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "跑一下" } },
      {
        seq: 2,
        at: atOffset(10),
        kind: "event",
        payload: { type: "tool_started", id: "t1", kind: "bash", title: "pnpm test", status: "running" },
      },
      {
        seq: 3,
        at: atOffset(20),
        kind: "event",
        payload: { type: "tool_updated", id: "t1", detail: "271 passed" },
      },
      {
        seq: 4,
        at: atOffset(30),
        kind: "event",
        payload: { type: "tool_updated", id: "t1", status: "completed", detail: "271 passed · 6.3s" },
      },
      {
        seq: 5,
        at: atOffset(40),
        kind: "event",
        payload: { type: "tool_updated", id: "t1", status: "failed" },
      },
      { seq: 6, at: atOffset(50), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const tool = messagesOf(acc)[1]
    expect(tool && tool.role === "assistant" && tool.tools?.[0]).toMatchObject({
      status: "failed",
      detail: "271 passed · 6.3s",
    })
  })
})

describe("plan 与 usage(TRACE_DATA_PLAN §7 P4)", () => {
  const atOffset = (ms: number) => new Date(T + ms).toISOString()

  it("metadata 的 plan 事件写入回合计划并整体替换;非法条目跳过", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "做个功能" } },
      {
        seq: 2,
        at: atOffset(10),
        kind: "event",
        payload: {
          type: "metadata",
          name: "plan",
          data: {
            entries: [
              { content: "读代码", priority: "high", status: "completed" },
              { content: "改代码", priority: "high", status: "in_progress" },
            ],
          },
        },
      },
      {
        seq: 3,
        at: atOffset(20),
        kind: "event",
        payload: {
          type: "metadata",
          name: "plan",
          data: {
            entries: [
              { content: "读代码", priority: "high", status: "completed" },
              { content: "改代码", priority: "high", status: "completed" },
              { content: "", status: "pending" },
              { content: 42, status: "pending" },
            ],
          },
        },
      },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "agent_message_chunk", text: "完成" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const assistant = messagesOf(acc)[1]
    expect(assistant && assistant.role === "assistant" && assistant.plan).toEqual([
      { content: "读代码", status: "completed" },
      { content: "改代码", status: "completed" },
    ])
  })

  it("turn_finished 的 usage 写入回合消息;无 usage 的终点不产生字段", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "第一个" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "一" } },
      {
        seq: 3,
        at: atOffset(20),
        kind: "event",
        payload: {
          type: "turn_finished",
          reason: "end_turn",
          usage: { inputTokens: 1500, outputTokens: 400, cost: 0.02 },
        },
      },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "user_message", text: "第二个" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "agent_message_chunk", text: "二" } },
      { seq: 6, at: atOffset(50), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const [first, second] = messagesOf(acc).filter((m) => m.role === "assistant")
    expect(first.usage).toEqual({ inputTokens: 1500, outputTokens: 400, cost: 0.02 })
    expect(second).not.toHaveProperty("usage")
  })

  it("notice 终结的回合不带 usage(usage 只随 turn_finished 上送)", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "好" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "notice", text: "Codex 运行失败" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    const notice = messagesOf(acc)[1]
    expect(notice && notice.role === "assistant").toBe(true)
    expect(notice).not.toHaveProperty("usage")
  })
})

describe("user_message origin(协作来源)", () => {
  it("带 origin 的 user_message 回放后 origin 不丢", () => {
    const acc = createAccumulator()
    applyRecord(acc, {
      seq: 1,
      at,
      kind: "event",
      payload: {
        type: "user_message",
        text: "帮我 review",
        origin: { kind: "session", sessionId: "s-123456789", title: "reviewer", harnessId: "pi" },
      },
    })
    expect(messagesOf(acc)).toEqual([{
      id: "u1",
      role: "user",
      text: "帮我 review",
      origin: { kind: "session", sessionId: "s-123456789", title: "reviewer", harnessId: "pi" },
    }])
  })

  it("无 origin 的事件与 v0.3 legacy user_message 均不带 origin(按 human 处理)", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at, kind: "event", payload: { type: "user_message", text: "人类消息" } })
    applyRecord(acc, { seq: 2, at, kind: "user_message", payload: { text: "legacy 消息" } })
    const messages = messagesOf(acc)
    expect(messages[0]).toEqual({ id: "u1", role: "user", text: "人类消息" })
    expect(messages[1]).toEqual({ id: "u2", role: "user", text: "legacy 消息" })
  })
})

describe("final message 按工具边界分段(过程文字不混入 final)", () => {
  const atOffset = (ms: number) => new Date(T + ms).toISOString()

  it("过程→tool→final:工具前的公开文字成为 progress,最后一次工具后的文本才是 final", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "看下文档" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "我看一下 " } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "agent_message_chunk", text: "接入文档。" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_started", id: "t1", kind: "search", title: "FetchURL", status: "running" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 6, at: atOffset(50), kind: "event", payload: { type: "agent_message_chunk", text: "文档在这里。" } },
      { seq: 7, at: atOffset(60), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "看下文档" },
      {
        id: "a1",
        role: "assistant",
        text: "文档在这里。",
        tools: [{ kind: "search", target: "FetchURL", detail: "", status: "done", startedAtMs: T + 30, durationMs: 10 }],
        activity: [
          { id: "progress-4", kind: "progress", text: "我看一下 接入文档。" },
          { id: "t1", kind: "tool", tool: { kind: "search", target: "FetchURL", detail: "", status: "done", startedAtMs: T + 30, durationMs: 10 } },
        ],
        durationMs: 50,
      },
    ])
  })

  it("过程→tool→过程→tool→final:多段过程按事件顺序稳定入 timeline,thinking 不混入", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "做一下" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_thought_chunk", text: "先想" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "agent_message_chunk", text: "第一段过程。" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 6, at: atOffset(50), kind: "event", payload: { type: "agent_message_chunk", text: "第二段过程。" } },
      { seq: 7, at: atOffset(60), kind: "event", payload: { type: "agent_thought_chunk", text: "再想" } },
      { seq: 8, at: atOffset(70), kind: "event", payload: { type: "tool_started", id: "t2", kind: "edit", title: "b.ts", status: "running" } },
      { seq: 9, at: atOffset(80), kind: "event", payload: { type: "tool_updated", id: "t2", status: "completed" } },
      { seq: 10, at: atOffset(90), kind: "event", payload: { type: "agent_message_chunk", text: "最终回答。" } },
      { seq: 11, at: atOffset(100), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    const m = messagesOf(acc)[1]
    expect(m && m.role === "assistant" && m.text).toBe("最终回答。")
    expect(m && m.role === "assistant" && m.thinking).toBe("先想再想")
    expect(m && m.role === "assistant" && m.activity).toEqual([
      { id: "thinking-2", kind: "thinking", text: "先想", startedAtMs: T + 10, durationMs: 10 },
      { id: "progress-4", kind: "progress", text: "第一段过程。" },
      { id: "t1", kind: "tool", tool: { kind: "read", target: "a.ts", detail: "", status: "done", startedAtMs: T + 30, durationMs: 10 } },
      { id: "thinking-7", kind: "thinking", text: "再想", startedAtMs: T + 60, durationMs: 10 },
      { id: "progress-8", kind: "progress", text: "第二段过程。" },
      { id: "t2", kind: "tool", tool: { kind: "edit", target: "b.ts", detail: "", status: "done", startedAtMs: T + 70, durationMs: 10 } },
    ])
  })

  it("实时增量与历史回放一致:流式中途 progress 已入 timeline 且 text 清空", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } })
    applyRecord(acc, { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "过程说明。" } })
    applyRecord(acc, { seq: 3, at: atOffset(20), kind: "event", payload: { type: "tool_started", id: "t1", kind: "bash", title: "ls", status: "running" } })

    // 流式中途:文字已切成 progress,正文暂空,顺序与后续回放一致
    expect(messagesOf(acc).at(-1)).toMatchObject({
      id: "draft",
      text: "",
      activity: [
        { id: "progress-3", kind: "progress", text: "过程说明。" },
        { id: "t1", kind: "tool", tool: { status: "running" } },
      ],
    })

    applyRecord(acc, { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } })
    applyRecord(acc, { seq: 5, at: atOffset(40), kind: "event", payload: { type: "agent_message_chunk", text: "final" } })
    applyRecord(acc, { seq: 6, at: atOffset(50), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } })

    // 同一 accumulator 续流的结果 === 从头回放整段日志
    const replayed = createAccumulator()
    const full = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "过程说明。" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "tool_started", id: "t1", kind: "bash", title: "ls", status: "running" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "agent_message_chunk", text: "final" } },
      { seq: 6, at: atOffset(50), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of full) applyRecord(replayed, r)
    expect(messagesOf(acc)).toEqual(messagesOf(replayed))
  })

  it("无独立 final:最后一段过程文字回退为 final,回答不消失且不重复渲染", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "直接给答案。" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "tool_started", id: "t1", kind: "bash", title: "true", status: "running" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    const m = messagesOf(acc)[1]
    expect(m && m.role === "assistant" && m.text).toBe("直接给答案。")
    // 回退后 progress 从 timeline 移除,只剩工具项
    expect(m && m.role === "assistant" && m.activity).toEqual([
      { id: "t1", kind: "tool", tool: { kind: "bash", target: "true", detail: "", status: "done", startedAtMs: T + 20, durationMs: 10 } },
    ])
  })

  it("未收到 turn_finished 就开始下一轮:过程保留但不伪造 final", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "开始任务" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "收到，我继续处理。" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "tool_started", id: "t1", kind: "bash", title: "run", status: "running" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "user_message", text: "继续" } },
    ] as const
    for (const record of records) applyRecord(acc, record)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "开始任务" },
      {
        id: "a1",
        role: "assistant",
        text: "",
        tools: [{ kind: "bash", target: "run", detail: "", status: "done", startedAtMs: T + 20, durationMs: 10 }],
        activity: [
          { id: "progress-3", kind: "progress", text: "收到，我继续处理。" },
          { id: "t1", kind: "tool", tool: { kind: "bash", target: "run", detail: "", status: "done", startedAtMs: T + 20, durationMs: 10 } },
        ],
        outcome: "interrupted",
        durationMs: 30,
      },
      { id: "u5", role: "user", text: "继续" },
    ])
  })

  it("纯文本无工具:整段文本仍是 final,不产生 activity", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "你好" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "agent_message_chunk", text: "呀。" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "hi" },
      { id: "a1", role: "assistant", text: "你好呀。", durationMs: 20 },
    ])
  })

  it("工具前纯空白文本段不产生 progress 项", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "hi" } },
      { seq: 2, at: atOffset(10), kind: "event", payload: { type: "agent_message_chunk", text: "\n\n" } },
      { seq: 3, at: atOffset(20), kind: "event", payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" } },
      { seq: 4, at: atOffset(30), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 5, at: atOffset(40), kind: "event", payload: { type: "agent_message_chunk", text: "结论。" } },
      { seq: 6, at: atOffset(50), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    const m = messagesOf(acc)[1]
    expect(m && m.role === "assistant" && m.text).toBe("结论。")
    expect(m && m.role === "assistant" && m.activity).toEqual([
      { id: "t1", kind: "tool", tool: { kind: "read", target: "a.ts", detail: "", status: "done", startedAtMs: T + 20, durationMs: 10 } },
    ])
  })

  it("legacy v0.3 路径同样按工具边界分段", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "user_message", payload: { text: "旧会话" } },
      { seq: 2, at: atOffset(10), kind: "update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧过程。" } } },
      { seq: 3, at: atOffset(20), kind: "update", payload: { sessionUpdate: "tool_call", toolCallId: "t1", kind: "read", title: "a.ts", status: "in_progress" } },
      { seq: 4, at: atOffset(30), kind: "update", payload: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } },
      { seq: 5, at: atOffset(40), kind: "update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧final。" } } },
      { seq: 6, at: atOffset(50), kind: "turn_end", payload: {} },
    ] as const
    for (const r of records) applyRecord(acc, r)

    expect(messagesOf(acc)).toEqual([
      { id: "u1", role: "user", text: "旧会话" },
      {
        id: "a1",
        role: "assistant",
        text: "旧final。",
        tools: [{ kind: "read", target: "a.ts", detail: "", status: "done", startedAtMs: T + 20, durationMs: 10 }],
        activity: [
          { id: "progress-3", kind: "progress", text: "旧过程。" },
          { id: "t1", kind: "tool", tool: { kind: "read", target: "a.ts", detail: "", status: "done", startedAtMs: T + 20, durationMs: 10 } },
        ],
        durationMs: 40,
      },
    ])
  })
})

describe("thinking 段计时闭合(step2)", () => {
  function atOffset(ms: number) {
    return new Date(T + ms).toISOString()
  }

  it("思考→说话→再思考:闭合段不被续写,新思考开新段(buildPhases 求和由 activity.test 钉住)", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "user_message", text: "做一下" } },
      { seq: 2, at: atOffset(1_000), kind: "event", payload: { type: "agent_thought_chunk", text: "A" } },
      { seq: 3, at: atOffset(5_000), kind: "event", payload: { type: "agent_message_chunk", text: "说一下。" } },
      { seq: 4, at: atOffset(6_000), kind: "event", payload: { type: "agent_thought_chunk", text: "B" } },
      { seq: 5, at: atOffset(9_000), kind: "event", payload: { type: "tool_started", id: "t1", kind: "bash", title: "ls", status: "running" } },
      { seq: 6, at: atOffset(9_500), kind: "event", payload: { type: "tool_updated", id: "t1", status: "completed" } },
      { seq: 7, at: atOffset(10_000), kind: "event", payload: { type: "turn_finished", reason: "end_turn" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    const m = messagesOf(acc)[1]
    if (m.role !== "assistant") throw new Error("fixture")
    // 「说一下。」是唯一一段过程文字,turn_finished 时被提升为 final(从 timeline 摘掉)
    expect(m.text).toBe("说一下。")
    // A 段被说话闭合在 4s,B 段独立开段并在工具边界闭合 3s——续写进 A 会把 B 的 3s 永久丢掉
    expect(m.activity).toEqual([
      { id: "thinking-2", kind: "thinking", text: "A", startedAtMs: T + 1_000, durationMs: 4_000 },
      { id: "thinking-4", kind: "thinking", text: "B", startedAtMs: T + 6_000, durationMs: 3_000 },
      { id: "t1", kind: "tool", tool: { kind: "bash", target: "ls", detail: "", status: "done", startedAtMs: T + 9_000, durationMs: 500 } },
    ])
  })

  it("思考段落遇 user_steer 闭合,非零耗时", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "event", payload: { type: "agent_thought_chunk", text: "想" } },
      { seq: 2, at: atOffset(2_500), kind: "event", payload: { type: "user_steer", text: "补充", clientMessageId: "c1" } },
    ] as const
    for (const r of records) applyRecord(acc, r)

    const m = messagesOf(acc)[0]
    if (m.role !== "assistant") throw new Error("fixture")
    expect(m.activity).toEqual([
      { id: "thinking-1", kind: "thinking", text: "想", startedAtMs: T, durationMs: 2_500 },
      { id: "steer-c1", kind: "steer", text: "补充" },
    ])
  })

  it("finalizeTrailing 兜底闭合尾部思考段,非零耗时", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at: atOffset(10), kind: "event", payload: { type: "agent_thought_chunk", text: "想到一半" } })
    finalizeTrailing(acc, atOffset(5_000))

    const m = messagesOf(acc)[0]
    if (m.role !== "assistant") throw new Error("fixture")
    expect(m.activity).toEqual([
      { id: "thinking-1", kind: "thinking", text: "想到一半", startedAtMs: T + 10, durationMs: 4_990 },
    ])
  })

  it("legacy v0.3 路径同样记 startedAtMs 并闭合时长", () => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at: atOffset(0), kind: "update", payload: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "旧想" } } },
      { seq: 2, at: atOffset(1_200), kind: "update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧final。" } } },
      { seq: 3, at: atOffset(1_500), kind: "turn_end", payload: {} },
    ] as const
    for (const r of records) applyRecord(acc, r)

    const m = messagesOf(acc)[0]
    if (m.role !== "assistant") throw new Error("fixture")
    expect(m.activity).toEqual([
      { id: "thinking-1", kind: "thinking", text: "旧想", startedAtMs: T, durationMs: 1_200 },
    ])
  })
})

describe("replay 审批事件", () => {
  const REQUEST = {
    type: "approval_request" as const,
    id: "apr-1",
    title: "rm -rf /tmp/x",
    detail: "需要删除目录",
    options: [{ id: "allow_once" as const, label: "允许一次" }],
  }

  it("approval_request 进 draft 为 pending 卡片,resolved 折叠为静态记录", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at, kind: "event", payload: { type: "agent_message_chunk", text: "我来处理" } })
    applyRecord(acc, { seq: 2, at, kind: "event", payload: REQUEST })
    const draft = messagesOf(acc).find((m) => m.id === "draft")
    expect(draft).toMatchObject({
      activity: [
        { kind: "progress", text: "我来处理" },
        { kind: "approval", approval: { id: "apr-1", title: "rm -rf /tmp/x", state: "pending" } },
      ],
    })

    applyRecord(acc, {
      seq: 3, at, kind: "event",
      payload: { type: "approval_resolved", id: "apr-1", decision: "allow_once", source: "user" },
    })
    const after = messagesOf(acc).find((m) => m.id === "draft")
    expect(after).toMatchObject({
      activity: [
        { kind: "progress" },
        { kind: "approval", approval: { state: { decision: "allow_once", source: "user" } } },
      ],
    })
  })

  it("未匹配的 resolved 不产生悬挂,回合终结后卡片随消息定稿", () => {
    const acc = createAccumulator()
    applyRecord(acc, { seq: 1, at, kind: "event", payload: { type: "approval_resolved", id: "ghost", decision: "deny", source: "cancel" } })
    expect(messagesOf(acc)).toEqual([])

    applyRecord(acc, { seq: 2, at, kind: "event", payload: REQUEST })
    applyRecord(acc, {
      seq: 3, at, kind: "event",
      payload: { type: "approval_resolved", id: "apr-1", decision: "deny", source: "session-close" },
    })
    applyRecord(acc, { seq: 4, at, kind: "event", payload: { type: "turn_finished", reason: "completed" } })
    const final = messagesOf(acc).find((m) => m.role === "assistant")
    expect(final).toMatchObject({
      activity: [{ kind: "approval", approval: { state: { decision: "deny", source: "session-close" } } }],
    })
  })
})

describe("异常结束保留已显示正文", () => {
  it.each(["next-message", "error", "cancelled", "notice", "trailing"] as const)("%s 不把正文移入活动记录，回放一致", (boundary) => {
    const acc = createAccumulator()
    const records = [
      { seq: 1, at, kind: "event", payload: { type: "user_message", text: "开始" } },
      { seq: 2, at, kind: "event", payload: { type: "agent_message_chunk", text: "已有回复" } },
    ] as const
    for (const record of records) applyRecord(acc, record)
    expect(messagesOf(acc).at(-1)?.text).toBe("已有回复")
    const finish = (target: ReturnType<typeof createAccumulator>) => {
      if (boundary === "trailing") finalizeTrailing(target, at)
      else applyRecord(target, { seq: 3, at, kind: "event", payload:
        boundary === "next-message" ? { type: "user_message", text: "继续" }
          : boundary === "notice" ? { type: "notice", text: "上游失败" }
            : { type: "turn_finished", reason: boundary },
      })
    }
    finish(acc)
    const message = messagesOf(acc)[1]
    expect(message).toMatchObject({ role: "assistant", text: "已有回复", outcome:
      boundary === "next-message" || boundary === "trailing" ? "interrupted"
        : boundary === "cancelled" ? "cancelled" : "error",
    })
    expect(message && message.role === "assistant" && message.activity).toBeUndefined()
    const replayed = createAccumulator()
    for (const record of records) applyRecord(replayed, JSON.parse(JSON.stringify(record)))
    finish(replayed)
    expect(messagesOf(replayed)).toEqual(messagesOf(acc))
  })
})
