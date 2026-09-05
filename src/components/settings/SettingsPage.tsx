/**
 * 设置页:全屏页面(不再是弹窗),左导航 + 右内容,与 Cindy 的设置形态一致。
 * 全局开关状态在 settings-store,AppSidebar 与 RuntimePicker 都经它打开。
 * z-40:比 radix 弹层(z-50)低一层,供应商向导等 dialog 仍然压在设置页之上。
 */

import { useEffect, useState } from "react"
import { ChevronLeft, Cpu, Keyboard, Palette, Plug } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { closeSettings, openSettings, useSettingsPage, type SettingsSection } from "@/lib/settings-store"
import { cn } from "@/lib/utils"

import { AppearanceSection } from "./AppearanceSection"
import { HarnessesSection } from "./HarnessesSection"
import { ProvidersSection } from "./ProvidersSection"
import { ShortcutsSection } from "./ShortcutsSection"

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Plug }[] = [
  { id: "providers", label: "供应商", icon: Plug },
  { id: "harnesses", label: "运行环境", icon: Cpu },
  { id: "appearance", label: "主题", icon: Palette },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
]

export function SettingsPage() {
  const settings = useSettingsPage()
  const [section, setSection] = useState<SettingsSection>(settings.section)

  // 每次打开跟随调用方指定的板块(渲染期调整,不开 effect);
  // 页面内的点击切换归本地 state 管
  const [prevOpen, setPrevOpen] = useState(settings.open)
  if (settings.open !== prevOpen) {
    setPrevOpen(settings.open)
    if (settings.open) setSection(settings.section)
  }

  // Esc 关闭;但有 dialog/popover 等浮层开着时让浮层自己消化这次按键
  useEffect(() => {
    if (!settings.open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      const overlayOpen = document.querySelector(
        '[role="dialog"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="select-content"]',
      )
      if (!overlayOpen) closeSettings()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [settings.open])

  // Electron 的 drag region 不遵守普通 z-index：设置页覆盖在侧栏上方时，
  // 底层侧栏 drag rect 仍会抢走原生鼠标事件。设置打开期间显式停用底层拖拽区。
  useEffect(() => {
    if (!settings.open) return
    document.documentElement.dataset.settingsOpen = "true"
    return () => {
      delete document.documentElement.dataset.settingsOpen
    }
  }, [settings.open])

  if (!settings.open) return null

  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]

  return (
    <div className="fixed inset-0 z-40 flex bg-background text-foreground">
      {window.bento && (
        <div
          aria-hidden
          className="absolute left-55 right-0 top-0 z-10 h-10 [-webkit-app-region:drag]"
        />
      )}
      {/* w-55 = 220px,与主侧栏同宽:进出设置时左栏不跳宽 */}
      <nav className="flex w-55 shrink-0 flex-col gap-0.5 border-r border-border bg-muted/40 p-3">
        {/* 桌面模式:给 macOS 红绿灯让位,兼作窗口拖拽区(同 AppSidebar) */}
        {window.bento && <div className="-mx-3 -mt-3 mb-1 h-7 shrink-0 [-webkit-app-region:drag]" />}
        <Button
          type="button"
          variant="ghost"
          className="mb-2 h-8 w-full justify-start gap-2 px-2"
          onClick={closeSettings}
        >
          <ChevronLeft className="size-4 opacity-70" />
          <span>设置</span>
        </Button>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSection(item.id)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              section === item.id && "bg-accent font-medium text-foreground",
            )}
          >
            <item.icon className="size-4 opacity-70" />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-2xl px-8 pb-16 pt-10">
            <h1 className="text-lg font-semibold">{active.label}</h1>
            <div className="mt-6">
              {section === "providers" && (
                <ProvidersSection addProviderIntent={settings.addProvider} />
              )}
              {section === "harnesses" && (
                <HarnessesSection onAddModel={() => {
                  setSection("providers")
                  openSettings("providers", { addProvider: true })
                }} />
              )}
              {section === "appearance" && <AppearanceSection />}
              {section === "shortcuts" && <ShortcutsSection />}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
