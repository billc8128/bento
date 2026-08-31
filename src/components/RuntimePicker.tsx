/** Codex 式运行配置菜单：首层配置摘要，二层分别选择 Harness / 模型 / 推理强度。 */

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react"

import { HarnessIcon } from "@/components/HarnessIcon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HARNESSES, getHarness, type HarnessId } from "@/core/harness"
import {
  compactModelName,
  findProviderModel,
  modelsForProvider,
  providersForModelPicker,
  type ProviderModel,
  type ProviderView,
} from "@/core/provider"
import { EFFORTS, type Effort } from "@/core/types"
import { providersForActiveSession } from "@/lib/session-provider-filter"
import { openSettings } from "@/lib/settings-store"
import { cn } from "@/lib/utils"

export type RuntimeSelection = {
  harnessId: HarnessId
  providerId: string | null
  modelId: string | null
  effort: Effort
}

type RuntimePickerProps = {
  selection: RuntimeSelection
  providers: ProviderView[]
  onSelectFull: (selection: RuntimeSelection) => void
  onHarnessChange?: (harnessId: HarnessId) => void
  onEffortChange?: (effort: Effort) => void
  onDiscover?: (harnessId: HarnessId) => void
  session?: boolean
  modelLocked?: boolean
}

type UnifiedRow = { provider: ProviderView; model: ProviderModel }
type PickerView = "root" | "harness" | "model" | "effort"

const HARNESS_ORDER: HarnessId[] = ["pi", "codex", "claude-code", "kimi", "opencode", "omp", "hermes"]

export function RuntimePicker({
  selection,
  providers,
  onSelectFull,
  onHarnessChange,
  onEffortChange,
  onDiscover,
  session = false,
  modelLocked = false,
}: RuntimePickerProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<PickerView>("root")
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const rowRefs = useRef(new Map<number, HTMLButtonElement>())

  const harness = getHarness(selection.harnessId)
  const harnessOptions = HARNESS_ORDER.map((id) => HARNESSES.find((item) => item.id === id)!)
  const selectableProviders = useMemo(() => {
    const available = providersForModelPicker(providers, session ? undefined : selection.harnessId)
    if (!session) return available
    return providersForActiveSession(available, {
      harnessId: selection.harnessId,
      providerId: selection.providerId,
    })
  }, [providers, selection.harnessId, selection.providerId, session])
  const selectedModel = findProviderModel(
    selectableProviders,
    selection.providerId,
    selection.harnessId,
    selection.modelId,
  )
  const modelLabel = selectedModel ? compactModelName(selectedModel) : "选择模型"
  const effortLabel = EFFORTS.find((item) => item.id === selection.effort)?.label ?? selection.effort
  const canTuneEffort = Boolean(
    selectedModel && harness.effortSelection && selectedModel.reasoning !== false && onEffortChange,
  )
  const needle = query.trim().toLowerCase()
  const sections = useMemo(
    () => selectableProviders.flatMap((provider) => {
      if (!provider.connected) return []
      const rows = modelsForProvider(provider, selection.harnessId)
        .map((model) => ({ provider, model }))
        .filter((row) => !needle ||
          `${provider.name} ${row.model.name} ${row.model.id}`.toLowerCase().includes(needle))
      return rows.length > 0 ? [{ provider, rows }] : []
    }),
    [needle, selectableProviders, selection.harnessId],
  )
  const items = useMemo(() => sections.flatMap((section) => section.rows), [sections])

  useEffect(() => {
    if (view === "model") rowRefs.current.get(highlight)?.scrollIntoView({ block: "nearest" })
  }, [highlight, view])

  const defaultEffortFor = (harnessId: HarnessId, model: ProviderModel): Effort => {
    const target = getHarness(harnessId)
    return model.defaultEffort && target.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : target.defaultEffort
  }
  const closePopover = () => setOpen(false)
  const openView = (next: PickerView) => {
    if (view === next) return
    setView(next)
    if (next === "model") {
      setQuery("")
      const index = items.findIndex((row) =>
        row.provider.id === selection.providerId && row.model.id === selection.modelId)
      setHighlight(index >= 0 ? index : 0)
      onDiscover?.(selection.harnessId)
    }
  }
  const pickHarness = (harnessId: HarnessId) => {
    if (harnessId === selection.harnessId) {
      setView("root")
      return
    }
    closePopover()
    onHarnessChange?.(harnessId)
    onDiscover?.(harnessId)
  }
  const pickModel = (row: UnifiedRow) => {
    if (modelLocked) return
    onSelectFull({
      harnessId: selection.harnessId,
      providerId: row.provider.id,
      modelId: row.model.id,
      effort: defaultEffortFor(selection.harnessId, row.model),
    })
    closePopover()
  }
  const pickEffort = (effort: Effort) => {
    if (!canTuneEffort) return
    onEffortChange?.(effort)
    closePopover()
  }
  const onModelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((previous) => Math.min(previous + 1, items.length - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((previous) => Math.max(previous - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      const row = items[highlight]
      if (row) pickModel(row)
    }
  }

  const rootRow = (label: string, value: string, next: PickerView, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => openView(next)}
      onMouseEnter={() => openView(next)}
      className={cn(
        "flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:opacity-45",
        view === next && "bg-muted",
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="ml-auto max-w-28 truncate font-normal text-muted-foreground">{value}</span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )

  const flyoutSize = view === "model"
    ? items.length <= 3
      ? "h-48 w-72"
      : items.length <= 6
        ? "h-72 w-72"
        : "h-96 w-72"
    : view === "harness"
      ? "h-[20.5rem] w-60"
      : view === "effort"
        ? harness.efforts.length >= 5
          ? "h-72 w-72"
          : harness.efforts.length >= 4
            ? "h-56 w-72"
            : "h-44 w-72"
        : ""

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setView("root")
          setQuery("")
          setOpen(true)
          onDiscover?.(selection.harnessId)
        } else closePopover()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          aria-label="运行配置"
          className={cn(
            // interpolate-size: 让 width 在 auto(静止内容宽) 与 15rem(展开) 之间可过渡,
            // 否则 auto→固定值不插值、直接跳变(Chromium 129+)
            "group/runtime relative max-w-[calc(100%-3rem)] rounded-full bg-transparent font-normal [interpolate-size:allow-keywords] transition-[width,background-color,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-muted/55 data-[state=open]:bg-muted/65 active:scale-[0.97] motion-reduce:transition-none",
            // 静止时内容宽;展开时与弹层同宽(w-60)且文字居中,弹层落在正上方形成一体
            open ? "w-60" : "",
            session ? "h-7 gap-1.5 pl-2 pr-6 text-sm" : "h-9 gap-2 pl-3 pr-7 text-sm",
          )}
        >
          <HarnessIcon id={selection.harnessId} className={session ? "size-3.5" : "size-4"} />
          <span className="truncate">{modelLabel}</span>
          {canTuneEffort && <span className="shrink-0 text-muted-foreground">{effortLabel}</span>}
          {/* 始终脱离文档流钉在右端:开合时 auto 内容宽不变,过渡起点不跳 */}
          <ChevronDown className={cn(
            "absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-transform duration-180 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-[state=open]/runtime:rotate-180",
            session ? "size-3" : "size-4",
          )} />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="runtime-popover relative h-[8.5rem] w-60 overflow-visible p-2"
      >
        <div>
          {rootRow("Harness", harness.name, "harness")}
          {rootRow("模型", modelLabel, "model", modelLocked)}
          {rootRow("推理强度", canTuneEffort ? effortLabel : "—", "effort", !canTuneEffort)}
        </div>

        {view !== "root" && (
          <div
            key={view}
            className={cn(
              "absolute bottom-0 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-pop animate-in fade-in zoom-in-95 duration-150 motion-reduce:animate-none",
              "right-[calc(100%+0.5rem)] slide-in-from-right-2",
              flyoutSize,
            )}
          >
          {view === "harness" && (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {harnessOptions.map((item) => (
                  <button key={item.id} type="button" onClick={() => pickHarness(item.id)} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    <HarnessIcon id={item.id} className="size-4" />
                    <span className="flex-1 text-sm font-medium">{item.name}</span>
                    {item.id === selection.harnessId && <Check className="size-4" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {view === "model" && (
            <div className="flex h-full min-h-0 flex-col" onKeyDown={onModelKeyDown}>
              <label className="mx-2 mt-2 flex h-10 shrink-0 items-center gap-2.5 rounded-xl bg-muted/70 px-3 focus-within:ring-1 focus-within:ring-foreground/20">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input value={query} onChange={(event) => { setQuery(event.target.value); setHighlight(0) }} placeholder="搜索模型" aria-label="搜索模型" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              </label>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {items.map((row, index) => {
                  const active = row.provider.id === selection.providerId && row.model.id === selection.modelId
                  return (
                    <button key={`${row.provider.id}:${row.model.id}`} type="button" ref={(node) => { if (node) rowRefs.current.set(index, node); else rowRefs.current.delete(index) }} disabled={modelLocked} onMouseEnter={() => setHighlight(index)} onClick={() => pickModel(row)} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default", index === highlight ? "bg-muted" : "hover:bg-muted/60", active && "font-medium")}>
                      <span className="min-w-0 flex-1 truncate">{row.model.name}<span className="font-normal text-muted-foreground"> · {row.provider.name}</span></span>
                      {active && <Check className="size-4 shrink-0" />}
                    </button>
                  )
                })}
                {items.length === 0 && (
                  <div className="space-y-2 px-3 py-6 text-center text-sm text-muted-foreground">
                    <p>{needle ? "没有匹配的模型" : "没有已连接供应商提供可选模型。"}</p>
                    {typeof window !== "undefined" && window.bento && (
                      <button type="button" className="text-foreground underline underline-offset-4" onClick={() => { setOpen(false); openSettings("providers", { addProvider: Boolean(needle) }) }}>
                        {needle ? "添加供应商…" : "前往供应商设置…"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {view === "effort" && (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {harness.efforts.map((effort) => {
                  const meta = EFFORTS.find((item) => item.id === effort)
                  return (
                    <button key={effort} type="button" onClick={() => pickEffort(effort)} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{meta?.label ?? effort}</span>{meta?.hint && <span className="block truncate text-xs text-muted-foreground">{meta.hint}</span>}</span>
                      {effort === selection.effort && <Check className="size-4 shrink-0" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
