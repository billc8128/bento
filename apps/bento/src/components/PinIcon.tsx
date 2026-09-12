import type { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

/**
 * 置顶图标(P7 书签旗):自绘,currentColor 跟随主题。
 * filled=已置顶实心;描边态用于 hover 快捷按钮的未置顶态。
 */
export function PinIcon({
  filled = true,
  className,
  ...props
}: HTMLAttributes<SVGSVGElement> & { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn("shrink-0", className)}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? 0 : 1.5}
      {...props}
    >
      <path d="M4.6 2.2c0-.4.3-.7.7-.7h5.4c.4 0 .7.3.7.7v11.3a.4.4 0 0 1-.63.33L8 11.6l-2.77 2.23a.4.4 0 0 1-.63-.33V2.2z" />
    </svg>
  )
}
