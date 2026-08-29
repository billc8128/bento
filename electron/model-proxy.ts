/**
 * LocalModelProxy:127.0.0.1 loopback 反向代理。
 *
 * user provider 会话的模型流量经此路由:URL 携带一次性 session token
 * (http://127.0.0.1:<port>/s/<token>/...),代理按 token → (providerId,
 * harnessId) 映射转发到用户配置的真实上游,注入密钥并剥掉 harness 自带的
 * 鉴权/账号头(防宿主已有凭证泄漏到第三方端点)。
 *
 * 硬性要求(kimi review #3/#7):
 *   - requestTimeout: 0——agent 一个 turn 跑几十分钟,Node ≥18 默认 300s
 *     会静默掐断 SSE
 *   - 每个 handler 全路径 try/catch,单请求异常绝不冒泡到 main 事件循环
 *   - token 生命周期由 ProviderRoutingService 管理:每次 driver start(含
 *     revive 重 spawn)重签发,stopLive/removeSession 吊销;本模块只存映射
 *   - anthropic-messages 直通(字节级 pipe,SSE 延迟≈0);openai-chat 同时
 *     桥两个方向:chat-bridge 服务 claude-code 的 /messages,
 *     responses-bridge 服务 codex 的 /responses
 */

import http from "node:http"
import type { AddressInfo } from "node:net"

import { ChatToAnthropicStream, translateRequest, translateResponse } from "./chat-bridge"
import { ChatToResponsesStream, translateChatToResponses, translateResponsesRequest } from "./responses-bridge"

export type ProxyRoute = {
  providerId: string
  agent: string
  baseUrl: string
  requestPath?: string
  wireProtocol: "anthropic-messages" | "openai-chat" | "openai-responses"
  /** 路由 resolve 时读出的明文 key;只活在请求处理瞬间,不落任何日志。 */
  apiKey: string
  auth?: { header: string; prefix?: string; fixedHeaders?: Record<string, string> }
  /** OAuth 等 provider 需要的固定上游头；在剥离 inbound 后补发。 */
  headerOverrides?: Record<string, string>
}

const TOKEN_PREFIX = "/s/"

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])
/** 剥掉 harness 自带的鉴权/账号头,防宿主凭证泄漏到第三方端点。 */
const STRIP_INBOUND = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "openai-organization",
  "openai-project",
  "chatgpt-account-id",
  "anthropic-beta",
  "cookie",
])

export function buildProxyHeaders(
  incoming: http.IncomingHttpHeaders,
  apiKey: string,
  overrides: Record<string, string> = {},
  auth?: ProxyRoute["auth"],
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || STRIP_INBOUND.has(lower)) continue
    if (typeof value === "string") headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(", ")
  }
  if (auth) {
    // 鉴权值只在有 apiKey 时注入(auth:none 等场景不伪造凭证);
    // fixedHeaders 是固定上游头,无论鉴权方式如何都必须生效。
    if (apiKey) headers[auth.header] = `${auth.prefix ?? ""}${apiKey}`
    Object.assign(headers, auth.fixedHeaders)
  }
  Object.assign(headers, overrides)
  return headers
}

function routeAuth(route: ProxyRoute): ProxyRoute["auth"] {
  if (route.auth || !route.apiKey) return route.auth
  return route.wireProtocol === "anthropic-messages"
    ? { header: "x-api-key" }
    : { header: "Authorization", prefix: "Bearer " }
}

/** token → 路由 的注册表;签发/吊销归 ProviderRoutingService。 */
export class RouteRegistry {
  private readonly routes = new Map<string, ProxyRoute>()

  issue(token: string, route: ProxyRoute): void {
    this.routes.set(token, route)
  }

  revoke(token: string): void {
    this.routes.delete(token)
  }

  revokeAll(): void {
    this.routes.clear()
  }

  revokeProvider(providerId: string): void {
    for (const [token, route] of this.routes) {
      if (route.providerId === providerId) this.routes.delete(token)
    }
  }

  resolve(token: string): ProxyRoute | undefined {
    return this.routes.get(token)
  }

  updateProvider(providerId: string, patch: Partial<Pick<ProxyRoute, "apiKey" | "baseUrl">>): void {
    for (const route of this.routes.values()) {
      if (route.providerId === providerId) Object.assign(route, patch)
    }
  }

  get size(): number {
    return this.routes.size
  }
}

/** 拆 /s/<token>/<suffix>:无 suffix 时 token 到尾,无斜杠也认(健康探测)。 */
export function splitTokenPath(pathname: string): { token: string; suffix: string } | null {
  if (!pathname.startsWith(TOKEN_PREFIX)) return null
  const rest = pathname.slice(TOKEN_PREFIX.length)
  const slash = rest.indexOf("/")
  const token = slash === -1 ? rest : rest.slice(0, slash)
  const suffix = slash === -1 ? "/" : rest.slice(slash)
  if (!token) return null
  return { token, suffix }
}

/** upstream 目标:requestPath 只覆盖推理端点(带 /messages 等已知形状),其余原样拼。 */
export function upstreamUrlOf(route: ProxyRoute, suffix: string, search: string): string {
  const base = route.baseUrl.replace(/\/+$/, "")
  const inferenceLike = /\/(v1\/)?(messages|completions|responses)(\/)?$/.test(suffix)
  const path = inferenceLike && route.requestPath ? route.requestPath : suffix
  return `${base}${path}${search}`
}

export type LocalModelProxy = {
  port: number
  routes: RouteRegistry
  close(): void
}

export function startLocalModelProxy(
  routes: RouteRegistry,
  options: { onError?: (error: Error, context: string) => void } = {},
): Promise<LocalModelProxy> {
  const onError = options.onError ?? (() => {})
  const server = http.createServer((req, res) => {
    try {
      void handleRequest(req, res, routes, onError)
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)), "dispatch")
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { type: "proxy_error", message: "proxy dispatch failed" } }))
    }
  })
  // 长 turn SSE:禁用默认超时(kimi review #3:默认 300s 静默掐断长流)
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.keepAliveTimeout = 0

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, routes, close: () => server.close() })
    })
  })
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: RouteRegistry,
  onError: (error: Error, context: string) => void,
): Promise<void> {
  let route: ProxyRoute | undefined
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const split = splitTokenPath(url.pathname)
    if (!split) {
      res.writeHead(404).end()
      return
    }
    route = routes.resolve(split.token)
    if (!route) {
      // 会话关闭/token 吊销后迟到请求:上游式 401,harness 能理解
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { type: "session_expired", message: "unknown session token" } }))
      return
    }

    if (route.wireProtocol === "openai-chat" && split.suffix.includes("messages")) {
      await handleChatBridge(req, res, route)
      return
    }
    if (route.wireProtocol === "openai-chat" && split.suffix.includes("responses")) {
      await handleResponsesBridge(req, res, route)
      return
    }

    const target = upstreamUrlOf(route, split.suffix, url.search)
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req)
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: buildProxyHeaders(req.headers, route.apiKey, route.headerOverrides, routeAuth(route)),
      body,
    })

    res.writeHead(upstreamRes.status, sanitizeResponseHeaders(upstreamRes.headers))
    if (upstreamRes.body) {
      // 字节级 pipe:不解析不改写,SSE 延迟≈0
      for await (const chunk of upstreamRes.body) res.write(chunk)
    }
    res.end()
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)), `route:${route?.providerId ?? "?"}`)
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { type: "proxy_error", message: "upstream request failed" } }))
  }
}

/**
 * openai-chat 桥:anthropic /messages 请求 → openai /chat/completions,
 * 响应(SSE 流式或 JSON)反向翻译回 anthropic 语义。GET 等其它请求直通。
 */
async function handleChatBridge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: ProxyRoute,
): Promise<void> {
  const anthropicBody = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>
  const chatRequest = translateRequest(anthropicBody)
  const target = `${route.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const headers = buildProxyHeaders(req.headers, route.apiKey, route.headerOverrides, routeAuth(route))
  delete headers["content-length"] // 翻译后长度必变,fetch 按新 body 重算
  const upstreamRes = await fetch(target, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: chatRequest.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(chatRequest),
  })

  if (!upstreamRes.ok) {
    res.writeHead(upstreamRes.status, sanitizeResponseHeaders(upstreamRes.headers))
    if (upstreamRes.body) for await (const chunk of upstreamRes.body) res.write(chunk)
    res.end()
    return
  }

  if (chatRequest.stream) {
    const translator = new ChatToAnthropicStream()
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const decoder = new TextDecoder()
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        for (const event of translator.push(decoder.decode(chunk as Uint8Array))) {
          res.write(`${event}\n\n`)
        }
      }
    }
    // 上游漏发 [DONE] 的兜底:连接结束也强制收尾
    for (const event of translator.finish()) res.write(`${event}\n\n`)
    res.end()
    return
  }

  const chatResponse = await upstreamRes.json() as Record<string, unknown>
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(translateResponse(chatResponse)))
}

/**
 * openai-chat 桥(codex 方向):codex 的 responses 请求 → openai
 * /chat/completions,响应(SSE 流式或 JSON)反向翻译回 responses 语义。
 */
async function handleResponsesBridge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: ProxyRoute,
): Promise<void> {
  const responsesBody = JSON.parse((await readBody(req)).toString("utf8")) as Parameters<
    typeof translateResponsesRequest
  >[0]
  const chatRequest = translateResponsesRequest(responsesBody)
  const target = `${route.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const headers = buildProxyHeaders(req.headers, route.apiKey, route.headerOverrides, routeAuth(route))
  delete headers["content-length"] // 翻译后长度必变,fetch 按新 body 重算
  const upstreamRes = await fetch(target, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: chatRequest.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(chatRequest),
  })

  if (!upstreamRes.ok) {
    res.writeHead(upstreamRes.status, sanitizeResponseHeaders(upstreamRes.headers))
    if (upstreamRes.body) for await (const chunk of upstreamRes.body) res.write(chunk)
    res.end()
    return
  }

  if (chatRequest.stream) {
    const translator = new ChatToResponsesStream()
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const decoder = new TextDecoder()
    if (upstreamRes.body) {
      // push/finish 产出的是完整 SSE 帧(已含 \n\n),直接透写
      for await (const chunk of upstreamRes.body) {
        for (const event of translator.push(decoder.decode(chunk as Uint8Array))) {
          res.write(event)
        }
      }
    }
    for (const event of translator.finish()) res.write(event)
    res.end()
    return
  }

  const chatResponse = await upstreamRes.json() as Parameters<typeof translateChatToResponses>[0]
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(translateChatToResponses(chatResponse)))
}

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "content-length")
      return // fetch 已解压;长度交回 chunked 表达
    out[name] = value
  })
  return out
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}
