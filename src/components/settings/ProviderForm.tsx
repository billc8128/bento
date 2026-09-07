/**
 * 自定义端点表单(向导第二步,也是编辑态本体)。
 * 默认只呈现一份统一配置:名称、API Key、Base URL、模型清单——底层按 harness
 * 展开的 runtimes 状态不变,统一字段是「写到所有启用 harness」的透镜。
 * 各 harness 配置出现分歧(手动分别改过)时,「按 Harness 分别配置」自动展开。
 * key 只写不读:编辑态 placeholder「已设置,留空则不修改」。保存不强制拉取通过。
 */

import { useEffect, useRef, useState } from "react"
import { ChevronRight, Loader2, LogIn, Plus, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getHarness } from "@/core/harness"
import {
  USER_PROVIDER_ID_RE,
  type CustomHarnessId,
  type CustomModelConfig,
  type CustomProviderConfig,
  type WireProtocol,
} from "@/core/provider"
import { EFFORTS, type Effort } from "@/core/types"
import { saveCustomProvider, type CustomProviderEntry } from "@/lib/custom-provider-store"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

import { CUSTOM_HARNESSES, describeFetchError, HARNESS_PROTOCOLS, PROTOCOL_LABELS } from "./labels"

/** 自定义模型的推理档位固定给低/中/高三档(上游接不接只有用户知道,不给 off/auto/max) */
const REASONING_EFFORTS: Effort[] = ["low", "medium", "high"]

type ModelRow = {
  id: string
  name: string
  reasoning: boolean
  defaultEffort: Effort
  /** 停用 = 不进最终 models 清单 */
  disabled: boolean
  /** 本次表单会话里手填的条目(来源不持久化,重开编辑不带角标) */
  manual: boolean
}

type RuntimeFormState = {
  enabled: boolean
  wireProtocol: WireProtocol
  baseUrl: string
  requestPath: string
  modelsUrl: string
  discoveryParser: "openai-list" | "anthropic-list" | "fireworks-list" | "ollama-tags"
  authHeader: string
  authPrefix: string
  fixedHeaders: string
  apiKey: string
  hasKey: boolean
  models: ModelRow[]
  fetching: boolean
  fetched: boolean
  fetchError: string | null
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function toRow(model: CustomModelConfig, manual: boolean): ModelRow {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning === true,
    defaultEffort: model.defaultEffort ?? "medium",
    disabled: model.enabled === false,
    manual,
  }
}

function emptyRuntime(enabled: boolean, wireProtocol: WireProtocol): RuntimeFormState {
  return {
    enabled,
    wireProtocol,
    baseUrl: "",
    requestPath: "",
    modelsUrl: "",
    discoveryParser: "openai-list",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    fixedHeaders: "",
    apiKey: "",
    hasKey: false,
    models: [],
    fetching: false,
    fetched: false,
    fetchError: null,
  }
}

function initRuntimes(
  editing: CustomProviderEntry | undefined,
  customProtocol: WireProtocol,
): Record<CustomHarnessId, RuntimeFormState> {
  const runtimes = {} as Record<CustomHarnessId, RuntimeFormState>
  for (const agent of CUSTOM_HARNESSES) {
    const existing = editing?.runtimes[agent]
    if (existing) {
      runtimes[agent] = {
        ...emptyRuntime(true, existing.wireProtocol ?? HARNESS_PROTOCOLS[agent][0]),
        baseUrl: existing.baseUrl ?? "",
        requestPath: existing.requestPath ?? "",
        modelsUrl: existing.modelsUrl ?? "",
        discoveryParser: existing.discoveryParser ?? "openai-list",
        authHeader: existing.auth?.inference.header ?? (existing.wireProtocol === "anthropic-messages" ? "x-api-key" : "Authorization"),
        authPrefix: existing.auth?.inference.prefix ?? (existing.wireProtocol === "anthropic-messages" ? "" : "Bearer "),
        fixedHeaders: existing.auth?.inference.fixedHeaders
          ? JSON.stringify(existing.auth.inference.fixedHeaders, null, 2)
          : "",
        hasKey: existing.hasKey,
        // 防御:老版本 main 的 list 曾把 runtimes 压成只剩 hasKey,models 可能缺
        models: (existing.models ?? []).map((model) => toRow(model, false)),
      }
    } else if (editing) {
      runtimes[agent] = emptyRuntime(false, HARNESS_PROTOCOLS[agent][0])
    } else {
      const protocol = HARNESS_PROTOCOLS[agent].includes(customProtocol)
        ? customProtocol
        : HARNESS_PROTOCOLS[agent][0]
      runtimes[agent] = emptyRuntime(HARNESS_PROTOCOLS[agent].includes(customProtocol), protocol)
    }
  }
  return runtimes
}

export function ProviderForm({
  custom = false,
  editing,
  onCancel,
  onSaved,
}: {
  custom?: boolean
  editing?: CustomProviderEntry
  onCancel: () => void
  /** 保存成功回传 provider id。 */
  onSaved: (providerId?: string) => void
}) {
  const { t } = useT()
  const [name, setName] = useState(editing?.name ?? "")
  const [slug, setSlug] = useState(editing ? editing.id.replace(/^user-/, "") : "")
  const [slugTouched, setSlugTouched] = useState(false)
  const [customProtocol, setCustomProtocol] = useState<WireProtocol>("anthropic-messages")
  const [runtimes, setRuntimes] = useState(() => initRuntimes(editing, "anthropic-messages"))
  const oauthDescriptor = editing?.auth.method === "oauth"
    ? editing.auth.oauth
    : undefined
  const [authMethod, setAuthMethod] = useState<"none" | "apiKey" | "oauth">(
    editing?.auth.method ?? "apiKey",
  )
  const [authorized, setAuthorized] = useState(editing?.hasCredential ?? false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [manualId, setManualId] = useState("")
  const [manualName, setManualName] = useState("")
  const [modelQuery, setModelQuery] = useState("")

  const enabled = CUSTOM_HARNESSES.filter((agent) => runtimes[agent].enabled)
  const first = enabled[0]

  // 各 harness 是否已分歧(baseUrl 或模型清单不同):分歧时统一清单不代表全貌,展开分别配置
  const divergent = enabled.length > 1 && enabled.some((agent) => {
    const a = runtimes[agent]
    const b = runtimes[first]
    if (a.baseUrl !== b.baseUrl) return true
    const idsA = a.models.map((row) => row.id).join("")
    const idsB = b.models.map((row) => row.id).join("")
    return idsA !== idsB
  })
  const [perHarnessOpen, setPerHarnessOpen] = useState(() => {
    if (!editing) return false
    const list = CUSTOM_HARNESSES.filter((agent) => editing.runtimes[agent])
    return list.length > 1 && list.some((agent) => {
      const a = editing.runtimes[agent]
      const b = editing.runtimes[list[0]]
      if (!a || !b) return false
      if (a.baseUrl !== b.baseUrl) return true
      return (a.models ?? []).map((model) => model.id).join("") !== (b.models ?? []).map((model) => model.id).join("")
    })
  })

  function patchRuntime(agent: CustomHarnessId, partial: Partial<RuntimeFormState>) {
    setRuntimes((prev) => ({ ...prev, [agent]: { ...prev[agent], ...partial } }))
  }

  /** 统一透镜:把同一份修改写到所有启用的 harness。 */
  function patchAll(partial: Partial<RuntimeFormState> | ((runtime: RuntimeFormState) => Partial<RuntimeFormState>)) {
    setRuntimes((prev) => {
      const next = { ...prev }
      for (const agent of CUSTOM_HARNESSES) {
        if (!next[agent].enabled) continue
        next[agent] = { ...next[agent], ...(typeof partial === "function" ? partial(next[agent]) : partial) }
      }
      return next
    })
  }

  function patchRowAll(modelId: string, partial: Partial<ModelRow>) {
    patchAll((runtime) => ({
      models: runtime.models.map((row) => (row.id === modelId ? { ...row, ...partial } : row)),
    }))
  }

  function onNameChange(value: string) {
    setName(value)
    if (!editing && !slugTouched) setSlug(slugify(value))
  }

  function onCustomProtocolChange(protocol: WireProtocol) {
    setCustomProtocol(protocol)
    setRuntimes((prev) => {
      const next = { ...prev }
      for (const agent of CUSTOM_HARNESSES) {
        const supported = HARNESS_PROTOCOLS[agent].includes(protocol)
        next[agent] = {
          ...prev[agent],
          enabled: supported,
          wireProtocol: supported ? protocol : prev[agent].wireProtocol,
        }
      }
      return next
    })
  }

  const shared = first ? runtimes[first] : undefined

  async function fetchAll() {
    const bento = window.bento
    if (!bento || !shared || !first) return
    const baseUrl = shared.baseUrl.trim().replace(/\/+$/, "")
    if (!/^https?:\/\//.test(baseUrl)) {
      patchAll({ fetchError: t("providers.errorBaseUrlFirst") })
      return
    }
    if (authMethod === "apiKey" && !shared.apiKey.trim() && !editing?.hasCredential) {
      patchAll({ fetchError: t("providers.errorApiKeyFirst") })
      return
    }
    patchAll({ fetching: true, fetchError: null })
    const result = await bento.fetchProviderModels({
      ...(editing ? { providerId: editing.id } : {}),
      modelsUrl: shared.modelsUrl.trim() || `${baseUrl}/models`,
      ...(shared.apiKey.trim() ? { apiKey: shared.apiKey.trim() } : {}),
      agent: first,
      ...(authMethod === "apiKey"
        ? {
            auth: {
              header: shared.authHeader.trim() || "Authorization",
              ...(shared.authPrefix ? { prefix: shared.authPrefix } : {}),
            },
          }
        : {}),
      parser: shared.discoveryParser,
    })
    if ("ok" in result && result.ok) {
      // additions-only:已有条目的标记不动,只补新 id;同一份清单合并进每个启用的 harness
      patchAll((runtime) => {
        const known = new Set(runtime.models.map((row) => row.id))
        const added = result.models.filter((model) => !known.has(model.id)).map((model) => toRow(model, false))
        return { fetching: false, fetched: true, models: [...runtime.models, ...added] }
      })
    } else {
      patchAll({ fetching: false, fetchError: describeFetchError(result, t) })
    }
  }

  const fetchAllRef = useRef(fetchAll)
  useEffect(() => {
    fetchAllRef.current = fetchAll
  })

  // 新建自定义端点:Base URL(和 key)填好后防抖自动拉一次;失败不重复烦用户
  const lastAutoFetch = useRef<string | null>(null)
  useEffect(() => {
    if (editing || authMethod === "oauth" || !shared) return
    if (shared.fetched || shared.fetching) return
    const baseUrl = shared.baseUrl.trim()
    if (!/^https?:\/\//.test(baseUrl)) return
    const signature = `${baseUrl}|${shared.apiKey.trim()}`
    if (lastAutoFetch.current === signature) return
    const timer = setTimeout(() => {
      lastAutoFetch.current = signature
      void fetchAllRef.current()
    }, 800)
    return () => clearTimeout(timer)
  }, [editing, authMethod, shared])

  function addManualModel() {
    if (!shared) return
    const id = manualId.trim()
    if (!id) return
    if (shared.models.some((row) => row.id === id)) {
      patchAll({ fetchError: t("providers.modelInList", { id }) })
      return
    }
    const row: ModelRow = { id, name: manualName.trim() || id, reasoning: false, defaultEffort: "medium", disabled: false, manual: true }
    patchAll((runtime) => ({
      models: runtime.models.some((existing) => existing.id === id) ? runtime.models : [...runtime.models, { ...row }],
      fetchError: null,
    }))
    setManualId("")
    setManualName("")
  }

  function buildConfig(): { config?: CustomProviderConfig; keys?: Record<string, string>; error?: string; advanced?: boolean } {
    const trimmedName = name.trim()
    if (!trimmedName) return { error: t("providers.errorNameRequired") }
    if (trimmedName.length > 60) return { error: t("providers.errorNameTooLong") }
    let id = editing?.id
    if (!id) {
      // 纯中文名 slugify 后为空:静默兜底一个随机标识,不拿实现细节烦用户
      const slugValue = slug.trim() || `p-${Math.random().toString(36).slice(2, 8)}`
      id = `user-${slugValue}`
      if (!USER_PROVIDER_ID_RE.test(id)) return { error: t("providers.errorIdChars"), advanced: true }
    }
    if (authMethod === "oauth" && !oauthDescriptor) return { error: t("providers.errorOAuthPreset") }
    const config: CustomProviderConfig = {
      schemaVersion: 2,
      runtimePolicy: editing?.runtimePolicy ?? "custom",
      ...(editing?.presetId ? { presetId: editing.presetId } : {}),
      ...(editing?.docsUrl ? { docsUrl: editing.docsUrl } : {}),
      id,
      name: trimmedName,
      auth: authMethod === "oauth"
        ? { method: "oauth", oauth: oauthDescriptor! }
        : authMethod === "none" ? { method: "none" } : { method: "apiKey" },
      runtimes: {},
    }
    const keys: Record<string, string> = {}
    for (const agent of CUSTOM_HARNESSES) {
      const runtime = runtimes[agent]
      if (!runtime.enabled) continue
      const baseUrl = runtime.baseUrl.trim().replace(/\/+$/, "")
      if (!/^https?:\/\//.test(baseUrl)) {
        return { error: enabled.length > 1 ? t("providers.errorBaseUrlHarness", { name: getHarness(agent).name }) : t("providers.errorBaseUrl"), advanced: true }
      }
      // 去重非空:停用与空 id/重复 id 的条目直接不进清单
      const seen = new Set<string>()
      const models: CustomModelConfig[] = []
      for (const row of runtime.models) {
        const modelId = row.id.trim()
        if (!modelId || seen.has(modelId)) continue
        seen.add(modelId)
        models.push({
          id: modelId,
          name: row.name.trim() || modelId,
          enabled: !row.disabled,
          ...(row.reasoning
            ? { reasoning: true, reasoningEfforts: REASONING_EFFORTS, defaultEffort: row.defaultEffort }
            : {}),
        })
      }
      if (models.length === 0) {
        return { error: enabled.length > 1 ? t("providers.errorNeedModelHarness", { name: getHarness(agent).name }) : t("providers.errorNeedModel") }
      }
      let fixedHeaders: Record<string, string> | undefined
      if (runtime.fixedHeaders.trim()) {
        try {
          const parsed = JSON.parse(runtime.fixedHeaders) as unknown
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
            Object.values(parsed).some((value) => typeof value !== "string")) {
            return { error: t("providers.errorHeadersType"), advanced: true }
          }
          fixedHeaders = parsed as Record<string, string>
        } catch {
          return { error: t("providers.errorHeadersJson"), advanced: true }
        }
      }
      config.runtimes[agent] = {
        baseUrl,
        wireProtocol: runtime.wireProtocol,
        ...(runtime.requestPath ? { requestPath: runtime.requestPath } : {}),
        ...(runtime.modelsUrl.trim() ? { modelsUrl: runtime.modelsUrl.trim().replace(/\/+$/, "") } : {}),
        discoveryParser: runtime.discoveryParser,
        ...(authMethod === "apiKey"
          ? {
              auth: {
                inference: {
                  header: runtime.authHeader.trim() || "Authorization",
                  ...(runtime.authPrefix ? { prefix: runtime.authPrefix } : {}),
                  ...(fixedHeaders ? { fixedHeaders } : {}),
                },
              },
            }
          : {}),
        models,
      }
      if (authMethod === "apiKey" && runtime.apiKey.trim()) keys[agent] = runtime.apiKey.trim()
    }
    if (Object.keys(config.runtimes).length === 0) return { error: t("providers.errorEnableHarness") }
    if (config.runtimePolicy === "preset") {
      config.disabledHarnesses = CUSTOM_HARNESSES.filter((agent) => !runtimes[agent].enabled)
    }
    return { config, keys }
  }

  async function save() {
    const built = buildConfig()
    if (built.error || !built.config) {
      setError(built.error ?? t("providers.errorIncomplete"))
      // 校验落在高级设置字段时自动展开(原按文案正则判定,i18n 后改为结构化标记)
      if (built.advanced) setAdvancedOpen(true)
      return
    }
    setSaving(true)
    setError(null)
    const { error: saveError } = await saveCustomProvider(built.config, built.keys)
    setSaving(false)
    if (saveError) {
      setError(saveError)
      return
    }
    onSaved(built.config.id)
  }

  async function loginOAuth() {
    const built = buildConfig()
    if (built.error || !built.config) {
      setError(built.error ?? t("providers.errorIncomplete"))
      return
    }
    const bento = window.bento
    if (!bento) return
    setLoggingIn(true)
    setError(null)
    const saved = await saveCustomProvider(built.config)
    if (saved.error) {
      setLoggingIn(false)
      setError(saved.error)
      return
    }
    const result = await bento.oauthLogin(built.config.id)
    setLoggingIn(false)
    if ("error" in result) {
      setError(result.error)
      return
    }
    setAuthorized(true)
  }

  const mq = modelQuery.trim().toLowerCase()
  const visibleRows = shared
    ? mq ? shared.models.filter((row) => `${row.name} ${row.id}`.toLowerCase().includes(mq)) : shared.models
    : []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-5">
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">{t("providers.nameLabel")}</span>
            <Input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder={t("providers.namePlaceholder")} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{t("providers.authMethod")}</span>
              <Select value={authMethod} onValueChange={(value) => setAuthMethod(value as "none" | "apiKey" | "oauth")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="apiKey">API Key</SelectItem>
                  <SelectItem value="none">{t("providers.authNone")}</SelectItem>
                  <SelectItem value="oauth" disabled={!oauthDescriptor}>{t("providers.oauthSubscription")}</SelectItem>
                </SelectContent>
              </Select>
            </label>

            {custom && (
              <label className="space-y-1.5">
                <span className="text-xs text-muted-foreground">{t("providers.wireProtocol")}</span>
                <Select value={customProtocol} onValueChange={(value) => onCustomProtocolChange(value as WireProtocol)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROTOCOL_LABELS) as WireProtocol[]).map((protocol) => (
                      <SelectItem key={protocol} value={protocol}>
                        {PROTOCOL_LABELS[protocol]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
          </div>

          {authMethod === "oauth" ? (
            <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2.5">
              <span className="text-xs text-muted-foreground">
                {authorized ? t("providers.oauthAuthorizedHint") : t("providers.oauthLoginHint")}
              </span>
              <Button
                type="button"
                size="sm"
                variant={authorized ? "outline" : "default"}
                disabled={loggingIn}
                onClick={() => void loginOAuth()}
                className="gap-1.5"
              >
                {loggingIn ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                {authorized ? t("providers.oauthRefresh") : t("providers.login")}
              </Button>
            </div>
          ) : (
            <>
              {authMethod === "apiKey" && shared && (
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">API Key</span>
                  <Input
                    type="password"
                    value={shared.apiKey}
                    onChange={(event) => patchAll({ apiKey: event.target.value })}
                    placeholder={enabled.some((agent) => runtimes[agent].hasKey) ? t("providers.keySetPlaceholder") : "sk-…"}
                    autoComplete="off"
                  />
                </label>
              )}

              {shared && (
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">Base URL</span>
                  <Input
                    value={shared.baseUrl}
                    onChange={(event) => patchAll({ baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
              )}
            </>
          )}

          {/* 统一模型清单:拉取 + 列表 + 手填,只出现一次 */}
          {authMethod !== "oauth" && shared && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={shared.fetching}
                  onClick={() => void fetchAll()}
                  className="gap-1.5"
                >
                  {shared.fetching ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {shared.models.length > 0 ? t("providers.refreshModels") : t("providers.fetchModels")}
                </Button>
                {shared.fetched && !shared.fetchError && (
                  <span className="type-micro text-muted-foreground">{t("providers.mergedHint")}</span>
                )}
                {divergent && (
                  <span className="type-micro text-muted-foreground">{t("providers.divergentHint")}</span>
                )}
              </div>
              {shared.fetchError && <p className="text-xs text-destructive">{shared.fetchError}</p>}

              {shared.models.length > 8 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t("providers.searchInList")} className="h-8 pl-8 text-xs" />
                </div>
              )}

              {shared.models.length > 0 && (
                <div className="space-y-1.5">
                  {visibleRows.map((row) => (
                    <div
                      key={row.id}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5",
                        row.disabled && "opacity-45",
                      )}
                    >
                      <Checkbox
                        checked={!row.disabled}
                        onCheckedChange={(value) => patchRowAll(row.id, { disabled: value !== true })}
                        aria-label={t("providers.enableModel", { id: row.id })}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs" title={row.id}>
                        {row.name}
                      </span>
                      {row.manual && (
                        <Badge variant="outline" className="px-1 py-0 type-micro font-normal">
                          {t("providers.manualBadge")}
                        </Badge>
                      )}
                      <label className="flex shrink-0 items-center gap-1 type-micro text-muted-foreground">
                        <Checkbox
                          checked={row.reasoning}
                          onCheckedChange={(value) => patchRowAll(row.id, { reasoning: value === true })}
                        />
                        {t("providers.reasoning")}
                      </label>
                      {row.reasoning && (
                        <Select
                          value={row.defaultEffort}
                          onValueChange={(value) => patchRowAll(row.id, { defaultEffort: value as Effort })}
                        >
                          <SelectTrigger className="h-6 w-14 px-1.5 type-micro">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {REASONING_EFFORTS.map((effort) => {
                              const meta = EFFORTS.find((item) => item.id === effort)
                              return (
                                <SelectItem key={effort} value={effort} className="text-xs">
                                  {meta ? t(meta.labelKey) : effort}
                                </SelectItem>
                              )
                            })}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ))}
                  {visibleRows.length === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">{t("providers.noMatchingModels")}</p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Input
                  value={manualId}
                  onChange={(event) => setManualId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addManualModel()
                    }
                  }}
                  placeholder={t("providers.manualIdPlaceholder")}
                  className="h-8 flex-1 text-xs"
                />
                <Input
                  value={manualName}
                  onChange={(event) => setManualName(event.target.value)}
                  placeholder={t("providers.displayNameOptional")}
                  className="h-8 w-32 text-xs"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-8 shrink-0"
                  onClick={addManualModel}
                  aria-label={t("providers.addModel")}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* 高级设置:默认收起;校验打到这里的字段时自动展开 */}
          {authMethod !== "oauth" && shared && (
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ChevronRight className="size-3.5 transition-transform group-data-open:rotate-90" />
                {t("providers.advanced")}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                {!editing && (
                  <label className="block space-y-1">
                    <span className="type-micro text-muted-foreground">{t("providers.idLabel")}</span>
                    <div className="flex items-center">
                      <span className="rounded-l-md border border-r-0 border-input bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                        user-
                      </span>
                      <Input
                        value={slug}
                        onChange={(event) => {
                          setSlugTouched(true)
                          setSlug(event.target.value)
                        }}
                        placeholder="my-provider"
                        className="h-8 rounded-l-none text-xs"
                      />
                    </div>
                  </label>
                )}
                <label className="block space-y-1">
                  <span className="type-micro text-muted-foreground">{t("providers.modelsUrlLabel")}</span>
                  <Input
                    value={shared.modelsUrl}
                    onChange={(event) => patchAll({ modelsUrl: event.target.value })}
                    placeholder="https://api.example.com/v1/models"
                    className="h-8 text-xs"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="type-micro text-muted-foreground">{t("providers.requestPathLabel")}</span>
                  <Input
                    value={shared.requestPath}
                    onChange={(event) => patchAll({ requestPath: event.target.value })}
                    placeholder="/v1/messages"
                    className="h-8 text-xs"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="type-micro text-muted-foreground">{t("providers.modelListFormat")}</span>
                  <Select value={shared.discoveryParser} onValueChange={(value) => patchAll({ discoveryParser: value as RuntimeFormState["discoveryParser"] })}>
                    <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai-list">OpenAI List</SelectItem>
                      <SelectItem value="anthropic-list">Anthropic List</SelectItem>
                      <SelectItem value="fireworks-list">Fireworks List</SelectItem>
                      <SelectItem value="ollama-tags">Ollama Tags</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                {authMethod === "apiKey" && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="type-micro text-muted-foreground">{t("providers.authHeader")}</span>
                      <Input value={shared.authHeader} onChange={(event) => patchAll({ authHeader: event.target.value })} className="h-8 text-xs" />
                    </label>
                    <label className="space-y-1">
                      <span className="type-micro text-muted-foreground">{t("providers.valuePrefix")}</span>
                      <Input value={shared.authPrefix} onChange={(event) => patchAll({ authPrefix: event.target.value })} placeholder="Bearer " className="h-8 text-xs" />
                    </label>
                    <label className="col-span-2 space-y-1">
                      <span className="type-micro text-muted-foreground">{t("providers.customHeaders")}</span>
                      <Textarea value={shared.fixedHeaders} onChange={(event) => patchAll({ fixedHeaders: event.target.value })} placeholder={'{"anthropic-version":"2023-06-01"}'} className="min-h-16 font-mono text-xs" />
                    </label>
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* 逃生舱:每个 harness 的独立配置(分歧时自动展开) */}
          {enabled.length > 1 && (
            <Collapsible open={perHarnessOpen} onOpenChange={setPerHarnessOpen}>              <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ChevronRight className="size-3.5 transition-transform group-data-open:rotate-90" />
                {t("providers.perHarness")}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-3">
                {enabled.map((agent) => {
                  const runtime = runtimes[agent]
                  const allowedProtocols = HARNESS_PROTOCOLS[agent]
                  return (
                    <section key={agent} className="space-y-2 rounded-lg border border-border p-3">
                      <p className="text-xs font-medium">{getHarness(agent).name}</p>
                      <label className="block space-y-1">
                        <span className="type-micro text-muted-foreground">Base URL</span>
                        <Input
                          value={runtime.baseUrl}
                          onChange={(event) => patchRuntime(agent, { baseUrl: event.target.value })}
                          className="h-8 text-xs"
                        />
                      </label>
                      {authMethod === "apiKey" && (
                        <label className="block space-y-1">
                          <span className="type-micro text-muted-foreground">API Key</span>
                          <Input
                            type="password"
                            value={runtime.apiKey}
                            onChange={(event) => patchRuntime(agent, { apiKey: event.target.value })}
                            placeholder={runtime.hasKey ? t("providers.keySetPlaceholder") : "sk-…"}
                            autoComplete="off"
                            className="h-8 text-xs"
                          />
                        </label>
                      )}
                      {allowedProtocols.length > 1 && (
                        <label className="block space-y-1">
                          <span className="type-micro text-muted-foreground">{t("providers.wireProtocol")}</span>
                          <Select
                            value={runtime.wireProtocol}
                            onValueChange={(value) => patchRuntime(agent, { wireProtocol: value as WireProtocol })}
                          >
                            <SelectTrigger className="h-8 w-full text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {allowedProtocols.map((protocol) => (
                                <SelectItem key={protocol} value={protocol} className="text-xs">
                                  {PROTOCOL_LABELS[protocol]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      )}
                      <p className="type-micro text-muted-foreground">
                        {t("providers.harnessModelCount", { count: runtime.models.length })}
                      </p>
                    </section>
                  )
                })}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </ScrollArea>

      <footer className="flex items-center justify-between border-t border-border px-5 py-3">
        <p className={cn("type-micro", error ? "text-destructive" : "text-muted-foreground/80")}>
          {error ?? (authMethod === "oauth" ? t("providers.oauthTokenHint") : t("providers.autoFetchHint"))}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("providers.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("providers.save")}
          </Button>
        </div>
      </footer>
    </div>
  )
}
