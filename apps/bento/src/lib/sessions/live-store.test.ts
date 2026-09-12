import { beforeEach, describe, expect, it, vi } from "vitest"

type Emit = (record: unknown) => void

vi.hoisted(() => {
  const listeners: Record<string, Set<(payload?: unknown) => void>> = {
    sessionEvent: new Set(),
    sessionsChanged: new Set(),
  }
  let emitEvent: Emit = () => {}
  ;(globalThis as Record<string, unknown>).window = {
    bento: {
      desktop: true,
      listSessions: async () => [
        { key: "a", title: "A", scope: "project", cwd: "/a", harnessId: "pi", nativeSessionId: "", createdAt: "", updatedAt: "", live: true },
        { key: "b", title: "B", scope: "chat", cwd: "", harnessId: "pi", nativeSessionId: "", createdAt: "", updatedAt: "", live: false, runtime: "working" },
      ],
      readEvents: async () => [],
      prompt: async () => ({ stopReason: "end_turn" }),
      queuePrompt: async () => ({ status: "queued", steerAvailable: true }),
      steerQueued: async () => ({ ok: true }),
      cancelQueued: async () => ({ ok: true }),
      onSessionEvent: (cb: (payload?: unknown) => void) => {
        listeners.sessionEvent.add(cb)
        emitEvent = (record: unknown) => { for (const cb of listeners.sessionEvent) cb({ key: "a", record }) }
        return () => listeners.sessionEvent.delete(cb)
      },
      onSessionsChanged: (cb: (payload?: unknown) => void) => {
        listeners.sessionsChanged.add(cb)
        return () => listeners.sessionsChanged.delete(cb)
      },
      onBinaryProgress: () => () => {},
      onCollaborationUiCommand: () => () => {},
      reportCollaborationUiState: () => {},
      __emit: (record: unknown) => emitEvent(record),
      __sessionsChanged: () => { for (const cb of listeners.sessionsChanged) cb() },
    },
  }
})

const bento = (window as unknown as {
  bento: Record<string, unknown> & { __emit: (record: unknown) => void; __sessionsChanged: () => void }
}).bento

// live-store 是模块级单例,动态 import 保证 stub 先就位
const live = await import("./live-store")

function sessionRecord(key: string) {
  return { key, title: key, scope: "project", cwd: "/a", harnessId: "pi", nativeSessionId: "", createdAt: "", updatedAt: "", live: true }
}

describe("live-store 协作切片", () => {
  beforeEach(() => {
    live.refreshSessions()
  })

  it("refreshSessions 重拉 main 列表(runtime 透传)", async () => {
    await vi.waitFor(() => {
      expect(live.liveMeta("b")?.runtime).toBe("working")
    })
    expect(live.liveMeta("a")?.title).toBe("A")
  })

  it("origin=session 的 user_message 置 running,turn_finished 清除;human 消息不影响", async () => {
    await vi.waitFor(() => expect(live.liveSessionsSnapshot().length).toBe(2))
    expect(live.isRunning("a")).toBe(false)

    bento.__emit({
      seq: 1,
      at: "2024-01-01T00:00:00Z",
      kind: "event",
      payload: { type: "user_message", text: "hi", origin: { kind: "session", sessionId: "x", title: "peer", harnessId: "pi" } },
    })
    expect(live.isRunning("a")).toBe(true)
    expect(live.hasUnreadSessionMessage("a")).toBe(true)

    bento.__emit({ seq: 2, at: "2024-01-01T00:00:01Z", kind: "event", payload: { type: "turn_finished" } })
    expect(live.isRunning("a")).toBe(false)
    expect(live.liveMeta("a")?.runtime).toBe("idle")
    live.setFocusedSession("a")
    expect(live.hasUnreadSessionMessage("a")).toBe(false)

    // human 消息不进入协作 running set，但 main runtime 仍是真实 working
    bento.__emit({ seq: 3, at: "2024-01-01T00:00:02Z", kind: "event", payload: { type: "user_message", text: "me" } })
    expect(live.isRunning("a")).toBe(false)
    expect(live.liveMeta("a")?.runtime).toBe("working")
    bento.__emit({ seq: 4, at: "2024-01-01T00:00:03Z", kind: "event", payload: { type: "turn_finished" } })
    expect(live.liveMeta("a")?.runtime).toBe("idle")
  })

  it("sessions:changed 触发重拉,协作创建的 Session 立即出现", async () => {
    await vi.waitFor(() => expect(live.liveSessionsSnapshot().length).toBe(2))
    // main 列表新增(模拟协作 create 后):改写 listSessions 实现再多一个会话
    ;(bento as Record<string, unknown>).listSessions = async () => [
      sessionRecord("a"),
      sessionRecord("b"),
      sessionRecord("agent-created"),
    ]
    bento.__sessionsChanged()
    await vi.waitFor(() => expect(live.liveSessionsSnapshot().some((s) => s.key === "agent-created")).toBe(true))
  })

  it("运行中后续消息保留为可 steer 队列，真实事件到达后移除", async () => {
    await live.queueLivePrompt("a", "下一条")
    const queued = live.queuedPrompt("a")
    expect(queued).toMatchObject({ input: { text: "下一条" }, steerAvailable: true, state: "queued" })
    await live.steerQueuedPrompt("a")
    expect(live.queuedPrompt("a")?.state).toBe("steering")
    bento.__emit({
      seq: 20,
      at: "2024-01-01T00:00:04Z",
      kind: "event",
      payload: { type: "user_steer", text: "下一条", clientMessageId: queued!.id },
    })
    expect(live.queuedPrompt("a")).toBeUndefined()
  })
})
