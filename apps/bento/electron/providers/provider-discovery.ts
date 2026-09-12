/** Provider 级模型发现。ACP/Pi RPC 只是传输，结果始终归属明确 provider。 */

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

import type { HarnessId } from "../../src/core/harness"
import { providerFamilyId, type ProviderModel, type ProviderView } from "../../src/core/provider"
import {
  canonicalProviderIdForAuth,
  providerNameForAuth,
} from "../../src/data/provider-sources"
import { getProviderPreset } from "../../src/data/provider-presets"
import { managedBinary, managedBinaryIfInstalled } from "../binaries/manager"
import { assertHarnessCwd, resolveHarnessRuntime } from "../runtime/harness-runtime"
import { resolvePiCommand } from "../drivers/pi"
import {
  fetchProviderModels,
  type FetchProviderModelsOptions,
} from "./provider-model-fetch"
import type { ProviderModelCache } from "./provider-model-cache"

export type ProviderDiscoveryResult = {
  models: ProviderModel[]
  currentModelId?: string
}

export type ProviderDiscoverer = (cwd: string) => Promise<ProviderDiscoveryResult>

/**
 * builtin OAuth 账户发现结果:result/error 皆空 = 非发现目标(不标 failed);
 * error 存在 = 发现执行过但失败(抛错或 OAuth 账户返回空目录),带中文文案。
 */
export type BuiltinDiscoveryResult = {
  result: ProviderDiscoveryResult | null
  error?: string
}

type RuntimeProviderDefinition = {
  id: string
  name: string
  harnessId: HarnessId
  discover?: ProviderDiscoverer
}

type AcpModelOption = { modelId?: unknown; value?: unknown; name?: unknown; description?: unknown }

export function parseAcpModelDiscovery(setup: unknown): ProviderDiscoveryResult {
  const value = (setup && typeof setup === "object" ? setup : {}) as Record<string, unknown>
  const legacy = (value.models && typeof value.models === "object"
    ? value.models
    : {}) as Record<string, unknown>
  const legacyOptions = Array.isArray(legacy.availableModels) ? legacy.availableModels : []
  const configOptions = Array.isArray(value.configOptions) ? value.configOptions : []
  const modelConfig = configOptions.find((item) => {
    const option = item as Record<string, unknown>
    return option.type === "select" && option.category === "model"
  }) as Record<string, unknown> | undefined
  const selectOptions = Array.isArray(modelConfig?.options)
    ? modelConfig.options.flatMap((item) => {
        const option = item as Record<string, unknown>
        return Array.isArray(option.options) ? option.options : [option]
      })
    : []
  const rawOptions = legacyOptions.length > 0 ? legacyOptions : selectOptions
  const models = rawOptions.flatMap((raw) => {
    const option = raw as AcpModelOption
    const id = typeof option.modelId === "string"
      ? option.modelId
      : typeof option.value === "string" ? option.value : ""
    if (!id) return []
    return [{
      id,
      name: typeof option.name === "string" ? option.name : id,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
      reasoning: true,
    }]
  })
  const currentModelId = typeof legacy.currentModelId === "string"
    ? legacy.currentModelId
    : typeof modelConfig?.currentValue === "string" ? modelConfig.currentValue : undefined
  return { models, ...(currentModelId ? { currentModelId } : {}) }
}

async function acpCommand(harnessId: Extract<HarnessId, "kimi" | "opencode" | "omp" | "hermes">) {
  return resolveHarnessRuntime(
    harnessId,
    "local",
    (cmd) => ({ cmd, args: ["acp"] }),
    async () => {
      if (harnessId !== "hermes") {
        return { cmd: await managedBinary(harnessId), args: ["acp"] }
      }
      const uvx = await managedBinaryIfInstalled("uvx")
      if (!uvx) throw new Error("Hermes 本机或已安装的 managed runtime 不可用")
      return {
        cmd: uvx,
        args: ["--offline", "--python", "3.12", "--from", "hermes-agent[acp]==0.19.0", "hermes-acp"],
      }
    },
  )
}

export async function discoverAcpProvider(
  harnessId: Extract<HarnessId, "kimi" | "opencode" | "omp" | "hermes">,
  cwd: string,
): Promise<ProviderDiscoveryResult> {
  assertHarnessCwd(cwd)
  const spec = await acpCommand(harnessId)
  const child = spawn(spec.cmd, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  const spawnFailure = Promise.withResolvers<never>()
  child.once("error", spawnFailure.reject)
  child.stderr?.resume()
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  )
  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
      sessionUpdate: async () => {},
    }),
    stream,
  )
  try {
    return await Promise.race([
      (async () => {
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        return parseAcpModelDiscovery(await connection.newSession({ cwd, mcpServers: [] }))
      })(),
      spawnFailure.promise,
    ])
  } finally {
    child.kill()
  }
}

export async function discoverPiProvider(cwd: string): Promise<ProviderDiscoveryResult> {
  assertHarnessCwd(cwd)
  const command = await resolvePiCommand("local")
  const child = spawn(command.cmd, command.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BENTO_EMBEDDED: "1" },
  })
  child.stderr?.resume()
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.type !== "response" || typeof frame.id !== "string") return
    const request = pending.get(frame.id)
    if (!request) return
    pending.delete(frame.id)
    if (frame.success === false) request.reject(new Error(String(frame.error ?? "Pi 模型发现失败")))
    else request.resolve(frame.data)
  })
  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.on("exit", () => failPending(new Error("Pi 在模型发现期间退出")))
  child.on("error", failPending)
  const request = (id: string, type: string) => {
    const deferred = Promise.withResolvers<unknown>()
    pending.set(id, deferred)
    child.stdin!.write(`${JSON.stringify({ id, type })}\n`)
    return deferred.promise
  }
  const timer = setTimeout(() => failPending(new Error("Pi 模型发现超时")), 60_000)
  try {
    const [models, state] = await Promise.all([
      request("bento-discover-models", "get_available_models"),
      request("bento-discover-state", "get_state"),
    ])
    return parsePiModelDiscovery(models, state)
  } finally {
    clearTimeout(timer)
    pending.clear()
    child.kill()
  }
}

export function parsePiModelDiscovery(value: unknown, state?: unknown): ProviderDiscoveryResult {
  const data = value as { models?: Array<Record<string, unknown>> }
  const current = (state as { model?: Record<string, unknown> } | undefined)?.model
  const currentModelId = current && typeof current.provider === "string" && typeof current.id === "string"
    ? `${current.provider}/${current.id}`
    : undefined
  return {
    models: (data.models ?? []).flatMap((model) => {
      if (typeof model.provider !== "string" || typeof model.id !== "string") return []
      return [{
        id: `${model.provider}/${model.id}`,
        name: typeof model.name === "string" ? model.name : String(model.id),
        reasoning: model.reasoning === true,
      }]
    }),
    ...(currentModelId ? { currentModelId } : {}),
  }
}

const DEFAULT_RUNTIME_PROVIDERS: RuntimeProviderDefinition[] = [
  { id: "moonshot", name: "Kimi Code", harnessId: "kimi", discover: (cwd) => discoverAcpProvider("kimi", cwd) },
  { id: "opencode-runtime", name: "OpenCode 配置", harnessId: "opencode", discover: (cwd) => discoverAcpProvider("opencode", cwd) },
  { id: "pi-runtime", name: "Pi 配置", harnessId: "pi", discover: discoverPiProvider },
  { id: "omp-runtime", name: "OMP 配置", harnessId: "omp", discover: (cwd) => discoverAcpProvider("omp", cwd) },
  { id: "hermes-runtime", name: "Hermes 配置", harnessId: "hermes", discover: (cwd) => discoverAcpProvider("hermes", cwd) },
]

export class ProviderDiscoveryService {
  private readonly cache = new Map<string, ProviderView[]>()

  constructor(
    private readonly definitions = DEFAULT_RUNTIME_PROVIDERS,
    private readonly persistentCache?: ProviderModelCache,
    /** 各 CLI 已配置 provider 键;未接线不过滤,接线后滤掉目录噪声。 */
    private readonly configuredKeys?: (harnessId: HarnessId) => string[],
    private readonly isOAuthConfigured?: (harnessId: HarnessId, providerId: string) => boolean,
  ) {}

  discoverHttpModels(options: FetchProviderModelsOptions) {
    return fetchProviderModels(options)
  }

  async list(options: {
    harnessId: HarnessId
    cwd: string
    discover?: boolean
    refresh?: boolean
  }): Promise<ProviderView[]> {
    const definition = this.definitions.find((item) => item.harnessId === options.harnessId)
    if (!definition) return []
    const key = `${definition.id}\0${options.cwd}`
    const persistentKey = `runtime\0${key}`
    const cached = this.cache.get(key) ?? this.persistentCache?.get<ProviderView[]>(persistentKey)
    if (cached && !this.cache.has(key)) this.cache.set(key, cached)
    const base: ProviderView = {
      id: definition.id,
      name: definition.name,
      source: "runtime",
      harnessIds: [definition.harnessId],
      connected: false,
      modelDiscovery: definition.discover ? "idle" : "unsupported",
      models: {},
    }
    if (!options.discover || !definition.discover) return cached ?? [base]
    if (cached?.every((provider) => provider.modelDiscovery === "ready") && !options.refresh) return cached
    try {
      const result = await definition.discover(options.cwd)
      // ACP 会把 CLI 认识的全部供应商目录吐出来;只保留用户真正配置过的前缀。
      // 无前缀的模型(CLI 当前默认/自定义)无法归因,一律保留。
      const allowed = new Set(this.configuredKeys?.(options.harnessId) ?? [])
      const filterCatalog = this.configuredKeys != null
      const groups = new Map<string, ProviderModel[]>()
      for (const model of result.models) {
        const separator = model.id.indexOf("/")
        if (filterCatalog && separator > 0 && !allowed.has(model.id.slice(0, separator))) continue
        const sourceId = separator > 0 ? model.id.slice(0, separator) : ""
        const oauth = sourceId ? this.isOAuthConfigured?.(definition.harnessId, sourceId) === true : false
        const canonicalId = sourceId ? canonicalProviderIdForAuth(sourceId, oauth) : undefined
        const groupId = canonicalId ?? definition.id
        groups.set(groupId, [...(groups.get(groupId) ?? []), model])
      }
      const discovered = [...groups.entries()].map(([groupId, models]): ProviderView => {
        const sourceId = models[0]?.id.split("/", 1)[0] ?? ""
        const oauth = sourceId ? this.isOAuthConfigured?.(definition.harnessId, sourceId) === true : false
        const preset = getProviderPreset(groupId)
        return {
          ...base,
          id: groupId === definition.id ? definition.id : `runtime-${definition.harnessId}-${groupId}`,
          canonicalId: providerFamilyId(groupId),
          name: providerNameForAuth(sourceId, oauth) ?? preset?.name ?? definition.name,
          connected: models.length > 0,
          modelDiscovery: "ready",
          models: { [definition.harnessId]: models },
          ...(result.currentModelId && models.some((model) => model.id === result.currentModelId)
            ? { defaultModelIds: { [definition.harnessId]: result.currentModelId } }
            : {}),
        }
      })
      const views = discovered.length > 0 ? discovered : [{ ...base, modelDiscovery: "ready" as const }]
      this.cache.set(key, views)
      this.persistentCache?.set(persistentKey, views)
      return views
    } catch (error) {
      const provider: ProviderView = {
        ...base,
        modelDiscovery: "failed",
        discoveryError: error instanceof Error ? error.message : String(error),
      }
      this.cache.set(key, [provider])
      return [provider]
    }
  }
}
