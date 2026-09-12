import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { PI_CAPABILITIES, piDriver, piModelRef, translatePiEvent } from "./pi"

describe("Pi capabilities", () => {
  it("与已实现的 set_model / set_thinking_level / steer 保持一致", () => {
    expect(PI_CAPABILITIES).toEqual({
      modelSwitch: "live",
      effortSwitch: "live",
      steer: "live",
    })
  })
})

async function waitForFrames(file: string, predicate: (frames: Array<Record<string, unknown>>) => boolean) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const frames = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : []
    if (predicate(frames)) return frames
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("等待 Pi RPC 测试帧超时")
}

describe("Pi RPC steer", () => {
  it("运行中的 prompt 后发送 steer，复用图片/文件语义且不提前结束原回合", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-pi-steer-"))
    const executable = path.join(dir, "pi")
    const log = path.join(dir, "frames.jsonl")
    const image = path.join(dir, "reference.png")
    const file = path.join(dir, "notes.csv")
    fs.writeFileSync(image, Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(file, "a,b\n1,2\n")
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const log = process.env.BENTO_PI_TEST_LOG
const output = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  fs.appendFileSync(log, JSON.stringify(frame) + "\\n")
  if (frame.type === "get_state") {
    output({ id: frame.id, type: "response", command: frame.type, success: true,
      data: { sessionId: "pi-test", sessionFile: "/tmp/pi-test.jsonl" } })
  } else if (frame.type === "prompt" || frame.type === "steer") {
    output({ id: frame.id, type: "response", command: frame.type, success: true })
  } else if (frame.type === "abort") {
    output({ id: frame.id, type: "response", command: frame.type, success: true })
    output({ type: "agent_end" })
    output({ type: "agent_settled" })
  }
})
`)
    fs.chmodSync(executable, 0o755)

    const previousOverride = process.env.BENTO_PI_PATH
    process.env.BENTO_PI_PATH = executable
    let connection: Awaited<ReturnType<typeof piDriver.start>> | undefined
    try {
      connection = await piDriver.start({
        cwd: dir,
        proxyEnv: { env: { BENTO_PI_TEST_LOG: log } },
      }, () => {})

      const attachments = [
        { name: "reference.png", path: image, mimeType: "image/png", size: 4, kind: "image" as const },
        { name: "notes.csv", path: file, mimeType: "text/csv", size: 8, kind: "file" as const },
      ]
      let completed = false
      const completion = connection.prompt({ text: "先分析", attachments }).then((result) => {
        completed = true
        return result
      })
      await waitForFrames(log, (frames) => frames.some((frame) => frame.type === "prompt"))

      await connection.steer?.({ text: "优先看附件", attachments })
      expect(completed).toBe(false)

      const frames = await waitForFrames(log, (values) => values.some((frame) => frame.type === "steer"))
      const prompt = frames.find((frame) => frame.type === "prompt")
      const steer = frames.find((frame) => frame.type === "steer")
      expect(prompt).toMatchObject({
        type: "prompt",
        message: `先分析\n\n附件文件：\n- ${file}`,
        images: [{ type: "image", data: "AAECAw==", mimeType: "image/png" }],
      })
      expect(steer).toMatchObject({
        type: "steer",
        message: `优先看附件\n\n附件文件：\n- ${file}`,
        images: [{ type: "image", data: "AAECAw==", mimeType: "image/png" }],
      })

      await connection.cancel()
      await expect(completion).resolves.toEqual({ stopReason: "end_turn" })
      expect(completed).toBe(true)
    } finally {
      connection?.close()
      if (previousOverride === undefined) delete process.env.BENTO_PI_PATH
      else process.env.BENTO_PI_PATH = previousOverride
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Pi 进程退出错误可读性", () => {
  it("启动即退出(1)时,错误带 stderr 尾部并脱敏 UUID", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-pi-exit-"))
    const executable = path.join(dir, "pi")
    fs.writeFileSync(executable, `#!/usr/bin/env node
process.stderr.write("Error: Cannot find module for 123e4567-e89b-12d3-a456-426614174000\\n")
process.exit(1)
`)
    fs.chmodSync(executable, 0o755)

    const previousOverride = process.env.BENTO_PI_PATH
    process.env.BENTO_PI_PATH = executable
    try {
      await expect(piDriver.start({ cwd: dir }, () => {})).rejects.toThrow(
        /^Pi 进程退出\(1\):Error: Cannot find module for <redacted>$/,
      )
    } finally {
      if (previousOverride === undefined) delete process.env.BENTO_PI_PATH
      else process.env.BENTO_PI_PATH = previousOverride
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

describe("Pi RPC run settlement", () => {
  it.each(["success", "exhausted", "cancelled"])("keeps retries busy until settled (%s)", async (outcome) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-pi-settled-"))
    const executable = path.join(dir, "pi")
    fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline")
const output = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  if (frame.type === "steer") {
    for (const event of JSON.parse(frame.message)) output(event)
  }
  if (frame.type === "abort") {
    output({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" })
    output({ type: "agent_settled" })
  }
  output({ id: frame.id, type: "response", command: frame.type, success: true,
    data: { sessionId: "pi-test" } })
})
`)
    fs.chmodSync(executable, 0o755)
    const previousOverride = process.env.BENTO_PI_PATH
    process.env.BENTO_PI_PATH = executable
    let connection: Awaited<ReturnType<typeof piDriver.start>> | undefined
    try {
      connection = await piDriver.start({ cwd: dir }, () => {})
      let completed = false
      const completion = connection.prompt("start").then((result) => {
        completed = true
        return result
      })
      // The steer response acts as a barrier: all preceding events have been consumed.
      const events = (frames: Array<Record<string, unknown>>) => connection!.steer!(JSON.stringify(frames))
      await events([
        { type: "turn_end", message: { stopReason: "error", errorMessage: "500 network error" } },
        { type: "agent_end", willRetry: true },
        { type: "auto_retry_start", attempt: 1, delayMs: 2000 },
      ])
      expect(completed).toBe(false)
      await expect(connection.prompt("continue too early")).rejects.toThrow("Pi 正在处理上一轮请求")
      await events([{ type: "agent_end", willRetry: false }])
      // Even willRetry:false isn't final: compaction/queued work may still follow.
      expect(completed).toBe(false)
      if (outcome === "cancelled") {
        await connection.cancel()
      } else {
        await events([{ type: "auto_retry_end", success: outcome === "success" }])
        expect(completed).toBe(false)
        await events([{ type: "agent_settled" }])
      }
      await expect(completion).resolves.toMatchObject({ stopReason: "end_turn" })
      expect(completed).toBe(true)
      const next = connection.prompt("continue after settled")
      await events([{ type: "agent_settled" }])
      await expect(next).resolves.toMatchObject({ stopReason: "end_turn" })
    } finally {
      connection?.close()
      if (previousOverride === undefined) delete process.env.BENTO_PI_PATH
      else process.env.BENTO_PI_PATH = previousOverride
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
