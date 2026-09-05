/**
 * 布局控制器(L3,ARCHITECTURE.md §6.1)。
 *
 * 「面板管理器 API」的最小实现:侧栏点击、会话拖入、未来 agent 的工具调用
 * 都经这里操作布局,不直接碰 dockview。DockWorkspace 在 onReady 时注册
 * DockviewApi;其他组件经 useLayout() 订阅衍生状态(打开了哪些会话、焦点
 * 在哪个)。v0.3 会话真实化后,这里与无头 core 的 store 合并。
 */

import { useSyncExternalStore } from "react"
import type { AddPanelOptions, DockviewApi } from "dockview"

import { deriveUiAdjacency } from "@/core/collaboration"
import type { UiSessionAdjacency, UiSessionRect } from "@/core/collaboration"
import { liveMeta } from "@/lib/live-store"

type PanelPosition = AddPanelOptions["position"]

export type LayoutMode = "managed" | "free"

export type LayoutSnapshot = {
  /** 已打开的会话 id(按面板顺序) */
  openSessionIds: string[]
  /** 焦点面板绑定的会话 */
  focusedSessionId: string | null
  /** 焦点在应用面板(单例,见 openAppsView) */
  appsFocused: boolean
  /** 实际可见 Session 的瞬时空间邻接关系。 */
  adjacency: UiSessionAdjacency[]
  /** managed(默认)= 无标签头受管布局;free = 标签页模式,组头可见可叠放 */
  mode: LayoutMode
}

const MODE_KEY = "bento.layoutMode"

function loadMode(): LayoutMode {
  try {
    if (localStorage.getItem(MODE_KEY) === "free") return "free"
  } catch {
    /* ignore */
  }
  return "managed"
}

let api: DockviewApi | null = null
let snapshot: LayoutSnapshot = {
  openSessionIds: [],
  focusedSessionId: null,
  appsFocused: false,
  adjacency: [],
  mode: loadMode(),
}

const listeners = new Set<() => void>()

/** 布局持久化防抖:程序化 addPanel/removePanel 不触发 dockview 的
 *  onDidLayoutChange,所有变更路径都显式走 refresh(),持久化也挂在这里 */
let persistTimer: number | undefined

function schedulePersist() {
  if (!api) return
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem("bento.layout", JSON.stringify(api!.toJSON()))
    } catch {
      /* ignore */
    }
  }, 500)
}

function emit() {
  for (const l of listeners) l()
}

/** 会话面板的 id 约定。一个会话最多一个面板,天然去重 */
export function panelIdOf(sessionId: string) {
  return `chat:${sessionId}`
}

function sessionIdOf(panelId: string): string | null {
  return panelId.startsWith("chat:") ? panelId.slice(5) : null
}

let headerObserver: MutationObserver | null = null
let headerHost: HTMLElement | null = null

/** DockWorkspace 在 onReady 注册;卸载时传 null。
 *  dockview 8 组注册是异步的,事件与 rAF 都追不上(藏头会漏),
 *  用 MutationObserver 盯组节点进 DOM 的时机兜底 */
export function attachDockApi(next: DockviewApi | null, container?: HTMLElement | null) {
  api = next
  headerObserver?.disconnect()
  headerObserver = null
  headerHost = container ?? null
  if (api && container) {
    headerObserver = new MutationObserver(() => applyHeaderMode())
    headerObserver.observe(container, { childList: true, subtree: true })
  }
  refresh()
}

/** 组头(标签页)显隐跟随模式。两条腿:dockview 状态 api(对已注册组)+
 *  DOM 直写(对注册滞后的组);dockview 自己的 setter 也是写同样的 inline style */
function applyHeaderMode() {
  if (!api) return
  const hidden = snapshot.mode === "managed"
  for (const g of api.groups) g.header.hidden = hidden
  if (headerHost) {
    for (const el of headerHost.querySelectorAll<HTMLElement>(".dv-tabs-and-actions-container")) {
      el.style.display = hidden ? "none" : ""
    }
  }
}

/** 从 dockview 现状重算衍生状态。面板增删、焦点变化后由各变更路径调用 */
export function refresh() {
  const open: string[] = []
  let focused: string | null = null
  let appsFocused = false
  let adjacency: UiSessionAdjacency[] = []
  if (api) {
    applyHeaderMode()
    for (const p of api.panels) {
      const sid = sessionIdOf(p.id)
      if (sid) open.push(sid)
    }
    focused = api.activePanel ? sessionIdOf(api.activePanel.id) : null
    appsFocused = api.activePanel?.id === APPS_PANEL_ID
    adjacency = currentUiAdjacency()
    schedulePersist()
  }
  // 无变化不通知,避免无谓重渲染
  if (
    open.join(",") !== snapshot.openSessionIds.join(",") ||
    focused !== snapshot.focusedSessionId ||
    appsFocused !== snapshot.appsFocused ||
    JSON.stringify(adjacency) !== JSON.stringify(snapshot.adjacency)
  ) {
    snapshot = { ...snapshot, openSessionIds: open, focusedSessionId: focused, appsFocused, adjacency }
    emit()
  }
}

export function titleOf(sessionId: string): string {
  // 布局恢复早于 live-store 加载完时兜底用 key;加载完 refresh() 会带真标题
  return liveMeta(sessionId)?.title ?? sessionId
}

function addChatPanel(sessionId: string, position?: PanelPosition, inactive?: boolean) {
  api!.addPanel({
    id: panelIdOf(sessionId),
    component: "view",
    title: titleOf(sessionId),
    params: { viewId: "core.chat", instanceState: { sessionId } },
    ...(inactive ? { inactive: true } : {}),
    ...(position ? { position } : {}),
  })
}

/**
 * 打开会话。replace = 换掉当前焦点面板的会话(默认,对应侧栏点击);
 * split = 在焦点面板旁新开一栏(对应拖拽落下,由 DockWorkspace 直接处理落点)。
 */
export function openSession(sessionId: string, mode: "replace" | "split" = "replace") {
  if (!api) return
  const existing = api.getPanel(panelIdOf(sessionId))
  if (existing) {
    existing.api.setActive()
    refresh()
    return
  }

  const active = api.activePanel
  const activeIsChat = active && sessionIdOf(active.id) !== null

  if (mode === "split" || !activeIsChat) {
    addChatPanel(
      sessionId,
      activeIsChat ? { direction: "right", referencePanel: active!.id } : undefined,
    )
  } else {
    // replace:先在同组加新面板再移除旧的,组不会因清空而消失
    addChatPanel(sessionId, { referenceGroup: active!.group })
    api.removePanel(active!)
  }
  refresh()
}

/** 在指定会话面板旁分栏打开(拖拽落点由调用方算好 position 传入) */
export function openSessionAt(sessionId: string, position: PanelPosition) {
  if (!api) return
  const existing = api.getPanel(panelIdOf(sessionId))
  if (existing) {
    existing.api.setActive()
    refresh()
    return
  }
  addChatPanel(sessionId, position)
  refresh()
}

export function closeSession(sessionId: string) {
  if (!api) return
  const panel = api.getPanel(panelIdOf(sessionId))
  if (!panel) return
  // 最后一个聊天面板不许关——工作台不允许空到没有对话
  if (snapshot.openSessionIds.length <= 1) return
  api.removePanel(panel)
  refresh()
}

/** 标签页模式开关(设置页)。模式切换立即作用于现有组头,
 *  refresh 内也有一份,这里保证不依赖后续事件 */
export function setLayoutMode(mode: LayoutMode) {
  if (snapshot.mode === mode) return
  snapshot = { ...snapshot, mode }
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
  if (api) for (const g of api.groups) g.header.hidden = mode === "managed"
  emit()
}

/** 应用面板的固定 id:单例,一点即活 */
export const APPS_PANEL_ID = "apps"

/**
 * 打开应用主视图。已开则聚焦;未开则在当前焦点组里加单例面板——
 * 之后点会话走 openSession 的默认路径,应用面板作为隐藏标签留在组里,
 * 再点「应用」即切回,布局持久化自动覆盖它
 */
export function openAppsView() {
  if (!api) return
  const existing = api.getPanel(APPS_PANEL_ID)
  if (existing) {
    existing.api.setActive()
    refresh()
    return
  }
  const active = api.activePanel
  api.addPanel({
    id: APPS_PANEL_ID,
    component: "view",
    title: "应用",
    params: { viewId: "core.apps" },
    ...(active ? { position: { referenceGroup: active.group } } : {}),
  })
  refresh()
}

// ---- 协作 UI(agent 面向的布局操作;仍只接 sessionId)----

/** auto 放置:容器足够宽且横向占优时向右分栏,否则向下(窄屏/纵向)。 */
export function choosePlacement(width: number, height: number): "right" | "down" {
  return width >= 680 && width >= height ? "right" : "down"
}

function chatPanelIds(): string[] {
  return snapshot.openSessionIds.map((id) => panelIdOf(id))
}

/**
 * agent 面向的 show。幂等:已有面板时只在 focus 时激活。
 * anchor 优先 caller session 的面板;auto 依容器尺寸选 right/down;
 * focus=false 直接 inactive 添加,绝不抢焦点。
 */
export function agentShowSession(
  sessionId: string,
  options: { anchorSessionId?: string; placement?: "auto" | "right" | "down"; focus?: boolean } = {},
) {
  if (!api) return
  const existing = api.getPanel(panelIdOf(sessionId))
  if (existing) {
    if (options.focus) existing.api.setActive()
    refresh()
    return
  }
  const previousActive = api.activePanel
  const anchor = (options.anchorSessionId && api.getPanel(panelIdOf(options.anchorSessionId))) ||
    (previousActive && sessionIdOf(previousActive.id) !== null ? previousActive : null)

  let position: PanelPosition | undefined
  if (anchor) {
    // "auto" 表示由容器尺寸决定:right/down 显式指定则照用
    const placement = !options.placement || options.placement === "auto"
      ? choosePlacement(api.width, api.height)
      : options.placement
    position = { direction: placement === "right" ? "right" : "below", referencePanel: anchor.id }
  }
  // focus=false 直接以 inactive 添加,不抢焦点也不做"抢了再还"
  addChatPanel(sessionId, position, !options.focus)
  refresh()
}

/** agent 面向的 hide:只移除面板,不关 Session;最后一个聊天面板保留(产品兜底,不白屏)。 */
export function agentHideSession(sessionId: string) {
  if (!api) return
  const panel = api.getPanel(panelIdOf(sessionId))
  if (!panel) return
  if (chatPanelIds().length <= 1) return
  api.removePanel(panel)
  refresh()
}

/** agent 面向的 focus。 */
export function agentFocusSession(sessionId: string) {
  if (!api) return
  api.getPanel(panelIdOf(sessionId))?.api.setActive()
  refresh()
}

/** 非 React 订阅(collaboration-ui 上报 presence 用) */
export function subscribeLayoutChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 非 React 场景的当前快照(collaboration-ui presence 上报用) */
export function currentLayoutSnapshot(): LayoutSnapshot {
  return snapshot
}

/**
 * 从 Dockview 当前真正可见的聊天内容区域计算 Session 邻接。
 * 同组未激活的标签不会进入投影；Dockview 的 group DOM 只在 renderer 内读取，
 * main/Agent 只会看到 sessionId 之间的关系。
 */
export function currentUiAdjacency(): UiSessionAdjacency[] {
  if (!api) return []
  const rects: UiSessionRect[] = []
  for (const panel of api.panels) {
    const sessionId = sessionIdOf(panel.id)
    if (!sessionId || !panel.api.isVisible) continue
    const rect = panel.group.element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    rects.push({
      sessionId,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    })
  }
  return deriveUiAdjacency(rects)
}

export function useLayout(): LayoutSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot,
  )
}
