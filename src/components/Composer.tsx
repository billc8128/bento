import { useRef, useState } from "react"
import { ArrowUp, FileText, ImageIcon, LoaderCircle, Paperclip, Square, X } from "lucide-react"

import { RuntimePicker } from "@/components/RuntimePicker"
import { FolderIcon } from "@/components/FolderIcon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useTraits } from "@/lib/style-context"
import { getHarness, type HarnessId } from "@/core/harness"
import { findProviderModel } from "@/core/provider"
import { shouldSubmitComposerKey } from "@/core/composer-keyboard"
import type { Effort, PromptAttachment, PromptInput, SessionScope } from "@/core/types"
import { useProviderCatalog } from "@/lib/provider-store"
import { COLUMN, type ComposerShape } from "@/data/styles"

type LiveActivity = { label: string; detail?: string }

type Attachment = PromptAttachment & { id: string; url?: string }

/** 外层:决定输入区在窗口里占多大地盘、离底边多远 */
const OUTER: Record<ComposerShape, string> = {
  docked: "shrink-0 border-t border-border bg-card px-4 py-2.5",
  card: "shrink-0 px-4 pb-4 pt-2",
  // 悬浮:脱离文档流盖在消息上,靠 App 的 relative main 定位。
  // before 是那道渐隐:消息滚到输入框附近先淡出,而不是被硬生生切一刀
  floating:
    "pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-12 before:bottom-0 before:bg-gradient-to-t before:from-background before:via-background before:to-transparent",
  inline: "shrink-0 border-t border-border px-4 pb-4 pt-3",
}

/** 输入框本体:边框、圆角、投影三件事全看风格 */
const SHELL: Record<ComposerShape, string> = {
  docked: "rounded-none border-0 bg-transparent shadow-none",
  card: "rounded-lg border bg-card shadow-flat",
  // 悬浮态用实底 + 投影分层,不用毛玻璃:消息从下面滚过去的遮挡交给
  // ChatView 底部那道渐隐,半透明输入框会让底下的代码块糊成噪点
  floating: "pointer-events-auto rounded-3xl border bg-card shadow-float",
  inline: "rounded-none border-0 bg-transparent shadow-none",
}

type ComposerProps = {
  /** 助手是否正在生成——决定右下角是发送还是停止 */
  running: boolean
  scope: SessionScope
  /** 会话所属 harness 与真实生效的模型配置。 */
  harnessId: HarnessId
  cwd: string
  providerId?: string
  modelId?: string
  effort?: Effort
  onToggleRun: () => void
  onSend?: (input: PromptInput) => void
  onModelChange?: (providerId: string, modelId: string) => void
  onEffortChange?: (effort: Effort) => void
  onHarnessChange?: (harnessId: HarnessId) => void
  liveActivity?: LiveActivity
  queueFull?: boolean
}

export function Composer({
  running,
  scope,
  harnessId,
  cwd,
  providerId,
  modelId,
  effort = "medium",
  onToggleRun,
  onSend,
  onModelChange,
  onEffortChange,
  onHarnessChange,
  liveActivity,
  queueFull = false,
}: ComposerProps) {
  const { composer: shape, width } = useTraits()
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)

  const harness = getHarness(harnessId)
  const providerCatalog = useProviderCatalog(harnessId, cwd)
  const model = findProviderModel(
    providerCatalog.providers,
    providerId,
    harnessId,
    modelId,
  )
  const providerConnected = providerCatalog.providers.some(
    (provider) => provider.id === providerId && provider.connected,
  )
  const folderName = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

  function addFiles(files: FileList | null, kind: Attachment["kind"]) {
    if (!files?.length) return
    const next = Array.from(files).flatMap((f, i) => {
        const path = window.bento?.pathForFile(f) ?? ""
        if (!path) return []
        const isImage = f.type.startsWith("image/")
        return {
          id: `${Date.now()}-${i}`,
          name: f.name,
          path,
          mimeType: f.type || "application/octet-stream",
          size: f.size,
          kind: isImage ? ("image" as const) : kind,
          ...(isImage ? { url: URL.createObjectURL(f) } : {}),
        }
      })
    setAttachments((prev) => [...prev, ...next])
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((x) => x.id === id)
      if (target?.url) URL.revokeObjectURL(target.url)
      return prev.filter((x) => x.id !== id)
    })
  }

  function drop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files, "file")
  }

  const canSend = !queueFull && (text.trim().length > 0 || attachments.length > 0) && Boolean(providerId && model && providerConnected)

  function send() {
    const t = text.trim()
    if ((!t && attachments.length === 0) || queueFull) return
    const sentAttachments = attachments.map(({ name, path, mimeType, size, kind }) => ({
      name, path, mimeType, size, kind,
    }))
    for (const attachment of attachments) if (attachment.url) URL.revokeObjectURL(attachment.url)
    setText("")
    setAttachments([])
    onSend?.({ text: t, attachments: sentAttachments })
  }

  return (
    <div className={OUTER[shape]}>
      {/* 输入区跟正文同宽,不然满宽风格里会出现一条居中的窄输入框 */}
      <div className={cn("w-full", COLUMN[width])}>
        {liveActivity && (
          <div className="pointer-events-auto mb-2 flex h-7 min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-brand motion-reduce:animate-none" />
            <span className="shrink-0 font-medium text-foreground/75">{liveActivity.label}</span>
            {liveActivity.detail && <span className="min-w-0 truncate">{liveActivity.detail}</span>}
          </div>
        )}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={cn(
            "relative transition-[border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
            SHELL[shape],
            dragging && "border-ring ring-2 ring-ring/60",
            dragging && shape === "inline" && "border",
          )}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-card/85">
              <span className="text-sm font-medium text-primary">松手上传</span>
            </div>
          )}

          {/* 附件区:图像走缩略图,文件走小卡片,不再用分隔线圈出一条窄带 */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-start gap-2 px-4 pt-3.5">
              {attachments.map((a) =>
                a.kind === "image" ? (
                  <div
                    key={a.id}
                    className="group relative size-16 overflow-hidden rounded-lg border border-border bg-muted"
                    title={a.name}
                  >
                    {a.url ? (
                      <img src={a.url} alt={a.name} className="size-full object-cover" />
                    ) : (
                      /* objectURL 不可用时的占位(理论上不会走到) */
                      <svg viewBox="0 0 64 64" className="size-full" aria-hidden>
                        <rect width="64" height="64" className="fill-accent" />
                        <rect x="8" y="10" width="20" height="20" rx="3" className="fill-primary/45" />
                        <rect x="33" y="14" width="23" height="4" rx="2" className="fill-foreground/30" />
                        <rect x="33" y="22" width="16" height="4" rx="2" className="fill-foreground/20" />
                        <rect x="8" y="38" width="48" height="4" rx="2" className="fill-foreground/25" />
                        <rect x="8" y="46" width="36" height="4" rx="2" className="fill-foreground/15" />
                      </svg>
                    )}
                    <button
                      onClick={() => removeAttachment(a.id)}
                      className="absolute right-1 top-1 rounded-full bg-black/55 p-0.5 text-white transition hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={`移除 ${a.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : (
                  <div
                    key={a.id}
                    className="group relative flex h-16 w-44 items-center gap-2.5 rounded-lg border border-border bg-muted/50 px-3"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
                      <FileText className="size-4.5" />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-xs font-medium">{a.name}</span>
                      <span className="type-micro uppercase text-muted-foreground">
                        {a.name.split(".").pop()}
                      </span>
                    </span>
                    <button
                      onClick={() => removeAttachment(a.id)}
                      className="absolute right-1 top-1 rounded-full bg-black/55 p-0.5 text-white transition hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={`移除 ${a.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ),
              )}
            </div>
          )}

          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={(e) => {
              if (shouldSubmitComposerKey({
                key: e.key,
                shiftKey: e.shiftKey,
                isComposing: composingRef.current || e.nativeEvent.isComposing,
              })) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={`向 ${harness.name} 描述你要做的事…`}
            rows={2}
            // field-sizing-content(Textarea 默认)按内容长高;预留两行高度,
            // 单行输入看起来太扁
            className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-4 pb-2 pt-3.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          />

          {/* 工具栏 */}
          <div className="flex items-center gap-1 px-3 pb-3">
            {scope === "project" && (
              <>
                <span
                  title={cwd}
                  className="flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-full px-2 text-sm text-muted-foreground"
                >
                  <FolderIcon open className="size-3.5 shrink-0" />
                  <span className="truncate">{folderName}</span>
                </span>
                <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
              </>
            )}
            {/* 附件 */}
            <input
              ref={imageRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files, "image")}
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files, "file")}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => imageRef.current?.click()}
                >
                  <ImageIcon className="size-4" />
                  <span className="sr-only">上传图像</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>上传图像</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                  <span className="sr-only">上传文件</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>上传文件</TooltipContent>
            </Tooltip>

            {/* 运行配置:右锚定,展开时向左生长,不挤发送按钮 */}
            <div className="flex min-w-0 flex-1 justify-end">
              <RuntimePicker
                session
                modelLocked={!onModelChange}
                selection={{
                  harnessId,
                  providerId: providerId ?? null,
                  modelId: modelId ?? null,
                  effort,
                }}
                providers={providerCatalog.providers}
                onDiscover={() => void providerCatalog.discover()}
                onEffortChange={(next) => {
                  if (!running) onEffortChange?.(next)
                }}
                onHarnessChange={(next) => {
                  if (!running && next !== harnessId) onHarnessChange?.(next)
                }}
                onSelectFull={(sel) => {
                  if (sel.providerId && sel.modelId) onModelChange?.(sel.providerId, sel.modelId)
                }}
              />
            </div>

            {/* 运行中仍允许发下一条；停止保持独立动作。 */}
            <Button size="icon" className="size-7 rounded-full" disabled={!canSend} onClick={send}>
              <ArrowUp className="size-4" />
              <span className="sr-only">{running ? "发送为下一条" : "发送"}</span>
            </Button>
            {running && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon" variant="secondary" onClick={onToggleRun} className="size-7 rounded-full">
                    <Square className="size-3 fill-current" />
                    <span className="sr-only">停止</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>停止当前任务</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* 悬浮形态下这行会压在消息上,不如省掉 */}
        {shape !== "floating" && (
          <p
            className={cn(
              "px-1 text-center text-xs text-muted-foreground",
              shape === "docked" ? "mt-1.5" : "mt-2",
            )}
          >
            <kbd className="font-mono">⏎</kbd> 发送 · <kbd className="font-mono">⇧⏎</kbd> 换行 ·
            可直接把图片或文件拖进来
          </p>
        )}
      </div>
    </div>
  )
}
