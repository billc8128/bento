import { describe, expect, it } from "vitest"

import { ClaudeAgentTranslator } from "./claude-agent-translator"

describe("ClaudeAgentTranslator", () => {
  it("翻译流式正文、思考与工具生命周期且不重复 full assistant", () => {
    const translator = new ClaudeAgentTranslator()
    expect(translator.translate({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "答" } },
    } as never)).toEqual([{ type: "agent_message_chunk", text: "答" }])
    expect(translator.translate({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "想" } },
    } as never)).toEqual([{ type: "agent_thought_chunk", text: "想" }])
    expect(translator.translate({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } },
    } as never)).toEqual([{
      type: "tool_started",
      id: "t1",
      kind: "read",
      title: "Read",
      status: "running",
    }])
    expect(translator.translate({
      type: "assistant",
      message: { content: [{ type: "text", text: "答" }, { type: "tool_use", id: "t1", name: "Read" }] },
    } as never)).toEqual([{ type: "tool_updated", id: "t1", title: "Read" }])

    expect(translator.translate({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    } as never)).toEqual([{
      type: "tool_updated",
      id: "t1",
      status: "completed",
      detail: "ok",
    }])
  })

  it("Edit 双形态补发统计:单组 old/new_string 与 edits[] 逐项聚合,title 修正为 file_path", () => {
    const translator = new ClaudeAgentTranslator()
    translator.translate({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "e1", name: "Edit" } },
    } as never)
    // 单组形态
    expect(translator.translate({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "e1",
          name: "Edit",
          input: { file_path: "/a.ts", old_string: "keep\nold\nend", new_string: "keep\nnew\nend" },
        }],
      },
    } as never)).toEqual([{
      type: "tool_updated",
      id: "e1",
      title: "/a.ts",
      diffs: [{ path: "/a.ts", added: 1, deleted: 1 }],
    }])

    // edits[] 形态(多段替换逐项聚合到同一文件)
    translator.translate({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "e2", name: "Edit" } },
    } as never)
    expect(translator.translate({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "e2",
          name: "Edit",
          input: {
            file_path: "/b.ts",
            edits: [
              { old_string: "a\nb", new_string: "a\nb\nc" },
              { old_string: "gone", new_string: "here" },
            ],
          },
        }],
      },
    } as never)).toEqual([{
      type: "tool_updated",
      id: "e2",
      title: "/b.ts",
      diffs: [{ path: "/b.ts", added: 2, deleted: 1 }],
    }])
  })

  it("Write 全量 added;未流式的 tool_use 兜底 started 直接带统计", () => {
    const translator = new ClaudeAgentTranslator()
    // 未流式:assistant 是首次露面,started 即带统计与 title
    expect(translator.translate({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: "/new.ts", content: "a\nb\n" },
        }],
      },
    } as never)).toEqual([{
      type: "tool_started",
      id: "w1",
      kind: "edit",
      title: "/new.ts",
      status: "running",
      diffs: [{ path: "/new.ts", added: 2, deleted: 0 }],
    }])

    // 已流式的 Write:补发 tool_updated
    const translator2 = new ClaudeAgentTranslator()
    translator2.translate({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "w2", name: "Write" } },
    } as never)
    expect(translator2.translate({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "w2",
          name: "Write",
          input: { file_path: "/new2.ts", content: "only" },
        }],
      },
    } as never)).toEqual([{
      type: "tool_updated",
      id: "w2",
      title: "/new2.ts",
      diffs: [{ path: "/new2.ts", added: 1, deleted: 0 }],
    }])
  })

  it("NotebookEdit 字段形态不同不出统计,input 缺 file_path 时 title 保持工具名", () => {
    const translator = new ClaudeAgentTranslator()
    translator.translate({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "nb1", name: "NotebookEdit" },
      },
    } as never)
    expect(translator.translate({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "nb1",
          name: "NotebookEdit",
          input: { notebook_path: "/n.ipynb", new_source: "cell" },
        }],
      },
    } as never)).toEqual([{ type: "tool_updated", id: "nb1", title: "NotebookEdit" }])
  })

  it("没有 partial 事件时从 assistant full message 兜底正文", () => {
    const translator = new ClaudeAgentTranslator()
    expect(translator.translate({
      type: "assistant",
      message: { content: [{ type: "text", text: "完整回答" }] },
    } as never)).toEqual([{ type: "agent_message_chunk", text: "完整回答" }])
  })

  it("忽略 SDK 回放的字符串 user content,不把它当 tool result 数组", () => {
    const translator = new ClaudeAgentTranslator()
    expect(translator.translate({
      type: "user",
      message: { role: "user", content: "hello" },
    } as never)).toEqual([])
  })
})

describe("ClaudeAgentTranslator 工具输出(TRACE_DATA_PLAN §7 P3)", () => {
  it("tool_result 文本已全量进 detail,不重复发 output", () => {
    const translator = new ClaudeAgentTranslator()
    expect(translator.translate({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "第一行\n第二行" }] }] },
    } as never)).toEqual([{
      type: "tool_updated",
      id: "t1",
      status: "completed",
      detail: "第一行\n第二行",
    }])
  })
})
