/**
 * 实验室板块(设置 → 实验室):实验性开关,目前是标签页模式(默认受管布局)。
 * 开关状态在 layout-store,全局唯一入口——不放侧栏菜单,低频设置归这里。
 */

import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n"
import { setLayoutMode, useLayout } from "@/lib/workspace/layout-store"

export function LayoutSection() {
  const { mode } = useLayout()
  const { t } = useT()

  return (
    <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{t("settings.tabMode")}</span>
          <span className="text-xs text-muted-foreground">
            {t("settings.tabModeDesc")}
          </span>
        </div>
        <Switch
          checked={mode === "free"}
          onCheckedChange={(v) => setLayoutMode(v ? "free" : "managed")}
          aria-label={t("settings.tabMode")}
        />
      </div>
    </div>
  )
}
