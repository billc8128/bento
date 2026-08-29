import { useCallback, useEffect, useSyncExternalStore } from "react"

import { HARNESSES, type HarnessId } from "@/core/harness"
import type { ProviderView } from "@/core/provider"

type ProviderSnapshot = {
  providers: ProviderView[]
  loaded: boolean
  loading: boolean
  discovering: boolean
  version: number
}

const snapshots = new Map<string, ProviderSnapshot>()
const listeners = new Set<() => void>()
const requestSeq = new Map<string, number>()

function keyOf(harnessId: HarnessId, cwd: string) {
  return `${harnessId}\0${cwd.trim()}`
}

function stateOf(key: string): ProviderSnapshot {
  let state = snapshots.get(key)
  if (!state) {
    state = { providers: [], loaded: false, loading: false, discovering: false, version: 0 }
    snapshots.set(key, state)
  }
  return state
}

function patch(key: string, value: Partial<Omit<ProviderSnapshot, "version">>) {
  const current = stateOf(key)
  snapshots.set(key, { ...current, ...value, version: current.version + 1 })
  for (const listener of listeners) listener()
}

// main 侧 custom provider CRUD 后推送;收到即把所有 snapshot 的 providers
// 置空,各处 hook 的初始拉取 effect 重新执行(拉到含 user provider 的列表)
if (typeof window !== "undefined" && window.bento?.onProvidersChanged) {
  window.bento.onProvidersChanged(() => {
    for (const key of snapshots.keys()) {
      const separator = key.indexOf("\0")
      const harnessId = key.slice(0, separator) as HarnessId
      const cwd = key.slice(separator + 1)
      void fetchProviders(harnessId, cwd, false)
    }
  })
}

/** 可见性变更只改现有快照，不清空目录或重新发现 CLI。 */
export function applyProviderModelVisibility(modelIds: string[], enabled: boolean) {
  const ids = new Set(modelIds)
  for (const [key, snapshot] of snapshots) {
    const providers = snapshot.providers.map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).map(([harnessId, models]) => [
          harnessId,
          models?.map((model) => ids.has(model.id) ? { ...model, enabled } : model),
        ]),
      ) as ProviderView["models"],
    }))
    patch(key, { providers })
  }
}

async function fetchProviders(
  harnessId: HarnessId,
  cwd: string,
  discover: boolean,
  refresh = false,
) {
  const key = keyOf(harnessId, cwd)
  const bento = window.bento
  if (!bento) return
  // React 子组件的「打开即发现」effect 可能先于本 hook 的初始列表 effect 执行；
  // 初始只读请求不得反过来取消并覆盖已经开始的真实发现。
  if (!discover && stateOf(key).discovering) return
  if (discover && stateOf(key).discovering) return
  const seq = (requestSeq.get(key) ?? 0) + 1
  requestSeq.set(key, seq)
  patch(key, discover
    ? { discovering: true, loading: false }
    : { loading: true, discovering: false })
  try {
    const providers = await bento.listProviders({
      harnessId,
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...(discover ? { discover: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    })
    if (requestSeq.get(key) === seq) patch(key, { providers, loaded: true })
  } catch {
    if (requestSeq.get(key) === seq) patch(key, { providers: [], loaded: true })
  } finally {
    if (requestSeq.get(key) === seq) {
      patch(key, { discovering: false, loading: false })
    }
  }
}

export function useProviderCatalog(harnessId: HarnessId, cwd: string) {
  const key = keyOf(harnessId, cwd)
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => stateOf(key),
  )

  useEffect(() => {
    if (!snapshot.loaded && !snapshot.loading) {
      void fetchProviders(harnessId, cwd, false)
    }
  }, [cwd, harnessId, snapshot.loaded, snapshot.loading])

  const discover = useCallback(
    (refresh = false) => fetchProviders(harnessId, cwd, true, refresh),
    [cwd, harnessId],
  )

  return { ...snapshot, discover }
}

/**
 * 全 harness 聚合目录(方案 C 的模型优先列表用)。
 * snapshot 仍按 (harnessId, cwd) 分 key 存,这里只读聚合;
 * useSyncExternalStore 要求 getSnapshot 稳定,聚合结果按版本签名缓存。
 */
type AllCatalogSnapshot = {
  providers: ProviderView[]
  loaded: boolean
  loading: boolean
  discovering: boolean
}

const aggregateCache = new Map<string, { signature: string; value: AllCatalogSnapshot }>()

export function mergeProviderCatalogs(providers: ProviderView[]): ProviderView[] {
  const merged = new Map<string, ProviderView>()
  for (const provider of providers) {
    const existing = merged.get(provider.id)
    const connectedModels = Object.fromEntries(
      Object.entries(provider.models).map(([harnessId, models]) => [
        harnessId,
        provider.connected ? models : [],
      ]),
    ) as ProviderView["models"]
    if (!existing) {
      merged.set(provider.id, { ...provider, models: connectedModels })
      continue
    }
    merged.set(provider.id, {
      ...existing,
      connected: existing.connected || provider.connected,
      harnessIds: [...new Set([...existing.harnessIds, ...provider.harnessIds])],
      models: { ...existing.models, ...connectedModels },
      defaultModelIds: { ...existing.defaultModelIds, ...provider.defaultModelIds },
    })
  }
  return [...merged.values()]
}

function aggregateOf(cwd: string): AllCatalogSnapshot {
  const states = HARNESSES.map((harness) => stateOf(keyOf(harness.id, cwd)))
  const signature = states.map((state) => state.version).join("|")
  const cached = aggregateCache.get(cwd)
  if (cached?.signature === signature) return cached.value
  const value: AllCatalogSnapshot = {
    providers: mergeProviderCatalogs(states.flatMap((state) => state.providers)),
    loaded: states.every((state) => state.loaded),
    loading: states.some((state) => state.loading),
    discovering: states.some((state) => state.discovering),
  }
  aggregateCache.set(cwd, { signature, value })
  return value
}

export function useAllProviderCatalogs(cwd: string) {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => aggregateOf(cwd),
  )

  // base 列表(无模型)很便宜,六个 harness 一次拉齐,撑开分组骨架。
  // 依赖 snapshot:onProvidersChanged 会把 providers 置空,必须随之重新拉取。
  useEffect(() => {
    for (const harness of HARNESSES) {
      const state = stateOf(keyOf(harness.id, cwd))
      if (!state.loaded && !state.loading) {
        void fetchProviders(harness.id, cwd, false)
      }
    }
  }, [cwd, snapshot])

  const discover = useCallback(
    (harnessId: HarnessId, refresh = false) =>
      fetchProviders(harnessId, cwd, true, refresh),
    [cwd],
  )

  // 当前 harness 立即发现;其余错峰后台发,避免同时 spawn 5 个 ACP 进程打满机器。
  // 结果按 (harnessId, cwd) 缓存,重复打开弹层不会重复发现。
  const discoverAll = useCallback(
    async (currentHarnessId: HarnessId, refresh = false) => {
      const tasks: Promise<void>[] = [fetchProviders(currentHarnessId, cwd, true, refresh)]
      const rest = HARNESSES.map((harness) => harness.id).filter((id) => id !== currentHarnessId)
      rest.forEach((id, index) => {
        tasks.push((async () => {
          await new Promise((resolve) => setTimeout(resolve, 400 * (index + 1)))
          const state = stateOf(keyOf(id, cwd))
          // 进行中的发现不被重复请求覆盖(refresh 除外),纪律同 fetchProviders 的只读守卫
          if (state.discovering) return
          const settled = state.providers.some(
            (p) => p.modelDiscovery === "ready" || p.modelDiscovery === "unsupported" || p.modelDiscovery === "failed",
          )
          if (settled && !refresh) return
          await fetchProviders(id, cwd, true, refresh)
        })())
      })
      await Promise.all(tasks)
    },
    [cwd],
  )

  return { ...snapshot, discover, discoverAll }
}
