import { describe, expect, it } from "vitest"

import type { CustomModelConfig } from "../src/core/provider"
import {
  deriveModelsUrl,
  fetchProviderModels,
  parseModelsResponse,
  type FetchModelsResult,
} from "./provider-model-fetch"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("deriveModelsUrl", () => {
  it("baseUrl 去尾斜杠后拼 /models，不重复添加版本段", () => {
    expect(deriveModelsUrl("https://api.x.com/v1/")).toBe("https://api.x.com/v1/models")
    expect(deriveModelsUrl("https://api.x.com")).toBe("https://api.x.com/models")
  })
})

describe("parseModelsResponse", () => {
  it("OpenAI {data:[...]} 形状;name 缺省回落 id", () => {
    const models = parseModelsResponse({
      data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner", name: "  " }],
    })
    expect(models).toEqual<CustomModelConfig[]>([
      { id: "deepseek-chat", name: "deepseek-chat" },
      { id: "deepseek-reasoner", name: "deepseek-reasoner" },
    ])
  })
  it("{models:[...]} 形状兼容;空 id 条目跳过", () => {
    expect(parseModelsResponse({ models: [{ id: "" }, { id: "m1", name: "M1" }] }).map((m) => m.id))
      .toEqual(["m1"])
  })
  it("既无 data 也无 models 返回空", () => {
    expect(parseModelsResponse({ foo: [] })).toEqual([])
    expect(parseModelsResponse("junk")).toEqual([])
  })
  it("解析 Fireworks 与 Ollama 的非 OpenAI 模型列表", () => {
    expect(parseModelsResponse({
      models: [{ name: "accounts/fireworks/models/kimi", displayName: "Kimi", contextLength: 262144 }],
    }, "fireworks-list")).toEqual([{
      id: "accounts/fireworks/models/kimi",
      name: "Kimi",
      contextWindow: 262144,
    }])
    expect(parseModelsResponse({ models: [{ model: "qwen3:8b", name: "qwen3:8b" }] }, "ollama-tags"))
      .toEqual([{ id: "qwen3:8b", name: "qwen3:8b" }])
  })
})

describe("fetchProviderModels", () => {
  it("成功:返回模型清单", async () => {
    const result = await fetchProviderModels(
      "https://api.x.com/v1/models",
      "sk",
      async () => jsonResponse(200, { data: [{ id: "m1" }] }),
    )
    expect(result).toEqual<FetchModelsResult>({ ok: true, models: [{ id: "m1", name: "m1" }] })
  })

  it("401/403 → unauthorized;404 → not-found", async () => {
    const unauthorized = await fetchProviderModels("u", "sk", async () => jsonResponse(401, {}))
    expect(unauthorized).toMatchObject({ ok: false, error: { kind: "unauthorized" } })
    const notFound = await fetchProviderModels("u", "sk", async () => jsonResponse(404, {}))
    expect(notFound).toMatchObject({ ok: false, error: { kind: "not-found" } })
  })

  it("网络异常 → network;非 JSON → parse;空清单 → parse", async () => {
    const network = await fetchProviderModels("u", "sk", async () => {
      throw new Error("connect ECONNREFUSED")
    })
    expect(network).toMatchObject({ ok: false, error: { kind: "network" } })
    const badJson = await fetchProviderModels("u", "sk", async () =>
      new Response("not json", { status: 200 }))
    expect(badJson).toMatchObject({ ok: false, error: { kind: "parse", message: "响应不是合法 JSON" } })
    const empty = await fetchProviderModels("u", "sk", async () => jsonResponse(200, { data: [] }))
    expect(empty).toMatchObject({ ok: false, error: { kind: "parse", message: "响应里没有可用模型" } })
  })

  it("按供应商配置发送独立鉴权头和固定 Header", async () => {
    let seen: Headers | undefined
    const result = await fetchProviderModels({
      modelsUrl: "https://api.anthropic.com/v1/models",
      apiKey: "sk-ant",
      auth: { header: "x-api-key", fixedHeaders: { "anthropic-version": "2023-06-01" } },
      parser: "anthropic-list",
    }, "", async (_url, init) => {
      seen = new Headers(init.headers)
      return jsonResponse(200, { data: [{ id: "claude" }] })
    })
    expect(result).toMatchObject({ ok: true })
    expect(seen?.get("x-api-key")).toBe("sk-ant")
    expect(seen?.get("anthropic-version")).toBe("2023-06-01")
    expect(seen?.get("authorization")).toBeNull()
  })
})
