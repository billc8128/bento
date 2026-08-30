import { useSyncExternalStore } from "react"

const STORAGE_KEY = "bento.workspaceTools.open"

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

let open = load()
let started = open
const listeners = new Set<() => void>()

export function setWorkspaceToolsOpen(next: boolean) {
  if (open === next) return
  open = next
  if (next) started = true
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0")
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener()
}

export function toggleWorkspaceTools() {
  setWorkspaceToolsOpen(!open)
}

export function useWorkspaceToolsOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
}

export function useWorkspaceToolsStarted(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => started,
  )
}
