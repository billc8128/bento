import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { discoverAcpProvider, parseAcpModelDiscovery, parsePiModelDiscovery } from "../providers/provider-discovery"

describe("ProviderDiscoveryService ACP 解析", () => {
  it("发现进程 spawn 失败时返回普通错误而不是未捕获异常", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-acp-spawn-"))
    const executable = path.join(dir, "opencode")
    const previous = process.env.BENTO_OPENCODE_PATH
    fs.writeFileSync(executable, "#!/definitely/missing/interpreter\n")
    fs.chmodSync(executable, 0o755)
    process.env.BENTO_OPENCODE_PATH = executable
    try {
      await expect(discoverAcpProvider("opencode", dir)).rejects.toThrow("ENOENT")
    } finally {
      if (previous === undefined) delete process.env.BENTO_OPENCODE_PATH
      else process.env.BENTO_OPENCODE_PATH = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("兼容读取 legacy session models", () => {
    expect(parseAcpModelDiscovery({
      models: {
        currentModelId: "claude-real",
        availableModels: [
          { modelId: "claude-real", name: "Claude Real", description: "from runtime" },
        ],
      },
    })).toEqual({
      currentModelId: "claude-real",
      models: [{
        id: "claude-real",
        name: "Claude Real",
        description: "from runtime",
        reasoning: true,
      }],
    })
  })

  it("读取标准 configOptions model select 并展开分组", () => {
    expect(parseAcpModelDiscovery({
      configOptions: [{
        id: "model",
        type: "select",
        category: "model",
        currentValue: "m-2",
        options: [{
          group: "main",
          name: "Main",
          options: [
            { value: "m-1", name: "Model 1" },
            { value: "m-2", name: "Model 2" },
          ],
        }],
      }],
    })).toMatchObject({
      currentModelId: "m-2",
      models: [
        { id: "m-1", name: "Model 1" },
        { id: "m-2", name: "Model 2" },
      ],
    })
  })
})

describe("ProviderDiscoveryService Pi 解析", () => {
  it("把 Pi provider/id 固化成可切换的 wire model id", () => {
    expect(parsePiModelDiscovery(
      {
        models: [
          { provider: "anthropic", id: "claude-sonnet", name: "Sonnet", reasoning: true },
          { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
        ],
      },
      { model: { provider: "openai", id: "gpt-5.4" } },
    )).toEqual({
      currentModelId: "openai/gpt-5.4",
      models: [
        { id: "anthropic/claude-sonnet", name: "Sonnet", reasoning: true },
        { id: "openai/gpt-5.4", name: "GPT-5.4", reasoning: false },
      ],
    })
  })
})
