import type { Message } from "@/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * P0 流式合并回归:高频内容事件(agent/thought chunk、tool_*)逐条 applyRecord
 * 但 UI 通知每 animation frame 最多一次;终点事件同步 flush。真实 Kimi 负载
 * 峰值 315 events/s、单 16ms 窗口 150 条,这里按同量级 burst 断言通知次数。
 * live-store 是模块级单例,accumulator 跨用例留存,故每个用例用独立 session key。
 */

type Emit = (record: unknown, key: string) => void

vi.hoisted(() => {
  const listeners = { sessionEvent: new Set<(payload?: unknown) => void>() }
  let emitEvent: Emit = () => {}
  ;(globalThis as Record<string, unknown>).window = {
    bento: {
      desktop: true,
      listSessions: async () =>
        ["s1", "s2", "s3", "s4", "s5"].map((key) => ({
          key,
          title: key.toUpperCase(),
          scope: "project",
          cwd: "/a",
          harnessId: "pi",
          nativeSessionId: "",
          createdAt: "",
          updatedAt: "",
          live: true,
        })),
      readEvents: async () => [],
      prompt: async () => ({ stopReason: "end_turn" }),
      queuePrompt: async () => ({ status: "queued", steerAvailable: true }),
      steerQueued: async () => ({ ok: true }),
      cancelQueued: async () => ({ ok: true }),
      onSessionEvent: (cb: (payload?: unknown) => void) => {
        listeners.sessionEvent.add(cb)
        emitEvent = (record: unknown, key: string) => {
          for (const cb of listeners.sessionEvent) cb({ key, record })
        }
        return () => listeners.sessionEvent.delete(cb)
      },
      onSessionsChanged: () => () => {},
      onBinaryProgress: () => () => {},
      onCollaborationUiCommand: () => () => {},
      reportCollaborationUiState: () => {},
      __emit: (record: unknown, key = "s1") => emitEvent(record, key),
    },
  }
})

const bento = (window as unknown as {
  bento: { __emit: (record: unknown, key?: string) => void }
}).bento

// node 测试环境没有 rAF:手动帧队列,帧的推进完全由测试控制
const rafCbs = new Map<number, FrameRequestCallback>()
let rafSeq = 0

function runFrame() {
  const cbs = [...rafCbs.values()]
  rafCbs.clear()
  for (const cb of cbs) cb(0)
}

// live-store 是模块级单例,动态 import 保证 stub 先就位
const live = await import("./live-store")

let notified = 0
let unsubscribe: () => void
// 当前用例的 session key;beforeEach 里换新,保证 accumulator 互不污染
let key = "s1"

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafSeq
    rafCbs.set(id, cb)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCbs.delete(id)
  })
  await live.ensureLoaded(key)
  notified = 0
  unsubscribe = live.subscribeLive(() => notified++)
})

afterEach(() => {
  unsubscribe()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  key = `s${Number(key.slice(1)) % 5 + 1}`
})

function chunk(seq: number, text: string) {
  return {
    seq,
    at: `2026-09-01T00:00:00.${String(seq).padStart(4, "0")}Z`,
    kind: "event",
    payload: { type: "agent_message_chunk", text },
  }
}

function emitChunks(count: number, fromSeq = 1) {
  for (let i = 0; i < count; i++) {
    bento.__emit(chunk(fromSeq + i, `c${fromSeq + i} `), key)
  }
}

describe("live-store 流式通知帧级合并", () => {
  it("单帧 150 条 chunk:通知 0 次,帧推进后恰好 1 次,消息完整无丢失", () => {
    emitChunks(150)

    // 数据已同步 apply(通知未发):合并只推迟通知,不丢记录
    expect(notified).toBe(0)
    const draft = live.liveMessages(key).at(-1)
    expect(draft?.id).toBe("draft")
    expect(draft?.text).toBe(Array.from({ length: 150 }, (_, i) => `c${i + 1} `).join(""))

    runFrame()
    expect(notified).toBe(1)

    // 第二批进入新的合并周期:下一帧再通知一次(共 2 次,而非 300 次)
    emitChunks(150, 151)
    expect(notified).toBe(1)
    runFrame()
    expect(notified).toBe(2)
  })

  it("终点事件(turn_finished)同步 flush,取消挂起帧,最终消息完整", () => {
    emitChunks(120)
    expect(notified).toBe(0)

    bento.__emit(
      {
        seq: 121,
        at: "2026-09-01T00:00:01Z",
        kind: "event",
        payload: { type: "turn_finished", reason: "end_turn" },
      },
      key,
    )

    // 立即可见,且没有额外的帧 flush 叠加
    expect(notified).toBe(1)
    runFrame()
    expect(notified).toBe(1)

    const messages = live.liveMessages(key)
    const last = messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(last?.id).toBe("a0")
    expect(last?.text).toBe(Array.from({ length: 120 }, (_, i) => `c${i + 1} `).join(""))
    expect(messages.some((m) => m.id === "draft")).toBe(false)
    expect(live.isRunning(key)).toBe(false)
  })

  it("user_message 立即可见:同步 flush,runtime 转 working,draft 以 interrupted 收尾", async () => {
    await vi.waitFor(() => expect(live.liveSessionsSnapshot().length).toBe(5))
    emitChunks(100)

    bento.__emit(
      {
        seq: 101,
        at: "2026-09-01T00:00:02Z",
        kind: "event",
        payload: { type: "user_message", text: "打断一下" },
      },
      key,
    )

    expect(notified).toBe(1)
    const messages = live.liveMessages(key)
    const interrupted = messages.find(
      (m): m is Extract<Message, { role: "assistant" }> =>
        m.role === "assistant" && m.outcome === "interrupted",
    )
    // 下一条消息到来时，已显示的回复仍留在正文，不移入折叠活动。
    expect(interrupted?.text).toContain("c100")
    expect(interrupted?.activity?.some((item) => item.kind === "progress")).not.toBe(true)
    expect(live.liveMeta(key)?.runtime).toBe("working")
  })

  it("rAF 停摆(窗口隐藏)时 100ms 定时兜底 flush", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    emitChunks(150)

    expect(notified).toBe(0)
    vi.advanceTimersByTime(100)
    expect(notified).toBe(1)
    // 兜底 flush 同时取消挂起的 rAF,同帧不双 bump
    expect(rafCbs.size).toBe(0)
    // 兜底 flush 后新事件重新进入合并周期
    emitChunks(1, 151)
    expect(notified).toBe(1)
    vi.advanceTimersByTime(100)
    expect(notified).toBe(2)
  })

  it("legacy update 记录同样合并,legacy 终点(turn_end)同样立即 flush", () => {
    for (let i = 1; i <= 100; i++) {
      bento.__emit(
        {
          seq: i,
          at: "2026-09-01T00:00:00Z",
          kind: "update",
          payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `l${i} ` } },
        },
        key,
      )
    }
    expect(notified).toBe(0)
    bento.__emit({ seq: 101, at: "2026-09-01T00:00:01Z", kind: "turn_end", payload: {} }, key)
    expect(notified).toBe(1)
    expect(live.liveMessages(key).at(-1)?.text).toBe(
      Array.from({ length: 100 }, (_, i) => `l${i + 1} `).join(""),
    )
  })
})
