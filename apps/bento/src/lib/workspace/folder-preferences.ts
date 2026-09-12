/** 文件夹分组偏好：仅影响 Bento 侧栏，不修改磁盘目录或会话记录。 */

import { useSyncExternalStore } from "react"

type FolderPreferences = {
  pinned: string[]
  hidden: string[]
  aliases: Record<string, string>
  /** 收折起来的文件夹分组(cwd);缺省全部展开 */
  collapsed: string[]
}

const STORAGE_KEY = "bento.folder-preferences"
const EMPTY: FolderPreferences = { pinned: [], hidden: [], aliases: {}, collapsed: [] }
let cache: FolderPreferences | null = null
const listeners = new Set<() => void>()

function load(): FolderPreferences {
  if (cache) return cache
  try {
    // 旧存档缺新字段(如 collapsed),与 EMPTY 合并补齐
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<FolderPreferences> | null
    cache = saved ? { ...EMPTY, ...saved } : EMPTY
  } catch {
    cache = EMPTY
  }
  return cache
}

function persist(next: FolderPreferences) {
  cache = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

export function toggleFolderPin(cwd: string) {
  const current = load()
  const pinned = new Set(current.pinned)
  if (pinned.has(cwd)) pinned.delete(cwd)
  else pinned.add(cwd)
  persist({ ...current, pinned: [...pinned] })
}

export function renameFolder(cwd: string, name: string) {
  const current = load()
  const aliases = { ...current.aliases }
  const next = name.trim()
  if (next) aliases[cwd] = next
  else delete aliases[cwd]
  persist({ ...current, aliases })
}

export function hideFolder(cwd: string) {
  const current = load()
  persist({ ...current, hidden: [...new Set([...current.hidden, cwd])] })
}

export function showFolder(cwd: string) {
  const current = load()
  if (!current.hidden.includes(cwd)) return
  persist({ ...current, hidden: current.hidden.filter((item) => item !== cwd) })
}

export function setFolderCollapsed(cwd: string, collapsed: boolean) {
  const current = load()
  if (current.collapsed.includes(cwd) === collapsed) return
  const next = new Set(current.collapsed)
  if (collapsed) next.add(cwd)
  else next.delete(cwd)
  persist({ ...current, collapsed: [...next] })
}

export function useFolderPreferences(): FolderPreferences {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
  )
}
