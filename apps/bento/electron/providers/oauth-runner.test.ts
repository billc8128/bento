import { describe, expect, it, vi } from "vitest"

import type { OAuthProviderDescriptor } from "../../src/core/provider"
import { pkceChallenge, refreshOAuthToken, runOAuthLogin } from "./oauth-runner"

const descriptor: OAuthProviderDescriptor = {
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  clientId: "public-client",
  scopes: "openid offline_access",
  extraAuthParams: { audience: "https://api.example.com/v1" },
}

describe("OAuth PKCE", () => {
  it("匹配 RFC 7636 S256 向量", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })
})

describe("runOAuthLogin", () => {
  it("打开授权页、校验回调并以 form POST 交换 token", async () => {
    let authorizeUrl = ""
    let tokenBody = ""
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("http://127.0.0.1:")) return fetch(input, init)
      tokenBody = String(init?.body)
      const idToken = `x.${Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
      })).toString("base64url")}.x`
      return new Response(JSON.stringify({
        access_token: "access-token",
        id_token: idToken,
        refresh_token: "refresh-token",
        expires_in: 3600,
        oauth_proxy_url: "https://proxy.example.com",
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    const login = runOAuthLogin(descriptor, {
      fetch: fakeFetch,
      openExternal: async (url) => {
        authorizeUrl = url
        const auth = new URL(url)
        const callback = new URL(auth.searchParams.get("redirect_uri")!)
        callback.searchParams.set("code", "auth-code")
        callback.searchParams.set("state", auth.searchParams.get("state")!)
        await fetch(callback)
      },
    })
    await expect(login).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      oauthProxyUrl: "https://proxy.example.com",
      accountId: "account-123",
    })
    const auth = new URL(authorizeUrl)
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256")
    expect(auth.searchParams.get("audience")).toBe("https://api.example.com/v1")
    expect(tokenBody).toContain("grant_type=authorization_code")
    expect(tokenBody).toContain("code_verifier=")
  })

  it("state 不匹配时拒绝且不交换 token", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch
    const result = await runOAuthLogin(descriptor, {
      fetch: fakeFetch,
      openExternal: async (url) => {
        const callback = new URL(new URL(url).searchParams.get("redirect_uri")!)
        callback.searchParams.set("code", "auth-code")
        callback.searchParams.set("state", "wrong-state")
        await fetch(callback)
      },
    })
    expect(result).toMatchObject({ error: { kind: "state" } })
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it("用户关闭浏览器不回调时按整体超时结束", async () => {
    const result = await runOAuthLogin(descriptor, {
      openExternal: async () => {},
      loginTimeoutMs: 5,
    })
    expect(result).toMatchObject({ error: { kind: "cancelled", message: "OAuth 登录等待超时" } })
  })
})

describe("refreshOAuthToken", () => {
  it("保留未轮换的 refresh token", async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: "new-access",
      expires_in: 7200,
    }), { status: 200 })) as typeof fetch
    await expect(refreshOAuthToken(descriptor, "old-refresh", { fetch: fakeFetch }))
      .resolves.toMatchObject({ accessToken: "new-access", refreshToken: "old-refresh" })
  })
})
