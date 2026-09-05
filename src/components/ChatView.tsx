import { memo, useEffect, useRef, useState } from "react"
import {
  ArrowDown,
  FileText,
  ImageIcon,
  Forward,
  X,
} from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Markdown } from "@/components/Markdown"
import { PromptRail } from "@/components/PromptRail"
import { TurnActivity } from "@/components/TurnActivity"
import { cn } from "@/lib/utils"
import { useTraits } from "@/lib/style-context"
import { resolveActivity } from "@/core/activity"
import type { LiveTurn } from "@/core/activity"
import type { ApprovalDecision } from "@/core/events"
import type { Message } from "@/core/types"
import {
  CHAT_CONTENT_GUTTER,
  COLUMN,
  type ComposerShape,
  type MessageShape,
} from "@/data/styles"

// Message 是按 role 判别的联合,子组件各取自己那一支
type UserMsg = Extract<Message, { role: "user" }>
type AssistantMsg = Extract<Message, { role: "assistant" }>

function AttachmentChip({ name, kind }: { name: string; kind: "image" | "file" }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
      {kind === "image" ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
      <span className="font-mono">{name}</span>
    </span>
  )
}

// memo:流式 draft 每帧重建,历史消息引用稳定,只有新消息/草稿重渲染
/** 长消息折叠阈值:8 行(text-sm + leading-relaxed ≈ 22.75px/行) */
const LONG_MESSAGE_CLAMP = "max-h-[184px]"

/** 用户长文本:先收 8 行 + 底部渐变提示,点击展开全文,再点收起。
 * 注意遮罩只能挂在内层文字上——挂气泡外壳会把气泡底色一起溶掉。 */
function ClampedText({ text, className, align = "start", buttonClassName }: {
  text: string
  className?: string
  align?: "start" | "end"
  buttonClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (el) setLong(el.scrollHeight > 184 + 4)
  }, [text])
  return (
    <div className="flex min-w-0 flex-col">
      <div
        ref={ref}
        onClick={() => long && setOpen(!open)}
        className={cn(
          className,
          !open && LONG_MESSAGE_CLAMP,
          !open && "overflow-hidden",
          long && !open && "cursor-pointer [mask-image:linear-gradient(to_bottom,black_calc(100%-44px),transparent)]",
        )}
      >
        {text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            "type-micro transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            align === "end" ? "self-end" : "self-start",
            buttonClassName ?? "text-muted-foreground hover:text-foreground",
          )}
        >
          {open ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  )
}

const UserMessage = memo(function UserMessage({ m, shape }: { m: UserMsg; shape: MessageShape }) {
  // 协作来源:envelope 不落 JSONL,这里只展示可信 origin,不当正文渲染
  const fromSession = m.origin?.kind === "session" ? m.origin.title : null
  // 无气泡的风格里,说话人靠一个标签和左侧竖线交代,读起来像日志
  if (shape === "plain")
    return (
      <div
        data-message-id={m.id}
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
          "min-w-0 max-w-full border-l-2 pl-3 text-sm leading-relaxed",
          fromSession
            ? "rounded-r-lg border-secondary-foreground/25 bg-secondary px-3 py-2 text-secondary-foreground"
            : "border-primary/40",
        )}>
          <ClampedText
            text={m.text}
            align="start"
            className="wrap-anywhere"
            buttonClassName={fromSession
              ? "text-secondary-foreground/60 hover:text-secondary-foreground"
              : undefined}
          />
        </div>
        {m.attachments?.map((a) => (
          <AttachmentChip key={a.name} name={a.name} kind={a.kind} />
        ))}
      </div>
    )

  return (
    <div
      data-message-id={m.id}
      data-message-origin={fromSession ? "session" : "human"}
      className="flex min-w-0 flex-col items-end gap-1.5"
    >
      {/* 气泡保持胶囊感:3xl(20px)接近旧 --radius 1rem 时代的 2xl 观感 */}
      <div className={cn(
        "min-w-0 max-w-[75%] rounded-3xl rounded-br-lg px-4 py-2.5 text-sm leading-relaxed",
        fromSession
          ? "bg-secondary text-secondary-foreground"
          : "bg-primary text-primary-foreground",
      )}>
        <ClampedText
          text={m.text}
          align="end"
          className="wrap-anywhere"
          buttonClassName={fromSession
            ? "text-secondary-foreground/60 hover:text-secondary-foreground"
            : "text-primary-foreground/65 hover:text-primary-foreground"}
        />
      </div>
      {fromSession && (
        <span className="type-micro font-mono text-muted-foreground">来自 {fromSession}</span>
      )}
      {m.attachments?.map((a) => (
        <AttachmentChip key={a.name} name={a.name} kind={a.kind} />
      ))}
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({
  m,
  message,
  tools,
  running,
  cwd,
}: {
  m: AssistantMsg
  message: MessageShape
  /** 工具轨迹形态:带框分组还是散开的行(落定 trace 用) */
  tools: "boxed" | "flat"
  /** running = 这是进行中的 draft。运行态的状态标题只活在 Composer 左上
   * 的 TurnActivity,消息区不再渲染 active trace;流式 final candidate
   * 照常长正文。回合落定(running=false)后,同一批 activity 折叠到
   * final 正文上方,默认一行摘要。 */
  running: boolean
  /** 会话工作目录:正文里的相对文件链接靠它锚定并接入右侧文件面板 */
  cwd?: string
}) {
  const activity = resolveActivity(m)
  return (
    <div className="flex min-w-0 flex-col items-start gap-2.5">
      {/* 轨迹(思考 + 工具)在回答之前:时序如此,正文第一眼就是答案 */}
      {!running && (activity.length > 0 || (m.plan?.length ?? 0) > 0) && (
        <div className="w-full min-w-0">
          <TurnActivity
            live={false}
            shape={tools}
            turn={{
              activity,
              tools: m.tools ?? [],
              ...(m.thinking ? { thinking: m.thinking } : {}),
              ...(m.outcome ? { outcome: m.outcome } : {}),
              ...(m.plan?.length ? { plan: m.plan } : {}),
              ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
              ...(m.usage ? { usage: m.usage } : {}),
            }}
          />
        </div>
      )}

      {/* 双向气泡时正文进气泡;否则铺满内容轴——行长已经由 --app-content-max
          管住,再套一层 68ch 就会出现正文比输入框窄一截的错位。
          流式草稿正文为空时不渲染,否则气泡形态会先出现一枚空胶囊 */}
      {m.text && (
        <Markdown
          text={m.text}
          cwd={cwd}
          className={cn(
            message === "bubble-both"
              ? "w-auto max-w-[92%] rounded-lg border border-border bg-card px-3.5 py-2.5"
              : "w-full",
          )}
        />
      )}
    </div>
  )
})

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
  /** 是否有回合在跑:抑制空态文案,并把 running 传给 draft 消息。
   * 运行态没有消息区占位——全窗口唯一的状态标题在 Composer 左上 */
  pending?: boolean
  /** 当前运行回合的唯一 activity；在消息流中展开，落定后由消息自身接管。 */
  turn?: LiveTurn
  /** 审批卡片决议入口(转发给 live TurnActivity) */
  onResolveApproval?: (id: string, decision: ApprovalDecision) => void
  /** 会话工作目录:传给 Markdown 解析相对文件链接 */
  cwd?: string
  queued?: {
    text: string
    steerAvailable: boolean
    steering: boolean
    onSteer: () => void
    onCancel: () => void
  }
}

export function ChatView({ messages, pending = true, turn, onResolveApproval, queued, cwd }: ChatViewProps) {
  const traits = useTraits()
  const boxRef = useRef<HTMLDivElement>(null)
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

    // P3:流式帧内 ResizeObserver 可能连续触发,同一帧只排一次滚动 rAF
    let stickRaf = 0
    const stick = () => {
      if (stickRaf) return
      stickRaf = window.requestAnimationFrame(() => {
        stickRaf = 0
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
      if (stickRaf) window.cancelAnimationFrame(stickRaf)
      viewport.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [])

  // 人类发送永远跳回最新(聊天惯例:自己发了消息就是要看回复),并把跟随
  // 重新粘上;协作来源的 user 消息(origin=session)不抢滚动,沿用贴底跟随。
  // 注意:messages 是 live-store 原地变更的稳定引用,不能当依赖——只能依赖末条 id。
  const lastIdRef = useRef<string | null>(null)
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null
  useEffect(() => {
    if (!lastMessageId) return
    const prev = lastIdRef.current
    lastIdRef.current = lastMessageId
    // 初次挂载/同一条不处理;挂载时的贴底由上面的 stick 负责
    if (prev === null || prev === lastMessageId) return
    const last = messages[messages.length - 1]
    if (last?.role === "user" && !last.origin) scrollToLatest()
    // 乐观上屏转正换 id 位置不变,二次触发幂等
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessageId])

  return (
    <div ref={boxRef} className="relative min-h-0 flex-1">
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

        {groupTurns(messages).map((messageTurn) => (
          <div key={messageTurn[0].id} className="flex min-w-0 flex-col gap-3">
            {messageTurn.map((m) =>
              m.role === "user" ? (
                <UserMessage key={m.id} m={m} shape={traits.message} />
              ) : (
                <div key={m.id} className="flex min-w-0 flex-col gap-2.5">
                  {pending && m.id === "draft" && turn && (
                    <TurnActivity live shape={traits.tools} turn={turn} onResolveApproval={onResolveApproval} />
                  )}
                  <AssistantMessage
                    m={m}
                    message={traits.message}
                    tools={traits.tools}
                    running={pending && m.id === "draft"}
                    cwd={cwd}
                  />
                </div>
              ),
            )}
          </div>
        ))}

        {turn && !messages.some((message) => message.role === "assistant" && message.id === "draft") && (
          <TurnActivity live shape={traits.tools} turn={turn} onResolveApproval={onResolveApproval} />
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
    <PromptRail containerRef={boxRef} messages={messages} />
    {!following && (
      <button
        type="button"
        aria-label="回到最新"
        title="回到最新"
        onClick={() => scrollToLatest("smooth")}
        className={cn(
          "absolute left-1/2 z-20 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-border bg-card shadow-pop hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          // 居中贴住输入区上沿:右缘是检索条的热区,别再叠在那;
          // floating 的渐变留白 -top-12,按钮压在输入卡上沿即可
          traits.composer === "floating" ? "bottom-36" : "bottom-3",
        )}
      >
        <ArrowDown className="size-4" />
      </button>
    )}
    </div>
  )
}
