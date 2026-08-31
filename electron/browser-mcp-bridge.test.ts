import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BrowserMcpBridge } from "./browser-mcp-bridge"
import type { WorkspaceBrowserManager } from "./workspace/browser-manager"

const bridges: BrowserMcpBridge[] = []

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close()
})

describe("Browser MCP", () => {
  it("经 stdio MCP 调用同一个 WorkspaceBrowserManager", async () => {
    const navigate = vi.fn(async () => {})
    const browsers = {
      list: () => [{ id: "tab-1", url: "", title: "新标签页", loading: false, canGoBack: false, canGoForward: false }],
      navigate,
    } as unknown as WorkspaceBrowserManager
    const bridge = new BrowserMcpBridge(browsers, () => ({ ownerId: 7, window: {} as never }))
    bridges.push(bridge)
    await bridge.start()
    const config = bridge.mcpServer(path.join(process.cwd(), "electron/browser-mcp-server.mjs"))
    const client = new Client({ name: "bento-test", version: "1" })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: config.args,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ...config.env,
      },
      stderr: "pipe",
    })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "browser_tabs",
        "browser_open",
        "browser_snapshot",
        "browser_click",
        "browser_fill",
        "browser_scroll",
        "browser_screenshot",
      ])
      const result = await client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } })
      expect(result.isError).not.toBe(true)
      expect(navigate).toHaveBeenCalledWith(7, "tab-1", "https://example.com")
    } finally {
      await client.close()
    }
  })
})
