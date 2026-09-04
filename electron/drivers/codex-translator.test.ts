import { describe, expect, it } from "vitest"

import { translateCodexNotification } from "./codex-translator"

describe("translateCodexNotification", () => {
  it("翻译消息和 reasoning 增量", () => {
    expect(translateCodexNotification("item/agentMessage/delta", { delta: "完成" })).toEqual([
      { type: "agent_message_chunk", text: "完成" },
    ])
    expect(translateCodexNotification("item/reasoning/summaryTextDelta", { delta: "检查" })).toEqual([
      { type: "agent_thought_chunk", text: "检查" },
    ])
  })

  it("翻译命令生命周期", () => {
    expect(translateCodexNotification("item/started", {
      item: { id: "cmd-1", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    })).toEqual([{
      type: "tool_started",
      id: "cmd-1",
      kind: "bash",
      title: "pnpm test",
      status: "running",
    }])
    expect(translateCodexNotification("item/completed", {
      item: { id: "cmd-1", type: "commandExecution", command: "pnpm test", status: "completed" },
    })).toEqual([{
      type: "tool_updated",
      id: "cmd-1",
      title: "pnpm test",
      status: "completed",
    }])
  })
})

describe("translateCodexNotification diff 统计(TRACE_DATA_PLAN §4)", () => {
  it("fileChange changes[] 按 kind.type 分支:add/delete 全文行数,update unified diff", () => {
    expect(
      translateCodexNotification("item/completed", {
        item: {
          id: "fc-1",
          type: "fileChange",
          status: "completed",
          changes: [
            { path: "/add.ts", kind: { type: "add" }, diff: "a\nb\n" },
            { path: "/del.ts", kind: { type: "delete" }, diff: "gone" },
            {
              path: "/upd.ts",
              kind: { type: "update", move_path: null },
              diff: "--- a/upd.ts\n+++ b/upd.ts\n-old\n+new",
            },
          ],
        },
      }),
    ).toEqual([{
      type: "tool_updated",
      id: "fc-1",
      title: "/add.ts",
      status: "completed",
      diffs: [
        { path: "/add.ts", added: 2, deleted: 0 },
        { path: "/del.ts", added: 0, deleted: 1 },
        { path: "/upd.ts", added: 1, deleted: 1 },
      ],
    }])
  })

  it("item/started 不带统计;kind 缺失/未知或 changes 缺失时降级", () => {
    expect(
      translateCodexNotification("item/started", {
        item: {
          id: "fc-2",
          type: "fileChange",
          status: "inProgress",
          changes: [{ path: "/x.ts", kind: { type: "add" }, diff: "a" }],
        },
      }),
    ).toEqual([{
      type: "tool_started",
      id: "fc-2",
      kind: "edit",
      title: "/x.ts",
      status: "running",
    }])

    // kind 未知 → 该文件跳过;全部跳过 → 无 diffs 字段
    expect(
      translateCodexNotification("item/completed", {
        item: {
          id: "fc-3",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "/x.ts", diff: "whatever" }],
        },
      }),
    ).toEqual([{
      type: "tool_updated",
      id: "fc-3",
      title: "/x.ts",
      status: "completed",
    }])

    expect(
      translateCodexNotification("item/completed", {
        item: { id: "fc-4", type: "fileChange", status: "completed" },
      }),
    ).toEqual([{
      type: "tool_updated",
      id: "fc-4",
      title: "fileChange",
      status: "completed",
    }])
  })
})

describe("translateCodexNotification 工具输出与搜索链接(TRACE_DATA_PLAN §7 P3)", () => {
  it("aggregatedOutput 透出为 output;exitCode 0 不追加", () => {
    expect(
      translateCodexNotification("item/completed", {
        item: {
          id: "cmd-9",
          type: "commandExecution",
          command: "ls",
          status: "completed",
          aggregatedOutput: "a.ts\nb.ts",
          exitCode: 0,
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        id: "cmd-9",
        title: "ls",
        status: "completed",
        output: "a.ts\nb.ts",
      },
    ])
  })

  it("exitCode 非 0 不算工具失败:completed + detail 带退出码,输出末尾仍追加", () => {
    expect(
      translateCodexNotification("item/completed", {
        item: {
          id: "cmd-10",
          type: "commandExecution",
          command: "pnpm test",
          status: "failed",
          aggregatedOutput: "2 failed",
          exitCode: 1,
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        id: "cmd-10",
        title: "pnpm test",
        status: "completed",
        detail: "exit 1",
        output: "2 failed\nexit code 1",
      },
    ])
  })

  it("没有 exitCode 的失败才是真失败(被拒/进程错误)", () => {
    expect(
      translateCodexNotification("item/completed", {
        item: {
          id: "cmd-11",
          type: "commandExecution",
          command: "rm -rf /",
          status: "declined",
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        id: "cmd-11",
        title: "rm -rf /",
        status: "failed",
      },
    ])
  })

  it("webSearch 的 action.url 透出为 url;无 aggregatedOutput 不发 output", () => {
    expect(
      translateCodexNotification("item/completed", {
        item: {
          id: "ws-1",
          type: "webSearch",
          action: { type: "search", query: "bento", url: "https://bento.dev/docs" },
        },
      }),
    ).toEqual([
      {
        type: "tool_updated",
        id: "ws-1",
        title: "webSearch",
        status: "completed",
        url: "https://bento.dev/docs",
      },
    ])
  })
})

describe("translateCodexNotification usage 透传(TRACE_DATA_PLAN §7 P4)", () => {
  it("thread/tokenUsage/updated 保留为 metadata,driver 依赖 name 与 data.tokenUsage", () => {
    const params = {
      threadId: "thr-1",
      tokenUsage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
    }
    expect(translateCodexNotification("thread/tokenUsage/updated", params)).toEqual([
      { type: "metadata", name: "thread/tokenUsage/updated", data: params },
    ])
  })
})
