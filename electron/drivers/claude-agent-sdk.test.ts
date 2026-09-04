import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it, vi } from "vitest"

import {
  claudeAgentSdkDriver,
  claudeSdkEnv,
  discoverClaudeModels,
  parseClaudeModels,
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
  it("模型目录只使用 SDK initialization 的实际返回", async () => {
    expect(parseClaudeModels([{
      value: "actual-model",
      displayName: "Actual Model",
      description: "from SDK",
      supportsEffort: true,
      supportedEffortLevels: ["low", "xhigh"],
    }])).toEqual({
      models: [{
        id: "actual-model",
        name: "Actual Model",
        description: "from SDK",
        reasoning: true,
        efforts: ["low", "max"],
      }],
    })

    const close = vi.fn()
    const query = vi.fn(() => ({
      supportedModels: vi.fn(async () => [{
        value: "account-model",
        displayName: "Account Model",
        description: "available",
      }]),
      close,
    }) as unknown as Query)
    await expect(discoverClaudeModels("/tmp", undefined, "managed", { query }))
      .resolves.toMatchObject({ models: [{ id: "account-model" }] })
    expect(close).toHaveBeenCalledOnce()
  })

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
    expect(calls[0]?.options?.pathToClaudeCodeExecutable).toBeUndefined()
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

  it("权限档位驱动 canUseTool 裁决,切 full 后走 bypassPermissions", async () => {
    const calls: Parameters<ClaudeQueryFactory>[0][] = []
    const query: ClaudeQueryFactory = vi.fn((params) => {
      calls.push(params)
      return queryOf([result("s-profile")])
    })
    const events: unknown[] = []
    const connection = await claudeAgentSdkDriver.start({
      cwd: "/repo",
      proxyEnv: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/r" }, strip: [] },
      permissionProfile: "restricted",
    }, (event) => events.push(event), { query })

    await connection.prompt("one")
    const canUseTool = calls[0]?.options?.canUseTool
    expect(canUseTool).toBeDefined()
    await expect(canUseTool!("Read", {}, { toolUseID: "t1" } as never))
      .resolves.toMatchObject({ behavior: "allow" })
    await expect(canUseTool!("Edit", { file_path: "/repo/a.ts" }, { toolUseID: "t2" } as never))
      .resolves.toMatchObject({ behavior: "allow" })
    await expect(canUseTool!("Bash", {}, { toolUseID: "t3" } as never))
      .resolves.toMatchObject({ behavior: "deny" })
    await expect(canUseTool!("WebFetch", {}, { toolUseID: "t4" } as never))
      .resolves.toMatchObject({ behavior: "deny" })

    // 会话中切档:canUseTool 现读档位,standard 立刻放行网络类
    await connection.setPermissionProfile?.("standard")
    await expect(canUseTool!("WebFetch", {}, { toolUseID: "t5" } as never))
      .resolves.toMatchObject({ behavior: "allow" })

    // standard 的 execute 不再自动拒:发审批卡 hold,决议后兑现
    const held = canUseTool!("Bash", { command: "rm -rf /tmp/x" }, { toolUseID: "t6" } as never)
    await vi.waitFor(() =>
      expect(events.some((e) => (e as { type?: string }).type === "approval_request")).toBe(true))
    const request = events.find((e) => (e as { type?: string }).type === "approval_request") as { id: string; title: string }
    expect(request.title).toBe("rm -rf /tmp/x")
    connection.resolveApproval?.(request.id, "allow_always")
    await expect(held).resolves.toMatchObject({ behavior: "allow" })
    // 总是允许已入会话规则:同名工具后续直接放行,不再发审批
    const before = events.length
    await expect(canUseTool!("Bash", { command: "ls" }, { toolUseID: "t7" } as never))
      .resolves.toMatchObject({ behavior: "allow" })
    expect(events.slice(before).some((e) => (e as { type?: string }).type === "approval_request")).toBe(false)

    // 越界写:同样走审批;拒绝则 deny
    const held2 = canUseTool!("Edit", { file_path: "/etc/hosts" }, { toolUseID: "t8" } as never)
    await vi.waitFor(() =>
      expect(events.filter((e) => (e as { type?: string }).type === "approval_request").length).toBe(2))
    const request2 = events.filter((e) => (e as { type?: string }).type === "approval_request")[1] as { id: string }
    connection.resolveApproval?.(request2.id, "deny")
    await expect(held2).resolves.toMatchObject({ behavior: "deny" })

    // full:下个 query 走 bypassPermissions(必须带 allowDangerouslySkipPermissions),不再挂 canUseTool
    await connection.setPermissionProfile?.("full")
    await connection.prompt("two")
    expect(calls[1]?.options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    })
    expect(calls[1]?.options?.canUseTool).toBeUndefined()
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
