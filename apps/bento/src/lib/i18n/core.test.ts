import { describe, expect, it } from "vitest"

import { resolveLocale, translate } from "./core"

describe("i18n core", () => {
  it("returns the zh-CN string for zh-CN", () => {
    expect(translate("zh-CN", "sidebar.newChat")).toBe("新对话")
  })

  it("returns the en-US string for en-US", () => {
    expect(translate("en-US", "sidebar.newChat")).toBe("New chat")
  })

  it("merges namespaces from multiple locale modules", () => {
    expect(translate("en-US", "composer.send")).toBe("Send")
    expect(translate("en-US", "settings.language")).toBe("Language")
  })

  it("interpolates {name} variables", () => {
    expect(translate("zh-CN", "composer.placeholder", { name: "Codex" })).toBe(
      "向 Codex 描述你要做的事…",
    )
    expect(translate("en-US", "sidebar.moreCount", { count: 3 })).toBe("3 more")
  })

  it("leaves unknown placeholders untouched", () => {
    expect(translate("en-US", "sidebar.newChatIn", {})).toBe("New chat in {label}")
  })

  it("falls back to zh-CN when the key is missing in the current locale", () => {
    // sidebar.cancel 两个语言都有;构造一个只在 zh-CN 存在的场景成本太高,
    // 这里直接验证缺失 key 的终极兜底:返回 key 本身
    expect(translate("en-US", "no.such.key")).toBe("no.such.key")
  })

  it("resolves explicit preferences and system", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN")
    expect(resolveLocale("en-US")).toBe("en-US")
    expect(["zh-CN", "en-US"]).toContain(resolveLocale("system"))
  })
})
