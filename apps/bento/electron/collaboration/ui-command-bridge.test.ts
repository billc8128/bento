import { describe, expect, it, vi } from "vitest"

import type { UiCommand, UiPresence } from "../../src/core/collaboration"
import { UiCommandBridge } from "./ui-command-bridge"

const presence: UiPresence = {
  visibleSessionIds: ["s-1", "s-2"],
  focusedSessionId: "s-1",
  layoutMode: "managed",
  adjacency: [
    { sessionId: "s-1", neighbors: { right: "s-2" } },
    { sessionId: "s-2", neighbors: { left: "s-1" } },
  ],
}

describe("UiCommandBridge", () => {
  it("show/hide/focus 组装命令并投递;show 默认 placement=auto/focus=false", () => {
    const sent: UiCommand[] = []
    const bridge = new UiCommandBridge((command) => {
      sent.push(command)
      return true
    })
    bridge.show("s-1", { anchorSessionId: "caller", placement: "down" })
    bridge.show("s-1", { focus: true })
    bridge.hide("s-2")
    bridge.focus("s-3")
    expect(sent).toEqual([
      { type: "show-session", sessionId: "s-1", anchorSessionId: "caller", placement: "down", focus: false },
      { type: "show-session", sessionId: "s-1", placement: "auto", focus: true },
      { type: "hide-session", sessionId: "s-2" },
      { type: "focus-session", sessionId: "s-3" },
    ])
  })

  it("无窗口时抛 ui_unavailable,命令不发出", () => {
    const send = vi.fn(() => false)
    const bridge = new UiCommandBridge(send)
    expect(() => bridge.show("s-1")).toThrowError(
      expect.objectContaining({ code: "ui_unavailable" }),
    )
    expect(() => bridge.hide("s-1")).toThrowError(
      expect.objectContaining({ code: "ui_unavailable" }),
    )
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("report 存最新 presence;currentPresence 返回副本且不被后续修改污染", () => {
    const bridge = new UiCommandBridge(() => true)
    bridge.report(presence)
    const snapshot = bridge.currentPresence()
    expect(snapshot).toEqual(presence)
    bridge.report({ visibleSessionIds: [], focusedSessionId: null, layoutMode: "free", adjacency: [] })
    expect(snapshot.visibleSessionIds).toEqual(["s-1", "s-2"]) // 旧快照不被污染
    expect(snapshot.adjacency[0].neighbors.right).toBe("s-2")
    expect(bridge.currentPresence().layoutMode).toBe("free")
  })
})

describe("UiCommandBridge.report 运行时校验", () => {
  it("非法 payload 整体忽略:非对象/缺数组/焦点类型错/非法 layoutMode", () => {
    const bridge = new UiCommandBridge(() => true)
    const before = bridge.currentPresence()
    bridge.report(null)
    bridge.report("nope")
    bridge.report({ focusedSessionId: null, layoutMode: "managed" }) // 缺 visibleSessionIds
    bridge.report({ visibleSessionIds: [], focusedSessionId: 3, layoutMode: "managed" })
    bridge.report({ visibleSessionIds: [], focusedSessionId: null, layoutMode: "float" })
    expect(bridge.currentPresence()).toEqual(before)
  })

  it("visibleSessionIds 去重(保持首现顺序)并丢弃非字符串项;合法 payload 正常入库", () => {
    const bridge = new UiCommandBridge(() => true)
    bridge.report({
      visibleSessionIds: ["s-2", "s-1", "s-2", 7, "", "s-3"],
      focusedSessionId: "s-1",
      layoutMode: "free",
    })
    expect(bridge.currentPresence()).toEqual({
      visibleSessionIds: ["s-2", "s-1", "s-3"],
      focusedSessionId: "s-1",
      layoutMode: "free",
      adjacency: [],
    })
  })

  it("adjacency 只保留可见 Session 之间的合法四向关系", () => {
    const bridge = new UiCommandBridge(() => true)
    bridge.report({
      visibleSessionIds: ["s-1", "s-2"],
      focusedSessionId: "s-1",
      layoutMode: "managed",
      adjacency: [
        { sessionId: "s-1", neighbors: { right: "s-2", left: "missing", diagonal: "s-2" } },
        { sessionId: "missing", neighbors: { left: "s-1" } },
      ],
    })
    expect(bridge.currentPresence().adjacency).toEqual([
      { sessionId: "s-1", neighbors: { right: "s-2" } },
    ])
  })
})
