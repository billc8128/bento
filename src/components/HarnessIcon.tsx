import type { HTMLAttributes } from "react"
import { Pi } from "lucide-react"

import hermesIcon from "@lobehub/icons-static-svg/icons/hermesagent.svg"

import claudeCodeIcon from "@/assets/harnesses/claude-code.svg"
import codexIcon from "@/assets/harnesses/codex.svg"
import { kimiIcon } from "@/assets/harnesses/kimi"
import ompIcon from "@/assets/harnesses/omp.svg"
import openCodeIcon from "@/assets/harnesses/opencode.svg"
import type { HarnessId } from "@/core/harness"
import { cn } from "@/lib/utils"

type HarnessIconProps = HTMLAttributes<HTMLSpanElement> & { id: HarnessId }

const ASSETS: Partial<Record<HarnessId, string>> = {
  codex: codexIcon,
  "claude-code": claudeCodeIcon,
  kimi: kimiIcon,
  opencode: openCodeIcon,
  omp: ompIcon,
}

/** 各图标源在自家网格里的留白不同,同一 size 盒子里字形视觉大小与左缘会漂移
    (满幅瓦片 vs 官方 mark vs lucide 描边,实测左缘差 2~6px)。按源做光学缩放,
    以满幅瓦片(kimi / opencode / omp 底板)为 1 基准;transform 不参与布局,
    不挤动文字轴。新增 harness 时先量字形在 viewBox 里的占比再定系数。 */
const OPTICAL_SCALE: Partial<Record<HarnessId, number>> = {
  codex: 1.25, // 40 网格,字形 ~32:四周留白 10%
  "claude-code": 1.25, // 同上
  hermes: 1.1, // lobehub 24 网格,留白 ~1/24
}

/** 垂直光学补偿(px,向下为正)。几何居中后大多数 mark 与文字质心已对齐
    (实测 ±0.5px);π 例外——字形头重(横杠在顶),质心比 bbox 中心高 ~1.5px,
    需要额外下沉才与相邻 mark 视觉同轴。translateY 写在 scale 之前,落在屏幕空间。 */
const OPTICAL_NUDGE_Y: Partial<Record<HarnessId, number>> = {
  pi: 2,
}

const opticalTransform = (id: HarnessId): string | undefined => {
  const parts: string[] = []
  const nudge = OPTICAL_NUDGE_Y[id]
  if (nudge) parts.push(`translateY(${nudge}px)`)
  const scale = OPTICAL_SCALE[id]
  if (scale) parts.push(`scale(${scale})`)
  return parts.length ? parts.join(" ") : undefined
}

/** 官方项目 mark 的统一尺寸适配层；Pi 没有独立图形资产，使用标准 π 图标。 */
export function HarnessIcon({ id, className, ...props }: HarnessIconProps) {
  if (id === "pi") {
    return (
      <span
        className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}
        aria-hidden
        {...props}
      >
        {/* lucide 24 网格字形只占 ~16px,留白全场最大:放大补齐并加粗描边,
            否则与满幅 mark 并列时小一圈还向右漂 */}
        <Pi className="size-full" strokeWidth={2} style={{ transform: `${opticalTransform("pi")} scale(1.32)` }} />
      </span>
    )
  }

  if (id === "hermes") {
    return (
      <span
        className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}
        aria-hidden
        {...props}
      >
        <img
          src={hermesIcon}
          alt=""
          draggable={false}
          className="size-full object-contain dark:invert"
          style={{ transform: opticalTransform("hermes") }}
        />
      </span>
    )
  }

  const transform = opticalTransform(id)
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center",
        id === "omp" && "rounded bg-[#131010] p-0.5",
        className,
      )}
      aria-hidden
      {...props}
    >
      {/* codex/claude 的 SVG 是 currentColor,但 <img> 不继承颜色,恒为黑;
          kimi 是深底 PNG——深色模式下反白。opencode/omp 自带亮字形,不用动 */}
      <img
        src={ASSETS[id]}
        alt=""
        draggable={false}
        className={cn(
          "size-full object-contain",
          (id === "codex" || id === "claude-code" || id === "kimi") && "dark:invert",
        )}
        style={transform ? { transform } : undefined}
      />
    </span>
  )
}
