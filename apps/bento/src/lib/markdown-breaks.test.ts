import { describe, expect, it } from "vitest"

import { hardBreaks } from "./markdown-breaks"

describe("hardBreaks", () => {
  it("普通连续行补硬换行", () => {
    expect(hardBreaks("App.tsx\nassets\ncomponents")).toBe("App.tsx  \nassets  \ncomponents")
  })

  it("空行分段的段落不动", () => {
    expect(hardBreaks("第一段\n\n第二段")).toBe("第一段\n\n第二段")
  })

  it("列表结构不动", () => {
    expect(hardBreaks("- a\n- b\n1. c\n2. d")).toBe("- a\n- b\n1. c\n2. d")
  })

  it("代码块内容原样保留", () => {
    expect(hardBreaks("```ts\nconst a = 1\nconst b = 2\n```")).toBe(
      "```ts\nconst a = 1\nconst b = 2\n```",
    )
  })

  it("表格行不动", () => {
    expect(hardBreaks("| a | b |\n| - | - |\n| 1 | 2 |")).toBe("| a | b |\n| - | - |\n| 1 | 2 |")
  })

  it("引用和标题不动", () => {
    expect(hardBreaks("## 标题\n> 引用\n> 续行")).toBe("## 标题\n> 引用\n> 续行")
  })

  it("混合内容:段落后的纯文本行补硬换行", () => {
    expect(hardBreaks("我只列目录。\n\nApp.tsx\nassets")).toBe("我只列目录。\n\nApp.tsx  \nassets")
  })
})
