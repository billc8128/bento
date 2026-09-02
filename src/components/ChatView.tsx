import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  Check,
  ArrowDown,
  ChevronDown,
  FileText,
  ImageIcon,
  Pencil,
  Search,
  Terminal,
  TriangleAlert,
  Forward,
  X,
} from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Markdown } from "@/components/Markdown"
import { ShiningText } from "@/components/ShiningText"
import { cn } from "@/lib/utils"
import { useTraits } from "@/lib/style-context"
import { formatDuration, formatUsage } from "@/core/formatDuration"
import type { ActivityItem, Message, ToolCall } from "@/core/types"
import {
  CHAT_CONTENT_GUTTER,
  COLUMN,
  type ComposerShape,
  type MessageShape,
  type StyleTraits,
} from "@/data/styles"

// Message 是按 role 判别的联合,子组件各取自己那一支
type UserMsg = Extract<Message, { role: "user" }>
type AssistantMsg = Extract<Message, { role: "assistant" }>

const TOOL_ICON = {
  read: FileText,
  edit: Pencil,
  bash: Terminal,
  search: Search,
} as const

const TOOL_LABEL = {
  read: "读取",
  edit: "编辑",
  bash: "执行",
  search: "搜索",
} as const

/** 工具调用行:图标 + 动作 + 目标 + diff 统计 + 结果 + 耗时,状态靠图标而非仅颜色。
 * 带 output 的行可点击展开输出面板(§7,复用 collapsible-section 折叠动效);
 * 搜索行带 url 时目标渲染为外链。字段都可选,旧数据自动隐藏。 */
function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(tool.output)

  const toggleKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      setOpen((v) => !v)
    }
  }

  return expandable ? (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={toggleKeys}
        className="trace-row flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-150 hover:bg-muted/50"
      >
        <ToolRowMain tool={tool} open={open} />
      </div>
      <CollapsibleContent className="collapsible-section">
        <pre className="mb-1 max-h-48 overflow-y-auto rounded-md border border-border bg-chrome px-2.5 py-2 font-mono type-micro whitespace-pre-wrap break-words text-muted-foreground">
          {tool.output}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  ) : (
    <div className="trace-row flex h-7 items-center gap-2 px-1.5 text-xs">
      <ToolRowMain tool={tool} />
    </div>
  )
}

/** 行内主体:图标/标签/目标/统计/耗时/状态,展开行多一枚旋转指示的 chevron */
function ToolRowMain({ tool, open }: { tool: ToolCall; open?: boolean }) {
  const Icon = TOOL_ICON[tool.kind]
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{TOOL_LABEL[tool.kind]}</span>
      {tool.url ? (
        <a
          href={tool.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 truncate font-mono text-foreground/85 underline decoration-border underline-offset-2 hover:decoration-foreground"
        >
          {tool.target}
        </a>
      ) : (
        <code className="min-w-0 truncate font-mono text-foreground/85">{tool.target}</code>
      )}
      <span className="flex-1" />
      {/* 收缩优先级:target/detail 可截断,diff/duration/图标不收缩 */}
      {tool.diffs?.map((d) => (
        <span key={d.path} className="shrink-0 font-mono type-micro tabular-nums">
          <span className="text-ok">+{d.added}</span>
          <span className="text-err"> −{d.deleted}</span>
        </span>
      ))}
      {tool.detail && (
        <span className="min-w-0 truncate type-micro tabular-nums text-muted-foreground/75">
          {tool.detail}
        </span>
      )}
      {/* running 中不存在 durationMs,spinner 保持唯一动态元素 */}
      {tool.durationMs !== undefined && (
        <span className="shrink-0 type-micro tabular-nums text-muted-foreground/75">
          {formatDuration(tool.durationMs)}
        </span>
      )}
      {tool.status === "done" && <Check className="size-3.5 shrink-0 text-ok" />}
      {tool.status === "running" && (
        <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current text-brand" />
      )}
      {tool.status === "failed" && <TriangleAlert className="size-3.5 shrink-0 text-err" />}
      {tool.output && (
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300",
            open && "rotate-180",
          )}
        />
      )}
    </>
  )
}

/** 轨迹头四角星:运行中亮,落定后暗下去 */
function TraceStar({ working }: { working: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden
      fill="currentColor"
      className={cn("shrink-0", working ? "text-foreground/70" : "text-muted-foreground/60")}
    >
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  )
}
/**
 * agent 轨迹:thinking 与工具调用收进同一个可展开块,放在回答之前——
 * 时序上它们本来就发生在回答之前,正文第一眼看到的就是答案。
 * 运行中自动展开、落定后自动收成一行摘要,用户手动展开/收起后以手动为准。
 * flat 形态的竖线从星标正下方长出、随内容长高;boxed 形态收进卡片。
 */
function TraceBlock({
  m,
  shape,
  running,
}: {
  m: AssistantMsg
  shape: StyleTraits["tools"]
  /** 显式传入:running = pending && m.id === "draft"。无工具回合流式中
   * settled 在数据上恒真,靠数据推「正在思考」是死分支(§5.2) */
  running: boolean
}) {
  const tools = m.tools ?? []
  const settled = tools.every((t) => t.status !== "running")
  const failed = tools.filter((t) => t.status === "failed").length
  const active = running || !settled
  const fallbackActivity: ActivityItem[] = [
    ...(m.thinking ? [{ id: "thinking", kind: "thinking" as const, text: m.thinking }] : []),
    ...tools.map((tool, index) => ({ id: `tool-${index}`, kind: "tool" as const, tool })),
  ]
  const activity = m.activity?.length ? m.activity : fallbackActivity
  const visibleActivity = active ? activity.slice(-4) : activity
  const hiddenActivityCount = activity.length - visibleActivity.length
  // null = 跟随自动状态:跑的时候展开、落定收起;用户点过就听用户的
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? active
  const traceRef = useRef<HTMLDivElement>(null)
  const [lineHeight, setLineHeight] = useState(0)
  useLayoutEffect(() => {
    const el = traceRef.current
    if (!open || !el) return
    // 竖线跟随内容:流式追加新行、展开工具输出面板等任何高度变化都重新量高
    const measure = () => setLineHeight(el.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open])

  const summary =
    tools.length > 0
      ? `${m.thinking ? "思考并" : ""}使用了 ${tools.length} 个工具`
      : "思考完成"
  const usageText = m.usage && (m.usage.inputTokens || m.usage.outputTokens || m.usage.cost !== undefined)
    ? formatUsage(m.usage)
    : undefined

  const activityRows = (
    <>
      {hiddenActivityCount > 0 && (
        <p className="px-1.5 py-0.5 type-micro text-muted-foreground">
          之前还有 {hiddenActivityCount} 项活动
        </p>
      )}
      {visibleActivity.map((item) => {
        if (item.kind === "tool") return <ToolRow key={item.id} tool={item.tool} />
        if (item.kind === "steer") {
          return (
            <div key={item.id} className="flex items-start gap-2 rounded-md bg-secondary px-2 py-1.5 text-xs text-secondary-foreground">
              <Forward className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">你补充：{item.text}</span>
            </div>
          )
        }
        return (
          <p
            key={item.id}
            className={cn(
              "max-w-[64ch] px-1.5 py-0.5 text-xs leading-relaxed text-muted-foreground",
              active && "line-clamp-3",
            )}
          >
            {item.text}
          </p>
        )
      })}
    </>
  )

  const plan = m.plan ?? []
  const planRows =
    plan.length > 0 ? (
      <div className="mb-0.5 flex flex-col">
        {plan.map((item, i) => (
          <div key={i} className="flex items-center gap-2 px-1.5 py-0.5 text-xs text-muted-foreground">
            {item.status === "completed" && <Check className="size-3.5 shrink-0 text-ok" />}
            {item.status === "in_progress" && (
              <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current text-brand" />
            )}
            {item.status === "pending" && (
              <span className="size-3.5 shrink-0 rounded-full border-2 border-muted-foreground/30" />
            )}
            <span className="min-w-0 truncate">{item.content}</span>
          </div>
        ))}
      </div>
    ) : null

  const list =
    shape === "flat" ? (
      <div className="relative mt-0.5 ml-[7px] pl-4">
        {/* 竖线高度跟随内容,流式追加新行时自然伸长 */}
        <span
          aria-hidden
          className="absolute top-[-6px] left-0 w-px bg-border transition-[height] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]"
          style={{ height: lineHeight ? lineHeight + 2 : 0 }}
        />
        <div ref={traceRef} className="flex flex-col gap-1 py-1">
          {planRows}
          {activityRows}
        </div>
      </div>
    ) : (
      <div className="mt-1 divide-y divide-border overflow-hidden rounded-md border border-border bg-chrome">
        {planRows}
        {activityRows}
      </div>
    )

  return (
    <Collapsible open={open} onOpenChange={setManual} className="flex min-w-0 max-w-full flex-col">
      <CollapsibleTrigger className="group -ml-1.5 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-sm font-medium text-foreground/70 transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <TraceStar working={active} />
        {active ? (
          <ShiningText
            text={tools.length > 0 ? "正在工作" : "正在思考"}
            className="min-w-0 truncate"
          />
        ) : (
          <span className="min-w-0 truncate">
            {summary}
            {m.durationMs !== undefined && ` · ${formatDuration(m.durationMs)}`}
            {usageText && ` · ${usageText}`}
            {failed > 0 && <span className="text-err"> · {failed} 个失败</span>}
          </span>
        )}
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-section">{list}</CollapsibleContent>
    </Collapsible>
  )
}

function AttachmentChip({ name, kind }: { name: string; kind: "image" | "file" }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
      {kind === "image" ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
      <span className="font-mono">{name}</span>
    </span>
  )
}

function UserMessage({ m, shape }: { m: UserMsg; shape: MessageShape }) {
  // 协作来源:envelope 不落 JSONL,这里只展示可信 origin,不当正文渲染
  const fromSession = m.origin?.kind === "session" ? m.origin.title : null
  // 无气泡的风格里,说话人靠一个标签和左侧竖线交代,读起来像日志
  if (shape === "plain")
    return (
      <div
        data-message-origin={fromSession ? "session" : "human"}
        className="flex flex-col items-start gap-1.5"
      >
        <span className={cn(
          "type-micro font-mono font-medium uppercase tracking-wider",
          fromSession ? "text-muted-foreground" : "text-primary",
        )}>
          {fromSession ? `来自 ${fromSession}` : "你"}
        </span>
        <div className={cn(
          "min-w-0 max-w-full wrap-anywhere border-l-2 pl-3 text-sm leading-relaxed",
          fromSession
            ? "rounded-r-lg border-secondary-foreground/25 bg-secondary px-3 py-2 text-secondary-foreground"
            : "border-primary/40",
        )}>
          {m.text}
        </div>
        {m.attachments?.map((a) => (
          <AttachmentChip key={a.name} name={a.name} kind={a.kind} />
        ))}
      </div>
    )

  return (
    <div
      data-message-origin={fromSession ? "session" : "human"}
      className="flex min-w-0 flex-col items-end gap-1.5"
    >
      {/* 气泡保持胶囊感:3xl(20px)接近旧 --radius 1rem 时代的 2xl 观感 */}
      <div className={cn(
        "min-w-0 max-w-[75%] wrap-anywhere rounded-3xl rounded-br-lg px-4 py-2.5 text-sm leading-relaxed",
        fromSession
          ? "bg-secondary text-secondary-foreground"
          : "bg-primary text-primary-foreground",
      )}>
        {m.text}
      </div>
      {fromSession && (
        <span className="type-micro font-mono text-muted-foreground">来自 {fromSession}</span>
      )}
      {m.attachments?.map((a) => (
        <AttachmentChip key={a.name} name={a.name} kind={a.kind} />
      ))}
    </div>
  )
}

function AssistantMessage({
  m,
  message,
  tools,
  running,
}: {
  m: AssistantMsg
  message: MessageShape
  tools: StyleTraits["tools"]
  running: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2.5">
      {/* 轨迹(思考 + 工具)在回答之前:时序如此,正文第一眼就是答案 */}
      {(m.thinking || m.tools) && (
        <div className="w-full">
          <TraceBlock m={m} shape={tools} running={running} />
        </div>
      )}

      {/* 双向气泡时正文进气泡;否则铺满内容轴——行长已经由 --app-content-max
          管住,再套一层 68ch 就会出现正文比输入框窄一截的错位。
          流式草稿正文为空时不渲染,否则气泡形态会先出现一枚空胶囊 */}
      {m.text && (
        <Markdown
          text={m.text}
          className={cn(
            message === "bubble-both"
              ? "w-auto max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-2.5"
              : "w-full",
          )}
        />
      )}
    </div>
  )
}

/** 距底多少像素以内算「还在看最新消息」 */
const STICK_THRESHOLD = 80

/** 一问一答收成一个回合:回合内紧凑(gap-3),回合之间放开(gap-8) */
function groupTurns(list: Message[]): Message[][] {
  const turns: Message[][] = []
  for (const m of list) {
    if (m.role === "user" || turns.length === 0) turns.push([])
    turns[turns.length - 1].push(m)
  }
  return turns
}

/** 输入区形态决定消息流要给底部留多少空 —— 悬浮的那套要让出整块 */
const BOTTOM_PAD: Record<ComposerShape, string> = {
  docked: "pb-8",
  card: "pb-10",
  floating: "pb-56",
  inline: "pb-8",
}

type ChatViewProps = {
  messages: Message[]
  /** 是否显示「生成中」占位行 */
  pending?: boolean
  pendingLabel?: React.ReactNode
  queued?: {
    text: string
    steerAvailable: boolean
    steering: boolean
    onSteer: () => void
    onCancel: () => void
  }
}

export function ChatView({ messages, pending = true, pendingLabel, queued }: ChatViewProps) {
  const traits = useTraits()
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const [following, setFollowing] = useState(true)

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const viewport = rootRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    stuckRef.current = true
    setFollowing(true)
    viewport.scrollTo({ top: viewport.scrollHeight, behavior })
  }

  // 停在最新一条,并在内容长高时跟随——但只在用户本来就贴着底部时,
  // 免得他往回翻历史的时候被硬拽回来。
  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    const content = contentRef.current
    if (!viewport || !content) return

    const stick = () => {
      window.requestAnimationFrame(() => {
        if (stuckRef.current) viewport.scrollTop = viewport.scrollHeight
      })
    }
    const onScroll = () => {
      const next = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < STICK_THRESHOLD
      stuckRef.current = next
      setFollowing(next)
    }

    stick()
    viewport.addEventListener("scroll", onScroll, { passive: true })
    // 字体或窗口变化会改内容高度,ResizeObserver 比 mount 时滚一次可靠
    const ro = new ResizeObserver(() => stuckRef.current && stick())
    ro.observe(content)

    return () => {
      viewport.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [])

  // 「正在生成…」占位只在 draft 还完全空白时显示——轨迹块或正文一旦出现,
  // 轨迹块自己的「正在工作/正在思考」流光已经接管,不再重复占位
  const last = messages[messages.length - 1]
  const draftBlank =
    last?.role === "assistant" && !last.thinking && !last.tools?.length && !last.text

  return (
    <div className="relative min-h-0 flex-1">
    <ScrollArea ref={rootRef} className="chat-scroll-area h-full min-h-0">
      <div
        ref={contentRef}
        className={cn(
          "box-border flex w-full min-w-0 max-w-full flex-col gap-8 pt-6",
          CHAT_CONTENT_GUTTER[traits.composer],
          COLUMN[traits.width],
          BOTTOM_PAD[traits.composer],
        )}
      >
        {messages.length === 0 && !pending && (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            在下面写下第一句话,开始这段对话。
          </div>
        )}

        {groupTurns(messages).map((turn, ti, turns) => (
          <div key={turn[0].id} className="flex min-w-0 flex-col gap-3">
            {turn.map((m) =>
              m.role === "user" ? (
                <UserMessage key={m.id} m={m} shape={traits.message} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  m={m}
                  message={traits.message}
                  tools={traits.tools}
                  running={pending && m.id === "draft"}
                />
              ),
            )}
            {/* 最后一条是用户消息时,生成中占位属于这个回合 */}
            {pending && ti === turns.length - 1 && turn[turn.length - 1].role === "user" && (
              <ShiningText text={pendingLabel ?? "正在生成…"} className="text-sm" />
            )}
          </div>
        ))}

        {pending && draftBlank && (
          <ShiningText text={pendingLabel ?? "正在生成…"} className="text-sm" />
        )}

        {queued && (
          <div className="flex min-w-0 flex-col items-end gap-1.5" data-queued-message>
            <div className="max-w-[75%] wrap-anywhere rounded-3xl rounded-br-lg bg-secondary px-4 py-2.5 text-sm text-secondary-foreground">
              {queued.text}
            </div>
            <div className="flex items-center gap-1.5 type-micro text-muted-foreground">
              <span>下一条</span>
              {queued.steerAvailable && (
                <button
                  type="button"
                  disabled={queued.steering}
                  onClick={queued.onSteer}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:text-muted-foreground"
                >
                  <Forward className="size-3" />
                  {queued.steering ? "正在引导" : "立即引导"}
                </button>
              )}
              <button
                type="button"
                aria-label="取消待发送消息"
                title="取消待发送消息"
                onClick={queued.onCancel}
                className="grid size-6 place-items-center rounded-md hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X className="size-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
    {!following && (
      <button
        type="button"
        onClick={() => scrollToLatest("smooth")}
        className={cn(
          "absolute right-4 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium shadow-pop hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          traits.composer === "floating" ? "bottom-56" : "bottom-3",
        )}
      >
        <ArrowDown className="size-3.5" />
        回到最新
      </button>
    )}
    </div>
  )
}
