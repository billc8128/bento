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
  if (status.source === "bundled") return status.version ? `Bento 内置 · ${status.version}` : "Bento 内置"
  if (status.source === "managed") return status.version ? `Bento 受管 · ${status.version}` : "Bento 受管 · 首次使用时安装"
  return "未安装"
}

function localInstallNote(status: HarnessRuntimeStatus | undefined): string | null {
  const install = status?.localInstall
  if (!install) return null
  return `本机另有安装${install.version ? ` ${install.version}` : ""},未使用`
}

/** 板块骨架:标题 + 一行说明 + 内容,全页统一节奏 */
function Section({ title, desc, action, children }: {
  title: string
  desc: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function HarnessesSection() {
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
      <Section
        title="运行环境"
        desc="会话使用 Bento 内置或受管版本,首次使用时自动安装。"
        action={
          <Button variant="ghost" size="icon" className="size-8" onClick={refresh} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
            <span className="sr-only">重新检测</span>
          </Button>
        }
      >
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {HARNESSES.map((harness) => {
            const status = statuses.find((item) => item.harnessId === harness.id)
            const note = localInstallNote(status)
            return (
              <div key={harness.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                  <HarnessIcon id={harness.id} className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{harness.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {sourceLabel(status)}
                  </span>
                </span>
                {note && (
                  <span className="shrink-0 text-xs text-muted-foreground/70">{note}</span>
                )}
              </div>
            )
          })}
        </div>
      </Section>

      <Section
        title="默认权限档位"
        desc="新建会话继承该档位;只有 Codex 是 OS 沙箱强制的硬边界,其余 Harness 为工具集近似。"
      >
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {PERMISSION_PROFILES.map((profile) => {
            const active = defaultProfile === profile.id
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => setDefaultPermissionProfile(profile.id)}
                className="flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{profile.name}</span>
                  <span className="type-micro mt-0.5 block text-muted-foreground">{profile.desc}</span>
                </span>
                <span className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-full border",
                  active ? "border-brand bg-brand text-brand-foreground" : "border-border",
                )}>
                  {active && <Check className="size-3" strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      <Section
        title="权限规则"
        desc="审批时选「本会话总是允许」的工具会记到项目的 .bento/permissions.json,之后自动放行。"
      >
        {ruleGroups.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            暂无规则
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {ruleGroups.map((group) => (
              <div key={group.cwd} className="rounded-xl border border-border px-4 py-3">
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
        )}
      </Section>
    </div>
  )
}
