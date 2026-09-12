import { describe, expect, it } from "vitest"

import { browserRevealPanelWidth, sidePanelsFit } from "./workspace-layout"

describe("browserRevealPanelWidth", () => {
  it("窄窗口优先为 Chat 保留空间，宽窗口仍使用标准浏览器宽度", () => {
    expect(browserRevealPanelWidth(1017, 220)).toBe(320)
    expect(browserRevealPanelWidth(1200, 220)).toBe(460)
    expect(browserRevealPanelWidth(1496, 220)).toBe(460)
  })
})

describe("sidePanelsFit", () => {
  it("只在左右栏与主区最小宽度都放得下时同时展开", () => {
    expect(sidePanelsFit(790, 220, 420, 320)).toBe(false)
    expect(sidePanelsFit(960, 220, 420, 320)).toBe(true)
    expect(sidePanelsFit(1250, 220, 420, 460)).toBe(true)
  })
})
