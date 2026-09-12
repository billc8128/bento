import { describe, expect, it, vi } from "vitest"

import type { HarnessId } from "../drivers/types"
import type { AppSessionLease } from "./app-runtime-host"
import { appStartOptions } from "./app-harness-adapter"

const lease: AppSessionLease = {
  sessionKey: "session-1",
  endpoint: "http://127.0.0.1:1234/mcp/token",
  token: "token",
  stdioRelay: {
    name: "Bento Apps",
    command: "/Applications/Bento.app/Contents/MacOS/Bento",
    args: ["/app/mcp-http-relay.mjs"],
    env: { BENTO_MCP_TOKEN: "token" },
  },
  piExtensionPath: "/tmp/bento-pi-mcp.mjs",
  dispose: vi.fn(),
}

describe("appStartOptions", () => {
  it("所有非 Pi Harness 通过同一个标准 MCP relay 消费 Apps", () => {
    const harnesses: HarnessId[] = ["claude-code", "codex", "kimi", "opencode", "omp", "hermes"]
    for (const harness of harnesses) {
      expect(appStartOptions(harness, lease)).toEqual({ mcpServers: [lease.stdioRelay] })
    }
  })

  it("Pi 只在 adapter 层使用 extension，仍消费同一个 session endpoint", () => {
    expect(appStartOptions("pi", lease)).toEqual({
      appArgs: ["--extension", lease.piExtensionPath],
      appEnv: {
        BENTO_MCP_ENDPOINT: lease.endpoint,
        BENTO_MCP_TOKEN: lease.token,
      },
    })
  })
})
