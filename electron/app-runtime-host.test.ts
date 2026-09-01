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

import { COLLABORATION_APP_ID } from "../src/core/apps"
import type { CollaborationSession, MessageOrigin, SessionMessage } from "../src/core/collaboration"
import { AppRuntimeHost } from "./app-runtime-host"
import { AppsStore, type AppSecretStore } from "./apps"
import { CollaborationService } from "./collaboration-service"
import type { SessionBackend } from "./collaboration-service"
import { UiCommandBridge } from "./ui-command-bridge"
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

// ---- Phase 1d:Collaboration App / MCP 工具 ----

async function listToolNames(lease: { endpoint: string; token: string }): Promise<string[]> {
  const client = new Client({ name: "collab-list", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${lease.token}` } },
  }))
  const tools = (await client.listTools()).tools.map((tool) => tool.name)
  await client.close()
  return tools
}

function fakeBackend(sessionKey: string) {
  const calls = { created: 0, sent: 0 }
  const backend: SessionBackend = {
    getSession(id) {
      return {
        id,
        title: "self",
        workspace: { scope: "project", cwd: "/proj/a" },
        harnessId: "pi",
        providerId: "native-pi",
        modelId: "m",
        runtime: "idle",
        updatedAt: "2024-01-01T00:00:00Z",
        lastSeq: 3,
      }
    },
    listSessions() {
      return [
        backend.getSession(sessionKey)!,
        { ...backend.getSession(sessionKey)!, id: "other", workspace: { scope: "project", cwd: "/proj/b" } } as CollaborationSession,
      ]
    },
    async createSession(spec) {
      calls.created += 1
      // 新 Session 必须有独立 id,否则 service 的 self_target guard 会拒发首 Prompt
      return { ...backend.getSession(sessionKey)!, id: `new-${calls.created}`, title: spec.title }
    },
    async sendToSession(_t, payload: { originalText: string; wireText: string; origin: MessageOrigin }) {
      calls.sent += 1
      void payload
      return { acceptedSeq: 4 }
    },
    readSessionMessages(_t, _a, _l, _i) {
      const messages: SessionMessage[] = [{
        seqStart: 3,
        seqEnd: 3,
        at: "2024-01-01T00:00:00Z",
        role: "assistant",
        text: "hello",
      }]
      return { messages, nextSeq: 3, truncated: false }
    },
    async waitForSession(_t, _u, _a, _t2) {
      return { session: backend.getSession(sessionKey)!, matched: "settled" as const }
    },
  }
  return { backend, calls }
}

async function callTool(lease: { endpoint: string; token: string }, name: string, args?: Record<string, unknown>) {
  const client = new Client({ name: "collab-test", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${lease.token}` } },
  }))
  const result = await client.callTool({ name, arguments: args ?? {} })
  await client.close()
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as unknown
}

describe("AppRuntimeHost Collaboration tools", () => {
  it("默认启用:协作与 UI 工具存在,caller 绑定 lease.sessionKey,跨项目可见", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-host-"))
    dirs.push(dir)
    const { backend } = fakeBackend("session-1")
    const host = new AppRuntimeHost(
      dir,
      new AppsStore(dir, secrets()),
      { list: () => [], navigate: async () => {} } as never,
      () => null,
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
      () => {},
      () => new CollaborationService(backend),
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("session-1", dir))!
    expect(lease).not.toBeNull()

    const names = (await listToolNames(lease)).filter((name) => name.startsWith("session_") || name.startsWith("runtime") || name.startsWith("workspace") || name.startsWith("harness_") || name.startsWith("model_") || name.startsWith("ui_"))
    for (const tool of ["runtime_snapshot", "workspace_list", "session_list", "harness_list", "model_list", "session_create", "session_send", "session_read", "session_wait", "ui_state", "ui_neighbor", "ui_show_session", "ui_hide_session", "ui_focus_session"]) {
      expect(names).toContain(tool)
    }

    const list = await callTool(lease, "session_list", {}) as { selfSessionId: string; sessions: Array<{ id: string }> }
    expect(list.selfSessionId).toBe("session-1")
    expect(list.sessions.map((s) => s.id)).toEqual(["session-1", "other"])

    const snapshot = await callTool(lease, "runtime_snapshot") as { selfSessionId: string; sessions: unknown[] }
    expect(snapshot.selfSessionId).toBe("session-1")
    expect(snapshot.sessions).toHaveLength(2)
  })

  it("session_create/session_send 调到注入的 service(真实 CollaborationService + fake backend)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-host2-"))
    dirs.push(dir)
    const { backend, calls } = fakeBackend("session-1")
    const host = new AppRuntimeHost(
      dir,
      new AppsStore(dir, secrets()),
      { list: () => [], navigate: async () => {} } as never,
      () => null,
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
      () => {},
      () => new CollaborationService(backend),
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("session-1", dir))!

    const created = await callTool(lease, "session_create", { title: "reviewer", prompt: "hi" }) as { session: { title: string }; prompt: string }
    expect(created.session.title).toBe("reviewer")
    expect(created.prompt).toBe("accepted")
    expect(calls.created).toBe(1)
    expect(calls.sent).toBe(1)

    const sent = await callTool(lease, "session_send", { targetSessionId: "other", text: "hi" }) as { acceptedSeq: number }
    expect(sent.acceptedSeq).toBe(4)
    expect(calls.sent).toBe(2)

    const read = await callTool(lease, "session_read", { targetSessionId: "other" }) as { messages: unknown[] }
    expect(read.messages).toHaveLength(1)
  })

  it("Collaboration 关闭:协作工具消失但 Browser 不受影响;仅 Collaboration 开启时 lease 仍签发", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-host3-"))
    dirs.push(dir)
    const store = new AppsStore(dir, secrets())
    const { backend } = fakeBackend("session-1")
    const host = new AppRuntimeHost(
      dir,
      store,
      { list: () => [], navigate: async () => {} } as never,
      () => null,
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
      () => {},
      () => new CollaborationService(backend),
    )
    hosts.push(host)
    await host.start()

    store.setEnabled(COLLABORATION_APP_ID, false)
    const lease = (await host.prepare("session-1", dir))!
    expect(lease).not.toBeNull() // Browser 仍默认开启
    const names = await listToolNames(lease)
    expect(names).toContain("browser_open")
    expect(names).not.toContain("session_list")
    expect(names).not.toContain("runtime_snapshot")

    // 仅 Collaboration 开启、Browser 与用户 App 全关:lease 仍签发
    store.setEnabled(COLLABORATION_APP_ID, true)
    store.setEnabled("browser", false)
    const onlyCollab = (await host.prepare("session-2", dir))!
    expect(onlyCollab).not.toBeNull()
    const onlyNames = await listToolNames(onlyCollab)
    expect(onlyNames).toContain("session_list")
    expect(onlyNames).not.toContain("browser_open")
    const who = await callTool(onlyCollab, "session_list") as { selfSessionId: string }
    expect(who.selfSessionId).toBe("session-2")
  })
})

describe("AppRuntimeHost Collaboration 错误语义与 wait", () => {
  it("CollaborationError 经 MCP 返回稳定 {error:{code,message}};session_wait 实调", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-host4-"))
    dirs.push(dir)
    const { backend } = fakeBackend("session-1")
    const host = new AppRuntimeHost(
      dir,
      new AppsStore(dir, secrets()),
      { list: () => [], navigate: async () => {} } as never,
      () => null,
      path.join(process.cwd(), "electron/mcp-http-relay.mjs"),
      path.join(process.cwd(), "electron/pi-mcp-extension.mjs"),
      () => {},
      () => {
        const ui = new UiCommandBridge(() => true)
        ui.report({
          visibleSessionIds: ["session-1", "other"],
          focusedSessionId: "session-1",
          layoutMode: "managed",
          adjacency: [
            { sessionId: "session-1", neighbors: { right: "other" } },
            { sessionId: "other", neighbors: { left: "session-1" } },
          ],
        })
        return new CollaborationService(backend, {
          ui,
          catalog: {
            listHarnesses: async () => [{
              id: "omp",
              name: "OMP",
              usable: true,
              source: "managed",
              effortSelection: true,
              efforts: ["off", "auto"],
              defaultEffort: "auto",
            }],
            listModels: async ({ harnessId }) => [{
              harnessId,
              providerId: "omp-provider",
              providerName: "OMP Provider",
              providerSource: "user",
              modelId: "omp-model",
              modelName: "OMP Model",
              reasoning: true,
              efforts: ["auto"],
              defaultEffort: "auto",
              providerDefault: true,
              default: true,
            }],
            resolveSelection: async () => ({
              providerId: "omp-provider",
              modelId: "omp-model",
              defaultEffort: "auto",
            }),
          },
        })
      },
    )
    hosts.push(host)
    await host.start()
    const lease = (await host.prepare("session-1", dir))!

    // self_target:稳定错误 payload,不含堆栈
    const err = await callTool(lease, "session_send", { targetSessionId: "session-1", text: "hi" }) as {
      error: { code: string; message: string }
    }
    expect(err.error).toMatchObject({ code: "self_target" })
    expect(JSON.stringify(err)).not.toContain("at ")

    // session_wait 实调:目标 idle,立即 settled
    const waited = await callTool(lease, "session_wait", { targetSessionId: "other", until: "settled", timeoutMs: 2_000 }) as {
      matched: string
    }
    expect(waited.matched).toBe("settled")

    const neighbor = await callTool(lease, "ui_neighbor", { direction: "right" }) as {
      session: { id: string; title: string } | null
    }
    expect(neighbor.session).toMatchObject({ id: "other", title: "self" })

    const harnesses = await callTool(lease, "harness_list") as { harnesses: Array<{ id: string }> }
    expect(harnesses.harnesses).toContainEqual(expect.objectContaining({ id: "omp" }))
    const models = await callTool(lease, "model_list", { harnessId: "omp" }) as {
      models: Array<{ providerId: string; modelId: string }>
    }
    expect(models.models).toContainEqual({
      harnessId: "omp",
      providerId: "omp-provider",
      providerName: "OMP Provider",
      providerSource: "user",
      modelId: "omp-model",
      modelName: "OMP Model",
      reasoning: true,
      efforts: ["auto"],
      defaultEffort: "auto",
      providerDefault: true,
      default: true,
    })

    // session_create 返回 ui 字段
    const created = await callTool(lease, "session_create", { title: "r" }) as { ui: string }
    expect(created.ui).toBe("queued")
  })
})
