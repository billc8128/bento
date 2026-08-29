/** main 侧 OAuth authorization-code + PKCE runner。token 只作为返回值交给 safeStorage。 */

import { createHash, randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

import type { OAuthProviderDescriptor } from "../src/core/provider"
import type { OAuthTokens } from "./custom-providers"

export type OAuthErrorKind = "network" | "unauthorized" | "invalid-response" | "state" | "cancelled"
export type OAuthLoginResult = OAuthTokens | { error: { kind: OAuthErrorKind; message: string } }

type OAuthRunnerDeps = {
  fetch?: typeof fetch
  openExternal?: (url: string) => Promise<unknown>
  serverFactory?: (handler: http.RequestListener) => http.Server
  loginTimeoutMs?: number
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url")
  return { verifier, challenge: pkceChallenge(verifier) }
}

function tokenExpiry(accessToken: string, expiresIn: unknown): number {
  const seconds = Number(expiresIn)
  if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1_000
  const payload = accessToken.split(".")[1]
  if (payload) {
    try {
      const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp
      if (typeof exp === "number") return exp * 1_000
    } catch {
      // 非 JWT token；使用短保守默认值，尽快走 refresh。
    }
  }
  return Date.now() + 60 * 60 * 1_000
}

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null
  const payload = token.split(".")[1]
  if (!payload) return null
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function accountIdFromToken(payload: Record<string, unknown>): string | undefined {
  const claims = jwtClaims(payload.id_token) ?? jwtClaims(payload.access_token)
  if (!claims) return undefined
  if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id
  const auth = claims["https://api.openai.com/auth"]
  if (auth && typeof auth === "object" &&
    typeof (auth as Record<string, unknown>).chatgpt_account_id === "string") {
    return (auth as Record<string, string>).chatgpt_account_id
  }
  return undefined
}

async function exchangeToken(
  descriptor: OAuthProviderDescriptor,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthLoginResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImpl(descriptor.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: descriptor.clientId, ...params }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) {
      const detail = typeof payload?.error_description === "string"
        ? payload.error_description
        : typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`
      return {
        error: {
          kind: response.status === 400 || response.status === 401 || response.status === 403
            ? "unauthorized"
            : "network",
          message: `OAuth token 交换失败: ${detail}`,
        },
      }
    }
    const accessToken = payload?.access_token
    if (typeof accessToken !== "string" || !accessToken) {
      return { error: { kind: "invalid-response", message: "OAuth token 响应缺少 access_token" } }
    }
    const accountId = accountIdFromToken(payload)
    return {
      accessToken,
      ...(typeof payload.refresh_token === "string" && payload.refresh_token
        ? { refreshToken: payload.refresh_token }
        : {}),
      expiresAt: tokenExpiry(accessToken, payload.expires_in),
      ...(typeof payload.oauth_proxy_url === "string" && payload.oauth_proxy_url
        ? { oauthProxyUrl: payload.oauth_proxy_url }
        : {}),
      ...(accountId ? { accountId } : {}),
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError"
    return {
      error: {
        kind: "network",
        message: timedOut ? "OAuth token 交换超时" : `OAuth token 交换失败: ${String(error)}`,
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runOAuthLogin(
  descriptor: OAuthProviderDescriptor,
  deps: OAuthRunnerDeps = {},
): Promise<OAuthLoginResult> {
  const fetchImpl = deps.fetch ?? fetch
  const openExternal = deps.openExternal ?? (async (url: string) => {
    const { shell } = await import("electron")
    await shell.openExternal(url)
  })
  const serverFactory = deps.serverFactory ?? ((handler) => http.createServer(handler))
  const { verifier, challenge } = createPkce()
  const state = randomBytes(24).toString("base64url")
  const redirectHost = descriptor.redirectHost ?? "127.0.0.1"
  const redirectPath = descriptor.redirectPath ?? "/callback"

  return new Promise<OAuthLoginResult>((resolve) => {
    let settled = false
    let loginTimer: NodeJS.Timeout | undefined
    const finish = (result: OAuthLoginResult) => {
      if (settled) return
      settled = true
      if (loginTimer) clearTimeout(loginTimer)
      if (server.listening) server.close()
      resolve(result)
    }
    const server = serverFactory((request, response) => {
      void (async () => {
        const callback = new URL(request.url ?? "/", "http://127.0.0.1")
        if (callback.pathname !== redirectPath) {
          response.writeHead(404).end()
          return
        }
        if (callback.searchParams.get("state") !== state) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          response.end("OAuth state mismatch. You can close this window.")
          finish({ error: { kind: "state", message: "OAuth state 校验失败" } })
          return
        }
        const providerError = callback.searchParams.get("error")
        if (providerError) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          response.end("OAuth authorization was cancelled. You can close this window.")
          finish({ error: { kind: "cancelled", message: `OAuth 授权失败: ${providerError}` } })
          return
        }
        const code = callback.searchParams.get("code")
        if (!code) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          response.end("Missing OAuth authorization code. You can close this window.")
          finish({ error: { kind: "invalid-response", message: "OAuth 回调缺少 code" } })
          return
        }
        const address = server.address() as AddressInfo
        const redirectUri = `http://${redirectHost}:${address.port}${redirectPath}`
        const anthropic = new URL(descriptor.tokenUrl).hostname === "platform.claude.com"
        const result = await exchangeToken(descriptor, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          ...(anthropic ? { state } : {}),
        }, fetchImpl)
        response.writeHead("error" in result ? 400 : 200, { "content-type": "text/plain; charset=utf-8" })
        response.end("error" in result
          ? "OAuth login failed. Return to Bento for details."
          : "OAuth login complete. You can close this window.")
        finish(result)
      })().catch((error) => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        response.end("OAuth login failed. Return to Bento for details.")
        finish({ error: { kind: "network", message: `OAuth 回调处理失败: ${String(error)}` } })
      })
    })

    server.once("error", (error) => {
      finish({ error: { kind: "network", message: `OAuth 回环服务启动失败: ${error.message}` } })
    })
    server.listen(descriptor.redirectPort ?? 0, "127.0.0.1", () => {
      loginTimer = setTimeout(() => {
        finish({ error: { kind: "cancelled", message: "OAuth 登录等待超时" } })
      }, deps.loginTimeoutMs ?? 5 * 60_000)
      const { port } = server.address() as AddressInfo
      const redirectUri = `http://${redirectHost}:${port}${redirectPath}`
      const authorizeUrl = new URL(descriptor.authorizeUrl)
      for (const [key, value] of Object.entries(descriptor.extraAuthParams ?? {})) {
        authorizeUrl.searchParams.set(key, value)
      }
      authorizeUrl.searchParams.set("client_id", descriptor.clientId)
      authorizeUrl.searchParams.set("redirect_uri", redirectUri)
      authorizeUrl.searchParams.set("scope", descriptor.scopes)
      authorizeUrl.searchParams.set("state", state)
      authorizeUrl.searchParams.set("code_challenge", challenge)
      authorizeUrl.searchParams.set("code_challenge_method", "S256")
      authorizeUrl.searchParams.set("response_type", "code")
      void openExternal(authorizeUrl.toString()).catch((error) => {
        finish({ error: { kind: "network", message: `无法打开 OAuth 授权页: ${String(error)}` } })
      })
    })
  })
}

export async function refreshOAuthToken(
  descriptor: OAuthProviderDescriptor,
  refreshToken: string,
  deps: Pick<OAuthRunnerDeps, "fetch"> = {},
): Promise<OAuthTokens | null> {
  const anthropic = new URL(descriptor.tokenUrl).hostname === "platform.claude.com"
  const result = await exchangeToken(descriptor, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(anthropic ? { scope: descriptor.scopes } : {}),
  }, deps.fetch ?? fetch)
  if ("error" in result) return null
  return { ...result, refreshToken: result.refreshToken ?? refreshToken }
}
