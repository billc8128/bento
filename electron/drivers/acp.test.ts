import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

import { acpMcpServers, createAcpDriver, sendLegacySessionModel } from "./acp"

describe("ACP MCP", () => {
  it("把 Bento stdio server 转成 ACP session/new 契约", () => {
    expect(acpMcpServers([{
      name: "Bento Browser",
      command: "/Applications/Bento.app/Contents/MacOS/Bento",
      args: ["browser-mcp-server.mjs"],
      env: { TOKEN: "secret" },
    }])).toEqual([{
      name: "Bento Browser",
      command: "/Applications/Bento.app/Contents/MacOS/Bento",
      args: ["browser-mcp-server.mjs"],
      env: [{ name: "TOKEN", value: "secret" }],
    }])
  })
})

describe("Hermes ACP model switch", () => {
  it("透传 session/set_model 到 SDK 底层连接", async () => {
    const sendRequest = vi.fn(async () => ({}))
    const connection = { connection: { sendRequest } }

    await sendLegacySessionModel(connection as never, "session-1", "custom:bento-a:model-1")

    expect(sendRequest).toHaveBeenCalledWith("session/set_model", {
      sessionId: "session-1",
      modelId: "custom:bento-a:model-1",
    })
  })
})

describe("ACP Driver session lifecycle", () => {
  function fakeOpen(options: { resume?: boolean } = {}) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const newSession = vi.fn(async () => ({ sessionId: "created-session" }))
    const resumeSession = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ sessionId }))
    const conn = {
      newSession,
      resumeSession,
      prompt: vi.fn(),
      cancel: vi.fn(),
    }
    const open = vi.fn(async () => ({
      child,
      conn,
      init: {
        agentCapabilities: {
          sessionCapabilities: { resume: options.resume === true },
        },
      },
    }))
    return { child, conn, newSession, resumeSession, open }
  }

  it("新会话使用 session/new 返回的 nativeSessionId", async () => {
    const fake = fakeOpen()
    const connection = await createAcpDriver("omp").start(
      { cwd: "/workspace" },
      vi.fn(),
      { open: fake.open },
    )
    expect(fake.newSession).toHaveBeenCalledWith({ cwd: "/workspace", mcpServers: [] })
    expect(connection.nativeSessionId).toBe("created-session")
    connection.close()
    expect(fake.child.kill).toHaveBeenCalledOnce()
  })

  it("已有 nativeSessionId 且 Harness 支持 resume 时恢复原会话", async () => {
    const fake = fakeOpen({ resume: true })
    const connection = await createAcpDriver("kimi").start(
      { cwd: "/workspace", nativeSessionId: "existing-session" },
      vi.fn(),
      { open: fake.open },
    )
    expect(fake.resumeSession).toHaveBeenCalledWith({
      sessionId: "existing-session",
      cwd: "/workspace",
      mcpServers: [],
    })
    expect(fake.newSession).not.toHaveBeenCalled()
    expect(connection.nativeSessionId).toBe("existing-session")
  })
})
