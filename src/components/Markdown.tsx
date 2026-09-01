import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import { hardBreaks } from "@/lib/markdown-breaks"

/**
 * 助手正文的 Markdown 渲染。样式全走主题 token,字号与聊天流对齐(text-sm);
 * 代码块不做语法高亮库,先用等宽 + 底色,保持包体小。
 * 单个 \n 经 hardBreaks 转成真实换行——模型的纯换行输出不会再糊成一行。
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 wrap-anywhere text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2.5 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2.5 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2.5 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? "")
            if (isBlock) return <code className="font-mono text-xs">{children}</code>
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
            )
          },
          pre: ({ children }) => (
            <pre className="mb-2.5 overflow-x-auto rounded-md border border-border bg-chrome p-3 leading-normal last:mb-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mb-2.5 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          // 表格只画横向行线:满格描边会让表格变成整段正文里最重的元素
          th: ({ children }) => (
            <th className="border-b border-border px-2.5 py-1.5 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border/60 px-2.5 py-1.5">{children}</td>,
          hr: () => <hr className="my-4 border-border" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        }}
      >
        {hardBreaks(text)}
      </ReactMarkdown>
    </div>
  )
}
