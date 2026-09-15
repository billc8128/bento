import { EventEmitter } from "node:events"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"

import { afterEach, describe, expect, it, vi } from "vitest"

import { AgentBrowserService, chromeExecutable } from "./agent-browser"

const dirs: string[] = []
const servers: http.Server[] = []
const services: AgentBrowserService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-agent-browser-"))
  dirs.push(dir)
  return dir
}

/** 假 Chrome:解析 spawn 参数里的调试端口,在该端口起 /json/version 应答。 */
function fakeChromeSpawn(wsPath = "/devtools/browser/fake") {
  const children: (ChildProcess & { killed: boolean })[] = []
  const spawnProcess = (_cmd: string, args?: readonly string[]) => {
    const port = Number((args ?? []).find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1])
    const server = http.createServer((request, response) => {
      if (request.url === "/json/version") {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}${wsPath}` }))
      } else {
        response.statusCode = 404
        response.end()
      }
    })
    servers.push(server)
    server.listen(port, "127.0.0.1")
    const child = new EventEmitter() as ChildProcess & { killed: boolean }
    child.pid = 4321 + children.length
    child.kill = vi.fn(() => {
      server.close()
      queueMicrotask(() => child.emit("exit", 0))
      return true
    }) as ChildProcess["kill"]
    children.push(child)
    return child
  }
  return { spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn, children }
}

describe("chromeExecutable", () => {
  it("按候选顺序探测,都不存在返回 null", () => {
    expect(chromeExecutable((p) => p.includes("Google Chrome"))).toContain("Google Chrome.app")
    expect(chromeExecutable((p) => p.includes("Chromium.app"))).toContain("Chromium.app")
    expect(chromeExecutable(() => false)).toBeNull()
  })
})

describe("AgentBrowserService", () => {
  it("无 Chrome:ensure 返回 null,不 spawn", () => {
    const service = new AgentBrowserService(tempDir(), {
      findChrome: () => null,
      spawnProcess: vi.fn() as never,
    })
    services.push(service)
    return expect(service.ensure()).resolves.toBeNull()
  })

  it("ensure 懒启动并缓存端点;并发 ensure 共享同一次启动", async () => {
    const { spawnProcess, children } = fakeChromeSpawn()
    const service = new AgentBrowserService(tempDir(), {
      findChrome: () => "/fake/chrome",
      spawnProcess,
    })
    services.push(service)
    const [a, b] = await Promise.all([service.ensure(), service.ensure()])
    expect(children).toHaveLength(1) // 并发只拉一次
    expect(a).toEqual(b)
    expect(a?.http).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(a?.ws).toContain("ws://127.0.0.1:")
    expect(service.endpoint()).toEqual(a) // 缓存
    const again = await service.ensure()
    expect(children).toHaveLength(1) // 已启动不重复拉
    expect(again).toEqual(a)
  })

  it("Chrome 进程退出后端点清空,下次 ensure 重拉", async () => {
    const { spawnProcess, children } = fakeChromeSpawn()
    const service = new AgentBrowserService(tempDir(), {
      findChrome: () => "/fake/chrome",
      spawnProcess,
    })
    services.push(service)
    await service.ensure()
    children[0].emit("exit", 0)
    expect(service.endpoint()).toBeNull()
    await service.ensure()
    expect(children).toHaveLength(2)
  })

  it("就绪超时:返回 null 并杀掉子进程", async () => {
    const child = new EventEmitter() as ChildProcess
    child.pid = 1
    child.kill = vi.fn(() => true) as ChildProcess["kill"]
    const service = new AgentBrowserService(tempDir(), {
      findChrome: () => "/fake/chrome",
      spawnProcess: (() => child) as never,
      readyTimeoutMs: 300, // 端口上没有任何服务,快速超时
    })
    services.push(service)
    await expect(service.ensure()).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalled()
    expect(service.endpoint()).toBeNull()
  })

  it("dispose 杀掉子进程并清空端点", async () => {
    const { spawnProcess, children } = fakeChromeSpawn()
    const service = new AgentBrowserService(tempDir(), {
      findChrome: () => "/fake/chrome",
      spawnProcess,
    })
    await service.ensure()
    service.dispose()
    expect(children[0].kill).toHaveBeenCalled()
    expect(service.endpoint()).toBeNull()
  })
})
