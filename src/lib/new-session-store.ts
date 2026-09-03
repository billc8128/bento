import { useSyncExternalStore } from "react"
import { DEFAULT_HARNESS_ID, type HarnessId } from "@/core/harness"
import type { SessionScope } from "@/core/types"

type NewSessionSnapshot = {
  open: boolean
  revision: number
  harnessId: HarnessId
  cwd: string
  scope: SessionScope
}

let snapshot: NewSessionSnapshot = {
  open: false,
  revision: 0,
  harnessId: DEFAULT_HARNESS_ID,
  cwd: "",
  scope: "chat",
}
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function requestNewSession(options: {
  harnessId?: HarnessId
  cwd?: string
  scope?: SessionScope
} = {}) {
  snapshot = {
    open: true,
    revision: snapshot.revision + 1,
    harnessId: options.harnessId ?? DEFAULT_HARNESS_ID,
    cwd: options.cwd ?? "",
    scope: options.scope ?? (options.cwd ? "project" : "chat"),
  }
  emit()
}

export function closeNewSession() {
  if (!snapshot.open) return
  snapshot = { ...snapshot, open: false }
  emit()
}

export function subscribeNewSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNewSessionSnapshot(): NewSessionSnapshot {
  return snapshot
}

export function useNewSession(): NewSessionSnapshot {
  return useSyncExternalStore(subscribeNewSession, getNewSessionSnapshot)
}
