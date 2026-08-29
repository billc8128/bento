import type {
  CustomHarnessId,
  CustomModelConfig,
  CustomProviderConfig,
  WireProtocol,
} from "./provider"

export type ProviderSource = "pi" | "omp" | "hermes" | "cindy" | "opencode"
export type ProviderDisposition = "preset" | "alias" | "cloud" | "account" | "runtime" | "custom"
export type ProviderCategory = "api" | "plan" | "local" | "cloud" | "account" | "runtime"
export type ProviderRegion = "cn" | "global" | "any"

export type ProviderSourceEntry = {
  sourceId: string
  sources: ProviderSource[]
  canonicalId: string
  disposition: ProviderDisposition
}

export type ProviderHeaderRule = {
  header: string
  prefix?: string
  fixedHeaders?: Record<string, string>
}

export type ProviderPresetAuth =
  | { method: "none" }
  | {
      method: "apiKey"
      inference: ProviderHeaderRule
      discovery?: ProviderHeaderRule
    }
  | { method: "adapter"; adapter: string }

export type ProviderPresetRuntime = {
  baseUrl: string
  wireProtocol: WireProtocol
  requestPath?: string
}

export type ProviderDiscoveryParser =
  | "openai-list"
  | "anthropic-list"
  | "fireworks-list"
  | "ollama-tags"

export type ProviderModelDiscovery =
  | { method: "http"; url: string; parser: ProviderDiscoveryParser }
  | { method: "static"; models: CustomModelConfig[] }
  | { method: "adapter"; adapter: string }

export type ProviderPreset = {
  id: string
  name: string
  category: ProviderCategory
  region: ProviderRegion
  docsUrl: string
  credentialUrl?: string
  auth: ProviderPresetAuth
  runtimes: Partial<Record<CustomHarnessId, ProviderPresetRuntime>>
  modelDiscovery: ProviderModelDiscovery
  /** 模型列表接口不返回能力时，用预设补齐已知的推理模型。 */
  reasoningModelIds?: string[]
  sourceIds: string[]
  /** false 表示已经纳入目录，但必须通过专用 adapter/本机来源连接。 */
  directConnect: boolean
}

export function applyPresetModelMetadata(
  preset: ProviderPreset,
  model: CustomModelConfig,
): CustomModelConfig {
  return preset.reasoningModelIds?.includes(model.id)
    ? { ...model, reasoning: true }
    : model
}

export type ProviderPresetView = Omit<ProviderPreset, "auth"> & {
  authMethod: ProviderPresetAuth["method"]
}

export type LocalProviderCandidate = {
  id: string
  name: string
  source: "Pi" | "OpenCode" | "Hermes" | "OMP" | "Kimi Code"
  sourceProviderId: string
  presetId: string
  credentialReusable: boolean
  authKind: "apiKey" | "oauth"
}

export function providerPresetView(preset: ProviderPreset): ProviderPresetView {
  const { auth, ...view } = preset
  return { ...view, authMethod: auth.method }
}

export function providerConfigFromPreset(
  preset: ProviderPreset,
  models: CustomModelConfig[],
  name = preset.name,
): CustomProviderConfig {
  if (!preset.directConnect) throw new Error(`${preset.name} 需要专用接入流程`)
  const runtimes: CustomProviderConfig["runtimes"] = {}
  for (const [harnessId, runtime] of Object.entries(preset.runtimes)) {
    if (!runtime) continue
    runtimes[harnessId as CustomHarnessId] = {
      ...runtime,
      ...(preset.modelDiscovery.method === "http"
        ? {
            modelsUrl: preset.modelDiscovery.url,
            discoveryParser: preset.modelDiscovery.parser,
          }
        : {}),
      ...(preset.auth.method === "apiKey"
        ? { auth: { inference: preset.auth.inference, ...(preset.auth.discovery ? { discovery: preset.auth.discovery } : {}) } }
        : {}),
      models: models.map((model) => applyPresetModelMetadata(preset, model)),
    }
  }
  return {
    schemaVersion: 2,
    runtimePolicy: "preset",
    id: `user-${preset.id}`,
    presetId: preset.id,
    name,
    docsUrl: preset.docsUrl,
    auth: preset.auth.method === "none" ? { method: "none" } : { method: "apiKey" },
    runtimes,
  }
}
