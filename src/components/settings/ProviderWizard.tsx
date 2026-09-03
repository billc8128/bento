import { useMemo, useState } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, Search, TerminalSquare } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ProviderCategory, ProviderPreset } from "@/core/provider-preset"
import { getProviderPreset, PROVIDER_PRESETS } from "@/data/provider-presets"
import type { CustomProviderEntry } from "@/lib/custom-provider-store"

import { DetectLocalProviders } from "./DetectLocalProviders"
import { PresetProviderForm } from "./PresetProviderForm"
import { ProviderForm } from "./ProviderForm"
import { ProviderMark } from "./ProviderMark"

type Pick = ProviderPreset | "custom" | null
type Step = "pick" | "form" | "detect"

const GROUPS: Array<{ id: ProviderCategory; label: string }> = [
  { id: "api", label: "API" },
  { id: "plan", label: "Coding / Token Plan" },
  { id: "local", label: "本地与代理" },
  { id: "account", label: "账户连接" },
  { id: "cloud", label: "云平台" },
]

function SpecialProviderForm({
  preset,
  onCancel,
  onDetect,
}: {
  preset: ProviderPreset
  onCancel: () => void
  onDetect: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-5 p-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{preset.name}</h3>
          <p className="text-xs text-muted-foreground">
            {preset.category === "cloud"
              ? "需要项目、区域或云端身份配置，不能作为普通 API Key 端点添加。"
              : preset.category === "account"
                ? "该类账户登录(如 Cursor、GitHub Copilot)需在对应 CLI 内使用,Bento 不导入也不代理其登录态。"
                : "使用供应商账户或现有 CLI 登录状态连接。"}
          </p>
        </div>
        <a
          href={preset.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
        >
          查看接入文档 <ExternalLink className="size-3" />
        </a>
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" onClick={onCancel}>返回</Button>
        {preset.category !== "account" && <Button onClick={onDetect}>检测本机配置</Button>}
      </footer>
    </div>
  )
}

export function ProviderWizard({
  open,
  onOpenChange,
  editing,
  onSaved,
  startStep = null,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: CustomProviderEntry | null
  /** 保存/导入成功后回传 provider id,便于父级选中并反馈。 */
  onSaved: (providerId?: string) => void
  /** 打开时直接进入的步骤(空态导入 CTA 用 detect);关闭时复位。 */
  startStep?: Step | null
}) {
  const [pick, setPick] = useState<Pick>(null)
  const [step, setStep] = useState<Step>(startStep ?? "pick")
  const [query, setQuery] = useState("")
  // startStep 变化时在渲染期同步(空态导入 CTA 复用挂载中的向导)。
  const [lastStartStep, setLastStartStep] = useState(startStep)
  if (startStep !== lastStartStep) {
    setLastStartStep(startStep)
    setStep(startStep ?? "pick")
  }
  const editingPreset = editing?.presetId ? getProviderPreset(editing.presetId) : undefined
  const selected = editingPreset ?? (pick !== null && pick !== "custom" ? pick : undefined)
  const activeStep: Step = editing ? "form" : step
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => GROUPS.map((group) => ({
    ...group,
    items: PROVIDER_PRESETS.filter((preset) =>
      preset.id !== "custom" &&
      preset.category === group.id &&
      (!q || preset.name.toLowerCase().includes(q) || preset.id.includes(q) || preset.sourceIds.some((id) => id.includes(q))),
    ),
  })).filter((group) => group.items.length > 0), [q])

  function close(next: boolean) {
    if (!next) {
      setPick(null)
      setStep("pick")
      setQuery("")
    }
    onOpenChange(next)
  }

  function backToPick() {
    setPick(null)
    setStep("pick")
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex h-[620px] max-h-[calc(100vh-2rem)] w-[720px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 transition-[height] sm:max-w-[min(720px,calc(100vw-2rem))]">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            {(activeStep === "form" || activeStep === "detect") && !editing && (
              <Button type="button" variant="ghost" size="icon-sm" onClick={backToPick} aria-label="返回供应商列表">
                <ArrowLeft />
              </Button>
            )}
            {editing
              ? `编辑 ${editing.name}`
              : activeStep === "pick"
                ? "添加供应商"
                : activeStep === "detect"
                  ? "从本机配置导入"
                  : selected?.name ?? "自定义端点"}
          </DialogTitle>
          <DialogDescription className="sr-only">选择并配置模型供应商</DialogDescription>
        </DialogHeader>

        {activeStep === "pick" ? (
          <>
            <div className="border-b border-border px-5 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索供应商" className="pl-8 focus-visible:border-foreground/25 focus-visible:ring-1 focus-visible:ring-foreground/15" autoFocus />
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 py-3">
                {!q && (
                  <div className="mb-3 space-y-2">
                    <button
                      type="button"
                      onClick={() => setStep("detect")}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-muted/70"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground shadow-sm">
                        <TerminalSquare className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">从本机配置导入</span>
                        <span className="block text-xs text-muted-foreground">自动检测 omp / Pi / OpenCode / Kimi Code 等本机配置</span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPick("custom"); setStep("form") }}
                      className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left transition-colors hover:bg-muted/60"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-sm font-medium">+</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">添加自定义端点</span>
                        <span className="block text-xs text-muted-foreground">手动填写 Base URL、API Key 与模型</span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </div>
                )}
                {groups.map((group) => (
                  <section key={group.id} className="py-2">
                    <p className="mb-1.5 px-2 text-xs text-muted-foreground">{group.label}</p>
                    <div className="divide-y divide-border border-y border-border">
                      {group.items.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => { setPick(preset); setStep("form") }}
                          className="flex min-h-11 w-full items-center gap-3 px-2 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ProviderMark name={preset.name} brandKey={preset.id} className="size-7" />
                          <span className="min-w-0 flex-1 truncate text-sm">{preset.name}</span>
                          {!preset.directConnect && <span className="text-xs text-muted-foreground">专用接入</span>}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                {groups.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">没有匹配的供应商</p>}
                {q && (
                  <section className="py-2">
                    <button
                      type="button"
                      onClick={() => { setPick("custom"); setStep("form") }}
                      className="flex min-h-11 w-full items-center gap-3 border-y border-dashed border-border px-2 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-xs font-medium">+</span>
                      <span className="text-sm">添加自定义端点</span>
                    </button>
                  </section>
                )}
              </div>
            </ScrollArea>
          </>
        ) : activeStep === "detect" ? (
          <DetectLocalProviders
            onBack={backToPick}
            onImported={(provider) => onSaved(provider.id)}
            onConfigure={(presetId) => {
              const preset = getProviderPreset(presetId)
              if (preset) {
                setPick(preset)
                setStep("form")
              } else {
                backToPick()
              }
            }}
          />
        ) : selected?.directConnect ? (
          <PresetProviderForm preset={selected} editing={editing ?? undefined} onCancel={() => editing ? close(false) : backToPick()} onSaved={onSaved} />
        ) : selected ? (
          <SpecialProviderForm preset={selected} onCancel={() => editing ? close(false) : backToPick()} onDetect={() => setStep("detect")} />
        ) : (
          <ProviderForm custom editing={editing ?? undefined} onCancel={() => editing ? close(false) : backToPick()} onSaved={onSaved} />
        )}
      </DialogContent>
    </Dialog>
  )
}
