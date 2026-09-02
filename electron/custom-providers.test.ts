import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig } from "../src/core/provider"
import {
  CustomProviderStore,
  migrateCustomProvider,
  mergeDiscoveredModels,
  normalizeCustomProvider,
  oauthSecretKeyOf,
  providerSecretKeyOf,
  secretKeyOf,
  validateCustomProvider,
  type SecretStore,
} from "./custom-providers"

function memorySecrets(): SecretStore & { dump: () => Map<string, string> } {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
    dump: () => map,
  }
}

const dirs: string[] = []
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-providers-"))
  dirs.push(dir)
  const secrets = memorySecrets()
  let changes = 0
  const store = new CustomProviderStore(dir, secrets, () => { changes += 1 })
  return { store, secrets, changes: () => changes, dir }
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }) })

const valid: CustomProviderConfig = {
  id: "user-deepseek",
  name: "DeepSeek",
  auth: { method: "apiKey" },
  runtimes: {
    "claude-code": {
      baseUrl: "https://api.deepseek.com/anthropic/",
      wireProtocol: "anthropic-messages",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    },
  },
}

const oauthValid: CustomProviderConfig = {
  id: "user-claude-subscription",
  name: "Claude 订阅",
  auth: {
    method: "oauth",
    oauth: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://console.anthropic.com/v1/oauth/token",
      clientId: "public-client",
      scopes: "oauth user:profile",
      redirectPort: 54545,
    },
  },
  runtimes: valid.runtimes,
}

describe("validateCustomProvider", () => {
  it("合法配置通过", () => {
    expect(validateCustomProvider(valid).ok).toBe(true)
  })
  it("拒绝撞内置命名空间的裸 id 与非法 id", () => {
    expect(validateCustomProvider({ ...valid, id: "openai" }).ok).toBe(false)
    expect(validateCustomProvider({ ...valid, id: "user-" }).ok).toBe(false)
    expect(validateCustomProvider({ ...valid, id: "user-OK" }).ok).toBe(false)
  })
  it("拒绝空模型清单、重复模型 id、非 http(s) baseUrl", () => {
    expect(validateCustomProvider({
      ...valid,
      runtimes: { "claude-code": { ...valid.runtimes["claude-code"]!, models: [] } },
    }).ok).toBe(false)
    expect(validateCustomProvider({
      ...valid,
      runtimes: {
        "claude-code": {
          ...valid.runtimes["claude-code"]!,
          models: [
            { id: "m", name: "M" },
            { id: "m", name: "M2" },
          ],
        },
      },
    }).ok).toBe(false)
    expect(validateCustomProvider({
      ...valid,
      runtimes: {
        "claude-code": { ...valid.runtimes["claude-code"]!, baseUrl: "ftp://x" },
      },
    }).ok).toBe(false)
  })
  it("拒绝未知 runtime", () => {
    expect(validateCustomProvider({
      ...valid,
      runtimes: { unknown: valid.runtimes["claude-code"]! },
    } as never).ok).toBe(false)
  })
  it("校验 OAuth descriptor,并拒绝 apiKey 混入 oauth 字段", () => {
    expect(validateCustomProvider(oauthValid).ok).toBe(true)
    expect(validateCustomProvider({
      ...oauthValid,
      auth: { method: "oauth", oauth: { ...oauthValid.auth.oauth, tokenUrl: "not-a-url" } },
    }).ok).toBe(false)
    expect(validateCustomProvider({
      ...valid,
      auth: { method: "apiKey", oauth: oauthValid.auth.oauth },
    }).ok).toBe(false)
  })
})

describe("normalizeCustomProvider", () => {
  it("baseUrl/modelsUrl 去尾斜杠、字符串字段 trim", () => {
    const normalized = normalizeCustomProvider({
      ...valid,
      runtimes: {
        "claude-code": {
          baseUrl: "https://api.deepseek.com/anthropic///",
          wireProtocol: "anthropic-messages",
          modelsUrl: "https://api.deepseek.com/v1/models/",
          models: [{ id: " deepseek-chat ", name: " DeepSeek Chat " }],
        },
      },
    })
    const runtime = normalized.runtimes["claude-code"]!
    expect(runtime.baseUrl).toBe("https://api.deepseek.com/anthropic")
    expect(runtime.modelsUrl).toBe("https://api.deepseek.com/v1/models")
    expect(runtime.models[0]).toMatchObject({ id: "deepseek-chat", name: "DeepSeek Chat" })
  })
})

describe("mergeDiscoveredModels", () => {
  it("additions-only:已有 id 不覆盖不删除,新 id 追加", () => {
    const existing = [{ id: "a", name: "手填 A" }, { id: "b", name: "手填 B" }]
    const merged = mergeDiscoveredModels(existing, [
      { id: "b", name: "拉取的同名应被忽略" },
      { id: "c", name: "新发现" },
    ])
    expect(merged.map((m) => [m.id, m.name])).toEqual([
      ["a", "手填 A"],
      ["b", "手填 B"],
      ["c", "新发现"],
    ])
  })
  it("无新增时返回原引用(免写盘)", () => {
    const existing = [{ id: "a", name: "A" }]
    expect(mergeDiscoveredModels(existing, [{ id: "a", name: "A2" }])).toBe(existing)
  })
})

describe("CustomProviderStore", () => {
  it("Kimi Code 预设迁移不再静态猜测推理能力", () => {
    const config: CustomProviderConfig = {
      id: "user-kimi-code",
      presetId: "kimi-code",
      name: "Kimi Code",
      auth: { method: "apiKey" },
      runtimes: {
        pi: {
          baseUrl: "https://api.kimi.com/coding/v1",
          wireProtocol: "openai-chat",
          models: [{ id: "k3", name: "k3" }],
        },
      },
    }

    expect(migrateCustomProvider(config).runtimes.pi?.models[0]?.reasoning).toBeUndefined()
  })

  it("智谱 Coding Plan 预设迁移不再补静态模型", () => {
    const config: CustomProviderConfig = {
      id: "user-zhipu-coding-plan-cn",
      presetId: "zhipu-coding-plan-cn",
      name: "智谱 GLM Coding Plan",
      auth: { method: "apiKey" },
      runtimes: {
        pi: {
          baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
          wireProtocol: "openai-chat",
          models: [{ id: "glm-5.3", name: "GLM 5.3" }],
        },
      },
    }

    expect(migrateCustomProvider(config).runtimes.pi?.models.map((model) => model.id))
      .toEqual(["glm-5.3"])
  })

  it("v1 预设配置幂等迁移到 v2，并补齐新增 Harness runtime", () => {
    const { store, dir } = tempStore()
    const legacy: CustomProviderConfig = {
      id: "user-zhipu-coding-plan-cn",
      name: "我的智谱套餐",
      auth: { method: "apiKey" },
      disabledHarnesses: ["hermes"],
      runtimes: {
        pi: {
          baseUrl: "https://custom-preserved.example/v1",
          wireProtocol: "openai-chat",
          auth: { inference: { header: "x-api-key", fixedHeaders: { "x-tenant": "mine" } } },
          models: [{ id: "glm-custom", name: "GLM Custom", enabled: false }],
        },
      },
    }
    fs.writeFileSync(
      path.join(dir, "providers", "custom.json"),
      JSON.stringify([legacy]),
    )

    const [migrated] = store.list()
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      runtimePolicy: "preset",
      presetId: "zhipu-coding-plan-cn",
      name: "我的智谱套餐",
    })
    expect(migrated!.runtimes.pi).toMatchObject({
      baseUrl: "https://custom-preserved.example/v1",
      auth: { inference: { fixedHeaders: { "x-tenant": "mine" } } },
    })
    expect(migrated!.runtimes.pi?.models[0]).toMatchObject({ id: "glm-custom", enabled: false })
    expect(migrated!.runtimes.kimi).toBeDefined()
    expect(migrated!.runtimes.opencode).toBeDefined()
    expect(migrated!.runtimes.omp).toBeDefined()
    expect(migrated!.runtimes.hermes).toBeUndefined()
    expect(migrateCustomProvider(migrated!)).toEqual(migrated)
    expect(JSON.parse(fs.readFileSync(path.join(dir, "providers", "custom.json"), "utf8"))[0])
      .toMatchObject({ schemaVersion: 2, runtimePolicy: "preset" })
  })

  it("upsert 持久化 + 变更通知;重启读回", () => {
    const { store, changes, dir } = tempStore()
    store.upsert(valid, { "claude-code": "sk-test" })
    expect(changes()).toBe(1)
    expect(store.hasKey("user-deepseek", "claude-code")).toBe(true)
    expect(store.readKey("user-deepseek", "claude-code")).toBe("sk-test")
    // 同一目录新实例 = 重启语义
    const revived = new CustomProviderStore(dir, memorySecrets())
    expect(revived.list().map((c) => c.id)).toEqual(["user-deepseek"])
  })

  it("remove 清密钥并通知;不存在时抛错", () => {
    const { store, secrets, changes } = tempStore()
    store.upsert(valid, { "claude-code": "sk-test" })
    store.remove("user-deepseek")
    expect(changes()).toBe(2)
    expect(store.list()).toEqual([])
    expect(secrets.dump().has(secretKeyOf("user-deepseek", "claude-code"))).toBe(false)
    expect(() => store.remove("user-deepseek")).toThrow(/不存在/)
  })

  it("坏 JSON / 半合法条目安全兜底为空表", () => {
    const { store, dir } = tempStore()
    fs.writeFileSync(
      path.join(dir, "providers", "custom.json"),
      JSON.stringify([{ ...valid }, { id: "openai", name: "撞键" }]),
    )
    expect(store.list().map((c) => c.id)).toEqual(["user-deepseek"])
    fs.writeFileSync(path.join(dir, "providers", "custom.json"), "{broken")
    const fresh = new CustomProviderStore(dir, memorySecrets())
    expect(fresh.list()).toEqual([])
  })

  it("upsert 空密钥不覆盖已存密钥(留空 = 不修改)", () => {
    const { store } = tempStore()
    store.upsert(valid, { "claude-code": "sk-first" })
    store.upsert({ ...valid, name: "改名" })
    expect(store.readKey("user-deepseek", "claude-code")).toBe("sk-first")
  })

  it("预设共享一份 provider key，并兼容旧的 per-runtime key", () => {
    const { store, secrets } = tempStore()
    store.upsert(valid, { "*": "sk-shared" })
    expect(store.readKey(valid.id, "claude-code")).toBe("sk-shared")
    expect(secrets.dump().get(providerSecretKeyOf(valid.id))).toBe("sk-shared")
    store.remove(valid.id)
    expect(secrets.dump().has(providerSecretKeyOf(valid.id))).toBe(false)
  })

  it("无需鉴权的本地供应商直接视为已连接", () => {
    const { store } = tempStore()
    const local = { ...valid, id: "user-local", auth: { method: "none" as const } }
    store.upsert(local)
    expect(store.hasCredential(local.id)).toBe(true)
  })

  it("OAuth token 整包只进 secret store,hasCredential 支持有效或可刷新", () => {
    const { store, secrets, dir } = tempStore()
    store.upsert(oauthValid)
    store.writeOAuthTokens(oauthValid.id, {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: 1,
      oauthProxyUrl: "https://oauth-proxy.example.com",
    })
    expect(store.readOAuthTokens(oauthValid.id)).toMatchObject({ accessToken: "oauth-access" })
    expect(store.hasCredential(oauthValid.id, Date.now())).toBe(true)
    expect(store.listView()[0]).toMatchObject({
      hasCredential: true,
      runtimes: { "claude-code": { baseUrl: "https://api.deepseek.com/anthropic", hasKey: false } },
    })
    expect(JSON.stringify(store.listView())).not.toContain("oauth-access")
    expect(secrets.dump().get(oauthSecretKeyOf(oauthValid.id))).toContain("oauth-access")
    expect(fs.readFileSync(path.join(dir, "providers", "custom.json"), "utf8")).not.toContain("oauth-access")
    store.clearOAuthTokens(oauthValid.id)
    expect(store.hasCredential(oauthValid.id)).toBe(false)
    store.writeOAuthTokens(oauthValid.id, {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: 1,
    })
    store.remove(oauthValid.id)
    expect(secrets.dump().has(oauthSecretKeyOf(oauthValid.id))).toBe(false)
  })

  it("旧 subscription provider 配置与 token 迁移到 builtin id", () => {
    const { store, secrets } = tempStore()
    const legacy: CustomProviderConfig = {
      ...oauthValid,
      id: "user-codex-subscription",
      name: "Codex 订阅",
      runtimes: {
        codex: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          wireProtocol: "openai-responses",
          models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
        },
      },
    }
    store.upsert(legacy)
    store.writeOAuthTokens(legacy.id, {
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: Date.now() + 60_000,
    })

    expect(store.migrateBuiltinSubscriptions()).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.readOAuthTokens("openai")).toMatchObject({ accessToken: "legacy-access" })
    expect(store.readOAuthTokens(legacy.id)).toBeNull()
    expect(secrets.dump().has(oauthSecretKeyOf(legacy.id))).toBe(false)
    expect(store.hasCredentialFor(store.getProviderConfig("openai")!, "codex")).toBe(true)
  })
})
