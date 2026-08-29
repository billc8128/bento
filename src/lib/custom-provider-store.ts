/**
 * 用户自定义供应商列表的 renderer 侧 store。
 * main 侧 CRUD 后推送 onProvidersChanged,这里整单重拉(量级是个位数,不值得增量)。
 * 纯 web 模式(window.bento 不存在)降级为 desktop=false 的空列表,由 UI 出空态。
 */

import { useEffect, useSyncExternalStore } from "react"

import type { CustomHarnessId, CustomProviderConfig, CustomRuntimeConfig } from "@/core/provider"

/** listCustomProviders 的条目:完整配置 + 每个 runtime 是否已存 key(key 本体只写不读)。 */
export type CustomProviderEntry = Omit<CustomProviderConfig, "runtimes"> & {
  hasCredential: boolean
  runtimes: Partial<Record<CustomHarnessId, CustomRuntimeConfig & { hasKey: boolean }>>
}

type Snapshot = {
  desktop: boolean
  loaded: boolean
  providers: CustomProviderEntry[]
  version: number
}

let state: Snapshot = {
  desktop: typeof window !== "undefined" && !!window.bento,
  loaded: false,
  providers: [],
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
    patch({ providers: [], loaded: true })
    return
  }
  try {
    const providers = await bento.listCustomProviders()
    patch({ providers: providers as CustomProviderEntry[], loaded: true })
  } catch {
    patch({ providers: [], loaded: true })
  }
}

if (typeof window !== "undefined" && window.bento?.onProvidersChanged) {
  window.bento.onProvidersChanged(() => void refresh())
}

export function useCustomProviders(): Snapshot {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
  useEffect(() => {
    if (!state.loaded) void refresh()
  }, [])
  return snapshot
}

/** 保存(新增或更新)。keys 只写:值非空才进 payload,空对象不打扰 main。 */
export async function saveCustomProvider(
  config: CustomProviderConfig,
  keys?: Record<string, string>,
): Promise<{ error?: string }> {
  const bento = window.bento
  if (!bento) return { error: "需要桌面版" }
  const cleanKeys = keys
    ? Object.fromEntries(Object.entries(keys).filter(([, value]) => value.trim() !== ""))
    : undefined
  const result = await bento.upsertCustomProvider({
    config,
    ...(cleanKeys && Object.keys(cleanKeys).length > 0 ? { keys: cleanKeys } : {}),
  })
  if (result.error) return { error: result.error }
  await refresh()
  return {}
}

export async function deleteCustomProvider(providerId: string): Promise<{ error?: string }> {
  const bento = window.bento
  if (!bento) return { error: "需要桌面版" }
  const result = await bento.removeCustomProvider(providerId)
  if (result.error) return { error: result.error }
  await refresh()
  return {}
}
