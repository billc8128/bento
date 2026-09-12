/**
 * 会话置顶:纯 renderer 偏好,localStorage 持久化(session key 跨重启稳定)。
 * 置顶是展示层顺序,不进 main 的会话记录——删库/换机不同步,可接受。
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "bento.pinned-sessions"

let cache: Set<string> | null = null
const listeners = new Set<() => void>()

function load(): Set<string> {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    cache = new Set()
  }
  return cache
}

function persist(next: Set<string>) {
  cache = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  for (const listener of listeners) listener()
}

export function isPinned(sessionKey: string): boolean {
  return load().has(sessionKey)
}

export function togglePin(sessionKey: string): void {
  const next = new Set(load())
  if (next.has(sessionKey)) next.delete(sessionKey)
  else next.add(sessionKey)
  persist(next)
}

/** 置顶集合的响应式快照;配合 useMemo 排序用。 */
export function usePinnedSessions(): Set<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => load(),
  )
}
