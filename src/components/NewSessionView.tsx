import { useMemo, useRef, useState } from "react"
import { ArrowUp, Folder, Loader2, MessageCircle, X } from "lucide-react"

import { WelcomeHero } from "@/components/WelcomeHero"
import { ProjectPicker } from "@/components/ProjectPicker"
import { RuntimePicker } from "@/components/RuntimePicker"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DEFAULT_HARNESS_ID, HARNESS_ORDER, getHarness, type HarnessId } from "@/core/harness"
import { shouldSubmitComposerKey } from "@/core/composer-keyboard"
import {
  defaultModelSelection,
  findProviderModel,
  modelsForProvider,
  providersForModelPicker,
} from "@/core/provider"
import type { Effort, SessionScope } from "@/core/types"
import { useHarnessPreferences } from "@/lib/harness-preferences"
import { closeNewSession } from "@/lib/new-session-store"
import { useDefaultPermissionProfile } from "@/lib/permission-profile"
import { loadRecentCwds, saveRecentCwd } from "@/lib/recent-cwds"
import { showFolder } from "@/lib/folder-preferences"
import { openSession } from "@/lib/layout-store"
import { createLive, sendPrompt, useLive } from "@/lib/live-store"
import { useAllProviderCatalogs } from "@/lib/provider-store"
import { cn } from "@/lib/utils"

export function NewSessionView({
  closable,
  initialHarnessId = DEFAULT_HARNESS_ID,
  initialCwd = "",
  initialScope = "chat",
}: {
  closable: boolean
  initialHarnessId?: HarnessId
  initialCwd?: string
  initialScope?: SessionScope
}) {
  const { sessions, binaryProgress } = useLive()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const [cwd, setCwd] = useState(initialCwd)
  const [scope, setScope] = useState<SessionScope>(initialScope)
  const [harnessId, setHarnessId] = useState<HarnessId>(initialHarnessId)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [effort, setEffort] = useState<Effort>(
    () => getHarness(initialHarnessId).defaultEffort,
  )
  const defaultPermissionProfile = useDefaultPermissionProfile()
  const [permissionProfile, setPermissionProfile] = useState(defaultPermissionProfile)
  const [task, setTask] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const harness = getHarness(harnessId)
  // 设置里关掉的 Harness 不能用于新会话:当前选中项被关时,渲染期回落到第一个启用的
  const { isEnabled } = useHarnessPreferences()
  if (!isEnabled(harnessId)) {
    const fallback = HARNESS_ORDER.find((id) => isEnabled(id))
    if (fallback && fallback !== harnessId) setHarnessId(fallback)
  }
  const providerCatalog = useAllProviderCatalogs(scope === "project" ? cwd : "")
  const selectableProviders = useMemo(
    () => providersForModelPicker(providerCatalog.providers, harnessId)
      .filter((provider) => provider.connected && modelsForProvider(provider, harnessId).length > 0),
    [harnessId, providerCatalog.providers],
  )
  const explicitProvider = providerId
    ? selectableProviders.find((provider) => provider.id === providerId)
    : undefined
  const explicitModel = explicitProvider && modelId
    ? modelsForProvider(explicitProvider, harnessId).find((model) => model.id === modelId)
    : undefined
  const defaultSelection = useMemo(
    () => defaultModelSelection(providerCatalog.providers, harnessId),
    [harnessId, providerCatalog.providers],
  )
  const resolvedProviderId = explicitModel ? explicitProvider!.id : defaultSelection?.providerId ?? null
  const resolvedModelId = explicitModel?.id ?? defaultSelection?.modelId ?? null
  const selectedModel = findProviderModel(
    selectableProviders,
    resolvedProviderId,
    harnessId,
    resolvedModelId,
  )
  const candidates = useMemo(
    () => [...new Set([
      ...loadRecentCwds(),
      ...sessions.filter((session) => session.scope === "project").map((session) => session.cwd),
    ])],
    [sessions],
  )
  const canStart = Boolean(
    window.bento && harness.live && task.trim() && resolvedProviderId && resolvedModelId &&
      selectedModel && (scope === "chat" || cwd.trim()) && !creating,
  )

  async function start() {
    if (!canStart) return
    setCreating(true)
    setError(null)
    const prompt = task.trim()
    const result = await createLive({
      scope,
      harnessId,
      cwd: scope === "project" ? cwd.trim() : "",
      title: prompt.slice(0, 24) || "新会话",
      providerId: resolvedProviderId!,
      modelId: resolvedModelId!,
      permissionProfile,
      ...(harness.effortSelection && selectedModel?.reasoning !== false ? { effort } : {}),
    })
    setCreating(false)
    if ("error" in result) {
      setError(result.error)
      return
    }

    if (scope === "project" && cwd.trim()) {
      saveRecentCwd(cwd.trim())
      showFolder(cwd.trim())
    }
    openSession(result.key)
    closeNewSession()
    void sendPrompt(result.key, prompt)
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
      {window.bento && (
        <div
          aria-hidden
          className="app-window-drag absolute inset-x-0 top-0 z-10 h-12 [-webkit-app-region:drag]"
        />
      )}
      {closable && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-4 top-4 z-20 size-8 [-webkit-app-region:no-drag]"
          onClick={closeNewSession}
        >
          <X className="size-4" />
          <span className="sr-only">关闭新对话</span>
        </Button>
      )}

      <div className="mx-auto flex min-h-full w-full flex-col justify-center px-4 py-10 sm:px-8 lg:px-12">
        <section className="mx-auto w-full max-w-[var(--app-onboarding-max)]">
          <WelcomeHero />

          <div>
            {/* 模式切换戴灰帽子:帽子外凸半卡在输入卡上沿,两个面叠成一个物件
                (按用户偏好 revert 5c190f7 的"并入卡片") */}
            <div className="relative z-0 mx-3 -mb-px flex min-h-[var(--app-project-row-height)] w-[calc(100%-1.5rem)] items-center justify-center rounded-t-2xl bg-muted/45 px-4 pb-2 pt-3 sm:mx-5 sm:w-[calc(100%-2.5rem)] sm:rounded-t-3xl sm:px-5">
              <div className="flex items-center justify-center">
                <div className="inline-flex shrink-0 gap-0.5 rounded-xl bg-muted p-1" role="tablist" aria-label="对话模式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scope === "chat"}
                    onClick={() => {
                      setScope("chat")
                      setError(null)
                      inputRef.current?.focus()
                    }}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-[color,background-color,box-shadow,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97] motion-reduce:transition-none",
                      scope === "chat"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "hover:bg-background/60 hover:text-foreground",
                    )}
                  >
                    <MessageCircle className="size-4" />
                    对话
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scope === "project"}
                    onClick={() => {
                      setScope("project")
                      setError(null)
                      inputRef.current?.focus()
                    }}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-[color,background-color,box-shadow,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97] motion-reduce:transition-none",
                      scope === "project"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "hover:bg-background/60 hover:text-foreground",
                    )}
                  >
                    <Folder className="size-4" />
                    项目
                  </button>
                </div>
                <div
                  aria-hidden={scope !== "project"}
                  className={cn(
                    "grid -translate-x-2 grid-cols-[0fr] opacity-0 transition-[grid-template-columns,margin-left,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    scope === "project" && "ml-2 translate-x-0 grid-cols-[1fr] opacity-100",
                  )}
                >
                  <div className="min-w-0 overflow-hidden">
                    <ProjectPicker
                      compact
                      disabled={scope !== "project"}
                      value={cwd}
                      candidates={candidates}
                      onChange={(path) => {
                        setCwd(path)
                        setError(null)
                        inputRef.current?.focus()
                      }}
                      className="whitespace-nowrap"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-10 overflow-hidden rounded-2xl border border-border bg-card shadow-pop sm:rounded-3xl">
            <Textarea
              ref={inputRef}
              autoFocus
              value={task}
              onChange={(event) => setTask(event.target.value)}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={(event) => {
                if (shouldSubmitComposerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: composingRef.current || event.nativeEvent.isComposing,
                })) {
                  event.preventDefault()
                  void start()
                }
              }}
              placeholder={scope === "chat" ? "随便聊聊，或问我任何问题…" : "描述一个需要在项目中完成的任务…"}
              rows={5}
              className="min-h-[var(--app-onboarding-composer-height)] resize-none rounded-none border-0 bg-transparent px-4 pb-3 pt-5 text-base shadow-none focus-visible:ring-0 dark:bg-transparent sm:px-5 md:text-base"
            />

            <div className="flex min-h-14 items-center gap-2 px-3 pb-3 sm:px-4">
              {/* 运行配置:右锚定,展开时向左生长,不挤发送按钮 */}
              <div className="flex min-w-0 flex-1 justify-end">
                <RuntimePicker
                  selection={{
                    harnessId,
                    providerId: resolvedProviderId,
                    modelId: resolvedModelId,
                    effort,
                  }}
                  providers={providerCatalog.providers}
                  onDiscover={providerCatalog.discover}
                  onEffortChange={setEffort}
                  permissionProfile={permissionProfile}
                  onPermissionChange={setPermissionProfile}
                  onHarnessChange={(next) => {
                    setHarnessId(next)
                    setProviderId(null)
                    setModelId(null)
                    setEffort(getHarness(next).defaultEffort)
                    setError(null)
                  }}
                  onSelectFull={(next) => {
                    setHarnessId(next.harnessId)
                    setProviderId(next.providerId)
                    setModelId(next.modelId)
                    setEffort(next.effort)
                    setError(null)
                  }}
                />
              </div>
              <Button
                size="icon"
                className="size-10 shrink-0 rounded-full"
                disabled={!canStart}
                onClick={() => void start()}
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                <span className="sr-only">开始对话</span>
              </Button>
            </div>

            {/* 首次使用某 harness 时受管二进制要下载几十 MB,给真实进度
                避免看起来像卡死(独立 IPC 频道,不经过会话事件缓冲) */}
            {creating && binaryProgress && (
              <div className="flex min-h-9 items-center gap-2 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="flex-1">{binaryProgress.text}</span>
                {binaryProgress.fraction !== undefined && (
                  <span className="font-mono tabular-nums">
                    {Math.round(binaryProgress.fraction * 100)}%
                  </span>
                )}
              </div>
            )}
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-center text-xs text-err">
              {error}
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
