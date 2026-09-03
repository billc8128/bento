import type { Effort, PromptInput } from "../../src/core/types"
import type { HarnessUsage } from "../../src/core/events"
import type { ProviderModel } from "../../src/core/provider"
import { managedCodexBinary } from "../binaries/manager"
import { assertHarnessCwd, resolveHarnessRuntime, type HarnessRuntimePreference } from "../harness-runtime"
import { CodexRpc } from "./codex-rpc"
import { translateCodexNotification } from "./codex-translator"
import { harnessUsage } from "./usage"
import { normalizePromptInput } from "../../src/core/types"
import type { ProviderDiscoveryResult } from "../provider-discovery"
import type { HarnessConnection, HarnessDriver } from "./types"

type JsonObject = Record<string, unknown>

function wireEffort(effort: Effort) {
  return effort === "max" ? "xhigh" : effort
}

function bentoEffort(value: unknown): Effort | undefined {
  if (value === "xhigh") return "max"
  return value === "low" || value === "medium" || value === "high" ? value : undefined
}

export function parseCodexModelList(value: JsonObject): ProviderDiscoveryResult {
  const data = Array.isArray(value.data) ? value.data : []
  let currentModelId: string | undefined
  const models: ProviderModel[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as JsonObject
    const id = typeof item.model === "string" ? item.model : typeof item.id === "string" ? item.id : ""
    if (!id) continue
    const efforts = (Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts
      : [])
      .map((entry) =>
        bentoEffort(
          entry && typeof entry === "object"
            ? (entry as JsonObject).reasoningEffort
            : entry,
        ),
      )
      .filter((entry): entry is Effort => Boolean(entry))
    const defaultEffort = bentoEffort(item.defaultReasoningEffort)
    models.push({
      id,
      name: typeof item.displayName === "string" ? item.displayName : id,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      reasoning: efforts.length > 0,
      ...(efforts.length > 0 ? { efforts: [...new Set(efforts)] } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
    })
    if (item.isDefault === true) currentModelId = id
  }
  return { models, ...(currentModelId ? { currentModelId } : {}) }
}

/** RPC 构造可注入:测试传 fake 验证参数契约,不 spawn 真进程 */
type RpcFactory = (
  cwd: string,
  handlers: RpcHandlers,
  env?: NodeJS.ProcessEnv,
  runtimePreference?: HarnessRuntimePreference,
) => CodexRpc | Promise<CodexRpc>

type RpcHandlers = {
  onNotification: (method: string, params: JsonObject) => void
  onServerRequest: (method: string, params: JsonObject) => Promise<JsonObject>
}

function defaultCreateRpc(
  cwd: string,
  handlers: RpcHandlers,
  env?: NodeJS.ProcessEnv,
  runtimePreference: HarnessRuntimePreference = "managed",
): Promise<CodexRpc> {
  return resolveHarnessRuntime(
    "codex",
    runtimePreference,
    (path) => path,
    managedCodexBinary,
  ).then(
    (binary) => new CodexRpc(binary, cwd, handlers.onNotification, handlers.onServerRequest, env),
  )
}

export async function discoverCodexModels(
  cwd: string,
  env?: NodeJS.ProcessEnv,
  deps: { createRpc?: RpcFactory; runtimePreference?: HarnessRuntimePreference } = {},
): Promise<ProviderDiscoveryResult> {
  assertHarnessCwd(cwd)
  const createRpc = deps.createRpc ?? defaultCreateRpc
  const rpc = await createRpc(cwd, {
    onNotification: () => {},
    onServerRequest: async (method) => {
      throw new Error(`模型发现不支持 Codex 服务端请求: ${method}`)
    },
  }, env, deps.runtimePreference)
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "bento", title: "Bento", version: "0.3.1" },
      capabilities: {},
    })
    rpc.notify("initialized")
    return parseCodexModelList(await rpc.request("model/list"))
  } finally {
    rpc.close()
  }
}

export const codexDriver: HarnessDriver = {
  id: "codex",
  async start(
    options,
    emit,
    deps: { createRpc?: RpcFactory } = {},
  ): Promise<HarnessConnection> {
    let activeTurnId: string | undefined
    let modelId = options.modelId
    let effort = options.effort ?? "high"
    const turnWaiters = new Map<string, (status: string) => void>()
    const finishedTurns = new Map<string, string>()
    // §7 P4:thread/tokenUsage/updated 是累计值,turn 末尾的最后一次即最新
    // 用量;捕获留在闭包里,随 turn/completed 的 waiter 一并透出。
    let latestUsage: HarnessUsage | undefined

    const handlers: RpcHandlers = {
      onNotification(method, params) {
        if (method === "thread/tokenUsage/updated") {
          const tokenUsage = params.tokenUsage as JsonObject | undefined
          latestUsage = harnessUsage({
            inputTokens: tokenUsage?.inputTokens,
            outputTokens: tokenUsage?.outputTokens,
          })
        }
        for (const event of translateCodexNotification(method, params)) emit(event)
        if (method === "turn/completed") {
          const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined
          if (!turn?.id) return
          if (turn.error?.message) emit({ type: "notice", text: turn.error.message })
          const waiter = turnWaiters.get(turn.id)
          if (waiter) {
            turnWaiters.delete(turn.id)
            waiter(turn.status ?? "completed")
          } else {
            finishedTurns.set(turn.id, turn.status ?? "completed")
          }
          if (activeTurnId === turn.id) activeTurnId = undefined
        }
      },
      async onServerRequest(method, params) {
        if (method.includes("requestApproval")) {
          emit({
            type: "notice",
            text: `Codex 请求了额外权限,当前 workspace-write/never 策略已拒绝或无需确认:${String(params.reason ?? method)}`,
          })
          return { decision: "decline" }
        }
        throw new Error(`Bento 尚不支持 Codex 服务端请求: ${method}`)
      },
    }

    const createRpc = (deps.createRpc ?? defaultCreateRpc) as RpcFactory
    const rpc = await createRpc(
      options.cwd,
      handlers,
      options.proxyEnv?.env,
      "managed",
    )
    rpc.onExit(() => {
      for (const waiter of turnWaiters.values()) waiter("process_exit")
      turnWaiters.clear()
    })

    try {
      await rpc.request("initialize", {
        clientInfo: { name: "bento", title: "Bento", version: "0.3.1" },
        capabilities: {},
      })
      rpc.notify("initialized")
    } catch (error) {
      rpc.close()
      throw error
    }

    const threadParams: JsonObject = {
      cwd: options.cwd,
      ...(modelId ? { model: modelId } : {}),
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ...(options.mcpServers?.length ? {
        config: {
          mcp_servers: Object.fromEntries(options.mcpServers.map((server) => [
            "bento-apps",
            { command: server.command, args: server.args, env: server.env },
          ])),
        },
      } : {}),
    }
    let thread: JsonObject
    if (options.nativeSessionId) {
      try {
        const resumed = await rpc.request("thread/resume", {
          threadId: options.nativeSessionId,
          ...threadParams,
        })
        thread = resumed.thread as JsonObject
      } catch {
        const created = await rpc.request("thread/start", threadParams)
        thread = created.thread as JsonObject
        emit({ type: "notice", text: "Codex 原会话无法恢复,已开新上下文续接" })
      }
    } else {
      const created = await rpc.request("thread/start", threadParams)
      thread = created.thread as JsonObject
    }
    const threadId = String(thread.id)

    const userInput = (input: string | PromptInput): JsonObject[] => {
      const request = normalizePromptInput(input)
      const values: JsonObject[] = [{ type: "text", text: request.text }]
      for (const attachment of request.attachments) {
        values.push(attachment.kind === "image"
          ? { type: "localImage", path: attachment.path }
          : { type: "mention", name: attachment.name, path: attachment.path })
      }
      return values
    }

    return {
      nativeSessionId: threadId,
      capabilities: { modelSwitch: "live", effortSwitch: "live", steer: "live" },
      async prompt(input) {
        const response = await rpc.request("turn/start", {
          threadId,
          input: userInput(input),
          ...(modelId ? { model: modelId } : {}),
          effort: wireEffort(effort),
        })
        const turn = response.turn as { id: string }
        activeTurnId = turn.id
        const completed = finishedTurns.get(turn.id)
        if (completed) {
          finishedTurns.delete(turn.id)
          activeTurnId = undefined
          return { stopReason: completed, ...(latestUsage ? { usage: latestUsage } : {}) }
        }
        const { promise, resolve } = Promise.withResolvers<{ stopReason?: string; usage?: HarnessUsage }>()
        turnWaiters.set(turn.id, (status) => resolve({ stopReason: status, ...(latestUsage ? { usage: latestUsage } : {}) }))
        return promise
      },
      async steer(input) {
        if (!activeTurnId) throw new Error("当前没有可引导的 Codex 回合")
        await rpc.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurnId,
          input: userInput(input),
        })
      },
      async cancel() {
        if (activeTurnId) await rpc.request("turn/interrupt", { threadId, turnId: activeTurnId })
      },
      close: () => rpc.close(),
      onExit: (callback) => rpc.onExit(callback),
      async setModel(nextModelId) {
        modelId = nextModelId
      },
      async setEffort(nextEffort) {
        effort = nextEffort
      },
    }
  },
}
