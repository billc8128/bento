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

/** 官方项目 mark 的统一尺寸适配层；Pi 没有独立图形资产，使用标准 π 图标。 */
export function HarnessIcon({ id, className, ...props }: HarnessIconProps) {
  if (id === "pi") {
    return (
      <span
        className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}
        aria-hidden
        {...props}
      >
        <Pi className="size-full" strokeWidth={1.8} />
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
        <img src={hermesIcon} alt="" draggable={false} className="size-full object-contain dark:invert" />
      </span>
    )
  }

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
      />
    </span>
  )
}
