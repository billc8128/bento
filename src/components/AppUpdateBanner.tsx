import { useEffect, useState } from "react"
import { ArrowDownToLine, ArrowUpToLine, RotateCw, TriangleAlert } from "lucide-react"
import type { AppUpdateState } from "@/core/app-update"
import { useT } from "@/lib/i18n"

/** 底栏上方的更新横幅:只在有更新相关状态时出现(空闲/检查中不渲染)。
 * available=版本号+「立即更新」品牌钮;downloading=百分比+底部进度条;
 * downloaded/installing=旋转「正在安装,即将重启」(下载完 650ms 自动安装);
 * error=红色「更新失败」+「重试」。一句完整说明放 title/无障碍标签。 */
export function AppUpdateBanner() {
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
  const failed = state.status === "error"
  const label = t(`sidebar.update.${state.status}`, { version: state.version })
  const retry = () => {
    if (state.version) {
      void window.bento?.downloadAppUpdate().catch(() => {
        setState({ ...state, status: "error", errorStage: "download" })
      })
    } else {
      void window.bento?.checkAppUpdate().catch(() => {})
    }
  }

  return (
    <div
      role="status"
      aria-label={label}
      title={label}
      className={`relative mb-1.5 flex items-center gap-2 overflow-hidden rounded-lg px-2.5 py-1.5 text-xs ${
        failed ? "bg-err/10" : "bg-brand/12"
      }`}
    >
      {state.status === "available" && (
        <>
          <ArrowUpToLine className="size-3.5 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {t("settings.updateAvailable", { version: state.version })}
          </span>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-md bg-brand px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t("settings.updateNow")}
          </button>
        </>
      )}
      {downloading && (
        <>
          <ArrowDownToLine className="size-3.5 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0 flex-1 text-foreground tabular-nums">
            {t("settings.updateDownloading", { percent: Math.floor(state.percent) })}
          </span>
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 bg-brand transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${state.percent}%` }}
          />
        </>
      )}
      {(state.status === "downloaded" || state.status === "installing") && (
        <>
          <RotateCw className="size-3.5 shrink-0 animate-spin text-brand motion-reduce:animate-none" aria-hidden />
          <span className="min-w-0 flex-1 text-foreground">{t("settings.updateInstalling")}</span>
        </>
      )}
      {failed && (
        <>
          <TriangleAlert className="size-3.5 shrink-0 text-err" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-err">{t("settings.updateFailed")}</span>
          <button
            type="button"
            onClick={retry}
            className="shrink-0 rounded-md bg-err/15 px-2 py-0.5 text-[11px] font-medium text-err transition-colors hover:bg-err/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t("settings.updateRetry")}
          </button>
        </>
      )}
    </div>
  )
}
