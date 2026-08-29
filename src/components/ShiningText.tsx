import { motion } from "motion/react"

import { cn } from "@/lib/utils"

/** running 态流光文字:一道高光匀速扫过,循环往复 */
export function ShiningText({ text, className }: { text: React.ReactNode; className?: string }) {
  return (
    <motion.span
      className={cn(
        "bg-[linear-gradient(110deg,var(--muted-foreground),35%,#fff,50%,var(--muted-foreground),75%,var(--muted-foreground))] bg-[length:200%_100%] bg-clip-text text-transparent",
        className,
      )}
      initial={{ backgroundPosition: "200% 0" }}
      animate={{ backgroundPosition: "-200% 0" }}
      transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
    >
      {text}
    </motion.span>
  )
}
