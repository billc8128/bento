/** 主进程 Provider Registry:builtin/user 连接态与模型目录的唯一事实源。 */

import os from "node:os"

import {
  buildConfiguredProvider,
  isNativeProviderId,
  modelsForProvider,
  NATIVE_MODEL_ID,
  nativeProviderId,
  providerFamilyId,
  type CustomProviderConfig,
  type ProviderView,
} from "../src/core/provider"
import { type HarnessId, type HarnessRuntimeStatus } from "../src/core/harness"
import { builtinProvidersForHarness } from "./builtin-providers"
import { discoverCodexModels } from "./drivers/codex"
import { discoverClaudeModels } from "./drivers/claude-agent-sdk"
import type { ProviderModelCache } from "./provider-model-cache"
import {
  ProviderDiscoveryService,
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
) => Promise<ProviderDiscoveryResult | null>

type RuntimeStatusReader = (harnessId: HarnessId) => Promise<HarnessRuntimeStatus>
type NativeDiscoverer = (
  harnessId: HarnessId,
  cwd: string,
) => Promise<ProviderDiscoveryResult | null>
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
 * 同一 canonical Provider 的本机发现只补目录，不改变鉴权来源。
 * 结果仍挂在 builtin/user Provider 下，因此 Bento Adapter 可直接执行；
 * 只有 native 凭证、没有 Bento 配置的 Provider 不会被合入。
 */
export function mergeDiscoveredModelsIntoConfigured(
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
        indexes.set(key, models.length)
        models.push({
          ...model,
          id: ["pi", "opencode", "omp"].includes(harnessId) ? `bento/${key}` : key,
        })
      }
    }
    return { ...provider, models: { ...provider.models, [harnessId]: models } }
  })
}

/** native 伪供应商显示名:该 harness 本机 CLI 对应的供应商;配置自由的 CLI 用中性名。 */
const NATIVE_PROVIDER_NAMES: Record<HarnessId, string> = {
  "claude-code": "Anthropic",
  codex: "OpenAI",
  kimi: "Kimi",
  pi: "本机配置",
  omp: "本机配置",
  opencode: "本机配置",
  hermes: "本机配置",
}

export class ProviderRegistry {
  private userProviders: CustomProviderConfig[] = []
  private readonly builtinCache = new Map<string, ProviderDiscoveryResult>()
  private readonly builtinAccountCache = new Map<string, ProviderDiscoveryResult>()
  private readonly nativeCache = new Map<string, ProviderDiscoveryResult>()

  constructor(
    private readonly discovery: ProviderDiscoveryService = new ProviderDiscoveryService(),
    private readonly isConnected: (config: CustomProviderConfig, harnessId: HarnessId) => boolean =
      () => false,
    private readonly discoverBuiltin: BuiltinDiscoverer = async () => null,
    private readonly runtimeStatus: RuntimeStatusReader = async (harnessId) => ({
      harnessId,
      source: "missing",
      usable: false,
      fallbackAvailable: false,
    }),
    private readonly discoverNative: NativeDiscoverer = async (harnessId, cwd) =>
      harnessId === "codex"
        ? discoverCodexModels(cwd, undefined, { runtimePreference: "local" })
        : harnessId === "claude-code"
          ? discoverClaudeModels(cwd, undefined, "local")
          : null,
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
    const runtime = await this.runtimeStatus(options.harnessId)
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
    const native = await this.nativeProvider(options, cwd, runtime, runtimeProviders)
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
        try {
          discovered = await this.discoverBuiltin(provider.id, options.harnessId, cwd) ?? undefined
          if (discovered?.models.length) {
            this.builtinCache.set(key, discovered)
            this.persistentCache?.set(persistentKey, discovered)
            if (accountCatalog) {
              this.builtinAccountCache.set(accountKey, discovered)
              this.persistentCache?.set(accountPersistentKey, discovered)
            }
          }
        } catch (error) {
          return {
            ...view,
            modelDiscovery: "failed" as const,
            discoveryError: error instanceof Error ? error.message : String(error),
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
    const configured = mergeDiscoveredModelsIntoConfigured(
      [...builtins, ...users],
      [...native, ...runtimeProviders],
      options.harnessId,
    )
    if (options.harnessId === "codex" || options.harnessId === "claude-code") {
      return [...native, ...configured]
    }

    return [
      ...native,
      ...runtimeProviders,
      ...configured,
    ]
  }

  private async nativeProvider(
    options: ListProviderOptions,
    cwd: string,
    runtime: HarnessRuntimeStatus,
    runtimeProviders: ProviderView[],
  ): Promise<ProviderView[]> {
    const nativeConfigRuntime =
      runtime.source === "local" ||
      runtime.source === "override" ||
      (options.harnessId === "pi" && runtime.source === "bundled") ||
      (["omp", "hermes"].includes(options.harnessId) && runtime.source === "managed")
    if (!nativeConfigRuntime) return []

    // Claude Code / Codex 的本机 CLI 只有一家供应商,直接发现模型清单。
    if (options.harnessId === "codex" || options.harnessId === "claude-code") {
      const key = `${options.harnessId}\0${cwd}`
      const persistentKey = `native\0${key}`
      if (options.refresh) this.nativeCache.delete(key)
      let discovered = this.nativeCache.get(key) ?? (options.refresh
        ? undefined
        : this.persistentCache?.get<ProviderDiscoveryResult>(persistentKey))
      if (discovered && !this.nativeCache.has(key)) this.nativeCache.set(key, discovered)
      let discoveryState: ProviderView["modelDiscovery"] = discovered ? "ready" : "unsupported"
      let discoveryError: string | undefined
      if (!discovered && options.discover) {
        try {
          discovered = await this.discoverNative(options.harnessId, cwd) ?? undefined
          if (discovered) {
            this.nativeCache.set(key, discovered)
            this.persistentCache?.set(persistentKey, discovered)
            discoveryState = "ready"
          }
        } catch (error) {
          discoveryState = "failed"
          discoveryError = error instanceof Error ? error.message : String(error)
        }
      } else if (!discovered) {
        discoveryState = "idle"
      }
      const discoveredModels = discovered?.models ?? []
      const currentModelId = discovered?.currentModelId
      const currentIsListed = Boolean(
        currentModelId && discoveredModels.some((model) => model.id === currentModelId),
      )
      const models = discoveredModels.filter((model) => model.id !== NATIVE_MODEL_ID)
      const defaultModelId = currentIsListed ? currentModelId! : models[0]?.id
      return [{
        id: nativeProviderId(options.harnessId),
        canonicalId: options.harnessId === "codex" ? "openai" : "anthropic",
        name: NATIVE_PROVIDER_NAMES[options.harnessId],
        source: "native",
        authMethod: "native",
        harnessIds: [options.harnessId],
        connected: true,
        modelDiscovery: discoveryState,
        ...(discoveryError ? { discoveryError } : {}),
        models: {
          [options.harnessId]: models.map((model) => ({
            ...model,
            enabled: this.modelEnabled(nativeProviderId(options.harnessId), model.id),
          })),
        },
        ...(defaultModelId ? { defaultModelIds: { [options.harnessId]: defaultModelId } } : {}),
      }]
    }

    // 其它 CLI(pi/omp/…)的发现结果已按真实供应商分组;逐组透传成 native 视图,
    // 保留供应商名,同一模型配在两个 plan 下会各自成行。
    const views = runtimeProviders
      .filter((provider) => (provider.models[options.harnessId] ?? []).length > 0)
      .map((provider): ProviderView => {
        const id = `native-${options.harnessId}/${provider.id}`
        const models = (provider.models[options.harnessId] ?? []).map((model) => ({
          ...model,
          enabled: this.modelEnabled(id, model.id),
        }))
        const configuredDefault = provider.defaultModelIds?.[options.harnessId]
        const defaultModelId = configuredDefault && models.some((model) => model.id === configuredDefault)
          ? configuredDefault
          : models.find((model) => model.enabled !== false)?.id
        return {
          id,
          canonicalId: provider.canonicalId ?? providerFamilyId(
            provider.id.replace(new RegExp(`^runtime-${options.harnessId}-`), ""),
          ),
          name: provider.name,
          source: "native",
          authMethod: "native",
          harnessIds: [options.harnessId],
          connected: true,
          modelDiscovery: provider.modelDiscovery,
          ...(provider.discoveryError ? { discoveryError: provider.discoveryError } : {}),
          models: { [options.harnessId]: models },
          ...(defaultModelId ? { defaultModelIds: { [options.harnessId]: defaultModelId } } : {}),
        }
      })

    return views
  }

  async resolveSelection(options: {
    harnessId: HarnessId
    cwd: string
    providerId?: string
    modelId?: string
  }): Promise<{ providerId: string; modelId: string } | null> {
    // 显式 Bento 选择已经由设置页目录确定，无需为校验它再启动一遍本机 CLI。
    // native/runtime 来源仍走下方 discovery，确保实际本机配置可执行。
    if (options.providerId && !isNativeProviderId(options.providerId)) {
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
    const exactNativeProvider = options.providerId === nativeProviderId(options.harnessId) &&
      isNativeProviderId(options.providerId)
    if (exactNativeProvider && options.modelId) {
      const runtime = await this.runtimeStatus(options.harnessId)
      if (options.modelId !== NATIVE_MODEL_ID && (runtime.usable || runtime.fallbackAvailable)) {
        return { providerId: options.providerId, modelId: options.modelId }
      }
      // 历史哨兵会话在本机 CLI 已删除时仍可交给 managed runtime 按默认模型恢复。
      if (options.modelId === NATIVE_MODEL_ID && runtime.source !== "local" && runtime.fallbackAvailable) {
        return { providerId: options.providerId, modelId: options.modelId }
      }
    }
    const providers = await this.list({
      harnessId: options.harnessId,
      cwd: options.cwd,
      discover: true,
    })
    if (exactNativeProvider && options.modelId === NATIVE_MODEL_ID) {
      const provider = providers.find((item) => item.source === "native" &&
        (item.models[options.harnessId] ?? []).some((model) => model.enabled !== false))
      const models = provider ? modelsForProvider(provider, options.harnessId) : []
      const model = models.find((item) => item.id === provider?.defaultModelIds?.[options.harnessId]) ?? models[0]
      return provider && model ? { providerId: provider.id, modelId: model.id } : null
    }
    const requestedModelId = options.modelId === NATIVE_MODEL_ID ? undefined : options.modelId
    const candidates = providers.filter((provider) => {
      if (!provider.connected) return false
      if (options.providerId && provider.id !== options.providerId) return false
      const models = provider.models[options.harnessId] ?? []
      return requestedModelId
        ? models.some((model) => model.id === requestedModelId)
        : models.length > 0
    })
    if (candidates.length !== 1) return null
    const provider = candidates[0]
    const modelId = requestedModelId ?? provider.defaultModelIds?.[options.harnessId] ??
      provider.models[options.harnessId]?.[0]?.id
    return modelId ? { providerId: provider.id, modelId } : null
  }
}
