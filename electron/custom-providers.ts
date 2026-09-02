/**
 * 用户自定义供应商存储(main 侧)。
 *
 * - 非凭证配置:userData/providers/custom.json,原子写(tmp + rename,同 index.json)
 * - API key:Electron safeStorage,key 名 provider_key_<id>_<agent>,per-runtime 独立
 * - OAuth token:Electron safeStorage,key 名 provider_oauth_<id>,provider 级整包加密
 * - 凭证绝不进 JSON、绝不经 IPC 回 renderer(renderer 只拿布尔状态)
 * - 变更通知:CRUD 成功后调 onChanged 回调 → main 向 renderer 广播 providers:changed
 *
 * 密钥读写经注入的 SecretStore 接口(测试传内存实现;prod 传 safeStorage 适配),
 * 本模块不 import electron,保持可单测。
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
  USER_PROVIDER_ID_RE,
  type CustomProviderConfig,
  type CustomModelConfig,
} from "../src/core/provider"
import { providerConfigFromPreset } from "../src/core/provider-preset"
import { getProviderPreset } from "../src/data/provider-presets"
import {
  LEGACY_SUBSCRIPTION_PROVIDER_IDS,
  builtinProvider,
} from "./builtin-providers"

/** 密钥存储抽象:prod = safeStorage 适配;测试 = 内存 Map。 */
export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

export type ValidationResult = { ok: true } | { ok: false; message: string }

export type OAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  /** Anthropic token 交换响应携带的推理上游；与 token 一起加密，绝不回 renderer。 */
  oauthProxyUrl?: string
  /** Codex ChatGPT 通道要求的 workspace/account id；只从 JWT 提取并随 token 加密。 */
  accountId?: string
}

const ID_MAX = 64
const NAME_MAX = 60

export function secretKeyOf(providerId: string, agent: string): string {
  return `provider_key_${providerId}_${agent}`
}

export function providerSecretKeyOf(providerId: string): string {
  return `provider_key_${providerId}`
}

export function oauthSecretKeyOf(providerId: string): string {
  return `provider_oauth_${providerId}`
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function validateCustomProvider(config: unknown): ValidationResult {
  if (!config || typeof config !== "object") return { ok: false, message: "配置必须是对象" }
  const c = config as Partial<CustomProviderConfig>
  if (typeof c.id !== "string" || !USER_PROVIDER_ID_RE.test(c.id))
    return { ok: false, message: "id 必须形如 user-<小写slug>" }
  if (c.id.length > ID_MAX) return { ok: false, message: `id 超长(>${ID_MAX})` }
  if (typeof c.name !== "string" || !c.name.trim()) return { ok: false, message: "名称不能为空" }
  if (c.name.length > NAME_MAX) return { ok: false, message: `名称超长(>${NAME_MAX})` }
  if (c.schemaVersion !== undefined && c.schemaVersion !== 2)
    return { ok: false, message: "不支持的供应商配置版本" }
  if (c.runtimePolicy !== undefined && c.runtimePolicy !== "preset" && c.runtimePolicy !== "custom")
    return { ok: false, message: "runtimePolicy 必须是 preset 或 custom" }
  if (c.disabledHarnesses !== undefined && (
    !Array.isArray(c.disabledHarnesses) ||
    c.disabledHarnesses.some((id) => !["claude-code", "codex", "pi", "kimi", "opencode", "omp", "hermes"].includes(id))
  )) return { ok: false, message: "disabledHarnesses 包含未知 Harness" }
  if (!c.auth || (c.auth.method !== "none" && c.auth.method !== "apiKey" && c.auth.method !== "oauth"))
    return { ok: false, message: "鉴权方式必须是 none、apiKey 或 oauth" }
  if (c.auth.method === "none") {
    if ("oauth" in c.auth) return { ok: false, message: "none 鉴权禁止携带 oauth 配置" }
  } else if (c.auth.method === "apiKey") {
    if ("oauth" in c.auth) return { ok: false, message: "apiKey 鉴权禁止携带 oauth 配置" }
  } else {
    const oauth = c.auth.oauth
    if (!oauth || (oauth.flow !== undefined && oauth.flow !== "authorization-code"))
      return { ok: false, message: "OAuth flow 必须是 authorization-code" }
    if (!isHttpUrl(oauth.authorizeUrl) || !isHttpUrl(oauth.tokenUrl))
      return { ok: false, message: "OAuth authorizeUrl/tokenUrl 必须是 http(s) URL" }
    if (typeof oauth.clientId !== "string" || !oauth.clientId.trim())
      return { ok: false, message: "OAuth clientId 不能为空" }
    if (typeof oauth.scopes !== "string" || !oauth.scopes.trim())
      return { ok: false, message: "OAuth scopes 不能为空" }
    if (oauth.redirectPort !== undefined &&
      (!Number.isInteger(oauth.redirectPort) || oauth.redirectPort < 1 || oauth.redirectPort > 65535))
      return { ok: false, message: "OAuth redirectPort 必须是有效端口" }
    if (oauth.redirectHost !== undefined && oauth.redirectHost !== "127.0.0.1" && oauth.redirectHost !== "localhost")
      return { ok: false, message: "OAuth redirectHost 必须是回环地址" }
    if (oauth.redirectPath !== undefined && !/^\/[A-Za-z0-9/_-]*$/.test(oauth.redirectPath))
      return { ok: false, message: "OAuth redirectPath 必须是绝对路径" }
    if (oauth.extraAuthParams !== undefined &&
      (typeof oauth.extraAuthParams !== "object" || Array.isArray(oauth.extraAuthParams) ||
        Object.values(oauth.extraAuthParams).some((value) => typeof value !== "string")))
      return { ok: false, message: "OAuth extraAuthParams 必须是字符串键值" }
  }
  if (!c.runtimes || typeof c.runtimes !== "object")
    return { ok: false, message: "至少配置一个 runtime" }
  const entries = Object.entries(c.runtimes)
  if (entries.length === 0) return { ok: false, message: "至少配置一个 runtime" }
  for (const [agent, runtime] of entries) {
    if (!["claude-code", "codex", "pi", "kimi", "opencode", "omp", "hermes"].includes(agent))
      return { ok: false, message: `不支持的 runtime: ${agent}` }
    if (!runtime || typeof runtime !== "object") return { ok: false, message: "runtime 配置无效" }
    if (typeof runtime.baseUrl !== "string" || !/^https?:\/\//.test(runtime.baseUrl.trim()))
      return { ok: false, message: `${agent}: baseUrl 必须是 http(s) URL` }
    if (
      runtime.wireProtocol !== "anthropic-messages" &&
      runtime.wireProtocol !== "openai-chat" &&
      runtime.wireProtocol !== "openai-responses"
    )
      return { ok: false, message: `${agent}: 未知协议 ${runtime.wireProtocol}` }
    if (runtime.requestPath !== undefined && !/^\//.test(runtime.requestPath))
      return { ok: false, message: `${agent}: requestPath 必须以 / 开头` }
    if (runtime.modelsUrl !== undefined && !isHttpUrl(runtime.modelsUrl))
      return { ok: false, message: `${agent}: modelsUrl 必须是 http(s) URL` }
    if (runtime.discoveryParser !== undefined && ![
      "openai-list", "anthropic-list", "fireworks-list", "ollama-tags",
    ].includes(runtime.discoveryParser))
      return { ok: false, message: `${agent}: 未知模型列表格式` }
    if (runtime.auth) {
      if (!runtime.auth.inference?.header.trim())
        return { ok: false, message: `${agent}: 鉴权 Header 不能为空` }
      for (const value of Object.values(runtime.auth.inference.fixedHeaders ?? {})) {
        if (typeof value !== "string") return { ok: false, message: `${agent}: 固定 Header 值必须是字符串` }
      }
    }
    if (!Array.isArray(runtime.models) || runtime.models.length === 0)
      return { ok: false, message: `${agent}: 模型清单不能为空` }
    const seen = new Set<string>()
    for (const model of runtime.models) {
      const m = model as Partial<CustomModelConfig>
      if (!m || typeof m.id !== "string" || !m.id.trim())
        return { ok: false, message: `${agent}: 模型 id 不能为空` }
      if (seen.has(m.id)) return { ok: false, message: `${agent}: 模型 id 重复 (${m.id})` }
      seen.add(m.id)
      if (typeof m.name !== "string" || !m.name.trim())
        return { ok: false, message: `${agent}: 模型名称不能为空 (${m.id})` }
      if (m.contextWindow !== undefined && (!Number.isFinite(m.contextWindow) || m.contextWindow <= 0))
        return { ok: false, message: `${agent}: contextWindow 必须是正数 (${m.id})` }
      if (m.enabled !== undefined && typeof m.enabled !== "boolean")
        return { ok: false, message: `${agent}: enabled 必须是布尔值 (${m.id})` }
    }
  }
  return { ok: true }
}

/** 规范化:去 baseUrl/modelsUrl 尾斜杠、trim 字符串字段(存前统一形状)。 */
export function normalizeCustomProvider(config: CustomProviderConfig): CustomProviderConfig {
  const trimSlash = (url: string) => url.trim().replace(/\/+$/, "")
  return {
    schemaVersion: 2,
    runtimePolicy: config.runtimePolicy ?? (config.presetId ? "preset" : "custom"),
    ...(config.disabledHarnesses?.length
      ? { disabledHarnesses: [...new Set(config.disabledHarnesses)] }
      : {}),
    id: config.id,
    ...(config.presetId ? { presetId: config.presetId } : {}),
    name: config.name.trim(),
    ...(config.docsUrl ? { docsUrl: config.docsUrl.trim() } : {}),
    auth: config.auth.method === "none"
      ? { method: "none" }
      : config.auth.method === "apiKey"
        ? { method: "apiKey" }
        : {
          method: "oauth",
          oauth: {
            ...(config.auth.oauth.flow ? { flow: config.auth.oauth.flow } : {}),
            authorizeUrl: config.auth.oauth.authorizeUrl.trim(),
            tokenUrl: config.auth.oauth.tokenUrl.trim(),
            clientId: config.auth.oauth.clientId.trim(),
            scopes: config.auth.oauth.scopes.trim(),
            ...(config.auth.oauth.redirectPort ? { redirectPort: config.auth.oauth.redirectPort } : {}),
            ...(config.auth.oauth.redirectHost ? { redirectHost: config.auth.oauth.redirectHost } : {}),
            ...(config.auth.oauth.redirectPath ? { redirectPath: config.auth.oauth.redirectPath } : {}),
            ...(config.auth.oauth.extraAuthParams
              ? { extraAuthParams: { ...config.auth.oauth.extraAuthParams } }
              : {}),
          },
        },
    runtimes: Object.fromEntries(
      Object.entries(config.runtimes).map(([agent, runtime]) => [
        agent,
        runtime && {
          ...runtime,
          baseUrl: trimSlash(runtime.baseUrl),
          ...(runtime.requestPath ? { requestPath: runtime.requestPath } : {}),
          ...(runtime.modelsUrl ? { modelsUrl: trimSlash(runtime.modelsUrl) } : {}),
          models: runtime.models.map((model) => ({
            ...model,
            id: model.id.trim(),
            name: model.name.trim(),
          })),
        },
      ]),
    ) as CustomProviderConfig["runtimes"],
  }
}

/**
 * additions-only 合并:已有 id(通常是手填条目)不被拉取结果覆盖或删除,
 * 新 id 追加。返回新数组;无新增时返回原引用(调用方可据此免写盘)。
 */
export function mergeDiscoveredModels(
  existing: CustomModelConfig[],
  discovered: CustomModelConfig[],
): CustomModelConfig[] {
  const known = new Set(existing.map((model) => model.id))
  const additions = discovered.filter((model) => !known.has(model.id))
  return additions.length > 0 ? [...existing, ...additions] : existing
}

/**
 * v1 → v2：能由稳定 preset id 唯一识别的旧配置补齐新增 Harness runtime。
 * 已有 runtime 始终优先，模型开关/自定义 Header/路径不会被预设覆盖。
 */
export function migrateCustomProvider(config: CustomProviderConfig): CustomProviderConfig {
  const inferredPresetId = config.presetId ?? (
    config.id.startsWith("user-") ? config.id.slice("user-".length) : undefined
  )
  const preset = inferredPresetId ? getProviderPreset(inferredPresetId) : undefined
  const followsPreset = config.runtimePolicy !== "custom" && Boolean(preset?.directConnect)

  if (!followsPreset || !preset) {
    return normalizeCustomProvider({ ...config, schemaVersion: 2, runtimePolicy: "custom" })
  }

  const models = new Map<string, CustomModelConfig>()
  for (const runtime of Object.values(config.runtimes)) {
    for (const model of runtime?.models ?? []) {
      if (!models.has(model.id)) models.set(model.id, { ...model })
    }
  }
  const presetConfig = providerConfigFromPreset(preset, [...models.values()], config.name)
  const runtimes = { ...presetConfig.runtimes, ...config.runtimes }
  for (const [harnessId, runtime] of Object.entries(runtimes)) {
    if (!runtime) continue
    runtimes[harnessId as keyof typeof runtimes] = {
      ...runtime,
      models: runtime.models,
    }
  }
  for (const harnessId of config.disabledHarnesses ?? []) delete runtimes[harnessId]

  return normalizeCustomProvider({
    ...config,
    schemaVersion: 2,
    runtimePolicy: "preset",
    presetId: preset.id,
    docsUrl: config.docsUrl ?? preset.docsUrl,
    runtimes,
  })
}

export class CustomProviderStore {
  private readonly file: string
  private readonly onChange: () => void
  private cache: CustomProviderConfig[] | null = null

  constructor(
    userDataDir: string,
    private readonly secrets: SecretStore,
    onChange: () => void = () => {},
  ) {
    const dir = path.join(userDataDir, "providers")
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, "custom.json")
    this.onChange = onChange
  }

  list(): CustomProviderConfig[] {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown
      const raw = Array.isArray(parsed) ? parsed as CustomProviderConfig[] : []
      const migrated = raw.filter((item) => validateCustomProvider(item).ok)
        .map(migrateCustomProvider)
        .filter((item) => validateCustomProvider(item).ok)
      this.cache = migrated
      if (JSON.stringify(raw) !== JSON.stringify(migrated)) this.persist(migrated)
    } catch {
      this.cache = []
    }
    return this.cache
  }

  getProviderConfig(providerId: string): CustomProviderConfig | undefined {
    return builtinProvider(providerId) ?? this.list().find((item) => item.id === providerId)
  }

  /** renderer 视图:非凭证配置 + 凭证布尔；不包含任何 secret/token。 */
  listView(): (CustomProviderConfig & {
    hasCredential: boolean
    runtimes: Record<string, { hasKey: boolean }>
  })[] {
    return this.list().map((config) => ({
      ...config,
      hasCredential: this.hasCredential(config.id),
      runtimes: Object.fromEntries(
        Object.entries(config.runtimes).map(([agent, runtime]) => [
          agent,
          { ...runtime, hasKey: this.hasKey(config.id, agent) },
        ]),
      ),
    })) as never
  }

  hasKey(providerId: string, agent: string): boolean {
    return Boolean(
      this.secrets.get(providerSecretKeyOf(providerId)) ??
      this.secrets.get(secretKeyOf(providerId, agent)),
    )
  }

  hasCredential(providerId: string, now = Date.now()): boolean {
    const config = this.getProviderConfig(providerId)
    if (!config) return false
    return Object.keys(config.runtimes).some((agent) =>
      this.hasCredentialFor(config, agent, now))
  }

  hasCredentialFor(config: CustomProviderConfig, agent: string, now = Date.now()): boolean {
    if (!config.runtimes[agent as keyof CustomProviderConfig["runtimes"]]) return false
    if (config.auth.method === "none") return true
    if (config.auth.method === "apiKey") return this.hasKey(config.id, agent)
    const tokens = this.readOAuthTokens(config.id)
    return Boolean(tokens && (tokens.expiresAt > now || tokens.refreshToken))
  }

  setKey(providerId: string, agent: string, value: string): void {
    if (agent === "*") this.secrets.set(providerSecretKeyOf(providerId), value)
    else this.secrets.set(secretKeyOf(providerId, agent), value)
  }

  /** 供路由 resolve 时读密钥(main 内部;不经 IPC)。 */
  readKey(providerId: string, agent: string): string | null {
    return this.secrets.get(providerSecretKeyOf(providerId)) ??
      this.secrets.get(secretKeyOf(providerId, agent))
  }

  writeOAuthTokens(providerId: string, tokens: OAuthTokens): void {
    this.secrets.set(oauthSecretKeyOf(providerId), JSON.stringify(tokens))
  }

  setOAuthTokens(providerId: string, tokens: OAuthTokens): void {
    this.writeOAuthTokens(providerId, tokens)
    this.onChange()
  }

  clearOAuthTokens(providerId: string): void {
    this.secrets.delete(oauthSecretKeyOf(providerId))
    this.onChange()
  }

  readOAuthTokens(providerId: string): OAuthTokens | null {
    const raw = this.secrets.get(oauthSecretKeyOf(providerId))
    if (!raw) return null
    try {
      const tokens = JSON.parse(raw) as Partial<OAuthTokens>
      if (typeof tokens.accessToken !== "string" || !tokens.accessToken ||
        typeof tokens.expiresAt !== "number") return null
      return tokens as OAuthTokens
    } catch {
      return null
    }
  }

  /** 把早期重复的 user subscription 身份与密文一次性搬到 builtin id。 */
  migrateBuiltinSubscriptions(): boolean {
    let changed = false
    for (const [legacyId, builtinId] of Object.entries(LEGACY_SUBSCRIPTION_PROVIDER_IDS)) {
      const legacyTokens = this.readOAuthTokens(legacyId)
      if (legacyTokens && !this.readOAuthTokens(builtinId)) {
        this.writeOAuthTokens(builtinId, legacyTokens)
      }
      if (legacyTokens) {
        this.secrets.delete(oauthSecretKeyOf(legacyId))
        changed = true
      }
    }
    const next = this.list().filter((item) => !(item.id in LEGACY_SUBSCRIPTION_PROVIDER_IDS))
    if (next.length !== this.list().length) {
      this.persist(next)
      changed = true
    }
    if (changed) this.onChange()
    return changed
  }

  upsert(config: CustomProviderConfig, keys?: Partial<Record<string, string>>): CustomProviderConfig {
    const check = validateCustomProvider(config)
    if (!check.ok) throw new Error(check.message)
    const normalized = normalizeCustomProvider(config)
    const next = this.list().filter((item) => item.id !== normalized.id)
    next.push(normalized)
    next.sort((a, b) => a.id.localeCompare(b.id))
    this.persist(next)
    for (const [agent, key] of Object.entries(keys ?? {})) {
      if (typeof key === "string" && key) this.setKey(normalized.id, agent, key)
    }
    this.onChange()
    return normalized
  }

  remove(providerId: string): void {
    const next = this.list().filter((item) => item.id !== providerId)
    if (next.length === this.list().length) throw new Error(`供应商不存在: ${providerId}`)
    for (const agent of ["claude-code", "codex", "pi", "kimi", "opencode", "omp", "hermes"]) {
      this.secrets.delete(secretKeyOf(providerId, agent))
    }
    this.secrets.delete(providerSecretKeyOf(providerId))
    this.secrets.delete(oauthSecretKeyOf(providerId))
    this.persist(next)
    this.onChange()
  }

  private persist(next: CustomProviderConfig[]) {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, this.file)
    this.cache = next
  }
}
