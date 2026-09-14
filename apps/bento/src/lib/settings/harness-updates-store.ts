/**
 * Harness 运行时更新的 renderer 侧 store。
 * 初始拉 status;收到 harnessUpdates:changed 推送(检查完成/下载进度/更新
 * 完成)即整单重拉。更新动作经 window.bento.harnessUpdatesUpdate 触发。
 */

import { useSyncExternalStore } from "react"

import type { HarnessUpdateStatus } from "@/core/harness-updates"

type Snapshot = {
  desktop: boolean
  loaded: boolean
  statuses: HarnessUpdateStatus[]
  version: number
}

let state: Snapshot = {
  desktop: typeof window !== "undefined" && !!window.bento,
  loaded: false,
  statuses: [],
  version: 0,
}
const listeners = new Set<() => void>()

function patch(next: Partial<Omit<Snapshot, "version">>) {
  state = { ...state, ...next, version: state.version + 1 }
  for (const listener of listeners) listener()
}

async function refresh() {
  const bento = window.bento
  if (!bento) {
    patch({ statuses: [], loaded: true })
    return
  }
  try {
    const statuses = await bento.harnessUpdatesStatus()
    patch({ statuses, loaded: true })
  } catch {
    patch({ loaded: true })
  }
}

if (typeof window !== "undefined" && window.bento?.onHarnessUpdatesChanged) {
  window.bento.onHarnessUpdatesChanged(() => void refresh())
}

export function useHarnessUpdates(): Snapshot {
  useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange)
      if (!state.loaded) void refresh()
      return () => listeners.delete(onStoreChange)
    },
    () => state,
  )
  return state
}

/** 未完成的更新数(available/downloading/failed):入口小点与「N 个可更新」用。 */
export function pendingUpdateCount(statuses: HarnessUpdateStatus[]): number {
  return statuses.filter((item) =>
    item.state === "available" || item.state === "downloading" || item.state === "failed",
  ).length
}
