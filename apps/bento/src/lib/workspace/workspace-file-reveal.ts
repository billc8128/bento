import { useSyncExternalStore } from "react"

/** 聊天里的文件链接 → 右侧文件面板预览的跨组件请求(与 browser-reveal 同模式):
 * 链接点击只发请求;App 负责展开面板,WorkspaceToolsPanel 负责落 tab。 */
export type FileReveal = {
  /** 会话工作目录(= Files 面板的 root);空字符串表示无工作区,调用方自行兜底 */
  root: string
  /** 相对 root 的路径;文件面板的路径边界只接受相对路径 */
  relativePath: string
  nonce: number
}

let current: FileReveal | null = null
let counter = 0
const listeners = new Set<() => void>()

function publish(next: FileReveal | null) {
  current = next
  for (const listener of listeners) listener()
}

export function requestWorkspaceFileReveal(root: string, relativePath: string) {
  publish({ root, relativePath, nonce: ++counter })
}

export function consumeWorkspaceFileReveal(nonce: number) {
  if (current?.nonce === nonce) publish(null)
}

export function useWorkspaceFileReveal(): FileReveal | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}
