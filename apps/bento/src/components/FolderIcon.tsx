import { IconFolder, IconFolderOpen } from "@tabler/icons-react"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

type FolderIconProps = ComponentProps<typeof IconFolder> & { open?: boolean }

/** 会话目录分组的公开图标对；展开状态直接切换语义图标。 */
export function FolderIcon({ open = false, className, ...props }: FolderIconProps) {
  const Icon = open ? IconFolderOpen : IconFolder
  return <Icon aria-hidden stroke={1.8} className={cn("shrink-0", className)} {...props} />
}
