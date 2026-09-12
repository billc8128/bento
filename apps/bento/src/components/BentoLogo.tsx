import type { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

const publicAsset = (name: string) => `${import.meta.env.BASE_URL}${name}`

/** Bento 品牌标识：深浅表面使用同一几何、不同前景资产。 */
export function BentoLogo({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      aria-hidden
      {...props}
    >
      <img
        src={publicAsset("bento-logo.png")}
        alt=""
        draggable={false}
        className="size-full object-contain dark:hidden"
      />
      <img
        src={publicAsset("bento-logo-dark.png")}
        alt=""
        draggable={false}
        className="hidden size-full object-contain dark:block"
      />
    </span>
  )
}
