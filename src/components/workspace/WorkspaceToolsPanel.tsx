import { useMemo, useState } from "react"
import type { FormEvent } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Maximize2,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"

type ToolId = "terminal" | "files" | "preview" | "browser"

type WorkspaceFile = {
  name: string
  path: string
  type: "file" | "folder"
  children?: WorkspaceFile[]
}

type PreviewFile = {
  language: string
  content: string[]
}

const TOOLS: Array<{ id: ToolId; label: string; icon: typeof TerminalSquare }> = [
  { id: "terminal", label: "终端", icon: TerminalSquare },
  { id: "files", label: "文件", icon: FolderOpen },
  { id: "preview", label: "预览", icon: Code2 },
  { id: "browser", label: "浏览器", icon: Globe2 },
]

const FILES: WorkspaceFile[] = [
  {
    name: "src",
    path: "src",
    type: "folder",
    children: [
      {
        name: "components",
        path: "src/components",
        type: "folder",
        children: [
          { name: "Composer.tsx", path: "src/components/Composer.tsx", type: "file" },
          { name: "WorkspacePanel.tsx", path: "src/components/WorkspacePanel.tsx", type: "file" },
        ],
      },
      { name: "App.tsx", path: "src/App.tsx", type: "file" },
      { name: "index.css", path: "src/index.css", type: "file" },
    ],
  },
  {
    name: "electron",
    path: "electron",
    type: "folder",
    children: [
      { name: "main.ts", path: "electron/main.ts", type: "file" },
      { name: "preload.ts", path: "electron/preload.ts", type: "file" },
    ],
  },
  { name: "ARCHITECTURE.md", path: "ARCHITECTURE.md", type: "file" },
  { name: "package.json", path: "package.json", type: "file" },
]

const PREVIEWS: Record<string, PreviewFile> = {
  "src/components/WorkspacePanel.tsx": {
    language: "TSX",
    content: [
      'import { Terminal, Files, Globe } from "lucide-react"',
      "",
      'type Tool = "terminal" | "files" | "preview" | "browser"',
      "",
      "export function WorkspacePanel() {",
      '  const [activeTool, setActiveTool] = useState<Tool>("terminal")',
      "",
      "  return (",
      '    <aside className="workspace-panel">',
      "      <PanelToolbar active={activeTool} onChange={setActiveTool} />",
      "      <ToolSurface tool={activeTool} />",
      "    </aside>",
      "  )",
      "}",
    ],
  },
  "src/App.tsx": {
    language: "TSX",
    content: [
      'import { WorkspacePanel } from "@/components/WorkspacePanel"',
      "",
      "export default function App() {",
      "  return (",
      '    <main className="workspace">',
      "      <Conversation />",
      "      <WorkspacePanel />",
      "    </main>",
      "  )",
      "}",
    ],
  },
  "src/index.css": {
    language: "CSS",
    content: [
      ".workspace-panel {",
      "  display: grid;",
      "  grid-template-rows: 44px minmax(0, 1fr);",
      "  border-left: 1px solid var(--border);",
      "  background: var(--background);",
      "}",
    ],
  },
  "package.json": {
    language: "JSON",
    content: [
      "{",
      '  "name": "bento",',
      '  "version": "0.3.1",',
      '  "description": "Local-first multi-harness agent workbench"',
      "}",
    ],
  },
}

const DEFAULT_PREVIEW = PREVIEWS["src/components/WorkspacePanel.tsx"]

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  )
}

function PanelHeader({ active, onChange, onClose }: { active: ToolId; onChange: (tool: ToolId) => void; onClose?: () => void }) {
  return (
    <header className="app-window-drag flex h-11 shrink-0 items-end border-b bg-background px-2 [-webkit-app-region:drag]">
      <nav aria-label="工作区工具" className="flex min-w-0 flex-1 items-end gap-0.5 self-stretch pt-1.5 [-webkit-app-region:no-drag]">
        {TOOLS.map((tool) => {
          const Icon = tool.icon
          const selected = active === tool.id
          return (
            <button
              key={tool.id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onChange(tool.id)}
              className={cn(
                "relative flex h-full min-w-0 items-center gap-1.5 rounded-t-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
                selected ? "text-foreground" : "text-muted-foreground hover:bg-muted/65 hover:text-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" strokeWidth={1.8} />
              <span>{tool.label}</span>
              {selected && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground" />}
            </button>
          )
        })}
      </nav>
      <div className="flex h-full items-center pl-1 [-webkit-app-region:no-drag]">
        <IconButton label="关闭工具面板" onClick={onClose}>
          <PanelRightClose className="size-4" />
        </IconButton>
      </div>
    </header>
  )
}

function TerminalPanel() {
  type TerminalSession = {
    id: number
    label: string
    commands: string[]
    draft: string
  }

  const [sessions, setSessions] = useState<TerminalSession[]>([
    { id: 1, label: "zsh", commands: ["pnpm test --run", "git status --short"], draft: "" },
  ])
  const [activeId, setActiveId] = useState(1)
  const [nextId, setNextId] = useState(2)
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0]

  function runCommand(event: FormEvent) {
    event.preventDefault()
    const command = active.draft.trim()
    if (!command) return
    setSessions((current) => current.map((session) => session.id === active.id
      ? { ...session, commands: [...session.commands, command], draft: "" }
      : session))
  }

  function addTerminal() {
    const session = { id: nextId, label: `zsh ${nextId}`, commands: [], draft: "" }
    setSessions((current) => [...current, session])
    setActiveId(session.id)
    setNextId((current) => current + 1)
  }

  function closeTerminal(id: number) {
    const index = sessions.findIndex((session) => session.id === id)
    const nextSessions = sessions.filter((session) => session.id !== id)
    setSessions(nextSessions)
    if (activeId === id) setActiveId(nextSessions[Math.max(0, index - 1)].id)
  }

  function updateDraft(value: string) {
    setSessions((current) => current.map((session) => session.id === active.id
      ? { ...session, draft: value }
      : session))
  }

  return (
    <section aria-label="终端" className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <div className="flex h-9 shrink-0 items-stretch border-b bg-chrome type-micro text-muted-foreground">
        <div role="tablist" aria-label="终端会话" className="flex min-w-0 flex-1 overflow-x-auto">
          {sessions.map((session) => {
            const selected = session.id === active.id
            return (
              <div
                key={session.id}
                className={cn(
                  "relative flex items-center border-r transition-colors",
                  sessions.length === 1 ? "min-w-0 flex-1" : "min-w-28 max-w-40 shrink-0",
                  selected ? "bg-background text-foreground" : "hover:bg-muted/70 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={`${session.label} · ~/Desktop/bento`}
                  onClick={() => setActiveId(session.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 font-mono focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-ok" />
                  <span className="truncate font-medium">
                    {session.label} · {sessions.length === 1 ? "~/Desktop/bento" : "bento"}
                  </span>
                </button>
                {sessions.length > 1 && (
                  <button
                    type="button"
                    aria-label={`关闭 ${session.label}`}
                    title={`关闭 ${session.label}`}
                    onClick={() => closeTerminal(session.id)}
                    className="mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <X className="size-3" />
                  </button>
                )}
                {selected && <span className="absolute inset-x-2 bottom-0 h-px bg-foreground" />}
              </div>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1 px-2">
          <IconButton label="新建终端" onClick={addTerminal}><Plus className="size-3.5" /></IconButton>
        <IconButton label="终端操作（正式版接入）" disabled><MoreHorizontal className="size-3.5" /></IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-xs selection:bg-accent selection:text-accent-foreground">
        <p className="mb-3 text-muted-foreground">Last login: Fri Aug 29 09:42:16 on ttys004</p>
        {active.commands.map((command, index) => (
          <div key={`${command}-${index}`} className="mb-3">
            <p><span className="font-medium text-foreground">bento</span> <span className="text-muted-foreground">git:(</span><span className="text-foreground">feature/workspace-panel</span><span className="text-muted-foreground">)</span> <span className="text-foreground">❯</span> {command}</p>
            {command.includes("test") ? (
              <div className="mt-1 text-muted-foreground">
                <p><span className="text-ok">✓</span> src/core/replay.test.ts <span>(8 tests)</span></p>
                <p><span className="text-ok">✓</span> src/lib/layout-store.test.ts <span>(5 tests)</span></p>
                <p className="mt-1"><span className="font-medium text-ok">13 passed</span> <span>in 1.84s</span></p>
              </div>
            ) : command.includes("status") ? (
              <p className="mt-1 text-foreground"><span className="font-medium">M</span> src/components/WorkspacePanel.tsx</p>
            ) : (
              <p className="mt-1 text-muted-foreground">command completed</p>
            )}
          </div>
        ))}
        <form onSubmit={runCommand} className="flex items-start gap-1">
          <span className="shrink-0"><span className="font-medium text-foreground">bento</span> <span className="text-muted-foreground">git:(</span><span className="text-foreground">feature/workspace-panel</span><span className="text-muted-foreground">)</span> <span className="text-foreground">❯</span></span>
          <input
            value={active.draft}
            onChange={(event) => updateDraft(event.target.value)}
            aria-label="输入终端命令"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs text-foreground caret-foreground outline-none"
          />
        </form>
      </div>
    </section>
  )
}

function FileIcon({ name }: { name: string }) {
  if (name.endsWith(".tsx") || name.endsWith(".ts")) return <FileCode2 className="size-3.5 text-[oklch(0.62_0.13_235)]" />
  if (name.endsWith(".json")) return <FileJson className="size-3.5 text-[oklch(0.69_0.13_85)]" />
  if (name.endsWith(".md")) return <FileText className="size-3.5 text-muted-foreground" />
  return <File className="size-3.5 text-muted-foreground" />
}

function FileRow({
  entry,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  entry: WorkspaceFile
  depth: number
  selectedPath: string
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const open = expanded.has(entry.path)
  const selected = entry.path === selectedPath
  return (
    <>
      <button
        type="button"
        onClick={() => entry.type === "folder" ? onToggle(entry.path) : onSelect(entry.path)}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
          selected && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {entry.type === "folder" ? (
          <>
            {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
            {open ? <FolderOpen className="size-3.5 text-muted-foreground" /> : <Folder className="size-3.5 text-muted-foreground" />}
          </>
        ) : (
          <><span className="size-3.5" /><FileIcon name={entry.name} /></>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {entry.type === "folder" && open && entry.children?.map((child) => (
        <FileRow key={child.path} entry={child} depth={depth + 1} selectedPath={selectedPath} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
      ))}
    </>
  )
}

function FilesPanel({ selectedPath, onSelect }: { selectedPath: string; onSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState(() => new Set(["src", "src/components", "electron"]))
  const [query, setQuery] = useState("")
  const visibleFiles = useMemo(() => {
    if (!query.trim()) return FILES
    const needle = query.toLowerCase()
    function filter(entries: WorkspaceFile[]): WorkspaceFile[] {
      return entries.flatMap((entry) => {
        if (entry.type === "file") return entry.path.toLowerCase().includes(needle) ? [entry] : []
        const children = filter(entry.children ?? [])
        return children.length ? [{ ...entry, children }] : []
      })
    }
    return filter(FILES)
  }, [query])

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <section aria-label="文件浏览" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <Search className="ml-1 size-3.5 text-muted-foreground" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称筛选" aria-label="筛选文件" className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/65 focus:outline-none" />
        <IconButton label="刷新文件（正式版接入）" disabled><RefreshCw className="size-3.5" /></IconButton>
      </div>
      <div className="flex h-8 shrink-0 items-center border-b bg-muted/25 px-3 type-micro text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono">~/Desktop/bento</span>
        <span>27 个文件</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {visibleFiles.length ? visibleFiles.map((entry) => (
          <FileRow key={entry.path} entry={entry} depth={0} selectedPath={selectedPath} expanded={query ? new Set(["src", "src/components", "electron"]) : expanded} onToggle={toggle} onSelect={onSelect} />
        )) : (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"><Search className="size-5 opacity-45" />没有匹配的文件</div>
        )}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-2 border-t px-3 type-micro text-muted-foreground">
        <span className="size-1.5 rounded-full bg-[var(--app-ok)]" />
        <span>文件变更已同步</span>
        <span className="flex-1" />
        <span className="font-mono">UTF-8</span>
      </footer>
    </section>
  )
}

function PreviewPanel({ path }: { path: string }) {
  const preview = PREVIEWS[path] ?? DEFAULT_PREVIEW
  const [copied, setCopied] = useState(false)

  function copyContent() {
    void navigator.clipboard.writeText(preview.content.join("\n")).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <section aria-label="文件预览" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileIcon name={path} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono type-micro text-muted-foreground">{preview.language}</span>
        <IconButton label={copied ? "已复制" : "复制文件内容"} onClick={copyContent}>{copied ? <Check className="size-3.5 text-[var(--app-ok)]" /> : <Copy className="size-3.5" />}</IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[color-mix(in_oklch,var(--background)_96%,var(--foreground))] py-3 font-mono text-xs leading-6">
        {preview.content.map((line, index) => (
          <div key={index} className="flex min-w-max pr-5 hover:bg-muted/55">
            <span className="mr-4 w-9 shrink-0 select-none text-right text-muted-foreground/45 tabular-nums">{index + 1}</span>
            <code className={cn("whitespace-pre", line.trimStart().startsWith("//") && "text-muted-foreground")}>{line || " "}</code>
          </div>
        ))}
      </div>
      <footer className="flex h-8 shrink-0 items-center border-t px-3 type-micro text-muted-foreground">
        <span>{preview.content.length} 行</span><span className="flex-1" /><span>只读预览</span>
      </footer>
    </section>
  )
}

function BrowserPanel() {
  const [url, setUrl] = useState("http://localhost:5173")
  const [draft, setDraft] = useState(url)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState([url])
  const [index, setIndex] = useState(0)

  function navigate(next: string) {
    const normalized = /^https?:\/\//.test(next) ? next : `https://${next}`
    setLoading(true)
    window.setTimeout(() => {
      const nextHistory = [...history.slice(0, index + 1), normalized]
      setUrl(normalized)
      setDraft(normalized)
      setHistory(nextHistory)
      setIndex(nextHistory.length - 1)
      setLoading(false)
    }, 320)
  }

  function move(nextIndex: number) {
    const nextUrl = history[nextIndex]
    if (!nextUrl) return
    setIndex(nextIndex)
    setUrl(nextUrl)
    setDraft(nextUrl)
  }

  return (
    <section aria-label="浏览器" className="flex min-h-0 flex-1 flex-col bg-muted/25">
      <form onSubmit={(event) => { event.preventDefault(); navigate(draft) }} className="flex h-11 shrink-0 items-center gap-1 border-b bg-background px-2">
        <IconButton label="后退" disabled={index === 0} onClick={() => move(index - 1)}><ArrowLeft className="size-3.5" /></IconButton>
        <IconButton label="前进" disabled={index >= history.length - 1} onClick={() => move(index + 1)}><ArrowRight className="size-3.5" /></IconButton>
        <IconButton label="刷新" onClick={() => navigate(url)}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></IconButton>
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-muted/45 px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring">
          <span className="size-1.5 shrink-0 rounded-full bg-[var(--app-ok)]" />
          <input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="网址" className="min-w-0 flex-1 bg-transparent font-mono type-micro outline-none" />
        </div>
        <IconButton label="在系统浏览器打开（正式版接入）" disabled><ExternalLink className="size-3.5" /></IconButton>
      </form>
      <div className="relative min-h-0 flex-1 overflow-auto p-3">
        {loading && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-primary/10"><span className="block h-full w-1/2 animate-[browser-progress_600ms_ease-in-out_infinite] bg-primary" /></div>}
        <div className="mx-auto min-h-full max-w-[520px] overflow-hidden rounded-lg border bg-white text-neutral-900 shadow-[0_10px_28px_rgba(0,0,0,0.08)]">
          <div className="flex h-9 items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-3"><span className="size-2 rounded-full bg-neutral-300" /><span className="size-2 rounded-full bg-neutral-300" /><span className="size-2 rounded-full bg-neutral-300" /><span className="ml-2 type-micro text-neutral-400">Bento preview</span></div>
          <div className="px-6 py-7">
            <div className="mb-8 flex items-center justify-between"><div className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-md bg-neutral-900 type-micro font-semibold text-white">B</span><span className="text-xs font-semibold">Bento</span></div><span className="type-micro text-neutral-400">Local preview</span></div>
            <h2 className="max-w-[12ch] text-3xl font-semibold leading-[1.08] tracking-[-0.035em]">你的 agents，一个工作台。</h2>
            <p className="mt-3 max-w-[38ch] text-xs leading-5 text-neutral-500">在同一个桌面空间里运行 Codex、Claude Code、Kimi 和更多 harness。</p>
            <button type="button" className="mt-5 rounded-md bg-neutral-900 px-3 py-2 type-micro font-medium text-white">开始新对话</button>
            <div className="mt-9 grid grid-cols-[1fr_1.4fr] gap-2">
              <div className="h-24 rounded-md bg-neutral-100 p-2"><div className="h-2 w-14 rounded bg-neutral-300" /><div className="mt-3 space-y-1.5"><div className="h-1.5 w-full rounded bg-neutral-200" /><div className="h-1.5 w-3/4 rounded bg-neutral-200" /></div></div>
              <div className="h-24 rounded-md bg-neutral-900 p-2 font-mono type-micro text-neutral-400"><span className="text-emerald-400">bento</span> ❯ pnpm dev<br /><span className="text-white">ready in 426ms</span></div>
            </div>
          </div>
        </div>
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-2 border-t bg-background px-3 type-micro text-muted-foreground"><span>1280 × 800</span><span className="flex-1" /><IconButton label="全屏预览（正式版接入）" disabled><Maximize2 className="size-3.5" /></IconButton></footer>
    </section>
  )
}

export function WorkspaceToolsPanel({
  defaultTool = "terminal",
  onClose,
}: {
  defaultTool?: ToolId
  onClose?: () => void
}) {
  const [active, setActive] = useState<ToolId>(defaultTool)
  const [selectedPath, setSelectedPath] = useState("src/components/WorkspacePanel.tsx")

  function selectFile(path: string) {
    setSelectedPath(path)
    setActive("preview")
  }

  return (
    <aside className="flex h-full min-h-0 min-w-[320px] flex-col overflow-hidden bg-background text-foreground">
      <PanelHeader active={active} onChange={setActive} onClose={onClose} />
      {active === "terminal" && <TerminalPanel />}
      {active === "files" && <FilesPanel selectedPath={selectedPath} onSelect={selectFile} />}
      {active === "preview" && <PreviewPanel path={selectedPath} />}
      {active === "browser" && <BrowserPanel />}
    </aside>
  )
}
