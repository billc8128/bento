/**
 * 布局板块:自由布局开关 + 重置布局。
 * 实际控制与侧栏账户菜单同源(layout-store),这里只是更宽敞的入口。
 */

import { RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { resetLayout, setLayoutMode, useLayout } from "@/lib/layout-store"

export function LayoutSection() {
  const { mode } = useLayout()

  return (
    <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">自由布局</span>
          <span className="text-xs text-muted-foreground">
            开启后可自由拖动、分组、关闭会话面板;关闭则回到单面板受管模式。
          </span>
        </div>
        <Checkbox
          checked={mode === "free"}
          onCheckedChange={(v) => setLayoutMode(v === true ? "free" : "managed")}
          aria-label="自由布局"
        />
      </div>

      <div className="flex items-center justify-between gap-6 px-4 py-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">重置布局</span>
          <span className="text-xs text-muted-foreground">
            把所有会话面板恢复为默认排列,不会关闭会话本身。
          </span>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => resetLayout()}>
          <RotateCcw className="size-3.5 opacity-70" />
          重置
        </Button>
      </div>
    </div>
  )
}
