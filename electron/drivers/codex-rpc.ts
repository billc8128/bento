import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

type JsonObject = Record<string, unknown>
type PendingRequest = {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly exitListeners = new Set<(code: number | null) => void>()
  private nextId = 1
  private exitCode: number | null | undefined

  constructor(
    binaryPath: string,
    cwd: string,
    private readonly onNotification: (method: string, params: JsonObject) => void,
    private readonly onServerRequest: (method: string, params: JsonObject) => Promise<JsonObject>,
    /** user provider 会话的隔离 env(CODEX_HOME 等);缺省继承宿主 env */
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.child = spawn(binaryPath, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (data: string) => console.error("[codex]", data.trimEnd()))

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on("line", (line) => this.handleLine(line))
    this.child.on("error", () => this.handleExit(null))
    this.child.on("exit", (code) => this.handleExit(code))
  }

  request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<JsonObject>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`codex RPC 超时(${rpcTimeoutMs(method) / 1000}s): ${method}`))
    }, rpcTimeoutMs(method))
    this.pending.set(id, { resolve, reject, timer })
    this.write({ id, method, params })
    return promise
  }

  notify(method: string, params: JsonObject = {}) {
    this.write({ method, params })
  }

  close() {
    this.child.stdin.end()
    if (this.child.exitCode === null) this.child.kill("SIGTERM")
  }

  onExit(callback: (code: number | null) => void) {
    if (this.exitCode !== undefined) callback(this.exitCode)
    else this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  private write(message: JsonObject) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleExit(code: number | null) {
    if (this.exitCode !== undefined) return
    this.exitCode = code
    const error = new Error(`codex app-server 退出(${code ?? "signal"})`)
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const listener of this.exitListeners) listener(code)
  }

  private handleLine(line: string) {
    if (!line.trim()) return
    let message: JsonObject
    try {
      message = JSON.parse(line) as JsonObject
    } catch {
      console.error("[codex] 非 JSON 输出:", line.slice(0, 500))
      return
    }

    const id = typeof message.id === "number" ? message.id : undefined
    const method = typeof message.method === "string" ? message.method : undefined
    if (id !== undefined && !method) {
      const request = this.pending.get(id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(id)
      if (message.error) {
        const error = message.error as { message?: string }
        request.reject(new Error(error.message ?? "Codex RPC 失败"))
      } else {
        request.resolve((message.result as JsonObject | undefined) ?? {})
      }
      return
    }

    const params = (message.params as JsonObject | undefined) ?? {}
    if (id !== undefined && method) {
      void this.onServerRequest(method, params).then(
        (result) => this.write({ id, result }),
        (error) => this.write({
          id,
          error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
        }),
      )
      return
    }
    if (method) this.onNotification(method, params)
  }
}

/**
 * 按方法分级超时:进程冷启动(initialize)与 thread 建立可能明显慢于
 * 普通控制请求,统一 30s 在慢机上偏紧。控制类 30s,生命周期类 90s。
 */
function rpcTimeoutMs(method: string): number {
  if (method === "initialize" || method === "model/list" || method.startsWith("thread/")) return 90_000
  return 30_000
}
