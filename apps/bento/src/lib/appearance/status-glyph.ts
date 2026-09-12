/** 会话状态指示样式偏好:仅影响侧栏渲染,localStorage 持久化。 */

import { useSyncExternalStore } from "react"

export type StatusGlyphVariant = "a" | "b" | "d" | "f"

/** 变体名文案由 AppearanceSection 经 GLYPH_NAME_KEYS 走 t() 查表 */
export const STATUS_GLYPH_VARIANTS: readonly { id: StatusGlyphVariant }[] = [
  { id: "b" },
  { id: "a" },
  { id: "d" },
  { id: "f" },
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
