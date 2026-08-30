import { randomUUID } from "node:crypto"

import {
  BrowserWindow,
  session,
  shell,
  WebContentsView,
  type Rectangle,
} from "electron"

import type {
  WorkspaceBounds,
  WorkspaceBrowserSnapshot,
  WorkspaceBrowserState,
} from "../../src/types/workspace"
import { normalizeWorkspaceBrowserUrl } from "../../src/core/workspace-browser"
import { simplifyWorkspaceAxNodes } from "../../src/core/workspace-browser-automation"

type BrowserRecord = {
  ownerId: number
  window: BrowserWindow
  view: WebContentsView
  state: WorkspaceBrowserState
  automationNodes: Map<number, { role: string; disabled: boolean }>
  debuggerAttached: boolean
}

type BrowserSender = (ownerId: number, payload: WorkspaceBrowserState) => void

const BROWSER_PARTITION = "persist:bento-workspace-browser"

function rectangle(bounds: WorkspaceBounds): Rectangle {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    throw new Error("浏览器区域无效")
  }
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

export class WorkspaceBrowserManager {
  private readonly browsers = new Map<string, BrowserRecord>()

  constructor(private readonly send: BrowserSender) {
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.on("will-download", (event) => event.preventDefault())
  }

  create(ownerId: number, window: BrowserWindow): WorkspaceBrowserState {
    const id = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    const state: WorkspaceBrowserState = {
      id,
      url: "",
      title: "新标签页",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }
    const record: BrowserRecord = {
      ownerId,
      window,
      view,
      state,
      automationNodes: new Map(),
      debuggerAttached: false,
    }
    this.browsers.set(id, record)
    window.contentView.addChildView(view)
    view.setVisible(false)

    const contents = view.webContents
    contents.setWindowOpenHandler(({ url }) => {
      try {
        void contents.loadURL(normalizeWorkspaceBrowserUrl(url))
      } catch {
        // 非 HTTP(S) 新窗口请求直接拒绝
      }
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      try {
        normalizeWorkspaceBrowserUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    contents.on("did-start-loading", () => {
      record.automationNodes.clear()
      this.update(record, { loading: true, error: undefined })
    })
    contents.on("did-stop-loading", () => this.update(record, { loading: false }))
    contents.on("did-navigate", (_event, url) => this.updateNavigation(record, url))
    contents.on("did-navigate-in-page", (_event, url) => this.updateNavigation(record, url))
    contents.on("page-title-updated", (_event, title) => this.update(record, { title: title || "新标签页" }))
    contents.on("did-fail-load", (_event, errorCode, description, url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.update(record, { loading: false, url, error: description })
    })
    contents.on("render-process-gone", (_event, details) => {
      this.update(record, { loading: false, error: `页面进程已退出：${details.reason}` })
    })

    return state
  }

  list(ownerId: number): WorkspaceBrowserState[] {
    return [...this.browsers.values()]
      .filter((record) => record.ownerId === ownerId)
      .map((record) => record.state)
  }

  async navigate(ownerId: number, id: string, input: string) {
    const record = this.owned(ownerId, id)
    const url = normalizeWorkspaceBrowserUrl(input)
    this.update(record, { url, loading: true, error: undefined })
    await record.view.webContents.loadURL(url)
  }

  back(ownerId: number, id: string) {
    const history = this.owned(ownerId, id).view.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward(ownerId: number, id: string) {
    const history = this.owned(ownerId, id).view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(ownerId: number, id: string) {
    this.owned(ownerId, id).view.webContents.reload()
  }

  setBounds(ownerId: number, id: string, bounds: WorkspaceBounds | null) {
    const record = this.owned(ownerId, id)
    if (!bounds) {
      record.view.setVisible(false)
      return
    }
    record.window.contentView.addChildView(record.view)
    record.view.setBounds(rectangle(bounds))
    record.view.setVisible(true)
  }

  async openExternal(ownerId: number, id: string) {
    const url = this.owned(ownerId, id).state.url
    if (url) await shell.openExternal(normalizeWorkspaceBrowserUrl(url))
  }

  async snapshot(ownerId: number, id: string): Promise<WorkspaceBrowserSnapshot> {
    const record = this.owned(ownerId, id)
    await this.ensureDebugger(record)
    await record.view.webContents.debugger.sendCommand("Accessibility.enable")
    try {
      const result = await record.view.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes?: unknown[] }
      const nodes = simplifyWorkspaceAxNodes((result.nodes ?? []) as Parameters<typeof simplifyWorkspaceAxNodes>[0])
      record.automationNodes = new Map(nodes.map((node) => [node.nodeId, {
        role: node.role,
        disabled: node.disabled === true,
      }]))
      return {
        url: record.state.url,
        title: record.state.title,
        nodes,
      }
    } finally {
      await record.view.webContents.debugger.sendCommand("Accessibility.disable")
    }
  }

  async click(ownerId: number, id: string, nodeId: number) {
    const record = this.automationNode(ownerId, id, nodeId)
    const result = await record.view.webContents.debugger.sendCommand("DOM.getBoxModel", {
      backendNodeId: nodeId,
    }) as { model: { border: number[] } }
    const quad = result.model.border
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    await record.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    })
    await record.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    })
  }

  async fill(ownerId: number, id: string, nodeId: number, text: string) {
    const record = this.automationNode(ownerId, id, nodeId, new Set(["combobox", "searchbox", "textbox"]))
    if (text.length > 100_000) throw new Error("输入内容过长")
    const debuggerApi = record.view.webContents.debugger
    const resolved = await debuggerApi.sendCommand("DOM.resolveNode", {
      backendNodeId: nodeId,
    }) as { object: { objectId?: string } }
    const objectId = resolved.object.objectId
    if (!objectId) throw new Error("输入节点不可用")
    try {
      await debuggerApi.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (nextValue) {
          if (this.isContentEditable) this.textContent = nextValue;
          else {
            const prototype = Object.getPrototypeOf(this);
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (setter) setter.call(this, nextValue);
            else this.value = nextValue;
          }
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          this.focus();
        }`,
        arguments: [{ value: text }],
      })
    } finally {
      await debuggerApi.sendCommand("Runtime.releaseObject", { objectId })
    }
  }

  async scroll(ownerId: number, id: string, deltaY: number) {
    const record = this.owned(ownerId, id)
    await this.ensureDebugger(record)
    const bounds = record.view.getBounds()
    await record.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: bounds.width / 2,
      y: bounds.height / 2,
      deltaX: 0,
      deltaY: Math.max(-4000, Math.min(4000, deltaY)),
    })
  }

  async screenshot(ownerId: number, id: string): Promise<string> {
    const record = this.owned(ownerId, id)
    await this.ensureDebugger(record)
    const result = await record.view.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }) as { data: string }
    return result.data
  }

  destroy(ownerId: number, id: string) {
    const record = this.owned(ownerId, id)
    this.browsers.delete(id)
    if (record.debuggerAttached && record.view.webContents.debugger.isAttached()) {
      record.view.webContents.debugger.detach()
    }
    record.window.contentView.removeChildView(record.view)
    record.view.webContents.close()
  }

  disposeOwner(ownerId: number) {
    for (const [id, record] of this.browsers) {
      if (record.ownerId !== ownerId) continue
      this.browsers.delete(id)
      if (record.debuggerAttached && record.view.webContents.debugger.isAttached()) {
        record.view.webContents.debugger.detach()
      }
      record.window.contentView.removeChildView(record.view)
      record.view.webContents.close()
    }
  }

  disposeAll() {
    for (const record of this.browsers.values()) {
      if (record.debuggerAttached && record.view.webContents.debugger.isAttached()) {
        record.view.webContents.debugger.detach()
      }
      record.window.contentView.removeChildView(record.view)
      record.view.webContents.close()
    }
    this.browsers.clear()
  }

  private updateNavigation(record: BrowserRecord, url: string) {
    const history = record.view.webContents.navigationHistory
    this.update(record, {
      url,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    })
  }

  private update(record: BrowserRecord, patch: Partial<WorkspaceBrowserState>) {
    record.state = { ...record.state, ...patch }
    this.send(record.ownerId, record.state)
  }

  private async ensureDebugger(record: BrowserRecord) {
    if (record.view.webContents.debugger.isAttached()) return
    record.view.webContents.debugger.attach("1.3")
    record.debuggerAttached = true
  }

  private automationNode(
    ownerId: number,
    id: string,
    nodeId: number,
    allowedRoles?: Set<string>,
  ): BrowserRecord {
    const record = this.owned(ownerId, id)
    const node = record.automationNodes.get(nodeId)
    if (!node) throw new Error("节点不在最近一次页面快照中")
    if (node.disabled) throw new Error("节点已禁用")
    if (allowedRoles && !allowedRoles.has(node.role)) throw new Error("节点不支持输入")
    return record
  }

  private owned(ownerId: number, id: string): BrowserRecord {
    const record = this.browsers.get(id)
    if (!record || record.ownerId !== ownerId) throw new Error("浏览器标签不存在")
    return record
  }
}
