/**
 * diff 统计纯函数(TRACE_DATA_PLAN §4):只出数字,不存 diff 全文。
 * 任一层解析失败/字段缺失由调用方降级——这里不做容错以外的表演。
 */

export type DiffStat = { added: number; deleted: number }

/**
 * 全量行数:去掉「一个」尾部换行后按全部行数计。
 * 不数「非空行」——unified diff 里空白行照样计 +,两种口径必须一致;
 * 也不能直接 split("\n") 取 length,"a\n" 会多出一个空尾巴行。
 */
export function countContentLines(text: string): number {
  const stripped = text.replace(/\n$/, "")
  return stripped === "" ? 0 : stripped.split("\n").length
}

/**
 * 新旧文本逐行比较:去掉共同前缀/后缀行,中间段旧行记 deleted、新行记 added。
 * oldText 为空(新建文件)视为全量 added。
 */
export function diffStatFromOldNew(
  oldText: string | null | undefined,
  newText: string,
): DiffStat {
  if (!oldText) return { added: countContentLines(newText), deleted: 0 }
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    added: newLines.length - prefix - suffix,
    deleted: oldLines.length - prefix - suffix,
  }
}

/** unified diff 统计:+/- 开头行计数,排除 +++/--- 文件头 */
export function diffStatFromUnifiedDiff(diffText: string): DiffStat {
  let added = 0
  let deleted = 0
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) added += 1
    else if (line.startsWith("-")) deleted += 1
  }
  return { added, deleted }
}
