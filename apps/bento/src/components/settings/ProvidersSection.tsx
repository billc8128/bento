import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, MoreHorizontal, Plus, RefreshCw, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import type { CustomModelConfig, CustomProviderConfig, ProviderModel, ProviderView } from "@/core/provider"
import {
  deleteCustomProvider,
  saveCustomProvider,
  useCustomProviders,
  type CustomProviderEntry,
} from "@/lib/providers/custom-provider-store"
import { applyProviderModelVisibility, providerCatalogSnapshot, useAllProviderCatalogs } from "@/lib/providers/provider-store"
import { useT, type TFn } from "@/lib/i18n"
import { useLocalImportSources } from "@/lib/providers/local-import"
import { consumeAddProviderIntent } from "@/lib/settings/settings-store"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

import { CUSTOM_HARNESSES, describeFetchError } from "./labels"
import { providerFamilyId } from "./provider-grouping"
import { ProviderMark } from "./ProviderMark"
import { ProviderWizard } from "./ProviderWizard"

type ProviderSource =
  | { kind: "builtin"; id: string; name: string; connected: boolean; modelCount: number; authMethod: "none" | "apiKey" | "oauth"; brandKey: string; view: ProviderView }
  | { kind: "custom"; id: string; name: string; connected: boolean; modelCount: number; authMethod: "none" | "apiKey" | "oauth"; brandKey?: string; entry: CustomProviderEntry }

type ProviderGroup = {
  id: string
  name: string
  brandKey?: string
  sources: ProviderSource[]
}

type ProviderGroupModel = CustomModelConfig & {
  key: string
  members: Array<{ source: ProviderSource; modelId: string }>
}

function providerFamilyName(id: string, fallback: string): string {
  if (id === "kimi-code") return "Kimi Code"
  if (id === "openai") return "OpenAI"
  if (id === "anthropic") return "Anthropic"
  if (id === "zai-coding-plan-global") return "Z.ai GLM Coding Plan"
  return fallback
}

function sourceTabLabel(source: ProviderSource, t: TFn): string {
  if (source.authMethod === "oauth") return "OAuth"
  if (source.authMethod === "apiKey") return "API Key"
  return t("providers.authNone")
}

function groupModelCount(group: ProviderGroup): number {
  return groupModels(group, {}).filter((model) => model.enabled !== false).length
}

function ItemMark({ group, large = false }: { group: ProviderGroup; large?: boolean }) {
  return <ProviderMark name={group.name} brandKey={group.brandKey} className={large ? "size-10 rounded-xl text-sm" : undefined} />
}

function toConfig(entry: CustomProviderEntry): CustomProviderConfig {
  const runtimes: CustomProviderConfig["runtimes"] = {}
  for (const harness of CUSTOM_HARNESSES) {
    const runtime = entry.runtimes[harness]
    if (!runtime) continue
    const { hasKey: _hasKey, ...config } = runtime
    runtimes[harness] = config
  }
  return {
    id: entry.id,
    name: entry.name,
    auth: entry.auth,
    runtimes,
    ...(entry.presetId ? { presetId: entry.presetId } : {}),
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
  }
}

function customModels(entry: CustomProviderEntry): CustomModelConfig[] {
  const map = new Map<string, CustomModelConfig>()
  for (const runtime of Object.values(entry.runtimes)) {
    for (const model of runtime?.models ?? []) {
      const previous = map.get(model.id)
      map.set(model.id, {
        ...previous,
        ...model,
        enabled: previous?.enabled !== false && model.enabled !== false,
      })
    }
  }
  return [...map.values()]
}

function catalogModels(provider: ProviderView): CustomModelConfig[] {
  const map = new Map<string, ProviderModel>()
  for (const models of Object.values(provider.models)) {
    for (const model of models ?? []) map.set(model.id, model)
  }
  return [...map.values()].map((model) => ({ ...model, enabled: model.enabled !== false }))
}

function modelKey(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id
}

function sourceModels(
  source: ProviderSource,
  drafts: Record<string, Record<string, boolean>>,
): CustomModelConfig[] {
  const draft = drafts[source.id]
  const models = source.kind === "custom" ? customModels(source.entry) : catalogModels(source.view)
  return models
    .map((model) => draft && model.id in draft ? { ...model, enabled: draft[model.id] } : model)
}

function groupModels(
  group: ProviderGroup,
  drafts: Record<string, Record<string, boolean>>,
): ProviderGroupModel[] {
  const map = new Map<string, ProviderGroupModel>()
  for (const source of group.sources) {
    for (const model of sourceModels(source, drafts)) {
      const key = modelKey(model.id)
      const previous = map.get(key)
      map.set(key, {
        ...previous,
        ...model,
        id: !previous || model.id.length < previous.id.length ? model.id : previous.id,
        name: previous?.name && previous.name !== previous.id ? previous.name : model.name,
        enabled: previous ? previous.enabled !== false || model.enabled !== false : model.enabled !== false,
        reasoning: previous?.reasoning === true || model.reasoning === true,
        contextWindow: Math.max(previous?.contextWindow ?? 0, model.contextWindow ?? 0) || undefined,
        key,
        members: [...(previous?.members ?? []), { source, modelId: model.id }],
      })
    }
  }
  return [...map.values()]
}

function contextLabel(value: number | undefined): string {
  if (!value) return ""
  if (value >= 1_000_000) return `${value / 1_000_000}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function ProvidersSkeleton() {
  const { t } = useT()
  return (
    <div className="contents" aria-busy="true" aria-label={t("providers.loadingProviders")}>
      <aside className="flex w-64 min-w-0 shrink-0 flex-col border-r border-border">
        <div className="flex h-12 items-center justify-between border-b border-border px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="size-4" />
        </div>
        <div className="flex-1 space-y-2 p-2">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-2.5 px-2.5 py-2">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className={cn("h-4", index === 3 ? "w-36" : "w-24")} />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="size-2 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
        <div className="border-t border-border p-3">
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-24 items-center gap-3 border-b border-border px-6">
          <Skeleton className="size-10 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
        <div className="flex items-center gap-4 border-b border-border px-6 py-4">
          <Skeleton className="h-9 max-w-md flex-1 rounded-lg" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="divide-y divide-border px-6">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex min-h-16 items-center gap-4 py-2">
              <div className="flex-1 space-y-1.5">
                <Skeleton className={cn("h-4", index % 2 ? "w-44" : "w-32")} />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}

export function ProvidersSection({ addProviderIntent }: { addProviderIntent: false | "form" | "detect" }) {
  const { t } = useT()
  const { desktop, loaded, providers: customProviders } = useCustomProviders()
  const {
    providers: catalogProviders,
    loaded: catalogLoaded,
    discover: discoverCatalog,
    discoverAll,
  } = useAllProviderCatalogs("")
  const sources = useMemo<ProviderSource[]>(() => [
    ...catalogProviders
      .filter((provider) => provider.source === "builtin")
      .map((view): ProviderSource => ({
        kind: "builtin",
        id: view.id,
        name: view.name,
        connected: view.connected,
        modelCount: catalogModels(view).filter((model) => model.enabled !== false).length,
        authMethod: view.authMethod === "apiKey" || view.authMethod === "none" ? view.authMethod : "oauth",
        brandKey: view.id,
        view,
      })),
    ...customProviders.map((entry): ProviderSource => ({
      kind: "custom",
      id: entry.id,
      name: entry.name,
      connected: entry.hasCredential,
      modelCount: customModels(entry).filter((model) => model.enabled !== false).length,
      authMethod: entry.auth.method,
      ...(entry.presetId ? { brandKey: entry.presetId } : {}),
      entry,
    })),
  ], [catalogProviders, customProviders])
  const groups = useMemo<ProviderGroup[]>(() => {
    const canonicalId = (source: ProviderSource) => {
      if (source.kind === "custom") return source.entry.presetId ?? source.id.replace(/^user-/, "")
      if (source.id === "openai") return "openai-api"
      if (source.id === "anthropic") return "anthropic-api"
      return source.id
    }
    const map = new Map<string, ProviderGroup>()
    for (const source of sources) {
      const canonical = canonicalId(source)
      const id = providerFamilyId(canonical)
      const group = map.get(id) ?? {
        id,
        name: providerFamilyName(id, source.name),
        brandKey: id,
        sources: [],
      }
      group.sources.push(source)
      map.set(id, group)
    }
    return [...map.values()]
  }, [sources])
  const [selectedId, setSelectedId] = useState("")
  const [query, setQuery] = useState("")
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStartStep, setWizardStartStep] = useState<"pick" | "detect" | null>(null)
  const [editing, setEditing] = useState<CustomProviderEntry | null>(null)
  const [deleting, setDeleting] = useState<CustomProviderEntry | null>(null)
  const [sessionsUsing, setSessionsUsing] = useState<{ id: string; count: number } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 空态导入 CTA(§2.5):只在无任何供应商时展示,候选只看可直接导入的。
  const importSources = useLocalImportSources()

  useEffect(() => {
    if (!desktop) return
    void discoverAll("codex")
  }, [desktop, discoverAll])

  // 模型可见性开关:本地即时生效,800ms 防抖合并一次写盘,失败回滚 + toast
  const [drafts, setDrafts] = useState<Record<string, Record<string, boolean>>>({})
  const draftsRef = useRef(drafts)
  const itemsRef = useRef(sources)
  useEffect(() => {
    draftsRef.current = drafts
    itemsRef.current = sources
  })
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = saveTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  const selectedGroup = groups.find((group) => group.id === selectedId) ?? groups[0]
  const models = selectedGroup ? groupModels(selectedGroup, drafts) : []
  const visibleModels = models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()))
  const allEnabled = models.length > 0 && models.every((model) => model.enabled !== false)
  const hasContext = models.some((model) => model.contextWindow)
  const builtinSource = selectedGroup?.sources.find(
    (source): source is Extract<ProviderSource, { kind: "builtin" }> => source.kind === "builtin",
  )
  const customSource = selectedGroup?.sources.find(
    (source): source is Extract<ProviderSource, { kind: "custom" }> => source.kind === "custom",
  )

  const [intentHandled, setIntentHandled] = useState(false)
  if (addProviderIntent && desktop && !intentHandled) {
    setIntentHandled(true)
    setEditing(null)
    setWizardStartStep(addProviderIntent === "detect" ? "detect" : null)
    setWizardOpen(true)
  }

  useEffect(() => {
    if (!deleting || !window.bento) return
    let alive = true
    void window.bento.providerSessionsUsing(deleting.id).then((count) => {
      if (alive) setSessionsUsing({ id: deleting.id, count })
    })
    return () => {
      alive = false
    }
  }, [deleting])
  // 只在 id 匹配当前删除目标时生效,避免上一个目标的计数串味(也免掉 effect 里同步重置)
  const usingCount = deleting && sessionsUsing?.id === deleting.id ? sessionsUsing.count : null

  async function flushDrafts(providerId: string) {
    const sent = draftsRef.current[providerId]
    const item = itemsRef.current.find((entry) => entry.id === providerId)
    if (!sent || !item || item.kind !== "custom") return
    const config = toConfig(item.entry)
    for (const runtime of Object.values(config.runtimes)) {
      if (!runtime) continue
      runtime.models = runtime.models.map((model) =>
        model.id in sent ? { ...model, enabled: sent[model.id] } : model,
      )
    }
    const result = await saveCustomProvider(config)
    if (result.error) {
      // 回滚到 store 里的真实值
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[providerId]
        return next
      })
      toast.error(t("providers.saveFailed", { error: result.error }))
      return
    }
    // 写盘期间没有新的改动才清草稿,否则保留等下一轮 flush
    setDrafts((prev) => {
      if (prev[providerId] !== sent) return prev
      const next = { ...prev }
      delete next[providerId]
      return next
    })
  }

  function toggleModels(entry: CustomProviderEntry, modelId: string | null, enabled: boolean) {
    setDrafts((prev) => {
      const current = { ...(prev[entry.id] ?? {}) }
      if (modelId === null) {
        for (const model of customModels(entry)) current[model.id] = enabled
      } else {
        current[modelId] = enabled
      }
      return { ...prev, [entry.id]: current }
    })
    const timers = saveTimers.current
    const existing = timers.get(entry.id)
    if (existing) clearTimeout(existing)
    timers.set(entry.id, setTimeout(() => {
      timers.delete(entry.id)
      void flushDrafts(entry.id)
    }, 800))
  }

  async function toggleCatalogModels(
    entry: Extract<ProviderSource, { kind: "builtin" }>,
    modelId: string | null,
    enabled: boolean,
  ) {
    const ids = modelId ? [modelId] : catalogModels(entry.view).map((model) => model.id)
    setDrafts((prev) => ({
      ...prev,
      [entry.id]: {
        ...(prev[entry.id] ?? {}),
        ...Object.fromEntries(ids.map((id) => [id, enabled])),
      },
    }))
    const result = await window.bento?.setProviderModelVisibility({
      providerId: entry.id,
      updates: ids.map((id) => ({ modelId: id, enabled })),
    })
    if (!result || "error" in result) {
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[entry.id]
        return next
      })
      toast.error(t("providers.saveFailed", { error: result && "error" in result ? result.error : t("providers.desktopUnavailable") }))
      return
    }
    applyProviderModelVisibility(ids, enabled)
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[entry.id]
      return next
    })
  }

  function toggleGroupModel(model: ProviderGroupModel | null, enabled: boolean) {
    if (!selectedGroup) return
    if (!model) {
      for (const source of selectedGroup.sources) {
        if (source.kind === "custom") toggleModels(source.entry, null, enabled)
        else void toggleCatalogModels(source, null, enabled)
      }
      return
    }
    for (const member of model.members) {
      if (member.source.kind === "custom") toggleModels(member.source.entry, member.modelId, enabled)
      else void toggleCatalogModels(member.source, member.modelId, enabled)
    }
  }

  /** 自定义供应商:按 runtime 候选地址逐个拉模型列表,合并新增项。
   *  返回新增数或失败原因;toast/错误展示由 refreshSelectedGroup 统一收口。 */
  async function refreshCustom(source: Extract<ProviderSource, { kind: "custom" }>): Promise<{ added: number } | { error: string }> {
    if (!window.bento) return { error: t("providers.desktopOnly") }
    const config = toConfig(source.entry)
    const candidates = CUSTOM_HARNESSES.flatMap((harness) => {
      const runtime = config.runtimes[harness]
      if (!runtime) return []
      const baseUrl = runtime.baseUrl.replace(/\/+$/, "")
      return [{
        harness,
        modelsUrl: runtime.modelsUrl ?? `${baseUrl}/models`,
        priority: runtime.modelsUrl ? 0 : /\/v\d+(?:beta)?$/i.test(baseUrl) ? 1 : 2,
      }]
    }).sort((a, b) => a.priority - b.priority)
    const seenUrls = new Set<string>()
    const failures: string[] = []
    let discovered: CustomModelConfig[] | null = null
    for (const candidate of candidates) {
      if (seenUrls.has(candidate.modelsUrl)) continue
      seenUrls.add(candidate.modelsUrl)
      const result = await window.bento.fetchProviderModels({
        providerId: source.id,
        agent: candidate.harness,
        modelsUrl: candidate.modelsUrl,
      })
      if ("ok" in result && result.ok) {
        discovered = result.models
        break
      } else {
        failures.push(describeFetchError(result, t))
      }
    }
    if (discovered) {
      const previousIds = new Set(customModels(source.entry).map((model) => model.id))
      const added = discovered.filter((model) => !previousIds.has(model.id)).length
      for (const runtime of Object.values(config.runtimes)) {
        if (!runtime) continue
        const existing = new Set(runtime.models.map((model) => model.id))
        runtime.models = [
          ...runtime.models,
          ...discovered
            .filter((model) => !existing.has(model.id))
            .map((model) => ({ ...model, enabled: true })),
        ]
      }
      const result = await saveCustomProvider(config)
      if (result.error) return { error: result.error }
      return { added }
    }
    return { error: failures[0] ?? t("providers.fetchModelsFailed") }
  }

  async function refreshSelectedGroup() {
    if (!selectedGroup) return
    setRefreshing(true)
    setError(null)
    const beforeIds = new Set(models.map((model) => model.id))
    const harnesses = new Set(selectedGroup.sources
      .filter((source): source is Extract<ProviderSource, { kind: "builtin" }> => source.kind === "builtin")
      .map((source) => source.view.harnessIds[0]!))
    const customResults = await Promise.all([
      // builtin:refresh=true 绕过全部缓存强制重新发现
      ...[...harnesses].map((harnessId) => discoverCatalog(harnessId, true)),
      ...selectedGroup.sources
        .filter((source): source is Extract<ProviderSource, { kind: "custom" }> => source.kind === "custom")
        .map(refreshCustom),
    ])
    // 反馈收口:builtin 从刷新后的 store 快照 diff 新增数、读发现失败;
    // custom 用 refreshCustom 的返回。任一部分失败都如实展示,不谎报成功。
    let added = 0
    const failures: string[] = []
    for (const harnessId of harnesses) {
      for (const provider of providerCatalogSnapshot(harnessId, "")) {
        if (!selectedGroup.sources.some((source) => source.id === provider.id)) continue
        if (provider.modelDiscovery === "failed") {
          failures.push(provider.discoveryError ?? t("providers.discoveryFailed"))
          continue
        }
        for (const list of Object.values(provider.models)) {
          for (const model of list ?? []) {
            if (!beforeIds.has(model.id)) added += 1
          }
        }
      }
    }
    for (const result of customResults) {
      if (result && typeof result === "object" && "added" in result) added += result.added
      if (result && typeof result === "object" && "error" in result) failures.push(result.error)
    }
    if (failures.length > 0) {
      setError(failures[0])
    } else if (harnesses.size > 0 || customResults.length > 0) {
      toast.success(added > 0 ? t("providers.refreshedAdded", { count: added }) : t("providers.refreshNoNew"))
    }
    setRefreshing(false)
  }

  async function toggleBuiltinAuth(provider: Extract<ProviderSource, { kind: "builtin" }>) {
    if (!window.bento) return
    setConnecting(true)
    setError(null)
    const result = provider.connected
      ? await window.bento.oauthLogout(provider.id)
      : await window.bento.oauthLogin(provider.id)
    if ("error" in result) {
      setError(result.error)
    } else {
      toast.success(provider.connected ? t("providers.disconnected", { name: provider.name }) : t("providers.connected", { name: provider.name }))
    }
    setConnecting(false)
  }

  function onWizardSaved(providerId?: string) {
    const wasEditing = editing !== null
    setWizardOpen(false)
    setEditing(null)
    if (providerId) {
      setSelectedId(providerFamilyId(providerId.replace(/^user-/, "")))
    }
    toast.success(wasEditing ? t("providers.savedChanges") : t("providers.providerAdded"))
  }

  if (!desktop) {
    return (
      <div className="grid min-h-80 place-items-center rounded-xl border border-border text-center">
        <div>
          <p className="text-sm font-medium">{t("providers.requiresDesktopTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("providers.requiresDesktopDesc")}</p>
        </div>
      </div>
    )
  }

  const pageReady = loaded && catalogLoaded

  return (
    <>
      <div className="flex h-[calc(100vh-9rem)] min-h-[560px] max-h-[760px] overflow-hidden rounded-xl border border-border bg-background">
        {!pageReady ? (
          <ProvidersSkeleton />
        ) : (
          <>
        <aside className="flex w-64 min-w-0 shrink-0 flex-col border-r border-border">
          <div className="flex h-12 items-center justify-between border-b border-border px-4 text-xs text-muted-foreground">
            <span>{t("providers.myProviders")}</span>
            <span className="tabular-nums">{groups.length}</span>
          </div>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="w-0 min-w-full p-2">
              {groups.map((group) => {
                const sourceLabels = [...new Set(group.sources.map((source) => sourceTabLabel(source, t)))]
                const sourceSummary = sourceLabels.length > 2
                  ? t("providers.sourceCount", { count: sourceLabels.length })
                  : sourceLabels.join(" + ")
                const connected = group.sources.some((source) => source.connected)
                const modelCount = groupModelCount(group)
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(group.id)
                      setQuery("")
                      setError(null)
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedGroup?.id === group.id && "bg-muted",
                    )}
                  >
                    <ItemMark group={group} />
                    <span className="min-w-0 flex-1 overflow-hidden">
                      <span className="block truncate text-sm font-medium">{group.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t("providers.sourceModelSummary", { sources: sourceSummary, count: modelCount })}
                      </span>
                    </span>
                    <span className={cn("size-2 shrink-0 rounded-full bg-border", connected && "bg-[var(--app-ok)]")} />
                  </button>
                )
              })}
              {loaded && groups.length === 0 && (
                <div className="px-3 py-10 text-center">
                  <p className="text-xs text-muted-foreground">{t("providers.noProviders")}</p>
                  <p className="mt-1 text-xs text-muted-foreground/70">{t("providers.addOneBelow")}</p>
                  {importSources !== null && importSources.length > 0 && (
                    <button
                      type="button"
                      className="mt-2 block w-full text-xs text-foreground underline underline-offset-4"
                      onClick={() => { setEditing(null); setWizardStartStep("detect"); setWizardOpen(true) }}
                    >
                      {t("providers.importFromLocal", { sources: importSources.join(" / ") })}
                    </button>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="border-t border-border p-3">
            <Button className="w-full" onClick={() => { setEditing(null); setWizardOpen(true) }}>
              <Plus />{t("providers.addProvider")}
            </Button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {selectedGroup ? (
            <>
              <header className="flex min-h-24 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-6 py-3">
                <ItemMark group={selectedGroup} large />
                <div className="min-w-40 flex-1">
                  <h2 className="truncate text-lg font-semibold">{selectedGroup.name}</h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {selectedGroup.sources.map((source) => (
                      <span
                        key={source.id}
                        className="whitespace-nowrap rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {sourceTabLabel(source, t)}
                      </span>
                    ))}
                    <span className="ml-1 whitespace-nowrap text-xs text-muted-foreground">
                      {t("providers.statusSummary", {
                        status: selectedGroup.sources.some((source) => source.connected) ? t("providers.available") : t("providers.notConnected"),
                        count: models.filter((model) => model.enabled !== false).length,
                      })}
                    </span>
                  </div>
                </div>
                {builtinSource ? (
                  <>
                    {builtinSource.connected && (
                      <Button variant="outline" disabled={refreshing} onClick={() => void refreshSelectedGroup()}>
                        <RefreshCw className={cn(refreshing && "animate-spin")} />{t("providers.refreshModels")}
                      </Button>
                    )}
                    <Button variant={builtinSource.connected ? "outline" : "default"} disabled={connecting} onClick={() => void toggleBuiltinAuth(builtinSource)}>
                      {connecting && <Loader2 className="animate-spin" />}{builtinSource.connected ? t("providers.disconnect") : t("providers.login")}
                    </Button>
                  </>
                ) : customSource ? (
                  <Button variant="outline" disabled={refreshing} onClick={() => void refreshSelectedGroup()}>
                    <RefreshCw className={cn(refreshing && "animate-spin")} />{t("providers.refreshModels")}
                  </Button>
                ) : (
                  <Button variant="outline" disabled={refreshing} onClick={() => void refreshSelectedGroup()}>
                    <RefreshCw className={cn(refreshing && "animate-spin")} />{t("providers.redetect")}
                  </Button>
                )}
                {customSource && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={t("providers.moreActions")}><MoreHorizontal /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => { setEditing(customSource.entry); setWizardOpen(true) }}>{t("providers.editProvider")}</DropdownMenuItem>
                      {customSource.entry.docsUrl && (
                      <DropdownMenuItem asChild><a href={customSource.entry.docsUrl} target="_blank" rel="noreferrer">{t("providers.integrationDocs")}</a></DropdownMenuItem>
                      )}
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(customSource.entry)}>{t("providers.deleteProvider")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </header>

              <div className="flex items-center gap-4 border-b border-border px-6 py-4">
                <div className="relative max-w-md flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("providers.searchModels")} className="pl-8" />
                </div>
                {models.length > 0 && (
                  <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {t("providers.showAll")}
                    <Switch
                      checked={allEnabled}
                      onCheckedChange={(checked) => toggleGroupModel(null, checked)}
                    />
                  </label>
                )}
              </div>

              {error && <p className="border-b border-border px-6 py-2 text-xs text-destructive">{error}</p>}
              <ScrollArea className="min-h-0 flex-1">
                <div className="divide-y divide-border px-6">
                  {visibleModels.map((model) => (
                    <div key={model.key} className={cn("grid min-h-16 items-center gap-4 py-2", hasContext ? "grid-cols-[minmax(0,1fr)_80px_44px]" : "grid-cols-[minmax(0,1fr)_44px]")}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{model.name}</p>
                        {model.name !== model.id && <p className="mt-0.5 truncate text-xs text-muted-foreground">{model.id}</p>}
                      </div>
                      {hasContext && <span className="text-right text-sm tabular-nums text-muted-foreground">{contextLabel(model.contextWindow)}</span>}
                      <Switch
                        checked={model.enabled !== false}
                        aria-label={t("providers.showModel", { name: model.name })}
                        onCheckedChange={(checked) => toggleGroupModel(model, checked)}
                      />
                    </div>
                  ))}
                  {visibleModels.length === 0 && (
                    <div className="py-16 text-center">
                      <p className="text-sm text-muted-foreground">{query ? t("providers.noMatchingModels") : t("providers.noModels")}</p>
                      {!query && customSource && (
                        <Button variant="outline" size="sm" className="mt-3" disabled={refreshing} onClick={() => void refreshSelectedGroup()}>
                          <RefreshCw className={cn(refreshing && "animate-spin")} />{t("providers.refreshModels")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="grid flex-1 place-items-center">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">{t("providers.emptyAddProvider")}</p>
                <Button className="mt-3" onClick={() => { setEditing(null); setWizardOpen(true) }}>
                  <Plus />{t("providers.addProvider")}
                </Button>
              </div>
            </div>
          )}
        </main>
          </>
        )}
      </div>

      <ProviderWizard
        open={pageReady && wizardOpen}
        startStep={wizardStartStep}
        onOpenChange={(open) => {
          setWizardOpen(open)
          if (!open) { setEditing(null); setWizardStartStep(null); consumeAddProviderIntent() }
        }}
        editing={editing}
        onSaved={onWizardSaved}
      />

      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("providers.deleteTitle", { name: deleting?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {usingCount
                ? t("providers.deleteDescInUse", { count: usingCount })
                : t("providers.deleteDesc")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t("providers.cancel")}</Button>
            <Button variant="destructive" onClick={async () => {
              if (!deleting) return
              const result = await deleteCustomProvider(deleting.id)
              if (result.error) {
                toast.error(t("providers.deleteFailed", { error: result.error }))
              } else {
                setDeleting(null)
                toast.success(t("providers.deleted", { name: deleting.name }))
              }
            }}>{t("providers.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
