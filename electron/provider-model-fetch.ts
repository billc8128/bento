/**
 * 列模型端点拉取(main 侧)。fetch 可注入(测试传 fake),10s 超时,
 * 错误分类(401/404/网络/解析)供表单字段级显示。
 */

import type { CustomModelConfig } from "../src/core/provider"
import type { ProviderDiscoveryParser, ProviderHeaderRule } from "../src/core/provider-preset"

export const FETCH_TIMEOUT_MS = 10_000

export type FetchModelsError =
  | { kind: "unauthorized"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "network"; message: string }
  | { kind: "parse"; message: string }

export type FetchModelsResult =
  | { ok: true; models: CustomModelConfig[] }
  | { ok: false; error: FetchModelsError }

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const defaultFetch: FetchLike = (url, init) => fetch(url, init)

/** modelsUrl 缺省推导:兼容 Base URL 通常已经包含 /v1,因此只追加 /models。 */
export function deriveModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`
}

function numberOf(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && value > 0)
}

function modelOf(item: Record<string, unknown>, id: string): CustomModelConfig {
  return {
    id,
    name: typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : id,
    ...(numberOf(item.contextWindow, item.context_length, item.contextLength, item.max_context_length)
      ? { contextWindow: numberOf(item.contextWindow, item.context_length, item.contextLength, item.max_context_length) }
      : {}),
  }
}

/** OpenAI /models 形状({data:[{id}]})与 {models:[...]} 双兼容解析。 */
export function parseModelsResponse(
  body: unknown,
  parser: ProviderDiscoveryParser = "openai-list",
): CustomModelConfig[] {
  const container = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const rawList = Array.isArray(container.data)
    ? container.data
    : Array.isArray(container.models) ? container.models : []
  const models: CustomModelConfig[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const rawId = parser === "ollama-tags"
      ? item.model ?? item.name
      : parser === "fireworks-list" ? item.name ?? item.id : item.id
    const id = typeof rawId === "string" ? rawId.trim() : ""
    if (!id) continue
    const model = modelOf(item, id)
    models.push(parser === "fireworks-list" && typeof item.displayName === "string" && item.displayName.trim()
      ? { ...model, name: item.displayName.trim() }
      : model)
  }
  return models
}

export type FetchProviderModelsOptions = {
  modelsUrl: string
  apiKey?: string
  auth?: ProviderHeaderRule
  parser?: ProviderDiscoveryParser
}

function discoveryHeaders(apiKey: string | undefined, auth: ProviderHeaderRule | undefined): Record<string, string> {
  const headers = { ...(auth?.fixedHeaders ?? {}) }
  if (apiKey && auth) headers[auth.header] = `${auth.prefix ?? ""}${apiKey}`
  return headers
}

export async function fetchProviderModels(
  modelsUrlOrOptions: string | FetchProviderModelsOptions,
  apiKey = "",
  fetchImpl: FetchLike = defaultFetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchModelsResult> {
  const options: FetchProviderModelsOptions = typeof modelsUrlOrOptions === "string"
    ? { modelsUrl: modelsUrlOrOptions, apiKey, auth: { header: "Authorization", prefix: "Bearer " } }
    : modelsUrlOrOptions
  let response: Response
  try {
    response = await fetchImpl(options.modelsUrl, {
      headers: discoveryHeaders(options.apiKey, options.auth),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { kind: "network", message } }
  }
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: { kind: "unauthorized", message: `密钥被拒绝(HTTP ${response.status})` } }
  if (response.status === 404)
    return { ok: false, error: { kind: "not-found", message: "列模型端点不存在(404),可手填模型或检查 baseUrl" } }
  if (!response.ok)
    return { ok: false, error: { kind: "network", message: `上游返回 HTTP ${response.status}` } }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: { kind: "parse", message: "响应不是合法 JSON" } }
  }
  const models = parseModelsResponse(body, options.parser)
  if (models.length === 0)
    return { ok: false, error: { kind: "parse", message: "响应里没有可用模型" } }
  return { ok: true, models }
}
