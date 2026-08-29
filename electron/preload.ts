/** preload:经 contextBridge 暴露受限 API,renderer 不碰 Electron 原语。 */

import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { HarnessId } from "../src/core/harness"
import type { Effort, SessionScope } from "../src/core/types"

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
  }) =>
    ipcRenderer.invoke("session:create", opts),
  prompt: (key: string, text: string) => ipcRenderer.invoke("session:prompt", key, text),
  cancel: (key: string) => ipcRenderer.invoke("session:cancel", key),
  setModel: (key: string, selection: { providerId: string; modelId: string }) =>
    ipcRenderer.invoke("session:set-model", key, selection),
  setEffort: (key: string, effort: Effort) =>
    ipcRenderer.invoke("session:set-effort", key, effort),
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

  chooseDirectory: () => ipcRenderer.invoke("project:choose-directory"),
  /** 拖进窗口的 File → 绝对路径(Electron 32+ File.path 已移除,必须走 webUtils) */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  createProject: (opts: { sourceDir: string; name: string }) =>
    ipcRenderer.invoke("project:create", opts),

  onSessionEvent: (cb: (e: { key: string; record: unknown }) => void) => {
    const handler = (_ev: unknown, payload: { key: string; record: unknown }) => cb(payload)
    ipcRenderer.on("session:event", handler)
    return () => ipcRenderer.removeListener("session:event", handler)
  },

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
