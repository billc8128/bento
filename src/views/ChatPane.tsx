/** core.chat:对话头 + 聊天流 + composer。多实例:每个面板绑一个会话。 */

import { useEffect, useState } from "react"
import { MessageCircle, MoreHorizontal, X } from "lucide-react"

import { ChatView } from "@/components/ChatView"
import { Composer } from "@/components/Composer"
import { Button } from "@/components/ui/button"
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
import { cn } from "@/lib/utils"
import { usePanelInstance } from "@/lib/panel-context"
import { useTraits } from "@/lib/style-context"
import { requestNewSession } from "@/lib/new-session-store"
import {
  cancelPrompt,
  cancelQueuedPrompt,
  ensureLoaded,
  isRunning,
  liveMessages,
  liveMeta,
  queueLivePrompt,
  queuedPrompt,
  sendPrompt,
  setLiveEffort,
  setLiveModel,
  setLivePermissionProfile,
  resolveLiveApproval,
  steerQueuedPrompt,
  useLive,
} from "@/lib/live-store"
import { getHarness, type HarnessId } from "@/core/harness"
import { liveTurnState } from "@/core/activity"
import type { SessionScope } from "@/core/types"
import { CHAT_CONTENT_GUTTER, type ComposerShape } from "@/data/styles"

type HeaderInfo = { title: string; path: string; branch?: string }

function PaneHeader({
  info,
  minimal,
  composer,
  scope,
  solo,
  onClose,
}: {
  info: HeaderInfo
  minimal: boolean
  composer: ComposerShape
  scope: SessionScope
  solo: boolean
  onClose: () => void
}) {
  return (
    <header
      className={cn(
        "app-window-drag flex shrink-0 items-center gap-2 [-webkit-app-region:drag]",
        minimal
          ? cn("h-16 border-transparent", CHAT_CONTENT_GUTTER[composer])
          : "h-12 border-b px-4",
      )}
    >
      {scope === "chat" && (
        <span
          title="Chat 会话"
          className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
        >
          <MessageCircle className="size-3.5" />
          <span className="sr-only">Chat 会话</span>
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 标题比正文高一级(text-base):它是这个面板的名字,不是一条列表项 */}
        <h1 className="app-title truncate text-base font-semibold leading-tight">{info.title}</h1>
        {!minimal && (
          <p className="type-micro truncate font-mono text-muted-foreground">
            {info.path}
            {info.branch ? ` · ${info.branch}` : ""}
          </p>
        )}
      </div>
      {!minimal && (
        <Button variant="ghost" size="icon" className="size-7 [-webkit-app-region:no-drag]">
          <MoreHorizontal className="size-4" />
          <span className="sr-only">更多操作</span>
        </Button>
      )}
      {!solo && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 [-webkit-app-region:no-drag]"
          onClick={onClose}
        >
          <X className="size-4" />
          <span className="sr-only">关闭此分栏</span>
        </Button>
      )}
    </header>
  )
}

export function ChatPane() {
  const traits = useTraits()
  const { sessionId, close, solo } = usePanelInstance()
  const [nextHarnessId, setNextHarnessId] = useState<HarnessId | null>(null)
  useLive() // 订阅真会话变化

  const minimal = traits.header === "minimal"
  const live = liveMeta(sessionId)

  // 真会话:打开即回放历史(与实时共用 reducer)
  useEffect(() => {
    if (live) void ensureLoaded(sessionId)
  }, [live, sessionId])

  if (!live) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        会话不存在或已删除
        {!solo && (
          <Button variant="ghost" size="sm" onClick={close}>
            关闭此分栏
          </Button>
        )}
      </div>
    )
  }

  // 本地发送集合之外,main runtime working(后台协作任务)也显示生成态
  const running = isRunning(sessionId) || live.runtime === "working"
  const harness = getHarness(live.harnessId as HarnessId)
  const messages = liveMessages(sessionId)
  const queued = queuedPrompt(sessionId)
  // 运行态唯一状态标题的数据源；在消息流末端展开，落定后同一批
  // activity 由对应 assistant message 的折叠 trace 承接。
  const turn = liveTurnState(messages, running)
  // 历史 native 会话:依赖本机 CLI 配置,已不再支持;历史仍可回放,不可续聊。
  const legacyNative = live.providerId?.startsWith("native-") ?? false
  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-col">
      <PaneHeader
        info={{
          title: live.title,
          path: live.scope === "chat"
            ? (harness?.name ?? live.harnessId)
            : `${live.cwd} · ${harness?.name ?? live.harnessId}`,
        }}
        minimal={minimal}
        composer={traits.composer}
        scope={live.scope}
        solo={solo}
        onClose={close}
      />
      <ChatView
        messages={messages}
        pending={running}
        turn={turn}
        onResolveApproval={(id, decision) => void resolveLiveApproval(sessionId, id, decision)}
        queued={queued ? {
          text: queued.input.text,
          steerAvailable: queued.steerAvailable,
          steering: queued.state === "steering",
          onSteer: () => void steerQueuedPrompt(sessionId),
          onCancel: () => void cancelQueuedPrompt(sessionId),
        } : undefined}
      />
      {legacyNative ? (
        <div className="flex min-h-14 items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
          <span>该会话依赖本机 CLI 配置,已不再支持;历史消息仍可查看。</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => requestNewSession({
              harnessId: live.harnessId as HarnessId,
              scope: live.scope,
              ...(live.scope === "project" ? { cwd: live.cwd } : {}),
            })}
          >
            新建会话
          </Button>
        </div>
      ) : (
        <Composer
          running={running}
          scope={live.scope}
          harnessId={live.harnessId as HarnessId}
          cwd={live.cwd}
          providerId={live.providerId}
          modelId={live.modelId}
          effort={live.effort}
          permissionProfile={live.permissionProfile}
          onToggleRun={() => void cancelPrompt(sessionId)}
          onSend={(input) => void (running
            ? queueLivePrompt(sessionId, input)
            : sendPrompt(sessionId, input))}
          queueFull={Boolean(queued)}
          onHarnessChange={setNextHarnessId}
          onModelChange={
            !running && live.capabilities?.modelSwitch === "live"
              ? (providerId, modelId) => void setLiveModel(sessionId, providerId, modelId)
              : undefined
          }
          onEffortChange={
            !running && live.capabilities?.effortSwitch === "live"
              ? (effort) => void setLiveEffort(sessionId, effort)
              : undefined
          }
          onPermissionChange={
            // 权限切换能力看 harness 静态元数据,不看会话存档的 capabilities——
            // 沉睡会话的 capabilities 是创建时快照,可能过期(M2 给 codex 加了热切)。
            // 运行中也允许切(对齐 Codex app):codex 下个回合生效,claude/ACP 下个工具调用即生效。
            getHarness(live.harnessId).permissionSwitch === "live"
              ? (profile) => void setLivePermissionProfile(sessionId, profile)
              : undefined
          }
        />
      )}
      <AlertDialog
        open={nextHarnessId !== null}
        onOpenChange={(open) => !open && setNextHarnessId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>切换 Harness 需要新对话</AlertDialogTitle>
            <AlertDialogDescription>
              当前会话不能直接从 {harness.name} 切换到
              {nextHarnessId ? ` ${getHarness(nextHarnessId).name}` : "其他 Harness"}。
              新建后会保留当前会话和上下文。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!nextHarnessId) return
                requestNewSession({
                  harnessId: nextHarnessId,
                  scope: live.scope,
                  ...(live.scope === "project" ? { cwd: live.cwd } : {}),
                })
                setNextHarnessId(null)
              }}
            >
              新建对话
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
