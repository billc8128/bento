import { useSyncExternalStore } from "react"

import type { BentoAppId, BentoAppView } from "@/core/apps"

type Snapshot = { loaded: boolean; apps: BentoAppView[]; version: number }

let snapshot: Snapshot = { loaded: false, apps: [], version: 0 }
const listeners = new Set<() => void>()

function publish(apps: BentoAppView[]) {
  snapshot = { loaded: true, apps, version: snapshot.version + 1 }
  for (const listener of listeners) listener()
}

async function refresh() {
  const apps = await window.bento?.listApps().catch(() => [])
  publish(apps ?? [])
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

export function useApps(): Snapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}
