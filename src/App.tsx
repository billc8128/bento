import { useEffect, useMemo, useRef, useState } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { PanelLeft } from "lucide-react"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarProvider } from "@/components/ui/sidebar"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { Toaster } from "@/components/Toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { TraitsProvider } from "@/lib/style-context"
import { ThemeProvider, type Theme } from "@/lib/theme-context"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  registerSidebarPanel,
  setSidebarCollapsed,
  toggleSidebarPanel,
  useSidebarCollapsed,
} from "@/lib/sidebar-toggle"
import { DockWorkspace } from "@/views/DockWorkspace"
import { getView } from "@/views/registry"
import "@/views/builtin"
import { DEFAULT_STYLE, STYLES, getStyle, type StyleId } from "@/data/styles"

/* 主题偏好持久化。localStorage 可能被禁用,全部 try/catch 静默降级 */
function loadStyle(): StyleId {
  try {
    const v = localStorage.getItem("bento.style")
    if (v && STYLES.some((s) => s.id === v)) return v as StyleId
  } catch {
    /* ignore */
  }
  return DEFAULT_STYLE
}

function loadDark(style: StyleId): boolean {
  try {
    const v = localStorage.getItem("bento.dark")
    if (v !== null) return v === "1"
  } catch {
    /* ignore */
  }
  return getStyle(style).tone === "dark"
}

export default function App() {
  const [style, setStyleState] = useState<StyleId>(loadStyle)
  const [dark, setDark] = useState<boolean>(() => loadDark(loadStyle()))
  const compact = useIsMobile()

  const { traits, layout } = getStyle(style)
  const sidebarLayout = compact
    ? { default: 215, min: 190, max: 240 }
    : layout.sidebar

  // 主题挂在 html 上:data-style 选配色套系,.dark 选明暗
  useEffect(() => {
    const root = document.documentElement
    root.dataset.style = style
    root.classList.toggle("dark", dark)
    try {
      localStorage.setItem("bento.style", style)
      localStorage.setItem("bento.dark", dark ? "1" : "0")
    } catch {
      /* ignore */
    }
  }, [style, dark])

  const theme = useMemo<Theme>(
    () => ({
      style,
      dark,
      /** 切主题时跟到这套主题本来设计的明暗,不然浅色向的那几套一上来就走样 */
      setStyle: (id) => {
        setStyleState(id)
        setDark(getStyle(id).tone === "dark")
      },
      setDark,
    }),
    [style, dark],
  )

  const Sessions = getView("core.sessions").component
  const sidebarPanelRef = useRef<PanelImperativeHandle>(null)
  const sidebarElRef = useRef<HTMLDivElement>(null)
  const sidebarCollapsed = useSidebarCollapsed()

  // ⌘B 与标题栏按钮共用同一个收折开关(收折是运行时状态,不持久化)。
  // 动画靠给面板元素临时挂 flex-grow transition:collapse/expand 改的是
  // 内联 flexGrow,浏览器自动补间;只在程序触发时挂,拖拽 resize 不受影响。
  // 展开条在收起的同一拍就出现:否则主区内容会先滑到红绿灯底下,
  // 动画结束时再被展开条猛地顶下去(肉眼可见的卡顿+重影)。
  useEffect(() => {
    const toggle = () => {
      const panel = sidebarPanelRef.current
      const el = sidebarElRef.current
      if (!panel) return
      if (el) {
        el.style.transition = "flex-grow 240ms cubic-bezier(0.32, 0.72, 0, 1)"
        window.setTimeout(() => {
          el.style.transition = ""
        }, 280)
      }
      if (panel.isCollapsed()) {
        setSidebarCollapsed(false) // 撤展开条,给回来的侧栏让位
        panel.expand()
      } else {
        setSidebarCollapsed(true)
        panel.collapse()
      }
    }
    const unregister = registerSidebarPanel(toggle)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "b" || (!e.metaKey && !e.ctrlKey)) return
      e.preventDefault()
      toggleSidebarPanel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      unregister()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <ThemeProvider value={theme}>
        <TraitsProvider value={traits}>
            <SidebarProvider className="h-screen min-h-0">
              <ResizablePanelGroup
                key={style}
                orientation="horizontal"
                className="min-h-0 bg-background text-foreground"
              >
                <ResizablePanel
                  panelRef={sidebarPanelRef}
                  elementRef={sidebarElRef}
                  collapsible
                  collapsedSize={0}
                  defaultSize={sidebarLayout.default}
                  minSize={sidebarLayout.min}
                  maxSize={sidebarLayout.max}
                  groupResizeBehavior="preserve-pixel-size"
                >
                  <Sessions />
                </ResizablePanel>

                {/* 分隔线本体交给侧栏的边框画,拖柄平时隐形,悬停/拖动时才显出来 */}
                <ResizableHandle className="-ml-1 w-1 bg-transparent transition-colors data-[separator=hover]:bg-primary/12 data-[separator=active]:bg-primary/25" />

                <ResizablePanel minSize={320}>
                  {/* 收起态:标题条占文档流(内容下移不重叠),兼作窗口拖拽区;
                      h-9 让按钮中线对齐 macOS 红绿灯(实测灯心约在内容顶 18px) */}
                  <div className="flex h-full flex-col">
                    {window.bento && sidebarCollapsed && (
                      <div className="app-window-drag flex h-9 shrink-0 items-center border-b border-border/60 bg-background pl-[76px] [-webkit-app-region:drag]">
                        <button
                          type="button"
                          onClick={toggleSidebarPanel}
                          title="展开侧边栏 (⌘B)"
                          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [-webkit-app-region:no-drag]"
                        >
                          <PanelLeft className="size-4" strokeWidth={1.8} />
                        </button>
                      </div>
                    )}
                    {/* 主区交给 dockview(受管模式);聊天面板经 view 注册表多实例渲染 */}
                    <div className="min-h-0 flex-1">
                      <DockWorkspace />
                    </div>
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
              <SettingsPage />
              <Toaster />
            </SidebarProvider>
        </TraitsProvider>
      </ThemeProvider>
    </TooltipProvider>
  )
}
