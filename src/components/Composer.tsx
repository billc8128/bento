import { useEffect, useRef, useState } from "react"
import { ArrowUp, FileText, ImageIcon, Paperclip, Square, X } from "lucide-react"

import { RuntimePicker } from "@/components/RuntimePicker"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useTraits } from "@/lib/style-context"
import { getHarness, type HarnessId } from "@/core/harness"
import type { PermissionProfile } from "@/core/permission"
import { findProviderModel } from "@/core/provider"
import { shouldSubmitComposerKey } from "@/core/composer-keyboard"
import type { Effort, PromptAttachment, PromptInput } from "@/core/types"
import { useProviderCatalog } from "@/lib/provider-store"
import { COLUMN, type ComposerShape } from "@/data/styles"

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
  /** 会话所属 harness 与真实生效的模型配置。 */
  harnessId: HarnessId
  cwd: string
  providerId?: string
  modelId?: string
  effort?: Effort
  permissionProfile?: PermissionProfile
  onToggleRun: () => void
  onSend?: (input: PromptInput) => void
  onModelChange?: (providerId: string, modelId: string) => void
  onEffortChange?: (effort: Effort) => void
  onPermissionChange?: (profile: PermissionProfile) => void
  onHarnessChange?: (harnessId: HarnessId) => void
  queueFull?: boolean
  /** 分栏时为 true:composer 默认收成胶囊,聚焦/点击展开 */
  collapsible?: boolean
}

export function Composer({
  running,
  harnessId,
  cwd,
  providerId,
  modelId,
  effort = "medium",
  permissionProfile,
  onToggleRun,
  onSend,
  onModelChange,
  onEffortChange,
  onPermissionChange,
  onHarnessChange,
  queueFull = false,
  collapsible = false,
}: ComposerProps) {
  const { composer: shape, width } = useTraits()
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

  // 只有圆角外壳的形态才有"胶囊"可收;docked/inline 没收起意义
  const canCollapse = collapsible && (shape === "floating" || shape === "card")
  // 只有内容(文字/附件)阻止收起;运行中也可收——停止/发送钮钉在右下角,
  // 收起态同样可见,队列提示本来就在 ChatView 消息流里
  const busy = attachments.length > 0 || text.trim().length > 0
  const collapsed = canCollapse && !busy && !manualOpen

  // Radix 弹层(RuntimePicker 等)portal 在 shell 外,点它不算"点外部"
  const inPopper = (t: EventTarget | null) =>
    t instanceof Element && Boolean(t.closest("[data-radix-popper-content-wrapper]"))

  // 点外部收回(busy 时 collapsed 已为 false,收起无害)
  useEffect(() => {
    if (!canCollapse) return
    const onDown = (e: PointerEvent) => {
      if (inPopper(e.target)) return
      if (!shellRef.current?.contains(e.target as Node)) setManualOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [canCollapse])

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

  async function addFiles(files: FileList | File[] | null, kind: Attachment["kind"]) {
    if (!files?.length) return
    const next = (await Promise.all(Array.from(files).map(async (f, i) => {
        // 剪贴板粘贴的 File 没有磁盘路径,先把字节落盘成附件文件
        let path = window.bento?.pathForFile(f) ?? ""
        if (!path && window.bento?.saveAttachmentBlob) {
          const saved = await window.bento.saveAttachmentBlob({
            name: f.name || `pasted-${Date.now()}`,
            mimeType: f.type || "application/octet-stream",
            data: await f.arrayBuffer(),
          })
          path = saved.path ?? ""
        }
        if (!path) return null
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
      }))).filter((a) => a !== null)
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
        <div
          ref={shellRef}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          onClick={() => {
            if (!collapsed) return
            setManualOpen(true)
            textareaRef.current?.focus()
          }}
          className={cn(
            "relative transition-[border-color,box-shadow,max-width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            SHELL[shape],
            // 收起态 48px 高配 24px 圆角已是完整胶囊;rounded-full(9999px)→24px 的
            // 插值会被"半径≤高度一半"钳制,动画前段看着不动、末尾跳变,所以不能用它
            collapsed && "mx-auto max-w-[460px] cursor-text rounded-[24px]",
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
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setManualOpen(true)}
            onBlur={(e) => {
              // 光标移出也收回(Tab/切窗口);焦点落在弹层里(选模型中)不收
              const next = e.relatedTarget
              if (!canCollapse) return
              if (next && shellRef.current?.contains(next)) return
              if (inPopper(next)) return
              setManualOpen(false)
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null)
              if (files.length === 0) return
              e.preventDefault()
              void addFiles(files, "file")
            }}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && canCollapse && !text.trim()) {
                setManualOpen(false)
                e.currentTarget.blur()
                return
              }
              if (shouldSubmitComposerKey({
                key: e.key,
                shiftKey: e.shiftKey,
                isComposing: composingRef.current || e.nativeEvent.isComposing,
              })) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={collapsed ? "描述你要做的事…" : `向 ${harness.name} 描述你要做的事…`}
            rows={collapsed ? 1 : 2}
            // 收起态是单行胶囊:禁换行,空间不够时横向裁剪(同单行 input),
            // 否则窄分栏下 placeholder 换行会被固定高度竖直切半
            wrap={collapsed ? "off" : "soft"}
            // field-sizing-content(Textarea 默认)按内容长高;展开态预留两行高度,
            // 单行输入看起来太扁。收起态固定 48px 单行居中,py-3 对称 padding 居中文字
            className={cn(
              "resize-none border-0 bg-transparent px-4 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent",
              "transition-[height,padding] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              collapsed
                ? "h-12 max-h-12 min-h-12 overflow-hidden py-3 pr-44 leading-6"
                : "max-h-40 min-h-16 pb-2 pt-3.5",
            )}
          />

          {/* 收起态胶囊里的 harness·model 身份:分栏下一眼认出这条会话是哪个 agent;
              展开后淡出,身份由工具栏的 RuntimePicker 承接 */}
          {canCollapse && (
            <span
              className={cn(
                // max-w-28 + right-14:最左不超过 168px,始终在 textarea pr-44(176px)
                // 保留区内,永不与输入文字重叠;超长模型名 truncate
                "pointer-events-none absolute right-14 top-1/2 max-w-28 -translate-y-1/2 truncate text-xs text-muted-foreground transition-opacity duration-200",
                collapsed ? "opacity-100" : "opacity-0",
              )}
            >
              {harness.name}
              {model ? ` · ${model.name}` : ""}
            </span>
          )}

          {/* 工具栏:收起态 0fr 收掉;发送/停止钮绝对定位在右下角,两种状态共用同一个位置 */}
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={cn(
                  "flex items-center gap-1 px-3 pb-3 transition-opacity duration-200",
                  // 右侧给绝对定位的发送(+停止)钮留位
                  running ? "pr-20" : "pr-12",
                  collapsed && "opacity-0",
                )}
              >
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
                permissionProfile={permissionProfile ?? "standard"}
                onPermissionChange={onPermissionChange}
                onHarnessChange={(next) => {
                  if (!running && next !== harnessId) onHarnessChange?.(next)
                }}
                onSelectFull={(sel) => {
                  if (sel.providerId && sel.modelId) onModelChange?.(sel.providerId, sel.modelId)
                }}
              />
            </div>
              </div>
            </div>
          </div>

          {/* 运行中仍允许发下一条;停止保持独立动作。钉在右下角:收起态也可见 */}
          <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1">
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
            可直接把图片或文件拖进来,或直接粘贴剪贴板图片
          </p>
        )}
      </div>
    </div>
  )
}
