import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parse as parseToml } from "smol-toml"

import {
  canonicalProviderIdForAuth,
  providerNameForAuth,
} from "../src/data/provider-sources"
import { getProviderPreset, PROVIDER_PRESETS } from "../src/data/provider-presets"
import type { CustomModelConfig } from "../src/core/provider"
import type { LocalProviderCandidate } from "../src/core/provider-preset"

type CandidateSecret = LocalProviderCandidate & { credential?: string; models?: CustomModelConfig[] }

const HERMES_ENV_PROVIDERS: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  XAI_API_KEY: "xai",
  GEMINI_API_KEY: "google",
  GOOGLE_API_KEY: "google",
  DEEPSEEK_API_KEY: "deepseek",
  OPENROUTER_API_KEY: "openrouter",
  GROQ_API_KEY: "groq",
  MISTRAL_API_KEY: "mistral",
  CEREBRAS_API_KEY: "cerebras",
  FIREWORKS_API_KEY: "fireworks",
  TOGETHER_API_KEY: "together",
  NVIDIA_API_KEY: "nvidia",
  HF_TOKEN: "huggingface",
  DEEPINFRA_API_KEY: "deepinfra",
  NOVITA_API_KEY: "novita",
  GMI_API_KEY: "gmi",
  MINIMAX_API_KEY: "minimax",
  MINIMAX_CN_API_KEY: "minimax-cn",
  MOONSHOT_API_KEY: "moonshotai",
  KIMI_API_KEY: "kimi-coding",
  OPENCODE_ZEN_API_KEY: "opencode-zen",
  OPENCODE_GO_API_KEY: "opencode-go",
  SILICONFLOW_API_KEY: "siliconflow",
  DASHSCOPE_API_KEY: "alibaba",
  XIAOMI_API_KEY: "xiaomi",
  ZAI_API_KEY: "zai",
  UPSTAGE_API_KEY: "upstage",
  ARCEEAI_API_KEY: "arcee",
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function credentialOf(value: unknown): { kind: "apiKey" | "oauth"; value?: string } | null {
  if (typeof value === "string" && value.trim()) return { kind: "apiKey", value: value.trim() }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = String(record.type ?? "")
  const key = [record.key, record.apiKey, record.api_key].find((item) => typeof item === "string" && item.trim())
  if ((type === "api" || type === "api_key" || !type) && typeof key === "string") {
    return { kind: "apiKey", value: key.trim() }
  }
  if (type === "oauth" || typeof record.access === "string" || typeof record.access_token === "string") {
    return { kind: "oauth" }
  }
  return null
}

function ompOAuthProviders(file: string): string[] {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(file, { readOnly: true })
    return database.prepare(
      "SELECT DISTINCT provider FROM auth_credentials WHERE credential_type = 'oauth' AND disabled_cause IS NULL",
    ).all().flatMap((row) => {
      const provider = (row as { provider?: unknown }).provider
      return typeof provider === "string" && provider ? [provider] : []
    })
  } catch {
    return []
  } finally {
    database?.close()
  }
}

function hermesOAuthProviders(homeDir: string, hermesDir: string): string[] {
  const ids = new Set<string>()
  const auth = readJson(path.join(hermesDir, "auth.json"))
  const pool = auth.credential_pool
  if (pool && typeof pool === "object" && !Array.isArray(pool)) {
    for (const [providerId, entries] of Object.entries(pool as Record<string, unknown>)) {
      if (Array.isArray(entries) && entries.length > 0) ids.add(providerId)
    }
  }
  const providers = auth.providers
  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    for (const [providerId, state] of Object.entries(providers as Record<string, unknown>)) {
      if (!state || typeof state !== "object" || Array.isArray(state)) continue
      const tokens = (state as Record<string, unknown>).tokens
      if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
        const values = Object.values(tokens as Record<string, unknown>)
        if (values.some((value) => typeof value === "string" && value.length > 0)) ids.add(providerId)
      }
    }
  }
  const codexTokens = readJson(path.join(homeDir, ".codex", "auth.json")).tokens
  if (codexTokens && typeof codexTokens === "object" && !Array.isArray(codexTokens)) {
    const access = (codexTokens as Record<string, unknown>).access_token
    const refresh = (codexTokens as Record<string, unknown>).refresh_token
    if ((typeof access === "string" && access) || (typeof refresh === "string" && refresh)) {
      ids.add("openai-codex")
    }
  }
  return [...ids]
}

function parseEnv(file: string): Record<string, string> {
  try {
    return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) return []
      const index = trimmed.indexOf("=")
      if (index < 1) return []
      const key = trimmed.slice(0, index).trim()
      const value = trimmed.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2")
      return value ? [[key, value]] : []
    }))
  } catch {
    return {}
  }
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined
  try {
    return new URL(url.trim()).hostname
  } catch {
    return undefined
  }
}

/** omp models.json 的 provider id 可能是随机 UUID,用 baseUrl 主机名反查预设目录。 */
function presetIdForBaseUrl(baseUrl: unknown): string | undefined {
  const host = hostOf(baseUrl)
  if (!host) return undefined
  for (const preset of PROVIDER_PRESETS) {
    if (!preset.directConnect) continue
    for (const runtime of Object.values(preset.runtimes)) {
      if (hostOf(runtime.baseUrl) === host) return preset.id
    }
  }
  return undefined
}

export class LocalProviderScanner {
  private candidates = new Map<string, CandidateSecret>()
  private readonly homeDir: string
  private readonly env: NodeJS.ProcessEnv

  constructor(homeDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.homeDir = homeDir
    this.env = env
  }

  scan(): LocalProviderCandidate[] {
    this.candidates.clear()
    const piDir = this.env.PI_CODING_AGENT_DIR || path.join(this.homeDir, ".pi", "agent")
    const dataDir = this.env.XDG_DATA_HOME || path.join(this.homeDir, ".local", "share")
    const hermesDir = this.env.HERMES_HOME || path.join(this.homeDir, ".hermes")
    // OMP 与 Pi 共用 PI_CODING_AGENT_DIR 作运行时覆盖;扫描时它属于 Pi 或某个
    // 隔离会话目录,绝不能拿来定位 OMP 的真实数据目录。
    const ompAgentDir = this.ompAgentDir()
    this.scanAuthFile("Pi", path.join(piDir, "auth.json"))
    this.scanAuthFile("OpenCode", path.join(dataDir, "opencode", "auth.json"))
    this.scanHermesValues({ ...this.env, ...parseEnv(path.join(hermesDir, ".env")) })
    this.scanHermesOAuth(hermesDir)
    this.scanOmpModels(path.join(ompAgentDir, "models.json"))
    this.scanOmpOAuth(path.join(ompAgentDir, "agent.db"))
    this.scanKimiCode()
    const merged = this.mergeByPreset([...this.candidates.values()])
    // 合并结果写回 map:credential()/localModels()/candidate() 按合并后的 id 取。
    this.candidates.clear()
    for (const item of merged) this.candidates.set(item.id, item)
    return merged
      .map(({ credential: _credential, models: _models, ...candidate }) => candidate)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 同一 preset 在多个本机来源里出现时合并成一个候选(来源列表并列展示)。
   * 凭证优先级与 Pi 官方 Resolution Order 一致(providers.md:auth.json >
   * 环境变量 > models.json)——auth.json 是凭证库,models.json 的 apiKey 是
   * 用户侧推理配置,两者独立维护,可能漂移;选优先级高的来源,导入的 key
   * 才与本机 CLI 实际推理所用的一致。模型清单取各来源并集,按 id 去重。
   */
  private mergeByPreset(list: CandidateSecret[]): CandidateSecret[] {
    const groups = new Map<string, CandidateSecret[]>()
    for (const item of list) {
      const group = groups.get(item.presetId) ?? []
      group.push(item)
      groups.set(item.presetId, group)
    }
    return [...groups.values()].map((group) => {
      if (group.length === 1) return group[0]
      const primary = group.find((item) => item.credentialReusable && item.source !== "OMP")
        ?? group.find((item) => item.credentialReusable)
        ?? group[0]
      const seen = new Set<string>()
      const models = group.flatMap((item) => item.models ?? []).filter((model) => {
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      })
      return {
        ...primary,
        ...(models.length > 0 ? { models } : {}),
        alsoFrom: [...new Set(group.filter((item) => item !== primary).map((item) => item.source))],
      }
    })
  }

  /**
   * 各 CLI 当前配置的 provider 原始键(模型 id 的 `前缀/` 来源)。
   * 用于把 ACP 模型发现吐出的全目录噪声(CLI 认识但用户没配的供应商)滤掉。
   */
  configuredKeys(source: LocalProviderCandidate["source"]): string[] {
    const keys = new Set<string>()
    if (source === "Pi") {
      const dir = this.env.PI_CODING_AGENT_DIR || path.join(this.homeDir, ".pi", "agent")
      for (const [id, value] of Object.entries(readJson(path.join(dir, "auth.json")))) {
        if (credentialOf(value)) keys.add(id)
      }
      const providers = readJson(path.join(dir, "models.json")).providers
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
          const apiKey = value && typeof value === "object"
            ? (value as Record<string, unknown>).apiKey
            : undefined
          if (typeof apiKey === "string" && apiKey.trim()) keys.add(id)
        }
      }
    } else if (source === "OpenCode") {
      const dataDir = this.env.XDG_DATA_HOME || path.join(this.homeDir, ".local", "share")
      for (const [id, value] of Object.entries(readJson(path.join(dataDir, "opencode", "auth.json")))) {
        if (credentialOf(value)) keys.add(id)
      }
      const provider = readJson(path.join(this.homeDir, ".config", "opencode", "opencode.json")).provider
      if (provider && typeof provider === "object" && !Array.isArray(provider)) {
        for (const id of Object.keys(provider)) keys.add(id)
      }
    } else if (source === "OMP") {
      const ompAgentDir = this.ompAgentDir()
      const providers = readJson(path.join(ompAgentDir, "models.json")).providers
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
          const apiKey = value && typeof value === "object"
            ? (value as Record<string, unknown>).apiKey
            : undefined
          if (typeof apiKey === "string" && apiKey.trim()) keys.add(id)
        }
      }
      for (const id of ompOAuthProviders(path.join(ompAgentDir, "agent.db"))) keys.add(id)
    } else if (source === "Kimi Code") {
      // [models."alias"] 的 alias 前缀 = ACP 模型 id 的 `前缀/`,即真实配置的
      // provider 来源(如 kimi-code、agent-plan);OAuth 登录基线仍并入,覆盖
      // 无自定义模型时 CLI 内置 managed 目录。
      for (const prefix of this.kimiModelPrefixes()) keys.add(prefix)
      if (this.hasKimiLogin()) keys.add("kimi-code")
    } else if (source === "Hermes") {
      const hermesDir = this.env.HERMES_HOME || path.join(this.homeDir, ".hermes")
      const values = { ...this.env, ...parseEnv(path.join(hermesDir, ".env")) }
      for (const [envName, providerId] of Object.entries(HERMES_ENV_PROVIDERS)) {
        if (values[envName]) keys.add(providerId)
      }
      for (const id of hermesOAuthProviders(this.homeDir, hermesDir)) keys.add(id)
    }
    return [...keys]
  }

  isOAuthConfigured(source: LocalProviderCandidate["source"], providerId: string): boolean {
    if (source === "Pi") {
      const dir = this.env.PI_CODING_AGENT_DIR || path.join(this.homeDir, ".pi", "agent")
      return credentialOf(readJson(path.join(dir, "auth.json"))[providerId])?.kind === "oauth"
    }
    if (source === "OpenCode") {
      const dataDir = this.env.XDG_DATA_HOME || path.join(this.homeDir, ".local", "share")
      return credentialOf(readJson(path.join(dataDir, "opencode", "auth.json"))[providerId])?.kind === "oauth"
    }
    if (source === "OMP") {
      return ompOAuthProviders(path.join(this.ompAgentDir(), "agent.db")).includes(providerId)
    }
    if (source === "Hermes") {
      const hermesDir = this.env.HERMES_HOME || path.join(this.homeDir, ".hermes")
      return hermesOAuthProviders(this.homeDir, hermesDir).includes(providerId)
    }
    return source === "Kimi Code" && providerId === "kimi-code" && this.hasKimiLogin()
  }

   credential(candidateId: string): string | null {
     return this.candidates.get(candidateId)?.credential ?? null
   }

  /** 来源配置里自带的模型清单(目前只有 omp models.json),扫描结果不附带。 */
  localModels(candidateId: string): CustomModelConfig[] | null {
    return this.candidates.get(candidateId)?.models ?? null
  }

  candidate(candidateId: string): LocalProviderCandidate | undefined {
    const value = this.candidates.get(candidateId)
    if (!value) return undefined
    const { credential: _credential, models: _models, ...candidate } = value
    return candidate
  }

  /**
   * OMP 数据目录:OMP_HOME(Bento 约定)或默认 ~/.omp/agent。
   * 不读 PI_CODING_AGENT_DIR——它是 Pi 与 OMP 共用的运行时覆盖,
   * 扫描场景下指向的是 Pi 或某个隔离会话目录,不是 OMP 的真实数据目录。
   */
  private ompAgentDir(): string {
    const ompDir = this.env.OMP_HOME || path.join(this.homeDir, ".omp")
    return path.join(ompDir, "agent")
  }

  private add(
    source: LocalProviderCandidate["source"],
    sourceProviderId: string,
    auth: { kind: "apiKey" | "oauth"; value?: string },
    fallbackPresetId?: string,
    models?: CustomModelConfig[],
  ) {
    const presetId = canonicalProviderIdForAuth(sourceProviderId, auth.kind === "oauth") ?? fallbackPresetId
    const preset = presetId ? getProviderPreset(presetId) : undefined
    if (!preset) return
    const id = `${source.toLowerCase().replace(/\s+/g, "")}-${sourceProviderId}`
    this.candidates.set(id, {
      id,
      name: providerNameForAuth(sourceProviderId, auth.kind === "oauth") ?? preset.name,
      source,
      sourceProviderId,
      presetId: preset.id,
      credentialReusable: auth.kind === "apiKey" && Boolean(auth.value) && preset.directConnect,
      authKind: auth.kind,
      ...(auth.value ? { credential: auth.value } : {}),
      ...(models && models.length > 0 ? { models } : {}),
    })
  }

  private scanAuthFile(source: Extract<LocalProviderCandidate["source"], "Pi" | "OpenCode">, file: string) {
    for (const [providerId, value] of Object.entries(readJson(file))) {
      const credential = credentialOf(value)
      if (credential) this.add(source, providerId, credential)
    }
  }

  private scanHermesValues(values: Record<string, string | undefined>) {
    for (const [envName, value] of Object.entries(values)) {
      const providerId = HERMES_ENV_PROVIDERS[envName]
      if (providerId && value) this.add("Hermes", providerId, { kind: "apiKey", value })
    }
  }

  private scanHermesOAuth(hermesDir: string) {
    for (const providerId of hermesOAuthProviders(this.homeDir, hermesDir)) {
      this.add("Hermes", providerId, { kind: "oauth" })
    }
  }

  private scanOmpOAuth(file: string) {
    for (const providerId of ompOAuthProviders(file)) {
      this.add("OMP", providerId, { kind: "oauth" })
    }
  }

  /** omp 的 provider 配置在 ~/.omp/agent/models.json:providers.<id>.{baseUrl,apiKey,models,...} */
  private scanOmpModels(file: string) {
    const providers = readJson(file).providers
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return
    for (const [providerId, value] of Object.entries(providers as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : ""
      if (!apiKey) continue
      const models = Array.isArray(record.models)
        ? record.models.flatMap((item): CustomModelConfig[] => {
            if (!item || typeof item !== "object") return []
            const model = item as Record<string, unknown>
            if (typeof model.id !== "string" || !model.id.trim()) return []
            return [{
              id: model.id.trim(),
              name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id.trim(),
              ...(model.reasoning === true ? { reasoning: true } : {}),
            }]
          })
        : undefined
      this.add("OMP", providerId, { kind: "apiKey", value: apiKey }, presetIdForBaseUrl(record.baseUrl), models)
    }
  }

  /** Kimi Code CLI 的 OAuth 登录态目录;凭证不可复制,只发现登录态。 */
  private hasKimiLogin(): boolean {
    const kimiDir = this.env.KIMI_CODE_HOME || path.join(this.homeDir, ".kimi-code")
    return ["credentials", "oauth"].some((entry) => {
      try {
        const stat = fs.statSync(path.join(kimiDir, entry))
        return stat.isDirectory() ? fs.readdirSync(path.join(kimiDir, entry)).length > 0 : stat.size > 0
      } catch {
        return false
      }
    })
  }

  /**
   * Kimi config.toml 的 [models."alias"] 别名前缀集合(如 kimi-code、agent-plan)。
   * 只读模型别名结构,不读 api_key/oauth 值;文件缺失或解析失败返回空集。
   */
  private kimiModelPrefixes(): Set<string> {
    const prefixes = new Set<string>()
    const kimiDir = this.env.KIMI_CODE_HOME || path.join(this.homeDir, ".kimi-code")
    let config: Record<string, unknown>
    try {
      config = parseToml(fs.readFileSync(path.join(kimiDir, "config.toml"), "utf8")) as Record<string, unknown>
    } catch {
      return prefixes
    }
    const models = config.models
    if (!models || typeof models !== "object" || Array.isArray(models)) return prefixes
    for (const alias of Object.keys(models as Record<string, unknown>)) {
      const separator = alias.indexOf("/")
      if (separator > 0) prefixes.add(alias.slice(0, separator))
    }
    return prefixes
  }

  private scanKimiCode() {
    if (this.hasKimiLogin()) this.add("Kimi Code", "kimi-code", { kind: "oauth" })
  }
}
