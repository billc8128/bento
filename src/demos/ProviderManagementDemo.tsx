import { useRef, useState } from "react"
import { CheckCircle2, ExternalLink, Eye, EyeOff, Loader2, MoreHorizontal, Plus, RefreshCw, Search, TerminalSquare } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type ModelRow = { id: string; name: string; context: string; visible: boolean }
type ProviderRow = {
  id: string
  name: string
  kind: "订阅" | "预设" | "导入" | "自定义"
  auth: "OAuth" | "API Key"
  connected: boolean
  models: ModelRow[]
}

const initialProviders: ProviderRow[] = [
  { id: "openai", name: "OpenAI", kind: "订阅", auth: "OAuth", connected: true, models: [{ id: "gpt-5.4", name: "GPT-5.4", context: "1M", visible: true }] },
  { id: "anthropic", name: "Anthropic", kind: "订阅", auth: "OAuth", connected: true, models: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", context: "200K", visible: true },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: "200K", visible: true },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: "200K", visible: true },
  ] },
  { id: "deepseek", name: "DeepSeek", kind: "预设", auth: "API Key", connected: true, models: [
    { id: "deepseek-chat", name: "DeepSeek Chat", context: "128K", visible: true },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner", context: "128K", visible: true },
  ] },
]

const presets = ["DeepSeek", "智谱 GLM", "Kimi (Moonshot)", "OpenRouter"]
const presetModels: Record<string, ModelRow[]> = {
  DeepSeek: [{ id: "deepseek-chat", name: "DeepSeek Chat", context: "128K", visible: true }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner", context: "128K", visible: true }],
  "智谱 GLM": [{ id: "glm-4.6", name: "GLM-4.6", context: "128K", visible: true }, { id: "glm-4.5", name: "GLM-4.5", context: "128K", visible: true }],
  "Kimi (Moonshot)": [{ id: "kimi-k3", name: "Kimi K3", context: "256K", visible: true }, { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", context: "256K", visible: true }],
  OpenRouter: [{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", context: "200K", visible: true }],
}
const presetInfo: Record<string, { docs: string; claudeUrl: string; claudeProtocol: string; codexUrl: string; codexProtocol: string }> = {
  DeepSeek: { docs: "https://api-docs.deepseek.com/", claudeUrl: "https://api.deepseek.com/anthropic", claudeProtocol: "Anthropic Messages", codexUrl: "https://api.deepseek.com/v1", codexProtocol: "OpenAI Chat · Bento 桥接" },
  "智谱 GLM": { docs: "https://docs.bigmodel.cn/", claudeUrl: "https://open.bigmodel.cn/api/anthropic", claudeProtocol: "Anthropic Messages", codexUrl: "https://open.bigmodel.cn/api/paas/v4", codexProtocol: "OpenAI Chat · Bento 桥接" },
  "Kimi (Moonshot)": { docs: "https://platform.moonshot.cn/docs", claudeUrl: "https://api.moonshot.cn/anthropic", claudeProtocol: "Anthropic Messages", codexUrl: "https://api.moonshot.cn/v1", codexProtocol: "OpenAI Chat · Bento 桥接" },
  OpenRouter: { docs: "https://openrouter.ai/docs", claudeUrl: "https://openrouter.ai/api/v1", claudeProtocol: "OpenAI Chat · Bento 桥接", codexUrl: "https://openrouter.ai/api/v1", codexProtocol: "OpenAI Chat · Bento 桥接" },
}
type DetectedProvider = {
  id: string
  name: string
  source: string
  credentialReusable: boolean
  canListModels: boolean
  models: ModelRow[]
}
const detectedProviders: DetectedProvider[] = [
  { id: "openrouter-opencode", name: "OpenRouter", source: "OpenCode", credentialReusable: true, canListModels: true, models: presetModels.OpenRouter },
  { id: "google-pi", name: "Google Gemini", source: "Pi", credentialReusable: false, canListModels: true, models: [{ id: "gemini-3-pro", name: "Gemini 3 Pro", context: "1M", visible: true }, { id: "gemini-3-flash", name: "Gemini 3 Flash", context: "1M", visible: true }] },
  { id: "acme-omp", name: "Acme Proxy", source: "OMP", credentialReusable: false, canListModels: false, models: [] },
]

type RuntimeDraft = {
  protocol: "anthropic-messages" | "openai-chat" | "openai-responses"
  baseUrl: string
  requestPath: string
  modelsUrl: string
  apiKey: string
  keyHeader: string
  keyPrefix: string
  headers: Array<{ key: string; value: string }>
}

const runtimeDrafts: Record<"claude-code" | "codex", RuntimeDraft> = {
  "claude-code": {
    protocol: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    requestPath: "/v1/messages",
    modelsUrl: "https://api.deepseek.com/models",
    apiKey: "",
    keyHeader: "Authorization",
    keyPrefix: "Bearer",
    headers: [{ key: "anthropic-version", value: "2023-06-01" }],
  },
  codex: {
    protocol: "openai-responses",
    baseUrl: "https://api.deepseek.com/v1",
    requestPath: "/responses",
    modelsUrl: "https://api.deepseek.com/models",
    apiKey: "",
    keyHeader: "Authorization",
    keyPrefix: "Bearer",
    headers: [],
  },
}

function Mark({ name }: { name: string }) {
  return <span className="grid size-9 shrink-0 place-items-center rounded-full border bg-muted text-sm text-muted-foreground">{name.charAt(0)}</span>
}

export function ProviderManagementDemo() {
  const [providers, setProviders] = useState(initialProviders)
  const [selectedId, setSelectedId] = useState("deepseek")
  const [query, setQuery] = useState("")
  const [editOpen, setEditOpen] = useState(false)
  const [editorProvider, setEditorProvider] = useState(initialProviders[2])
  const [editorName, setEditorName] = useState(initialProviders[2].name)
  const [editorMode, setEditorMode] = useState<"create" | "edit">("edit")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const modelSectionRef = useRef<HTMLElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetName, setPresetName] = useState("")
  const [presetKey, setPresetKey] = useState("")
  const [showPresetKey, setShowPresetKey] = useState(false)
  const [connectingPreset, setConnectingPreset] = useState(false)
  const [presetStage, setPresetStage] = useState<"connect" | "models">("connect")
  const [selectedPresetModels, setSelectedPresetModels] = useState<Record<string, boolean>>({})
  const [detectOpen, setDetectOpen] = useState(false)
  const [detectStage, setDetectStage] = useState<"list" | "loading" | "models" | "error">("list")
  const [detectedProvider, setDetectedProvider] = useState<DetectedProvider | null>(null)
  const [selectedDetectedModels, setSelectedDetectedModels] = useState<Record<string, boolean>>({})
  const [runtime, setRuntime] = useState<"claude-code" | "codex">("claude-code")
  const [auth, setAuth] = useState<"apiKey" | "oauth" | "none">("apiKey")
  const [drafts, setDrafts] = useState(runtimeDrafts)
  const [modelsFetched, setModelsFetched] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)

  const provider = providers.find((item) => item.id === selectedId) ?? providers[0]
  const visibleModels = provider.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()))
  const allVisible = provider.models.every((model) => model.visible)
  const draft = drafts[runtime]
  const hasSavedKey = editorProvider.auth === "API Key" && editorProvider.connected
  const canUseCredential = auth === "none" || auth === "apiKey" && (hasSavedKey || draft.apiKey.trim()) || auth === "oauth" && editorProvider.connected
  const editorCanSave = Boolean(editorName.trim() && Object.values(drafts).every((item) => item.baseUrl && item.modelsUrl && (!item.requestPath || item.requestPath.startsWith("/"))) && editorProvider.models.length > 0 && (auth !== "apiKey" || hasSavedKey || Object.values(drafts).every((item) => item.apiKey.trim())))

  function openEditor(nextProvider: ProviderRow, mode: "create" | "edit" = "edit") {
    setEditorProvider(nextProvider)
    setEditorName(nextProvider.name)
    setAuth(nextProvider.auth === "OAuth" ? "oauth" : "apiKey")
    setRuntime("claude-code")
    setDrafts(structuredClone(runtimeDrafts))
    setModelsFetched(false)
    setTested(false)
    setEditorMode(mode)
    setEditOpen(true)
    setAddOpen(false)
  }

  function openNewProvider(name: string) {
    const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom"
    openEditor({ id: `user-${slug}`, name, kind: "自定义", auth: "API Key", connected: false, models: name ? [{ id: `${slug}-chat`, name: `${name} Chat`, context: "—", visible: true }] : [] }, "create")
    const endpoints: Record<string, string> = {
      "智谱 GLM": "https://open.bigmodel.cn/api/paas/v4",
      "Kimi (Moonshot)": "https://api.moonshot.cn/v1",
      OpenRouter: "https://openrouter.ai/api/v1",
      "Google Gemini": "https://generativelanguage.googleapis.com/v1beta",
    }
    const endpoint = endpoints[name] ?? ""
    setDrafts({
      "claude-code": { ...runtimeDrafts["claude-code"], baseUrl: endpoint, modelsUrl: endpoint ? `${endpoint}/models` : "", apiKey: "" },
      codex: { ...runtimeDrafts.codex, baseUrl: endpoint, modelsUrl: endpoint ? `${endpoint}/models` : "", apiKey: "" },
    })
  }

  function openPreset(name: string) {
    setPresetName(name)
    setPresetKey("")
    setShowPresetKey(false)
    setConnectingPreset(false)
    setPresetStage("connect")
    setSelectedPresetModels(Object.fromEntries((presetModels[name] ?? []).map((model) => [model.id, true])))
    setAddOpen(false)
    setPresetOpen(true)
  }

  function connectPreset() {
    const selectedModels = (presetModels[presetName] ?? []).filter((model) => selectedPresetModels[model.id])
    const id = `preset-${presetName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider"}`
    const next: ProviderRow = { id, name: presetName, kind: "预设", auth: "API Key", connected: true, models: selectedModels }
    setProviders((current) => current.some((item) => item.name === presetName) ? current.map((item) => item.name === presetName ? { ...item, connected: true, models: selectedModels } : item) : [...current, next])
    setSelectedId((providers.find((item) => item.name === presetName)?.id) ?? id)
    setPresetOpen(false)
  }

  function fetchPresetModels() {
    setConnectingPreset(true)
    window.setTimeout(() => {
      setConnectingPreset(false)
      setPresetStage("models")
    }, 500)
  }

  function saveEditor() {
    const saved = { ...editorProvider, name: editorName }
    setProviders((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])
    setSelectedId(saved.id)
    setEditOpen(false)
  }

  function deleteProvider() {
    const next = providers.filter((item) => item.id !== provider.id)
    setProviders(next)
    setSelectedId(next[0].id)
    setDeleteOpen(false)
  }

  function refreshModels() {
    setRefreshing(true)
    window.setTimeout(() => setRefreshing(false), 700)
  }

  function openDetection() {
    setDetectStage("list")
    setDetectedProvider(null)
    setSelectedDetectedModels({})
    setDetectOpen(true)
  }

  function inspectDetectedProvider(candidate: DetectedProvider) {
    setDetectedProvider(candidate)
    setDetectStage("loading")
    window.setTimeout(() => {
      if (!candidate.canListModels) {
        setDetectStage("error")
        return
      }
      setSelectedDetectedModels(Object.fromEntries(candidate.models.map((model) => [model.id, true])))
      setDetectStage("models")
    }, 650)
  }

  function selectedDetectedRows() {
    return detectedProvider?.models.filter((model) => selectedDetectedModels[model.id]) ?? []
  }

  function importDetectedProvider() {
    if (!detectedProvider) return
    const id = `import-${detectedProvider.id}`
    const next: ProviderRow = { id, name: detectedProvider.name, kind: "导入", auth: "API Key", connected: true, models: selectedDetectedRows() }
    setProviders((current) => [...current.filter((item) => item.id !== id), next])
    setSelectedId(id)
    setDetectOpen(false)
  }

  function continueDetectedAuth() {
    if (!detectedProvider) return
    const id = `import-${detectedProvider.id}`
    setDetectOpen(false)
    openEditor({ id, name: detectedProvider.name, kind: "导入", auth: "API Key", connected: false, models: selectedDetectedRows() }, "create")
    const endpoint = detectedProvider.name === "Google Gemini" ? "https://generativelanguage.googleapis.com/v1beta" : ""
    setDrafts({
      "claude-code": { ...runtimeDrafts["claude-code"], baseUrl: endpoint, modelsUrl: endpoint ? `${endpoint}/models` : "", apiKey: "" },
      codex: { ...runtimeDrafts.codex, baseUrl: endpoint, modelsUrl: endpoint ? `${endpoint}/models` : "", apiKey: "" },
    })
  }

  function patchDraft(patch: Partial<RuntimeDraft>) {
    setDrafts((current) => ({ ...current, [runtime]: { ...current[runtime], ...patch } }))
  }

  function selectProtocol(value: RuntimeDraft["protocol"]) {
    patchDraft({
      protocol: value,
      requestPath: value === "anthropic-messages" ? "/v1/messages" : value === "openai-chat" ? "/chat/completions" : "/responses",
    })
  }

  function toggleModel(id: string, checked: boolean) {
    setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, models: item.models.map((model) => model.id === id ? { ...model, visible: checked } : model) } : item))
  }

  function toggleAll(checked: boolean) {
    setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, models: item.models.map((model) => ({ ...model, visible: checked })) } : item))
  }

  function testConnection() {
    setTesting(true)
    setTested(false)
    window.setTimeout(() => { setTesting(false); setTested(true) }, 700)
  }

  function fetchEditorModels() {
    if (editorProvider.models.length === 0) {
      setEditorProvider((current) => ({ ...current, models: [
        { id: "model-chat", name: "Model Chat", context: "128K", visible: true },
        { id: "model-reasoner", name: "Model Reasoner", context: "128K", visible: true },
      ] }))
    }
    setModelsFetched(true)
    window.requestAnimationFrame(() => modelSectionRef.current?.scrollIntoView({ block: "nearest" }))
  }

  const editDialog = (
    <Dialog open={editOpen} onOpenChange={setEditOpen}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="px-5 py-4"><DialogTitle>{editorMode === "create" ? "添加供应商" : "编辑供应商"}</DialogTitle><DialogDescription className="sr-only">配置鉴权、运行协议、请求端点和模型列表。</DialogDescription></DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto border-t px-5 py-4">
          <div className="grid grid-cols-[1fr_12rem] gap-3">
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">名称</span><Input value={editorName} onChange={(event) => setEditorName(event.target.value)} /></label>
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">鉴权方式</span><Select value={auth} onValueChange={(value) => setAuth(value as typeof auth)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="apiKey">API Key</SelectItem><SelectItem value="oauth">OAuth</SelectItem><SelectItem value="none">无鉴权</SelectItem></SelectContent></Select></label>
          </div>

          <Tabs value={runtime} onValueChange={(value) => { setRuntime(value as typeof runtime); setModelsFetched(false); setTested(false) }}>
            <TabsList className="w-full"><TabsTrigger value="claude-code">Claude Code</TabsTrigger><TabsTrigger value="codex">Codex</TabsTrigger></TabsList>
          </Tabs>

          {auth === "oauth" && <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
            <label className="col-span-2 space-y-1.5"><span className="text-xs text-muted-foreground">授权地址</span><Input placeholder="https://provider.example.com/oauth/authorize" /></label>
            <label className="col-span-2 space-y-1.5"><span className="text-xs text-muted-foreground">Token 地址</span><Input placeholder="https://provider.example.com/oauth/token" /></label>
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">Client ID</span><Input /></label>
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">Scopes</span><Input placeholder="openid profile" /></label>
          </div>}

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">接口协议</span><Select value={draft.protocol} onValueChange={(value) => selectProtocol(value as RuntimeDraft["protocol"])}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{runtime === "claude-code" ? <><SelectItem value="anthropic-messages">Anthropic Messages</SelectItem><SelectItem value="openai-chat">OpenAI Chat（Bento 桥接）</SelectItem></> : <><SelectItem value="openai-responses">OpenAI Responses</SelectItem><SelectItem value="openai-chat">OpenAI Chat（Bento 桥接）</SelectItem></>}</SelectContent></Select></label>
            <label className="col-span-2 space-y-1.5"><span className="text-xs text-muted-foreground">Base URL</span><Input value={draft.baseUrl} onChange={(event) => patchDraft({ baseUrl: event.target.value })} /></label>
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">精确请求路径（可选）</span><Input value={draft.requestPath} onChange={(event) => patchDraft({ requestPath: event.target.value })} /></label>
          </div>

          {auth === "apiKey" && <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 space-y-1.5"><span className="text-xs text-muted-foreground">API Key</span><Input type="password" value={draft.apiKey} onChange={(event) => patchDraft({ apiKey: event.target.value })} placeholder="已保存，留空不修改" /></label>
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">注入 Header</span><Select value={draft.keyHeader} onValueChange={(value) => patchDraft({ keyHeader: value })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Authorization">Authorization</SelectItem><SelectItem value="x-api-key">x-api-key</SelectItem><SelectItem value="api-key">api-key</SelectItem></SelectContent></Select></label>
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">值前缀</span><Input value={draft.keyPrefix} onChange={(event) => patchDraft({ keyPrefix: event.target.value })} /></label>
          </div>}

          <section className="space-y-2">
            <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">自定义请求头（可选）</span><Button size="xs" variant="ghost" onClick={() => patchDraft({ headers: [...draft.headers, { key: "", value: "" }] })}><Plus />添加</Button></div>
            {draft.headers.length === 0 ? <div className="rounded-lg border border-dashed py-3 text-center text-xs text-muted-foreground">无自定义请求头</div> : draft.headers.map((header, index) => <div className="grid grid-cols-[1fr_1fr_auto] gap-2" key={index}><Input value={header.key} aria-label={`请求头名称 ${index + 1}`} onChange={(event) => patchDraft({ headers: draft.headers.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item) })} /><Input value={header.value} aria-label={`请求头值 ${index + 1}`} onChange={(event) => patchDraft({ headers: draft.headers.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })} /><Button size="icon" variant="ghost" aria-label={`删除请求头 ${index + 1}`} onClick={() => patchDraft({ headers: draft.headers.filter((_, itemIndex) => itemIndex !== index) })}>×</Button></div>)}
          </section>

          <div className="flex items-center gap-2"><Button variant="outline" disabled={!canUseCredential || !draft.baseUrl} onClick={testConnection}>{testing ? "测试中…" : "测试连接"}</Button>{tested && <span className="inline-flex items-center gap-1 text-xs text-[var(--app-ok)]"><CheckCircle2 className="size-3.5" />连接成功</span>}</div>

          <section ref={modelSectionRef} className="space-y-2 border-t pt-4">
            <label className="space-y-1.5"><span className="text-xs text-muted-foreground">模型列表地址</span><div className="flex gap-2"><Input value={draft.modelsUrl} onChange={(event) => patchDraft({ modelsUrl: event.target.value })} /><Button variant="outline" disabled={!canUseCredential || !draft.modelsUrl} onClick={fetchEditorModels}>获取模型</Button></div></label>
            {modelsFetched && <div className="overflow-hidden rounded-lg border"><div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground"><span>模型清单</span><span>{editorProvider.models.length}</span></div>{editorProvider.models.map((model) => <label className="flex items-center gap-3 border-t px-3 py-2.5 first:border-t-0" key={model.id}><Checkbox defaultChecked /><span className="min-w-0"><span className="block text-xs font-medium">{model.name}</span><span className="block truncate type-micro text-muted-foreground">{model.id}</span></span></label>)}</div>}
          </section>
        </div>
        <DialogFooter className="m-0 rounded-none"><Button variant="ghost" onClick={() => setEditOpen(false)}>取消</Button><Button disabled={!editorCanSave} onClick={saveEditor}>{editorMode === "create" ? "添加" : "保存"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-semibold tracking-tight">供应商</h1>
        <div className="mt-5 grid min-h-[640px] grid-cols-[15rem_minmax(0,1fr)] overflow-hidden rounded-2xl border bg-card">
          <aside className="flex flex-col border-r bg-muted/25">
            <div className="flex h-12 items-center justify-between border-b px-4 text-xs text-muted-foreground"><span>我的供应商</span><Badge variant="secondary">{providers.length}</Badge></div>
            <div className="flex-1 p-2">{providers.map((item) => <button className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${item.id === selectedId ? "bg-accent" : "hover:bg-accent/60"}`} key={item.id} onClick={() => setSelectedId(item.id)}><Mark name={item.name} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block text-xs text-muted-foreground">{item.kind} · {item.models.filter((model) => model.visible).length} 个模型</span></span><span className={`size-1.5 rounded-full ${item.connected ? "bg-[var(--app-ok)]" : "bg-border"}`} /></button>)}</div>
            <div className="grid gap-2 border-t px-4 pt-3 pb-4"><Button variant="outline" size="sm" onClick={openDetection}><TerminalSquare />检测本机供应商</Button><Button variant="outline" size="sm" className="border-dashed" onClick={() => setAddOpen(true)}><Plus />添加供应商</Button></div>
          </aside>

          <section className="min-w-0">
            <header className="flex min-h-28 items-center justify-between border-b px-6"><div className="flex items-center gap-3"><Mark name={provider.name} /><div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{provider.name}</h2><Badge variant="outline">{provider.auth}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{provider.connected ? "已连接" : "等待鉴权"} · {provider.models.filter((model) => model.visible).length} 个模型</p></div></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={refreshing} onClick={refreshModels}><RefreshCw className={refreshing ? "animate-spin" : ""} />{refreshing ? "刷新中…" : "刷新模型"}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多操作"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{(provider.kind === "自定义" || provider.kind === "导入") && <DropdownMenuItem onSelect={() => openEditor(provider)}>编辑供应商</DropdownMenuItem>}{provider.kind === "预设" && <DropdownMenuItem onSelect={() => openPreset(provider.name)}>更新 API Key</DropdownMenuItem>}<DropdownMenuItem onSelect={() => setDetailsOpen(true)}>连接详情</DropdownMenuItem>{provider.kind !== "订阅" && <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>删除供应商</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div></header>
            <div className="flex items-center justify-between gap-4 px-6 py-4"><div className="relative w-80"><Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称或 ID" /></div><label className="flex items-center gap-2 text-xs text-muted-foreground">全部展示<Switch checked={allVisible} onCheckedChange={toggleAll} /></label></div>
            <div className="mx-6 border-t">{visibleModels.map((model) => <div className="grid min-h-16 grid-cols-[1fr_8rem_3rem] items-center border-t first:border-t-0" key={model.id}><span className={model.visible ? "text-sm font-medium" : "text-sm font-medium text-muted-foreground/50"}>{model.name}</span><span className="text-xs tabular-nums text-muted-foreground">{model.context}</span><Switch className="justify-self-end" checked={model.visible} onCheckedChange={(checked) => toggleModel(model.id, checked)} aria-label={`展示 ${model.name}`} /></div>)}</div>
          </section>
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>添加供应商</DialogTitle><DialogDescription className="sr-only">选择预设或添加自定义端点。</DialogDescription></DialogHeader><div className="overflow-hidden rounded-lg border">{presets.map((preset) => <button className="flex w-full items-center gap-3 border-t px-3 py-3 text-left first:border-t-0 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50" disabled={providers.some((item) => item.name === preset)} key={preset} onClick={() => openPreset(preset)}><Mark name={preset} /><span className="flex-1 text-sm font-medium">{preset}</span><span className="text-xs text-muted-foreground">{providers.some((item) => item.name === preset) ? "已添加" : "选择"}</span></button>)}</div><Button variant="outline" className="border-dashed" onClick={() => openNewProvider("")}><Plus />添加自定义端点</Button></DialogContent></Dialog>
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{providers.some((item) => item.name === presetName) ? "更新供应商" : "添加供应商"}</DialogTitle>
            <DialogDescription className="sr-only">核对预设接入信息，测试连接并选择模型。</DialogDescription>
          </DialogHeader>

          {presetStage === "connect" ? (
            <div className="space-y-4 px-5 py-5">
              <div className="flex items-center gap-3"><Mark name={presetName} /><div className="min-w-0"><h3 className="truncate text-base font-semibold">{presetName}</h3><p className="text-xs text-muted-foreground">API Key 预设</p></div></div>

              <section className="overflow-hidden rounded-lg border text-xs">
                <div className="border-b px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3"><span className="font-medium">Claude Code</span><Badge variant="secondary">{presetInfo[presetName]?.claudeProtocol}</Badge></div>
                  <code className="mt-1 block break-all font-sans text-muted-foreground">{presetInfo[presetName]?.claudeUrl}</code>
                </div>
                <div className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3"><span className="font-medium">Codex</span><Badge variant="secondary">{presetInfo[presetName]?.codexProtocol}</Badge></div>
                  <code className="mt-1 block break-all font-sans text-muted-foreground">{presetInfo[presetName]?.codexUrl}</code>
                </div>
              </section>

              <a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" href={presetInfo[presetName]?.docs} target="_blank" rel="noreferrer">查看接入文档<ExternalLink className="size-3" /></a>

              <label className="block space-y-1.5"><span className="text-xs text-muted-foreground">API Key</span><div className="relative"><Input className="pr-10" type={showPresetKey ? "text" : "password"} value={presetKey} onChange={(event) => setPresetKey(event.target.value)} placeholder={providers.some((item) => item.name === presetName) ? "已保存，留空不修改" : "输入 API Key"} autoComplete="off" /><Button className="absolute top-1/2 right-1 -translate-y-1/2" type="button" variant="ghost" size="icon-sm" aria-label={showPresetKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowPresetKey((visible) => !visible)}>{showPresetKey ? <EyeOff /> : <Eye />}</Button></div></label>
            </div>
          ) : (
            <div className="space-y-3 px-5 py-5">
              <div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">选择模型</h3><p className="mt-1 text-xs text-muted-foreground">选择要加入模型列表的模型。</p></div><Badge variant="secondary">{Object.values(selectedPresetModels).filter(Boolean).length} / {(presetModels[presetName] ?? []).length}</Badge></div>
              <div className="overflow-hidden rounded-lg border">{(presetModels[presetName] ?? []).map((model) => <label className="flex items-center gap-3 border-t px-3 py-3 first:border-t-0" key={model.id}><Checkbox checked={selectedPresetModels[model.id]} onCheckedChange={(checked) => setSelectedPresetModels((current) => ({ ...current, [model.id]: checked === true }))} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{model.name}</span><span className="block truncate text-xs text-muted-foreground">{model.id}</span></span><span className="text-xs tabular-nums text-muted-foreground">{model.context}</span></label>)}</div>
            </div>
          )}

          <DialogFooter className="m-0 rounded-none">
            {presetStage === "connect" ? <><Button variant="ghost" disabled={connectingPreset} onClick={() => setPresetOpen(false)}>取消</Button><Button disabled={connectingPreset || !presetKey.trim() && !providers.some((item) => item.name === presetName)} onClick={fetchPresetModels}>{connectingPreset && <Loader2 className="animate-spin" />}{connectingPreset ? "获取中…" : "获取模型列表"}</Button></> : <><Button variant="ghost" onClick={() => setPresetStage("connect")}>上一步</Button><Button disabled={!Object.values(selectedPresetModels).some(Boolean)} onClick={connectPreset}>添加</Button></>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={detectOpen} onOpenChange={setDetectOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg [&_[data-slot=dialog-close]]:top-4 [&_[data-slot=dialog-close]]:right-4">
          <DialogHeader className="px-6 pt-5 pb-4"><DialogTitle>检测本机供应商</DialogTitle><DialogDescription className="sr-only">使用本机 CLI 登录态获取模型，并决定是否导入凭证。</DialogDescription></DialogHeader>

          {detectStage === "list" && <div className="grid gap-3 px-6 pb-6">{detectedProviders.map((candidate) => <Button variant="outline" className="h-auto w-full justify-between rounded-xl px-4 py-3.5" key={candidate.id} onClick={() => inspectDetectedProvider(candidate)}><span className="flex min-w-0 flex-col items-start gap-1"><span className="text-sm font-medium">{candidate.name}</span><span className="text-xs font-normal text-muted-foreground">来自 {candidate.source}</span></span><span className="text-xs font-normal text-muted-foreground">{candidate.canListModels ? candidate.credentialReusable ? "可直接导入" : "需重新鉴权" : "无法连接"}</span></Button>)}</div>}

          {detectStage === "loading" && <div className="grid min-h-44 place-items-center px-6 pb-6 text-center"><div><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /><p className="mt-3 text-sm font-medium">正在获取模型</p><p className="mt-1 text-xs text-muted-foreground">使用 {detectedProvider?.source} 的现有登录状态</p></div></div>}

          {detectStage === "error" && <div className="px-6 pb-6"><div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"><p className="text-sm font-medium">无法从 {detectedProvider?.source} 获取模型</p><p className="mt-1 text-xs text-muted-foreground">配置存在，但登录状态不可用或 CLI 拒绝访问。</p></div><div className="mt-4"><Button variant="outline" onClick={() => setDetectStage("list")}>返回</Button></div></div>}

          {detectStage === "models" && detectedProvider && <><div className="space-y-4 px-6 pb-6"><div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">{detectedProvider.name}</h3><p className="mt-1 text-xs text-muted-foreground">来自 {detectedProvider.source}</p></div><Badge variant={detectedProvider.credentialReusable ? "secondary" : "outline"}>{detectedProvider.credentialReusable ? "可导入凭证" : "需重新鉴权"}</Badge></div><div className="overflow-hidden rounded-lg border">{detectedProvider.models.map((model) => <label className="flex items-center gap-3 border-t px-3 py-3 first:border-t-0" key={model.id}><Checkbox checked={selectedDetectedModels[model.id]} onCheckedChange={(checked) => setSelectedDetectedModels((current) => ({ ...current, [model.id]: checked === true }))} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{model.name}</span><span className="block truncate text-xs text-muted-foreground">{model.id}</span></span><span className="text-xs tabular-nums text-muted-foreground">{model.context}</span></label>)}</div>{detectedProvider.credentialReusable && <p className="text-xs text-muted-foreground">确认后由主进程将凭证导入系统安全存储，页面不会读取凭证内容。</p>}</div><DialogFooter className="m-0 rounded-none"><Button variant="ghost" onClick={() => setDetectStage("list")}>返回</Button><Button disabled={selectedDetectedRows().length === 0} onClick={detectedProvider.credentialReusable ? importDetectedProvider : continueDetectedAuth}>{detectedProvider.credentialReusable ? "导入并添加" : "继续鉴权"}</Button></DialogFooter></>}
        </DialogContent>
      </Dialog>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}><DialogContent><DialogHeader><DialogTitle>连接详情</DialogTitle><DialogDescription className="sr-only">查看供应商连接、鉴权与模型状态。</DialogDescription></DialogHeader><dl className="overflow-hidden rounded-lg border text-sm"><div className="flex justify-between border-b px-3 py-2"><dt className="text-muted-foreground">状态</dt><dd>{provider.connected ? "已连接" : "等待鉴权"}</dd></div><div className="flex justify-between border-b px-3 py-2"><dt className="text-muted-foreground">鉴权</dt><dd>{provider.auth}</dd></div><div className="flex justify-between px-3 py-2"><dt className="text-muted-foreground">模型</dt><dd>{provider.models.length} 个</dd></div></dl></DialogContent></Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><DialogHeader><DialogTitle>删除 {provider.name}</DialogTitle><DialogDescription>删除后，该供应商将从模型选择中移除。</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="destructive" onClick={deleteProvider}>删除</Button></DialogFooter></DialogContent></Dialog>
      {editDialog}
    </main>
  )
}
