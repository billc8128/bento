import { describe, expect, it, vi } from "vitest"

import { closeNewSession, getNewSessionSnapshot, requestNewSession, subscribeNewSession } from "./new-session-store"

describe("new-session-store", () => {
  it("打开新会话落位 harness/scope 并通知订阅者", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeNewSession(listener)
    requestNewSession({ harnessId: "omp", scope: "chat" })
    expect(getNewSessionSnapshot()).toMatchObject({
      open: true,
      harnessId: "omp",
      scope: "chat",
    })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it("closeNewSession 只关面板,不动 revision", () => {
    requestNewSession({ harnessId: "omp" })
    const before = getNewSessionSnapshot()
    closeNewSession()
    const after = getNewSessionSnapshot()
    expect(after.open).toBe(false)
    expect(after.revision).toBe(before.revision)
  })
})
