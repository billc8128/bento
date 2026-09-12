/**
 * 协作 UI 初始化(renderer,Phase 2)。
 *
 * 订阅 main → renderer 的协作 UI 命令;show 先刷新 live sessions(Agent 刚建的
 * Session 要能立刻进侧栏/面板标题),再操作布局;持续把脱敏 presence 上报 main。
 * 纯 web 模式(window.bento 不存在)静默不启用。
 */

import {
  agentFocusSession,
  agentHideSession,
  agentShowSession,
  currentLayoutSnapshot,
  subscribeLayoutChange,
} from "@/lib/workspace/layout-store"
import { refreshSessions, setFocusedSession } from "@/lib/sessions/live-store"

let initialized = false

export function initCollaborationUi(): void {
  const bento = window.bento
  if (!bento || initialized) return
  initialized = true

  bento.onCollaborationUiCommand((command) => {
    switch (command.type) {
      case "show-session":
        // 先重拉列表,保证新 Session 的标题/元数据已就位再开面板
        void refreshSessions().then(() => {
          agentShowSession(command.sessionId, {
            anchorSessionId: command.anchorSessionId,
            placement: command.placement,
            focus: command.focus,
          })
        })
        return
      case "hide-session":
        agentHideSession(command.sessionId)
        return
      case "focus-session":
        agentFocusSession(command.sessionId)
        return
    }
  })

  // presence 上报:布局任何变化后把脱敏快照发回 main(字段名映射)
  const report = () => {
    const snap = currentLayoutSnapshot()
    setFocusedSession(snap.focusedSessionId)
    bento.reportCollaborationUiState({
      visibleSessionIds: snap.adjacency.map((entry) => entry.sessionId),
      focusedSessionId: snap.focusedSessionId,
      layoutMode: snap.mode,
      adjacency: snap.adjacency,
    })
  }
  subscribeLayoutChange(report)
  report()
}

export function collaborationUiInitialized(): boolean {
  return initialized
}
