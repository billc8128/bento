import { memo, useEffect, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import { hardBreaks } from "@/lib/markdown-breaks"

/** 模型常把本地产物写成绝对路径链接(如 [下载 Logo](/Users/…/icon.png));
 * file:// 与裸绝对路径都认,非绝对路径(http/相对)不动。 */
function localFilePath(href: string | undefined): string | null {
  if (!href) return null
  const raw = href.startsWith("file://") ? decodeURIComponent(href.slice(7)) : href
  return raw.startsWith("/") ? raw : null
}

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|#|$)/i

/** 本地图片:经 IPC 读成 data URL 内联渲染;读不到就退成可点击的文件链接。 */
function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.bento
      ?.readFileDataUrl(path)
      .then((result) => {
        if (alive && result?.dataUrl) setUrl(result.dataUrl)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [path])
  if (!url) return <LocalFileLink path={path}>{alt || path}</LocalFileLink>
  return (
    <img
      src={url}
      alt={alt ?? ""}
      title={`${path}(点击在访达中打开)`}
      onClick={() => void window.bento?.openPath(path)}
      className="my-2 max-h-72 max-w-full cursor-zoom-in rounded-lg border border-border object-contain"
    />
  )
}

function LocalFileLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a
      href={`file://${path}`}
      title={path}
      onClick={(e) => {
        e.preventDefault()
        void window.bento?.openPath(path)
      }}
      className="cursor-pointer text-primary underline underline-offset-2"
    >
      {children}
    </a>
  )
}

/**
 * 助手正文的 Markdown 渲染。样式全走主题 token,字号与聊天流对齐(text-sm);
 * 代码块不做语法高亮库,先用等宽 + 底色,保持包体小。
 * 单个 \n 经 hardBreaks 转成真实换行——模型的纯换行输出不会再糊成一行。
 */
// memo(text/className 值相等即跳过):流式期间只有文本真正变化的 draft 会重解析,
// 历史消息与纯 tool 更新帧不再重复 parse markdown
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
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
          a: ({ children, href }) => {
            const local = localFilePath(href)
            if (local) {
              return IMAGE_PATH.test(local)
                ? <LocalImage path={local} alt={typeof children === "string" ? children : undefined} />
                : <LocalFileLink path={local}>{children}</LocalFileLink>
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {children}
              </a>
            )
          },
          img: ({ src, alt }) => {
            const local = localFilePath(typeof src === "string" ? src : undefined)
            if (local) return <LocalImage path={local} alt={alt} />
            return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-2 max-w-full rounded-lg" />
          },
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
})
