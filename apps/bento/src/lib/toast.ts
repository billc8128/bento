/**
 * 极简全局 toast。与 settings-store 同款的模块级 store,免 Context。
 * 成功/失败反馈统一走这里,组件里不再各写各的瞬态提示。
 */

import { useSyncExternalStore } from "react"

export type ToastKind = "success" | "error" | "info"

type ToastItem = {
  id: number
  kind: ToastKind
  text: string
}

let toasts: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function toast(text: string, kind: ToastKind = "info") {
  const id = nextId++
  toasts = [...toasts, { id, kind, text }]
  emit()
  setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== id)
    emit()
  }, 3600)
}

toast.success = (text: string) => toast(text, "success")
toast.error = (text: string) => toast(text, "error")

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts,
  )
}
