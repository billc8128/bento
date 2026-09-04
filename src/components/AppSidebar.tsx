import { useMemo, useState } from "react"
import {
  Blocks,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Keyboard,
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
import { HarnessIcon } from "@/components/HarnessIcon"
import { PinIcon } from "@/components/PinIcon"
import { StatusGlyph } from "@/components/StatusGlyph"
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
import { closeSession, openAppsView, openSession, resetLayout, setLayoutMode, useLayout } from "@/lib/layout-store"
import { closeNewSession, requestNewSession, useNewSession } from "@/lib/new-session-store"
import {
  hideFolder,
  renameFolder,
  toggleFolderPin,
  useFolderPreferences,
} from "@/lib/folder-preferences"
import { hasUnreadSessionMessage, isRunning, liveMeta, removeLive, renameLive, useLive, hasPendingApproval } from "@/lib/live-store"
import type { HarnessId } from "@/core/harness"
import { togglePin, usePinnedSessions } from "@/lib/pinned-sessions"
import { openSettings } from "@/lib/settings-store"
import { useStatusGlyph } from "@/lib/status-glyph"
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
  island: "rounded-xl border border-sidebar-border shadow-pop",
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
  const { focusedSessionId, mode, appsFocused } = useLayout()
  const { sessions: liveSessions } = useLive()
  const theme = useTheme()
  const pinned = usePinnedSessions()
  const folderPreferences = useFolderPreferences()
  const statusGlyph = useStatusGlyph()
  const newSessionOpen = useNewSession().open
  /** 行内重命名:Electron 不支持 window.prompt,换成输入框就地编辑 */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ key: string; title: string } | null>(null)
  const [openSessionMenu, setOpenSessionMenu] = useState<string | null>(null)
  const [openFolderMenu, setOpenFolderMenu] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set())
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
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
    // 起始页覆盖层打开时,它是唯一的"当前位置":压掉会话行的焦点高亮,
    // 否则点新对话后与底层焦点会话双高亮(真实事故)
    const active = key === focusedSessionId && !newSessionOpen
    // 本地发送集合之外,main 侧 runtime working(协作唤醒)同样算 running
    const running = isRunning(key) || liveMeta(key)?.runtime === "working"
    const unread = hasUnreadSessionMessage(key)
    // 审批 hold 优先级最高:回合卡在等用户,比"进行中"更需要被看见
    const attention = hasPendingApproval(key)
    const isPinned = pinned.has(key)
    if (renaming === key) {
      return (
        <SidebarMenuItem key={key}>
          <div className="flex h-7 items-center pl-11 pr-5">
            <Input
              autoFocus
              defaultValue={s.title}
              aria-label="重命名会话"
              className="h-6 flex-1 rounded-md px-1 text-sm focus-visible:border-foreground/25 focus-visible:ring-1 focus-visible:ring-foreground/15"
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
        {/* harness 小标落在左侧缩进槽,与文件夹图标同列(x=20);标题保持文字轴不动。
            比文件夹图标略小(size-3.5),弱透明度避免抢标题 */}
        <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 opacity-70">
          <HarnessIcon id={s.harnessId as HarnessId} className="size-3.5" />
        </span>
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
            "h-7 rounded-none pl-11 pr-5 group-hover/menu-item:pr-24 group-focus-within/menu-item:pr-24",
            openSessionMenu === key && "pr-24",
          )}
        >
          {/* 会话行不带图标:标题落文字轴(pl-11 = 44px),层级靠错落缩进表达,
              不靠压父级颜色(Codex 式) */}
          <span className="flex-1 truncate text-sm">{s.title}</span>
          {/* 状态指示样式由设置 → 主题 里的 StatusGlyph 决定 */}
          {attention && <StatusGlyph state="attention" variant={statusGlyph} />}
          {!attention && running && <StatusGlyph state="running" variant={statusGlyph} />}
          {!attention && !running && unread && <StatusGlyph state="unread" variant={statusGlyph} />}
          {/* 平时只露置顶标;hover 换成 时间 + pin + ⋯ 快捷操作 */}
          {!running && allowPin && isPinned && (
            <PinIcon className="size-3 text-muted-foreground group-hover/menu-item:hidden" />
          )}
        </SidebarMenuButton>
        <span
          className={cn(
            "invisible absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 group-hover/menu-item:visible group-focus-within/menu-item:visible",
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
      {/* px-3 与下方列表同一条内缩线:头、列表、底栏共用一个左对齐轴 */}
      <SidebarHeader className="gap-2 px-3 pb-3 pt-1.5">
        <div className="app-window-drag flex items-center justify-between pl-1 [-webkit-app-region:drag]">
          <span className="flex items-center gap-2.5">
            <BentoLogo className="size-7" />
            <span className="app-title text-base font-semibold tracking-tight">Bento</span>
          </span>
          <span className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
            {/* 搜索先复用「全部对话」对话框;⌘K 全局面板落地后(v0.4)换成它 */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              title="搜索对话"
              onClick={() => setChatArchiveOpen(true)}
            >
              <Search className="size-4" />
              <span className="sr-only">搜索对话</span>
            </Button>
          </span>
        </div>
      </SidebarHeader>

      {/* px-0:行的 hover/选中背景通栏 bleed,不留内缩药丸(对齐轴在各行自己的 px-5) */}
      <SidebarContent className="px-0">
        <SidebarGroup className="p-0">
          <div className="space-y-4 pb-2">
              {/* 主导航:新对话是唯一新建入口(头部不再放 compose 图标,避免双入口);
                  应用收在同一组,底部只留用户卡。两行都带当前态,与会话行一样给方位反馈 */}
              <SidebarMenu className="gap-0.5">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={newSessionOpen || (liveSessions.length === 0 && !appsFocused)}
                    className="h-8 gap-2 rounded-none px-5 text-sm"
                    onClick={() => requestNewSession()}
                  >
                    {/* PenSquare 字形左侧留白比 Blocks 多 ~1px(viewBox 内边距不同),
                        光学补偿 -1px 让两个图标的左缘对齐 */}
                    <PenSquare className="size-4 -translate-x-px" />
                    <span>新对话</span>
                    <span className="ml-auto type-micro text-muted-foreground">⌘N</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={appsFocused && !newSessionOpen}
                    className="h-8 gap-2 rounded-none px-5 text-sm"
                    onClick={() => {
                      openAppsView()
                      closeNewSession()
                    }}
                  >
                    <Blocks className="size-4" />
                    <span>应用</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              {/* 小节标签(Codex 式):muted 小字 + 可收展 chevron;操作区(新对话/应用)
                  保持行样式,内容区用标签分层,不再让「对话」混成第三个操作入口 */}
              <section className="pb-2">
                <Collapsible open={!chatCollapsed} onOpenChange={(open) => setChatCollapsed(!open)}>
                  <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1.5 px-5 type-micro font-medium tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    对话
                    <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="collapsible-section">
                {chatKeys.length === 0 && (
                  <p className="pl-5 pr-5 pt-1 type-micro text-muted-foreground">还没有对话</p>
                )}
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
                      <CollapsibleTrigger className="flex h-6 items-center gap-1 rounded px-5 type-micro text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
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
                  </CollapsibleContent>
                </Collapsible>
              </section>
              {/* 置顶区:脱离文件夹组,集中在顶部;标签样式与「对话/项目」同规 */}
              {pinnedKeys.length > 0 && (
                <Collapsible defaultOpen>
                  <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1.5 px-5 type-micro font-medium tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    置顶
                    <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="collapsible-section">
                    <SidebarMenu className="gap-0.5">
                      {pinnedKeys.map((key) => renderRow(key))}
                    </SidebarMenu>
                  </CollapsibleContent>
                </Collapsible>
              )}
              <Collapsible open={!projectsCollapsed} onOpenChange={(open) => setProjectsCollapsed(!open)}>
                <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1.5 px-5 type-micro font-medium tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  项目
                  <ChevronDown className="size-3 transition-transform group-data-[state=closed]:-rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent className="collapsible-section">
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
                        <div className="flex h-7 items-center px-5">
                          <Input
                            autoFocus
                            defaultValue={label}
                            aria-label="重命名文件夹分组"
                            className="h-6 flex-1 rounded-md px-1 text-sm focus-visible:border-foreground/25 focus-visible:ring-1 focus-visible:ring-foreground/15"
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
                          <CollapsibleTrigger className="flex h-full w-full items-center gap-2 px-5 pr-14 text-sm font-medium text-sidebar-foreground transition-colors hover:text-sidebar-foreground">
                            <FolderIcon open={open} className="size-4" />
                            <span className="truncate">{label}</span>
                            {isPinnedFolder && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
                          </CollapsibleTrigger>
                          <span
                            className={cn(
                              "absolute right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/folder:opacity-100 group-focus-within/folder:opacity-100",
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
                </CollapsibleContent>
              </Collapsible>
            </div>
        </SidebarGroup>
      </SidebarContent>

        <SidebarFooter className="gap-1 px-3 pb-3">
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
            {/* 菜单不宽过侧栏本体(220px),不然弹出会盖到正文区 */}
            <DropdownMenuContent side="top" align="start" className="w-51">
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
            <DialogTitle>全部对话</DialogTitle>
            <DialogDescription className="sr-only">搜索或浏览全部对话</DialogDescription>
          </DialogHeader>
          <div className="border-b border-border px-4 py-3">
            {/* 自动聚焦的唯一输入位:光标即焦点提示,focus-within 只做轻微提亮,
                不上品牌色焦点环(那是键盘 Tab 导航的信号) */}
            <div className="flex h-9 items-center gap-2 rounded-lg bg-muted/70 px-3 focus-within:ring-1 focus-within:ring-foreground/15">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                value={chatQuery}
                onChange={(event) => setChatQuery(event.target.value)}
                placeholder="搜索对话"
                aria-label="搜索全部对话"
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
                  没有匹配的对话
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
