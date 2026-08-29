import { useMemo, useState } from "react"
import { ChevronDown, Folder, FolderPlus, Plus, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type ProjectPickerProps = {
  value: string
  candidates: string[]
  onChange: (path: string) => void
  className?: string
  compact?: boolean
  disabled?: boolean
}

function parts(value: string) {
  return value.replace(/\/$/, "").split("/").filter(Boolean)
}

function projectName(value: string) {
  if (value === "~") return "~"
  return parts(value).at(-1) ?? "/"
}

function parentName(value: string) {
  const items = parts(value)
  return items.length > 1 ? items.at(-2) : undefined
}

function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (path: string) => void
}) {
  const [name, setName] = useState("")
  const [sourceDir, setSourceDir] = useState("")
  const [creating, setCreating] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pickSource() {
    const result = await window.bento?.chooseDirectory()
    if (result?.error) setError(result.error)
    if (result?.path) {
      setSourceDir(result.path)
      setError(null)
    }
  }

  function dropSource(event: React.DragEvent) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file || !window.bento) return
    // Electron 里拖拽的文件夹也会以 File 出现;webUtils 拿绝对路径
    const path = window.bento.pathForFile(file)
    if (path) {
      setSourceDir(path)
      setError(null)
    }
  }

  async function create() {
    if (!window.bento || !name.trim() || !sourceDir) return
    setCreating(true)
    setError(null)
    const result = await window.bento.createProject({ sourceDir, name: name.trim() })
    setCreating(false)
    if (!result.path) {
      setError(result.error ?? "项目创建失败")
      return
    }
    onCreated(result.path)
    setName("")
    setSourceDir("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 p-6 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">创建项目</DialogTitle>
          <DialogDescription className="sr-only">
            输入项目名称并选择新项目所在的源文件夹。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center rounded-xl border border-input px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
          <Folder className="size-4.5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="项目名称"
            aria-label="项目名称"
            className="h-12 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">源文件夹</p>
          <button
            type="button"
            onClick={() => void pickSource()}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={dropSource}
            className={cn(
              "flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              dragging && "border-primary bg-muted/50 ring-2 ring-ring/30",
            )}
          >
            <FolderPlus className="size-6 text-muted-foreground" />
            {sourceDir ? (
              <>
                <span className="font-medium">{projectName(sourceDir)}</span>
                <span className="max-w-full truncate text-xs text-muted-foreground">{sourceDir}</span>
              </>
            ) : (
              <span>{dragging ? "松手选择这个文件夹" : "点击选择,或把文件夹拖进来"}</span>
            )}
          </button>
        </div>

        {error && <p className="text-sm text-err">{error}</p>}

        <DialogFooter className="-mx-6 -mb-6 bg-transparent px-6 pb-6 pt-1 sm:border-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!window.bento || !name.trim() || !sourceDir || creating} onClick={() => void create()}>
            {creating ? "正在创建…" : "创建项目"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ProjectPicker({
  value,
  candidates,
  onChange,
  className,
  compact = false,
  disabled = false,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return candidates.filter((path) =>
      !needle || `${projectName(path)} ${path}`.toLowerCase().includes(needle),
    )
  }, [candidates, query])

  function choose(path: string) {
    onChange(path)
    setQuery("")
    setOpen(false)
  }

  async function chooseDirectory() {
    const result = await window.bento?.chooseDirectory()
    if (result?.path) choose(result.path)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            compact
              ? "flex items-center"
              : "relative flex min-h-[var(--app-project-row-height)] items-center rounded-t-2xl bg-muted/45 px-4 pb-2 pt-3 sm:rounded-t-[1.75rem] sm:px-5",
            className,
          )}
        >
          <div className={cn("group/project relative min-w-0 max-w-full", !compact && "-ml-2")}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="选择项目"
                disabled={disabled}
                className={cn(
                  compact
                    ? "flex h-9 min-w-0 max-w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none"
                    : "project-picker-depression flex min-w-0 max-w-full items-center gap-2.5 rounded-full px-2 py-2 text-left transition-[background-color,box-shadow,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-hover/project:translate-y-px group-focus-within/project:translate-y-px",
                  !value && "text-muted-foreground",
                )}
              >
                <Folder
                  className={cn(
                    "size-4.5 shrink-0 transition-opacity duration-100",
                    value && "group-hover/project:opacity-0 group-focus-within/project:opacity-0",
                  )}
                />
                <span
                  className={cn(
                    compact ? "text-sm" : "text-sm sm:text-base",
                    value ? "min-w-0 truncate" : "shrink-0",
                  )}
                  title={value || undefined}
                >
                  {value ? projectName(value) : "选择项目"}
                </span>
                {compact && <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
            </PopoverTrigger>

            {value && !compact && (
              <button
                type="button"
                aria-label={`清除项目 ${projectName(value)}`}
                title="清除项目"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  setOpen(false)
                  setQuery("")
                  onChange("")
                }}
                className="absolute left-1.5 top-1/2 z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-muted-foreground/65 text-background opacity-0 transition-[opacity,transform,background-color] duration-150 hover:bg-muted-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-hover/project:translate-y-[calc(-50%+1px)] group-hover/project:opacity-100 group-focus-within/project:translate-y-[calc(-50%+1px)] group-focus-within/project:opacity-100"
              >
                <X className="size-3.5" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(34rem,calc(100vw-2rem))] p-2"
        >
          <div className="flex items-center gap-2 px-2 pb-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>

          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {filtered.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => choose(path)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  path === value && "bg-muted",
                )}
              >
                <Folder className="size-4 shrink-0" />
                <span className="font-medium">{projectName(path)}</span>
                {parentName(path) && (
                  <span className="min-w-0 truncate text-muted-foreground">{parentName(path)}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">没有匹配的最近项目</p>
            )}
          </div>

          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              disabled={!window.bento}
              onClick={() => void chooseDirectory()}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-45"
            >
              <FolderPlus className="size-4" />
              打开文件夹…
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setCreateOpen(true)
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Plus className="size-4" />
              新建项目
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <NewProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(path) => choose(path)}
      />
    </>
  )
}
