/**
 * 「从本机配置导入」:向导内的检测流程。
 * 显式状态机 scanning → list → detail → (importing) → 成功回调,
 * 每个阶段都有文案;凭证不可复制的候选给「手动配置」出口,0 模型时可手填再导入。
 */

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Loader2, Plus, TerminalSquare } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import type { CustomModelConfig } from "@/core/provider"
import type { LocalProviderCandidate } from "@/core/provider-preset"
import { getProviderPreset } from "@/data/provider-presets"
import { ProviderMark } from "./ProviderMark"

type DetectedModel = CustomModelConfig & { enabled: boolean }

type Phase =
  | { step: "scanning" }
  | { step: "list" }
  | { step: "detail"; inspecting: boolean }
  | { step: "importing" }

export function DetectLocalProviders({
  onBack,
  onImported,
  onConfigure,
}: {
  onBack: () => void
  onImported: (provider: { id: string; name: string; modelCount: number }) => void
  /** 凭证不可复制时跳到对应预设的手动表单。 */
  onConfigure: (presetId: string) => void
}) {
  const [phase, setPhase] = useState<Phase>({ step: "scanning" })
  const [candidates, setCandidates] = useState<LocalProviderCandidate[]>([])
  const [candidate, setCandidate] = useState<LocalProviderCandidate | null>(null)
  const [models, setModels] = useState<DetectedModel[]>([])
  const [manualId, setManualId] = useState("")
  const [error, setError] = useState<string | null>(null)
  /** 防止组件卸载或重扫后迟到的 inspect 结果覆盖新状态。 */
  const inspectSeq = useRef(0)

  useEffect(() => {
    let alive = true
    void window.bento?.scanLocalProviders().then((found) => {
      if (!alive) return
      setCandidates(found)
      setPhase({ step: "list" })
    })
    return () => {
      alive = false
    }
  }, [])

  async function inspect(next: LocalProviderCandidate) {
    setCandidate(next)
    setModels([])
    setManualId("")
    setError(null)
    if (!next.credentialReusable) {
      setPhase({ step: "detail", inspecting: false })
      return
    }
    const seq = ++inspectSeq.current
    setPhase({ step: "detail", inspecting: true })
    const result = await window.bento?.inspectLocalProvider(next.id)
    if (seq !== inspectSeq.current) return
    setPhase({ step: "detail", inspecting: false })
    if (!result || !("ok" in result) || !result.ok) {
      setError(result && "message" in result ? result.message : "无法读取模型列表，可手动添加")
      return
    }
    setModels(result.models.map((model) => ({ ...model, enabled: true })))
  }

  function addManual() {
    const id = manualId.trim()
    if (!id) return
    if (models.some((model) => model.id === id)) {
      setError(`模型 ${id} 已在清单里`)
      return
    }
    setModels((current) => [...current, { id, name: id, enabled: true }])
    setManualId("")
    setError(null)
  }

  async function importSelected() {
    if (!candidate || !window.bento) return
    const chosen = models.filter((model) => model.enabled)
    if (chosen.length === 0) {
      setError("至少保留一个模型，或手动添加一个模型 ID")
      return
    }
    setPhase({ step: "importing" })
    setError(null)
    const result = await window.bento.importLocalProvider({ candidateId: candidate.id, models: chosen })
    if (result.error || !result.config) {
      setPhase({ step: "detail", inspecting: false })
      setError(result.error ?? "导入失败")
      return
    }
    onImported({ id: result.config.id, name: result.config.name, modelCount: chosen.length })
  }

  if (phase.step === "scanning") {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在扫描本机 CLI 配置…
        </div>
        <div className="mt-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-2/3" />
        </div>
      </div>
    )
  }

  if (phase.step === "list") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 p-5">
          <p className="mb-3 text-xs text-muted-foreground">
            {candidates.length > 0
              ? `在 ${[...new Set(candidates.map((item) => item.source))].join(" / ")} 的配置里发现以下供应商：`
              : "已扫描 omp / Pi / OpenCode / Kimi Code / Hermes 的本机配置："}
          </p>
          <div className="divide-y divide-border border-y border-border">
            {candidates.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/60"
                onClick={() => void inspect(item)}
              >
                <ProviderMark name={item.name} brandKey={item.presetId} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    来自 {item.source} · {item.credentialReusable ? "可直接导入" : "需要重新鉴权"}
                  </p>
                </div>
              </button>
            ))}
            {candidates.length === 0 && (
              <div className="py-10 text-center">
                <TerminalSquare className="mx-auto size-5 text-muted-foreground/60" />
                <p className="mt-2 text-sm text-muted-foreground">未发现可导入的本机配置</p>
                <p className="mt-1 text-xs text-muted-foreground/70">可以返回列表，从预设或自定义端点手动添加。</p>
              </div>
            )}
          </div>
        </div>
        <footer className="flex justify-start border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft />返回供应商列表
          </Button>
        </footer>
      </div>
    )
  }

  // detail / importing
  const importing = phase.step === "importing"
  const inspecting = phase.step === "detail" && phase.inspecting
  const preset = candidate ? getProviderPreset(candidate.presetId) : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <div className="flex items-center gap-3">
          {candidate && <ProviderMark name={candidate.name} brandKey={candidate.presetId} />}
          <div>
            <p className="text-sm font-medium">{candidate?.name}</p>
            <p className="text-xs text-muted-foreground">来自 {candidate?.source}</p>
          </div>
        </div>

        {candidate && !candidate.credentialReusable ? (
          <div className="rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
            检测到登录状态，但凭证不可安全复制。可以回到手动流程重新填入密钥完成配置。
          </div>
        ) : inspecting ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取可用模型…
          </div>
        ) : (
          <>
            {models.length > 0 && (
              <div className="divide-y divide-border border-y border-border">
                {models.map((model) => (
                  <div key={model.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{model.name}</p>
                      {model.name !== model.id && <p className="truncate text-xs text-muted-foreground">{model.id}</p>}
                    </div>
                    <Switch
                      checked={model.enabled}
                      aria-label={`导入 ${model.name}`}
                      onCheckedChange={(checked) =>
                        setModels((current) => current.map((item) => (item.id === model.id ? { ...item, enabled: checked } : item)))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {models.length === 0 && !error && (
              <p className="text-xs text-muted-foreground">没有读到模型列表，手动添加一个模型 ID 即可导入。</p>
            )}
            <div className="flex gap-2">
              <Input
                value={manualId}
                onChange={(event) => setManualId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    addManual()
                  }
                }}
                placeholder="手动添加模型 ID"
                className="h-8 text-xs"
              />
              <Button type="button" variant="outline" size="icon" className="size-8 shrink-0" onClick={addManual} aria-label="添加模型">
                <Plus className="size-3.5" />
              </Button>
            </div>
          </>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-5 py-3">
        <Button variant="ghost" onClick={() => setPhase({ step: "list" })} disabled={importing}>
          <ArrowLeft />返回
        </Button>
        {candidate && !candidate.credentialReusable ? (
          preset?.directConnect ? (
            <Button onClick={() => onConfigure(preset.id)}>手动配置 {preset.name}</Button>
          ) : (
            <Button variant="outline" onClick={onBack}>去手动添加</Button>
          )
        ) : (
          <Button disabled={importing || inspecting} onClick={() => void importSelected()}>
            {importing && <Loader2 className="animate-spin" />}
            导入供应商
          </Button>
        )}
      </footer>
    </div>
  )
}
