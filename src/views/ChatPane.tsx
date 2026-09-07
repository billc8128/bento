/** core.chat:对话头 + 聊天流 + composer。多实例:每个面板绑一个会话。 */

import { useEffect, useState } from "react"
import { MessageCircle, MoreHorizontal, X } from "lucide-react"

import { ChatView } from "@/components/ChatView"
import { Composer } from "@/components/Composer"
import { Button } from "@/components/ui/button"
import { FolderIcon } from "@/components/FolderIcon"
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
import { useT } from "@/lib/i18n"
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

type HeaderInfo = { title: string; path: string; branch?: string; folder?: string }

/** 项目目录名:pane 头部展示的文件夹名(路径最后一段) */
function dirName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
}

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
  const { t } = useT()
  return (
    <header
      className={cn(
        "app-window-drag flex shrink-0 items-center gap-2 [-webkit-app-region:drag]",
        minimal
          // 压缩到 h-9:头部只剩文件夹名/标题一行,再厚就和正文抢地盘
          ? cn("h-9 border-b border-border/50 bg-muted/35", CHAT_CONTENT_GUTTER[composer])
          : "h-12 border-b px-4",
      )}
    >
      {scope === "chat" && (
        // 和文件夹图标同一待遇:裸图标,不带底色 chip(灰底看着像选中态)
        <MessageCircle
          className="size-4 shrink-0 text-muted-foreground"
          aria-label={t("chat.chatSession")}
        />
      )}
      {/* 项目会话:文件夹名提到标题级(纯信息,不响应点击)——分栏布局下每个
          pane 自己带项目上下文,minimal 模式再没有"这是哪个项目"的盲区 */}
      {info.folder && (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <FolderIcon className="size-4" />
          <span className="max-w-32 truncate text-sm font-medium">{info.folder}</span>
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* minimal + 项目会话不显示标题:文件夹名已承载 pane 身份,标题和侧栏重复。
            其余场景标题保留;minimal 下缩到 text-sm,与文件夹名同一级 */}
        {!(minimal && info.folder) && (
          <h1
            className={cn(
              "app-title truncate leading-tight",
              minimal ? "text-sm font-medium" : "text-base font-semibold",
            )}
          >
            {info.title}
          </h1>
        )}
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
          <span className="sr-only">{t("chat.moreActions")}</span>
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
          <span className="sr-only">{t("chat.closePane")}</span>
        </Button>
      )}
    </header>
  )
}

export function ChatPane() {
  const traits = useTraits()
  const { t } = useT()
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
        {t("chat.sessionMissing")}
        {!solo && (
          <Button variant="ghost" size="sm" onClick={close}>
            {t("chat.closePane")}
          </Button>
        )}
      </div>
    )
  }

  // 本地发送集合之外,main runtime working(后台协作任务)也显示生成态;
  // blocked(挂起审批)turn 还活着,同样按 running 渲染,审批卡片另有提示。
  const running = isRunning(sessionId) || live.runtime === "working" || live.runtime === "blocked"
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
          ...(live.scope === "project" ? { folder: dirName(live.cwd) } : {}),
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
        cwd={live.scope === "project" ? live.cwd : undefined}
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
          <span>{t("chat.legacyNative")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => requestNewSession({
              harnessId: live.harnessId as HarnessId,
              scope: live.scope,
              ...(live.scope === "project" ? { cwd: live.cwd } : {}),
            })}
          >
            {t("chat.newSession")}
          </Button>
        </div>
      ) : (
        <Composer
          running={running}
          collapsible={!solo}
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
            <AlertDialogTitle>{t("chat.switchHarnessTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat.switchHarnessDesc", {
                from: harness.name,
                to: nextHarnessId ? getHarness(nextHarnessId).name : t("chat.otherHarness"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("chat.cancel")}</AlertDialogCancel>
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
              {t("chat.newChat")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
