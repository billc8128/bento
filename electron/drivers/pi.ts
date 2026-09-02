import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"

import { countContentLines, diffStatFromOldNew } from "../../src/core/diffstat"
import { harnessUsage } from "./usage"
import type { HarnessEvent, HarnessToolDiff, HarnessToolKind, HarnessUsage } from "../../src/core/events"
import { normalizePromptInput, type Effort, type PromptInput } from "../../src/core/types"
import { resolveHarnessRuntime, type HarnessRuntimePreference } from "../harness-runtime"
import { resolvePiRpcEntry } from "../pi-rpc-entry"
import type { HarnessCapabilities, HarnessConnection, HarnessDriver } from "./types"

export const PI_CAPABILITIES: HarnessCapabilities = {
  modelSwitch: "live",
  effortSwitch: "live",
  steer: "live",
}

type RpcResponse = {
  id?: string
  type: "response"
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type PiInputCommand = {
  type: "prompt" | "steer"
  message: string
  images?: Array<{ type: "image"; data: string; mimeType: string }>
}

type PiCommand = { cmd: string; args: string[] }

export function resolvePiCommand(preference: HarnessRuntimePreference): Promise<PiCommand> {
  return resolveHarnessRuntime(
    "pi",
    preference,
    (cmd) => ({ cmd, args: ["--mode", "rpc", "--approve"] }),
    async () => ({ cmd: process.execPath, args: [resolvePiRpcEntry(), "--approve"] }),
  )
}

/** prompt 与 steer 必须共享完全相同的附件语义：普通文件作为本地路径上下文，
 * 图片走 Pi RPC 原生 image content。 */
function piInputCommand(type: PiInputCommand["type"], value: string | PromptInput): PiInputCommand {
  const input = normalizePromptInput(value)
  const files = input.attachments.filter((attachment) => attachment.kind === "file")
  const message = files.length === 0
    ? input.text
    : `${input.text}\n\n附件文件：\n${files.map((file) => `- ${file.path}`).join("\n")}`
  const images = input.attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      type: "image" as const,
      data: fs.readFileSync(attachment.path).toString("base64"),
      mimeType: attachment.mimeType,
    }))
  return { type, message, ...(images.length ? { images } : {}) }
}
function toolKind(name: string): HarnessToolKind {
  if (name === "read" || name === "ls") return "read"
  if (name === "edit" || name === "write") return "edit"
  if (name === "grep" || name === "find" || name.includes("search")) return "search"
  return "bash"
}

/** §4:Pi 内置 edit 的 args 是 {path, edits:[{oldText,newText}]} 逐项聚合;
 * write 是 {path, content} 全量 added。无路径或字段缺失不出统计(缺省降级)。 */
function piToolDiffs(name: string, args: Record<string, unknown>): HarnessToolDiff[] | undefined {
  const path = typeof args.path === "string" ? args.path : undefined
  if (!path) return undefined
  if (name === "write") {
    if (typeof args.content !== "string") return undefined
    return [{ path, added: countContentLines(args.content), deleted: 0 }]
  }
  if (name === "edit") {
    const edits = args.edits
    if (!Array.isArray(edits)) return undefined
    let added = 0
    let deleted = 0
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue
      const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown }
      if (typeof oldText !== "string" || typeof newText !== "string") continue
      const stat = diffStatFromOldNew(oldText, newText)
      added += stat.added
      deleted += stat.deleted
    }
    return added + deleted > 0 ? [{ path, added, deleted }] : undefined
  }
  return undefined
}

function detail(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** 上游错误形如 `401: {"code":..,"message":"令牌已过期…"}`,提取状态码 + message 字段;解析不了就原样返回。 */
function piErrorText(raw: string): string {
  const match = /^(\d+):\s*(\{.*)$/s.exec(raw)
  if (!match) return raw
  try {
    const parsed = JSON.parse(match[2]) as { message?: unknown }
    if (typeof parsed.message === "string" && parsed.message) {
      return `${match[1]} ${parsed.message}`
    }
  } catch {
    /* 保留原文 */
  }
  return raw
}

export function translatePiEvent(value: unknown): HarnessEvent | undefined {
  if (!value || typeof value !== "object") return undefined
  const event = value as Record<string, unknown>

  if (event.type === "extension_error") {
    const message = String(event.error ?? "未知错误")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<redacted>")
    return { type: "notice", text: `Pi 扩展错误:${message}` }
  }

  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined
    if (update?.type === "text_delta") {
      return { type: "agent_message_chunk", text: String(update.delta ?? "") }
    }
    if (update?.type === "thinking_delta") {
      return { type: "agent_thought_chunk", text: String(update.delta ?? "") }
    }
    return undefined
  }

  if (event.type === "tool_execution_start") {
    const name = String(event.toolName ?? "tool")
    const args = (event.args ?? {}) as Record<string, unknown>
    const path = typeof args.path === "string" ? args.path : undefined
    const diffs = piToolDiffs(name, args)
    return {
      type: "tool_started",
      id: String(event.toolCallId ?? "unknown"),
      kind: toolKind(name),
      // args 带路径时 title 从工具名改为真实目标(§4)
      title: path ?? name,
      status: "running",
      ...(diffs ? { diffs } : {}),
    }
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "tool_updated",
      id: String(event.toolCallId ?? "unknown"),
      ...(detail(event.partialResult) ? { detail: detail(event.partialResult) } : {}),
    }
  }

  if (event.type === "tool_execution_end") {
    // §7:result 文本已全量进 detail,output 只在比 detail 更全时才接;
    // 当前 detail 就是全量输出,不重复接线(扩充输出面板留给 ACP/Codex 这类丢弃方)。
    return {
      type: "tool_updated",
      id: String(event.toolCallId ?? "unknown"),
      status: event.isError ? "failed" : "completed",
      ...(detail(event.result) ? { detail: detail(event.result) } : {}),
    }
  }
  // 错误终态只挂在 turn_end 的 assistant 消息上(message_end 会更早重复同一份),
  // 翻译成 notice 上屏并落盘,否则上游 4xx(订阅失效/令牌过期)会被吞成静默空回复
  if (event.type === "turn_end") {
    const message = event.message as Record<string, unknown> | undefined
    if (message?.stopReason === "error" && typeof message.errorMessage === "string") {
      return { type: "notice", text: `模型请求失败:${piErrorText(message.errorMessage)}` }
    }
    return undefined
  }

  return undefined
}

class PiRpcProcess {
  private readonly child: ChildProcess
  private buffer = ""
  private nextId = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly exitListeners = new Set<(code: number | null) => void>()
  private turn: { resolve: () => void; reject: (error: Error) => void } | undefined
  /** §7 P4:turn_end 的 assistant 消息带 usage(input/output/cost.total) */
  usage: HarnessUsage | undefined
  private exitCode: number | null | undefined

  constructor(
    command: PiCommand,
    cwd: string,
    nativeSessionId: string | undefined,
    private readonly emit: (event: HarnessEvent) => void,
    proxyEnv?: { env: Record<string, string>; strip?: string[] },
    app?: { args?: string[]; env?: Record<string, string> },
  ) {
    const args = [...command.args]
    args.push(...(app?.args ?? []))
    if (nativeSessionId) args.push("--session", nativeSessionId)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        !(proxyEnv?.strip ?? []).some((prefix) => key.startsWith(prefix))),
    )
    this.child = spawn(command.cmd, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, ...proxyEnv?.env, ...app?.env, ELECTRON_RUN_AS_NODE: "1" },
    })
    this.child.stdout!.on("data", (chunk: Buffer) => this.read(chunk.toString()))
    this.child.stderr!.on("data", (chunk: Buffer) => {
      console.error("[pi]", chunk.toString().trimEnd())
    })
    this.child.on("exit", (code) => this.handleExit(code))
    this.child.on("error", (error) => this.fail(error))
  }

  private read(chunk: string) {
    this.buffer += chunk
    while (true) {
      const end = this.buffer.indexOf("\n")
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      this.handle(JSON.parse(line) as Record<string, unknown>)
    }
  }

  private handle(frame: Record<string, unknown>) {
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      const response = frame as RpcResponse
      if (response.success) pending.resolve(response)
      else pending.reject(new Error(response.error ?? `${response.command} 失败`))
      return
    }
    if (frame.type === "turn_end") {
      const message = frame.message as
        | { usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } } }
        | undefined
      this.usage = harnessUsage({
        inputTokens: message?.usage?.input,
        outputTokens: message?.usage?.output,
        cost: message?.usage?.cost?.total,
      })
    }
    const event = translatePiEvent(frame)
    if (event) this.emit(event)
    if (frame.type === "agent_end") {
      this.turn?.resolve()
      this.turn = undefined
    }
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.turn?.reject(error)
    this.turn = undefined
  }

  private handleExit(code: number | null) {
    this.exitCode = code
    this.fail(new Error(`Pi 进程退出(${code ?? "signal"})`))
    for (const listener of this.exitListeners) listener(code)
  }

  request(command: Record<string, unknown>): Promise<RpcResponse> {
    const id = `bento-${++this.nextId}`
    const line = `${JSON.stringify({ id, ...command })}\n`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin!.write(line, (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async prompt(value: string | PromptInput) {
    if (this.turn) throw new Error("Pi 正在处理上一轮请求")
    this.usage = undefined
    const completed = new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject }
    })
    try {
      await this.request(piInputCommand("prompt", value))
      await completed
    } catch (error) {
      this.turn = undefined
      throw error
    }
  }

  async steer(value: string | PromptInput) {
    await this.request(piInputCommand("steer", value))
  }

  onExit(callback: (code: number | null) => void) {
    if (this.exitCode !== undefined) callback(this.exitCode)
    else this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  close() {
    this.child.kill()
  }
}

function thinkingLevel(effort: Effort) {
  if (effort === "max") return "xhigh"
  if (effort === "auto") return "medium"
  return effort
}

export function piModelRef(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) throw new Error(`Pi 模型必须形如 provider/model: ${value}`)
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

export const piDriver: HarnessDriver = {
  id: "pi",
  async start(options, emit): Promise<HarnessConnection> {
    const command = await resolvePiCommand(
      options.runtimePreference ?? (options.proxyEnv ? "managed" : "local"),
    )
    const rpc = new PiRpcProcess(command, options.cwd, options.nativeSessionId, emit, options.proxyEnv, {
      args: options.appArgs,
      env: options.appEnv,
    })
    const state = await rpc.request({ type: "get_state" })
    const data = state.data as { sessionFile?: string; sessionId: string }
    if (options.modelId) {
      await rpc.request({ type: "set_model", ...piModelRef(options.modelId) })
    }
    if (options.effort) {
      await rpc.request({ type: "set_thinking_level", level: thinkingLevel(options.effort) })
    }

    return {
      nativeSessionId: data.sessionFile ?? data.sessionId,
      capabilities: PI_CAPABILITIES,
      async prompt(input) {
        await rpc.prompt(input)
        return { stopReason: "end_turn", ...(rpc.usage ? { usage: rpc.usage } : {}) }
      },
      async steer(input) {
        await rpc.steer(input)
      },
      async cancel() {
        await rpc.request({ type: "abort" })
      },
      close: () => rpc.close(),
      onExit: (callback) => rpc.onExit(callback),
      async setModel(modelId) {
        await rpc.request({ type: "set_model", ...piModelRef(modelId) })
      },
      async setEffort(effort) {
        await rpc.request({ type: "set_thinking_level", level: thinkingLevel(effort) })
      },
    }
  },
}
