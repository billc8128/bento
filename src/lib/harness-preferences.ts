/**
 * Harness 启用开关(设置 → Harness 页逐行控制)。关掉的 Harness 在运行时
 * 选择器里不可选;存量会话不受影响(选择器会保留当前 harness 的展示)。
 * localStorage 持久化。
 */

import { useSyncExternalStore } from "react"

import type { HarnessId } from "@/core/harness"

const KEY = "bento.disabledHarnesses"

function load(): Set<HarnessId> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    return new Set(Array.isArray(raw) ? (raw as HarnessId[]) : [])
  } catch {
    return new Set()
  }
}

let disabled = load()
let version = 0
const listeners = new Set<() => void>()

export function isHarnessEnabled(id: HarnessId): boolean {
  return !disabled.has(id)
}

export function setHarnessEnabled(id: HarnessId, enabled: boolean) {
  const next = new Set(disabled)
  if (enabled) next.delete(id)
  else next.add(id)
  disabled = next
  version += 1
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener()
}

export function useHarnessPreferences(): { isEnabled: (id: HarnessId) => boolean } {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
  )
  return { isEnabled: isHarnessEnabled }
}
