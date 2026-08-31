import { Compass, Info } from "lucide-react"

import { Switch } from "@/components/ui/switch"
import { useApps, setAppEnabled } from "@/lib/apps-store"
import { toast } from "@/lib/toast"

export function AppsSection() {
  const { loaded, apps } = useApps()

  if (!window.bento) {
    return <p className="text-sm text-muted-foreground">Apps 仅在桌面版可用。</p>
  }
  if (!loaded) {
    return <p className="text-sm text-muted-foreground">正在读取 Apps…</p>
  }

  return (
    <div className="space-y-6">
      <p className="max-w-xl text-sm leading-6 text-muted-foreground">
        Apps 为 Harness 提供额外工具。开关会应用到新会话和下次恢复的会话。
      </p>
      {apps.map((app) => (
        <section key={app.id} className="border-y border-border py-5">
          <div className="flex items-start gap-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
              <Compass className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">{app.name}</h2>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">{app.description}</p>
                </div>
                <Switch
                  checked={app.enabled}
                  aria-label={`${app.enabled ? "关闭" : "打开"}${app.name} App`}
                  onCheckedChange={(enabled) => {
                    void setAppEnabled(app.id, enabled).then((error) => {
                      if (error) toast.error(error)
                    })
                  }}
                />
              </div>
              <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-[6rem_1fr]">
                <dt className="text-muted-foreground">提供能力</dt>
                <dd>Browser MCP · 导航、页面快照、点击、填写、滚动、截图</dd>
                <dt className="text-muted-foreground">支持</dt>
                <dd>{app.harnesses.join("、")}</dd>
              </dl>
              {app.unsupportedHarnesses.length > 0 && (
                <p className="mt-4 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {app.unsupportedHarnesses.join("、")} 当前不内置 MCP，因此不会注入 Browser MCP。
                </p>
              )}
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}
