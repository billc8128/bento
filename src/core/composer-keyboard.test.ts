import { describe, expect, it } from "vitest"

import { shouldSubmitComposerKey } from "./composer-keyboard"

describe("shouldSubmitComposerKey", () => {
  it("中文输入法确认候选时不发送", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false)
  })

  it("普通 Enter 发送，Shift+Enter 换行", () => {
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true)
    expect(shouldSubmitComposerKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false)
  })
})
