import { describe, expect, it } from "vitest"

import { browserRevealPanelWidth } from "./workspace-layout"

describe("browserRevealPanelWidth", () => {
  it("窄窗口优先为 Chat 保留空间，宽窗口仍使用标准浏览器宽度", () => {
    expect(browserRevealPanelWidth(1017, 220)).toBe(320)
    expect(browserRevealPanelWidth(1200, 220)).toBe(460)
    expect(browserRevealPanelWidth(1496, 220)).toBe(460)
  })
})
