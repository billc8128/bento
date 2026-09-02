import { describe, expect, it } from "vitest"

import {
  buildPhases,
  cleanToolTarget,
  livePhaseId,
  liveStatus,
  liveTurnState,
  phaseLabel,
  resolveActivity,
  settledMasterLabel,
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

const thinking = (id: string, text: string): ActivityItem => ({ id, kind: "thinking", text })

const progress = (id: string, text: string): ActivityItem => ({ id, kind: "progress", text })

const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind)

describe("buildPhases 阶段栈分组", () => {
  it("连续 thinking 并成一段(text 拼接)、连续 tool 并成一组(保序)", () => {
    const rows = buildPhases([
      thinking("th1", "先想"),
      thinking("th2", "，再想"),
      toolItem("t1"),
      toolItem("t2"),
      thinking("th3", "再想"),
      toolItem("t3"),
    ])
    expect(kinds(rows)).toEqual(["thinking", "tools", "thinking", "tools"])
    expect(rows[0]).toEqual({ id: "th1", kind: "thinking", text: "先想，再想" })
    expect(rows[1]).toMatchObject({ kind: "tools", tools: [tool(), tool()] })
    expect(rows[2]).toEqual({ id: "th3", kind: "thinking", text: "再想" })
    expect(rows[3]).toMatchObject({ kind: "tools", tools: [tool()] })
  })

  it("连续 thinking 合并时耗时求和;只有一边有数据保留那一边,都没有就缺席", () => {
    const rows = buildPhases([
      { id: "th1", kind: "thinking", text: "先想", durationMs: 2000 },
      { id: "th2", kind: "thinking", text: "再想", durationMs: 1500 },
    ])
    expect(rows[0]).toEqual({ id: "th1", kind: "thinking", text: "先想再想", durationMs: 3500 })
    const mixed = buildPhases([
      { id: "th1", kind: "thinking", text: "先想", durationMs: 2000 },
      { id: "th2", kind: "thinking", text: "再想" },
      { id: "th3", kind: "thinking", text: "又想", durationMs: 1500 },
    ])
    expect(mixed[0]).toEqual({ id: "th1", kind: "thinking", text: "先想再想又想", durationMs: 3500 })

    const noTiming = buildPhases([thinking("th1", "想"), thinking("th2", "，想")])
    expect(noTiming[0]).toEqual({ id: "th1", kind: "thinking", text: "想，想" })
  })

  it("progress/steer 切段并独立成行", () => {
    const rows = buildPhases([
      progress("p1", "先看一下"),
      toolItem("t1"),
      toolItem("t2"),
      thinking("th1", "再想"),
      toolItem("t3"),
      { id: "s1", kind: "steer", text: "补充" },
      toolItem("t4"),
    ])
    expect(kinds(rows)).toEqual(["progress", "tools", "thinking", "tools", "steer", "tools"])
    const toolRows = rows.filter((r) => r.kind === "tools")
    expect(toolRows.map((r) => r.kind === "tools" && r.tools.length)).toEqual([2, 1, 1])
  })

  it("空 timeline 不出行", () => {
    expect(buildPhases([])).toEqual([])
  })
})

describe("livePhaseId 活跃阶段判定", () => {
  it("末段是 tools 且有 running → 工具阶段;全部落定 → 无 live 阶段", () => {
    expect(livePhaseId(buildPhases([toolItem("t1", { status: "running" })]))).toBe("t1")
    expect(livePhaseId(buildPhases([toolItem("t1")]))).toBeUndefined()
  })

  it("末段是 thinking:有起点未闭合(流式/间隙)→ live;已闭合(被说话接管)→ 无 live 阶段", () => {
    const streaming: ActivityItem = { id: "th1", kind: "thinking", text: "在想", startedAtMs: 100 }
    const closed: ActivityItem = { id: "th2", kind: "thinking", text: "想完", startedAtMs: 100, durationMs: 400 }
    expect(livePhaseId(buildPhases([streaming]))).toBe("th1")
    expect(livePhaseId(buildPhases([closed]))).toBeUndefined()
    // 闭合段 + 新流式段合并后,尾项未闭合 → 整段仍是 live(时长是部分和,不提前露出)
    expect(livePhaseId(buildPhases([closed, streaming]))).toBe("th2")
    expect(livePhaseId(buildPhases([progress("p1", "说话")]))).toBeUndefined()
    expect(livePhaseId(buildPhases([{ id: "s1", kind: "steer", text: "补充" }]))).toBeUndefined()
    expect(livePhaseId([])).toBeUndefined()
  })
})

describe("phaseLabel 阶段行标题", () => {
  it("thinking:落定「已思考」,进行中「正在思考…」", () => {
    expect(phaseLabel({ id: "x", kind: "thinking", text: "想" }, true)).toBe("正在思考…")
    expect(phaseLabel({ id: "x", kind: "thinking", text: "想" }, false)).toBe("已思考")
  })

  it("thinking 落定且有计时数据:标题带整段耗时;缺时长数据回退无时长文案", () => {
    expect(phaseLabel({ id: "x", kind: "thinking", text: "想", durationMs: 2000 }, false)).toBe("已思考 2.0s")
    expect(phaseLabel({ id: "x", kind: "thinking", text: "想", durationMs: 61000 }, false)).toBe("已思考 1m01s")
  })

  it("tools:落定「已使用 N 个工具」;时态由该行自身 running 决定,不看是否栈末行(live)", () => {
    expect(phaseLabel({ id: "x", kind: "tools", tools: [tool(), tool()] }, true)).toBe("已使用 2 个工具")
    expect(phaseLabel({ id: "x", kind: "tools", tools: [tool(), tool()] }, false)).toBe("已使用 2 个工具")
    // 栈末行被穿插的思考抢走(live=false)时,行内仍有 running 工具 → 现在时
    expect(phaseLabel({ id: "x", kind: "tools", tools: [tool(), tool({ status: "running" })] }, false)).toBe("正在使用工具")
    expect(phaseLabel({ id: "x", kind: "tools", tools: [tool({ status: "running" })] }, true)).toBe("正在使用工具")
  })
})

describe("cleanToolTarget 剥 harness 前缀", () => {
  it("kimi 的动作前缀被剥掉;无前缀的 target 恒等", () => {
    expect(cleanToolTarget("Running: curl -s -o /dev/null")).toBe("curl -s -o /dev/null")
    expect(cleanToolTarget("Editing /Users/bcc/src/a.ts")).toBe("/Users/bcc/src/a.ts")
    expect(cleanToolTarget("Reading src/core/config.ts")).toBe("src/core/config.ts")
    expect(cleanToolTarget("pnpm test")).toBe("pnpm test")
    expect(cleanToolTarget("src/lib/llm.ts")).toBe("src/lib/llm.ts")
  })

  it("实证清单全量覆盖:子代理/后台/媒体/抓取/停任务前缀都被剥掉", () => {
    expect(cleanToolTarget("Launching coder agent: 修复样式")).toBe("修复样式")
    expect(cleanToolTarget("Reading output of task bash-123")).toBe("bash-123")
    expect(cleanToolTarget("Starting background: pnpm dev")).toBe("pnpm dev")
    expect(cleanToolTarget("Reading media: foo.png")).toBe("foo.png")
    expect(cleanToolTarget("Stopping task bash-123")).toBe("bash-123")
    expect(cleanToolTarget("Fetching: https://example.com")).toBe("https://example.com")
  })

  it("顺序约束:Reading media: 不能被 Reading 半剥成 media: foo.png(长前缀必须先命中)", () => {
    expect(cleanToolTarget("Reading media: foo.png")).toBe("foo.png")
    expect(cleanToolTarget("Reading media: foo.png")).not.toBe("media: foo.png")
  })
})

describe("settledMasterLabel 落定总折叠行", () => {
  it("有耗时:已工作 Xm XXs;缺 durationMs 回退内容摘要;非正常终结冠在前面", () => {
    expect(settledMasterLabel({ thinking: "想过", tools: [tool()], durationMs: 72000 })).toBe("已工作 1m12s")
    expect(settledMasterLabel({ thinking: "想过", tools: [tool()] })).toBe("思考并使用了 1 个工具")
    expect(settledMasterLabel({ outcome: "cancelled", tools: [tool()], durationMs: 12000 })).toBe("已停止 · 已工作 12s")
    expect(settledMasterLabel({ outcome: "error", tools: [tool(), tool()] })).toBe("执行失败 · 2 个工具")
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
    // 同一批 activity 仍在落定消息上,由消息区总折叠 trace 承接
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

describe("liveStatus 兜底状态文案(无活跃工作段时)", () => {
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
    const p: ActivityItem = { id: "p1", kind: "progress", text: "过程" }
    expect(liveStatus({ activity: [p], tools: [tool({ status: "running" })] })).toEqual({
      label: "正在使用工具",
    })
    expect(liveStatus({ activity: [p], tools: [] })).toEqual({ label: "正在工作" })
  })

  it("末段思考已被说话闭合(正在输出正文):显示正在回复,不假装还在思考", () => {
    const closedThinking: ActivityItem = { id: "th1", kind: "thinking", text: "想完", startedAtMs: 100, durationMs: 400 }
    expect(liveStatus({ activity: [toolItem("t1"), closedThinking], tools: [] })).toEqual({
      label: "正在回复",
    })
    // 有 running 工具时仍优先工具状态
    expect(
      liveStatus({ activity: [closedThinking], tools: [tool({ status: "running" })] }),
    ).toEqual({ label: "正在使用工具" })
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

describe("settledSummary 落定内容摘要(缺耗时旧数据的回退)", () => {
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
