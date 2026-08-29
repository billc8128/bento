import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  buildProxyHeaders,
  RouteRegistry,
  splitTokenPath,
  startLocalModelProxy,
  upstreamUrlOf,
  type LocalModelProxy,
  type ProxyRoute,
} from "./model-proxy"

describe("splitTokenPath / upstreamUrlOf", () => {
  it("拆 token 与 suffix;无 suffix 也认", () => {
    expect(splitTokenPath("/s/abc123/v1/messages")).toMatchObject({ token: "abc123", suffix: "/v1/messages" })
    expect(splitTokenPath("/s/abc123")).toMatchObject({ token: "abc123", suffix: "/" })
    expect(splitTokenPath("/healthz")).toBeNull()
    expect(splitTokenPath("/s/")).toBeNull()
  })
  it("推理端点用 requestPath 覆盖,其余原样拼;尾斜杠归一", () => {
    const route: ProxyRoute = {
      providerId: "user-x",
      agent: "claude-code",
      baseUrl: "https://up.example.com/",
      requestPath: "/custom/messages",
      wireProtocol: "anthropic-messages",
      apiKey: "sk",
    }
    expect(upstreamUrlOf(route, "/v1/messages", "")).toBe("https://up.example.com/custom/messages")
    expect(upstreamUrlOf(route, "/v1/models", "?limit=1")).toBe("https://up.example.com/v1/models?limit=1")
  })
})

describe("buildProxyHeaders", () => {
  it("剥 harness 鉴权/账号头与 hop-by-hop;只注入供应商声明的鉴权头", () => {
    const headers = buildProxyHeaders(
      {
        authorization: "Bearer harness-token-must-die",
        "x-api-key": "harness-key-must-die",
        "anthropic-beta": "must-die",
        "chatgpt-account-id": "must-die",
        host: "127.0.0.1:1",
        "content-type": "application/json",
        "x-custom": ["a", "b"],
      },
      "sk-user",
      { "anthropic-beta": "OAuth-2025-04-20" },
      { header: "x-api-key" },
    )
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-custom": "a, b",
      "x-api-key": "sk-user",
      "anthropic-beta": "OAuth-2025-04-20",
    })
  })
})

describe("LocalModelProxy 全链路(fake 上游)", () => {
  let proxy: LocalModelProxy
  let upstream: http.Server
  let upstreamUrl: string
  const seen: { path: string; auth: string | undefined; apiKeyHeader: string | undefined; body: string }[] = []
  const routes = new RouteRegistry()
  const errors: Error[] = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          auth: req.headers.authorization,
          apiKeyHeader: req.headers["x-api-key"] as string | undefined,
          body,
        })
        if (req.url?.includes("stream")) {
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write("data: chunk1\n\n")
          res.write("data: chunk2\n\n")
          res.end()
        } else if (req.url?.includes("boom")) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "upstream says no" }))
        } else {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, path: req.url }))
        }
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    proxy = await startLocalModelProxy(routes, { onError: (e) => errors.push(e) })
    routes.issue("tok-live", {
      agent: "claude-code",
      baseUrl: upstreamUrl,
      wireProtocol: "anthropic-messages",
      apiKey: "sk-live",
    })
  })
  afterAll(() => {
    proxy.close()
    upstream.close()
  })

  it("POST 直通:路径转发、鉴权替换、响应体原样", async () => {
    seen.length = 0
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-live/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer harness-cred",
        "anthropic-beta": "leak-me-not",
      },
      body: JSON.stringify({ model: "m1", stream: false }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, path: "/v1/messages" })
    expect(seen[0]).toMatchObject({
      auth: undefined,
      apiKeyHeader: "sk-live",
      body: JSON.stringify({ model: "m1", stream: false }),
    })
    // 泄漏检查:宿主凭证没有透传
    expect(JSON.stringify(seen[0])).not.toContain("harness")
    expect(errors).toEqual([])
  })

  it("SSE 流式:两个 event 原样到达", async () => {
    seen.length = 0
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-live/v1/stream`)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const text = await res.text()
    expect(text).toBe("data: chunk1\n\ndata: chunk2\n\n")
    expect(errors).toEqual([])
  })

  it("未知 token → 401 session_expired;非 /s/ 路径 → 404", async () => {
    const unauthorized = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-dead/v1/messages`)
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ error: { type: "session_expired" } })
    expect((await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).status).toBe(404)
  })

  it("上游 500 错误体透传,代理自身不报错", async () => {
    seen.length = 0
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-live/boom`)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: "upstream says no" })
    expect(errors).toEqual([])
  })

  it("revoke 后同 token 立即 401", async () => {
    routes.issue("tok-temp", {
      providerId: "user-x", agent: "claude-code", baseUrl: upstreamUrl,
      wireProtocol: "anthropic-messages", apiKey: "sk",
    })

    expect((await fetch(`http://127.0.0.1:${proxy.port}/s/tok-temp/v1/messages`)).status).toBe(200)
    routes.revoke("tok-temp")
    expect((await fetch(`http://127.0.0.1:${proxy.port}/s/tok-temp/v1/messages`)).status).toBe(401)
  })
})

describe("openai-chat 桥全链路(fake openai 上游)", () => {
  let proxy: LocalModelProxy
  let upstream: http.Server
  const routes = new RouteRegistry()
  const seenRequests: { path: string; body: Record<string, unknown> }[] = []

  beforeAll(async () => {
    // fake openai chat 端点:校验收到的已是 openai 形状,回 openai SSE
    upstream = http.createServer((req, res) => {
      if ((req.method ?? "GET") === "GET") {
        seenRequests.push({ path: req.url ?? "", body: {} })
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
        return
      }
      let raw = ""
      req.on("data", (chunk) => { raw += chunk })
      req.on("end", () => {
        seenRequests.push({ path: req.url ?? "", body: JSON.parse(raw) as Record<string, unknown> })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "答案" } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{\"p\":1}" } }] } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    proxy = await startLocalModelProxy(routes)
    routes.issue("tok-chat", {
      providerId: "user-ds",
      agent: "claude-code",
      baseUrl: upstreamBase,
      wireProtocol: "openai-chat",
      apiKey: "sk-ds",
    })
  })
  afterAll(() => {
    proxy.close()
    upstream.close()
  })

  it("anthropic /messages 流式请求 → openai 翻译 → anthropic 事件流返回", async () => {
    seenRequests.length = 0
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-chat/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: true,
        system: "sys",
        messages: [{ role: "user", content: "问" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")

    // 上游收到的是 openai 形状
    expect(seenRequests[0]!.path).toBe("/chat/completions")
    expect(seenRequests[0]!.body).toMatchObject({
      model: "deepseek-chat",
      stream: true,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "问" },
      ],
    })

    // harness 收到的是 anthropic 事件流:文本增量 + tool_use block + stop
    const text = await res.text()
    expect(text).toContain('"type":"text_delta","text":"答案"')
    expect(text).toContain('"type":"tool_use","id":"c1","name":"read"')
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(text).toContain('"type":"message_stop"')
  })

  it("非 messages 路径(如 /v1/models)直通不走桥", async () => {
    seenRequests.length = 0
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-chat/v1/models`)
    expect(res.status).toBe(200)
    expect(seenRequests[0]!.path).toBe("/v1/models")
  })
})

describe("openai-chat → responses 桥全链路(codex 方向,fake openai 上游)", () => {
  let proxy: LocalModelProxy
  let upstream: http.Server
  const routes = new RouteRegistry()
  const seenRequests: { path: string; body: Record<string, unknown> }[] = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (chunk) => { raw += chunk })
      req.on("end", () => {
        seenRequests.push({ path: req.url ?? "", body: JSON.parse(raw) as Record<string, unknown> })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ model: "kimi-k3", choices: [{ delta: { content: "答案" } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{\"p\":1}" } }] } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    proxy = await startLocalModelProxy(routes)
    routes.issue("tok-resp", {
      providerId: "user-kimi",
      agent: "codex",
      baseUrl: upstreamBase,
      wireProtocol: "openai-chat",
      apiKey: "sk-kimi",
    })
  })
  afterAll(() => {
    proxy.close()
    upstream.close()
  })

  it("codex /responses 流式请求 → chat 翻译 → responses 事件流返回", async () => {
    seenRequests.length = 0
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/tok-resp/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        stream: true,
        instructions: "sys",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "问" }] }],
        reasoning: { effort: "high" },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")

    // 上游收到的是 openai chat 形状
    expect(seenRequests[0]!.path).toBe("/chat/completions")
    expect(seenRequests[0]!.body).toMatchObject({
      model: "kimi-k3",
      stream: true,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "问" },
      ],
    })

    // codex 收到的是 responses 事件流
    const text = await res.text()
    expect(text).toContain("event: response.created")
    expect(text).toContain('"type":"response.output_text.delta"')
    expect(text).toContain('"delta":"答案"')
    expect(text).toContain('"type":"function_call","status":"in_progress","call_id":"c1","name":"read"')
    expect(text).toContain("event: response.completed")
    expect(text).toContain('"input_tokens":4')
  })
})
