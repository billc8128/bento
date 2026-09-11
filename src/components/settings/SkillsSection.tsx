/**
 * 设置页 Skills 板块:全局 skills 扫描列表 + 主开关/逐 skill 开关。
 * 交互基准(已获批 demo):主开关关闭时列表整体 disable(半透明 + 不可点);
 * 头部实时「已启用 x/y」;同名多来源以 badge 并列;底部说明快照语义。
 * 开关状态存 renderer localStorage(skills-preferences),变更即推送 main;
 * 投递发生在会话 prepare(物化复制,新会话生效)。
 */

import { useEffect, useMemo, useState } from "react"
import { FolderCog, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { GlobalSkill } from "@/types/bento"
import { useT } from "@/lib/i18n"
import {
  setSkillsAllowGlobal,
  setSkillEnabled,
  useSkillsPreferences,
} from "@/lib/skills-preferences"

export function SkillsSection() {
  const { t } = useT()
  const { allowGlobal, isSkillEnabled } = useSkillsPreferences()
  const [skills, setSkills] = useState<GlobalSkill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const enabledCount = useMemo(
    () => (skills ?? []).filter((skill) => isSkillEnabled(skill.name)).length,
    // isSkillEnabled 随开关 store 版本变化(每次渲染都是最新闭包),这里随之重算
    [skills, isSkillEnabled],
  )
  const rescan = () => {
    window.bento!
      .scanSkills()
      .then((list) => {
        setSkills(list)
        setError(null)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  useEffect(() => {
    if (!window.bento) return // 纯 web 模式无扫描通道,直接走占位文案
    let cancelled = false
    window.bento!
      .scanSkills()
      .then((list) => {
        if (!cancelled) {
          setSkills(list)
          setError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!window.bento) {
    return <p className="text-sm text-muted-foreground">{t("settings.skillsDesktopOnly")}</p>
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 主开关卡 */}
      <div className="flex items-center gap-4 rounded-xl border border-border px-4 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
          <FolderCog className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("settings.skillsAllowTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.skillsAllowDesc")}</p>
        </div>
        <Switch
          checked={allowGlobal}
          onCheckedChange={setSkillsAllowGlobal}
          aria-label={t("settings.skillsAllowTitle")}
        />
      </div>

      {/* 列表卡 */}
      {error ? (
        <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-4">
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {t("settings.skillsScanFailed", { error })}
          </p>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5" onClick={rescan}>
            <RotateCw className="size-3.5" />
            {t("settings.retry")}
          </Button>
        </div>
      ) : skills === null ? (
        <p className="text-sm text-muted-foreground">{t("settings.skillsScanning")}</p>
      ) : skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.skillsEmpty")}</p>
      ) : (
        <div className={allowGlobal ? "" : "pointer-events-none opacity-45"}>
          <div className="flex items-baseline justify-between px-1 pb-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("settings.skillsFound", { count: skills.length })}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("settings.skillsEnabledCount", { enabled: enabledCount, total: skills.length })}
            </span>
          </div>
          <div className="divide-y divide-border rounded-xl border border-border">
            {skills.map((skill) => (
              <div key={skill.name} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm">{skill.name}</p>
                    {skill.sources.map((src) => (
                      <span
                        key={src}
                        className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
                      >
                        {src}
                      </span>
                    ))}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{skill.description}</p>
                </div>
                <Switch
                  checked={isSkillEnabled(skill.name)}
                  aria-label={t("settings.skillsEnableAria", { name: skill.name })}
                  onCheckedChange={(checked) => setSkillEnabled(skill.name, checked)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.skillsFooter")}
      </p>
    </div>
  )
}
