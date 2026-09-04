/**
 * 主题板块:配色套系卡片。每套主题的明暗由它自己的 tone 决定,
 * 不再单独提供深浅切换(套系本身就是分深浅的)。
 * 套系预览色取自 themes.css 各主题的 tone 默认变体(bg/primary/accent),
 * 是设计常量而非运行时 token——和 macOS 外观选择器一个做法。
 */

import { Check } from "lucide-react"

import { StatusGlyph } from "@/components/StatusGlyph"
import { STYLES, type StyleId } from "@/data/styles"
import { STATUS_GLYPH_VARIANTS, setStatusGlyph, useStatusGlyph } from "@/lib/status-glyph"
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
  const statusGlyph = useStatusGlyph()

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

      <section>
        <h2 className="text-sm font-medium">会话状态指示</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          侧栏会话行的「进行中 / 未读」指示样式,琥珀代表进行中,绿色代表新消息。
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {STATUS_GLYPH_VARIANTS.map((v) => {
            const activeItem = statusGlyph === v.id
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setStatusGlyph(v.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                  activeItem
                    ? "border-brand ring-1 ring-brand/40"
                    : "border-border hover:border-foreground/25",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{v.name}</span>
                    {activeItem && <Check className="size-4 shrink-0 text-brand" />}
                  </div>
                  <p className="type-micro mt-0.5 text-muted-foreground">{v.desc}</p>
                </div>
                {/* 预览:复刻真实会话行的文字轴(pl-11/pr-5),D 的能量条才能对得上 */}
                <div className="flex w-44 shrink-0 flex-col rounded-lg border border-border/60 bg-muted/40 py-1">
                  <span className="relative flex h-7 items-center pl-11 pr-5 text-xs">
                    <span className="flex-1 truncate">重构 imagegen 注入</span>
                    <StatusGlyph state="running" variant={v.id} />
                  </span>
                  <span className="relative flex h-7 items-center pl-11 pr-5 text-xs">
                    <span className="flex-1 truncate">看下这个项目</span>
                    <StatusGlyph state="unread" variant={v.id} />
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
