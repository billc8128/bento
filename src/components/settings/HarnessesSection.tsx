import { useEffect, useState } from "react"
import { Check, RefreshCw } from "lucide-react"

import { HarnessIcon } from "@/components/HarnessIcon"
import { Button } from "@/components/ui/button"
import { HARNESSES, type HarnessRuntimeStatus } from "@/core/harness"
import { PERMISSION_PROFILES } from "@/core/permission"
import { setDefaultPermissionProfile, useDefaultPermissionProfile } from "@/lib/permission-profile"
import { cn } from "@/lib/utils"

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
  const defaultProfile = useDefaultPermissionProfile()
  const [ruleGroups, setRuleGroups] = useState<
    { cwd: string; rules: { harnessId: string; rule: string; createdAt: string }[] }[]
  >([])

  const refresh = () => {
    setLoading(true)
    void window.bento?.listHarnessRuntimes().then(setStatuses).finally(() => setLoading(false))
  }
  const refreshRules = () => {
    void window.bento?.listPermissionRules().then(setRuleGroups)
  }

  useEffect(() => {
    let alive = true
    void window.bento?.listHarnessRuntimes().then((items) => {
      if (alive) setStatuses(items)
    }).finally(() => {
      if (alive) setLoading(false)
    })
    void window.bento?.listPermissionRules().then((groups) => {
      if (alive) setRuleGroups(groups)
    })
    return () => { alive = false }
  }, [])

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-sm font-medium">默认权限档位</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          新建会话继承该档位;只有 Codex 是 OS 沙箱强制的硬边界,其余 Harness 为工具集近似。
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {PERMISSION_PROFILES.map((profile) => {
            const active = defaultProfile === profile.id
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => setDefaultPermissionProfile(profile.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                  active
                    ? "border-brand ring-1 ring-brand/40"
                    : "border-border hover:border-foreground/25",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{profile.name}</span>
                    {active && <Check className="size-4 shrink-0 text-brand" />}
                  </div>
                  <p className="type-micro mt-0.5 text-muted-foreground">{profile.desc}</p>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium">权限规则</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          审批时选「本会话总是允许」的工具会记到项目的 .bento/permissions.json,之后自动放行。
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {ruleGroups.length === 0 && (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              暂无规则
            </p>
          )}
          {ruleGroups.map((group) => (
            <div key={group.cwd} className="rounded-xl border border-border p-3">
              <p className="truncate font-mono text-xs text-muted-foreground">{group.cwd}</p>
              <div className="mt-2 flex flex-col gap-1">
                {group.rules.map((item) => (
                  <div key={`${item.harnessId}:${item.rule}`} className="flex items-center gap-2">
                    <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                      {item.rule}
                    </span>
                    <span className="type-micro text-muted-foreground/70">{item.harnessId}</span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      className="type-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => {
                        void window.bento
                          ?.removePermissionRule(group.cwd, item.harnessId, item.rule)
                          .then(refreshRules)
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

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
    </div>
  )
}
