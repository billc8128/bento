/** 更新提示小点:brand 色 6px,不喧宾夺主(harness 有可更新项时挂在入口上)。 */

import { cn } from "@/lib/utils"

export function UpdateDot({ className }: { className?: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full bg-brand", className)} />
}
