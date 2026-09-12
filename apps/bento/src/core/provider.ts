/**
 * 模型供应商目录(L1)。Harness 是执行引擎；Provider 决定鉴权/路由来源；
 * Model 是某个 Provider 在某个 Harness 下真实发现到的能力。
 */

import type { HarnessId } from "./harness"
import type { Effort } from "./types"

export type ProviderModel = {
  /** 传给上游的真实 wire model id。 */
  id: string
  name: string
  description?: string
  reasoning: boolean
  efforts?: Effort[]
  defaultEffort?: Effort
  contextWindow?: number
  /** false 时保留在管理页，但不进入运行时模型选择器。 */
  enabled?: boolean
}

export type ProviderView = {
  id: string
  /** 跨 Harness 来源归并时使用的稳定供应商身份。 */
  canonicalId?: string
  name: string
  source: "builtin" | "runtime" | "user"
  authMethod?: "none" | "apiKey" | "oauth"
  harnessIds: HarnessId[]
  connected: boolean
  /** 未发现不等于没有模型；unsupported/failed 时必须让 Harness 自己选默认。 */
  modelDiscovery: "idle" | "loading" | "ready" | "unsupported" | "failed"
  discoveryError?: string
  models: Partial<Record<HarnessId, ProviderModel[]>>
  defaultModelIds?: Partial<Record<HarnessId, string>>
}

export function providerFamilyId(canonicalId: string): string {
  if (canonicalId === "openai-api" || canonicalId === "openai-codex") return "openai"
  if (canonicalId === "anthropic-api") return "anthropic"
  if (canonicalId === "xai-api" || canonicalId === "xai-oauth") return "xai"
  return canonicalId
}

// ---------------------------------------------------------------------------
// 用户自定义供应商(v0.4,模式参考 Cindy:宿主接管凭证与路由)
// ---------------------------------------------------------------------------

/** 上游真实接受的推理 wire 协议。 */
export type WireProtocol = "anthropic-messages" | "openai-chat" | "openai-responses"

/** 用户 provider 的 id 命名空间:强制 user- 前缀,防与 RUNTIME_PROVIDER 撞键。 */
export const USER_PROVIDER_ID_RE = /^user-[a-z0-9_-]+$/

/** 单个 runtime(harness)下的自定义端点配置。 */
export type CustomRuntimeConfig = {
  /** 兼容端点 base URL(去尾斜杠后存)。 */
  baseUrl: string
  wireProtocol: WireProtocol
  /** 非标准推理端点的相对路径(以 / 开头);缺省按协议推导。 */
  requestPath?: string
  /** 列模型端点;缺省 baseUrl + /models。 */
  modelsUrl?: string
  /** 预设供应商可指定模型列表响应解析器；旧配置缺省 OpenAI list。 */
  discoveryParser?: "openai-list" | "anthropic-list" | "fireworks-list" | "ollama-tags"
  /** 推理与模型发现可使用不同鉴权头；旧配置按 wireProtocol 推导。 */
  auth?: {
    inference: { header: string; prefix?: string; fixedHeaders?: Record<string, string> }
    discovery?: { header: string; prefix?: string; fixedHeaders?: Record<string, string> }
  }
  /** 手填 + 拉取 additions-only 合并的模型清单。 */
  models: CustomModelConfig[]
}

/**
 * 单个自定义模型。reasoning 缺省 false(不猜);桥接端点(openai-chat)一律
 * false 且不做 effort 映射——上游接不接思考参数只有用户知道,选错会被上游
 * 拒绝,用户改选即可,宿主不替用户猜。
 */
export type CustomModelConfig = {
  /** 原样发上游的 wire model id。 */
  id: string
  name: string
  reasoning?: boolean
  reasoningEfforts?: Effort[]
  defaultEffort?: Effort
  contextWindow?: number
  /** false 的模型保留在供应商管理页，但不进入运行时模型选择器。 */
  enabled?: boolean
}

export type OAuthFlow = "authorization-code"

/** OAuth 公共客户端描述符。client secret 与 token 都不属于此公开配置。 */
export interface OAuthProviderDescriptor {
  flow?: OAuthFlow
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  scopes: string
  redirectPort?: number
  /** 缺省 127.0.0.1；个别官方客户端只登记 localhost。 */
  redirectHost?: "127.0.0.1" | "localhost"
  /** 缺省 /callback；个别官方客户端登记了固定回调路径。 */
  redirectPath?: `/${string}`
  extraAuthParams?: Record<string, string>
}

export type ProviderAuth =
  | { method: "none" }
  | { method: "apiKey" }
  | { method: "oauth"; oauth: OAuthProviderDescriptor }

/** 用户自定义供应商的非凭证配置(API key/OAuth token 只存 safeStorage)。 */
export type CustomProviderConfig = {
  /** v2 把预设跟随策略与用户显式禁用分开；缺省表示待迁移的旧配置。 */
  schemaVersion?: 2
  runtimePolicy?: "preset" | "custom"
  disabledHarnesses?: HarnessId[]
  /** user-<slug>;USER_PROVIDER_ID_RE 校验。 */
  id: string
  name: string
  /** 来自内置预设时记录稳定 preset id；自定义端点缺省。 */
  presetId?: string
  docsUrl?: string
  auth: ProviderAuth
  /** 按 runtime 独立配置。 */
  runtimes: Partial<Record<HarnessId, CustomRuntimeConfig>>
}

export type CustomHarnessId = HarnessId

const CUSTOM_HARNESS_ORDER: readonly CustomHarnessId[] = [
  "claude-code", "codex", "pi", "kimi", "opencode", "omp", "hermes", "trae",
]

/**
 * 把用户配置展开成标准 ProviderView(source:"user"),与内置 runtime provider
 * 同形状进 registry 统一发布。纯函数;id 合法性由存储层保证,此处信任输入。
 */
export function buildConfiguredProvider(
  config: CustomProviderConfig,
  source: "builtin" | "user",
  connected: boolean,
): ProviderView {
  const harnessIds: HarnessId[] = []
  const models: Partial<Record<HarnessId, ProviderModel[]>> = {}
  for (const harnessId of CUSTOM_HARNESS_ORDER) {
    const runtime = config.runtimes[harnessId]
    if (!runtime) continue
    harnessIds.push(harnessId)
    models[harnessId] = runtime.models.filter((model) => model.enabled !== false).map((model) => ({
      id: ["pi", "opencode", "omp"].includes(harnessId) ? `bento/${model.id}` : model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.reasoning === true && model.reasoningEfforts && model.reasoningEfforts.length > 0
        ? { efforts: model.reasoningEfforts }
        : {}),
      ...(model.reasoning === true && model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    }))
  }
  return {
    id: config.id,
    canonicalId: providerFamilyId(config.presetId ?? config.id.replace(/^user-/, "")),
    name: config.name,
    source,
    authMethod: config.auth.method,
    harnessIds,
    connected,
    modelDiscovery: "ready",
    models,
  }
}

export function buildUserProvider(config: CustomProviderConfig, connected = true): ProviderView {
  return buildConfiguredProvider(config, "user", connected)
}

export function modelsForProvider(provider: ProviderView, harnessId: HarnessId): ProviderModel[] {
  return (provider.models[harnessId] ?? []).filter((model) => model.enabled !== false)
}

/** Harness 有时把 Provider 作为 `Provider/Model` 塞进 name；紧凑触发器只显示模型段。 */
export function compactModelName(model: Pick<ProviderModel, "id" | "name">): string {
  const name = model.name.trim() || model.id
  const separator = name.lastIndexOf("/")
  return separator >= 0 && separator < name.length - 1 ? name.slice(separator + 1).trim() : name
}

function canonicalProviderKey(provider: ProviderView): string {
  if (provider.canonicalId) return provider.canonicalId
  return providerFamilyId(provider.id.replace(/^user-/, ""))
}

export type DedupeOptions = {
  /** 该 provider 的模型无条件保留并优先占位(活跃会话当前路由)。 */
  pinnedProviderId?: string
}

/**
 * 新会话按 canonical Provider + upstream model 去重,先到先得:输入顺序即
 * 优先级(pinned provider 无条件提到最前)。
 */
export function dedupeProviderModels(
  providers: ProviderView[],
  harnessId: HarnessId,
  options: DedupeOptions = {},
): ProviderView[] {
  const ordered = options.pinnedProviderId
    ? [...providers].sort((a, b) =>
        Number(b.id === options.pinnedProviderId) - Number(a.id === options.pinnedProviderId))
    : providers
  const seen = new Set<string>()
  return ordered.flatMap((provider) => {
    const canonicalProvider = canonicalProviderKey(provider)
    const models = modelsForProvider(provider, harnessId).filter((model) => {
      const key = `${canonicalProvider}\0${model.id.replace(/^bento\//, "").toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (models.length === 0) return []
    return [{ ...provider, models: { ...provider.models, [harnessId]: models } }]
  })
}

/** Runtime/CLI 来源只用于“检测本机供应商”，未导入前不进入模型选择器。 */
export function providersForModelPicker(
  providers: ProviderView[],
  harnessId?: HarnessId,
): ProviderView[] {
  const available = providers.filter((provider) => provider.source !== "runtime")
  return harnessId ? dedupeProviderModels(available, harnessId) : available
}

/** 新会话默认选择:取目录第一项;Provider 上报的 defaultModelIds 优先于目录顺序。 */
export function defaultModelSelection(
  providers: ProviderView[],
  harnessId: HarnessId,
): { providerId: string; modelId: string } | null {
  const available = providersForModelPicker(providers, harnessId)
    .filter((provider) => provider.connected && modelsForProvider(provider, harnessId).length > 0)
  const provider = available[0]
  if (!provider) return null
  const models = modelsForProvider(provider, harnessId)
  const configuredDefault = provider.defaultModelIds?.[harnessId]
  const model = models.find((item) => item.id === configuredDefault) ?? models[0]
  return model ? { providerId: provider.id, modelId: model.id } : null
}

export function findProviderModel(
  providers: ProviderView[],
  providerId: string | null | undefined,
  harnessId: HarnessId,
  modelId: string | null | undefined,
): ProviderModel | undefined {
  if (!modelId) return undefined
  if (providerId) {
    const provider = providers.find((item) => item.id === providerId)
    return provider ? modelsForProvider(provider, harnessId).find((model) => model.id === modelId) : undefined
  }
  // v0.3.1 旧会话只有 modelId；仅用于显示迁移，不把推断值持久化成用户选择。
  return providers
    .flatMap((provider) => modelsForProvider(provider, harnessId))
    .find((model) => model.id === modelId)
}
