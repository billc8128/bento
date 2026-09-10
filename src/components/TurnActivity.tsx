/**
 * TurnActivity:一个回合的活动按「阶段摘要栈」渲染——连续 thinking 并成一段、
 * 连续 tool 并成一组,progress 独立成行。steer(回合中补充)不在这里:
 * replay 已把它拆成消息流里的真实 user message。
 *
 * - live:回合运行中,位于消息流末端、紧邻 Composer 上方。已完成的
 *   thinking/tools 阶段收进顶部一行聚合(实时计数、点击展开完整栈);
 *   进行中的阶段(正在思考/正在使用工具)与 progress/approval 留在
 *   流里,进行中的阶段永远在栈末,带流光文案;没有活跃工作段时
 *   (说话中/空栈)由末尾的兜底状态行承接,全窗口唯一的状态标题;
 * - settled:回合落定后折叠到 final 正文上方,一行总折叠「已工作 Xm XXs」,
 *   展开后回看完整阶段栈。
 *
 * 分组、阶段判定、摘要文案都在 src/core/activity.ts(纯函数,可直接测)。
 */

import { useState, type ReactNode } from "react"
import {
  Check,
  ChevronDown,
  FileText,
  ListCollapse,
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
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import {
  buildPhases,
  cleanToolTarget,
  liveAggregate,
  livePhaseId,
  liveStatus,
  phaseLabel,
  settledMasterLabel,
  toolGroupStatus,
  type LiveAggregate,
  type LiveTurn,
  type PhaseRow,
} from "@/core/activity"
import { formatDuration, formatUsage } from "@/core/formatDuration"
import type { ApprovalDecision, HarnessUsage } from "@/core/events"
import type { ApprovalRequest, PlanItem, ToolCall } from "@/core/types"
import type { StyleTraits } from "@/data/styles"

const TOOL_ICON = {
  read: FileText,
  edit: Pencil,
  bash: Terminal,
  search: Search,
} as const

const TOOL_LABEL_KEY = {
  read: "activity.toolRead",
  edit: "activity.toolEdit",
  bash: "activity.toolBash",
  search: "activity.toolSearch",
} as const

const TOOL_RUNNING_LABEL_KEY = {
  read: "activity.toolReading",
  edit: "activity.toolEditing",
  bash: "activity.toolBashRunning",
  search: "activity.toolSearching",
} as const

/** 工具调用行:图标 + 动作 + 目标 + diff 统计 + 结果 + 耗时,状态靠图标而非仅颜色。
 * 带 output 的行可点击展开输出面板(§7,复用 collapsible-section 折叠动效);
 * 搜索行带 url 时目标渲染为外链。字段都可选,旧数据自动隐藏。 */
function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false)
  // P2 延迟挂载:从未展开过就不构造 output 元素;展开后 sticky 保持构造,
  // 关闭动画(Radix Presence)不受影响。sticky 只在事件回调里翻转,
  // 不做 render-phase setState。
  const [contentMounted, setContentMounted] = useState(false)
  const applyOpen = (next: boolean) => {
    setOpen(next)
    if (next) setContentMounted(true)
  }
  const expandable = Boolean(tool.output)

  const toggleKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      applyOpen(!open)
    }
  }

  return expandable ? (
    <Collapsible open={open} onOpenChange={applyOpen}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => applyOpen(!open)}
        onKeyDown={toggleKeys}
        className="trace-row flex h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
      >
        <ToolRowMain tool={tool} open={open} />
      </div>
      <CollapsibleContent className="collapsible-section">
        {contentMounted && (
          <pre className="mb-1 max-h-48 overflow-y-auto rounded-md border border-border bg-chrome px-2.5 py-2 font-mono type-micro whitespace-pre-wrap break-words text-muted-foreground">
            {tool.output}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  ) : (
    <div className="trace-row flex h-7 items-center gap-2 px-1.5 text-xs">
      <ToolRowMain tool={tool} />
    </div>
  )
}

/** 行内主体:图标/标签/目标/统计/耗时/状态,展开行多一枚旋转指示的 chevron。
 * 在跑的行动词用现在时(正在执行),目标先过 cleanToolTarget 剥掉 harness
 * 前缀(如 kimi 的 "Running: "),避免「执行 Running: curl」。 */
function ToolRowMain({ tool, open }: { tool: ToolCall; open?: boolean }) {
  const { t } = useT()
  const Icon = TOOL_ICON[tool.kind]
  const label = t(tool.status === "running" ? TOOL_RUNNING_LABEL_KEY[tool.kind] : TOOL_LABEL_KEY[tool.kind])
  const target = cleanToolTarget(tool.target)
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {tool.url ? (
        <a
          href={tool.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 truncate font-mono text-foreground/85 underline decoration-border underline-offset-2 hover:decoration-foreground"
        >
          {target}
        </a>
      ) : (
        <code className="min-w-0 truncate font-mono text-foreground/85">{target}</code>
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
      {/* running 中不存在 durationMs；运行态动效只留给阶段行的状态文案。 */}
      {tool.durationMs !== undefined && (
        <span className="shrink-0 type-micro tabular-nums text-muted-foreground/75">
          {formatDuration(tool.durationMs)}
        </span>
      )}
      {tool.status === "done" && <Check className="size-3.5 shrink-0 text-ok" />}
      {tool.status === "running" && (
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-brand motion-reduce:animate-none" />
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

/** 轨迹头四角星:进行中亮,落定后暗下去 */
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

/** 展开细节的容器:左侧一条竖线标出归属关系,与行首图标对齐。 */
function DetailRail({ children }: { children: ReactNode }) {
  return (
    <div className="relative mt-0.5 ml-2 pl-4">
      <span aria-hidden className="absolute inset-y-1 left-0 w-px bg-border" />
      <div className="flex min-w-0 flex-col gap-1 py-1">{children}</div>
    </div>
  )
}

/** 阶段行的公共折叠骨架:默认折叠、点击向下展开;折叠时不构造内容
 * (流式热路径),展开后 sticky 保持,关闭动画不受影响。 */
function TraceCollapsible({ header, children }: { header: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // P2 延迟挂载:sticky 只在事件回调里翻转,不做 render-phase setState。
  const [contentMounted, setContentMounted] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setContentMounted(true)
      }}
      className="min-w-0"
    >
      <CollapsibleTrigger className="trace-row group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none">
        {header}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-section">
        {contentMounted && children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** thinking 阶段行:落定「已思考」/进行中「正在思考…」(流光),展开看思考文本。 */
function ThinkingPhaseRow({ text, label, live }: { text: string; label: string; live: boolean }) {
  return (
    <TraceCollapsible
      header={
        <>
          <TraceStar working={live} />
          {live ? (
            <ShiningText text={label} className="shrink-0" />
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">{label}</span>
          )}
          <span className="flex-1" />
        </>
      }
    >
      <DetailRail>
        <p className="max-w-full px-1.5 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted-foreground">
          {text}
        </p>
      </DetailRail>
    </TraceCollapsible>
  )
}

/** 工具阶段行:落定「已使用 N 个工具」/进行中「正在使用工具」,展开后每行
 * 一个具体 tool call(在跑的那行动词是现在时、琥珀点脉冲)。 */
function ToolsPhaseRow({ tools, label, live }: { tools: ToolCall[]; label: string; live: boolean }) {
  const status = toolGroupStatus(tools)
  const failed = tools.filter((tool) => tool.status === "failed").length
  return (
    <TraceCollapsible
      header={
        <>
          <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
          {live ? (
            <ShiningText text={label} className="shrink-0" />
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">{label}</span>
          )}
          <span className="flex-1" />
          {status === "done" && <Check className="size-3.5 shrink-0 text-ok" />}
          {status === "running" && (
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-brand motion-reduce:animate-none" />
          )}
          {status === "failed" && (
            <span className="flex shrink-0 items-center gap-1 text-err">
              <TriangleAlert className="size-3.5" />
              <span className="type-micro tabular-nums">{failed}</span>
            </span>
          )}
        </>
      }
    >
      <DetailRail>
        {tools.map((tool, i) => (
          <ToolRow key={i} tool={tool} />
        ))}
      </DetailRail>
    </TraceCollapsible>
  )
}

/** live 回合的计划摘要:一行进度条 + x/y + 当前项,点击展开全表(限高滚动)。
 * 放在阶段栈底部(贴最新消息),不再钉栈顶被滚出视野。 */
function PlanSummary({ plan }: { plan: PlanItem[] }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const done = plan.filter((item) => item.status === "completed").length
  const current = plan.find((item) => item.status === "in_progress")
  const pct = plan.length > 0 ? (done / plan.length) * 100 : 0
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group -ml-1.5 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-sm font-medium text-foreground/70 transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none">
        <span className="h-[3px] w-16 shrink-0 overflow-hidden rounded-full bg-border">
          <span
            className="block h-full rounded-full bg-brand transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="shrink-0">
          {t("activity.plan")} <span className="type-micro tabular-nums text-muted-foreground">{done}/{plan.length}</span>
        </span>
        {current && (
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            {t("activity.planCurrent", { content: current.content })}
          </span>
        )}
        <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-section">
        <div className="max-h-48 overflow-y-auto overscroll-contain">
          <PlanRows plan={plan} />
        </div>
      </CollapsibleContent>
    </Collapsible>
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

/** 审批行:pending = 可点决议卡(允许一次/总是允许/拒绝);已结算 = 一行静态记录。
 * source 非 user 的结算(取消/关闭/协作自动)如实标注,不伪装成用户点的。 */
function ApprovalRow({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest
  onResolve?: (id: string, decision: ApprovalDecision) => void
}) {
  const { t } = useT()
  if (approval.state === "pending") {
    return (
      <div className="trace-row rounded-lg border border-brand/40 bg-brand/5 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-brand" />
          <span className="shrink-0 text-xs font-medium">{t("activity.approvalNeeded")}</span>
        </div>
        <code className="mt-1.5 block truncate font-mono text-xs text-foreground/85">
          {approval.title}
        </code>
        {approval.detail && (
          <p className="mt-1 type-micro text-muted-foreground">{approval.detail}</p>
        )}
        <div className="mt-2 flex items-center gap-2">
          {approval.options.map((option, i) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={option.id === "deny" ? "ghost" : i === 0 ? "default" : "secondary"}
              className={cn("h-7 text-xs", option.id === "deny" && "text-destructive hover:text-destructive")}
              onClick={() => onResolve?.(approval.id, option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    )
  }
  const { decision, source } = approval.state
  const decisionLabel = decision === "deny"
    ? source === "unattended-auto"
      ? t("activity.autoDenied")
      : source === "cancel"
        ? t("activity.deniedWithCancel")
        : source === "session-close"
          ? t("activity.deniedWithSessionClose")
          : t("activity.denied")
    : decision === "allow_always"
      ? t("activity.allowedAlways")
      : t("activity.allowed")
  return (
    <div className="trace-row flex h-7 items-center gap-2 px-1.5 text-xs">
      {decision === "deny"
        ? <TriangleAlert className="size-3.5 shrink-0 text-err" />
        : <Check className="size-3.5 shrink-0 text-ok" />}
      <span className="shrink-0 text-muted-foreground">{t("activity.approval")}</span>
      <code className="min-w-0 truncate font-mono text-foreground/85">{approval.title}</code>
      <span className="flex-1" />
      <span className={cn("shrink-0 type-micro", decision === "deny" ? "text-err/80" : "text-muted-foreground/75")}>
        {decisionLabel}
      </span>
    </div>
  )
}

/** 阶段栈中的一行:thinking/tools 走折叠阶段行,approval 是审批卡,progress 是
 * 公开过程文字(比 thinking 亮一档;live 窗口内限三行)。 */
function PhaseRowView({
  row,
  livePhase,
  compact,
  onResolveApproval,
}: {
  row: PhaseRow
  livePhase: boolean
  compact: boolean
  onResolveApproval?: (id: string, decision: ApprovalDecision) => void
}) {
  const { t } = useT()
  if (row.kind === "thinking") {
    return <ThinkingPhaseRow text={row.text} label={phaseLabel(row, livePhase, t)} live={livePhase} />
  }
  if (row.kind === "tools") {
    return <ToolsPhaseRow tools={row.tools} label={phaseLabel(row, livePhase, t)} live={livePhase} />
  }
  if (row.kind === "approval") {
    return <ApprovalRow approval={row.approval} onResolve={onResolveApproval} />
  }
  return (
    <p
      className={cn(
        "max-w-full px-1.5 py-0.5 text-[13px] leading-relaxed text-foreground/75",
        compact && "line-clamp-3",
      )}
    >
      {row.text}
    </p>
  )
}

/** live 聚合行:已完成的 thinking/tools 阶段收进 trace 块顶部一行——
 * 计数实时更新(「已思考 Xs · 已使用 N 个工具 · M 个失败」),点击展开
 * 回看完整阶段栈(阶段行保持各自可展开)。展开态沿用 TraceCollapsible
 * 的 sticky 挂载:新完成的阶段在展开中实时追加。 */
function LiveAggregateRow({
  agg,
  onResolveApproval,
}: {
  agg: LiveAggregate
  onResolveApproval?: (id: string, decision: ApprovalDecision) => void
}) {
  const { t } = useT()
  const parts: string[] = []
  if (agg.thinkingMs !== undefined) {
    parts.push(t("activity.thoughtWithDuration", { duration: formatDuration(agg.thinkingMs) }))
  } else if (agg.thinkingCount > 0) {
    parts.push(t("activity.thought"))
  }
  if (agg.toolCount > 0) parts.push(t("activity.usedTools", { count: agg.toolCount }))
  return (
    <TraceCollapsible
      header={
        <>
          <ListCollapse className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">
            {parts.join(" · ")}
            {agg.failedCount > 0 && (
              <span className="text-err"> · {t("activity.failedCount", { count: agg.failedCount })}</span>
            )}
          </span>
          <span className="flex-1" />
        </>
      }
    >
      <DetailRail>
        {agg.rows.map((row) => (
          <PhaseRowView key={row.id} row={row} livePhase={false} compact onResolveApproval={onResolveApproval} />
        ))}
      </DetailRail>
    </TraceCollapsible>
  )
}

export function TurnActivity({
  turn,
  live,
  shape,
  onResolveApproval,
}: {
  turn: LiveTurn & {
    durationMs?: number
    usage?: HarnessUsage
    outcome?: "cancelled" | "error" | "interrupted"
  }
  /** live = 回合运行中(Composer 左上);settled = 落定消息内的总折叠 trace */
  live: boolean
  shape: StyleTraits["tools"]
  /** 审批卡片决议入口(live 视图);settled 回放一律静态,不传球 */
  onResolveApproval?: (id: string, decision: ApprovalDecision) => void
}) {
  const { t } = useT()
  const { activity } = turn
  const phases = buildPhases(activity)
  const plan = turn.plan ?? []
  const liveId = live ? livePhaseId(phases) : undefined

  // settled 总折叠的折叠态(用户手动选择后保持)。live 分支提前 return,这两个
  // state 只在 settled 路径生效——hooks 必须无条件声明,故提到分支之前。
  const [manual, setManual] = useState<boolean | null>(null)
  const [contentMounted, setContentMounted] = useState(false)

  if (live) {
    // 已完成的 thinking/tools 阶段收进顶部聚合行;进行中的阶段与
    // progress/approval 按时间序留在流里。没有活跃工作段时
    // (空栈/说话中)由末尾的兜底状态行承接——全窗口唯一的状态标题。
    const agg = liveAggregate(phases)
    const aggregated = new Set(agg.rows.map((row) => row.id))
    const flowRows = phases.filter((row) => !aggregated.has(row.id))
    const fallback = liveId === undefined ? liveStatus(turn, t) : undefined
    return (
      <div className="flex min-w-0 max-w-full flex-col gap-0.5">
        {agg.rows.length > 0 && <LiveAggregateRow agg={agg} onResolveApproval={onResolveApproval} />}
        {flowRows.map((row) => (
          <PhaseRowView key={row.id} row={row} livePhase={row.id === liveId} compact onResolveApproval={onResolveApproval} />
        ))}
        {fallback && (
          <div className="-ml-1.5 flex w-full min-w-0 cursor-default items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-sm font-medium text-foreground/70">
            <TraceStar working />
            <ShiningText text={fallback.label} className="shrink-0" />
          </div>
        )}
        {/* plan 摘要在栈底:贴最新消息,进度一眼可见;全表点击展开 */}
        {plan.length > 0 && <PlanSummary plan={plan} />}
      </div>
    )
  }

  // settled:一行总折叠「已工作 Xm XXs」,展开回看完整阶段栈;final 正文在组件外。
  // P2 延迟挂载:折叠的总览连阶段栈元素都不构造;首次展开在 onOpenChange 里
  // sticky,关闭动画不受影响。
  const open = manual ?? false

  const failed = turn.tools.filter((tool) => tool.status === "failed").length
  const usageText =
    turn.usage && (turn.usage.inputTokens || turn.usage.outputTokens || turn.usage.cost !== undefined)
      ? formatUsage(turn.usage)
      : undefined
  const expandable = phases.length > 0 || plan.length > 0

  const header = (
    <>
      <TraceStar working={false} />
      <span className="min-w-0 truncate">
        {settledMasterLabel(turn, t)}
        {usageText && ` · ${usageText}`}
        {failed > 0 && <span className="text-err"> · {t("activity.failedCount", { count: failed })}</span>}
      </span>
      <span className="flex-1" />
      {expandable && (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      )}
    </>
  )

  const headerClass =
    "group -ml-1.5 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-sm font-medium text-foreground/70 transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"

  // 无活动占位:只有一行标题,不可展开,不渲染 chevron
  if (!expandable) {
    return <div className={cn(headerClass, "cursor-default hover:text-foreground/70")}>{header}</div>
  }

  const list = contentMounted
    ? shape === "flat"
      ? (
          <div className="relative mt-0.5 ml-2 pl-4">
            <span aria-hidden className="absolute inset-y-1 left-0 w-px bg-border" />
            <div className="flex min-w-0 flex-col gap-1 py-1">
              {plan.length > 0 && <PlanRows plan={plan} />}
              {phases.map((row) => (
                <PhaseRowView key={row.id} row={row} livePhase={false} compact={false} />
              ))}
            </div>
          </div>
        )
      : (
          <div className="mt-1 divide-y divide-border overflow-hidden rounded-md border border-border bg-chrome">
            {plan.length > 0 && <PlanRows plan={plan} />}
            {phases.map((row) => (
              <PhaseRowView key={row.id} row={row} livePhase={false} compact={false} />
            ))}
          </div>
        )
    : null

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setManual(next)
        if (next) setContentMounted(true)
      }}
      className="flex min-w-0 max-w-full flex-col"
    >
      <CollapsibleTrigger className={headerClass}>{header}</CollapsibleTrigger>
      <CollapsibleContent className="collapsible-section">{list}</CollapsibleContent>
    </Collapsible>
  )
}
