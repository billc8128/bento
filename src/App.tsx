import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PanelImperativeHandle } from "react-resizable-panels"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarProvider } from "@/components/ui/sidebar"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { WorkspaceToolsPanel } from "@/components/workspace/WorkspaceToolsPanel"
import { PanelStateIcon, WindowPanelToggle } from "@/components/WindowPanelToggle"
import { Toaster } from "@/components/Toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { TraitsProvider } from "@/lib/style-context"
import { ThemeProvider, type Theme } from "@/lib/theme-context"
import { initProfileDefault } from "@/lib/profile-store"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  registerSidebarPanel,
  setSidebarCollapsed,
  toggleSidebarPanel,
  useSidebarCollapsed,
} from "@/lib/sidebar-toggle"
import { DockWorkspace } from "@/views/DockWorkspace"
import { getView } from "@/views/registry"
import { liveMeta, useLive } from "@/lib/live-store"
import { useLayout } from "@/lib/layout-store"
import { initCollaborationUi } from "@/lib/collaboration-ui"
import { requestNewSession } from "@/lib/new-session-store"
import { useSettingsPage } from "@/lib/settings-store"
import {
  setWorkspaceToolsOpen,
  toggleWorkspaceTools,
  useWorkspaceToolsOpen,
  useWorkspaceToolsStarted,
} from "@/lib/workspace-tools-store"
import { useWorkspaceBrowserReveal } from "@/lib/workspace-browser-reveal"
import { consumeWorkspaceFileReveal, useWorkspaceFileReveal } from "@/lib/workspace-file-reveal"
import "@/views/builtin"
import { DEFAULT_STYLE, STYLES, getStyle, type StyleId } from "@/data/styles"
import { cn } from "@/lib/utils"
import { browserRevealPanelWidth, sidePanelsFit } from "@/core/workspace-layout"

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
  // 协作 UI 桥:main→renderer 的 show/hide/focus 命令 + presence 上报(Phase 2)
  useEffect(() => initCollaborationUi(), [])
  // 本地资料:首次启动用系统用户名做默认显示名
  useEffect(() => initProfileDefault(), [])
  const workspaceToolsOpen = useWorkspaceToolsOpen()
  const workspaceToolsStarted = useWorkspaceToolsStarted()
  const browserRevealId = useWorkspaceBrowserReveal()
  const fileReveal = useWorkspaceFileReveal()
  const { focusedSessionId } = useLayout()
  const { sessions } = useLive()
  const settings = useSettingsPage()
  const focusedSession = focusedSessionId ? liveMeta(focusedSessionId) : sessions[0]
  const workspaceRoot = focusedSession?.scope === "project" ? focusedSession.cwd : ""

  const { traits, layout } = getStyle(style)
  const sidebarLayout = compact
    ? { default: 215, min: 190, max: 240 }
    : layout.sidebar

  // 主题挂在 html 上:data-style 选配色套系,.dark 选明暗
  useEffect(() => {
    const root = document.documentElement
    root.dataset.style = style
    root.classList.toggle("dark", dark)
    // 液态玻璃:整窗 vibrancy 由主进程接管,离开该套系即撤销
    window.bento?.setGlassVibrancy?.(style === "glass")
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
  const workspacePanelRef = useRef<PanelImperativeHandle>(null)
  const sidebarElRef = useRef<HTMLDivElement>(null)
  const workspacePanelElRef = useRef<HTMLDivElement>(null)
  const workspaceInitialRef = useRef(true)
  const workspaceProgrammaticResizeRef = useRef(false)
  const sidebarCollapsed = useSidebarCollapsed()

  // Codex 式悬停 peek:侧栏收起时,左缘热区悬停滑出悬浮侧栏,移出 250ms 后
  // 自动收回。侧栏本体在 0 宽面板里保持挂载(折叠不丢组件态,如文件夹开合);
  // peek 期间 overlay 是第二个实例,内容来自同一份 store。
  const [sidebarPeek, setSidebarPeek] = useState(false)
  const sidebarPeekTimerRef = useRef(0)
  const openSidebarPeek = () => {
    window.clearTimeout(sidebarPeekTimerRef.current)
    setSidebarPeek(true)
  }
  const closeSidebarPeek = () => {
    window.clearTimeout(sidebarPeekTimerRef.current)
    sidebarPeekTimerRef.current = window.setTimeout(() => setSidebarPeek(false), 250)
  }

  const preferredBrowserPanelWidth = useCallback(() => {
    const sidebarWidth = sidebarElRef.current?.getBoundingClientRect().width ?? sidebarLayout.default
    return browserRevealPanelWidth(window.innerWidth, sidebarWidth)
  }, [sidebarLayout.default])

  useEffect(() => {
    if (!browserRevealId) return
    setWorkspaceToolsOpen(true)
    window.requestAnimationFrame(() => workspacePanelRef.current?.resize(preferredBrowserPanelWidth()))
  }, [browserRevealId, preferredBrowserPanelWidth])

  // 聊天文件链接 → 右侧文件面板。root 对不上当前工作区(点了非焦点 pane 的
  // 链接,或 chat 会话没有工作区)时面板放不下,退回访达打开。
  // 命中时只负责展开面板;落哪个 tab、开哪个预览由 WorkspaceToolsPanel 消费。
  useEffect(() => {
    if (!fileReveal) return
    if (!workspaceRoot || fileReveal.root !== workspaceRoot) {
      consumeWorkspaceFileReveal(fileReveal.nonce)
      void window.bento?.openPath(`${fileReveal.root}/${fileReveal.relativePath}`)
      return
    }
    setWorkspaceToolsOpen(true)
  }, [fileReveal, workspaceRoot])

  // ⌘B 与标题栏按钮共用同一个收折开关(收折是运行时状态,不持久化)。
  // 动画靠给面板元素临时挂 flex-grow transition:collapse/expand 改的是
  // 内联 flexGrow,浏览器自动补间;只在程序触发时挂,拖拽 resize 不受影响。
  // 全局标题栏不参与面板宽度动画，因此左右栏开关在开合前后保持同一坐标。
  useEffect(() => {
    const toggle = () => {
      const panel = sidebarPanelRef.current
      const el = sidebarElRef.current
      if (!panel) return
      if (el) {
        el.style.transition = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? ""
          : "flex-grow 210ms cubic-bezier(0.16, 1, 0.3, 1)"
        window.setTimeout(() => {
          el.style.transition = ""
        }, 240)
      }
      if (panel.isCollapsed()) {
        const targetSidebarWidth = Math.max(sidebarLayout.min, sidebarLayout.default)
        const mainMinWidth = compact ? 320 : 420
        const workspaceWidth = Math.max(
          320,
          workspacePanelElRef.current?.getBoundingClientRect().width ?? 0,
        )
        const workspaceMustYield = workspaceToolsOpen && !sidePanelsFit(
          window.innerWidth,
          targetSidebarWidth,
          mainMinWidth,
          workspaceWidth,
        )
        setSidebarCollapsed(false)
        if (workspaceMustYield) {
          setWorkspaceToolsOpen(false)
          workspacePanelRef.current?.collapse()
          window.requestAnimationFrame(() => panel.expand())
        } else {
          panel.expand()
        }
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
  }, [compact, sidebarLayout.default, sidebarLayout.min, workspaceToolsOpen])

  // ⌘N 新对话:与侧栏「新对话」行同一入口
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "n" || (!e.metaKey && !e.ctrlKey) || e.shiftKey || e.altKey) return
      e.preventDefault()
      requestNewSession()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  useEffect(() => {
    const panel = workspacePanelRef.current
    const element = workspacePanelElRef.current
    if (!panel) return
    if (!workspaceInitialRef.current && element && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.style.transition = "flex-grow 210ms cubic-bezier(0.16, 1, 0.3, 1)"
    }
    workspaceInitialRef.current = false
    workspaceProgrammaticResizeRef.current = true
    if (workspaceToolsOpen) {
      const sidebarPanel = sidebarPanelRef.current
      const sidebarWidth = sidebarElRef.current?.getBoundingClientRect().width ?? 0
      const mainMinWidth = compact ? 320 : 420
      const availableWidth = window.innerWidth
      if (
        sidebarPanel &&
        !sidebarPanel.isCollapsed() &&
        !sidePanelsFit(availableWidth, sidebarWidth, mainMinWidth, 320)
      ) {
        setSidebarCollapsed(true)
        sidebarPanel.collapse()
      }
      window.requestAnimationFrame(() => panel.expand())
    } else {
      panel.collapse()
    }
    const timer = window.setTimeout(() => {
      if (element) element.style.transition = ""
      workspaceProgrammaticResizeRef.current = false
    }, 240)
    return () => {
      window.clearTimeout(timer)
      workspaceProgrammaticResizeRef.current = false
    }
  }, [compact, workspaceToolsOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "j" || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      toggleWorkspaceTools()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <ThemeProvider value={theme}>
        <TraitsProvider value={traits}>
            <SidebarProvider className="h-screen min-h-0 flex-col">
              {window.bento && (
                <div className="app-window-drag flex h-9 shrink-0 items-center border-b border-border/60 bg-background pl-[76px] pr-3 [-webkit-app-region:drag]">
                  <WindowPanelToggle
                    onClick={toggleSidebarPanel}
                    label={`${sidebarCollapsed ? "展开" : "收起"}侧边栏 (⌘B)`}
                  >
                    <PanelStateIcon side="left" expanded={!sidebarCollapsed} />
                  </WindowPanelToggle>
                  <span className="flex-1" />
                  <WindowPanelToggle
                    onClick={toggleWorkspaceTools}
                    label={`${workspaceToolsOpen ? "关闭" : "打开"}工具面板 (⌘J)`}
                  >
                    <PanelStateIcon side="right" expanded={workspaceToolsOpen} />
                  </WindowPanelToggle>
                </div>
              )}
              <ResizablePanelGroup
                key={style}
                orientation="horizontal"
                className="min-h-0 flex-1 bg-background text-foreground"
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
                  onResize={(size) => {
                    const collapsed = size.inPixels === 0
                    if (collapsed !== sidebarCollapsed) setSidebarCollapsed(collapsed)
                  }}
                >
                  <Sessions />
                </ResizablePanel>

                {/* 分隔线本体交给侧栏的边框画,拖柄平时隐形,悬停/拖动时才显出来 */}
                <ResizableHandle className="-ml-1 w-1 bg-transparent transition-colors data-[separator=hover]:bg-primary/12 data-[separator=active]:bg-primary/25" />

                <ResizablePanel minSize={compact ? 320 : 420}>
                  <div className="flex h-full flex-col">
                    {/* 主区交给 dockview(受管模式);聊天面板经 view 注册表多实例渲染 */}
                    <div className="min-h-0 flex-1">
                      <DockWorkspace />
                    </div>
                  </div>
                </ResizablePanel>

                <ResizableHandle className={cn("w-px bg-border transition-colors data-[separator=hover]:bg-primary/35 data-[separator=active]:bg-primary/55", !workspaceToolsOpen && "hidden")} />
                <ResizablePanel
                  panelRef={workspacePanelRef}
                  elementRef={workspacePanelElRef}
                  collapsible
                  collapsedSize={0}
                  defaultSize={workspaceToolsOpen ? 460 : 0}
                  minSize={320}
                  maxSize={680}
                  groupResizeBehavior="preserve-pixel-size"
                  onResize={(size) => {
                    if (size.inPixels !== 0 || !workspaceToolsOpen) return
                    window.requestAnimationFrame(() => {
                      if (
                        !workspaceProgrammaticResizeRef.current &&
                        workspacePanelRef.current?.isCollapsed()
                      ) setWorkspaceToolsOpen(false)
                    })
                  }}
                >
                  {workspaceToolsStarted && (
                    <div
                      className={cn(
                        "h-full transition-opacity duration-150 ease-out motion-reduce:transition-none",
                        workspaceToolsOpen ? "opacity-100 delay-50" : "opacity-0",
                      )}
                      aria-hidden={!workspaceToolsOpen}
                      inert={!workspaceToolsOpen}
                    >
                      <WorkspaceToolsPanel
                        key={workspaceRoot || "chat"}
                        workspaceRoot={workspaceRoot}
                        suspended={settings.open || !workspaceToolsOpen}
                      />
                    </div>
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>

              {/* Codex 式悬停 peek:收起后左缘热区滑出悬浮侧栏,移出自动收回。
                  悬浮层盖在内容上不占布局,窄窗口同样适用。
                  收起期间常驻挂载(位移进出才有动画),隐藏时不可聚焦不可点。 */}
              {sidebarCollapsed && (
                <>
                  <div
                    aria-hidden
                    className="fixed bottom-0 left-0 top-9 z-30 w-3"
                    onMouseEnter={openSidebarPeek}
                    onMouseLeave={closeSidebarPeek}
                  />
                  <div
                    aria-hidden={!sidebarPeek}
                    inert={!sidebarPeek}
                    className={cn(
                      "fixed bottom-0 left-0 top-9 z-40 border-r border-sidebar-border bg-background shadow-pop",
                      "transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                      sidebarPeek ? "translate-x-0" : "pointer-events-none -translate-x-full",
                    )}
                    style={{ width: sidebarLayout.default }}
                    onMouseEnter={openSidebarPeek}
                    onMouseLeave={closeSidebarPeek}
                  >
                    <Sessions />
                  </div>
                </>
              )}
              <SettingsPage />
              <Toaster />
            </SidebarProvider>
        </TraitsProvider>
      </ThemeProvider>
    </TooltipProvider>
  )
}
