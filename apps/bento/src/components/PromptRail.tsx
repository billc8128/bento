import { useEffect, useRef, useState } from "react"

import type { Message } from "@/core/types"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/** 消息快速检索条:贴在聊天区右缘的一列小刻度,一根对应一条用户指令。
 * 至少三条用户指令时启用;平时隐藏,鼠标在右缘(HOT_EDGE px)停留后浮现;划过刻度有波浪动效,
 * 同时浮出的指令列表高亮并对齐到对应条目;点刻度或条目都平滑跳转。 */
type PromptEntry = { id: string; text: string; collab: boolean }

const TICK_W = 8
const TICK_W_MAX = 15
const WAVE_SIGMA = 13
const HOT_EDGE = 48
const SHOW_DELAY = 300
const HIDE_DELAY = 200

export function PromptRail({ containerRef, messages }: {
  /** ChatView 最外层相对定位容器:热区监听、浮卡定位、消息元素查找都锚在它身上 */
  containerRef: React.RefObject<HTMLDivElement | null>
  messages: Message[]
}) {
  const { t } = useT()
  // messages 是 live-store 原地变更的稳定引用,不能直接进依赖数组;
  // 每次渲染重新过滤很便宜,效果里用首尾 id + 条数做变更信号
  const prompts: PromptEntry[] = []
  for (const m of messages) {
    if (m.role !== "user") continue
    prompts.push({ id: m.id, text: m.text, collab: m.origin?.kind === "session" })
  }
  const promptsKey = `${prompts.length}:${prompts[0]?.id ?? ""}:${prompts[prompts.length - 1]?.id ?? ""}`

  const [active, setActive] = useState(false)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [currentIdx, setCurrentIdx] = useState(-1)
  const [popTop, setPopTop] = useState(12)
  const [gap, setGap] = useState(5)

  const railRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const tickRefs = useRef<(HTMLButtonElement | null)[]>([])
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const showTimerRef = useRef(0)
  const hideTimerRef = useRef(0)
  const activeRef = useRef(false)

  const getViewport = () =>
    containerRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null

  const findMsgEl = (id: string) =>
    containerRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ?? null

  // ---------- 浮现/隐藏:document 级监听,任何移动/滚动都重新评估。
  // 只挂容器会漏:鼠标移去 composer 等兄弟元素、或 pop 滑动盖住静止鼠标
  // (mouseenter 不触发)时,容器收不到事件,组件就卡死在展开态。
  // 不用覆盖层热区,免得盖住气泡右缘的「展开全文」等可点元素 ----------
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null)

  const evaluate = (x: number, y: number) => {
    const el = containerRef.current
    if (!el || !railRef.current) return
    const r = el.getBoundingClientRect()
    const inHot = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.right - x <= HOT_EDGE
    // 几何判断鼠标是否在浮卡上,不依赖 mouseenter——浮卡滑动盖住
    // 静止鼠标时 enter 不触发,光靠事件标志会永远收不起来
    const pop = popRef.current
    const pr = activeRef.current && pop ? pop.getBoundingClientRect() : null
    const overPop = !!pr && x >= pr.left && x <= pr.right && y >= pr.top && y <= pr.bottom
    if (inHot || overPop) {
      window.clearTimeout(hideTimerRef.current)
      if (!activeRef.current && !showTimerRef.current) {
        showTimerRef.current = window.setTimeout(() => {
          showTimerRef.current = 0
          activeRef.current = true
          setActive(true)
          const cur = listRef.current?.querySelector<HTMLElement>("[data-current='1']")
          if (cur) scrollListTo(cur)
        }, SHOW_DELAY)
      }
    } else {
      scheduleHide()
    }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY }
      evaluate(e.clientX, e.clientY)
    }
    const onLeave = () => {
      lastMouseRef.current = null
      scheduleHide()
    }
    // 点到检索区以外的任何地方:立即收起,不等延迟
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (railRef.current?.contains(t) || popRef.current?.contains(t)) return
      hideNow()
    }
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("pointerdown", onPointerDown, true)
    document.documentElement.addEventListener("mouseleave", onLeave)
    return () => {
      document.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.documentElement.removeEventListener("mouseleave", onLeave)
      window.clearTimeout(hideTimerRef.current)
      window.clearTimeout(showTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function hideNow() {
    window.clearTimeout(showTimerRef.current)
    showTimerRef.current = 0
    window.clearTimeout(hideTimerRef.current)
    activeRef.current = false
    setActive(false)
    setHoverIdx(null)
  }

  function scheduleHide() {
    window.clearTimeout(showTimerRef.current)
    showTimerRef.current = 0
    window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(hideNow, HIDE_DELAY)
  }

  /** 只滚浮卡列表;scrollIntoView 会把聊天区一起带动,不能用 */
  function scrollListTo(item: HTMLElement) {
    const list = listRef.current
    if (!list) return
    const relTop = item.offsetTop - list.offsetTop
    if (relTop < list.scrollTop) {
      list.scrollTop = relTop
    } else if (relTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = relTop + item.offsetHeight - list.clientHeight
    }
  }

  // ---------- 当前刻度:视口中线以下最后一根 ----------
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport || prompts.length === 0) return
    const compute = () => {
      const vpR = viewport.getBoundingClientRect()
      const center = vpR.top + vpR.height / 2
      let idx = -1
      prompts.forEach((p, i) => {
        const el = findMsgEl(p.id)
        if (el && el.getBoundingClientRect().top + el.offsetHeight / 2 <= center) idx = i
      })
      setCurrentIdx(idx)
    }
    compute()
    // 滚动会改变鼠标与热区的相对关系(鼠标不动但内容在动),重新评估一次
    const onScroll = () => {
      compute()
      const m = lastMouseRef.current
      if (m) evaluate(m.x, m.y)
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => viewport.removeEventListener("scroll", onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptsKey])

  // ---------- 刻度间距:等距排列,超出热区高度时压缩 ----------
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const fit = () => {
      const avail = el.clientHeight - 48
      const need = prompts.length * 2 + (prompts.length - 1) * 5 + 24
      setGap(need > avail && prompts.length > 1
        ? Math.max(2, (avail - 24 - prompts.length * 2) / (prompts.length - 1))
        : 5)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptsKey])

  // 切会话(live-store 同实例复用)时收起浮卡、清掉 hover
  useEffect(() => {
    hideNow()
  }, [promptsKey])

  // ---------- 波浪 + 列表跟随 ----------
  const wave = (mouseY: number) => {
    let nearest = -1
    let nearestD = Infinity
    tickRefs.current.forEach((t, i) => {
      if (!t) return
      const r = t.getBoundingClientRect()
      const d = mouseY - (r.top + r.height / 2)
      if (Math.abs(d) < nearestD) { nearestD = Math.abs(d); nearest = i }
      const g = Math.exp(-((d / WAVE_SIGMA) ** 2))
      t.style.width = `${TICK_W + (TICK_W_MAX - TICK_W) * g}px`
      if (!t.dataset.current && !t.dataset.collab) {
        t.style.backgroundColor = `color-mix(in oklch, var(--primary) ${Math.round(15 + 55 * g)}%, transparent)`
      }
    })
    if (nearest >= 0) syncPop(nearest)
  }

  const waveReset = () => {
    for (const t of tickRefs.current) {
      if (!t) continue
      t.style.width = ""
      t.style.backgroundColor = ""
    }
  }

  /** 高亮对应条目,并把浮卡垂直滑到「条目与刻度齐平」的位置(夹紧在可视区内) */
  const syncPop = (i: number) => {
    setHoverIdx(i)
    const col = containerRef.current
    const pop = popRef.current
    const tick = tickRefs.current[i]
    const item = itemRefs.current[i]
    if (!col || !pop || !tick || !item) return
    const colR = col.getBoundingClientRect()
    const tickR = tick.getBoundingClientRect()
    const tickCenter = tickR.top + tickR.height / 2 - colR.top
    const list = listRef.current
    const itemCenter = item.offsetTop - (list?.scrollTop ?? 0) + item.offsetHeight / 2
    const top = Math.max(12, Math.min(tickCenter - itemCenter, col.clientHeight - pop.offsetHeight - 12))
    setPopTop(top)
    if (list) scrollListTo(item)
  }

  const jumpTo = (p: PromptEntry) => {
    const viewport = getViewport()
    const el = findMsgEl(p.id)
    if (!viewport || !el) return
    const vpR = viewport.getBoundingClientRect()
    const elR = el.getBoundingClientRect()
    viewport.scrollTo({
      top: viewport.scrollTop + (elR.top - vpR.top) - viewport.clientHeight / 2 + elR.height / 2,
      behavior: "smooth",
    })
    el.classList.remove("prompt-target-flash")
    void el.offsetWidth
    el.classList.add("prompt-target-flash")
    hideNow()
  }

  if (prompts.length < 3) return null

  return (
    <>
      <div
        ref={railRef}
        onMouseMove={(e) => wave(e.clientY)}
        onMouseLeave={() => {
          waveReset()
          scheduleHide()
        }}
        className={cn(
          "absolute top-1/2 right-1.5 z-10 flex w-[22px] -translate-y-1/2 cursor-pointer flex-col items-end py-3 transition-all duration-200",
          active ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-1.5 opacity-0",
        )}
        style={{ gap }}
      >
        {prompts.map((p, i) => (
          <button
            key={p.id}
            ref={(el) => { tickRefs.current[i] = el }}
            type="button"
            aria-label={t("workspace.jumpToPrompt", { text: p.text.slice(0, 24) })}
            data-current={i === currentIdx ? "1" : undefined}
            data-collab={p.collab ? "1" : undefined}
            onClick={() => jumpTo(p)}
            className={cn(
              "h-0.5 w-2 flex-none rounded-full bg-primary/15 transition-[width,background-color] duration-150 ease-out",
              i === currentIdx && "bg-primary",
              p.collab && "bg-transparent ring-1 ring-inset ring-primary/20",
              p.collab && i === currentIdx && "ring-primary",
            )}
          />
        ))}
      </div>

      <div
        ref={popRef}
        onMouseEnter={() => window.clearTimeout(hideTimerRef.current)}
        onMouseLeave={() => scheduleHide()}
        className={cn(
          "absolute right-8 z-20 flex max-h-[min(480px,calc(100%-24px))] w-[248px] flex-col overflow-hidden rounded-xl border border-border bg-popover/90 text-popover-foreground shadow-pop backdrop-blur-md transition-[opacity,transform,top] duration-200",
          active ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-2 opacity-0",
        )}
        style={{ top: popTop }}
      >
        <div className="type-micro flex-none px-3.5 pt-2.5 pb-1.5 text-muted-foreground">
          {t("workspace.promptCount", { count: prompts.length })}
        </div>
        <div ref={listRef} className="overflow-y-auto px-1.5 pb-1.5">
          {prompts.map((p, i) => (
            <button
              key={p.id}
              ref={(el) => { itemRefs.current[i] = el }}
              type="button"
              data-current={i === currentIdx ? "1" : undefined}
              onClick={() => jumpTo(p)}
              onMouseEnter={() => {
                setHoverIdx(i)
                const t = tickRefs.current[i]
                if (t) t.style.width = `${TICK_W_MAX}px`
              }}
              onMouseLeave={() => {
                setHoverIdx(null)
                waveReset()
              }}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                i === hoverIdx && "bg-muted",
                p.collab ? "text-muted-foreground" : "text-foreground",
                i === currentIdx && "font-medium",
              )}
            >
              <span className={cn(
                "h-0.5 w-2 flex-none -translate-y-1 rounded-full bg-primary/20",
                (i === currentIdx || i === hoverIdx) && "bg-primary",
                p.collab && "bg-transparent ring-1 ring-inset ring-primary/20",
                p.collab && (i === currentIdx || i === hoverIdx) && "ring-primary",
              )} />
              <span className="min-w-0 truncate">{p.text}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
