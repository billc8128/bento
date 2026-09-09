import { useEffect, useState } from "react"
import { ArrowDownToLine, ArrowUpToLine, Check, RotateCw } from "lucide-react"
import type { AppUpdateState } from "@/core/app-update"
import { useT } from "@/lib/i18n"

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
  const Icon = downloading ? ArrowDownToLine
    : state.status === "downloaded" ? Check
      : state.status === "installing" || state.status === "error" ? RotateCw : ArrowUpToLine

  return (
    <>
      <button
        type="button"
        className="app-update-pill"
        data-state={state.status}
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
        <span className="app-update-fill" style={{ transform: `scaleX(${state.percent / 100})` }} />
        <Icon className={state.status === "installing" ? "app-update-spin" : undefined} aria-hidden />
        {downloading && <span className="app-update-percent" aria-hidden>{Math.floor(state.percent)}%</span>}
      </button>
      <span className="sr-only" role="status">{label}</span>
      {downloading && <span className="sr-only" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(state.percent)} />}
    </>
  )
}
