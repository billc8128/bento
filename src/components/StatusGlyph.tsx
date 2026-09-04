/**
 * 会话状态指示:五套可切换样式(设置 → 主题),覆盖 进行中 / 未读 两个状态。
 * 色彩语义:琥珀(--color-brand)= 进行中,绿(--app-ok)= 完成/新消息。
 * 样式全部在 index.css 的 .sg-* 类上,D 变体的能量条绝对定位、相对会话行。
 */

import type { CSSProperties } from "react"

import type { StatusGlyphVariant } from "@/lib/status-glyph"

/** F 变体的 chevron 波前延迟表:亮度波沿"人"字形斜向右推进 */
const F_CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3)
  const c = i % 3
  return (c + Math.abs(r - 1)) * 90
})

export function StatusGlyph({
  state,
  variant,
}: {
  state: "running" | "unread"
  variant: StatusGlyphVariant
}) {
  const label = state === "running" ? "进行中" : "有来自其它会话的新消息"
  switch (variant) {
    case "a":
      return state === "running" ? (
        <span className="sg-a-dot" role="img" aria-label={label}><i /></span>
      ) : (
        <span className="sg-a-unread" role="img" aria-label={label} />
      )
    case "b":
      return state === "running" ? (
        <svg className="sg-b-ring" viewBox="0 0 14 14" role="img" aria-label={label}>
          <circle className="track" cx="7" cy="7" r="5.5" />
          <circle className="arc" cx="7" cy="7" r="5.5" />
        </svg>
      ) : (
        <span className="sg-b-unread" role="img" aria-label={label}><i /></span>
      )
    case "c":
      return state === "running" ? (
        <span className="sg-c-status" role="img" aria-label={label}>
          <span className="sg-c-shimmer">工作中</span>
          <span className="sg-c-ticker"><b /><b /><b /></span>
        </span>
      ) : (
        <span className="sg-c-unread" role="img" aria-label={label}><i />新回复</span>
      )
    case "d":
      return state === "running" ? (
        <>
          <span className="sg-d-edge" aria-hidden />
          <span className="sg-d-sweep" role="img" aria-label={label} />
        </>
      ) : (
        <span className="sg-d-unread" role="img" aria-label={label} />
      )
    case "f":
      return state === "running" ? (
        <span className="sg-f-grid" role="img" aria-label={label}>
          {F_CHEVRON.map((d, i) => (
            <span key={i} className="on" style={{ "--delay": `${d}ms` } as CSSProperties} />
          ))}
        </span>
      ) : (
        <span className="sg-f-grid unread" role="img" aria-label={label}>
          {F_CHEVRON.map((_, i) => (
            <span key={i} className={i === 4 ? "hit" : undefined} />
          ))}
        </span>
      )
  }
}
