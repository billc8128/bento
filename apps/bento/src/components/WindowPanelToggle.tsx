import { cn } from "@/lib/utils"

export function PanelStateIcon({
  side,
  expanded,
  peekHint = false,
  className,
}: {
  side: "left" | "right"
  expanded: boolean
  /** 收起态下的悬停预告:分隔线长到半高,提示 peek 即将展开 */
  peekHint?: boolean
  className?: string
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path
        d={side === "left" ? "M9 5.5v13" : "M15 5.5v13"}
        className={cn(
          "origin-center transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
          !expanded && !peekHint && (side === "left" ? "-translate-x-0.5 scale-y-[0.34]" : "translate-x-0.5 scale-y-[0.34]"),
          !expanded && peekHint && (side === "left" ? "-translate-x-0.5 scale-y-[0.68]" : "translate-x-0.5 scale-y-[0.68]"),
        )}
      />
    </svg>
  )
}

export function WindowPanelToggle({
  label,
  className,
  onClick,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  label: string
  className?: string
  onClick: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "window-panel-toggle flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-100 ease-out hover:bg-muted hover:text-foreground active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:active:scale-100 motion-reduce:transition-none",
        className,
      )}
    >
      {children}
    </button>
  )
}
