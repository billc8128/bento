import { lazy, Suspense, useEffect, useRef, useState } from "react"
import {
  Check,
  Compass,
  FolderOpen,
  MoreHorizontal,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { PanelStateIcon } from "@/components/WindowPanelToggle"

const BrowserWorkspacePane = lazy(() => import("@/components/workspace/BrowserWorkspacePane").then((module) => ({ default: module.BrowserWorkspacePane })))
const FilesWorkspacePane = lazy(() => import("@/components/workspace/FilesWorkspacePane").then((module) => ({ default: module.FilesWorkspacePane })))
const TerminalWorkspacePane = lazy(() => import("@/components/workspace/TerminalWorkspacePane").then((module) => ({ default: module.TerminalWorkspacePane })))

type WorkspaceTabKind = "terminal" | "files" | "browser"

type WorkspaceTab = {
  id: string
  kind: WorkspaceTabKind
  title: string
}

const TAB_KINDS: Array<{ id: WorkspaceTabKind; label: string; icon: typeof TerminalSquare }> = [
  { id: "terminal", label: "终端", icon: TerminalSquare },
  { id: "files", label: "文件", icon: FolderOpen },
  { id: "browser", label: "浏览器", icon: Compass },
]

const TAB_ICON = Object.fromEntries(TAB_KINDS.map((item) => [item.id, item.icon])) as Record<WorkspaceTabKind, typeof TerminalSquare>

function initialTabs(): WorkspaceTab[] {
  return [
    { id: "terminal-1", kind: "terminal", title: "终端" },
    { id: "files-1", kind: "files", title: "文件" },
    { id: "browser-1", kind: "browser", title: "新标签页" },
  ]
}

function storageNamespace(workspaceRoot: string): string {
  return `bento.workspaceTools:${workspaceRoot || "chat"}`
}

function paneStorageKey(workspaceRoot: string, tabId: string): string {
  return `${storageNamespace(workspaceRoot)}:${tabId}`
}

function loadWorkspaceState(workspaceRoot: string, defaultTool: WorkspaceTabKind) {
  const fallback = { tabs: initialTabs(), activeId: `${defaultTool}-1` as string | null }
  try {
    const saved = JSON.parse(localStorage.getItem(storageNamespace(workspaceRoot)) ?? "null") as {
      tabs?: WorkspaceTab[]
      activeId?: string | null
    } | null
    if (!saved?.tabs || !Array.isArray(saved.tabs)) return fallback
    const tabs = saved.tabs.filter((tab) =>
      typeof tab?.id === "string" &&
      typeof tab?.title === "string" &&
      TAB_KINDS.some((kind) => kind.id === tab.kind))
    const activeId = tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId! : tabs[0]?.id ?? null
    return { tabs, activeId }
  } catch {
    return fallback
  }
}

function tabCounters(tabs: WorkspaceTab[]): Record<WorkspaceTabKind, number> {
  const counters = { terminal: 0, files: 0, browser: 0 }
  for (const tab of tabs) {
    const index = Number.parseInt(tab.id.slice(tab.kind.length + 1), 10)
    if (Number.isFinite(index)) counters[tab.kind] = Math.max(counters[tab.kind], index)
  }
  return counters
}

function tabTitle(kind: WorkspaceTabKind, index: number): string {
  if (kind === "terminal") return index === 1 ? "终端" : `终端 ${index}`
  if (kind === "files") return index === 1 ? "文件" : `文件 ${index}`
  return index === 1 ? "新标签页" : `新标签页 ${index}`
}

function WorkspaceTabBar({
  tabs,
  activeId,
  onActivate,
  onCloseTab,
  onAddTab,
  onClosePanel,
  onOverlayChange,
}: {
  tabs: WorkspaceTab[]
  activeId: string | null
  onActivate: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onAddTab: (kind: WorkspaceTabKind) => void
  onClosePanel?: () => void
  onOverlayChange: (open: boolean) => void
}) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const addButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const tab = activeId ? tabRefs.current.get(activeId) : null
    tab?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeId, tabs.length])

  function activate(tabId: string) {
    onActivate(tabId)
    window.requestAnimationFrame(() => tabRefs.current.get(tabId)?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" }))
  }

  function focusTab(tabId: string) {
    window.requestAnimationFrame(() => tabRefs.current.get(tabId)?.focus())
  }

  function closeAndFocus(tabId: string) {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    const remaining = tabs.filter((tab) => tab.id !== tabId)
    const nextFocusId = tabId === activeId
      ? remaining[Math.min(index, remaining.length - 1)]?.id
      : activeId ?? remaining[0]?.id
    onCloseTab(tabId)
    if (nextFocusId) focusTab(nextFocusId)
    else window.requestAnimationFrame(() => addButtonRef.current?.focus())
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, tabId: string) {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    let nextIndex: number | null = null
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length
    if (event.key === "Home") nextIndex = 0
    if (event.key === "End") nextIndex = tabs.length - 1
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      closeAndFocus(tabId)
      return
    }
    if (nextIndex === null) return
    event.preventDefault()
    const next = tabs[nextIndex]
    if (!next) return
    activate(next.id)
    focusTab(next.id)
  }

  return (
    <header className="app-window-drag flex h-11 shrink-0 items-center gap-1 border-b bg-background px-1.5 [-webkit-app-region:drag]">
      <div role="tablist" aria-label="工作区标签" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const Icon = TAB_ICON[tab.kind]
          const selected = tab.id === activeId
          return (
            <div key={tab.id} className={cn("group/tab flex h-8 min-w-24 max-w-44 flex-1 basis-40 items-center rounded-md transition-colors", selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
              <button ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id) }} type="button" role="tab" id={`workspace-tab-${tab.id}`} aria-selected={selected} aria-controls={`workspace-tabpanel-${tab.id}`} tabIndex={selected ? 0 : -1} title={tab.title} onClick={() => activate(tab.id)} onKeyDown={(event) => handleKeyDown(event, tab.id)} className="flex h-full min-w-0 flex-1 items-center gap-2 px-2.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"><Icon className="size-3.5 shrink-0" strokeWidth={1.8} /><span className={cn("truncate", tab.kind === "terminal" && "font-mono")}>{tab.title}</span></button>
              <button type="button" aria-label={`关闭 ${tab.title}`} title={`关闭 ${tab.title}`} tabIndex={-1} onClick={() => closeAndFocus(tab.id)} className={cn("mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-opacity hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", selected ? "opacity-75" : "opacity-0 group-hover/tab:opacity-75 group-focus-within/tab:opacity-75")}><X className="size-3" /></button>
            </div>
          )
        })}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-l pl-1 [-webkit-app-region:no-drag]">
        {tabs.length > 3 && (
          <DropdownMenu onOpenChange={onOverlayChange}>
            <DropdownMenuTrigger asChild><button type="button" aria-label="所有工作区标签" title="所有工作区标签" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">{tabs.map((tab) => { const Icon = TAB_ICON[tab.kind]; return <DropdownMenuItem key={tab.id} onSelect={() => activate(tab.id)} className="gap-2 py-1.5"><Icon className="size-4 shrink-0 text-muted-foreground" /><span className={cn("min-w-0 flex-1 truncate", tab.kind === "terminal" && "font-mono")}>{tab.title}</span>{tab.id === activeId && <Check className="size-3.5 shrink-0" />}</DropdownMenuItem> })}</DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu onOpenChange={onOverlayChange}>
          <DropdownMenuTrigger asChild><button ref={addButtonRef} type="button" aria-label="新建工作区标签" title="新建工作区标签" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><Plus className="size-4" /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">{TAB_KINDS.map((kind) => { const Icon = kind.icon; return <DropdownMenuItem key={kind.id} onSelect={() => onAddTab(kind.id)} className="py-1.5"><Icon className="size-4 text-muted-foreground" /><span>{kind.label}</span></DropdownMenuItem> })}</DropdownMenuContent>
        </DropdownMenu>
        <button type="button" aria-label="关闭工具面板" title="关闭工具面板" onClick={onClosePanel} className="window-panel-toggle grid size-8 place-items-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-100 ease-out hover:bg-muted hover:text-foreground active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:active:scale-100 motion-reduce:transition-none"><PanelStateIcon side="right" expanded /></button>
      </div>
    </header>
  )
}

function EmptyWorkspace({ onAdd }: { onAdd: (kind: WorkspaceTabKind) => void }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        <p className="px-3 text-xs text-muted-foreground">打开工作区工具</p>
        <div className="mt-2 space-y-1">{TAB_KINDS.map((kind) => { const Icon = kind.icon; return <button key={kind.id} type="button" onClick={() => onAdd(kind.id)} className="flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/65 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><Icon className="size-4 text-muted-foreground" /><span className="font-medium">{kind.label}</span></button> })}</div>
      </div>
    </div>
  )
}

export function WorkspaceToolsPanel({
  workspaceRoot = "",
  defaultTool = "terminal",
  suspended = false,
  onClose,
}: {
  workspaceRoot?: string
  defaultTool?: WorkspaceTabKind
  suspended?: boolean
  onClose?: () => void
}) {
  const [initial] = useState(() => loadWorkspaceState(workspaceRoot, defaultTool))
  const [tabs, setTabs] = useState<WorkspaceTab[]>(initial.tabs)
  const [activeId, setActiveId] = useState<string | null>(initial.activeId)
  const [visited, setVisited] = useState(() => new Set(initial.activeId ? [initial.activeId] : []))
  const [overlayOpen, setOverlayOpen] = useState(false)
  const counters = useRef<Record<WorkspaceTabKind, number>>(tabCounters(initial.tabs))

  useEffect(() => {
    try {
      localStorage.setItem(storageNamespace(workspaceRoot), JSON.stringify({ tabs, activeId }))
    } catch {
      /* ignore */
    }
  }, [activeId, tabs, workspaceRoot])

  function activateTab(tabId: string) {
    setActiveId(tabId)
    setVisited((current) => current.has(tabId) ? current : new Set(current).add(tabId))
  }

  function addTab(kind: WorkspaceTabKind) {
    const index = ++counters.current[kind]
    const tab = { id: `${kind}-${index}`, kind, title: tabTitle(kind, index) }
    setTabs((current) => [...current, tab])
    activateTab(tab.id)
  }

  function closeTab(tabId: string) {
    const closing = tabs.find((tab) => tab.id === tabId)
    if (closing?.kind === "browser" || closing?.kind === "files") {
      try { localStorage.removeItem(paneStorageKey(workspaceRoot, tabId)) } catch { /* ignore */ }
    }
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId)
      const next = current.filter((tab) => tab.id !== tabId)
      if (activeId === tabId) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null)
      return next
    })
  }

  function renameTab(tabId: string, title: string) {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, title } : tab))
  }

  return (
    <aside className="flex h-full min-h-0 min-w-80 flex-col overflow-hidden bg-background text-foreground">
      <WorkspaceTabBar tabs={tabs} activeId={activeId} onActivate={activateTab} onCloseTab={closeTab} onAddTab={addTab} onClosePanel={onClose} onOverlayChange={setOverlayOpen} />
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 && <EmptyWorkspace onAdd={addTab} />}
        {tabs.map((tab) => {
          const active = tab.id === activeId
          return (
            <div key={tab.id} role="tabpanel" id={`workspace-tabpanel-${tab.id}`} aria-labelledby={`workspace-tab-${tab.id}`} hidden={!active} className={cn("absolute inset-0 flex min-h-0 flex-col", !active && "hidden")}>
              {visited.has(tab.id) && (
                <Suspense fallback={<div className="grid h-full place-items-center text-xs text-muted-foreground">正在打开工具…</div>}>
                  {tab.kind === "terminal" && <TerminalWorkspacePane cwd={workspaceRoot} onTitleChange={(title) => renameTab(tab.id, title)} />}
                  {tab.kind === "files" && <FilesWorkspacePane root={workspaceRoot} instanceId={tab.id} storageKey={paneStorageKey(workspaceRoot, tab.id)} />}
                  {tab.kind === "browser" && <BrowserWorkspacePane active={active} suspended={suspended || overlayOpen} storageKey={paneStorageKey(workspaceRoot, tab.id)} onTitleChange={(title) => renameTab(tab.id, title)} />}
                </Suspense>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
