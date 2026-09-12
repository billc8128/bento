import type { HarnessUsage } from "../../src/core/events"

/** 各 driver 把 vendor 用量字段收敛成 HarnessUsage:只保留数值字段,
 * 一个都没有时不产生 usage(缺省降级)。四家 driver 共用,避免散落同款过滤。 */
export function harnessUsage(parts: {
  inputTokens?: unknown
  outputTokens?: unknown
  cost?: unknown
}): HarnessUsage | undefined {
  const usage: HarnessUsage = {}
  if (typeof parts.inputTokens === "number") usage.inputTokens = parts.inputTokens
  if (typeof parts.outputTokens === "number") usage.outputTokens = parts.outputTokens
  if (typeof parts.cost === "number") usage.cost = parts.cost
  return Object.keys(usage).length > 0 ? usage : undefined
}
