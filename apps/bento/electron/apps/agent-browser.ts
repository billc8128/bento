/**
 * 通用 Agent Browser:Bento 管理的专用 Chrome 实例 + 标准 CDP 端点。
 *
 * 动机:agent 需要带登录态的浏览器时,内嵌浏览器(browser_* 工具)是独立
 * profile 帮不上;操控用户日常 Chrome 的两条路(AppleScript 注入、
 * --remote-debugging-port 挂默认 profile)都被 macOS/Chrome 的安全设计封死。
 * 剩下的正路就是 Codex CLI/agent-browser 的架构:独立持久 profile 的专用
 * Chrome,用户登录一次,agent 经标准 CDP(Playwright connectOverCDP 等)接入。
 *
 * 安全边界:CDP 端口只绑 127.0.0.1;profile 是 agent 专用目录——用户往里
 * 登录什么就等于授权 agent 访问什么,与日常浏览器完全隔离。
 */

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

export type AgentBrowserEndpoint = { http: string; ws: string; pid: number }

export function chromeExecutable(exists: (p: string) => boolean = fs.existsSync): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (exists(candidate)) return candidate
  }
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function fetchWsUrl(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => (body += chunk))
      response.on("end", () => {
        try {
          const ws = (JSON.parse(body) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl
          if (ws) resolve(ws)
          else reject(new Error("CDP /json/version 缺 webSocketDebuggerUrl"))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    request.once("error", reject)
    request.setTimeout(2000, () => request.destroy(new Error("CDP 探测超时")))
  })
}

/** 轮询 /json/version 直到 Chrome 就绪 */
async function waitReady(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await fetchWsUrl(port)
    } catch (error) {
      if (Date.now() >= deadline) throw error instanceof Error ? error : new Error(String(error))
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

type AgentBrowserDeps = {
  findChrome?: () => string | null
  spawnProcess?: typeof spawn
  readyTimeoutMs?: number
}

export class AgentBrowserService {
  private child: ChildProcess | null = null
  private current: AgentBrowserEndpoint | null = null
  private starting: Promise<AgentBrowserEndpoint | null> | null = null

  constructor(
    private readonly userDataDir: string,
    private readonly deps: AgentBrowserDeps = {},
  ) {}

  /** 已启动则返回端点;未启动/无 Chrome 返回 null(不触发启动)。 */
  endpoint(): AgentBrowserEndpoint | null {
    return this.current
  }

  /** 懒启动:首次调用拉起 Chrome;并发调用共享同一次启动。 */
  async ensure(): Promise<AgentBrowserEndpoint | null> {
    if (this.current) return this.current
    this.starting ??= this.launch()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async launch(): Promise<AgentBrowserEndpoint | null> {
    const chrome = (this.deps.findChrome ?? (() => chromeExecutable()))()
    if (!chrome) return null
    const port = await freePort()
    const profile = path.join(this.userDataDir, "agent-browser")
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
    const child = (this.deps.spawnProcess ?? spawn)(chrome, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Playwright 等客户端的 ws 握手没有 Origin 头,Chrome 111+ 默认拒
      "--remote-allow-origins=*",
      "about:blank",
    ], { stdio: "ignore" })
    this.child = child
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null
        this.current = null
      }
    })
    try {
      const ws = await waitReady(port, this.deps.readyTimeoutMs ?? 15_000)
      const endpoint: AgentBrowserEndpoint = { http: `http://127.0.0.1:${port}`, ws, pid: child.pid ?? 0 }
      this.current = endpoint
      return endpoint
    } catch {
      child.kill()
      if (this.child === child) this.child = null
      return null
    }
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
    this.current = null
  }
}
