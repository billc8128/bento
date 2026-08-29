/**
 * 侧栏面板的收折开关:面板 ref 在 App.tsx,触发点在 AppSidebar(标题栏按钮)
 * 和主区(收起后的展开条),用这个模块解耦。
 * 收折是运行时状态不持久化;状态由 App.tsx 在动画落定后回写(见
 * setSidebarCollapsed),这里只做触发分发与订阅。
 */

import { useSyncExternalStore } from "react"

let toggleFn: (() => void) | null = null
let collapsed = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** App.tsx 挂载面板后注册;返回清理函数。 */
export function registerSidebarPanel(toggle: () => void): () => void {
  toggleFn = toggle
  return () => {
    if (toggleFn === toggle) toggleFn = null
  }
}

export function toggleSidebarPanel(): void {
  toggleFn?.()
}

/** 由 App.tsx 的收折动画在合适的时机回写(收起:动画结束;展开:立即)。 */
export function setSidebarCollapsed(value: boolean): void {
  if (collapsed === value) return
  collapsed = value
  emit()
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => collapsed,
  )
}
