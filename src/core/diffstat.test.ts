import { describe, expect, it } from "vitest"

import { countContentLines, diffStatFromOldNew, diffStatFromUnifiedDiff } from "./diffstat"

describe("diffStatFromOldNew", () => {
  it("oldText 为空(null/undefined)视为全量 added——新建文件", () => {
    expect(diffStatFromOldNew(null, "a\nb\nc")).toEqual({ added: 3, deleted: 0 })
    expect(diffStatFromOldNew(undefined, "a\nb")).toEqual({ added: 2, deleted: 0 })
    // 尾换行只算一行,不产生幽灵空行
    expect(diffStatFromOldNew(null, "a\nb\n")).toEqual({ added: 2, deleted: 0 })
    expect(diffStatFromOldNew(null, "")).toEqual({ added: 0, deleted: 0 })
  })

  it("共同前缀/后缀行去重,只数中间改动段", () => {
    const oldText = ["keep", "old1", "old2", "old3", "tail"].join("\n")
    const newText = ["keep", "new1", "tail"].join("\n")
    expect(diffStatFromOldNew(oldText, newText)).toEqual({ added: 1, deleted: 3 })
  })

  it("全文替换(无公共行)两边全数", () => {
    expect(diffStatFromOldNew("x\ny", "1\n2\n3")).toEqual({ added: 3, deleted: 2 })
  })

  it("内容相同为 0/0,不产幽灵统计", () => {
    expect(diffStatFromOldNew("a\nb", "a\nb")).toEqual({ added: 0, deleted: 0 })
  })

  it("头尾同时改动:前缀与后缀各自去重且互不重叠", () => {
    expect(diffStatFromOldNew("same\nm1\nm2\nsame2", "same\nn1\nn2\nsame2")).toEqual({
      added: 2,
      deleted: 2,
    })
  })

  it("中部的相同行不去重(算法只去前缀/后缀,口径如此)", () => {
    expect(diffStatFromOldNew("old\nmid\nend", "new\nmid\nfinish")).toEqual({
      added: 3,
      deleted: 3,
    })
  })
})

describe("diffStatFromUnifiedDiff", () => {
  it("排除 +++/--- 文件头", () => {
    const diff = ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n")
    expect(diffStatFromUnifiedDiff(diff)).toEqual({ added: 1, deleted: 1 })
  })

  it("纯新增", () => {
    expect(diffStatFromUnifiedDiff("+a\n+b\n+c")).toEqual({ added: 3, deleted: 0 })
  })

  it("纯删除", () => {
    expect(diffStatFromUnifiedDiff("-a\n-b")).toEqual({ added: 0, deleted: 2 })
  })

  it("上下文行与 No-newline 标记不计", () => {
    const diff = [" context", "-gone", "+here", "\\ No newline at end of file"].join("\n")
    expect(diffStatFromUnifiedDiff(diff)).toEqual({ added: 1, deleted: 1 })
  })
})

describe("countContentLines(Codex add/delete 全文行数口径)", () => {
  it("只去掉一个尾换行,空文件为 0 行", () => {
    expect(countContentLines("a\nb\nc")).toBe(3)
    expect(countContentLines("a\nb\n")).toBe(2)
    expect(countContentLines("")).toBe(0)
  })
})
