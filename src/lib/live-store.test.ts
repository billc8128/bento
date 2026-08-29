import { afterEach, describe, expect, it, vi } from "vitest"

import type { LogRecord } from "@/core/events"
import type { LiveSessionRecord } from "@/types/bento"

const at = "2026-08-24T00:00:00.000Z"

function sessionRecord(live: boolean): LiveSessionRecord {
  return {
    key: "s1",
    scope: "project",
    harnessId: "claude-code",
    cwd: "/tmp",
    nativeSessionId: "n1",
    title: "t",
    createdAt: at,
    updatedAt: at,
    live,
  }
}

/** 崩溃/强退会话的 JSONL 尾部:trailing draft 没有任何终点事件 */
function trailingDraftLog(): LogRecord[] {
  return [
    { seq: 1, at, kind: "event", payload: { type: "user_message", text: "继续" } },
    {
      seq: 2,
      at,
      kind: "event",
      payload: { type: "tool_started", id: "t1", kind: "read", title: "a.ts", status: "running" },
    },
  ]
}

function baseBento(overrides: Partial<Window["bento"] & object>): Window["bento"] & object {
  return {
    desktop: true,
    listSessions: async () => [],
    readEvents: async () => [],
    onSessionEvent: () => {},
    onBinaryProgress: () => {},
    ...overrides,
  } as Window["bento"] & object
}

/** live-store 是模块级单例:每个用例 resetModules + 注入全新的 window.bento */
async function loadStore(bento: Window["bento"] & object) {
  vi.resetModules()
  ;(globalThis as unknown as { window: unknown }).window = { bento }
  return import("./live-store")
}

afterEach(() => {
  vi.resetModules()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe("live-store 回放终界(TRACE_DATA_PLAN §3.3)", () => {
  it("首轮 prompt 后同步 main 写回的 Harness capabilities", async () => {
    const pending = sessionRecord(true)
    const connected: LiveSessionRecord = {
      ...pending,
      capabilities: { modelSwitch: "live", effortSwitch: "live" },
    }
    let listCalls = 0
    const store = await loadStore(
      baseBento({
        listSessions: async () => listCalls++ === 0 ? [pending] : [connected],
        prompt: async () => ({ stopReason: "completed" }),
      }),
    )
    await vi.waitFor(() => expect(store.liveMeta("s1")).toBeTruthy())

    await store.sendPrompt("s1", "你好")

    expect(store.liveMeta("s1")?.capabilities).toEqual({
      modelSwitch: "live",
      effortSwitch: "live",
    })
  })

  it("renderer 非 running 且 main 侧非 live 时,收尾 trailing draft", async () => {
    const store = await loadStore(
      baseBento({
        listSessions: async () => [sessionRecord(false)],
        readEvents: async () => trailingDraftLog(),
      }),
    )
    await store.ensureLoaded("s1")

    // 收尾后工具强制 failed,消息不再以 draft 形态吐出(spinner 消失)。
    // 收尾时刻是真实 now(),回合耗时只做区间断言
    const messages = store.liveMessages("s1")
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ id: "u1", role: "user", text: "继续" })
    expect(messages[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      text: "",
      tools: [
        { kind: "read", target: "a.ts", detail: "", status: "failed", startedAtMs: Date.parse(at) },
      ],
    })
    expect(messages[1]?.role === "assistant" && typeof messages[1]?.durationMs === "number" &&
      messages[1].durationMs > 0).toBe(true)
  })

  it("main 侧仍 live 时不收尾:回合可能还在跑", async () => {
    const store = await loadStore(
      baseBento({
        listSessions: async () => [sessionRecord(true)],
        readEvents: async () => trailingDraftLog(),
      }),
    )
    await store.ensureLoaded("s1")

    expect(store.liveMessages("s1")).toEqual([
      { id: "u1", role: "user", text: "继续" },
      {
        id: "draft",
        role: "assistant",
        text: "",
        tools: [{ kind: "read", target: "a.ts", detail: "", status: "running", startedAtMs: Date.parse(at) }],
      },
    ])
  })

  it("本 renderer 的 prompt 在飞时不收尾(running 分支)", async () => {
    let resolvePrompt: ((value: { stopReason: string }) => void) | undefined
    const store = await loadStore(
      baseBento({
        listSessions: async () => [sessionRecord(false)],
        readEvents: async () => trailingDraftLog(),
        prompt: () =>
          new Promise<{ stopReason: string }>((resolve) => {
            resolvePrompt = resolve
          }),
        cancel: async () => {
          resolvePrompt?.({ stopReason: "aborted" })
        },
      }),
    )
    // 模拟重载后回合仍在跑:sendPrompt 在飞,再加载历史
    const sending = store.sendPrompt("s1", "继续")
    await store.ensureLoaded("s1")

    // 未收尾:trailing draft 原样吐出,spinner 照转
    expect(store.liveMessages("s1").at(-1)).toMatchObject({
      id: "draft",
      role: "assistant",
      tools: [{ kind: "read", target: "a.ts", detail: "", status: "running" }],
    })

    await store.cancelPrompt("s1")
    await sending
  })
})
