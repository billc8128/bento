import { useEffect, useMemo, useRef, useState } from "react"
import { ExternalLink, Eye, EyeOff, Loader2, Plus, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import type { CustomModelConfig } from "@/core/provider"
import type { ProviderPreset } from "@/core/provider-preset"
import { getHarness } from "@/core/harness"
import type { CustomProviderEntry } from "@/lib/custom-provider-store"

type SelectableModel = CustomModelConfig & { enabled: boolean }

function initialModels(preset: ProviderPreset, editing?: CustomProviderEntry): SelectableModel[] {
  const source = editing
    ? Object.values(editing.runtimes).flatMap((runtime) => runtime?.models ?? [])
    : preset.modelDiscovery.method === "static" ? preset.modelDiscovery.models : []
  const seen = new Set<string>()
  return source.flatMap((model) => {
    if (seen.has(model.id)) return []
    seen.add(model.id)
    return [{ ...model, enabled: model.enabled !== false }]
  })
}

function contextLabel(value: number | undefined): string {
  if (!value) return "—"
  if (value >= 1_000_000) return `${value / 1_000_000}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export function PresetProviderForm({
  preset,
  editing,
  onCancel,
  onSaved,
}: {
  preset: ProviderPreset
  editing?: CustomProviderEntry
  onCancel: () => void
  /** 保存成功回传 provider id。 */
  onSaved: (providerId?: string) => void
}) {
  const [name, setName] = useState(editing?.name ?? preset.name)
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<SelectableModel[]>(() => initialModels(preset, editing))
  const [manualId, setManualId] = useState("")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fetched, setFetched] = useState(models.length > 0)
  const [error, setError] = useState<string | null>(null)
  const needsKey = preset.auth.method === "apiKey"
  const hasCredential = editing?.hasCredential === true
  const allEnabled = models.length > 0 && models.every((model) => model.enabled)
  const selectedCount = useMemo(() => models.filter((model) => model.enabled).length, [models])
  const canConnect = !needsKey || hasCredential || Boolean(apiKey.trim())
  const canSave = Boolean(name.trim()) && canConnect && selectedCount > 0
  const q = query.trim().toLowerCase()
  const visibleModels = q ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(q)) : models

  const loadingRef = useRef(false)

  async function discover() {
    const bento = window.bento
    if (!bento || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    const result = await bento.discoverPresetModels({
      presetId: preset.id,
      ...(editing ? { providerId: editing.id } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    })
    loadingRef.current = false
    setLoading(false)
    if (!("ok" in result) || !result.ok) {
      setError("message" in result ? result.message : "无法获取模型列表")
      return
    }
    const previous = new Map(models.map((model) => [model.id, model]))
    setModels(result.models.map((model) => ({
      ...model,
      enabled: previous.get(model.id)?.enabled ?? true,
    })))
    setFetched(true)
  }

  const discoverRef = useRef(discover)
  useEffect(() => {
    discoverRef.current = discover
  })

  // 填入 key(或编辑态已有凭证)后防抖自动拉取;失败不对同一 key 重试,改了 key 再自动拉
  const lastAutoKey = useRef<string | null>(null)
  useEffect(() => {
    if (fetched || loading) return
    const key = apiKey.trim()
    const ready = needsKey ? key.length > 0 || hasCredential : true
    const signature = needsKey && hasCredential && !key ? "__saved__" : key
    if (!ready || lastAutoKey.current === signature) return
    const timer = setTimeout(() => {
      lastAutoKey.current = signature
      void discoverRef.current()
    }, 800)
    return () => clearTimeout(timer)
  }, [apiKey, fetched, loading, needsKey, hasCredential])

  function addManualModel() {
    const id = manualId.trim()
    if (!id) return
    if (models.some((model) => model.id === id)) {
      setError(`模型 ${id} 已经存在`)
      return
    }
    setModels((current) => [...current, { id, name: id, enabled: true }])
    setManualId("")
    setFetched(true)
    setError(null)
  }

  async function save() {
    const bento = window.bento
    if (!bento) return
    if (!name.trim()) {
      setError("请输入显示名称")
      return
    }
    if (models.length === 0) {
      setError("请先获取模型列表，或手动添加模型 ID")
      return
    }
    if (selectedCount === 0) {
      setError("至少展示一个模型")
      return
    }
    setSaving(true)
    setError(null)
    const result = await bento.savePresetProvider({
      presetId: preset.id,
      ...(editing ? { providerId: editing.id } : {}),
      name: name.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      models: models.map((model) => ({ ...model, enabled: model.enabled })),
    })
    setSaving(false)
    if (result.error) {
      setError(result.error)
      return
    }
    onSaved(result.config?.id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-5">
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">显示名称</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          {needsKey && (
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">API Key</span>
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={editing?.hasCredential ? "已保存，留空不修改" : "输入 API Key"}
                  className="pr-9"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey((visible) => !visible)}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </label>
          )}

          <div className="space-y-2 border-y border-border py-3 text-xs">
            {Object.entries(preset.runtimes).map(([harness, runtime]) => runtime && (
              <div key={harness} className="grid grid-cols-[92px_1fr] gap-3">
                <span className="text-muted-foreground">{getHarness(harness).name}</span>
                <span className="truncate" title={runtime.baseUrl}>{runtime.baseUrl}</span>
              </div>
            ))}
            <a
              href={preset.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              接入文档 <ExternalLink className="size-3" />
            </a>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={loading || !canConnect} onClick={() => void discover()}>
                {loading && <Loader2 className="animate-spin" />}
                {fetched ? "刷新模型" : "获取模型列表"}
              </Button>
              {models.length > 0 && (
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  全部展示
                  <Switch
                    checked={allEnabled}
                    onCheckedChange={(checked) => setModels((current) => current.map((model) => ({ ...model, enabled: checked })))}
                  />
                </label>
              )}
            </div>

            {models.length > 8 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在清单里搜索" className="h-8 pl-8 text-xs" />
              </div>
            )}

            {models.length > 0 && (
              <div className="divide-y divide-border border-y border-border">
                {visibleModels.map((model) => (
                  <div key={model.id} className="grid min-h-14 grid-cols-[minmax(0,1fr)_70px_44px] items-center gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{model.name}</p>
                      {model.name !== model.id && <p className="truncate text-xs text-muted-foreground">{model.id}</p>}
                    </div>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">{contextLabel(model.contextWindow)}</span>
                    <Switch
                      checked={model.enabled}
                      aria-label={`展示 ${model.name}`}
                      onCheckedChange={(checked) => setModels((current) => current.map((item) => item.id === model.id ? { ...item, enabled: checked } : item))}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Input
                value={manualId}
                onChange={(event) => setManualId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    addManualModel()
                  }
                }}
                placeholder="手动添加模型 ID"
              />
              <Button type="button" variant="outline" size="icon" onClick={addManualModel} aria-label="添加模型">
                <Plus />
              </Button>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </ScrollArea>

      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button disabled={saving || !canSave} onClick={() => void save()}>
          {saving && <Loader2 className="animate-spin" />}
          {editing ? "保存" : "添加"}
        </Button>
      </footer>
    </div>
  )
}
