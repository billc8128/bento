/**
 * 设置页的全局开关。AppSidebar 菜单与 RuntimePicker 空态都经这里打开,
 * SettingsPage 挂在 App 根部订阅同一份状态。
 */

import { useSyncExternalStore } from "react"

export type SettingsSection = "providers" | "harnesses" | "appearance" | "layout" | "shortcuts"

type SettingsState = {
  open: boolean
  section: SettingsSection
  /** 打开供应商区后直接进添加向导(RuntimePicker 空态「添加供应商…」)。 */
  addProvider: boolean
  version: number
}

let state: SettingsState = { open: false, section: "providers", addProvider: false, version: 0 }
const listeners = new Set<() => void>()

function patch(next: Partial<Omit<SettingsState, "version">>) {
  state = { ...state, ...next, version: state.version + 1 }
  for (const listener of listeners) listener()
}

export function openSettings(section: SettingsSection = "providers", opts?: { addProvider?: boolean }) {
  patch({ open: true, section, addProvider: opts?.addProvider === true })
}

export function closeSettings() {
  patch({ open: false, addProvider: false })
}

/** 一次性消费 addProvider 意图,避免下次打开复进向导。 */
export function consumeAddProviderIntent() {
  if (state.addProvider) patch({ addProvider: false })
}

export function useSettingsPage(): SettingsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}
