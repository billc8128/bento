import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

import { I18nProvider } from "@/lib/i18n"
import { Markdown } from "./Markdown"

/**
 * 本地路径解码回归:react-markdown 会把 URL 里的空格/非 ASCII percent-encode,
 * 不解码的话 readFileDataUrl / openPath 拿到的都是不存在的路径
 * (真实事故:codex imagegen 产物固定在 "~/Library/Application Support/..." 下,
 * 永远带空格,图片全部退成死链接)。
 * SSR 下 LocalImage 的 useEffect 不跑,输出的是兜底 LocalFileLink——
 * 它的 href 就是会传给 IPC / shell 的路径,正好可断言。
 */
function render(text: string, cwd?: string): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <Markdown text={text} cwd={cwd} />
    </I18nProvider>,
  )
}

describe("Markdown 本地文件路径解码", () => {
  it("带空格的绝对路径(角括号目的地)解码回真实路径", () => {
    const html = render("![视觉稿](</Users/bcc/Library/Application Support/bento/x.png>)")
    expect(html).toContain("file:///Users/bcc/Library/Application Support/bento/x.png")
    expect(html).not.toContain("%20")
  })

  it("相对路径里的非 ASCII 在锚定 cwd 后解码", () => {
    const html = render("[报告](docs/报告.md)", "/Users/bcc/Desktop/buzzland")
    expect(html).toContain("file:///Users/bcc/Desktop/buzzland/docs/报告.md")
    expect(html).not.toContain("%E6%8A%A5")
  })

  it("文件名里的字面 % 不会因为解码抛错而丢失", () => {
    const html = render("![图](/tmp/100%.png)")
    expect(html).toContain("file:///tmp/100%.png")
  })

  it("http 图片不受影响,仍走普通 <img>", () => {
    const html = render("![稿](http://127.0.0.1:18743/onboarding.png)")
    expect(html).toContain('<img src="http://127.0.0.1:18743/onboarding.png"')
  })
})
