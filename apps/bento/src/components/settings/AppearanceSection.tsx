/**
 * 外观板块:配色套系卡片。主卡只有一张「默认」(石墨 token);
 * 其余风格主题折叠在「更多主题」里。明暗与套系正交——每套主题都有自己的
 * dark 变体,明暗由侧栏的月亮开关控制,不在这里做卡片。
 * 预览是缩微的 app 窗口:颜色取自 themes.css 该主题设计明暗(tone)的 token,
 * 结构跟 traits 走(浮岛侧栏/无气泡日志),是设计常量而非运行时 token。
 */

import { useState } from "react"
import { Check, ChevronRight } from "lucide-react"

import { StatusGlyph } from "@/components/StatusGlyph"
import { STYLES, getStyle, styleName, type StyleId } from "@/data/styles"
import { useLocalePreference, useT, type LocalePreference } from "@/lib/i18n"
import { STATUS_GLYPH_VARIANTS, setStatusGlyph, useStatusGlyph, type StatusGlyphVariant } from "@/lib/appearance/status-glyph"
import { useTheme } from "@/lib/appearance/theme-context"
import { cn } from "@/lib/utils"

/** 迷你窗口用的五色:窗底 / 侧栏 / 文字行(弱化内容) / 强调。按主题设计的明暗取 */
type Preview = { bg: string; side: string; soft: string; acc: string }

/** 状态指示变体名的词典 key(命名空间 settings) */
const GLYPH_NAME_KEYS: Record<StatusGlyphVariant, string> = {
  b: "settings.glyphProgressRing",
  a: "settings.glyphBreathingHalo",
  d: "settings.glyphEnergyBar",
  f: "settings.glyphPixelState",
}

const PREVIEWS: Record<StyleId, Preview> = {
  graphite: { bg: "oklch(1 0 0)", side: "oklch(0.985 0 0)", soft: "oklch(0.93 0 0)", acc: "oklch(0.72 0.15 72)" },
  glass: { bg: "linear-gradient(135deg, oklch(0.85 0.04 250), oklch(0.9 0.03 150))", side: "oklch(1 0 0 / 0.35)", soft: "oklch(1 0 0 / 0.55)", acc: "oklch(0.72 0.15 72)" },
  // indigo / terminal 是深色向设计,预览直接用 dark 变体
  indigo: { bg: "oklch(0 0 0)", side: "oklch(0.21 0 0)", soft: "oklch(0.28 0 0)", acc: "oklch(0.62 0.17 267.44)" },
  soft: { bg: "oklch(0.955 0.009 285)", side: "oklch(1 0 0)", soft: "oklch(0.92 0.012 285)", acc: "oklch(0.56 0.15 320)" },
  warm: { bg: "oklch(0.985 0.006 85)", side: "oklch(0.962 0.01 80)", soft: "oklch(0.935 0.012 80)", acc: "oklch(0.52 0.135 42)" },
  terminal: { bg: "oklch(0.16 0.008 160)", side: "oklch(0.135 0.008 160)", soft: "oklch(0.3 0.014 160)", acc: "oklch(0.62 0.135 150)" },
}

/** 缩微 app:侧栏 + 正文行 + 用户气泡 + 输入条。结构差异按 traits 画:
 * 浮岛侧栏缩成独立圆角块;无气泡(plain)的日志风用强调色前缀代替气泡 */
function ThemePreview({ id }: { id: StyleId }) {
  const p = PREVIEWS[id]
  const { traits } = getStyle(id)
  const island = traits.sidebar === "island"
  return (
    <div
      className="flex h-20 overflow-hidden rounded-lg border border-border/60 p-1"
      style={{ background: p.bg }}
    >
      <div
        className={cn(
          "flex w-[26%] flex-col gap-1 p-1.5",
          island ? "m-0.5 mr-1 rounded-md" : "rounded-l-md",
        )}
        style={{ background: p.side }}
      >
        <span className="block h-1 w-3/5 rounded-full" style={{ background: p.soft }} />
        <span className="block h-1 w-4/5 rounded-full" style={{ background: p.soft }} />
        <span className="block h-1 w-2/5 rounded-full" style={{ background: p.acc }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <span className="block h-1 w-5/6 rounded-full" style={{ background: p.soft }} />
        <span className="block h-1 w-3/5 rounded-full" style={{ background: p.soft }} />
        {traits.message === "plain" ? (
          <span className="mt-0.5 block h-2 w-2/3 rounded-sm border-l-2 pl-1" style={{ borderColor: p.acc }}>
            <span className="block h-1 w-full rounded-full" style={{ background: p.soft }} />
          </span>
        ) : (
          <span className="mt-0.5 block h-2.5 w-2/5 self-end rounded-full" style={{ background: p.acc }} />
        )}
        <span className="mt-auto block h-2.5 rounded-full" style={{ background: p.soft }} />
      </div>
    </div>
  )
}

function ThemeCard({ id, name, active, onSelect }: {
  id: StyleId
  name: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "rounded-xl border p-2.5 text-left transition-colors",
        active ? "border-brand ring-1 ring-brand/40" : "border-border hover:border-foreground/25",
      )}
    >
      <ThemePreview id={id} />
      <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
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
  const { t } = useT()
  const { preference, setPreference } = useLocalePreference()

  const languageOptions: { id: LocalePreference; label: string }[] = [
    { id: "system", label: t("settings.languageSystem") },
    { id: "zh-CN", label: t("settings.languageZh") },
    { id: "en-US", label: t("settings.languageEn") },
  ]

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-sm font-medium">{t("settings.language")}</h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {languageOptions.map((option) => {
            const activeItem = preference === option.id
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setPreference(option.id)}
                className={cn(
                  "flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors",
                  activeItem
                    ? "border-brand ring-1 ring-brand/40"
                    : "border-border hover:border-foreground/25",
                )}
              >
                <span className="text-sm font-medium">{option.label}</span>
                {activeItem && <Check className="size-4 shrink-0 text-brand" />}
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium">{t("settings.colorThemes")}</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <ThemeCard
            id="graphite"
            name={styleName("graphite", t)}
            active={theme.style === "graphite"}
            onSelect={() => theme.setStyle("graphite")}
          />
        </div>

        <button
          type="button"
          onClick={() => setMoreOpen(!moreOpen)}
          className="mt-3 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", moreOpen && "rotate-90")} />
          {t("settings.moreThemes")}
        </button>
        {moreOpen && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            {STYLES.filter((s) => s.id !== "graphite").map((s) => (
              <ThemeCard
                key={s.id}
                id={s.id}
                name={styleName(s.id, t)}
                active={theme.style === s.id}
                onSelect={() => theme.setStyle(s.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium">{t("settings.statusIndicator")}</h2>
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
                  <span className="text-sm font-medium">{t(GLYPH_NAME_KEYS[v.id])}</span>
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
