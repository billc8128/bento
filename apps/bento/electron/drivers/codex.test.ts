import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HarnessEvent } from "../../src/core/events"
import { configureBinaryManager } from "../binaries/manager"
import { type RpcFactory, codexDriver, discoverCodexModels, parseCodexModelList } from "./codex"
import type { CodexRpc } from "./codex-rpc"


let tempDir = ""

afterEach(() => {
  delete process.env.BENTO_CODEX_PATH
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

/** 走真实 CodexRpc 的完整流程:fake codex 是一段 node 脚本,按 JSON-RPC
 *  应答 initialize/thread/start/turn/start 并推送流事件。 */
describe("codexDriver 全流程", () => {
  it("完成 initialize → thread/start → turn/start 并翻译流事件", { timeout: 30_000 }, async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-codex-test-"))
    const fakeCodex = path.join(tempDir, "codex")
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
rl.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") send({ id: message.id, result: {} })
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr-test" } } })
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-test", status: "inProgress" } } })
    send({ method: "item/agentMessage/delta", params: { delta: message.params.model + ":" + message.params.effort } })
    send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } })
  }
})
`)
    fs.chmodSync(fakeCodex, 0o755)
    process.env.BENTO_CODEX_PATH = fakeCodex
    configureBinaryManager(tempDir)

    const events: HarnessEvent[] = []
    const connection = await codexDriver.start(
      { cwd: tempDir, modelId: "gpt-5.4", effort: "medium" },
      (event) => events.push(event),
    )
    await connection.setModel?.("gpt-5.6-sol")
    await connection.setEffort?.("max")
    await expect(connection.prompt("hello")).resolves.toEqual({ stopReason: "completed" })
    // setModel/setEffort 后 prompt 带上新值;effort=max 映射 codex 的 xhigh
    expect(events).toContainEqual({
      type: "agent_message_chunk",
      text: "gpt-5.6-sol:xhigh",
    })

    const exited = new Promise<void>((resolve) => connection.onExit(() => resolve()))
    connection.close()
    await exited
  })
})

/** thread/start 与 thread/resume 的参数契约:枚举值错一个字符服务端就拒收
 *  (P0 复发防护:workspaceWrite → workspace-write 那次就是静默回归) */
describe("codexDriver thread 参数", () => {
  it("thread 注入 Browser MCP，turn 发送图片与文件引用", async () => {
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
    let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
    const createRpc: RpcFactory = async (_cwd, handlers) => {
      notify = handlers.onNotification
      return {
        request: async (method: string, params?: Record<string, unknown>) => {
          requests.push({ method, params })
          if (method === "thread/start") return { thread: { id: "thr-mcp" } }
          if (method === "turn/start") {
            queueMicrotask(() => notify?.("turn/completed", { turn: { id: "turn-mcp", status: "completed" } }))
            return { turn: { id: "turn-mcp" } }
          }
          return {}
        },
        notify: () => {},
        onExit: () => () => {},
        close: () => {},
      } as unknown as CodexRpc
    }
    const connection = await codexDriver.start({
      cwd: "/tmp",
      mcpServers: [{
        name: "Bento Browser",
        command: "/bin/node",
        args: ["browser.mjs"],
        env: { TOKEN: "secret" },
      }],
    }, () => {}, { createRpc })
    await connection.prompt({
      text: "查看附件",
      attachments: [
        { name: "shot.png", path: "/tmp/shot.png", mimeType: "image/png", size: 1, kind: "image" },
        { name: "report.csv", path: "/tmp/report.csv", mimeType: "text/csv", size: 1, kind: "file" },
      ],
    })
    expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: { mcp_servers: { "bento-apps": { command: "/bin/node", args: ["browser.mjs"] } } },
    })
    expect(requests.find((request) => request.method === "turn/start")?.params?.input).toEqual([
      { type: "text", text: "查看附件" },
      { type: "localImage", path: "/tmp/shot.png" },
      { type: "mention", name: "report.csv", path: "/tmp/report.csv" },
    ])
  })

  it("运行中通过 turn/steer 向当前 turn 立即追加引导", async () => {
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
    let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
    const createRpc: RpcFactory = async (_cwd, handlers) => {
      notify = handlers.onNotification
      return {
        request: async (method: string, params?: Record<string, unknown>) => {
          requests.push({ method, params })
          if (method === "thread/start") return { thread: { id: "thr-steer" } }
          if (method === "turn/start") return { turn: { id: "turn-steer" } }
          if (method === "turn/steer") return { turnId: "turn-steer" }
          return {}
        },
        notify: () => {}, onExit: () => () => {}, close: () => {},
      } as unknown as CodexRpc
    }
    const connection = await codexDriver.start({ cwd: "/tmp" }, () => {}, { createRpc })
    const completion = connection.prompt("先实现主体")
    await vi.waitFor(() => expect(requests.some((request) => request.method === "turn/start")).toBe(true))
    await connection.steer?.("先把移动端做好")
    expect(requests.find((request) => request.method === "turn/steer")?.params).toEqual({
      threadId: "thr-steer",
      expectedTurnId: "turn-steer",
      input: [{ type: "text", text: "先把移动端做好" }],
    })
    notify?.("turn/completed", { turn: { id: "turn-steer", status: "completed" } })
    await expect(completion).resolves.toEqual({ stopReason: "completed" })
  })

  it("sandbox/approvalPolicy 使用服务端枚举 kebab-case", { timeout: 30_000 }, async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-codex-params-"))
    // 沙箱枚举校验放在 fake 脚本里:收到非法值直接报错,契约破坏即测试红
    const fakeCodex = path.join(tempDir, "codex")
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const fail = (id, message) => send({ id, error: { code: -32602, message } })
rl.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") return send({ id: message.id, result: {} })
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (!["read-only", "workspace-write", "danger-full-access"].includes(message.params.sandbox)) {
      return fail(message.id, "Invalid request: unknown variant " + JSON.stringify(message.params.sandbox))
    }
    if (!["untrusted", "on-failure", "on-request", "never"].includes(message.params.approvalPolicy)) {
      return fail(message.id, "Invalid request: unknown approvalPolicy")
    }
    return send({ id: message.id, result: { thread: { id: "thr-enum" } } })
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "t", status: "inProgress" } } })
    return send({ method: "turn/completed", params: { turn: { id: "t", status: "completed" } } })
  }
})
`)
    fs.chmodSync(fakeCodex, 0o755)
    process.env.BENTO_CODEX_PATH = fakeCodex
    configureBinaryManager(tempDir)

    const connection = await codexDriver.start({ cwd: tempDir }, () => {})
    await expect(connection.prompt("hi")).resolves.toEqual({ stopReason: "completed" })
    connection.close()
  })

  it("未显式选择模型时不向 thread/start 编造 model", { timeout: 30_000 }, async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-codex-default-model-"))
    const fakeCodex = path.join(tempDir, "codex")
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
rl.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") return send({ id: message.id, result: {} })
  if (message.method === "thread/start") {
    if (Object.hasOwn(message.params, "model")) return send({ id: message.id, error: { message: "unexpected model" } })
    return send({ id: message.id, result: { thread: { id: "thr-default" } } })
  }
})
`)
    fs.chmodSync(fakeCodex, 0o755)
    process.env.BENTO_CODEX_PATH = fakeCodex
    configureBinaryManager(tempDir)

    const connection = await codexDriver.start({ cwd: tempDir }, () => {})
    connection.close()
  })

  it("权限档位:thread 基底 + turn/start 逐回合 policy 覆盖", async () => {
    const starts: Record<string, unknown>[] = []
    const turns: Record<string, unknown>[] = []
    const createRpc: RpcFactory = async () => ({
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") {
          starts.push(params ?? {})
          return { thread: { id: "thr-profile" } }
        }
        if (method === "turn/start") {
          turns.push(params ?? {})
          queueMicrotask(() => {})
          return { turn: { id: "turn-p", status: "inProgress" } }
        }
        return {}
      },
      notify: () => {}, onExit: () => () => {}, close: () => {},
    } as unknown as CodexRpc)
    for (const profile of ["restricted", "standard", "full", undefined] as const) {
      const connection = await codexDriver.start(
        { cwd: "/tmp", ...(profile ? { permissionProfile: profile } : {}) },
        () => {},
        { createRpc },
      )
      void connection.prompt("hi").catch(() => {})
      await vi.waitFor(() => expect(turns.length).toBeGreaterThan(0))
      connection.close()
      turns.length = 0
    }
    // thread 基底:sandbox + approvalPolicy;不再下发 network config(turn 级接管)
    expect(starts[0]).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "never" })
    expect(starts[1]).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request" })
    expect(starts[2]).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" })
    for (const start of starts) expect(start).not.toHaveProperty("config")
  })

  it("会话中切档:后续 turn/start 带新档位的 policy", async () => {
    const turns: Record<string, unknown>[] = []
    const createRpc: RpcFactory = async () => ({
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thr-switch" } }
        if (method === "turn/start") {
          turns.push(params ?? {})
          return { turn: { id: "turn-s", status: "inProgress" } }
        }
        return {}
      },
      notify: () => {}, onExit: () => () => {}, close: () => {},
    } as unknown as CodexRpc)
    const connection = await codexDriver.start(
      { cwd: "/tmp", permissionProfile: "restricted" },
      () => {},
      { createRpc },
    )
    void connection.prompt("one").catch(() => {})
    await vi.waitFor(() => expect(turns.length).toBe(1))
    await connection.setPermissionProfile?.("full")
    void connection.prompt("two").catch(() => {})
    await vi.waitFor(() => expect(turns.length).toBe(2))
    expect(turns[0]).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    })
    expect(turns[1]).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    })
    connection.close()
  })

  it("审批 hold:requestApproval 挂起,resolveApproval 兑现决议", async () => {
    const events: HarnessEvent[] = []
    let serverRequest: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
    const createRpc: RpcFactory = async (_cwd, handlers) => {
      serverRequest = handlers.onServerRequest
      return {
        request: async (method: string) => {
          if (method === "thread/start") return { thread: { id: "thr-apr" } }
          return {}
        },
        notify: () => {}, onExit: () => () => {}, close: () => {},
      } as unknown as CodexRpc
    }
    const connection = await codexDriver.start({ cwd: "/tmp" }, (event) => events.push(event), { createRpc })

    const pending = serverRequest!("item/commandExecution/requestApproval", {
      command: ["rm", "-rf", "/tmp/x"],
      reason: "需要删除目录",
    })
    // hold 期间请求事件已发出,带三个通用选项
    await vi.waitFor(() => expect(events.some((e) => e.type === "approval_request")).toBe(true))
    const request = events.find((e) => e.type === "approval_request")
    expect(request).toMatchObject({
      title: "rm -rf /tmp/x",
      detail: "需要删除目录",
      options: [
        { id: "allow_once", label: "允许一次" },
        { id: "allow_always", label: "本会话总是允许" },
        { id: "deny", label: "拒绝" },
      ],
    })
    // 决议兑现:allow_always → codex 的 acceptForSession
    connection.resolveApproval?.((request as { id: string }).id, "allow_always")
    await expect(pending).resolves.toEqual({ decision: "acceptForSession" })

    // cancel 竞态:hold 中的审批立即 decline,不等 RPC 回包
    const pending2 = serverRequest!("item/fileChange/requestApproval", { reason: "写工作区外" })
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === "approval_request").length).toBe(2))
    void connection.cancel()
    await expect(pending2).resolves.toEqual({ decision: "decline" })
    connection.close()
  })
})

describe("codexDriver usage 透传(TRACE_DATA_PLAN §7 P4)", () => {
  it("thread/tokenUsage/updated 的 tokenUsage 随 prompt() 返回", async () => {
    // 注入假 RPC,不起子进程:全量套件 fork 风暴下冷 spawn 曾把用例拖过
    // vitest 5s 天花板;stdio 帧协议的覆盖留给上面两个真实流程用例。
    let push: RpcHandlers["onNotification"] | undefined
    const createRpc: RpcFactory = async (_cwd, handlers) => {
      push = handlers.onNotification
      return {
        request: async (method: string) => {
          if (method === "thread/start") return { thread: { id: "thr-usage" } }
          if (method === "turn/start") {
            // queueMicrotask 让通知先于 driver 的 result 续体执行,
            // 走 finishedTurns 快路径(waiter 分支由真实流程用例覆盖)。
            queueMicrotask(() => {
              push?.("thread/tokenUsage/updated", { tokenUsage: { inputTokens: 1520, outputTokens: 430 } })
              push?.("turn/completed", { turn: { id: "turn-u", status: "completed" } })
            })
            return { turn: { id: "turn-u", status: "inProgress" } }
          }
          return {}
        },
        notify: () => {},
        onExit: () => () => {},
        close: () => {},
      } as unknown as CodexRpc
    }

    const connection = await codexDriver.start({ cwd: "/tmp" }, () => {}, { createRpc })
    // vendor 的 tokenUsage 是累计值,inputTokens/outputTokens 取最后一帧
    await expect(connection.prompt("hello")).resolves.toEqual({
      stopReason: "completed",
      usage: { inputTokens: 1520, outputTokens: 430 },
    })
  })
})

describe("Codex model/list", () => {
  it("只使用 app-server 返回的 wire model 与能力", () => {
    expect(parseCodexModelList({
      data: [
        {
          id: "catalog-entry",
          model: "wire-model",
          displayName: "Wire Model",
          description: "runtime-discovered",
          isDefault: true,
          defaultReasoningEffort: "xhigh",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "xhigh" },
          ],
        },
      ],
    })).toEqual({
      currentModelId: "wire-model",
      models: [{
        id: "wire-model",
        name: "Wire Model",
        description: "runtime-discovered",
        reasoning: true,
        efforts: ["low", "max"],
        defaultEffort: "max",
      }],
    })
  })

  it("完成 initialize → model/list 并关闭发现进程", { timeout: 30_000 }, async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-codex-model-list-"))
    const fakeCodex = path.join(tempDir, "codex")
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
rl.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") return send({ id: message.id, result: {} })
  if (message.method === "model/list") return send({ id: message.id, result: {
    data: [{ model: "runtime-model", displayName: "Runtime Model", isDefault: true }]
  } })
})
`)
    fs.chmodSync(fakeCodex, 0o755)
    process.env.BENTO_CODEX_PATH = fakeCodex
    configureBinaryManager(tempDir)

    await expect(discoverCodexModels(tempDir)).resolves.toEqual({
      currentModelId: "runtime-model",
      models: [{ id: "runtime-model", name: "Runtime Model", reasoning: false }],
    })
  })
})
