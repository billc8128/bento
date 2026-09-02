import { describe, expect, it } from "vitest"

import source from "./TurnActivity.tsx?raw"

/**
 * P2 静态守护:TurnActivity 的 sticky 延迟挂载标记(contentMounted)只允许在
 * 事件回调(applyOpen / onOpenChange)里翻转为 true。render 阶段 setState 会
 * 造成同步二次渲染,违背流式性能目标——这里用源码模式检查兜底,防止回潮。
 */

describe("TurnActivity 延迟挂载静态检查", () => {
  it("不允许 render-phase setState 翻转 sticky 挂载标记", () => {
    // 单行与带花括号的变体都禁止
    expect(source).not.toMatch(/if\s*\(\s*open[^)]*\)\s*setContentMounted\s*\(\s*true\s*\)/)
    expect(source).not.toMatch(/if\s*\(\s*open[^)]*\)\s*\{\s*setContentMounted\s*\(\s*true\s*\)/)
  })

  it("setContentMounted(true) 只出现在事件回调上下文中", () => {
    const occurrences = [...source.matchAll(/setContentMounted\s*\(\s*true\s*\)/g)]
    expect(occurrences.length).toBe(3) // ToolRow / TraceCollapsible / TurnActivity 各一处
    for (const match of occurrences) {
      const context = source.slice(Math.max(0, match.index - 200), match.index)
      expect(context).toMatch(/applyOpen|onOpenChange/)
    }
  })
})
