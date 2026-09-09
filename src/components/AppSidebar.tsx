import { useMemo, useState } from "react"
import {
  Blocks,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Sun,
  Pencil,
  PenSquare,
  Plus,
  Search,
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { AppUpdatePill } from "@/components/AppUpdatePill"
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { useT, type TFn } from "@/lib/i18n"
import { useTraits } from "@/lib/style-context"
import { closeSession, openAppsView, openSession, useLayout } from "@/lib/layout-store"
import { closeNewSession, requestNewSession, useNewSession } from "@/lib/new-session-store"
import { useTheme } from "@/lib/theme-context"
import { profileInitial, useProfile } from "@/lib/profile-store"
import { NewProjectDialog } from "@/components/ProjectPicker"
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
import type { SidebarShape } from "@/data/styles"

/** 外层包裹:浮岛要靠四周留白才浮得起来 */
const FRAME: Record<SidebarShape, string> = {
  flush: "h-full",
  island: "h-full p-3",
  bare: "h-full",
}

/** 面板本身:边界是画一条线、描一圈框,还是干脆不画 */
const PANEL: Record<SidebarShape, string> = {
  flush: "border-r border-sidebar-border",
  island: "rounded-xl border border-sidebar-border shadow-pop",
  bare: "",
}

/** 内容区内缩:贴边/裸露的高亮可以通栏 bleed;浮岛的行碰到卡片边会显得挤,
 * 内容整体内缩 8px,行再多一圈圆角,选中态是嵌在卡里的胶囊而不是贴边长条 */
const CONTENT_PAD: Record<SidebarShape, string> = {
  flush: "px-0",
  island: "px-2",
  bare: "px-0",
}

/** 会话目录名展示:取路径最后一段 */
function dirLabel(cwd: string): string {
  const short = cwd.replace(/^~(?=$|\/)/, "").split("/").filter(Boolean)
  return short.at(-1) ?? "/"
}

/** 会话行的相对时间:刚刚 / Nm / Nh / 昨天 / 周X / M-D */
function relativeTime(iso: string, t: TFn): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diff = Date.now() - then
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return t("sidebar.timeJustNow")
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return t("sidebar.timeYesterday")
  if (days < 7) return `${days}d`
  const d = new Date(then)
  return `${d.getMonth() + 1}-${d.getDate()}`
}


export function AppSidebar() {
  const { t } = useT()
  const { sidebar: shape } = useTraits()
  const inset = shape === "island"
  const rowRound = inset ? "rounded-lg" : "rounded-none"
  const { focusedSessionId, appsFocused } = useLayout()
  const profile = useProfile()
  const theme = useTheme()
  const { sessions: liveSessions } = useLive()
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
  const [createProjectOpen, setCreateProjectOpen] = useState(false)

  /** 项目区「使用现有文件夹」:选完目录直接进该目录的新会话起始页 */
  async function pickProjectFolder() {
    const result = await window.bento?.chooseDirectory()
    if (result?.path) requestNewSession({ scope: "project", cwd: result.path })
  }
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
    // 本地发送集合之外,main 侧 runtime working(协作唤醒)同样算 running;
    // blocked(挂起审批)turn 未结束,也算 running——attention 图标另有最高优先级。
    const runtime = liveMeta(key)?.runtime
    const running = isRunning(key) || runtime === "working" || runtime === "blocked"
    const unread = hasUnreadSessionMessage(key)
    // 审批 hold 优先级最高:回合卡在等用户,比"进行中"更需要被看见
    const attention = hasPendingApproval(key)
    const isPinned = pinned.has(key)
    if (renaming === key) {
      return (
        <SidebarMenuItem key={key}>
          <div className="flex h-7 items-center pl-12 pr-5">
            <Input
              autoFocus
              defaultValue={s.title}
              aria-label={t("sidebar.renameSession")}
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
        {/* harness 小标比文件夹图标列(left-5)错进一档(left-7 = 8px):4px 错落低于
            可识别阈值,读起来像没对齐;8px 才成立为树状层级。尺寸仍与文件夹图标同 16px */}
        {/* flex 让 span 高度塌缩到图标本身:否则 span 是 24px 行盒,内联图标坐在
            基线上方,整列图标偏高 ~2px(实测过) */}
        <span className="pointer-events-none absolute left-7 top-1/2 flex -translate-y-1/2 opacity-70">
          <HarnessIcon id={s.harnessId as HarnessId} className="size-4" />
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
            "h-7 pl-12 pr-5 group-hover/menu-item:pr-24 group-focus-within/menu-item:pr-24",
            rowRound,
            openSessionMenu === key && "pr-24",
          )}
        >
          {/* 会话行标题随图标列一起错进(pl-12 = 48px),文字缩进与图标错落共同表达层级,
              不靠压父级颜色(Codex 式) */}
          <span className="flex-1 truncate text-sm">{s.title}</span>
          {/* 状态指示样式由设置 → 外观 里的 StatusGlyph 决定 */}
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
              {relativeTime(s.updatedAt, t)}
            </span>
          )}
          {allowPin && (
            <button
              type="button"
              title={isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
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
                title={t("sidebar.sessionActions")}
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
                  {isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="gap-2 text-sm" onSelect={() => setRenaming(key)}>
                <Pencil className="size-4 opacity-70" />
                {t("sidebar.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 text-sm text-destructive focus:text-destructive"
                onSelect={() => setDeleting({ key, title: s.title })}
              >
                <Trash2 className="size-4 opacity-70" />
                {t("sidebar.delete")}
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
              title={t("sidebar.searchChats")}
              onClick={() => setChatArchiveOpen(true)}
            >
              <Search className="size-4" />
              <span className="sr-only">{t("sidebar.searchChats")}</span>
            </Button>
          </span>
        </div>
      </SidebarHeader>

      {/* 贴边/裸露:行的 hover/选中背景通栏 bleed;浮岛:内缩 + 圆角(见 CONTENT_PAD) */}
      <SidebarContent className={CONTENT_PAD[shape]}>
        <SidebarGroup className="p-0">
          <div className="space-y-4 pb-2">
              {/* 主导航:新对话是唯一新建入口(头部不再放 compose 图标,避免双入口);
                  应用收在同一组,底部只留用户卡。两行都带当前态,与会话行一样给方位反馈 */}
              <SidebarMenu className="gap-0.5">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={newSessionOpen || (liveSessions.length === 0 && !appsFocused)}
                    className={cn("h-8 gap-2 px-5 text-sm", rowRound)}
                    onClick={() => requestNewSession()}
                  >
                    {/* 光学对齐基准是文件夹图标列(tabler,字形左缘比 lucide 深 1px):
                        PenSquare 字形留白天然多 1px 正好落位,Blocks 需 +1px 补偿 */}
                    <PenSquare className="size-4" />
                    <span>{t("sidebar.newChat")}</span>
                    <span className="ml-auto type-micro text-muted-foreground">⌘N</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={appsFocused && !newSessionOpen}
                    className={cn("h-8 gap-2 px-5 text-sm", rowRound)}
                    onClick={() => {
                      openAppsView()
                      closeNewSession()
                    }}
                  >
                    {/* Blocks 字形在 lucide 网格里偏左上:右移 1px 对齐文件夹列,
                        上移 1px 的反向是下沉——实测它比文字质心低 1.2px,提 1px */}
                    <Blocks className="size-4 translate-x-px -translate-y-px" />
                    <span>{t("sidebar.apps")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              {/* 小节标签(Codex 式):muted + 可收展 chevron;hover 右侧出快捷动作。
                  操作区(新对话/应用)保持行样式,内容区用标签分层 */}
              <section className="pb-2">
                <Collapsible open={!chatCollapsed} onOpenChange={(open) => setChatCollapsed(!open)}>
                  <div className="group/section relative flex h-7 items-center">
                    <CollapsibleTrigger className="group flex h-full w-full items-center gap-1.5 px-5 pr-9 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      {t("sidebar.chats")}
                      <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
                    </CollapsibleTrigger>
                    <button
                      type="button"
                      title={t("sidebar.newChat")}
                      aria-label={t("sidebar.newChat")}
                      onClick={() => requestNewSession({ scope: "chat" })}
                      className="absolute right-2 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100 group-focus-within/section:opacity-100"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <CollapsibleContent className="collapsible-section">
                {chatKeys.length === 0 && (
                  <p className="pl-5 pr-5 pt-1 type-micro text-muted-foreground">{t("sidebar.noChats")}</p>
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
                        {chatExpanded ? t("sidebar.collapse") : t("sidebar.moreCount", { count: chatKeys.length - 1 })}
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
                        {t("sidebar.showAll")}
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
                  <CollapsibleTrigger className="group flex h-7 w-full items-center gap-1.5 px-5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    {t("sidebar.pinned")}
                    <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="collapsible-section">
                    <SidebarMenu className="gap-0.5">
                      {pinnedKeys.map((key) => renderRow(key))}
                    </SidebarMenu>
                  </CollapsibleContent>
                </Collapsible>
              )}
              <Collapsible open={!projectsCollapsed} onOpenChange={(open) => setProjectsCollapsed(!open)}>
                <div className="group/section relative flex h-7 items-center">
                  <CollapsibleTrigger className="group flex h-full w-full items-center gap-1.5 px-5 pr-9 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    {t("sidebar.projects")}
                    <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
                  </CollapsibleTrigger>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title={t("sidebar.newProject")}
                        aria-label={t("sidebar.newProject")}
                        className="absolute right-2 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100 group-focus-within/section:opacity-100"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start" className="w-44">
                      <DropdownMenuItem className="gap-2 text-sm" onSelect={() => setCreateProjectOpen(true)}>
                        <Plus className="size-3.5 opacity-70" />
                        {t("sidebar.newBlankProject")}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="gap-2 text-sm" onSelect={() => void pickProjectFolder()}>
                        <FolderPlus className="size-3.5 opacity-70" />
                        {t("sidebar.useExistingFolder")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
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
                            aria-label={t("sidebar.renameFolder")}
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
                                  title={t("sidebar.folderActions", { label })}
                                  aria-label={t("sidebar.folderActions", { label })}
                                  className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                >
                                  <MoreHorizontal className="size-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="w-40">
                                <DropdownMenuItem className="gap-2 text-sm" onSelect={() => toggleFolderPin(g.cwd)}>
                                  <PinIcon filled={isPinnedFolder} className="size-3.5 opacity-70" />
                                  {isPinnedFolder ? t("sidebar.unpin") : t("sidebar.pinFolder")}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="gap-2 text-sm" onSelect={() => setRenamingFolder(g.cwd)}>
                                  <Pencil className="size-4 opacity-70" />
                                  {t("sidebar.rename")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  className="gap-2 text-sm"
                                  onSelect={() => hideFolder(g.cwd)}
                                >
                                  <Trash2 className="size-4 opacity-70" />
                                  {t("sidebar.removeFromSidebar")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <button
                              type="button"
                              title={t("sidebar.newChatInFolder")}
                              aria-label={t("sidebar.newChatIn", { label })}
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

        <SidebarFooter className="px-3 pb-3">
          {/* 底栏是一个整体:hover 整行一起亮;明暗切换与设置是行内嵌的两个小钮 */}
          <div className="flex items-center rounded-lg transition-colors hover:bg-sidebar-accent">
            <button
              type="button"
              onClick={() => openSettings("account")}
              className="flex h-auto min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-2 py-1.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Avatar size="sm">
                {profile.avatar && <AvatarImage src={profile.avatar} />}
                <AvatarFallback className="type-micro bg-primary/15 font-semibold text-sidebar-foreground">
                  {profile.avatar ? null : profileInitial(profile.name)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                {profile.name}
              </span>
            </button>
            <AppUpdatePill />
            <button
              type="button"
              title={theme.dark ? t("sidebar.switchToLight") : t("sidebar.switchToDark")}
              onClick={() => theme.setDark(!theme.dark)}
              className="mr-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {theme.dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* 项目区「新建空白项目」:建完文件夹直接进它的新会话起始页 */}
      <NewProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        onCreated={(path) => requestNewSession({ scope: "project", cwd: path })}
      />

      <Dialog
        open={chatArchiveOpen}
        onOpenChange={(open) => {
          setChatArchiveOpen(open)
          if (!open) setChatQuery("")
        }}
      >
        <DialogContent className="flex h-[min(34rem,calc(100vh-3rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>{t("sidebar.allChats")}</DialogTitle>
            <DialogDescription className="sr-only">{t("sidebar.allChatsDesc")}</DialogDescription>
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
                placeholder={t("sidebar.searchChats")}
                aria-label={t("sidebar.searchChats")}
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
                    {relativeTime(session.updatedAt, t)}
                  </span>
                </button>
              ))}
              {filteredChats.length === 0 && (
                <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
                  {t("sidebar.noMatchingChats")}
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
            <AlertDialogTitle>{t("sidebar.deleteSession")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sidebar.deleteSessionDesc", { title: deleting?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sidebar.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                closeSession(deleting.key)
                void removeLive(deleting.key)
                setDeleting(null)
              }}
            >
              {t("sidebar.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
