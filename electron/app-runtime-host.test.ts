import fs from "node:fs"
import { spawn } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppRuntimeHost } from "./app-runtime-host"
import { AppsStore, type AppSecretStore } from "./apps"
import { localHarnessExecutable } from "./harness-runtime"
import { resolvePiRpcEntry } from "./pi-rpc-entry"
import type { WorkspaceBrowserManager } from "./workspace/browser-manager"

const hosts: AppRuntimeHost[] = []
const dirs: string[] = []
const servers: http.Server[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function secrets(): AppSecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

describe("AppRuntimeHost", () => {
  it("一个 session endpoint 同时服务 HTTP、stdio relay 与 Browser runtime", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-app-runtime-"))
    dirs.push(dir)
    const navigate = vi.fn(async () => {})
    const browsers = {
      list: () => [{ id: "tab-1", url: "", title: "新标签页", loading: false, canGoBack: false, canGoForward: false }],
      navigate,
    } as unknown as WorkspaceBrowserManager
    const host = new AppRuntimeHost(
      dir,
      new AppsStore(dir, secrets()),
      browsers,
      () => ({ ownerId: 7 }),
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("session-1", dir))!

    const httpClient = new Client({ name: "http-test", version: "1" })
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(lease.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${lease.token}` } },
    }))
    expect((await httpClient.listTools()).tools.map((tool) => tool.name)).toContain("browser_open")
    await httpClient.callTool({ name: "browser_open", arguments: { url: "https://example.com" } })
    expect(navigate).toHaveBeenCalledWith(7, "tab-1", "https://example.com")
    await httpClient.close()

    const relayClient = new Client({ name: "relay-test", version: "1" })
    await relayClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: lease.stdioRelay.args,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ...lease.stdioRelay.env,
      },
      stderr: "pipe",
    }))
    expect((await relayClient.listTools()).tools.map((tool) => tool.name)).toContain("browser_tabs")
    await relayClient.close()

    const extensionSource = pathToFileURL(path.join(process.cwd(), "electron/pi-mcp-extension.mjs")).href
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import extension from ${JSON.stringify(extensionSource)};
      const tools = [];
      await extension({ registerTool(tool) { tools.push(tool.name); } });
      process.stdout.write(JSON.stringify(tools));
    `], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        BENTO_MCP_ENDPOINT: lease.endpoint,
        BENTO_MCP_TOKEN: lease.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("error", reject)
      child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
    })
    expect(JSON.parse(output)).toContain("browser_open")

    const localPi = localHarnessExecutable("pi")
    const pi = spawn(localPi?.path ?? process.execPath, localPi
      ? ["--mode", "rpc", "--approve", "--extension", lease.piExtensionPath]
      : [resolvePiRpcEntry(), "--approve", "--extension", lease.piExtensionPath], {
      cwd: dir,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ELECTRON_RUN_AS_NODE: "1",
        BENTO_MCP_ENDPOINT: lease.endpoint,
        BENTO_MCP_TOKEN: lease.token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    pi.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`)
    const frames = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const values: Array<Record<string, unknown>> = []
      let buffered = ""
      const timer = setTimeout(() => { pi.kill(); reject(new Error("Pi extension probe timeout")) }, 10_000)
      pi.stdout.on("data", (chunk) => {
        buffered += chunk.toString()
        while (buffered.includes("\n")) {
          const index = buffered.indexOf("\n")
          const line = buffered.slice(0, index).trim()
          buffered = buffered.slice(index + 1)
          if (!line) continue
          const frame = JSON.parse(line) as Record<string, unknown>
          values.push(frame)
          if (frame.type === "response" && frame.id === "state") {
            clearTimeout(timer)
            pi.kill()
            resolve(values)
          }
        }
      })
      pi.on("error", reject)
    })
    expect(frames.some((frame) => frame.type === "extension_error")).toBe(false)
    await lease.dispose()
  })

  it("browser_open 在空窗口中创建 Browser，并通知 Renderer 展示同一标签页", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-browser-autocreate-"))
    dirs.push(dir)
    const state = {
      id: "tab-created",
      url: "",
      title: "新标签页",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }
    const ensure = vi.fn(() => state)
    const navigate = vi.fn(async () => {})
    const reveal = vi.fn()
    const browsers = {
      list: () => [],
      ensure,
      navigate,
    } as unknown as WorkspaceBrowserManager
    const host = new AppRuntimeHost(
      dir,
      new AppsStore(dir, secrets()),
      browsers,
      () => ({ ownerId: 9, window: {} as never }),
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
      reveal,
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("browser-autocreate", dir))!
    const client = new Client({ name: "browser-test", version: "1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${lease.token}` } },
    }))

    await client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } })
    expect(ensure).toHaveBeenCalledWith(9, expect.anything())
    expect(reveal).toHaveBeenCalledWith("tab-created")
    expect(navigate).toHaveBeenCalledWith(9, "tab-created", "https://example.com")
    await client.close()
    await lease.dispose()
  })

  it("用户 HTTP App 由 Main 持有 header，并通过 lazy catalog 调用", async () => {
    let authorization = ""
    const upstream = http.createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end()
        return
      }
      authorization = request.headers.authorization ?? ""
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string; params?: { arguments?: unknown } }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: JSON.stringify(message.params?.arguments) }] }
            : {}
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    })
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-user-app-runtime-"))
    dirs.push(dir)
    const store = new AppsStore(dir, secrets())
    store.upsert({
      name: "Echo",
      transport: { type: "http", url },
      headers: { Authorization: "Bearer secret" },
    })
    const host = new AppRuntimeHost(
      dir,
      store,
      { list: () => [] } as unknown as WorkspaceBrowserManager,
      () => ({ ownerId: 1 }),
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("user-app-session", dir))!
    const client = new Client({ name: "app-test", version: "1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${lease.token}` } },
    }))
    expect(await client.callTool({ name: "apps_search_tools", arguments: { query: "echo" } }))
      .toMatchObject({ content: [{ type: "text", text: expect.stringContaining("user-echo") }] })
    await expect(client.callTool({
      name: "apps_call_tool",
      arguments: { app: "user-echo", tool: "echo", args: { text: "hello" } },
    })).resolves.toMatchObject({ isError: true })
    await client.callTool({ name: "apps_describe_tool", arguments: { app: "user-echo", tool: "echo" } })
    expect(await client.callTool({
      name: "apps_call_tool",
      arguments: { app: "user-echo", tool: "echo", args: { text: "hello" } },
    })).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("hello") }] })
    expect(authorization).toBe("Bearer secret")
    await client.close()
    await lease.dispose()
  })

  it("用户 App 启动失败不会阻断 lease，并提供可恢复状态", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-failed-app-runtime-"))
    dirs.push(dir)
    const store = new AppsStore(dir, secrets())
    store.upsert({ name: "Broken", transport: { type: "stdio", command: "/usr/bin/false", args: [] } })
    const host = new AppRuntimeHost(
      dir,
      store,
      { list: () => [] } as unknown as WorkspaceBrowserManager,
      () => ({ ownerId: 1 }),
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("failed-app-session", dir))!
    const client = new Client({ name: "failed-app-test", version: "1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${lease.token}` } },
    }))
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("apps_status")
    expect(await client.callTool({ name: "apps_status" })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("user-broken") }],
    })
    await client.close()
    await lease.dispose()
  })
})
