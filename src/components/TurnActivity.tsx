/**
 * TurnActivity:一个回合的活动(思考 / 过程文字 / 工具 / 引导)只有一种渲染。
 *
 * - live:回合运行中,位于消息流末端、紧邻 Composer 上方,全窗口唯一的状态标题
 *   (星标 + 流光文案 + chevron),默认折叠,用户展开后按事件顺序回放 timeline;
 * - settled:回合落定后折叠到 final 正文上方,默认收成一行摘要。
 *
 * 分组、状态文案、占位规则都在 src/core/activity.ts(纯函数,可直接测)。
 */

import { useState } from "react"
import {
  Check,
  ChevronDown,
  FileText,
  Forward,
  Pencil,
  Search,
  Terminal,
  TriangleAlert,
} from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ShiningText } from "@/components/ShiningText"
import { cn } from "@/lib/utils"
import {
  groupActivity,
  liveStatus,
  settledSummary,
  toolGroupStatus,
  type ActivityBlock,
  type LiveTurn,
} from "@/core/activity"
import { formatDuration, formatUsage } from "@/core/formatDuration"
import type { HarnessUsage } from "@/core/events"
import type { PlanItem, ToolCall } from "@/core/types"
import type { StyleTraits } from "@/data/styles"

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
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={toggleKeys}
        className="trace-row flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
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
      {/* running 中不存在 durationMs；运行态动效只留给顶部状态文案。 */}
      {tool.durationMs !== undefined && (
        <span className="shrink-0 type-micro tabular-nums text-muted-foreground/75">
          {formatDuration(tool.durationMs)}
        </span>
      )}
      {tool.status === "done" && <Check className="size-3.5 shrink-0 text-ok" />}
      {tool.status === "running" && (
        <span className="size-2 shrink-0 rounded-full bg-brand" />
      )}
      {tool.status === "failed" && <TriangleAlert className="size-3.5 shrink-0 text-err" />}
      {tool.output && (
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      )}
    </>
  )
}

/** 一段 agentic work:thinking 与其间多个工具统一折成一行，展开后仍按
 * 原始事件顺序展示。公开 progress 会在 core/activity 中切断工作段。 */
function WorkGroup({ items }: { items: Extract<ActivityBlock, { kind: "work" }>["items"] }) {
  const [open, setOpen] = useState(false)
  if (items.length === 1 && items[0].kind === "tool") return <ToolRow tool={items[0].tool} />

  const tools = items.flatMap((item) => item.kind === "tool" ? [item.tool] : [])
  const status = toolGroupStatus(tools)
  const failed = tools.filter((tool) => tool.status === "failed").length
  const label = tools.length > 0
    ? `${status === "running" ? "正在使用" : "使用了"} ${tools.length} 个工具`
    : "思考"

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger className="trace-row group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none">
        {tools.length > 0
          ? <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
          : <TraceStar working={false} />}
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="flex-1" />
        {tools.length > 0 && status === "done" && <Check className="size-3.5 shrink-0 text-ok" />}
        {tools.length > 0 && status === "running" && (
          <span className="size-2 shrink-0 rounded-full bg-brand" />
        )}
        {tools.length > 0 && status === "failed" && (
          <span className="flex shrink-0 items-center gap-1 text-err">
            <TriangleAlert className="size-3.5" />
            <span className="type-micro tabular-nums">{failed}</span>
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-section">
        <div className="flex min-w-0 flex-col">
          {items.map((item) => (
            item.kind === "tool"
              ? <ToolRow key={item.id} tool={item.tool} />
              : (
                  <p key={item.id} className="max-w-full px-1.5 py-1 text-xs text-muted-foreground">
                    {item.text}
                  </p>
                )
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 轨迹头四角星:运行中亮,落定后暗下去 */
function TraceStar({ working }: { working: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="currentColor"
      className={cn("size-4 shrink-0", working ? "text-foreground/70" : "text-muted-foreground/60")}
    >
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  )
}

function PlanRows({ plan }: { plan: PlanItem[] }) {
  return (
    <div className="mb-0.5 flex flex-col">
      {plan.map((item, i) => (
        <div key={i} className="flex items-center gap-2 px-1.5 py-0.5 text-xs text-muted-foreground">
          {item.status === "completed" && <Check className="size-3.5 shrink-0 text-ok" />}
          {item.status === "in_progress" && (
            <span className="size-2 shrink-0 rounded-full bg-brand" />
          )}
          {item.status === "pending" && (
            <span className="size-3.5 shrink-0 rounded-full border-2 border-muted-foreground/30" />
          )}
          <span className="min-w-0 truncate">{item.content}</span>
        </div>
      ))}
    </div>
  )
}

/** 单个渲染块:工具组 / 引导条 / 一段文字。compact(live 窗口内)时文字
 * 限三行,过程文字比 thinking 亮一档——它是公开发言,thinking 是内部想法。 */
function ActivityBlockRow({ block, compact }: { block: ActivityBlock; compact: boolean }) {
  if (block.kind === "work") return <WorkGroup items={block.items} />
  if (block.kind === "steer") {
    return (
      <div className="flex items-start gap-2 rounded-md bg-secondary px-2 py-1.5 text-xs text-secondary-foreground">
        <Forward className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 wrap-anywhere">你补充：{block.text}</span>
      </div>
    )
  }
  return (
    <p
      className={cn(
        "max-w-full px-1.5 py-0.5 text-xs leading-relaxed",
        block.kind === "progress" ? "text-foreground/75" : "text-muted-foreground",
        compact && "line-clamp-3",
      )}
    >
      {block.text}
    </p>
  )
}

export function TurnActivity({
  turn,
  live,
  shape,
}: {
  turn: LiveTurn & {
    durationMs?: number
    usage?: HarnessUsage
    outcome?: "cancelled" | "error" | "interrupted"
  }
  /** live = 回合运行中(Composer 左上);settled = 落定消息内的折叠 trace */
  live: boolean
  shape: StyleTraits["tools"]
}) {
  const { activity, tools } = turn
  // live 默认展开、settled 默认折叠；用户手动选择后保持其选择。
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? live

  const blocks = groupActivity(activity)
  const plan = turn.plan ?? []
  const expandable = blocks.length > 0 || plan.length > 0

  const failed = tools.filter((tool) => tool.status === "failed").length
  const usageText =
    turn.usage && (turn.usage.inputTokens || turn.usage.outputTokens || turn.usage.cost !== undefined)
      ? formatUsage(turn.usage)
      : undefined
  const status = live ? liveStatus(turn) : undefined

  const activityRows = (
    <>
      {blocks.map((block) => (
        <ActivityBlockRow key={block.id} block={block} compact={live} />
      ))}
    </>
  )

  const list =
    shape === "flat" ? (
      <div className="relative mt-0.5 ml-2 pl-4">
        <span aria-hidden className="absolute inset-y-1 left-0 w-px bg-border" />
        <div className="flex min-w-0 flex-col gap-1 py-1">
          {plan.length > 0 && <PlanRows plan={plan} />}
          {activityRows}
        </div>
      </div>
    ) : (
      <div className="mt-1 divide-y divide-border overflow-hidden rounded-md border border-border bg-chrome">
        {plan.length > 0 && <PlanRows plan={plan} />}
        {activityRows}
      </div>
    )

  const header = (
    <>
      <TraceStar working={live} />
      {live ? (
        <>
          <ShiningText text={status!.label} className="shrink-0" />
        </>
      ) : (
        <span className="min-w-0 truncate">
          {settledSummary(turn)}
          {turn.durationMs !== undefined && ` · ${formatDuration(turn.durationMs)}`}
          {usageText && ` · ${usageText}`}
          {failed > 0 && <span className="text-err"> · {failed} 个失败</span>}
        </span>
      )}
      {expandable && (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      )}
    </>
  )

  const headerClass =
    "group -ml-1.5 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-sm font-medium text-foreground/70 transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"

  // 无活动占位(回合刚开始、什么都没流出来):只有一行标题,不可展开,
  // 不渲染 chevron——运行中全窗口的状态标题只有这一处
  if (!expandable) {
    return <div className={cn(headerClass, "cursor-default hover:text-foreground/70")}>{header}</div>
  }

  return (
    <Collapsible open={open} onOpenChange={setManual} className="flex min-w-0 max-w-full flex-col">
      <CollapsibleTrigger className={headerClass}>{header}</CollapsibleTrigger>
      <CollapsibleContent className="collapsible-section">{list}</CollapsibleContent>
    </Collapsible>
  )
}
