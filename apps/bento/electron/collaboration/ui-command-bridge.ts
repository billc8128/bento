/**
 * UiCommandBridge(Phase 2):main ↔ renderer 的窄 UI 桥。
 *
 * main→renderer 发 show/hide/focus 命令;renderer→main 上报脱敏 presence。
 * 第一版只有单主窗口:send 回调返回 false 表示当前没有可接收命令的窗口。
 * 不暴露 Dockview 内部 id,全部以 sessionId 寻址。
 */

import { CollaborationError } from "../../src/core/collaboration"
import type {
  UiCommand,
  UiDirection,
  UiPresence,
  UiSessionAdjacency,
  UiShowOptions,
} from "../../src/core/collaboration"

const DIRECTIONS: UiDirection[] = ["left", "right", "above", "below"]

export class UiCommandBridge {
  private presence: UiPresence = {
    visibleSessionIds: [],
    focusedSessionId: null,
    layoutMode: "managed",
    adjacency: [],
  }

  /** 返回 false = 当前没有主窗口可接收命令(web 模式/窗口已销毁)。 */
  private readonly send: (command: UiCommand) => boolean

  constructor(send: (command: UiCommand) => boolean) {
    this.send = send
  }

  /** renderer 最近一次上报的脱敏 presence。 */
  currentPresence(): UiPresence {
    return {
      ...this.presence,
      visibleSessionIds: [...this.presence.visibleSessionIds],
      adjacency: this.presence.adjacency.map((entry) => ({
        sessionId: entry.sessionId,
        neighbors: { ...entry.neighbors },
      })),
    }
  }

  /**
   * renderer 上报 presence。运行时校验:非法 payload 整体忽略;
   * visibleSessionIds 去重(保持首次出现顺序)。
   */
  report(presence: unknown): void {
    if (typeof presence !== "object" || presence === null) return
    const candidate = presence as Partial<UiPresence>
    if (!Array.isArray(candidate.visibleSessionIds)) return
    if (
      candidate.focusedSessionId !== null &&
      typeof candidate.focusedSessionId !== "string"
    ) {
      return
    }
    if (candidate.layoutMode !== "managed" && candidate.layoutMode !== "free") return
    const seen = new Set<string>()
    const visibleSessionIds = candidate.visibleSessionIds.filter((id) => {
      if (typeof id !== "string" || id === "" || seen.has(id)) return false
      seen.add(id)
      return true
    })
    const adjacency: UiSessionAdjacency[] = []
    const visible = new Set(visibleSessionIds)
    const adjacencySeen = new Set<string>()
    if (candidate.adjacency !== undefined && !Array.isArray(candidate.adjacency)) return
    for (const raw of candidate.adjacency ?? []) {
      if (typeof raw !== "object" || raw === null) continue
      const entry = raw as Partial<UiSessionAdjacency>
      if (
        typeof entry.sessionId !== "string" ||
        !visible.has(entry.sessionId) ||
        adjacencySeen.has(entry.sessionId) ||
        typeof entry.neighbors !== "object" ||
        entry.neighbors === null
      ) continue
      adjacencySeen.add(entry.sessionId)
      const neighbors: Partial<Record<UiDirection, string>> = {}
      for (const direction of DIRECTIONS) {
        const target = entry.neighbors[direction]
        if (typeof target === "string" && target !== entry.sessionId && visible.has(target)) {
          neighbors[direction] = target
        }
      }
      adjacency.push({ sessionId: entry.sessionId, neighbors })
    }
    this.presence = {
      visibleSessionIds,
      focusedSessionId: candidate.focusedSessionId,
      layoutMode: candidate.layoutMode,
      adjacency,
    }
  }

  show(sessionId: string, options: UiShowOptions = {}): void {
    this.deliver({
      type: "show-session",
      sessionId,
      ...(options.anchorSessionId ? { anchorSessionId: options.anchorSessionId } : {}),
      placement: options.placement ?? "auto",
      focus: options.focus ?? false,
    })
  }

  hide(sessionId: string): void {
    this.deliver({ type: "hide-session", sessionId })
  }

  focus(sessionId: string): void {
    this.deliver({ type: "focus-session", sessionId })
  }

  private deliver(command: UiCommand): void {
    if (!this.send(command)) throw new CollaborationError("ui_unavailable")
  }
}
