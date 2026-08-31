import { CheckCircle2, CircleAlert, Info } from "lucide-react"

import { useToasts } from "@/lib/toast"
import { cn } from "@/lib/utils"

const ICONS = {
  success: CheckCircle2,
  error: CircleAlert,
  info: Info,
} as const

/** 全局 toast 出口,挂在 App 根部。z-[60] 压过设置页(z-40)与 radix 弹层(z-50)。 */
export function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((item) => {
        const Icon = ICONS[item.kind]
        return (
          <div
            key={item.id}
            className={cn(
              "flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-pop animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none",
              item.kind === "error" && "text-destructive",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span>{item.text}</span>
          </div>
        )
      })}
    </div>
  )
}
