/**
 * 主题板块:配色套系卡片。每套主题的明暗由它自己的 tone 决定,
 * 不再单独提供深浅切换(套系本身就是分深浅的)。
 * 套系预览色取自 themes.css 各主题的 tone 默认变体(bg/primary/accent),
 * 是设计常量而非运行时 token——和 macOS 外观选择器一个做法。
 */

import { Check } from "lucide-react"

import { STYLES, type StyleId } from "@/data/styles"
import { useTheme } from "@/lib/theme-context"
import { cn } from "@/lib/utils"

const SWATCHES: Record<StyleId, { bg: string; primary: string; accent: string }> = {
  graphite: { bg: "oklch(1 0 0)", primary: "oklch(0.205 0 0)", accent: "oklch(0.95 0 0)" },
  indigo: { bg: "oklch(0 0 0)", primary: "oklch(0.514 0.16 267.44)", accent: "oklch(0.32 0 0)" },
  soft: { bg: "oklch(0.955 0.009 285)", primary: "oklch(0.56 0.15 320)", accent: "oklch(0.9 0.02 300)" },
  warm: { bg: "oklch(0.985 0.006 85)", primary: "oklch(0.52 0.135 42)", accent: "oklch(0.935 0.016 78)" },
  terminal: { bg: "oklch(0.16 0.008 160)", primary: "oklch(0.62 0.135 150)", accent: "oklch(0.28 0.018 158)" },
}

export function AppearanceSection() {
  const theme = useTheme()

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-sm font-medium">配色套系</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          每套主题不只是颜色——侧栏形态、气泡、输入区结构都会随之变化。
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {STYLES.map((s) => {
            const swatch = SWATCHES[s.id]
            const activeItem = theme.style === s.id
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => theme.setStyle(s.id)}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  activeItem
                    ? "border-brand ring-1 ring-brand/40"
                    : "border-border hover:border-foreground/25",
                )}
              >
                <div
                  className="flex h-16 items-end gap-1.5 rounded-lg border border-border/60 p-2"
                  style={{ background: swatch.bg }}
                >
                  <span className="size-3.5 rounded-full" style={{ background: swatch.primary }} />
                  <span
                    className="size-3.5 rounded-full border border-black/10"
                    style={{ background: swatch.accent }}
                  />
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  {activeItem && <Check className="size-4 shrink-0 text-brand" />}
                </div>
                <p className="type-micro mt-0.5 text-muted-foreground">{s.desc}</p>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
