import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"

import { HarnessIcon } from "@/components/HarnessIcon"
import { Button } from "@/components/ui/button"
import { HARNESSES, type HarnessRuntimeStatus } from "@/core/harness"

function sourceLabel(status: HarnessRuntimeStatus | undefined): string {
  if (!status) return "检测中…"
  // source 是首选执行来源(override → managed/bundled);managed 首次使用时按需下载。
  if (status.source === "override") return status.version ? `指定路径 · ${status.version}` : "指定路径"
  if (status.source === "bundled") return "Bento 内置"
  if (status.source === "managed") return "Bento 受管 · 首次使用时安装"
  return "未安装"
}

function localInstallNote(status: HarnessRuntimeStatus | undefined): string | null {
  const install = status?.localInstall
  if (!install) return null
  return `检测到本机安装${install.version ? `(${install.version})` : ""},未使用`
}

export function HarnessesSection({ onAddModel }: { onAddModel: () => void }) {
  const [statuses, setStatuses] = useState<HarnessRuntimeStatus[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    setLoading(true)
    void window.bento?.listHarnessRuntimes().then(setStatuses).finally(() => setLoading(false))
  }

  useEffect(() => {
    let alive = true
    void window.bento?.listHarnessRuntimes().then((items) => {
      if (alive) setStatuses(items)
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [])

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <span className="text-sm text-muted-foreground">会话使用 Bento 内置或受管版本</span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onAddModel}>添加模型</Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={refresh} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
            <span className="sr-only">重新检测</span>
          </Button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {HARNESSES.map((harness) => {
          const status = statuses.find((item) => item.harnessId === harness.id)
          const note = localInstallNote(status)
          return (
            <div key={harness.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                <HarnessIcon id={harness.id} className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{harness.name}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {sourceLabel(status)}
                </span>
                {note && (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">
                    {note}
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
