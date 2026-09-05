/** 会话状态指示样式偏好:仅影响侧栏渲染,localStorage 持久化。 */

import { useSyncExternalStore } from "react"

export type StatusGlyphVariant = "a" | "b" | "d" | "f"

export const STATUS_GLYPH_VARIANTS: readonly {
  id: StatusGlyphVariant
  name: string
}[] = [
  { id: "b", name: "微型进度环" },
  { id: "a", name: "呼吸光环" },
  { id: "d", name: "行内能量条" },
  { id: "f", name: "像素状态机" },
]

const STORAGE_KEY = "bento.status-glyph"
const DEFAULT_VARIANT: StatusGlyphVariant = "b"
let cache: StatusGlyphVariant | null = null
const listeners = new Set<() => void>()

function load(): StatusGlyphVariant {
  if (cache) return cache
  const saved = localStorage.getItem(STORAGE_KEY)
  cache = STATUS_GLYPH_VARIANTS.some((v) => v.id === saved)
    ? (saved as StatusGlyphVariant)
    : DEFAULT_VARIANT
  return cache
}

export function setStatusGlyph(next: StatusGlyphVariant) {
  cache = next
  localStorage.setItem(STORAGE_KEY, next)
  for (const listener of listeners) listener()
}

export function useStatusGlyph(): StatusGlyphVariant {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
  )
}
