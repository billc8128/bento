import { useState } from "react"
import { Compass, Globe, Pencil, Plus, RotateCw, TerminalSquare, Trash2 } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { BentoAppView, UserAppInput } from "@/core/apps"
import { removeApp, retryApps, setAppEnabled, upsertApp, useApps } from "@/lib/apps-store"
import { toast } from "@/lib/toast"

function keyValues(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=")
    if (index < 1) return []
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    return key && value ? [[key, value]] : []
  }))
}

export function AppsSection() {
  const { loaded, apps, error } = useApps()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BentoAppView | null>(null)
  const [deleting, setDeleting] = useState<BentoAppView | null>(null)
  const [type, setType] = useState<"stdio" | "http">("stdio")
  const [name, setName] = useState("")
  const [target, setTarget] = useState("")
  const [args, setArgs] = useState("")
  const [secrets, setSecrets] = useState("")
  const [clearSecrets, setClearSecrets] = useState(false)
  const [saving, setSaving] = useState(false)

  if (!window.bento) return <p className="text-sm text-muted-foreground">应用仅在桌面版可用。</p>
  if (!loaded) return <p className="text-sm text-muted-foreground">正在读取应用…</p>

  function resetForm() {
    setEditing(null)
    setType("stdio")
    setName("")
    setTarget("")
    setArgs("")
    setSecrets("")
    setClearSecrets(false)
  }

  function openAdd() {
    resetForm()
    setDialogOpen(true)
  }

  function openEdit(app: BentoAppView) {
    if (!app.connection) return
    setEditing(app)
    setType(app.connection.type)
    setName(app.name)
    setTarget(app.connection.type === "stdio" ? app.connection.command : app.connection.url)
    setArgs(app.connection.type === "stdio" ? app.connection.args.join("\n") : "")
    setSecrets("")
    setClearSecrets(false)
    setDialogOpen(true)
  }

  async function save() {
    const input: UserAppInput = {
      ...(editing ? { id: editing.id } : {}),
      name,
      transport: type === "stdio"
        ? { type, command: target, args: args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }
        : { type, url: target },
      ...(type === "stdio" ? { env: keyValues(secrets) } : { headers: keyValues(secrets) }),
      ...(editing && clearSecrets ? { clearSecrets: true } : {}),
    }
    setSaving(true)
    const error = await upsertApp(input)
    setSaving(false)
    if (error) {
      toast.error(error)
      return
    }
    toast.success(editing ? `已更新 ${name}` : `已添加 ${name}`)
    setDialogOpen(false)
    resetForm()
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        <p className="max-w-xl text-sm text-muted-foreground">
          应用通过同一套 MCP Runtime 向所有兼容 Harness 提供工具。内置应用直接暴露稳定工具，用户应用按需发现。
        </p>
        <Button size="sm" className="shrink-0 gap-1.5" onClick={openAdd}>
          <Plus className="size-4" />
          添加应用
        </Button>
      </div>

      {error && (
        <div className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5">
          <p className="text-sm text-destructive">应用读取失败：{error}</p>
          <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={retryApps}>
            <RotateCw className="size-3.5" />
            重试
          </Button>
        </div>
      )}

      <div className="mt-6 divide-y divide-border border-y border-border">
        {apps.map((app) => {
          const Icon = app.transport === "builtin" ? Compass : app.transport === "stdio" ? TerminalSquare : Globe
          return (
            <section key={app.id} className="flex items-start gap-4 py-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{app.name}</h2>
                  <span className="type-micro rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {app.transport === "builtin" ? "内置" : app.transport.toUpperCase()}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{app.description}</p>
                {app.source === "user" && (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {app.connection && (
                      <p className="truncate font-mono" title={app.connection.type === "stdio"
                        ? [app.connection.command, ...app.connection.args].join(" ")
                        : app.connection.url}
                      >
                        {app.connection.type === "stdio"
                          ? [app.connection.command, ...app.connection.args].join(" ")
                          : app.connection.url}
                      </p>
                    )}
                    <p>
                      工具按需发现 · 新建会话后生效
                      {app.hasSecrets ? " · 凭证已加密保存" : ""}
                    </p>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {app.editable && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`编辑 ${app.name}`}
                      onClick={() => openEdit(app)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除 ${app.name}`}
                      onClick={() => setDeleting(app)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
                <Switch
                  checked={app.enabled}
                  aria-label={`${app.enabled ? "关闭" : "打开"}${app.name} App`}
                  onCheckedChange={(enabled) => void setAppEnabled(app.id, enabled).then((error) => {
                    if (error) toast.error(error)
                  })}
                />
              </div>
            </section>
          )
        })}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.name}` : "添加 MCP 应用"}</DialogTitle>
            <DialogDescription>应用由 Bento Main 托管，一次配置即可用于全部兼容 Harness。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label htmlFor="app-name" className="text-sm font-medium">名称</label>
              <Input
                id="app-name"
                className="focus-visible:border-foreground/25 focus-visible:ring-foreground/15"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="GitHub"
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium">连接方式</span>
              <Select value={type} onValueChange={(value) => {
                const nextType = value as "stdio" | "http"
                setType(nextType)
                if (editing) setClearSecrets(nextType !== editing.connection?.type)
              }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio 命令</SelectItem>
                  <SelectItem value="http">Streamable HTTP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="app-target" className="text-sm font-medium">{type === "stdio" ? "Command" : "URL"}</label>
              <Input
                id="app-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={type === "stdio" ? "npx" : "https://example.com/mcp"}
              />
            </div>
            {type === "stdio" && (
              <div className="space-y-1.5">
                <label htmlFor="app-args" className="text-sm font-medium">Arguments</label>
                <Textarea id="app-args" value={args} onChange={(event) => setArgs(event.target.value)} placeholder={"-y\n@modelcontextprotocol/server-github"} />
                <p className="text-xs text-muted-foreground">每行一个参数。</p>
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor="app-secrets" className="text-sm font-medium">{type === "stdio" ? "环境变量" : "HTTP Headers"}</label>
              <Textarea
                id="app-secrets"
                value={secrets}
                onChange={(event) => {
                  setSecrets(event.target.value)
                  if (event.target.value.trim()) setClearSecrets(false)
                }}
                placeholder={type === "stdio" ? "GITHUB_TOKEN=…" : "Authorization=Bearer …"}
              />
              <p className="text-xs text-muted-foreground">
                每行 KEY=VALUE；值使用系统加密存储，不返回 Renderer。
                {editing?.hasSecrets
                  ? clearSecrets ? " 保存时会删除现有凭证。" : " 留空会保留现有凭证。"
                  : ""}
              </p>
              {editing?.hasSecrets && (
                <label className="flex items-center gap-2 pt-1 text-sm">
                  <Checkbox
                    checked={clearSecrets}
                    onCheckedChange={(checked) => {
                      const next = checked === true
                      setClearSecrets(next)
                      if (next) setSecrets("")
                    }}
                  />
                  清除已保存凭证
                </label>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button disabled={saving || !name.trim() || !target.trim()} onClick={() => void save()}>
              {saving ? "保存中…" : editing ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleting?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              App 配置和系统加密存储的凭证都会被删除，已有会话不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                const app = deleting
                setDeleting(null)
                void removeApp(app.id).then((removeError) => {
                  if (removeError) toast.error(removeError)
                  else toast.success(`已删除 ${app.name}`)
                })
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
