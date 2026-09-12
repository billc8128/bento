/**
 * 主区布局宿主(L3):dockview 接管,默认受管布局(ARCHITECTURE.md §6.1)。
 *
 * - 受管(默认):隐藏标签头、禁浮动组。用户手势 = 拖分隔条、关面板、会话拖入分栏
 * - 标签页模式(设置页开启):组头可见,会话/应用可叠放,浏览器式切换
 * - 布局持久化:防抖写 localStorage,损坏/viewId 未注册回退默认布局
 * - 外部拖入:侧栏会话行带 application/x-bento-session,落点由 dockview 算
 */

import { useEffect, useRef } from "react"
import { DockviewReact } from "dockview-react"
import {
  positionToDirection,
  type DockviewTheme,
  type DockviewApi,
  type DockviewDidDropEvent,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from "dockview"

import {
  attachDockApi,
  closeSession,
  openSession,
  openSessionAt,
  panelIdOf,
  refresh,
  useLayout,
} from "@/lib/workspace/layout-store"
import { liveSessionsSnapshot, useLive } from "@/lib/sessions/live-store"
import { useNewSession } from "@/lib/sessions/new-session-store"
import { useT } from "@/lib/i18n"
import { PanelInstanceProvider } from "@/lib/workspace/panel-context"
import { NewSessionView } from "@/components/NewSessionView"
import { getView } from "@/views/registry"

const LAYOUT_KEY = "bento.layout"

export const SESSION_MIME = "application/x-bento-session"


type PanelParams = {
  viewId: string
  instanceState?: { sessionId?: string }
}

/** 所有面板的统一宿主:把布局树里的 instanceState 转成实例 context */
function PanelHost(props: IDockviewPanelProps<PanelParams>) {
  const { openSessionIds } = useLayout()
  const { t } = useT()
  const { viewId, instanceState } = props.params
  const sessionId = instanceState?.sessionId ?? ""

  let View: React.ComponentType
  try {
    View = getView(viewId).component
  } catch {
    // viewId 未注册(比如插件被卸载后遗留的布局):占位而不是白屏
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("workspace.unknownView", { viewId })}
      </div>
    )
  }

  return (
    <PanelInstanceProvider
      value={{
        panelId: props.api.id,
        sessionId,
        close: () => closeSession(sessionId),
        solo: openSessionIds.length <= 1,
      }}
    >
      <View />
    </PanelInstanceProvider>
  )
}

const COMPONENTS = { view: PanelHost }

/** 自定义主题:变量在 themes.css 里全部映射到 L0 token */
const BENTO_THEME: DockviewTheme = { name: "bento", className: "dockview-theme-bento" }

function loadLayout(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SerializedDockview
    // 预检:面板引用的 view 必须都已注册,否则整份布局按损坏处理
    for (const p of Object.values(data.panels ?? {})) {
      const params = p.params as PanelParams | undefined
      if (!params?.viewId) throw new Error("panel 缺 viewId")
      getView(params.viewId)
    }
    return data
  } catch {
    try {
      localStorage.removeItem(LAYOUT_KEY)
    } catch {
      /* ignore */
    }
    return null
  }
}

/** 默认布局:打开最近一个会话;没有会话就留空(由空态引导新建) */
function defaultLayout(api: DockviewApi) {
  const last = liveSessionsSnapshot()[0]
  if (!last) return
  api.addPanel({
    id: panelIdOf(last.key),
    component: "view",
    title: last.title,
    params: { viewId: "core.chat", instanceState: { sessionId: last.key } },
  })
}

/** 布局里引用的会话若已删档,恢复时剔除,不留在树上当死面板 */
function pruneStalePanels(api: DockviewApi) {
  const live = new Set(liveSessionsSnapshot().map((s) => s.key))
  for (const p of api.panels) {
    const sid = p.params?.viewId === "core.chat" ? p.params.instanceState?.sessionId : null
    if (sid && !live.has(sid)) api.removePanel(p)
  }
}

function isSessionDrag(e: DragEvent | PointerEvent): e is DragEvent {
  return e instanceof DragEvent && !!e.dataTransfer?.types.includes(SESSION_MIME)
}

export function DockWorkspace() {
  const { mode, appsFocused } = useLayout()
  const { initialized, sessions: liveSessions } = useLive()
  const newSession = useNewSession()
  const apiRef = useRef<DockviewApi | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const managed = mode === "managed"

  // Session index 真正加载后再清理恢复布局。不能在初始空数组阶段 prune，
  // 否则会把所有持久化 Panel 误判为已删除，再退化成单 Panel。
  useEffect(() => {
    const api = apiRef.current
    if (!api || !initialized) return
    pruneStalePanels(api)
    if (api.panels.length === 0 && liveSessions.length > 0) openSession(liveSessions[0].key)
  }, [initialized, liveSessions])


  function onReady(event: DockviewReadyEvent) {
    const api = event.api
    apiRef.current = api
    attachDockApi(api, hostRef.current)

    const saved = loadLayout()
    if (saved) {
      try {
        api.fromJSON(saved)
      } catch {
        api.clear()
        if (initialized) defaultLayout(api)
      }
    } else if (initialized) {
      defaultLayout(api)
    }

    // 外部拖入:只接受侧栏会话拖拽
    api.onUnhandledDragOver((e) => {
      if (isSessionDrag(e.nativeEvent)) e.accept()
    })

    // 用户手势(拖拽重排等) dockview 会发事件;程序化变更由 refresh() 兜底,
    // 持久化统一在 layout-store 的 schedulePersist
    api.onDidLayoutChange(() => refresh())
    api.onDidActivePanelChange(() => refresh())

    refresh()
  }

  function onDidDrop(e: DockviewDidDropEvent) {
    if (!(e.nativeEvent instanceof DragEvent)) return
    const sessionId = e.nativeEvent.dataTransfer?.getData(SESSION_MIME)
    if (!sessionId) return

    let direction = positionToDirection(e.position)
    // 受管布局没有标签页,落进组内(within)会叠在别的面板后面看不见——转成右分栏
    if (managed && direction === "within") direction = "right"

    openSessionAt(
      sessionId,
      e.group ? { direction, referenceGroup: e.group } : { direction },
    )
  }

  useEffect(() => {
    return () => {
      attachDockApi(null)
    }
  }, [])

  return (
    <div ref={hostRef} className="relative h-full">
      <DockviewReact
        components={COMPONENTS}
        theme={BENTO_THEME}
        onReady={onReady}
        onDidDrop={onDidDrop}
        disableFloatingGroups={managed}
        hideBorders={false}
      />
      {/* 无会话自动 onboarding;已有会话时点「新对话」覆盖到同一完整起始页。
          「新对话」是显式意图,始终优先;仅自动 onboarding 给聚焦的应用面板让位 */}
      {(newSession.open || (liveSessions.length === 0 && !appsFocused)) && (
        <div data-overlay-page className="absolute inset-0 z-20">
          <NewSessionView
            key={newSession.revision}
            closable={liveSessions.length > 0}
            initialHarnessId={newSession.harnessId}
            initialCwd={newSession.cwd}
            initialScope={newSession.scope}
          />
        </div>
      )}
    </div>
  )
}
