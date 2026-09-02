import { describe, expect, it } from "vitest"

import {
  groupActivity,
  liveStatus,
  liveTurnState,
  resolveActivity,
  settledSummary,
  toolGroupStatus,
} from "./activity"
import type { ActivityItem, Message, ToolCall } from "./types"

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({
  kind: "bash",
  target: "ls",
  detail: "",
  status: "done",
  ...over,
})

const toolItem = (id: string, over: Partial<ToolCall> = {}): ActivityItem => ({
  id,
  kind: "tool",
  tool: tool(over),
})

describe("groupActivity 工具分组边界", () => {
  it("连续 tool 合并为一个工作段,单个工具也走工作段", () => {
    const blocks = groupActivity([
      toolItem("t1"),
      toolItem("t2"),
      toolItem("t3"),
      toolItem("t4"),
    ])
    expect(blocks).toEqual([
      {
        id: "t1",
        kind: "work",
        items: [
          toolItem("t1"),
          toolItem("t2"),
          toolItem("t3"),
          toolItem("t4"),
        ],
      },
    ])
    // 单个工具:一组一件
    expect(groupActivity([toolItem("solo")])).toEqual([
      { id: "solo", kind: "work", items: [toolItem("solo")] },
    ])
  })

  it("thinking 与工具保持原顺序收进工作段,progress/steer 才切段", () => {
    const blocks = groupActivity([
      { id: "p1", kind: "progress", text: "先看一下" },
      toolItem("t1"),
      toolItem("t2"),
      { id: "th1", kind: "thinking", text: "再想" },
      toolItem("t3"),
      { id: "s1", kind: "steer", text: "补充" },
      toolItem("t4"),
    ])
    expect(blocks.map((b) => b.kind)).toEqual([
      "progress",
      "work",
      "steer",
      "work",
    ])
    const groups = blocks.filter((b) => b.kind === "work")
    expect(groups.map((g) => g.kind === "work" && g.items.map((item) => item.kind))).toEqual([
      ["tool", "tool", "thinking", "tool"],
      ["tool"],
    ])
  })

  it("空 timeline 不出块", () => {
    expect(groupActivity([])).toEqual([])
  })
})

describe("toolGroupStatus 聚合状态", () => {
  it("一个在跑就是在跑;无 running 有失败报失败;全落定才 done", () => {
    expect(toolGroupStatus([tool(), tool({ status: "running" })])).toBe("running")
    expect(toolGroupStatus([tool(), tool({ status: "failed" })])).toBe("failed")
    expect(toolGroupStatus([tool(), tool()])).toBe("done")
  })
})

describe("liveTurnState 单标题来源与结束折叠", () => {
  const finalized: Message = {
    id: "a1",
    role: "assistant",
    text: "最终回答。",
    tools: [tool()],
    activity: [
      { id: "progress-2", kind: "progress", text: "过程。" },
      toolItem("t1"),
    ],
  }

  it("running 且 draft 存在:活动数据全部来自 draft 的结构化 timeline", () => {
    const draft: Message = {
      id: "draft",
      role: "assistant",
      text: "流式中",
      tools: [tool({ status: "running" })],
      thinking: "在想",
      activity: [
        { id: "thinking-1", kind: "thinking", text: "在想" },
        toolItem("t1", { status: "running" }),
      ],
    }
    const turn = liveTurnState([{ id: "u1", role: "user", text: "hi" }, draft], true)
    expect(turn).toEqual({
      activity: [
        { id: "thinking-1", kind: "thinking", text: "在想" },
        toolItem("t1", { status: "running" }),
      ],
      tools: [tool({ status: "running" })],
      thinking: "在想",
    })
  })

  it("回合落定(running=false)返回 undefined:Composer 上方的活动块消失", () => {
    expect(liveTurnState([{ id: "u1", role: "user", text: "hi" }, finalized], false)).toBeUndefined()
    // 同一批 activity 仍在落定消息上,由消息区折叠 trace 承接
    if (finalized.role !== "assistant") throw new Error("fixture")
    expect(resolveActivity(finalized)).toEqual(finalized.activity)
    expect(settledSummary(finalized)).toBe("使用了 1 个工具")
  })

  it("无活动占位:running 但没有 draft(回合刚开始),给空 timeline 占位", () => {
    const turn = liveTurnState([{ id: "u1", role: "user", text: "hi" }], true)
    expect(turn).toEqual({ activity: [], tools: [] })
    expect(liveStatus(turn!)).toEqual({ label: "正在思考" })
  })

  it("无活动占位:draft 已建但还没流出任何事件,同样是「正在思考」", () => {
    const draft: Message = { id: "draft", role: "assistant", text: "" }
    const turn = liveTurnState([draft], true)
    expect(turn).toEqual({ activity: [], tools: [] })
    expect(liveStatus(turn!)).toEqual({ label: "正在思考" })
  })
})

describe("liveStatus 状态文案由 timeline 最后一项决定", () => {
  it("存在 running 工具时只显示正在使用工具", () => {
    expect(
      liveStatus({ activity: [toolItem("t1", { status: "running", target: "a.ts" })], tools: [] }),
    ).toEqual({ label: "正在使用工具" })
  })

  it("工具落定但回合仍在运行时显示正在工作;末项 steer 显示已收到补充", () => {
    expect(
      liveStatus({ activity: [toolItem("t1", { target: "b.ts" })], tools: [] }),
    ).toEqual({ label: "正在工作" })
    expect(
      liveStatus({ activity: [{ id: "s1", kind: "steer", text: "快点" }], tools: [] }),
    ).toEqual({ label: "已收到你的补充" })
  })

  it("末项是文字:有工具在跑仍显示正在使用工具,已有过程则正在工作", () => {
    const progress: ActivityItem = { id: "p1", kind: "progress", text: "过程" }
    expect(liveStatus({ activity: [progress], tools: [tool({ status: "running" })] })).toEqual({
      label: "正在使用工具",
    })
    expect(liveStatus({ activity: [progress], tools: [] })).toEqual({ label: "正在工作" })
  })
})

describe("resolveActivity 旧历史回退", () => {
  it("缺 activity 时回退 thinking + tools 聚合,thinking 在前", () => {
    expect(
      resolveActivity({ thinking: "想过", tools: [tool()], activity: undefined }),
    ).toEqual([
      { id: "thinking", kind: "thinking", text: "想过" },
      { id: "tool-0", kind: "tool", tool: tool() },
    ])
  })

  it("有 activity 时不看旧字段", () => {
    const activity: ActivityItem[] = [toolItem("t1")]
    expect(resolveActivity({ thinking: "想过", tools: [tool()], activity })).toBe(activity)
  })
})

describe("settledSummary 落定一行摘要", () => {
  it("有工具:思考并/使用了 N 个工具;无工具:思考完成", () => {
    expect(settledSummary({ thinking: "想过", tools: [tool(), tool()] })).toBe(
      "思考并使用了 2 个工具",
    )
    expect(settledSummary({ thinking: undefined, tools: [tool()] })).toBe("使用了 1 个工具")
    expect(settledSummary({ thinking: "想过", tools: [] })).toBe("思考完成")
  })

  it("非正常终结不会伪装成完成态", () => {
    expect(settledSummary({ outcome: "interrupted", tools: [tool()], thinking: "想过" }))
      .toBe("上轮未完成 · 1 个工具")
    expect(settledSummary({ outcome: "cancelled", tools: [], thinking: undefined })).toBe("已停止")
    expect(settledSummary({ outcome: "error", tools: [tool(), tool()], thinking: undefined }))
      .toBe("执行失败 · 2 个工具")
  })
})
