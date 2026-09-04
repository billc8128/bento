import { useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  File,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Image,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { WorkspaceFileEntry, WorkspaceFilePreview } from "@/types/workspace"

type DirectoryState = {
  loading: boolean
  error?: string
  entries: WorkspaceFileEntry[]
}

const DEMO_DIRECTORIES: Record<string, WorkspaceFileEntry[]> = {
  "": [
    { name: "src", path: "src", kind: "directory", size: 0, modifiedAt: "" },
    { name: "artifacts", path: "artifacts", kind: "directory", size: 0, modifiedAt: "" },
    { name: "package.json", path: "package.json", kind: "file", size: 1400, modifiedAt: "" },
  ],
  src: [
    { name: "App.tsx", path: "src/App.tsx", kind: "file", size: 1200, modifiedAt: "" },
    { name: "index.css", path: "src/index.css", kind: "file", size: 1800, modifiedAt: "" },
  ],
  artifacts: [
    { name: "browser-selection.pdf", path: "artifacts/browser-selection.pdf", kind: "file", size: 82000, modifiedAt: "" },
    { name: "benchmark.csv", path: "artifacts/benchmark.csv", kind: "file", size: 860, modifiedAt: "" },
    { name: "preview.html", path: "artifacts/preview.html", kind: "file", size: 1300, modifiedAt: "" },
  ],
}

function demoPreview(path: string): WorkspaceFilePreview {
  if (path.endsWith(".csv")) {
    return {
      kind: "csv",
      path,
      mime: "text/csv",
      size: 86,
      text: "方案,启动,内存,隔离\nWebContentsView,快,中,强\nwebview,快,中,中\n外部浏览器,慢,低,强",
    }
  }
  if (path.endsWith(".html")) {
    return {
      kind: "html",
      path,
      mime: "text/html",
      size: 230,
      text: "<!doctype html><style>body{font:16px system-ui;padding:32px}h1{max-width:12ch;font-size:42px}p{color:#666;line-height:1.6}</style><h1>One workbench for every agent.</h1><p>Run, inspect and verify local work without leaving the conversation.</p>",
    }
  }
  if (path.endsWith(".pdf")) {
    return {
      kind: "html",
      path,
      mime: "text/html",
      size: 82000,
      text: "<!doctype html><style>body{font:15px system-ui;margin:0;background:#eee;padding:24px}.page{box-sizing:border-box;max-width:680px;min-height:880px;margin:auto;background:white;padding:64px;box-shadow:0 8px 30px #0002}h1{font-size:36px;max-width:13ch}p{color:#555;line-height:1.7}</style><article class=page><h1>Browser Architecture</h1><p>WebContentsView · persistent partition · bounded automation surface.</p></article>",
    }
  }
  return {
    kind: "text",
    path,
    mime: path.endsWith(".json") ? "application/json" : "text/plain",
    size: 180,
    text: path.endsWith(".json")
      ? '{\n  "name": "bento",\n  "version": "0.3.1"\n}'
      : 'import { WorkspaceToolsPanel } from "@/components/workspace/WorkspaceToolsPanel"\n\nexport default function App() {\n  return <WorkspaceToolsPanel />\n}',
  }
}

function FileKindIcon({ name, directory = false }: { name: string; directory?: boolean }) {
  if (directory) return <Folder className="size-3.5 shrink-0" />
  const extension = name.split(".").at(-1)?.toLowerCase()
  if (extension === "csv") return <FileSpreadsheet className="size-3.5 shrink-0 text-ok" />
  if (extension === "pdf") return <FileText className="size-3.5 shrink-0 text-err" />
  if (extension === "html") return <Code2 className="size-3.5 shrink-0 text-warn" />
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")) return <Image className="size-3.5 shrink-0" />
  if (extension === "json") return <FileJson className="size-3.5 shrink-0" />
  if (["ts", "tsx", "js", "jsx", "css"].includes(extension ?? "")) return <FileCode2 className="size-3.5 shrink-0" />
  return <File className="size-3.5 shrink-0" />
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === "," && !quoted) {
      row.push(cell)
      cell = ""
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += character
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

function PreviewSurface({ root, path, revision }: { root: string; path: string; revision: number }) {
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!window.bento) {
        if (!cancelled) {
          setPreview(demoPreview(path))
          setError(null)
        }
        return
      }
      const result = await window.bento.workspace.files.read(root, path)
      if (cancelled) return
      if (result.preview) {
        setPreview(result.preview)
        setError(null)
      }
      else setError(result.error)
    }
    void load().finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [path, revision, root])

  const blobUrl = useMemo(() => {
    if (!preview || (preview.kind !== "pdf" && preview.kind !== "image")) return null
    const bytes = Uint8Array.from(atob(preview.base64), (character) => character.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: preview.mime }))
  }, [preview])

  useEffect(() => () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }, [blobUrl])

  if (loading) return <div className="grid h-full place-items-center text-xs text-muted-foreground">正在读取文件…</div>
  if (error) return <div role="alert" className="grid h-full place-items-center p-6 text-center text-xs"><div><p className="font-medium">无法预览文件</p><p className="mt-1 text-muted-foreground">{error}</p></div></div>
  if (!preview) return null

  const title = path.split("/").at(-1) ?? path
  const extension = title.split(".").at(-1)?.toUpperCase() ?? "FILE"

  let content: React.ReactNode
  if (preview.kind === "pdf" && blobUrl) {
    content = <iframe title={title} src={blobUrl} className="h-full w-full border-0 bg-background" />
  } else if (preview.kind === "image" && blobUrl) {
    content = <div className="grid h-full place-items-center overflow-auto bg-muted/35 p-6"><img src={blobUrl} alt={title} className="max-h-full max-w-full object-contain" /></div>
  } else if (preview.kind === "html") {
    content = <div className="h-full bg-muted/35 p-3"><iframe title={title} sandbox="" srcDoc={preview.text} className="h-full w-full rounded-md border bg-white" /></div>
  } else if (preview.kind === "csv") {
    const rows = parseCsv(preview.text).slice(0, 2000)
    const header = rows[0] ?? []
    content = (
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-left font-mono text-xs">
          <thead className="sticky top-0 bg-muted"><tr>{header.map((cell, index) => <th key={`${cell}-${index}`} className="whitespace-nowrap border-b border-r px-3 py-2 font-medium last:border-r-0">{cell}</th>)}</tr></thead>
          <tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex} className="hover:bg-muted/40">{header.map((_, cellIndex) => <td key={cellIndex} className="whitespace-nowrap border-b border-r px-3 py-2 last:border-r-0">{row[cellIndex] ?? ""}</td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  } else if (preview.kind === "text") {
    const lines = preview.text.split("\n")
    const visibleLines = lines.slice(0, 2000)
    content = (
      <div className="h-full overflow-auto bg-muted/25 py-3 font-mono text-xs leading-6">
        {visibleLines.map((line, index) => <div key={index} className="flex min-w-max px-3"><span className="mr-4 w-9 shrink-0 select-none text-right text-muted-foreground/45 tabular-nums">{index + 1}</span><span className="whitespace-pre">{line || " "}</span></div>)}
        {lines.length > visibleLines.length && <p className="border-t px-4 py-3 text-muted-foreground">文件较长，仅显示前 2000 行。</p>}
      </div>
    )
  } else {
    content = <div className="grid h-full place-items-center p-6 text-center text-xs"><div><FileText className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 font-medium">暂不支持此文件格式</p><p className="mt-1 text-muted-foreground">{preview.mime}</p></div></div>
  }

  return (
    <section aria-label="文件预览" className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileKindIcon name={title} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span>
        <span className="rounded-md bg-muted px-2 py-1 type-micro text-muted-foreground">{extension}</span>
        {(preview.kind === "text" || preview.kind === "csv" || preview.kind === "html") && (
          <button type="button" aria-label="复制文件内容" title="复制文件内容" onClick={() => void navigator.clipboard.writeText(preview.text)} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><Copy className="size-3.5" /></button>
        )}
      </header>
      <div className="min-h-0 flex-1">{content}</div>
      <footer className="flex h-8 shrink-0 items-center border-t px-3 type-micro text-muted-foreground"><span>{Intl.NumberFormat().format(preview.size)} bytes</span><span className="ml-auto">只读预览</span></footer>
    </section>
  )
}

function FileTreeRow({
  entry,
  depth,
  directories,
  expanded,
  query,
  onToggle,
  onOpen,
}: {
  entry: WorkspaceFileEntry
  depth: number
  directories: Map<string, DirectoryState>
  expanded: Set<string>
  query: string
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const open = entry.kind === "directory" && expanded.has(entry.path)
  const directory = directories.get(entry.path)
  const visible = !query || entry.name.toLowerCase().includes(query) || entry.kind === "directory"
  if (!visible) return null

  return (
    <>
      <button
        type="button"
        onClick={() => entry.kind === "directory" ? onToggle(entry.path) : onOpen(entry.path)}
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left font-mono text-xs hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
        style={{ paddingInlineStart: `${depth * 16 + 10}px` }}
      >
        {entry.kind === "directory" ? <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} /> : <span className="size-3 shrink-0" />}
        {entry.kind === "directory" && open ? <FolderOpen className="size-3.5 shrink-0" /> : <FileKindIcon name={entry.name} directory={entry.kind === "directory"} />}
        <span className="truncate">{entry.name}</span>
      </button>
      {open && directory?.loading && <div className="h-7 px-4 text-xs text-muted-foreground" style={{ paddingInlineStart: `${(depth + 1) * 16 + 28}px` }}>读取中…</div>}
      {open && directory?.error && <div className="px-4 py-1 text-xs text-err" style={{ paddingInlineStart: `${(depth + 1) * 16 + 28}px` }}>{directory.error}</div>}
      {open && directory?.entries.map((child) => <FileTreeRow key={child.path} entry={child} depth={depth + 1} directories={directories} expanded={expanded} query={query} onToggle={onToggle} onOpen={onOpen} />)}
    </>
  )
}

type SavedFilesState = {
  expanded: string[]
  previewTabs: string[]
  activePath: string | null
}

function loadFilesState(storageKey: string): SavedFilesState {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<SavedFilesState> | null
    const expanded = Array.isArray(saved?.expanded) ? saved.expanded.filter((path): path is string => typeof path === "string") : []
    const previewTabs = Array.isArray(saved?.previewTabs) ? saved.previewTabs.filter((path): path is string => typeof path === "string") : []
    const activePath = typeof saved?.activePath === "string" && previewTabs.includes(saved.activePath) ? saved.activePath : null
    return { expanded, previewTabs, activePath }
  } catch {
    return { expanded: [], previewTabs: [], activePath: null }
  }
}

export function FilesWorkspacePane({ root, instanceId, storageKey, revealPath, onRevealHandled }: {
  root: string
  instanceId: string
  storageKey: string
  /** 聊天文件链接转来的待打开预览(相对 root);消费完经 onRevealHandled 清掉 */
  revealPath?: string | null
  onRevealHandled?: () => void
}) {
  const treeTabKey = "__files__"
  const idPrefix = `files-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
  const [restored] = useState(() => loadFilesState(storageKey))
  const [directories, setDirectories] = useState(() => new Map<string, DirectoryState>())
  const [expanded, setExpanded] = useState(() => new Set(restored.expanded))
  const [previewTabs, setPreviewTabs] = useState<string[]>(restored.previewTabs)
  const [activePath, setActivePath] = useState<string | null>(restored.activePath)
  const [query, setQuery] = useState("")
  const [watchRevision, setWatchRevision] = useState(0)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  async function loadDirectory(path: string, refresh = false) {
    if (!refresh && directories.has(path)) return
    setDirectories((current) => new Map(current).set(path, { loading: true, entries: [] }))
    if (!window.bento) {
      setDirectories((current) => new Map(current).set(path, { loading: false, entries: DEMO_DIRECTORIES[path] ?? [] }))
      return
    }
    const result = await window.bento.workspace.files.list(root, path)
    setDirectories((current) => new Map(current).set(path, result.entries
      ? { loading: false, entries: result.entries }
      : { loading: false, entries: [], error: result.error }))
  }

  useEffect(() => {
    void loadDirectory("", true)
    for (const directory of expanded) void loadDirectory(directory, true)
  // loadDirectory intentionally follows the active root only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        expanded: [...expanded],
        previewTabs,
        activePath,
      }))
    } catch {
      /* ignore */
    }
  }, [activePath, expanded, previewTabs, storageKey])

  useEffect(() => {
    const api = window.bento?.workspace.files
    if (!api || !root) return
    let disposed = false
    const subscriptions = new Map<string, string>()
    const timers = new Map<string, number>()
    const stop = api.onChanged((change) => {
      const directory = subscriptions.get(change.subscriptionId)
      if (directory === undefined) return
      const previous = timers.get(directory)
      if (previous) window.clearTimeout(previous)
      timers.set(directory, window.setTimeout(async () => {
        const result = await api.list(root, directory)
        if (disposed) return
        setDirectories((current) => new Map(current).set(directory, result.entries
          ? { loading: false, entries: result.entries }
          : { loading: false, entries: [], error: result.error }))
        setWatchRevision((revision) => revision + 1)
      }, 120))
    })
    void Promise.all(["", ...expanded].map(async (directory) => {
      const result = await api.watch(root, directory)
      if (!result.subscriptionId) return
      if (disposed) api.unwatch(result.subscriptionId)
      else subscriptions.set(result.subscriptionId, directory)
    }))
    return () => {
      disposed = true
      stop()
      for (const timer of timers.values()) window.clearTimeout(timer)
      for (const subscriptionId of subscriptions.keys()) api.unwatch(subscriptionId)
    }
  }, [expanded, root])

  useEffect(() => {
    const tab = tabRefs.current.get(activePath ?? treeTabKey)
    const item = activePath ? tab?.parentElement : tab
    item?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activePath, previewTabs.length])

  function activate(path: string | null) {
    setActivePath(path)
    window.requestAnimationFrame(() => {
      const tab = tabRefs.current.get(path ?? treeTabKey)
      const item = path ? tab?.parentElement : tab
      item?.scrollIntoView({ block: "nearest", inline: "nearest" })
    })
  }

  function toggle(path: string) {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      void loadDirectory(path)
    }
    setExpanded(next)
  }

  function open(path: string) {
    setPreviewTabs((current) => current.includes(path) ? current : [...current, path])
    setActivePath(path)
  }

  // 聊天文件链接转来的预览请求:直接开/激活对应预览 tab
  useEffect(() => {
    if (!revealPath) return
    open(revealPath)
    onRevealHandled?.()
  }, [revealPath, onRevealHandled])

  function close(path: string) {
    const index = previewTabs.indexOf(path)
    const next = previewTabs.filter((item) => item !== path)
    setPreviewTabs(next)
    if (activePath === path) setActivePath(next[Math.max(0, index - 1)] ?? null)
  }

  function subTabId(path: string | null) {
    return path ? `${idPrefix}-preview-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}` : `${idPrefix}-tree`
  }

  const rootEntries = directories.get("")

  return (
    <section aria-label="文件" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b bg-muted/30 pl-1.5 type-micro">
        <div role="tablist" aria-label="文件与预览" className="flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button ref={(element) => { if (element) tabRefs.current.set(treeTabKey, element); else tabRefs.current.delete(treeTabKey) }} type="button" role="tab" id={subTabId(null)} aria-selected={activePath === null} aria-controls={`${subTabId(null)}-panel`} tabIndex={activePath === null ? 0 : -1} onClick={() => activate(null)} className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", activePath === null ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground")}><FolderOpen className="size-3.5" />文件树</button>
          {previewTabs.map((path) => {
            const title = path.split("/").at(-1) ?? path
            const selected = activePath === path
            return <div key={path} className={cn("group/file-tab ml-1 flex h-7 min-w-24 max-w-40 shrink-0 items-center rounded-md", selected ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground")}><button ref={(element) => { if (element) tabRefs.current.set(path, element); else tabRefs.current.delete(path) }} type="button" role="tab" id={subTabId(path)} aria-selected={selected} aria-controls={`${subTabId(path)}-panel`} tabIndex={selected ? 0 : -1} title={path} onClick={() => activate(path)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><FileKindIcon name={title} /><span className="truncate font-mono">{title}</span></button><button type="button" tabIndex={-1} aria-label={`关闭 ${title}`} onClick={() => close(path)} className="mr-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3" /></button></div>
          })}
        </div>
        {previewTabs.length > 2 && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="所有文件标签" title="所有文件标签" className="mx-1 grid size-7 shrink-0 place-items-center rounded-md border-l text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><MoreHorizontal className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-56"><DropdownMenuItem onSelect={() => activate(null)} className="gap-2 py-1.5"><FolderOpen className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">文件树</span>{activePath === null && <Check className="size-3.5" />}</DropdownMenuItem>{previewTabs.map((path) => { const title = path.split("/").at(-1) ?? path; return <DropdownMenuItem key={path} onSelect={() => activate(path)} className="gap-2 py-1.5"><FileKindIcon name={title} /><span className="min-w-0 flex-1 truncate font-mono">{title}</span>{activePath === path && <Check className="size-3.5" />}</DropdownMenuItem> })}</DropdownMenuContent></DropdownMenu>}
      </div>

      <div className="relative min-h-0 flex-1">
        <div role="tabpanel" id={`${subTabId(null)}-panel`} aria-labelledby={subTabId(null)} hidden={activePath !== null} className={cn("absolute inset-0 flex min-h-0 flex-col", activePath !== null && "hidden")}>
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2"><Search className="ml-1 size-3.5 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value.toLowerCase())} placeholder="筛选已展开文件" aria-label="筛选文件" className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/65 focus:outline-none" /><button type="button" aria-label="刷新文件树" title="刷新文件树" onClick={() => void loadDirectory("", true)} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><RefreshCw className="size-3.5" /></button></div>
          <div className="flex h-8 shrink-0 items-center border-b bg-muted/20 px-3 type-micro text-muted-foreground"><span className="truncate font-mono" title={root || "Demo workspace"}>{root || "Demo workspace"}</span><span className="ml-auto">{window.bento ? "只读 · 自动刷新" : "只读"}</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {rootEntries?.loading && <p className="px-3 py-2 text-xs text-muted-foreground">正在读取项目…</p>}
            {rootEntries?.error && <div role="alert" className="px-3 py-3 text-xs"><p className="font-medium">无法打开项目</p><p className="mt-1 text-muted-foreground">{rootEntries.error}</p></div>}
            {rootEntries && !rootEntries.loading && !rootEntries.error && rootEntries.entries.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">目录为空</p>}
            {rootEntries?.entries.map((entry) => <FileTreeRow key={entry.path} entry={entry} depth={0} directories={directories} expanded={expanded} query={query} onToggle={toggle} onOpen={open} />)}
          </div>
        </div>
        {previewTabs.map((path) => <div key={path} role="tabpanel" id={`${subTabId(path)}-panel`} aria-labelledby={subTabId(path)} hidden={activePath !== path} className={cn("absolute inset-0", activePath !== path && "hidden")}><PreviewSurface root={root} path={path} revision={watchRevision} /></div>)}
      </div>
    </section>
  )
}
