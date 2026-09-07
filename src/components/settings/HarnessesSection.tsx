import { useEffect, useState } from "react"
import { Check, RefreshCw } from "lucide-react"

import { HarnessIcon } from "@/components/HarnessIcon"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { HARNESSES, getHarness, type HarnessRuntimeStatus } from "@/core/harness"
import { PERMISSION_PROFILES } from "@/core/permission"
import { useT, type TFn } from "@/lib/i18n"
import { setHarnessEnabled, useHarnessPreferences } from "@/lib/harness-preferences"
import { setDefaultPermissionProfile, useDefaultPermissionProfile } from "@/lib/permission-profile"
import { cn } from "@/lib/utils"

function sourceLabel(status: HarnessRuntimeStatus | undefined, t: TFn): string {
  // 版本透传:override 探测、managed 取 manifest pin、bundled 取内嵌包版本
  return status?.version ?? t("settings.detecting")
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
  const { t } = useT()
  const [statuses, setStatuses] = useState<HarnessRuntimeStatus[]>([])
  const [loading, setLoading] = useState(true)
  const defaultProfile = useDefaultPermissionProfile()
  const { isEnabled } = useHarnessPreferences()
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
        title={t("settings.runtime")}
        desc={t("settings.runtimeDesc")}
        action={
          <Button variant="ghost" size="icon" className="size-8" onClick={refresh} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
            <span className="sr-only">{t("settings.redetect")}</span>
          </Button>
        }
      >
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {HARNESSES.map((harness) => {
            const status = statuses.find((item) => item.harnessId === harness.id)
            return (
              <div key={harness.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                  <HarnessIcon id={harness.id} className="size-4.5" />
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="text-sm font-medium">{harness.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {sourceLabel(status, t)}
                  </span>
                </span>
                <Switch
                  checked={isEnabled(harness.id)}
                  onCheckedChange={(v) => setHarnessEnabled(harness.id, v)}
                  aria-label={t("settings.enableHarness", { name: harness.name })}
                />
              </div>
            )
          })}
        </div>
      </Section>

      <Section
        title={t("settings.defaultPermission")}
        desc={t("settings.defaultPermissionDesc")}
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
                  <span className="block text-sm font-medium">{t(profile.nameKey)}</span>
                  <span className="type-micro mt-0.5 block text-muted-foreground">{t(profile.descKey)}</span>
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
        title={t("settings.autoAllowRules")}
        desc={t("settings.autoAllowRulesDesc")}
      >
        {ruleGroups.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            {t("settings.noRules")}
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
                      <span className="type-micro text-muted-foreground/70">
                        {getHarness(item.harnessId).name}
                      </span>
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
                        {t("settings.delete")}
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
