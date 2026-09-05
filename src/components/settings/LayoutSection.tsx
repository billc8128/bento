/**
 * 实验室板块(设置 → 实验室):实验性开关,目前是标签页模式(默认受管布局)。
 * 开关状态在 layout-store,全局唯一入口——不放侧栏菜单,低频设置归这里。
 */

import { Checkbox } from "@/components/ui/checkbox"
import { setLayoutMode, useLayout } from "@/lib/layout-store"

export function LayoutSection() {
  const { mode } = useLayout()

  return (
    <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">标签页模式</span>
          <span className="text-xs text-muted-foreground">
            开启后每个面板组顶部显示标签页,多个会话/应用可叠放切换,类似浏览器;
            关闭则回到受管布局,分栏靠侧栏拖拽。
          </span>
        </div>
        <Checkbox
          checked={mode === "free"}
          onCheckedChange={(v) => setLayoutMode(v === true ? "free" : "managed")}
          aria-label="标签页模式"
        />
      </div>
    </div>
  )
}
