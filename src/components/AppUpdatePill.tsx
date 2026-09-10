import { useEffect, useState } from "react"
import { ArrowDownToLine, ArrowUpToLine, Check, RotateCw, TriangleAlert } from "lucide-react"
import type { AppUpdateState } from "@/core/app-update"
import { useT } from "@/lib/i18n"

/** 下载进度环:绕着图标的一圈 brand 描边,替代旧的整钮填充。 */
function ProgressRing({ percent }: { percent: number }) {
  const circumference = 2 * Math.PI * 9
  return (
    <svg aria-hidden className="absolute inset-[3px] -rotate-90" viewBox="0 0 22 22">
      <circle className="fill-none stroke-border" cx="11" cy="11" r="9" strokeWidth="2" />
      <circle
        className="fill-none stroke-brand transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none"
        cx="11" cy="11" r="9" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
  )
}

/** 底栏更新入口:与主题切换同一套幽灵小钮语言,注意力只交给一枚琥珀点。
 * available=图标+琥珀点(点击下载);downloading=进度环;downloaded=品牌色对勾;
 * installing=旋转;error=红色警告(点击重试)。文案全部走 tooltip/无障碍标签。 */
export function AppUpdatePill() {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const { t } = useT()
  useEffect(() => {
    const api = window.bento
    if (!api) return
    let active = true
    let receivedEvent = false
    const unsubscribe = api.onAppUpdate((next) => { receivedEvent = true; setState(next) })
    void api.getAppUpdate().then((next) => {
      if (active && !receivedEvent) setState(next)
    }).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])

  if (!state || state.status === "idle" || state.status === "checking" || !state.version) return null
  const downloading = state.status === "downloading"
  const actionable = state.status === "available" || state.status === "error"
  const label = t(`sidebar.update.${state.status}`, { version: state.version })

  return (
    <>
      <button
        type="button"
        className="relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-default aria-disabled:hover:text-muted-foreground"
        title={label}
        aria-label={label}
        aria-disabled={!actionable}
        onClick={() => {
          if (!actionable) return
          void window.bento?.downloadAppUpdate().catch(() => {
            setState({ ...state, status: "error", errorStage: "download" })
          })
        }}
      >
        {state.status === "available" && (
          <>
            <ArrowUpToLine className="size-3.5" aria-hidden />
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" />
          </>
        )}
        {downloading && (
          <>
            <ProgressRing percent={state.percent} />
            <ArrowDownToLine className="size-3" aria-hidden />
          </>
        )}
        {state.status === "downloaded" && <Check className="size-3.5 text-brand" aria-hidden />}
        {state.status === "installing" && (
          <RotateCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        )}
        {state.status === "error" && <TriangleAlert className="size-3.5 text-err" aria-hidden />}
      </button>
      <span className="sr-only" role="status">{label}</span>
      {downloading && <span className="sr-only" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(state.percent)} />}
    </>
  )
}
