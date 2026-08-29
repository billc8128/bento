import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    // type="scroll":滚动条只在滚动时短暂出现(macOS overlay 风格),
    // 不再常驻一条灰色长条压在内容边上
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      type="scroll"
      scrollHideDelay={600}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        // absolute:让滚动条浮在内容上而不占布局宽度,否则滚动区会比同宽的输入框窄一条
        "absolute flex touch-none p-px transition-colors select-none data-horizontal:bottom-0 data-horizontal:left-0 data-horizontal:h-1.5 data-horizontal:w-full data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:top-0 data-vertical:right-0 data-vertical:h-full data-vertical:w-1.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-muted-foreground/30"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
