import { useSyncExternalStore } from "react"

import type { BentoAppId, BentoAppView, UserAppInput } from "@/core/apps"

type Snapshot = { loaded: boolean; apps: BentoAppView[]; error: string | null; version: number }

let snapshot: Snapshot = { loaded: false, apps: [], error: null, version: 0 }
const listeners = new Set<() => void>()

function publish(apps: BentoAppView[]) {
  snapshot = { loaded: true, apps, error: null, version: snapshot.version + 1 }
  for (const listener of listeners) listener()
}

async function refresh() {
  try {
    publish(await window.bento?.listApps() ?? [])
  } catch (error) {
    snapshot = {
      ...snapshot,
      loaded: true,
      error: error instanceof Error ? error.message : "读取 Apps 失败",
      version: snapshot.version + 1,
    }
    for (const listener of listeners) listener()
  }
}

export function retryApps() {
  void refresh()
}

if (window.bento) {
  void refresh()
  window.bento.onAppsChanged(() => void refresh())
}

export async function setAppEnabled(id: BentoAppId, enabled: boolean): Promise<string | null> {
  const previous = snapshot.apps
  publish(previous.map((app) => app.id === id ? { ...app, enabled } : app))
  const result = await window.bento?.setAppEnabled(id, enabled)
  if (!result || "error" in result) {
    publish(previous)
    return result && "error" in result ? result.error : "桌面模式不可用"
  }
  return null
}

export async function upsertApp(input: UserAppInput): Promise<string | null> {
  const result = await window.bento?.upsertApp(input)
  if (!result || "error" in result) return result && "error" in result ? result.error : "桌面模式不可用"
  await refresh()
  return null
}

export async function removeApp(id: string): Promise<string | null> {
  const result = await window.bento?.removeApp(id)
  if (!result || "error" in result) return result && "error" in result ? result.error : "桌面模式不可用"
  await refresh()
  return null
}

export function useApps(): Snapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}
