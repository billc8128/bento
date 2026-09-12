import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  delete process.env.BENTO_MCP_ENDPOINT
  delete process.env.BENTO_MCP_TOKEN
})

describe("Pi MCP extension", () => {
  it("在 session_start 后把 MCP tools 合入 active set", async () => {
    const server = http.createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        const frame = JSON.parse(body) as { id: number; method: string }
        const result = frame.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            }
          : frame.method === "tools/list"
            ? {
                tools: [{
                  name: "session_list",
                  description: "list sessions",
                  inputSchema: { type: "object", properties: {} },
                }, {
                  name: "harness_list",
                  description: "list harnesses",
                  inputSchema: { type: "object", properties: {} },
                }, {
                  name: "model_list",
                  description: "list models",
                  inputSchema: {
                    type: "object",
                    properties: { harnessId: { type: "string" } },
                    required: ["harnessId"],
                  },
                }],
              }
            : { content: [{ type: "text", text: "ok" }] }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    process.env.BENTO_MCP_ENDPOINT = `http://127.0.0.1:${port}`
    process.env.BENTO_MCP_TOKEN = "test-token"

    const registered = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
    let active = ["read"]
    let onSessionStart: (() => void) | undefined
    const pi = {
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        registered.set(tool.name, tool)
      },
      getActiveTools: () => active,
      setActiveTools(tools: string[]) { active = tools },
      on(event: string, callback: () => void) {
        if (event === "session_start") onSessionStart = callback
      },
    }

    const url = `${pathToFileURL(path.join(process.cwd(), "electron/apps/pi-mcp-extension.mjs")).href}?test=${Date.now()}`
    const extension = (await import(url)).default as (api: typeof pi) => Promise<void>
    await extension(pi)

    expect([...registered.keys()]).toEqual(["session_list", "harness_list", "model_list"])
    expect(active).toEqual(["read"])
    onSessionStart?.()
    expect(active).toEqual(["read", "session_list", "harness_list", "model_list"])
    await expect(registered.get("session_list")!.execute("id", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    })
    await expect(registered.get("model_list")!.execute("id", { harnessId: "omp" }))
      .resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] })
  })
})
