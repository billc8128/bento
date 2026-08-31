import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it, vi } from "vitest"

import {
  claudeAgentSdkDriver,
  claudeSdkEnv,
  type ClaudeQueryFactory,
} from "./claude-agent-sdk"

function queryOf(messages: SDKMessage[], interrupt = vi.fn(async () => {})): Query {
  let index = 0
  return {
    async next() {
      const value = messages[index++]
      return value ? { done: false, value } : { done: true, value: undefined }
    },
    async return() { return { done: true, value: undefined } },
    async throw(error) { throw error },
    [Symbol.asyncIterator]() { return this },
    interrupt,
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    initializationResult: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    mcpServerStatus: vi.fn(),
    accountInfo: vi.fn(),
    rewindFiles: vi.fn(),
    reconnectMcpServer: vi.fn(),
    toggleMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    streamInput: vi.fn(),
    stopTask: vi.fn(),
    close: vi.fn(),
  } as unknown as Query
}

function result(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    stop_reason: "end_turn",
    errors: [],
    usage: { input_tokens: 1200, output_tokens: 340 },
    total_cost_usd: 0.0207,
  } as never
}

describe("claudeAgentSdkDriver", () => {
  it("用隔离 env 创建 SDK session,翻译流并在后续 turn resume", async () => {
    const calls: Parameters<ClaudeQueryFactory>[0][] = []
    const query: ClaudeQueryFactory = vi.fn((params) => {
      calls.push(params)
      const sessionId = params.options?.resume ?? params.options?.sessionId ?? "session"
      return queryOf([
        {
          type: "stream_event",
          session_id: sessionId,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
        } as never,
        result(sessionId),
      ])
    })
    const events: unknown[] = []
    const connection = await claudeAgentSdkDriver.start({
      cwd: "/tmp",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      proxyEnv: {
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:1234/s/route",
          ANTHROPIC_AUTH_TOKEN: "bento-local-proxy",
          CLAUDE_CONFIG_DIR: "/tmp/claude-isolated",
        },
        strip: ["ANTHROPIC_"],
      },
      mcpServers: [{
        name: "Bento Browser",
        command: "/bin/node",
        args: ["browser.mjs"],
        env: { TOKEN: "secret" },
      }],
    }, (event) => events.push(event), { query })

    // §7 P4:result 的 usage/total_cost_usd 透出到 prompt() 返回
    await expect(connection.prompt("one")).resolves.toEqual({
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 340, cost: 0.0207 },
    })
    await connection.setModel?.("claude-opus-4-8")
    await expect(connection.prompt("two")).resolves.toEqual({
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 340, cost: 0.0207 },
    })
    expect(calls[0]?.options).toMatchObject({
      sessionId: connection.nativeSessionId,
      model: "claude-sonnet-4-6",
      includePartialMessages: true,
      settingSources: ["project"],
      mcpServers: {
        "bento-apps": { type: "stdio", command: "/bin/node", args: ["browser.mjs"] },
      },
    })
    expect(calls[1]?.options).toMatchObject({
      resume: connection.nativeSessionId,
      model: "claude-opus-4-8",
    })
    expect(events).toContainEqual({ type: "agent_message_chunk", text: "ok" })
  })

  it("缺 host 路由环境时拒绝,不回落本机 Claude 登录态", async () => {
    await expect(claudeAgentSdkDriver.start({
      cwd: "/tmp",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
    }, () => {})).rejects.toThrow(/缺少 Bento provider 路由环境/)
  })
})

describe("claudeSdkEnv", () => {
  it("剥宿主 Anthropic 凭证后只注入 route env", () => {
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "host-secret"
    try {
      const env = claudeSdkEnv({
        env: { ANTHROPIC_AUTH_TOKEN: "route-token" },
        strip: ["ANTHROPIC_"],
      })
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("route-token")
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("bento/0.3.1")
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
    }
  })
})
