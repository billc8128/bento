/** core.apps:应用管理主视图。单例面板(layout-store APPS_PANEL_ID),与对话面板平级;
 *  内容复用原设置板块的 AppsSection,设置页不再重复入口 */

import { Blocks } from "lucide-react"

import { AppsSection } from "@/components/settings/AppsSection"
import { ScrollArea } from "@/components/ui/scroll-area"

export function AppsPane() {
  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-col">
      {/* 与 ChatPane 非 minimal 头同构；左右栏开关统一位于全局窗口标题栏。 */}
      <header className="app-window-drag flex h-12 shrink-0 items-center gap-2 border-b px-4 [-webkit-app-region:drag]">
        <Blocks className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="app-title min-w-0 flex-1 truncate text-base font-semibold leading-tight">
          应用
        </h1>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {/* 内容宽度与设置页同规:max-w-2xl 居中(DESIGN.md 同类容器同一宽度) */}
        <div className="mx-auto w-full max-w-2xl px-6 py-6">
          <AppsSection />
        </div>
      </ScrollArea>
    </main>
  )
}
