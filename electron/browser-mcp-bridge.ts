import { randomUUID } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

import type { BrowserWindow } from "electron"

import type { HarnessMcpServer } from "./drivers/types"
import type { WorkspaceBrowserManager } from "./workspace/browser-manager"

type BrowserHost = { ownerId: number; window: BrowserWindow }

type BrowserToolRequest = {
  tool: "tabs" | "open" | "snapshot" | "click" | "fill" | "scroll" | "screenshot"
  args?: Record<string, unknown>
}

export class BrowserMcpBridge {
  private server: http.Server | null = null
  private port = 0
  private readonly token = randomUUID()

  constructor(
    private readonly browsers: WorkspaceBrowserManager,
    private readonly host: () => BrowserHost | null,
  ) {}

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

  mcpServer(scriptPath: string): HarnessMcpServer {
    if (!this.server) throw new Error("Browser MCP bridge 尚未启动")
    return {
      name: "Bento Browser",
      command: process.execPath,
      args: [scriptPath],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        BENTO_BROWSER_BRIDGE_URL: `http://127.0.0.1:${this.port}/invoke`,
        BENTO_BROWSER_BRIDGE_TOKEN: this.token,
      },
    }
  }

  close(): void {
    this.server?.close()
    this.server = null
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/invoke" ||
        request.headers.authorization !== `Bearer ${this.token}`
      ) {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > 1_000_000) throw new Error("Browser MCP 请求过大")
        chunks.push(bytes)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BrowserToolRequest
      const result = await this.invoke(payload)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ result }))
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  private async invoke(request: BrowserToolRequest): Promise<unknown> {
    const host = this.host()
    if (!host) throw new Error("Bento 窗口当前不可用")
    const args = request.args ?? {}
    const states = this.browsers.list(host.ownerId)
    if (request.tool === "tabs") return states
    const id = typeof args.tabId === "string" ? args.tabId : states[0]?.id
    if (!id) throw new Error("没有可操作的浏览器标签页，请先在右侧工具面板打开浏览器")
    if (request.tool === "open") {
      if (typeof args.url !== "string") throw new Error("url 必须是字符串")
      await this.browsers.navigate(host.ownerId, id, args.url)
      return this.browsers.list(host.ownerId).find((state) => state.id === id)
    }
    if (request.tool === "snapshot") return this.browsers.snapshot(host.ownerId, id)
    if (request.tool === "click") {
      if (typeof args.nodeId !== "number") throw new Error("nodeId 必须是数字")
      await this.browsers.click(host.ownerId, id, args.nodeId)
      return { ok: true }
    }
    if (request.tool === "fill") {
      if (typeof args.nodeId !== "number" || typeof args.text !== "string") {
        throw new Error("nodeId 和 text 参数无效")
      }
      await this.browsers.fill(host.ownerId, id, args.nodeId, args.text)
      return { ok: true }
    }
    if (request.tool === "scroll") {
      if (typeof args.deltaY !== "number") throw new Error("deltaY 必须是数字")
      await this.browsers.scroll(host.ownerId, id, args.deltaY)
      return { ok: true }
    }
    return { base64: await this.browsers.screenshot(host.ownerId, id), mimeType: "image/png" }
  }
}
