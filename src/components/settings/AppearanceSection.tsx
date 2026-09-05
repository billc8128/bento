/**
 * 外观板块:配色套系卡片。默认就两张——浅色/深色模式(同一套石墨 token 的明暗);
 * 其余风格主题折叠在「更多主题」里。每套主题的明暗由它自己的 tone 决定,
 * 套系预览色取自 themes.css 各主题的 tone 默认变体,是设计常量而非运行时 token。
 */

import { useState } from "react"
import { Check, ChevronRight } from "lucide-react"

import { StatusGlyph } from "@/components/StatusGlyph"
import { STYLES, type StyleId } from "@/data/styles"
import { STATUS_GLYPH_VARIANTS, setStatusGlyph, useStatusGlyph } from "@/lib/status-glyph"
import { useTheme } from "@/lib/theme-context"
import { cn } from "@/lib/utils"

const SWATCHES: Record<StyleId, { bg: string; primary: string; accent: string }> = {
  graphite: { bg: "oklch(1 0 0)", primary: "oklch(0.205 0 0)", accent: "oklch(0.95 0 0)" },
  glass: { bg: "linear-gradient(135deg, oklch(0.85 0.04 250), oklch(0.9 0.03 150))", primary: "oklch(0.21 0 0)", accent: "oklch(0.72 0.15 72)" },
  indigo: { bg: "oklch(0 0 0)", primary: "oklch(0.514 0.16 267.44)", accent: "oklch(0.32 0 0)" },
  soft: { bg: "oklch(0.955 0.009 285)", primary: "oklch(0.56 0.15 320)", accent: "oklch(0.9 0.02 300)" },
  warm: { bg: "oklch(0.985 0.006 85)", primary: "oklch(0.52 0.135 42)", accent: "oklch(0.935 0.016 78)" },
  terminal: { bg: "oklch(0.16 0.008 160)", primary: "oklch(0.62 0.135 150)", accent: "oklch(0.28 0.018 158)" },
}

/** 深色模式 = 石墨 token 的 dark 变体,预览色取自 themes.css 的 graphite.dark */
const DARK_SWATCH = { bg: "oklch(0.205 0 0)", primary: "oklch(0.922 0 0)", accent: "oklch(0.8 0.145 75)" }

function ThemeCard({ name, swatch, active, onSelect }: {
  name: string
  swatch: { bg: string; primary: string; accent: string }
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "rounded-xl border p-3 text-left transition-colors",
        active ? "border-brand ring-1 ring-brand/40" : "border-border hover:border-foreground/25",
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
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{name}</span>
        {active && <Check className="size-4 shrink-0 text-brand" />}
      </div>
    </button>
  )
}

export function AppearanceSection() {
  const theme = useTheme()
  const statusGlyph = useStatusGlyph()
  const [moreOpen, setMoreOpen] = useState(false)
  // 深色模式是石墨 token 的 dark 变体:两张主卡的 active 判定要把明暗也算上
  const graphiteActive = theme.style === "graphite"

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-sm font-medium">配色套系</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <ThemeCard
            name="浅色模式"
            swatch={SWATCHES.graphite}
            active={graphiteActive && !theme.dark}
            onSelect={() => { theme.setStyle("graphite"); theme.setDark(false) }}
          />
          <ThemeCard
            name="深色模式"
            swatch={DARK_SWATCH}
            active={graphiteActive && theme.dark}
            onSelect={() => { theme.setStyle("graphite"); theme.setDark(true) }}
          />
        </div>

        <button
          type="button"
          onClick={() => setMoreOpen(!moreOpen)}
          className="mt-3 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", moreOpen && "rotate-90")} />
          更多主题
        </button>
        {moreOpen && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            {STYLES.filter((s) => s.id !== "graphite").map((s) => (
              <ThemeCard
                key={s.id}
                name={s.name}
                swatch={SWATCHES[s.id]}
                active={theme.style === s.id}
                onSelect={() => theme.setStyle(s.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium">会话状态指示</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {STATUS_GLYPH_VARIANTS.map((v) => {
            const activeItem = statusGlyph === v.id
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setStatusGlyph(v.id)}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  activeItem
                    ? "border-brand ring-1 ring-brand/40"
                    : "border-border hover:border-foreground/25",
                )}
              >
                {/* 三个状态横向排开;相对定位盒是 D 能量条的锚(它绝对定位到行) */}
                <div className="relative flex h-11 items-center justify-center gap-5 rounded-lg border border-border/60 bg-muted/40">
                  <StatusGlyph state="running" variant={v.id} />
                  <StatusGlyph state="attention" variant={v.id} />
                  <StatusGlyph state="unread" variant={v.id} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{v.name}</span>
                  {activeItem && <Check className="size-4 shrink-0 text-brand" />}
                </div>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
