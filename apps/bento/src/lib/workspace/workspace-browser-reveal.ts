import { useSyncExternalStore } from "react"

let browserId: string | null = null
const listeners = new Set<() => void>()

function publish(next: string | null) {
  browserId = next
  for (const listener of listeners) listener()
}

if (typeof window !== "undefined" && window.bento) {
  window.bento.workspace.browser.onReveal((id) => publish(id))
}

export function consumeWorkspaceBrowserReveal(id: string) {
  if (browserId === id) publish(null)
}

export function useWorkspaceBrowserReveal(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => browserId,
  )
}
