/**
 * 聊天场景的单换行修复。模型常输出纯 \n 换行(逐行列文件名、逐行步骤),
 * CommonMark 会把单个换行折叠成空格,导致这些行糊成一行。这里在代码块、
 * 列表、表格等块结构之外,把单个 \n 转成 Markdown 硬换行(行尾两个空格),
 * 让渲染结果保留原始换行。
 */

const FENCE = /^\s*(```|~~~)/
// 已经靠换行表达结构的块语法不参与:标题、列表、引用、表格、链接定义、缩进代码、HTML
const BLOCK = /^\s*(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|\|| {4}|\[[^\]]*\]:|<\/?[a-zA-Z])/

export function hardBreaks(text: string): string {
  const lines = text.split("\n")
  let fenced = false
  return lines
    .map((line, i) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      const next = lines[i + 1]
      if (fenced || next === undefined || line.trim() === "" || next.trim() === "") {
        return line
      }
      if (BLOCK.test(line) || BLOCK.test(next)) return line
      return line + "  "
    })
    .join("\n")
}
