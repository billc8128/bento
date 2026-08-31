import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { ArrowLeft, ArrowRight, Compass, ExternalLink, RefreshCw } from "lucide-react"

import type { WorkspaceBrowserState } from "@/types/workspace"
import { normalizeWorkspaceBrowserUrl } from "@/core/workspace-browser"

const EMPTY_BROWSER: WorkspaceBrowserState = {
  id: "",
  url: "",
  title: "新标签页",
  loading: false,
  canGoBack: false,
  canGoForward: false,
}

function BrowserIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35">{children}</button>
}

export function BrowserWorkspacePane({
  active,
  suspended,
  storageKey,
  onTitleChange,
  preferredBrowserId,
  onBrowserIdChange,
}: {
  active: boolean
  suspended: boolean
  storageKey: string
  onTitleChange: (title: string) => void
  preferredBrowserId?: string
  onBrowserIdChange?: (id: string) => void
}) {
  const [restoredUrl] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      return saved ? normalizeWorkspaceBrowserUrl(saved) : ""
    } catch {
      return ""
    }
  })
  const restoredTitle = restoredUrl ? new URL(restoredUrl).hostname : "新标签页"
  const contentRef = useRef<HTMLDivElement>(null)
  const browserIdRef = useRef<string | null>(null)
  const preferredBrowserIdRef = useRef(preferredBrowserId)
  const titleChangeRef = useRef(onTitleChange)
  const browserIdChangeRef = useRef(onBrowserIdChange)
  const [state, setState] = useState<WorkspaceBrowserState>(() => restoredUrl
    ? { ...EMPTY_BROWSER, id: window.bento ? "" : "demo", url: restoredUrl, title: restoredTitle }
    : EMPTY_BROWSER)
  const [draft, setDraft] = useState(restoredUrl)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    titleChangeRef.current = onTitleChange
    browserIdChangeRef.current = onBrowserIdChange
  }, [onBrowserIdChange, onTitleChange])

  useEffect(() => {
    const api = window.bento?.workspace.browser
    if (!api) return
    let disposed = false
    const stop = api.onState((next) => {
      if (next.id !== browserIdRef.current) return
      setState(next)
      setDraft(next.url)
      titleChangeRef.current(next.title || "新标签页")
      if (next.url) {
        try { localStorage.setItem(storageKey, next.url) } catch { /* ignore */ }
      }
    })
    void api.create(preferredBrowserIdRef.current).then((result) => {
      if (disposed) {
        if (result.state) void api.destroy(result.state.id)
        return
      }
      if (!result.state) {
        setCreateError(result.error)
        return
      }
      browserIdRef.current = result.state.id
      browserIdChangeRef.current?.(result.state.id)
      setState(result.state)
      setDraft(result.state.url)
      titleChangeRef.current(result.state.title || "新标签页")
      if (result.state.url) {
        try { localStorage.setItem(storageKey, result.state.url) } catch { /* ignore */ }
      }
      if (restoredUrl && !preferredBrowserIdRef.current) {
        void api.navigate(result.state.id, restoredUrl).then((navigation) => {
          if ("error" in navigation) setState((current) => ({ ...current, error: navigation.error }))
        })
      }
    })
    return () => {
      disposed = true
      stop()
      const id = browserIdRef.current
      browserIdRef.current = null
      if (id) void api.destroy(id)
    }
  }, [restoredUrl, storageKey])

  useEffect(() => {
    const api = window.bento?.workspace.browser
    const host = contentRef.current
    const id = browserIdRef.current
    if (!api || !host || !id) return

    const syncBounds = () => {
      if (!active || suspended || !state.url || state.error) {
        api.setBounds(id, null)
        return
      }
      const bounds = host.getBoundingClientRect()
      api.setBounds(id, {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      })
    }
    const observer = new ResizeObserver(() => window.requestAnimationFrame(syncBounds))
    observer.observe(host)
    window.addEventListener("resize", syncBounds)
    window.requestAnimationFrame(syncBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", syncBounds)
      api.setBounds(id, null)
    }
  }, [active, state.error, state.id, state.url, suspended])

  async function navigateToDraft() {
    const value = draft.trim()
    if (!value) return
    const api = window.bento?.workspace.browser
    const id = browserIdRef.current
    if (!api || !id) {
      try {
        const url = normalizeWorkspaceBrowserUrl(value)
        const title = new URL(url).hostname
        setState({ ...EMPTY_BROWSER, id: "demo", url, title })
        titleChangeRef.current(title)
        try { localStorage.setItem(storageKey, url) } catch { /* ignore */ }
      } catch {
        setState((current) => ({ ...current, error: "请输入有效的 HTTP(S) URL" }))
      }
      return
    }
    const result = await api.navigate(id, value)
    if ("error" in result) setState((current) => ({ ...current, loading: false, error: result.error }))
  }

  function navigate(event: FormEvent) {
    event.preventDefault()
    void navigateToDraft()
  }

  const browser = window.bento?.workspace.browser
  const browserId = state.id || null

  return (
    <section aria-label="浏览器" className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={navigate} className="flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
        <BrowserIconButton label="后退" disabled={!state.canGoBack} onClick={() => browserId && browser?.back(browserId)}><ArrowLeft className="size-3.5" /></BrowserIconButton>
        <BrowserIconButton label="前进" disabled={!state.canGoForward} onClick={() => browserId && browser?.forward(browserId)}><ArrowRight className="size-3.5" /></BrowserIconButton>
        <BrowserIconButton label="刷新" disabled={!state.url} onClick={() => browserId && browser?.reload(browserId)}><RefreshCw className="size-3.5" /></BrowserIconButton>
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3 focus-within:border-foreground/25 focus-within:ring-1 focus-within:ring-foreground/15">
          <Compass className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">网址</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="输入 URL" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60" />
        </label>
        <BrowserIconButton label="在系统浏览器打开" disabled={!state.url || !browserId} onClick={() => { if (browserId) void browser?.openExternal(browserId) }}><ExternalLink className="size-3.5" /></BrowserIconButton>
      </form>

      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {state.loading && <div className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-primary/10"><span className="block h-full w-1/2 animate-[browser-progress_600ms_ease-in-out_infinite] bg-primary" /></div>}
        {!state.url && !createError && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center"><div><Compass className="mx-auto size-8 text-muted-foreground" strokeWidth={1.6} /><p className="mt-3 text-sm font-medium">开始浏览</p><p className="mt-1 text-xs text-muted-foreground">输入 URL 以打开页面</p></div></div>
        )}
        {(createError || state.error) && (
          <div role="alert" className="absolute inset-0 z-10 grid place-items-center bg-background p-6 text-center"><div><p className="text-sm font-medium">页面无法打开</p><p className="mt-1 max-w-md text-xs text-muted-foreground">{createError || state.error}</p><button type="button" onClick={() => { setState((current) => ({ ...current, error: undefined })); void navigateToDraft() }} className="mt-4 rounded-md border px-3 py-1.5 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">重试</button></div></div>
        )}
        {!window.bento && state.url && !state.error && (
          <div className="absolute inset-0 overflow-auto bg-muted/35 p-4"><div className="mx-auto min-h-full max-w-2xl rounded-lg border bg-background p-8"><p className="font-mono type-micro text-muted-foreground">{state.url}</p><h2 className="mt-10 text-xl font-semibold">Browser preview</h2><p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">正式桌面版由隔离的 WebContentsView 渲染真实页面；纯 Web demo 只展示浏览器 chrome 和生命周期。</p></div></div>
        )}
      </div>
    </section>
  )
}
