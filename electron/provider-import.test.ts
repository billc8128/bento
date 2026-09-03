import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"

import { LocalProviderScanner } from "./provider-import"

const dirs: string[] = []
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bento-provider-import-"))
  dirs.push(home)
  return home
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }) })

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe("LocalProviderScanner", () => {
  it("识别 Pi/OpenCode API key 和 OAuth，但不把凭证明文返回 renderer", () => {
    const home = tempHome()
    write(path.join(home, ".pi/agent/auth.json"), JSON.stringify({
      deepseek: { type: "api_key", key: "sk-pi" },
      "openai-codex": { type: "oauth", access: "secret-oauth" },
    }))
    write(path.join(home, ".local/share/opencode/auth.json"), JSON.stringify({
      openrouter: { type: "api", key: "sk-open-code" },
    }))
    const scanner = new LocalProviderScanner(home, {})
    const result = scanner.scan()
    expect(result.map((item) => [item.source, item.presetId, item.credentialReusable])).toEqual([
      ["Pi", "deepseek", true],
      ["Pi", "openai-codex", false],
      ["OpenCode", "openrouter", true],
    ])
    expect(JSON.stringify(result)).not.toContain("sk-pi")
    expect(scanner.credential("pi-deepseek")).toBe("sk-pi")
  })

  it("Pi 共用 provider id 时按 credential type 区分 Claude/Grok 订阅与 API", () => {
    const home = tempHome()
    write(path.join(home, ".pi/agent/auth.json"), JSON.stringify({
      anthropic: { type: "oauth", access: "claude-secret" },
      xai: { type: "oauth", access: "grok-secret" },
      openai: { type: "api_key", key: "openai-key" },
    }))
    const scanner = new LocalProviderScanner(home, {})
    const result = scanner.scan()
    expect(result.map((item) => [item.name, item.presetId, item.authKind])).toEqual([
      ["Claude Pro/Max", "anthropic-api", "oauth"],
      ["OpenAI API", "openai-api", "apiKey"],
      ["xAI SuperGrok", "xai-oauth", "oauth"],
    ])
    expect(scanner.isOAuthConfigured("Pi", "anthropic")).toBe(true)
    expect(scanner.isOAuthConfigured("Pi", "xai")).toBe(true)
    expect(scanner.isOAuthConfigured("Pi", "openai")).toBe(false)
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("识别 Hermes .env 的已知 provider 变量", () => {
    const home = tempHome()
    write(path.join(home, ".hermes/.env"), "DEEPSEEK_API_KEY='sk-ds'\nOPENROUTER_API_KEY=sk-or\nUNKNOWN=x\n")
    const scanner = new LocalProviderScanner(home, {})
    expect(scanner.scan().map((item) => item.presetId)).toEqual(["deepseek", "openrouter"])
  })

  it("识别 Hermes auth.json credential pool 与 Codex CLI OAuth，不返回 token", () => {
    const home = tempHome()
    write(path.join(home, ".hermes/auth.json"), JSON.stringify({
      version: 1,
      credential_pool: {
        "openai-codex": [{ id: "codex-1", access_token: "hermes-secret" }],
        anthropic: [{ id: "claude-1", access_token: "claude-secret" }],
        "xai-oauth": [{ id: "grok-1", access_token: "grok-secret" }],
      },
    }))
    const scanner = new LocalProviderScanner(home, {})
    expect(scanner.scan().map((item) => [item.name, item.presetId, item.authKind])).toEqual([
      ["Claude Pro/Max", "anthropic-api", "oauth"],
      ["OpenAI Codex 订阅", "openai-codex", "oauth"],
      ["xAI SuperGrok", "xai-oauth", "oauth"],
    ])
    expect(scanner.configuredKeys("Hermes").sort()).toEqual(["anthropic", "openai-codex", "xai-oauth"])
    expect(scanner.isOAuthConfigured("Hermes", "anthropic")).toBe(true)
    expect(scanner.isOAuthConfigured("Hermes", "xai-oauth")).toBe(true)
    expect(JSON.stringify(scanner.scan())).not.toContain("hermes-secret")

    const codexHome = tempHome()
    write(path.join(codexHome, ".codex/auth.json"), JSON.stringify({
      tokens: { access_token: "codex-secret", refresh_token: "refresh-secret" },
    }))
    const borrowed = new LocalProviderScanner(codexHome, {})
    expect(borrowed.configuredKeys("Hermes")).toEqual(["openai-codex"])
    expect(JSON.stringify(borrowed.scan())).not.toContain("codex-secret")
  })

  it("识别 omp models.json,UUID provider 按 baseUrl 反查预设", () => {
    const home = tempHome()
    write(path.join(home, ".omp/agent/models.json"), JSON.stringify({
      providers: {
        "glm-coding-plan": {
          baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
          apiKey: "sk-glm",
          models: [{ id: "glm-5.3", name: "GLM 5.3", reasoning: true }, { id: "glm-5-turbo" }, { name: "no-id" }],
        },
        "c767a447-7cf3-4d4f-b996-51ca391ab93d": { name: "Kimi Code (live test)", baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi" },
        "no-key": { baseUrl: "https://example.com/v1" },
      },
    }))
    const scanner = new LocalProviderScanner(home, {})
    const result = scanner.scan()
    expect(result.map((item) => [item.source, item.presetId, item.credentialReusable])).toEqual([
      ["OMP", "kimi-code", true],
      ["OMP", "zhipu-coding-plan-cn", true],
    ])
    expect(JSON.stringify(result)).not.toContain("sk-glm")
    expect(JSON.stringify(result)).not.toContain("glm-5.3")
    expect(scanner.credential("omp-glm-coding-plan")).toBe("sk-glm")
    expect(scanner.localModels("omp-glm-coding-plan")).toEqual([
      { id: "glm-5.3", name: "GLM 5.3", reasoning: true },
      { id: "glm-5-turbo", name: "glm-5-turbo" },
    ])
    expect(scanner.localModels("omp-c767a447-7cf3-4d4f-b996-51ca391ab93d")).toBeNull()
  })

  it("识别 OMP agent.db 中仍启用的 OAuth Provider", () => {
    const home = tempHome()
    const databasePath = path.join(home, ".omp/agent/agent.db")
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT
      );
      INSERT INTO auth_credentials(provider, credential_type, data, disabled_cause)
      VALUES
        ('openai-codex', 'oauth', '{"access":"omp-secret"}', NULL),
        ('anthropic', 'oauth', '{"access":"claude-secret"}', NULL),
        ('xai-oauth', 'oauth', '{"access":"grok-secret"}', NULL),
        ('anthropic', 'oauth', '{"access":"disabled"}', 'logged_out'),
        ('openai', 'api_key', '{"key":"sk"}', NULL);
    `)
    database.close()
    const scanner = new LocalProviderScanner(home, {})
    expect(scanner.scan().map((item) => [item.name, item.presetId, item.authKind])).toEqual([
      ["Claude Pro/Max", "anthropic-api", "oauth"],
      ["OpenAI Codex 订阅", "openai-codex", "oauth"],
      ["xAI SuperGrok", "xai-oauth", "oauth"],
    ])
    expect(scanner.configuredKeys("OMP").sort()).toEqual(["anthropic", "openai-codex", "xai-oauth"])
    expect(scanner.isOAuthConfigured("OMP", "anthropic")).toBe(true)
    expect(scanner.isOAuthConfigured("OMP", "xai-oauth")).toBe(true)
    expect(JSON.stringify(scanner.scan())).not.toContain("omp-secret")
  })

  it("发现 Kimi Code CLI 登录态但标记为需要重新鉴权", async () => {
    const home = tempHome()
    write(path.join(home, ".kimi-code/oauth/token.json"), "{}")
    const scanner = new LocalProviderScanner(home, {})
    expect(scanner.scan().map((item) => [item.source, item.presetId, item.credentialReusable, item.authKind])).toEqual([
      ["Kimi Code", "kimi-code", false, "oauth"],
    ])
  })

  it("configuredKeys('Kimi Code') 解析 config.toml 的真实模型前缀,agent-plan 不再被过滤", () => {
    const home = tempHome()
    write(path.join(home, ".kimi-code/config.toml"), `
default_model = "kimi-code/k3-256k"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"
type = "kimi"
api_key = ""

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[providers.agent-plan]
type = "openai"
base_url = "https://ark.cn-beijing.volces.com/api/plan/v3"
api_key = "ark-secret-not-returned"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
display_name = "K3"

[models."agent-plan/kimi-k3"]
provider = "agent-plan"
model = "kimi-k3"
max_context_size = 262144
`)
    const scanner = new LocalProviderScanner(home, {})
    const keys = scanner.configuredKeys("Kimi Code").sort()
    expect(keys).toEqual(["agent-plan", "kimi-code"])
    // 只读别名结构:api_key/OAuth 值绝不进入返回值
    expect(JSON.stringify(keys)).not.toContain("ark-secret-not-returned")
  })

  it("同一 preset 在多个来源检出时合并:凭证优先 auth.json 来源,模型清单取并集", () => {
    const home = tempHome()
    write(path.join(home, ".pi/agent/auth.json"), JSON.stringify({
      "glm-coding-plan": { type: "api_key", key: "sk-pi-good" },
    }))
    write(path.join(home, ".omp/agent/models.json"), JSON.stringify({
      providers: {
        "glm-coding-plan": {
          baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
          apiKey: "sk-omp-stale",
          models: [{ id: "glm-5.3", name: "GLM 5.3" }, { id: "glm-5-turbo" }],
        },
      },
    }))
    const scanner = new LocalProviderScanner(home, {})
    const result = scanner.scan()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      source: "Pi",
      presetId: "zhipu-coding-plan-cn",
      alsoFrom: ["OMP"],
      credentialReusable: true,
    })
    // 凭证取 Pi(auth.json 是凭证库,OMP models.json 的 key 可能漂移)
    expect(scanner.credential(result[0]!.id)).toBe("sk-pi-good")
    // 模型清单并集仍挂在合并后的候选上
    expect(scanner.localModels(result[0]!.id)?.map((model) => model.id))
      .toEqual(["glm-5.3", "glm-5-turbo"])
  })

  it("config.toml 缺失或损坏时 Kimi configuredKeys 回落到 OAuth 登录基线", () => {
    const home = tempHome()
    write(path.join(home, ".kimi-code/config.toml"), "not [ valid toml {{{")
    write(path.join(home, ".kimi-code/oauth/token.json"), "{}")
    const broken = new LocalProviderScanner(home, {})
    expect(broken.configuredKeys("Kimi Code")).toEqual(["kimi-code"])

    const empty = new LocalProviderScanner(tempHome(), {})
    expect(empty.configuredKeys("Kimi Code")).toEqual([])
  })
})
