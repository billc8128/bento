/** preload:经 contextBridge 暴露受限 API,renderer 不碰 Electron 原语。 */

import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { HarnessId } from "../src/core/harness"
import type { ApprovalDecision } from "../src/core/events"
import type { PermissionProfile } from "../src/core/permission"
import type { Effort, PromptInput, SessionScope } from "../src/core/types"
import type { BentoAppId, BentoAppView, UserAppInput } from "../src/core/apps"
import type {
  WorkspaceBounds,
  WorkspaceBrowserSnapshot,
  WorkspaceBrowserState,
  WorkspaceFileChange,
  WorkspaceTerminalExit,
} from "../src/types/workspace"

const api = {
  /** renderer 判断自己跑在桌面壳里还是纯 web(纯 web 时 window.bento 不存在) */
  desktop: true as const,

  createSession: (opts: {
    scope?: SessionScope
    harnessId: string
    cwd: string
    title?: string
    providerId: string
    modelId: string
    effort?: Effort
    permissionProfile?: PermissionProfile
  }) =>
    ipcRenderer.invoke("session:create", opts),
  prompt: (key: string, input: PromptInput) => ipcRenderer.invoke("session:prompt", key, input),
  queuePrompt: (key: string, input: PromptInput, clientMessageId: string) =>
    ipcRenderer.invoke("session:queue-prompt", key, input, clientMessageId),
  steerQueued: (key: string, clientMessageId: string) =>
    ipcRenderer.invoke("session:steer-queued", key, clientMessageId),
  cancelQueued: (key: string, clientMessageId: string) =>
    ipcRenderer.invoke("session:cancel-queued", key, clientMessageId),
  cancel: (key: string) => ipcRenderer.invoke("session:cancel", key),
  setModel: (key: string, selection: { providerId: string; modelId: string }) =>
    ipcRenderer.invoke("session:set-model", key, selection),
  setEffort: (key: string, effort: Effort) =>
    ipcRenderer.invoke("session:set-effort", key, effort),
  setPermissionProfile: (key: string, profile: PermissionProfile) =>
    ipcRenderer.invoke("session:set-permission-profile", key, profile),
  resolveApproval: (key: string, id: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke("session:resolve-approval", key, id, decision),
  listPermissionRules: () => ipcRenderer.invoke("permission-rules:list"),
  removePermissionRule: (cwd: string, harnessId: string, rule: string) =>
    ipcRenderer.invoke("permission-rules:remove", cwd, harnessId, rule),
  renameSession: (key: string, title: string) =>
    ipcRenderer.invoke("session:rename", key, title),
  closeSession: (key: string) => ipcRenderer.invoke("session:close", key),
  removeSession: (key: string) => ipcRenderer.invoke("session:remove", key),
  listSessions: () => ipcRenderer.invoke("session:list"),
  listHarnessRuntimes: () => ipcRenderer.invoke("harness-runtime:list"),
  readEvents: (key: string) => ipcRenderer.invoke("session:events", key),
  listProviders: (options: {
    harnessId: HarnessId
    cwd?: string
    discover?: boolean
    refresh?: boolean
  }) => ipcRenderer.invoke("provider:list", options),
  setProviderModelVisibility: (payload: {
    providerId: string
    updates: Array<{ modelId: string; enabled: boolean }>
  }) => ipcRenderer.invoke("provider:model-visibility", payload),
  listProviderPresets: () => ipcRenderer.invoke("provider-preset:list"),
  discoverPresetModels: (payload: { presetId: string; providerId?: string; apiKey?: string }) =>
    ipcRenderer.invoke("provider-preset:discover", payload),
  savePresetProvider: (payload: {
    presetId: string
    providerId?: string
    name?: string
    apiKey?: string
    models: unknown[]
  }) => ipcRenderer.invoke("provider-preset:save", payload),
  scanLocalProviders: () => ipcRenderer.invoke("provider-import:scan"),
  inspectLocalProvider: (candidateId: string) => ipcRenderer.invoke("provider-import:inspect", candidateId),
  importLocalProvider: (payload: { candidateId: string; models: unknown[] }) =>
    ipcRenderer.invoke("provider-import:save", payload),
  listCustomProviders: () => ipcRenderer.invoke("custom-provider:list"),
  upsertCustomProvider: (payload: {
    config: unknown
    keys?: Record<string, string>
  }) => ipcRenderer.invoke("custom-provider:upsert", payload),
  oauthLogin: (providerId: string) => ipcRenderer.invoke("provider:oauth-login", providerId),
  oauthLogout: (providerId: string) => ipcRenderer.invoke("provider:oauth-logout", providerId),
  removeCustomProvider: (providerId: string) =>
    ipcRenderer.invoke("custom-provider:remove", providerId),
  fetchProviderModels: (payload: {
    providerId?: string
    modelsUrl: string
    apiKey?: string
    agent?: string
    auth?: { header: string; prefix?: string; fixedHeaders?: Record<string, string> }
    parser?: "openai-list" | "anthropic-list" | "fireworks-list" | "ollama-tags"
  }) => ipcRenderer.invoke("custom-provider:fetch-models", payload),
  providerSessionsUsing: (providerId: string) =>
    ipcRenderer.invoke("custom-provider:sessions-using", providerId),
  listApps: () => ipcRenderer.invoke("apps:list") as Promise<BentoAppView[]>,
  setAppEnabled: (id: BentoAppId, enabled: boolean) =>
    ipcRenderer.invoke("apps:set-enabled", id, enabled),
  upsertApp: (input: UserAppInput) => ipcRenderer.invoke("apps:upsert", input),
  removeApp: (id: string) => ipcRenderer.invoke("apps:remove", id),
  onAppsChanged: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("apps:changed", handler)
    return () => ipcRenderer.removeListener("apps:changed", handler)
  },

  chooseDirectory: () => ipcRenderer.invoke("project:choose-directory"),
  /** 拖进窗口的 File → 绝对路径(Electron 32+ File.path 已移除,必须走 webUtils) */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  /** 剪贴板粘贴的 File 没有磁盘路径,把字节落盘为附件文件 */
  saveAttachmentBlob: (input: { name: string; mimeType: string; data: ArrayBuffer }) =>
    ipcRenderer.invoke("attachment:save-blob", input),
  openPath: (target: string) => ipcRenderer.invoke("shell:open-path", target),
  readFileDataUrl: (target: string) => ipcRenderer.invoke("file:read-data-url", target),
  createProject: (opts: { sourceDir: string; name: string }) =>
    ipcRenderer.invoke("project:create", opts),

  workspace: {
    terminal: {
      create: (input: { cwd: string; cols: number; rows: number }) =>
        ipcRenderer.invoke("workspace-terminal:create", input),
      write: (id: string, data: string) => ipcRenderer.send("workspace-terminal:write", id, data),
      resize: (id: string, cols: number, rows: number) =>
        ipcRenderer.send("workspace-terminal:resize", id, cols, rows),
      kill: (id: string) => ipcRenderer.invoke("workspace-terminal:kill", id),
      onData: (cb: (event: { id: string; data: string }) => void) => {
        const handler = (_event: unknown, payload: { id: string; data: string }) => cb(payload)
        ipcRenderer.on("workspace-terminal:data", handler)
        return () => ipcRenderer.removeListener("workspace-terminal:data", handler)
      },
      onExit: (cb: (event: WorkspaceTerminalExit) => void) => {
        const handler = (_event: unknown, payload: WorkspaceTerminalExit) => cb(payload)
        ipcRenderer.on("workspace-terminal:exit", handler)
        return () => ipcRenderer.removeListener("workspace-terminal:exit", handler)
      },
    },
    files: {
      list: (root: string, relativePath: string) =>
        ipcRenderer.invoke("workspace-files:list", root, relativePath),
      read: (root: string, relativePath: string) =>
        ipcRenderer.invoke("workspace-files:read", root, relativePath),
      watch: (root: string, directory: string) =>
        ipcRenderer.invoke("workspace-files:watch", root, directory),
      unwatch: (subscriptionId: string) =>
        ipcRenderer.send("workspace-files:unwatch", subscriptionId),
      onChanged: (cb: (change: WorkspaceFileChange) => void) => {
        const handler = (_event: unknown, payload: WorkspaceFileChange) => cb(payload)
        ipcRenderer.on("workspace-files:changed", handler)
        return () => ipcRenderer.removeListener("workspace-files:changed", handler)
      },
    },
    browser: {
      create: (preferredId?: string) => ipcRenderer.invoke("workspace-browser:create", preferredId),
      list: () => ipcRenderer.invoke("workspace-browser:list") as Promise<WorkspaceBrowserState[]>,
      navigate: (id: string, url: string) => ipcRenderer.invoke("workspace-browser:navigate", id, url),
      setBounds: (id: string, bounds: WorkspaceBounds | null) =>
        ipcRenderer.send("workspace-browser:bounds", id, bounds),
      back: (id: string) => ipcRenderer.send("workspace-browser:back", id),
      forward: (id: string) => ipcRenderer.send("workspace-browser:forward", id),
      reload: (id: string) => ipcRenderer.send("workspace-browser:reload", id),
      openExternal: (id: string) => ipcRenderer.invoke("workspace-browser:open-external", id),
      automation: {
        snapshot: (id: string) => ipcRenderer.invoke("workspace-browser:snapshot", id) as Promise<
          { snapshot: WorkspaceBrowserSnapshot; error?: undefined } | { snapshot?: undefined; error: string }
        >,
        click: (id: string, nodeId: number) => ipcRenderer.invoke("workspace-browser:click", id, nodeId),
        fill: (id: string, nodeId: number, text: string) =>
          ipcRenderer.invoke("workspace-browser:fill", id, nodeId, text),
        scroll: (id: string, deltaY: number) =>
          ipcRenderer.invoke("workspace-browser:scroll", id, deltaY),
        screenshot: (id: string) => ipcRenderer.invoke("workspace-browser:screenshot", id),
      },
      destroy: (id: string) => ipcRenderer.invoke("workspace-browser:destroy", id),
      onState: (cb: (state: WorkspaceBrowserState) => void) => {
        const handler = (_event: unknown, payload: WorkspaceBrowserState) => cb(payload)
        ipcRenderer.on("workspace-browser:state", handler)
        return () => ipcRenderer.removeListener("workspace-browser:state", handler)
      },
      onReveal: (cb: (id: string) => void) => {
        const handler = (_event: unknown, id: string) => cb(id)
        ipcRenderer.on("workspace-browser:reveal", handler)
        return () => ipcRenderer.removeListener("workspace-browser:reveal", handler)
      },
    },
  },

  onSessionEvent: (cb: (e: { key: string; record: unknown }) => void) => {
    const handler = (_ev: unknown, payload: { key: string; record: unknown }) => cb(payload)
    ipcRenderer.on("session:event", handler)
    return () => ipcRenderer.removeListener("session:event", handler)
  },

  /** index 变化(协作创建/重命名/删除)后触发;renderer 重拉 session:list */
  onSessionsChanged: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("sessions:changed", handler)
    return () => ipcRenderer.removeListener("sessions:changed", handler)
  },

  /** 协作 UI 命令(main → renderer),单主窗口 */
  onCollaborationUiCommand: (cb: (command: unknown) => void) => {
    const handler = (_ev: unknown, command: unknown) => cb(command)
    ipcRenderer.on("collaboration:ui-command", handler)
    return () => ipcRenderer.removeListener("collaboration:ui-command", handler)
  },

  /** renderer 把布局 presence 上报 main(脱敏,只有 sessionId) */
  reportCollaborationUiState: (presence: unknown) =>
    ipcRenderer.send("collaboration:ui-state", presence),

  /** main 侧 custom provider CRUD 后推送;renderer store 收到即作废重取 */
  onProvidersChanged: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("providers:changed", handler)
    return () => ipcRenderer.removeListener("providers:changed", handler)
  },

  /** 受管二进制下载进度(独立于会话事件流,见 main.ts 注释) */
  onBinaryProgress: (cb: (p: unknown) => void) => {
    const handler = (_ev: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on("binary:progress", handler)
    return () => ipcRenderer.removeListener("binary:progress", handler)
  },
}

contextBridge.exposeInMainWorld("bento", api)

export type BentoApi = typeof api
