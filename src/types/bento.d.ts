/** preload 暴露的桌面 API。纯 web 模式下 window.bento 不存在,一切须降级。 */

import type { LogRecord } from "@/core/replay"
import type { HarnessId, HarnessRuntimeStatus } from "@/core/harness"
import type { CustomModelConfig, CustomProviderConfig, ProviderView } from "@/core/provider"
import type { LocalProviderCandidate, ProviderPresetView } from "@/core/provider-preset"
import type { BinaryProgress } from "../../electron/binaries/progress"
import type { Effort, SessionScope } from "@/core/types"
// BinaryProgress 单源定义在 electron/binaries/progress.ts(纯类型,无 node 依赖),
// 这里 re-export 供 renderer 引用
export type { BinaryProgress }

export type LiveSessionRecord = {
  key: string
  scope: SessionScope
  harnessId: string
  cwd: string
  nativeSessionId: string
  providerId?: string
  modelId?: string
  effort?: Effort
  capabilities?: {
    modelSwitch: "none" | "new-session" | "live"
    effortSwitch: "none" | "new-session" | "live"
  }
  title: string
  createdAt: string
  updatedAt: string
  live: boolean
}

declare global {
  interface Window {
    bento?: {
      desktop: true
      createSession(opts: {
        scope?: SessionScope
        harnessId: string
        cwd: string
        title?: string
        providerId: string
        modelId: string
        effort?: Effort
      }): Promise<
        { key: string; record: LiveSessionRecord; error?: undefined } | { error: string }
      >
      prompt(key: string, text: string): Promise<{ stopReason: string } | { error: string }>
      cancel(key: string): Promise<void>
      setModel(key: string, selection: { providerId: string; modelId: string }): Promise<
        { record: LiveSessionRecord; error?: undefined } | { error: string }
      >
      setEffort(key: string, effort: Effort): Promise<
        { record: LiveSessionRecord; error?: undefined } | { error: string }
      >
      renameSession(key: string, title: string): Promise<{ record: LiveSessionRecord; error?: undefined } | { error: string }>
      closeSession(key: string): Promise<void>
      removeSession(key: string): Promise<void>
      listSessions(): Promise<LiveSessionRecord[]>
      listHarnessRuntimes(): Promise<HarnessRuntimeStatus[]>
      readEvents(key: string): Promise<LogRecord[]>
      listProviders(options: {
        harnessId: HarnessId
        cwd?: string
        discover?: boolean
        refresh?: boolean
      }): Promise<ProviderView[]>
      setProviderModelVisibility(payload: {
        providerId: string
        updates: Array<{ modelId: string; enabled: boolean }>
      }): Promise<{ ok: true } | { error: string }>
      listProviderPresets(): Promise<ProviderPresetView[]>
      discoverPresetModels(payload: { presetId: string; providerId?: string; apiKey?: string }): Promise<
        { ok: true; models: CustomModelConfig[] } |
        { ok: false; error: { kind: string; message: string } } |
        { error: string; message: string }
      >
      savePresetProvider(payload: {
        presetId: string
        providerId?: string
        name?: string
        apiKey?: string
        models: CustomModelConfig[]
      }): Promise<{ config?: CustomProviderConfig; error?: string }>
      scanLocalProviders(): Promise<LocalProviderCandidate[]>
      inspectLocalProvider(candidateId: string): Promise<
        { ok: true; models: CustomModelConfig[] } |
        { ok: false; error: { kind: string; message: string } } |
        { error: string; message: string }
      >
      importLocalProvider(payload: { candidateId: string; models: CustomModelConfig[] }): Promise<
        { config?: CustomProviderConfig; error?: string }
      >
      listCustomProviders(): Promise<(CustomProviderConfig & {
        hasCredential: boolean
        runtimes: Record<string, { hasKey: boolean }>
      })[]>
      upsertCustomProvider(payload: {
        config: CustomProviderConfig
        keys?: Record<string, string>
      }): Promise<{ config?: CustomProviderConfig; error?: string }>
      oauthLogin(providerId: string): Promise<{ ok: true } | { error: string }>
      oauthLogout(providerId: string): Promise<{ ok: true } | { error: string }>
      removeCustomProvider(providerId: string): Promise<{ error?: string }>
      fetchProviderModels(payload: {
        providerId?: string
        modelsUrl: string
        apiKey?: string
        agent?: string
        auth?: { header: string; prefix?: string; fixedHeaders?: Record<string, string> }
        parser?: "openai-list" | "anthropic-list" | "fireworks-list" | "ollama-tags"
      }): Promise<{ ok: true; models: CustomModelConfig[] } | { ok: false; error: { kind: string; message: string } } | { error: string; message: string }>
      providerSessionsUsing(providerId: string): Promise<number>
      onProvidersChanged(cb: () => void): () => void
      chooseDirectory(): Promise<{ path?: string; error?: string }>
      /** 拖入的 File → 绝对路径(拖拽建项目用) */
      pathForFile(file: File): string
      createProject(opts: { sourceDir: string; name: string }): Promise<
        { path: string; error?: undefined } | { path?: undefined; error: string }
      >
      onSessionEvent(cb: (e: { key: string; record: LogRecord }) => void): () => void
      onBinaryProgress(cb: (p: BinaryProgress) => void): () => void
    }
  }
}

export {}
