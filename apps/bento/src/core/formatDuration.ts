/**
 * 耗时格式化(TRACE_DATA_PLAN §3.5):分桶按原始 ms 判,显示一律 Math.floor
 * 截断——否则 9.95s 四舍五入成「10.0s」、59.9s 成「60s」,越桶展示。
 */

/** < 100ms → `<0.1s`(同 tick 批量事件的 at 差常为 0,不能渲染成 `0.0s`) */
export function formatDuration(ms: number): string {
  if (ms < 100) return "<0.1s"
  if (ms < 10_000) {
    const tenths = Math.floor(ms / 100)
    return `${Math.floor(tenths / 10)}.${tenths % 10}s`
  }
  if (ms < 60_000) {
    return `${Math.floor(ms / 1000)}s`
  }
  if (ms < 3_600_000) {
    const totalSeconds = Math.floor(ms / 1000)
    return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`
  }
  const totalMinutes = Math.floor(ms / 60_000)
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, "0")}m`
}

/**
 * 回合用量格式化(TRACE_DATA_PLAN §7 P4):低调追加在回合摘要的耗时之后。
 * 只格式化存在的字段;都没有则不产生文本。
 */
export function formatUsage(usage: { inputTokens?: number; outputTokens?: number; cost?: number }): string {
  const parts: string[] = []
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  if (tokens > 0) {
    parts.push(
      tokens >= 1_000_000
        ? `${(tokens / 1_000_000).toFixed(1)}M tok`
        : tokens >= 1_000
          ? `${Math.floor(tokens / 100) / 10}k tok`
          : `${tokens} tok`,
    )
  }
  if (usage.cost !== undefined) parts.push(`$${usage.cost.toFixed(2)}`)
  return parts.join(" · ")
}
