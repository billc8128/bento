import { useEffect, useState } from "react"
import { Check, ChevronDown, FileCode2, PanelRightOpen, Search, Settings2, Sparkles } from "lucide-react"

import { BentoLogo } from "@/components/BentoLogo"
import { WorkspaceToolsPanel } from "@/components/workspace/WorkspaceToolsPanel"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useIsMobile } from "@/hooks/use-mobile"
import { DEFAULT_STYLE, getStyle, type StyleId } from "@/data/styles"

/**
 * THESIS: 单一受管右栏让聊天保持中心；不把三种独立工作区拆成并列 dock。
 * OWN-WORLD: 延续主题 token、发丝分隔和紧凑排版；终端与当前深浅主题同源。
 * STORY: 终端、文件和浏览器共享一级 tab；PDF、CSV、HTML 和文本预览进入 Files 二级 tab。
 * FIRST VIEWPORT: 224px 会话栏 + 对话 + 460px 工具栏；窄屏工具栏占满视口。
 * FORM: local-extension/no-roll；精确局部扩展按规范不运行 concept roll。
 */

function DemoSidebar() {
  return (
    <aside className="hidden h-full w-[224px] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="app-window-drag flex h-12 items-center gap-2 px-4 [-webkit-app-region:drag]"><BentoLogo className="size-6" /><span className="app-title text-sm font-semibold">Bento</span></div>
      <button type="button" className="mx-3 mt-2 flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-xs text-muted-foreground shadow-sm"><Search className="size-3.5" />搜索会话<span className="ml-auto font-mono type-micro">⌘K</span></button>
      <div className="mt-5 px-4 type-micro font-medium text-muted-foreground">今天</div>
      <div className="mt-1 px-2">
        <button type="button" className="flex w-full flex-col rounded-lg bg-sidebar-accent px-3 py-2 text-left"><span className="truncate text-xs font-medium">设计右侧工作区面板</span><span className="mt-0.5 truncate font-mono type-micro text-muted-foreground">bento · codex</span></button>
        <button type="button" className="mt-1 flex w-full flex-col rounded-lg px-3 py-2 text-left text-muted-foreground hover:bg-sidebar-accent"><span className="truncate text-xs">Provider 模型同步</span><span className="mt-0.5 truncate font-mono type-micro">bento · claude</span></button>
      </div>
      <div className="mt-auto flex items-center gap-2 border-t px-3 py-3"><span className="grid size-7 place-items-center rounded-full bg-foreground type-micro font-semibold text-background">BC</span><span className="min-w-0 flex-1 truncate text-xs">Bento Contributor</span><Settings2 className="size-3.5 text-muted-foreground" /></div>
    </aside>
  )
}

function DemoConversation({ panelOpen, onOpenPanel }: { panelOpen: boolean; onOpenPanel: () => void }) {
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="app-window-drag flex h-11 shrink-0 items-center border-b px-4 [-webkit-app-region:drag]">
        <div className="min-w-0"><h1 className="truncate text-xs font-semibold">设计右侧工作区面板</h1><p className="truncate font-mono type-micro text-muted-foreground">~/Desktop/bento · Codex</p></div>
        <span className="flex-1" />
        {!panelOpen && <button type="button" onClick={onOpenPanel} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [-webkit-app-region:no-drag]"><PanelRightOpen className="size-3.5" />打开工具</button>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-6 pb-8 pt-10">
          <div className="ml-auto max-w-[82%] rounded-2xl rounded-br-md bg-muted px-4 py-3 text-sm leading-6">看下这个项目。接下来我准备做个类似 Codex 的右侧 panel，想先支持 terminal、带 PDF/CSV/HTML 预览的文件工作区，以及浏览器。调研一下应该怎么做，出一版 demo。</div>
          <div className="mt-9 max-w-[92%]">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground/70"><Sparkles className="size-3.5" /><span>完成调研与 demo</span><ChevronDown className="size-3.5 text-muted-foreground" /></div>
            <div className="ml-[6px] mt-2 border-l pl-4 text-xs text-muted-foreground">
              <div className="flex h-7 items-center gap-2"><Check className="size-3.5 text-[var(--app-ok)]" /><span>检查面板与布局架构</span></div>
              <div className="flex h-7 items-center gap-2"><Check className="size-3.5 text-[var(--app-ok)]" /><span>实现三种工作区与富文件预览</span></div>
              <div className="flex h-7 items-center gap-2"><FileCode2 className="size-3.5" /><code className="font-mono text-foreground/80">WorkspaceToolsPanel.tsx</code><span className="ml-auto font-mono type-micro"><span className="text-[var(--app-ok)]">+418</span> <span className="text-[var(--app-err)]">−0</span></span></div>
            </div>
            <div className="mt-6 space-y-3 text-sm leading-6">
              <p>右侧面板已经跑起来了。终端、文件和浏览器共享一级 tab 生命周期；PDF、CSV、HTML 和文本预览保留在文件工作区的二级 tab。</p>
              <p>正式版本建议把 UI 保持为受控组件，系统能力放进 Electron 主进程，通过窄 IPC 接口接入。浏览器需要独立隔离，不能把本地文件能力暴露给远程页面。</p>
            </div>
          </div>
          <div className="mt-auto pt-12">
            <div className="rounded-2xl border bg-card p-3 shadow-[0_6px_24px_rgba(0,0,0,0.05)]">
              <textarea aria-label="消息" placeholder="继续告诉 Bento 你想改什么…" className="h-16 w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/60" />
              <div className="flex items-center type-micro text-muted-foreground"><span>Codex · GPT-5.6</span><span className="ml-auto">⌘ ↵ 发送</span></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

export function WorkspacePanelDemo() {
  const [panelOpen, setPanelOpen] = useState(true)
  const mobile = useIsMobile()

  useEffect(() => {
    const style = (localStorage.getItem("bento.style") ?? DEFAULT_STYLE) as StyleId
    const savedDark = localStorage.getItem("bento.dark")
    const root = document.documentElement
    root.dataset.style = style
    root.classList.toggle("dark", savedDark === null ? getStyle(style).tone === "dark" : savedDark === "1")
  }, [])

  if (mobile) {
    return (
      <div className="h-screen min-h-0 bg-background text-foreground">
        {panelOpen ? (
          <WorkspaceToolsPanel onClose={() => setPanelOpen(false)} />
        ) : (
          <DemoConversation panelOpen={false} onOpenPanel={() => setPanelOpen(true)} />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <DemoSidebar />
      <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
        <ResizablePanel minSize={360}>
          <DemoConversation panelOpen={panelOpen} onOpenPanel={() => setPanelOpen(true)} />
        </ResizablePanel>
        {panelOpen && <>
          <ResizableHandle className="w-px bg-border transition-colors data-[separator=hover]:bg-primary/35 data-[separator=active]:bg-primary/55" />
          <ResizablePanel defaultSize={460} minSize={320} maxSize={680} groupResizeBehavior="preserve-pixel-size">
            <WorkspaceToolsPanel onClose={() => setPanelOpen(false)} />
          </ResizablePanel>
        </>}
      </ResizablePanelGroup>
    </div>
  )
}
