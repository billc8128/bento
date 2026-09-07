/** 主进程 Provider Registry:builtin/user 连接态与模型目录的唯一事实源。 */

import os from "node:os"

import {
  buildConfiguredProvider,
  modelsForProvider,
  providerFamilyId,
  type CustomProviderConfig,
  type ProviderView,
} from "../src/core/provider"
import type { HarnessId } from "../src/core/harness"
import { builtinProvidersForHarness } from "./builtin-providers"
import type { ProviderModelCache } from "./provider-model-cache"
import {
  ProviderDiscoveryService,
  type BuiltinDiscoveryResult,
  type ProviderDiscoveryResult,
} from "./provider-discovery"

type ListProviderOptions = {
  harnessId: HarnessId
  cwd?: string
  discover?: boolean
  refresh?: boolean
}

type BuiltinDiscoverer = (
  providerId: string,
  harnessId: HarnessId,
  cwd: string,
) => Promise<BuiltinDiscoveryResult | null>

type ModelEnabledReader = (providerId: string, modelId: string) => boolean

function discoveredModelKey(modelId: string): string {
  const normalized = modelId.replace(/^bento\//, "")
  const separator = normalized.indexOf("/")
  return separator >= 0 ? normalized.slice(separator + 1) : normalized
}

const BENTO_PREFIXED_MODEL_HARNESSES = new Set<HarnessId>(["pi", "opencode", "omp"])

function discoveredForHarness(
  discovery: ProviderDiscoveryResult,
  harnessId: HarnessId,
): ProviderDiscoveryResult {
  const modelId = (id: string) => {
    const key = discoveredModelKey(id)
    return BENTO_PREFIXED_MODEL_HARNESSES.has(harnessId) ? `bento/${key}` : key
  }
  return {
    models: discovery.models.map((model) => ({ ...model, id: modelId(model.id) })),
    ...(discovery.currentModelId ? { currentModelId: modelId(discovery.currentModelId) } : {}),
  }
}

/**
 * 同一 canonical Provider 的本机发现只充实**已配置模型**的元数据
 * (reasoning/efforts/contextWindow)，不增补新模型——设置页开什么，
 * 选择器就有什么(开关交互才有意义)。鉴权来源不变;builtin OAuth 不借
 * 本机目录,只有本机凭证、没有 Bento 配置的 Provider 不参与。
 */
export function enrichConfiguredModelsFromDiscovery(
  configured: ProviderView[],
  discovered: ProviderView[],
  harnessId: HarnessId,
): ProviderView[] {
  const byCanonical = new Map<string, ProviderView[]>()
  for (const provider of discovered) {
    if (!provider.canonicalId) continue
    const key = providerFamilyId(provider.canonicalId)
    byCanonical.set(key, [...(byCanonical.get(key) ?? []), provider])
  }

  return configured.map((provider) => {
    // builtin OAuth 必须只认自己的隔离账户发现，不能借本机 CLI 目录补模型。
    if (provider.source === "builtin") return provider
    if (!provider.canonicalId) return provider
    const sources = byCanonical.get(providerFamilyId(provider.canonicalId)) ?? []
    if (sources.length === 0) return provider
    const models = [...(provider.models[harnessId] ?? [])]
    const indexes = new Map(models.map((model, index) => [discoveredModelKey(model.id), index]))
    for (const source of sources) {
      for (const model of modelsForProvider(source, harnessId)) {
        const key = discoveredModelKey(model.id)
        const existingIndex = indexes.get(key)
        if (existingIndex !== undefined) {
          const existing = models[existingIndex]!
          models[existingIndex] = {
            ...existing,
            reasoning: existing.reasoning || model.reasoning,
            ...(existing.efforts ? {} : model.efforts ? { efforts: model.efforts } : {}),
            ...(existing.defaultEffort ? {} : model.defaultEffort
              ? { defaultEffort: model.defaultEffort }
              : {}),
            contextWindow: Math.max(existing.contextWindow ?? 0, model.contextWindow ?? 0) || undefined,
          }
          continue
        }
        // 未配置的模型不增补:目录集合恒等于用户在设置页管理的清单。
      }
    }
    return { ...provider, models: { ...provider.models, [harnessId]: models } }
  })
}

export class ProviderRegistry {
  private userProviders: CustomProviderConfig[] = []
  private readonly builtinCache = new Map<string, ProviderDiscoveryResult>()
  private readonly builtinAccountCache = new Map<string, ProviderDiscoveryResult>()

  constructor(
    private readonly discovery: ProviderDiscoveryService = new ProviderDiscoveryService(),
    private readonly isConnected: (config: CustomProviderConfig, harnessId: HarnessId) => boolean =
      () => false,
    private readonly discoverBuiltin: BuiltinDiscoverer = async () => null,
    private readonly modelEnabled: ModelEnabledReader = () => true,
    private readonly persistentCache?: ProviderModelCache,
  ) {}

  /** CustomProviderStore 变更后同步;user provider 与 cwd 无关,不进发现缓存。 */
  setUserProviders(configs: CustomProviderConfig[]): void {
    this.userProviders = configs
  }

  private userProvidersFor(harnessId: HarnessId): ProviderView[] {
    return this.userProviders
      .filter((provider) => provider.runtimes[harnessId as keyof CustomProviderConfig["runtimes"]])
      .map((provider) => this.configuredView(provider, "user", harnessId))
  }

  private configuredView(
    config: CustomProviderConfig,
    source: "builtin" | "user",
    harnessId: HarnessId,
  ): ProviderView {
    const view = buildConfiguredProvider(config, source, this.isConnected(config, harnessId))
    const models = view.models[harnessId] ?? []
    return {
      ...view,
      harnessIds: [harnessId],
      modelDiscovery: models.length > 0 ? "ready" : "idle",
      models: {
        [harnessId]: source === "builtin"
          ? models.map((model) => ({
              ...model,
              enabled: this.modelEnabled(config.id, model.id),
            }))
          : models,
      },
    }
  }

  async list(options: ListProviderOptions): Promise<ProviderView[]> {
    const cwd = options.cwd?.trim() || os.homedir()
    const builtinConfigs = builtinProvidersForHarness(options.harnessId)
    const runtimeProviderViews = options.harnessId === "codex" || options.harnessId === "claude-code"
      ? []
      : await this.discovery.list({
          harnessId: options.harnessId,
          cwd,
          discover: options.discover,
          refresh: options.refresh,
        })
    const runtimeProviders = runtimeProviderViews.map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).map(([harnessId, models]) => [
          harnessId,
          models?.map((model) => ({
            ...model,
            enabled: this.modelEnabled(provider.id, model.id),
          })),
        ]),
      ) as ProviderView["models"],
    }))
    const builtins = await Promise.all(builtinConfigs.map(async (provider) => {
      const view = this.configuredView(provider, "builtin", options.harnessId)
      if (!view.connected) return view
      const key = `${provider.id}\0${options.harnessId}\0${cwd}`
      const persistentKey = `builtin\0${key}`
      const accountKey = provider.id
      const accountPersistentKey = `builtin-account\0${accountKey}`
      const accountCatalog = provider.auth.method === "oauth"
      let discovered = options.refresh
        ? undefined
        : this.builtinCache.get(key) ??
          (accountCatalog ? this.builtinAccountCache.get(accountKey) : undefined) ??
          (accountCatalog
            ? this.persistentCache?.get<ProviderDiscoveryResult>(accountPersistentKey)
            : undefined) ??
          this.persistentCache?.get<ProviderDiscoveryResult>(persistentKey)
      if (discovered && !this.builtinCache.has(key)) this.builtinCache.set(key, discovered)
      if (discovered && accountCatalog && !this.builtinAccountCache.has(accountKey)) {
        this.builtinAccountCache.set(accountKey, discovered)
      }
      if (options.discover && !discovered) {
        let outcome: BuiltinDiscoveryResult | null = null
        try {
          outcome = await this.discoverBuiltin(provider.id, options.harnessId, cwd)
        } catch (error) {
          outcome = { result: null, error: error instanceof Error ? error.message : String(error) }
        }
        // 发现目标执行过但失败(抛错/空目录):标 failed 并透出文案,
        // 不能静默回 idle 让设置页谎报"模型列表已是最新"。
        if (outcome?.error) {
          return {
            ...view,
            modelDiscovery: "failed" as const,
            discoveryError: outcome.error,
          }
        }
        discovered = outcome?.result ?? undefined
        if (discovered?.models.length) {
          this.builtinCache.set(key, discovered)
          this.persistentCache?.set(persistentKey, discovered)
          if (accountCatalog) {
            this.builtinAccountCache.set(accountKey, discovered)
            this.persistentCache?.set(accountPersistentKey, discovered)
          }
        }
      }
      if (!discovered?.models.length) return view
      const published = discoveredForHarness(discovered, options.harnessId)
      return {
        ...view,
        modelDiscovery: "ready" as const,
        models: {
          [options.harnessId]: published.models.map((model) => ({
            ...model,
            enabled: this.modelEnabled(provider.id, model.id),
          })),
        },
        ...(published.currentModelId
          ? { defaultModelIds: { [options.harnessId]: published.currentModelId } }
          : {}),
      }
    }))
    const users = this.userProvidersFor(options.harnessId)
    return [
      ...runtimeProviders,
      ...enrichConfiguredModelsFromDiscovery([...builtins, ...users], runtimeProviders, options.harnessId),
    ]
  }


  async resolveSelection(options: {
    harnessId: HarnessId
    cwd: string
    providerId?: string
    modelId?: string
  }): Promise<{ providerId: string; modelId: string } | null> {
    // 显式 Bento 选择已经由设置页目录确定，无需为校验它再启动一遍本机 CLI。
    // 历史 native- 前缀 id 不在 builtin/user 注册表内 → 无候选 → null(阻止恢复)。
    if (options.providerId) {
      const config = [
        ...builtinProvidersForHarness(options.harnessId),
        ...this.userProviders,
      ].find((provider) => provider.id === options.providerId)
      if (config) {
        const source: "builtin" | "user" = config.id.startsWith("user-") ? "user" : "builtin"
        let provider = this.configuredView(config, source, options.harnessId)
        if (source === "builtin") {
          const cwd = options.cwd.trim() || os.homedir()
          const key = `${config.id}\0${options.harnessId}\0${cwd}`
          const discovered = this.builtinCache.get(key) ??
            this.builtinAccountCache.get(config.id) ??
            this.persistentCache?.get<ProviderDiscoveryResult>(`builtin-account\0${config.id}`) ??
            this.persistentCache?.get<ProviderDiscoveryResult>(`builtin\0${key}`)
          if (discovered?.models.length) {
            const published = discoveredForHarness(discovered, options.harnessId)
            provider = {
              ...provider,
              models: {
                [options.harnessId]: published.models.map((model) => ({
                  ...model,
                  enabled: this.modelEnabled(config.id, model.id),
                })),
              },
              ...(published.currentModelId
                ? { defaultModelIds: { [options.harnessId]: published.currentModelId } }
                : {}),
            }
          }
        }
        if (!provider.connected) return null
        const models = provider.models[options.harnessId] ?? []
        const modelId = options.modelId ?? provider.defaultModelIds?.[options.harnessId] ?? models[0]?.id
        if (modelId && models.some((model) => model.id === modelId)) {
          return { providerId: provider.id, modelId }
        }
      }
    }
    const providers = await this.list({
      harnessId: options.harnessId,
      cwd: options.cwd,
      discover: true,
    })
    const candidates = providers.filter((provider) => {
      if (!provider.connected) return false
      if (provider.source === "runtime") return false
      if (options.providerId && provider.id !== options.providerId) return false
      const models = provider.models[options.harnessId] ?? []
      return options.modelId
        ? models.some((model) => model.id === options.modelId)
        : models.length > 0
    })
    if (candidates.length !== 1) return null
    const provider = candidates[0]
    const modelId = options.modelId ?? provider.defaultModelIds?.[options.harnessId] ??
      provider.models[options.harnessId]?.[0]?.id
    return modelId ? { providerId: provider.id, modelId } : null
  }
}
