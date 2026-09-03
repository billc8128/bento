import { randomUUID } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import type { BrowserWindow } from "electron"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

import { BROWSER_APP_ID, COLLABORATION_APP_ID } from "../src/core/apps"
import type { SessionListInput } from "../src/core/collaboration"
import { CollaborationError } from "../src/core/collaboration"
import type { CollaborationService } from "./collaboration-service"
import type { HarnessMcpServer } from "./drivers/types"
import type { AppsStore, RuntimeApp } from "./apps"
import type { WorkspaceBrowserManager } from "./workspace/browser-manager"

type BrowserHost = { ownerId: number; window: BrowserWindow }
type ExternalTool = {
  appId: string
  appName: string
  client: Client
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

type RuntimeLease = {
  sessionKey: string
  cwd: string
  token: string
  browserEnabled: boolean
  collaborationEnabled: boolean
  configuredUserApps: number
  clients: Client[]
  appClients: Map<string, { name: string; client: Client }>
  failures: Map<string, string>
  tools: Map<string, ExternalTool>
  disclosed: Set<string>
}

export type AppSessionLease = {
  sessionKey: string
  endpoint: string
  token: string
  stdioRelay: HarnessMcpServer
  piExtensionPath: string
  dispose(): Promise<void>
}

function processEnv(extra: Record<string, string>): Record<string, string> {
  const inherited = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "ComSpec", "PATHEXT"]
  return {
    ...Object.fromEntries(inherited.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : [])),
    ...extra,
  }
}

function toolKey(appId: string, toolName: string): string {
  return `${appId}\0${toolName}`
}

export class AppRuntimeHost {
  private readonly leases = new Map<string, RuntimeLease>()
  private server: http.Server | null = null
  private port = 0
  readonly piExtensionPath: string

  constructor(
    private readonly userDataDir: string,
    private readonly apps: AppsStore,
    private readonly browsers: WorkspaceBrowserManager,
    private readonly browserHost: () => BrowserHost | null,
    private readonly relayScriptPath: string,
    piExtensionSourcePath: string,
    private readonly revealBrowser: (id: string) => void = () => {},
    /** 协作服务 getter:main 在 SessionManager 就绪后注入,避免初始化循环。 */
    private readonly collaboration: () => CollaborationService | null = () => null,
  ) {
    const runtimeDir = path.join(userDataDir, "apps", "runtime")
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    this.piExtensionPath = path.join(runtimeDir, "bento-pi-mcp.mjs")
    fs.writeFileSync(this.piExtensionPath, fs.readFileSync(piExtensionSourcePath), { mode: 0o600 })
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject)
      this.server!.listen(0, "127.0.0.1", () => resolve())
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  async prepare(sessionKey: string, cwd: string): Promise<AppSessionLease | null> {
    if (!this.server) throw new Error("App Runtime Host 尚未启动")
    await this.disposeLease(sessionKey)
    const browserEnabled = this.apps.isEnabled(BROWSER_APP_ID)
    const collaborationEnabled = this.apps.isEnabled(COLLABORATION_APP_ID)
    const runtimeApps = this.apps.enabledRuntimeApps()
    if (!browserEnabled && !collaborationEnabled && runtimeApps.length === 0) return null
    const lease: RuntimeLease = {
      sessionKey,
      cwd,
      token: randomUUID(),
      browserEnabled,
      collaborationEnabled,
      configuredUserApps: runtimeApps.length,
      clients: [],
      appClients: new Map(),
      failures: new Map(),
      tools: new Map(),
      disclosed: new Set(),
    }
    await Promise.all(runtimeApps.map((app) => this.connectApp(lease, app)))
    this.leases.set(lease.token, lease)
    const endpoint = `http://127.0.0.1:${this.port}/mcp/${lease.token}`
    const token = lease.token
    return {
      sessionKey,
      endpoint,
      token,
      stdioRelay: {
        name: "Bento Apps",
        command: process.execPath,
        args: [this.relayScriptPath],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          BENTO_MCP_ENDPOINT: endpoint,
          BENTO_MCP_TOKEN: token,
        },
      },
      piExtensionPath: this.piExtensionPath,
      dispose: () => this.disposeLease(sessionKey),
    }
  }

  async close(): Promise<void> {
    for (const lease of [...this.leases.values()]) await this.disposeLease(lease.sessionKey)
    this.server?.close()
    this.server = null
  }

  private async connectApp(lease: RuntimeLease, app: RuntimeApp): Promise<void> {
    const client = new Client({ name: `bento-${app.id}`, version: "0.1.0" })
    const transport = app.transport.type === "stdio"
      ? new StdioClientTransport({
          command: app.transport.command,
          args: app.transport.args,
          env: processEnv(app.env),
          cwd: lease.cwd,
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(app.transport.url), {
          requestInit: { headers: app.headers },
        })
    if (transport instanceof StdioClientTransport) {
      (transport.stderr as NodeJS.ReadableStream | null)?.resume()
    }
    try {
      await client.connect(transport, { timeout: 10_000 })
      lease.clients.push(client)
      lease.appClients.set(app.id, { name: app.name, client })
      let cursor: string | undefined
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined)
        for (const tool of result.tools) {
          lease.tools.set(toolKey(app.id, tool.name), {
            appId: app.id,
            appName: app.name,
            client,
            name: tool.name,
            description: tool.description ?? `${app.name} / ${tool.name}`,
            inputSchema: tool.inputSchema as Record<string, unknown>,
          })
        }
        cursor = result.nextCursor
      } while (cursor)
    } catch {
      lease.failures.set(app.id, "无法连接或完成 MCP 初始化")
      await client.close().catch(() => {})
    }
  }

  private makeServer(lease: RuntimeLease): McpServer {
    const server = new McpServer({ name: "bento-apps", version: "0.1.0" })
    if (lease.browserEnabled) this.registerBrowserTools(server)
    if (lease.collaborationEnabled) this.registerCollaborationTools(server, lease)
    if (lease.configuredUserApps > 0) {
    server.registerTool("apps_status", {
      description: "查看当前会话用户 Apps 的连接状态。",
    }, async () => ({ content: [{ type: "text", text: JSON.stringify({
      connected: [...lease.appClients.keys()],
      unavailable: [...lease.failures].map(([app, error]) => ({ app, error })),
    }) }] }))
    server.registerTool("apps_search_tools", {
      description: "搜索当前会话已启用的用户 Apps 工具，不加载完整参数 schema。",
      inputSchema: { query: z.string().optional() },
    }, async ({ query }) => {
      const needle = query?.trim().toLowerCase() ?? ""
      const tools = [...lease.tools.values()]
        .filter((tool) => !needle || `${tool.appName} ${tool.name} ${tool.description}`.toLowerCase().includes(needle))
        .map((tool) => ({ app: tool.appId, tool: tool.name, description: tool.description }))
      return { content: [{ type: "text", text: JSON.stringify(tools) }] }
    })
    server.registerTool("apps_describe_tool", {
      description: "读取一个用户 App 工具的完整 input schema；调用前必须先描述。",
      inputSchema: { app: z.string(), tool: z.string() },
    }, async ({ app, tool }) => {
      const found = lease.tools.get(toolKey(app, tool))
      if (!found) throw new Error("App 工具不存在")
      lease.disclosed.add(toolKey(app, tool))
      return { content: [{ type: "text", text: JSON.stringify({
        app: found.appId,
        tool: found.name,
        description: found.description,
        inputSchema: found.inputSchema,
      }) }] }
    })
    server.registerTool("apps_call_tool", {
      description: "调用已经通过 apps_describe_tool 检查过的用户 App 工具。",
      inputSchema: { app: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) },
    }, async ({ app, tool, args }, extra) => {
      const key = toolKey(app, tool)
      const found = lease.tools.get(key)
      if (!found) throw new Error("App 工具不存在")
      if (!lease.disclosed.has(key)) throw new Error("请先调用 apps_describe_tool 检查参数 schema")
      return await found.client.callTool(
        { name: found.name, arguments: args },
        undefined,
        { timeout: 600_000, maxTotalTimeout: 600_000, signal: extra.signal },
      ) as never
    })
    server.registerTool("apps_list_resources", {
      description: "列出用户 App 提供的 MCP resources。",
      inputSchema: { app: z.string().optional() },
    }, async ({ app }) => {
      const resources: unknown[] = []
      for (const [appId, entry] of lease.appClients) {
        if (app && app !== appId) continue
        const result = await entry.client.listResources().catch(() => ({ resources: [] }))
        resources.push(...result.resources.map((resource) => ({ app: appId, ...resource })))
      }
      return { content: [{ type: "text", text: JSON.stringify(resources) }] }
    })
    server.registerTool("apps_read_resource", {
      description: "读取指定用户 App 的 MCP resource。",
      inputSchema: { app: z.string(), uri: z.string() },
    }, async ({ app, uri }) => {
      const entry = lease.appClients.get(app)
      if (!entry) throw new Error("App 不存在")
      return { content: [{ type: "text", text: JSON.stringify(await entry.client.readResource({ uri })) }] }
    })
    server.registerTool("apps_list_prompts", {
      description: "列出用户 App 提供的 MCP prompts。",
      inputSchema: { app: z.string().optional() },
    }, async ({ app }) => {
      const prompts: unknown[] = []
      for (const [appId, entry] of lease.appClients) {
        if (app && app !== appId) continue
        const result = await entry.client.listPrompts().catch(() => ({ prompts: [] }))
        prompts.push(...result.prompts.map((prompt) => ({ app: appId, ...prompt })))
      }
      return { content: [{ type: "text", text: JSON.stringify(prompts) }] }
    })
    server.registerTool("apps_get_prompt", {
      description: "读取指定用户 App 的 MCP prompt。",
      inputSchema: { app: z.string(), name: z.string(), arguments: z.record(z.string(), z.string()).optional() },
    }, async ({ app, name, arguments: promptArguments }) => {
      const entry = lease.appClients.get(app)
      if (!entry) throw new Error("App 不存在")
      return { content: [{ type: "text", text: JSON.stringify(await entry.client.getPrompt({ name, arguments: promptArguments })) }] }
    })
    }
    return server
  }

  /** 协作 App 稳定工具:caller 只来自 lease.sessionKey,Agent 不能伪造来源。 */
  private registerCollaborationTools(server: McpServer, lease: RuntimeLease): void {
    const caller = lease.sessionKey
    const requireService = (): CollaborationService => {
      const service = this.collaboration()
      if (!service) throw new CollaborationError("session_unavailable")
      return service
    }
    const wrap = (handler: (args: Record<string, unknown>) => Promise<unknown>) =>
      async (args: Record<string, unknown>) => {
        try {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(await handler(args)) }],
          }
        } catch (error) {
          if (error instanceof CollaborationError) {
            // 只保留稳定 code/message,不泄露堆栈与内部细节。
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ error: { code: error.code, message: error.message } }),
              }],
            }
          }
          throw error
        }
    }

    server.registerTool("runtime_snapshot", {
      description: "读取当前 Bento runtime 的协作拓扑快照(workspaces/sessions/ui)。",
    }, wrap(async () => requireService().snapshot(caller)))

    server.registerTool("workspace_list", {
      description: "列出当前 runtime 的全部 Workspace(session 归并投影)。",
    }, wrap(async () => {
      const snapshot = requireService().snapshot(caller)
      return { selfSessionId: snapshot.selfSessionId, workspaces: snapshot.workspaces }
    }))

    server.registerTool("session_list", {
      description: "列出全部可协作 Session;默认跨项目,含 sleeping。",
      inputSchema: {
        scope: z.enum(["chat", "project"]).optional(),
        cwd: z.string().optional(),
        runtime: z.enum(["sleeping", "idle", "working"]).optional(),
      },
    }, wrap(async (args) => {
      const input: SessionListInput = {}
      if (typeof args.scope === "string") input.scope = args.scope as SessionListInput["scope"]
      if (typeof args.cwd === "string") input.cwd = args.cwd
      if (typeof args.runtime === "string") input.runtime = args.runtime as SessionListInput["runtime"]
      return requireService().list(caller, input)
    }))

    server.registerTool("harness_list", {
      description: "列出 Bento 当前支持的 Harness、运行时可用性与推理强度；创建不同 Harness Session 前先调用。",
    }, wrap(async () => requireService().harnessList(caller)))

    server.registerTool("model_list", {
      description: "列出目标 Harness 在当前或指定已有 Workspace 中可执行的 Provider/Model；仅返回已连接且启用的选项。",
      inputSchema: {
        harnessId: z.enum(["claude-code", "codex", "kimi", "opencode", "pi", "omp", "hermes"]),
        cwd: z.string().optional(),
      },
    }, wrap(async (args) => requireService().modelList(caller, {
      harnessId: args.harnessId as "claude-code" | "codex" | "kimi" | "opencode" | "pi" | "omp" | "hermes",
      ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    })))

    server.registerTool("session_create", {
      description: "创建协作者 Session；同 Harness 继承调用者配置，跨 Harness 自动使用该 Harness 最近或默认的可执行模型。",
      inputSchema: {
        title: z.string().optional(),
        prompt: z.string().optional(),
        scope: z.enum(["chat", "project"]).optional(),
        cwd: z.string().optional(),
        harnessId: z.enum(["claude-code", "codex", "kimi", "opencode", "pi", "omp", "hermes"]).optional(),
        providerId: z.string().optional(),
        modelId: z.string().optional(),
        effort: z.enum(["off", "auto", "low", "medium", "high", "max"]).optional(),
        show: z.boolean().optional(),
        placement: z.enum(["auto", "right", "down"]).optional(),
        focus: z.boolean().optional(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
    }, wrap(async (args) => requireService().create(caller, args as never)))

    server.registerTool("session_send", {
      description: "向目标 Session 发送消息;working 目标返回 session_busy,第一版不排队。",
      inputSchema: {
        targetSessionId: z.string(),
        text: z.string(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
    }, wrap(async (args) => requireService().send(caller, args as never)))

    server.registerTool("session_read", {
      description: "读取目标 Session 的脱敏消息历史(afterSeq 游标 + limit)。",
      inputSchema: {
        targetSessionId: z.string(),
        afterSeq: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(50).optional(),
        includeTools: z.boolean().optional(),
      },
    }, wrap(async (args) => requireService().read(caller, args as never)))

    server.registerTool("ui_state", {
      description: "读取协作 UI 状态(可见会话/焦点/布局模式/空间邻接)。",
    }, wrap(async () => requireService().uiState(caller)))

    server.registerTool("ui_neighbor", {
      description: "把左侧/右侧/上方/下方的空间指代解析成相邻 Session；缺省从调用者自身开始。",
      inputSchema: {
        direction: z.enum(["left", "right", "above", "below"]),
        fromSessionId: z.string().optional(),
      },
    }, wrap(async (args) => requireService().uiNeighbor(caller, {
      direction: args.direction as "left" | "right" | "above" | "below",
      ...(typeof args.fromSessionId === "string" ? { fromSessionId: args.fromSessionId } : {}),
    })))

    server.registerTool("ui_show_session", {
      description: "在主区展示目标 Session 的面板;幂等,默认不抢焦点。",
      inputSchema: {
        sessionId: z.string(),
        placement: z.enum(["auto", "right", "down"]).optional(),
        focus: z.boolean().optional(),
      },
    }, wrap(async (args) => requireService().uiShow(caller, {
      sessionId: String(args.sessionId),
      ...(typeof args.placement === "string" ? { placement: args.placement as "auto" | "right" | "down" } : {}),
      ...(typeof args.focus === "boolean" ? { focus: args.focus } : {}),
    })))

    server.registerTool("ui_hide_session", {
      description: "只移除目标 Session 的面板,不关闭或删除 Session。",
      inputSchema: { sessionId: z.string() },
    }, wrap(async (args) => requireService().uiHide(caller, { sessionId: String(args.sessionId) })))

    server.registerTool("ui_focus_session", {
      description: "聚焦目标 Session 的面板。",
      inputSchema: { sessionId: z.string() },
    }, wrap(async (args) => requireService().uiFocus(caller, { sessionId: String(args.sessionId) })))

    server.registerTool("session_wait", {
      description: "等待目标 Session 状态(settled/working/next_message);超时不 cancel 目标。",
      inputSchema: {
        targetSessionId: z.string(),
        until: z.enum(["working", "settled", "next_message"]).optional(),
        afterSeq: z.number().int().nonnegative().optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
    }, wrap(async (args) => requireService().wait(caller, args as never)))
  }

  private registerBrowserTools(server: McpServer): void {
    server.registerTool("browser_tabs", {
      description: "列出 Bento 右侧工作区的浏览器标签页。",
    }, async () => ({ content: [{ type: "text", text: JSON.stringify(this.browserStates()) }] }))
    server.registerTool("browser_open", {
      description: "在指定或第一个 Bento 浏览器标签页打开 URL；没有标签页时自动创建并展示。",
      inputSchema: { tabId: z.string().optional(), url: z.string() },
    }, async ({ tabId, url }) => {
      const { ownerId, id } = this.browserTarget(tabId, true)
      this.revealBrowser(id)
      await this.browsers.navigate(ownerId, id, url)
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, tabId: id }) }] }
    })
    server.registerTool("browser_snapshot", {
      description: "获取页面无障碍树；click/fill 使用返回的 nodeId。",
      inputSchema: { tabId: z.string().optional() },
    }, async ({ tabId }) => {
      const { ownerId, id } = this.browserTarget(tabId)
      return { content: [{ type: "text", text: JSON.stringify(await this.browsers.snapshot(ownerId, id)) }] }
    })
    server.registerTool("browser_click", {
      description: "点击最近一次 browser_snapshot 中的节点。",
      inputSchema: { tabId: z.string().optional(), nodeId: z.number().int() },
    }, async ({ tabId, nodeId }) => {
      const { ownerId, id } = this.browserTarget(tabId)
      await this.browsers.click(ownerId, id, nodeId)
      return { content: [{ type: "text", text: "ok" }] }
    })
    server.registerTool("browser_fill", {
      description: "向最近一次 browser_snapshot 中的文本节点填写内容。",
      inputSchema: { tabId: z.string().optional(), nodeId: z.number().int(), text: z.string() },
    }, async ({ tabId, nodeId, text }) => {
      const { ownerId, id } = this.browserTarget(tabId)
      await this.browsers.fill(ownerId, id, nodeId, text)
      return { content: [{ type: "text", text: "ok" }] }
    })
    server.registerTool("browser_scroll", {
      description: "滚动当前页面；正数向下，负数向上。",
      inputSchema: { tabId: z.string().optional(), deltaY: z.number() },
    }, async ({ tabId, deltaY }) => {
      const { ownerId, id } = this.browserTarget(tabId)
      await this.browsers.scroll(ownerId, id, deltaY)
      return { content: [{ type: "text", text: "ok" }] }
    })
    server.registerTool("browser_screenshot", {
      description: "截取当前浏览器标签页可见区域。",
      inputSchema: { tabId: z.string().optional() },
    }, async ({ tabId }) => {
      const { ownerId, id } = this.browserTarget(tabId)
      return { content: [{ type: "image", data: await this.browsers.screenshot(ownerId, id), mimeType: "image/png" }] }
    })
  }

  private browserStates() {
    const host = this.browserHost()
    return host ? this.browsers.list(host.ownerId) : []
  }

  private browserTarget(tabId?: string, createIfMissing = false): { ownerId: number; id: string } {
    const host = this.browserHost()
    if (!host) throw new Error("Bento 窗口当前不可用")
    const states = this.browsers.list(host.ownerId)
    const id = tabId ?? states[0]?.id ?? (createIfMissing
      ? this.browsers.ensure(host.ownerId, host.window).id
      : undefined)
    if (!id) throw new Error("没有可操作的浏览器标签页")
    return { ownerId: host.ownerId, id }
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const token = request.url?.split("?", 1)[0]?.match(/^\/mcp\/([^/]+)$/)?.[1]
    const lease = token ? this.leases.get(token) : undefined
    if (!lease || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" })
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }))
      return
    }
    const server = this.makeServer(lease)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } catch {
      if (!response.headersSent) response.writeHead(500).end()
    } finally {
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    }
  }

  private async disposeLease(sessionKey: string): Promise<void> {
    const lease = [...this.leases.values()].find((entry) => entry.sessionKey === sessionKey)
    if (!lease) return
    this.leases.delete(lease.token)
    await Promise.all(lease.clients.map((client) => client.close().catch(() => {})))
  }
}
