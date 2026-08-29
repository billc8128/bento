/**
 * 动态按钮:hover 时圆形从中心扩散填满、文字反白。
 * arrows=true(默认,适合大按钮)时左右箭头进出、文字位移;
 * arrows=false(胶囊/小尺寸)只留扩散反白,箭头在小尺寸下会压文字。
 * 配色全部走主题 token(foreground/background),不写死颜色,五套主题通吃。
 */

import { ArrowRight } from "lucide-react"

import { cn } from "@/lib/utils"

type FlowButtonProps = {
  text?: string
  /** 无箭头版本用于小尺寸胶囊 */
  arrows?: boolean
  /**
   * invert=true(默认):hover 填 foreground 深色、文字反白。
   * invert=false:hover 只泛浅灰、文字不变色——带深色图标(harness 图标)时用,
   * 深色填充会把图标吃掉。
   */
  invert?: boolean
  children?: React.ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">

export function FlowButton({
  text = "Modern Button",
  arrows = true,
  invert = true,
  children,
  className,
  type = "button",
  ...rest
}: FlowButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "group relative flex cursor-pointer items-center gap-1 overflow-hidden rounded-[100px] border-[1.5px] border-foreground/40 bg-transparent px-8 py-3 text-sm font-semibold text-foreground transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:rounded-[12px] active:scale-[0.95]",
        invert && "hover:border-transparent hover:text-background",
        className,
      )}
      {...rest}
    >
      {arrows && (
        <ArrowRight className="absolute left-[-25%] z-[9] size-4 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:left-4" />
      )}

      <span
        className={cn(
          "relative z-[1] flex items-center gap-1 transition-all duration-[800ms] ease-out",
          // 位移是给飞入的左箭头腾位置;无箭头时原地不动
          arrows && "-translate-x-3 group-hover:translate-x-3",
        )}
      >
        {children ?? text}
      </span>

      {/* 扩散圆:尺寸写大,靠 overflow-hidden 裁剪,小按钮也同样填满 */}
      <span
        className={cn(
          "absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-[50%] opacity-0 transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:size-[220px] group-hover:opacity-100",
          invert ? "bg-foreground" : "bg-muted",
        )}
      />

      {arrows && (
        <ArrowRight className="absolute right-4 z-[9] size-4 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:right-[-25%]" />
      )}
    </button>
  )
}
