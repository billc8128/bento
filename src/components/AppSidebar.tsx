import { useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Keyboard,
  LogOut,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Palette,
  Pencil,
  PenSquare,
  RotateCcw,
  Search,
  Settings,
  SquareSplitHorizontal,
  Trash2,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { BentoLogo } from "@/components/BentoLogo"
import { PanelStateIcon, WindowPanelToggle } from "@/components/WindowPanelToggle"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FolderIcon } from "@/components/FolderIcon"
import { PinIcon } from "@/components/PinIcon"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { useTraits } from "@/lib/style-context"
import { useTheme } from "@/lib/theme-context"
import { closeSession, openSession, resetLayout, setLayoutMode, useLayout } from "@/lib/layout-store"
import { closeNewSession } from "@/lib/new-session-store"
import {
  hideFolder,
  renameFolder,
  toggleFolderPin,
  useFolderPreferences,
} from "@/lib/folder-preferences"
import { isRunning, removeLive, renameLive, useLive } from "@/lib/live-store"
import { togglePin, usePinnedSessions } from "@/lib/pinned-sessions"
import { toggleSidebarPanel } from "@/lib/sidebar-toggle"
import { requestNewSession } from "@/lib/new-session-store"
import { openSettings } from "@/lib/settings-store"
import { SESSION_MIME } from "@/views/DockWorkspace"
import { STYLES, type SidebarShape, type StyleId } from "@/data/styles"

/** 外层包裹:浮岛要靠四周留白才浮得起来 */
const FRAME: Record<SidebarShape, string> = {
  flush: "h-full",
  island: "h-full py-2.5 pl-2.5",
  bare: "h-full",
}

/** 面板本身:边界是画一条线、描一圈框,还是干脆不画 */
const PANEL: Record<SidebarShape, string> = {
  flush: "border-r border-sidebar-border",
  island: "rounded-xl border border-sidebar-border shadow-lg",
  bare: "",
}

/** 会话目录名展示:取路径最后一段 */
function dirLabel(cwd: string): string {
  const short = cwd.replace(/^~(?=$|\/)/, "").split("/").filter(Boolean)
  return short.at(-1) ?? "/"
}

/** 会话行的相对时间:刚刚 / Nm / Nh / 昨天 / 周X / M-D */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diff = Date.now() - then
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return "昨天"
  if (days < 7) return `${days}d`
  const d = new Date(then)
  return `${d.getMonth() + 1}-${d.getDate()}`
}


export function AppSidebar() {
  const { sidebar: shape } = useTraits()
  const { focusedSessionId, mode } = useLayout()
  const { sessions: liveSessions } = useLive()
  const theme = useTheme()
  const pinned = usePinnedSessions()
  const folderPreferences = useFolderPreferences()
  /** 行内重命名:Electron 不支持 window.prompt,换成输入框就地编辑 */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ key: string; title: string } | null>(null)
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null)
  const [openFolderMenu, setOpenFolderMenu] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set())
  const [chatExpanded, setChatExpanded] = useState(false)
  const [chatArchiveOpen, setChatArchiveOpen] = useState(false)
  const [chatQuery, setChatQuery] = useState("")

  const chatKeys = useMemo(
    () => liveSessions.filter((session) => session.scope === "chat").map((session) => session.key),
    [liveSessions],
  )
  const filteredChats = useMemo(() => {
    const needle = chatQuery.trim().toLowerCase()
    return liveSessions.filter((session) =>
      session.scope === "chat" && (!needle || session.title.toLowerCase().includes(needle)))
  }, [chatQuery, liveSessions])

  // 会话按工作目录分组(真实数据推导,没有 mock 填充);置顶区是引用——
  // 会话在原文件夹组里照常显示,不从组里抽走(不然整组被置顶后文件夹就没了)
  const { groups, pinnedKeys } = useMemo(() => {
    const projectSessions = liveSessions.filter((session) => session.scope === "project")
    const pinnedKeys = projectSessions.filter((s) => pinned.has(s.key)).map((s) => s.key)
    const map = new Map<string, { cwd: string; keys: string[] }>()
    for (const s of projectSessions) {
      const g = map.get(s.cwd) ?? { cwd: s.cwd, keys: [] }
      g.keys.push(s.key)
      map.set(s.cwd, g)
    }
    const pinnedFolders = new Set(folderPreferences.pinned)
    const hiddenFolders = new Set(folderPreferences.hidden)
    const groups = [...map.values()]
      .filter((group) => !hiddenFolders.has(group.cwd))
      .sort((a, b) => Number(pinnedFolders.has(b.cwd)) - Number(pinnedFolders.has(a.cwd)))
    return { groups, pinnedKeys }
  }, [folderPreferences, liveSessions, pinned])

  function confirmRename(key: string, value: string) {
    setRenaming(null)
    const title = value.trim()
    if (title) void renameLive(key, title)
  }

  function confirmFolderRename(cwd: string, value: string) {
    setRenamingFolder(null)
    if (value.trim()) renameFolder(cwd, value)
  }

  /** 会话行:置顶区与文件夹组共用。hover 出行内快捷 pin + ⋯,平时只留状态图标 */
  function renderRow(key: string, options: { allowPin?: boolean } = {}) {
    const allowPin = options.allowPin ?? true
    const s = liveSessions.find((x) => x.key === key)!
    const active = key === focusedSessionId
    const running = isRunning(key)
    const isPinned = pinned.has(key)
    if (renaming === key) {
      return (
        <SidebarMenuItem key={key}>
          <div className="flex h-8 items-center px-2.5">
            <Input
              autoFocus
              defaultValue={s.title}
              aria-label="重命名会话"
              className="h-6 flex-1 rounded-md px-1 text-sm"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRename(key, e.currentTarget.value)
                if (e.key === "Escape") setRenaming(null)
              }}
              onBlur={(e) => confirmRename(key, e.target.value)}
            />
          </div>
        </SidebarMenuItem>
      )
    }
    return (
      <SidebarMenuItem key={key}>
        <SidebarMenuButton
          isActive={active}
          onClick={() => {
            openSession(key)
            closeNewSession()
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SESSION_MIME, key)
            e.dataTransfer.effectAllowed = "move"
          }}
          className={cn(
            "h-8 gap-2 px-2.5 group-hover/menu-item:pr-24 group-focus-within/menu-item:pr-24",
            openSessionMenu === key && "pr-24",
          )}
        >
          <span className="flex-1 truncate text-sm">{s.title}</span>
          {running && (
            <span className="relative flex size-1.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-ok" />
            </span>
          )}
          {/* 平时只露置顶标;hover 换成 时间 + pin + ⋯ 快捷操作 */}
          {!running && allowPin && isPinned && (
            <PinIcon className="size-3 text-muted-foreground group-hover/menu-item:hidden" />
          )}
        </SidebarMenuButton>
        <span
          className={cn(
            "invisible absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 group-hover/menu-item:visible group-focus-within/menu-item:visible",
            openSessionMenu === key && "visible",
          )}
        >
          {!running && (
            <span className="px-0.5 type-micro tabular-nums text-muted-foreground">
              {relativeTime(s.updatedAt)}
            </span>
          )}
          {allowPin && (
            <button
              type="button"
              title={isPinned ? "取消置顶" : "置顶"}
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
              onClick={() => togglePin(key)}
            >
              <PinIcon filled={isPinned} className="size-3" />
            </button>
          )}
          <DropdownMenu
            open={openSessionMenu === key}
            onOpenChange={(next) => setOpenSessionMenu(next ? key : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="会话操作"
                className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="right"
              align="start"
              collisionPadding={{ top: 44, right: 8, bottom: 8, left: 8 }}
              className="w-40"
            >
              {allowPin && (
                <DropdownMenuItem className="gap-2 text-sm" onSelect={() => togglePin(key)}>
                  <PinIcon filled={isPinned} className="size-3.5 opacity-70" />
                  {isPinned ? "取消置顶" : "置顶"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="gap-2 text-sm" onSelect={() => setRenaming(key)}>
                <Pencil className="size-4 opacity-70" />
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 text-sm text-destructive focus:text-destructive"
                onSelect={() => setDeleting({ key, title: s.title })}
              >
                <Trash2 className="size-4 opacity-70" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </SidebarMenuItem>
    )
  }

  return (
    <div className={cn("w-full", FRAME[shape])}>
      <Sidebar collapsible="none" className={cn("h-full w-full overflow-hidden", PANEL[shape])}>
      {/* 桌面模式:给 macOS 红绿灯让位,整条兼作窗口拖拽区;左侧放 Codex 式收折钮。
          h-9:实测红绿灯中线约在内容顶 18px,h-7 时图标偏高 4px */}
      {window.bento && (
        <div className="app-window-drag flex h-9 shrink-0 items-center pl-[76px] [-webkit-app-region:drag]">
          <WindowPanelToggle
            onClick={toggleSidebarPanel}
            label="收起侧边栏 (⌘B)"
          >
            <PanelStateIcon side="left" expanded />
          </WindowPanelToggle>
        </div>
      )}
      <SidebarHeader className="gap-2 px-4 pb-3 pt-1.5">
        <div className="app-window-drag flex items-center justify-between [-webkit-app-region:drag]">
          <span className="flex items-center gap-2.5">
            <BentoLogo className="size-9" />
            <span className="app-title text-base font-semibold tracking-tight">Bento</span>
          </span>
          {/* 方案 A:新对话收成 icon,与搜索并排,侧栏不再有重色块 */}
          <span className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
            <Button variant="ghost" size="icon" className="size-7" title="搜索对话">
              <Search className="size-4" />
              <span className="sr-only">搜索对话</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              title="新对话"
              onClick={() => requestNewSession()}
            >
              <PenSquare className="size-4" />
              <span className="sr-only">新对话</span>
            </Button>
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3">
        <SidebarGroup className="p-0">
          <div className="space-y-4 pb-2">
              <section className="group/chat border-b border-sidebar-border pb-2">
                <div className="flex h-7 items-center px-1 text-sm font-medium text-sidebar-foreground">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <MessageCircle className="size-4" />
                    Chat
                  </span>
                  <button
                    type="button"
                    title="新建 Chat"
                    aria-label="新建 Chat"
                    onClick={() => requestNewSession({ scope: "chat" })}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-hover/chat:opacity-100 group-focus-within/chat:opacity-100"
                  >
                    <PenSquare className="size-3.5" />
                  </button>
                </div>
                {chatKeys.length > 0 && (
                  <SidebarMenu className="gap-0.5">
                    {renderRow(chatKeys[0], { allowPin: false })}
                  </SidebarMenu>
                )}
                {chatKeys.length > 1 && (
                  <Collapsible open={chatExpanded} onOpenChange={setChatExpanded}>
                    <CollapsibleContent className="collapsible-section">
                      <div className="max-h-[8.5rem] overflow-y-auto pr-0.5">
                        <SidebarMenu className="gap-0.5">
                          {chatKeys.slice(1).map((key) => renderRow(key, { allowPin: false }))}
                        </SidebarMenu>
                      </div>
                    </CollapsibleContent>
                    <div className="mt-1 flex h-6 items-center">
                      <CollapsibleTrigger className="flex h-6 items-center gap-1 rounded px-2 type-micro text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        {chatExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                        {chatExpanded ? "收起" : `更多 ${chatKeys.length - 1} 条`}
                      </CollapsibleTrigger>
                      <button
                        type="button"
                        tabIndex={chatExpanded ? 0 : -1}
                        aria-hidden={!chatExpanded}
                        onClick={() => {
                          setChatQuery("")
                          setChatArchiveOpen(true)
                        }}
                        className={cn(
                          "ml-auto h-6 rounded px-2 type-micro text-muted-foreground opacity-0 transition-[color,opacity] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          chatExpanded ? "opacity-100" : "pointer-events-none",
                        )}
                      >
                        全部
                      </button>
                    </div>
                  </Collapsible>
                )}
              </section>
              {/* 置顶区:脱离文件夹组,集中在顶部 */}
              {pinnedKeys.length > 0 && (
                <Collapsible defaultOpen>
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-1 pb-1.5 text-muted-foreground transition-colors hover:text-sidebar-foreground">
                    <PinIcon className="size-3" />
                    <span className="type-micro font-semibold tracking-[0.08em]">置顶</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="collapsible-section">
                    <SidebarMenu className="gap-0.5">
                      {pinnedKeys.map((key) => renderRow(key))}
                    </SidebarMenu>
                  </CollapsibleContent>
                </Collapsible>
              )}
              <div className="space-y-1">
                {groups.map((g) => {
                  const open = !closedGroups.has(g.cwd)
                  const label = folderPreferences.aliases[g.cwd] ?? dirLabel(g.cwd)
                  const isPinnedFolder = folderPreferences.pinned.includes(g.cwd)
                  return (
                    <Collapsible
                      key={g.cwd}
                      open={open}
                      onOpenChange={(next) => {
                        setClosedGroups((previous) => {
                          const updated = new Set(previous)
                          if (next) updated.delete(g.cwd)
                          else updated.add(g.cwd)
                          return updated
                        })
                      }}
                    >
                      {/* 分组小节标题:点击名称收折;hover 时右侧出现管理与新对话。 */}
                      {renamingFolder === g.cwd ? (
                        <div className="flex h-7 items-center px-1">
                          <Input
                            autoFocus
                            defaultValue={label}
                            aria-label="重命名文件夹分组"
                            className="h-6 flex-1 rounded-md px-1 text-sm"
                            onFocus={(event) => event.currentTarget.select()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") confirmFolderRename(g.cwd, event.currentTarget.value)
                              if (event.key === "Escape") setRenamingFolder(null)
                            }}
                            onBlur={(event) => confirmFolderRename(g.cwd, event.currentTarget.value)}
                          />
                        </div>
                      ) : (
                        <div className="group/folder relative flex h-7 items-center">
                          <CollapsibleTrigger className="flex h-full w-full items-center gap-2 px-1 pr-14 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:text-sidebar-foreground">
                            <FolderIcon open={open} className="size-4" />
                            <span className="truncate">{label}</span>
                            {isPinnedFolder && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
                          </CollapsibleTrigger>
                          <span
                            className={cn(
                              "absolute right-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/folder:opacity-100 group-focus-within/folder:opacity-100",
                              openFolderMenu === g.cwd && "opacity-100",
                            )}
                          >
                            <DropdownMenu
                              open={openFolderMenu === g.cwd}
                              onOpenChange={(next) => setOpenFolderMenu(next ? g.cwd : null)}
                            >
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  title="文件夹操作"
                                  aria-label={`${label} 文件夹操作`}
                                  className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                >
                                  <MoreHorizontal className="size-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="w-40">
                                <DropdownMenuItem className="gap-2 text-sm" onSelect={() => toggleFolderPin(g.cwd)}>
                                  <PinIcon filled={isPinnedFolder} className="size-3.5 opacity-70" />
                                  {isPinnedFolder ? "取消置顶" : "置顶文件夹"}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="gap-2 text-sm" onSelect={() => setRenamingFolder(g.cwd)}>
                                  <Pencil className="size-4 opacity-70" />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  className="gap-2 text-sm"
                                  onSelect={() => hideFolder(g.cwd)}
                                >
                                  <Trash2 className="size-4 opacity-70" />
                                  从侧栏移除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <button
                              type="button"
                              title="在此文件夹中新建对话"
                              aria-label={`在 ${label} 中新建对话`}
                              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                              onClick={() => requestNewSession({ scope: "project", cwd: g.cwd })}
                            >
                              <PenSquare className="size-3.5" />
                            </button>
                          </span>
                        </div>
                      )}
                      <CollapsibleContent className="collapsible-section">
                        <SidebarMenu className="gap-0.5">
                          {g.keys.map((key) => renderRow(key))}
                        </SidebarMenu>
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </div>
            </div>
        </SidebarGroup>
      </SidebarContent>

        <SidebarFooter className="px-2 pb-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton className="h-auto gap-2.5 px-2 py-1.5">
                <Avatar size="sm">
                  <AvatarFallback className="type-micro bg-primary/15 font-semibold text-sidebar-foreground">
                    DV
                  </AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0">
                  <span className="truncate text-xs font-medium">dev</span>
                  <span className="type-micro truncate text-muted-foreground">
                    dev@bento.local
                  </span>
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel className="flex flex-col gap-0 text-xs">
                <span className="font-medium text-foreground">dev</span>
                <span className="type-micro font-normal text-muted-foreground">
                  dev@bento.local
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {/* 主题切换收进账户菜单——主题是用户偏好,不是原型对比工具 */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 text-sm">
                  <Palette className="size-4 opacity-70" />
                  <span className="flex-1">主题</span>
                  <span className="type-micro text-muted-foreground">
                    {STYLES.find((s) => s.id === theme.style)?.name}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuRadioGroup
                    value={theme.style}
                    onValueChange={(v) => theme.setStyle(v as StyleId)}
                  >
                    {STYLES.map((s) => (
                      <DropdownMenuRadioItem key={s.id} value={s.id} className="text-sm">
                        {s.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={theme.dark}
                    onCheckedChange={theme.setDark}
                    className="gap-2 text-sm"
                  >
                    <Moon className="size-4 opacity-70" />
                    深色模式
                  </DropdownMenuCheckboxItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {/* 布局:自由模式 opt-in(ARCHITECTURE.md §6.1),重置回默认 */}
              <DropdownMenuCheckboxItem
                checked={mode === "free"}
                onCheckedChange={(v) => setLayoutMode(v ? "free" : "managed")}
                className="gap-2 text-sm"
              >
                <SquareSplitHorizontal className="size-4 opacity-70" />
                自由布局
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem className="gap-2 text-sm" onSelect={() => resetLayout()}>
                <RotateCcw className="size-4 opacity-70" />
                重置布局
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 text-sm" onSelect={() => openSettings("providers")}>
                <Settings className="size-4 opacity-70" />
                设置
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-sm" onSelect={() => openSettings("shortcuts")}>
                <Keyboard className="size-4 opacity-70" />
                快捷键
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2 text-sm text-destructive focus:text-destructive">
                <LogOut className="size-4 opacity-70" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>

      <Dialog
        open={chatArchiveOpen}
        onOpenChange={(open) => {
          setChatArchiveOpen(open)
          if (!open) setChatQuery("")
        }}
      >
        <DialogContent className="flex h-[min(34rem,calc(100vh-3rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>全部 Chat</DialogTitle>
            <DialogDescription className="sr-only">搜索或浏览全部 Chat 会话</DialogDescription>
          </DialogHeader>
          <div className="border-b border-border px-4 py-3">
            <div className="flex h-9 items-center gap-2 rounded-lg bg-muted/70 px-3 focus-within:ring-1 focus-within:ring-ring">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                value={chatQuery}
                onChange={(event) => setChatQuery(event.target.value)}
                placeholder="搜索 Chat"
                aria-label="搜索全部 Chat"
                className="h-full border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-3">
              {filteredChats.map((session) => (
                <button
                  key={session.key}
                  type="button"
                  onClick={() => {
                    openSession(session.key)
                    closeNewSession()
                    setChatArchiveOpen(false)
                  }}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    session.key === focusedSessionId && "bg-muted",
                  )}
                >
                  <MessageCircle className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{session.title}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {relativeTime(session.updatedAt)}
                  </span>
                </button>
              ))}
              {filteredChats.length === 0 && (
                <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
                  没有匹配的 Chat
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 删除会话:历史一并删除,用正式弹窗而不是 window.confirm(Electron 下不可靠) */}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleting?.title}」的历史记录将一并删除,此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                closeSession(deleting.key)
                void removeLive(deleting.key)
                setDeleting(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
