/**
 * 面板实例状态(ARCHITECTURE.md §4.3):同一 view 类型可以开多个实例,
 * 各自持有自己的状态。布局层把布局树里该 panel 的 instanceState 转成
 * context 下发,view 从这里取——保持「view 不收任意 props」的契约。
 */

import { createContext, useContext } from "react"

export type PanelInstance = {
  /** 布局树中的面板 id */
  panelId: string
  /** core.chat 的实例状态:绑定的会话 */
  sessionId: string
  /** 关闭本面板(最后一个聊天面板不可关,solo 时为 no-op) */
  close: () => void
  /** 当前是否只有这一个聊天面板 */
  solo: boolean
}

const PanelContext = createContext<PanelInstance | null>(null)

export const PanelInstanceProvider = PanelContext.Provider

export function usePanelInstance(): PanelInstance {
  const v = useContext(PanelContext)
  if (!v) throw new Error("usePanelInstance 必须在面板宿主内使用")
  return v
}
