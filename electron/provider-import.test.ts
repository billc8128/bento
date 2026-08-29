import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

  it("识别 Hermes .env 的已知 provider 变量", () => {
    const home = tempHome()
    write(path.join(home, ".hermes/.env"), "DEEPSEEK_API_KEY='sk-ds'\nOPENROUTER_API_KEY=sk-or\nUNKNOWN=x\n")
    const scanner = new LocalProviderScanner(home, {})
    expect(scanner.scan().map((item) => item.presetId)).toEqual(["deepseek", "openrouter"])
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
