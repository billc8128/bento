import type { Effort, PromptInput } from "../../src/core/types"
import type { ApprovalDecision, HarnessUsage } from "../../src/core/events"
import { codexSandboxPolicy, codexThreadPolicy, type PermissionProfile } from "../../src/core/permission"
import type { ProviderModel } from "../../src/core/provider"
import { managedCodexBinary } from "../binaries/manager"
import { assertHarnessCwd, resolveHarnessRuntime, type HarnessRuntimePreference } from "../runtime/harness-runtime"
import { CodexRpc } from "./codex-rpc"
import { translateCodexNotification } from "./codex-translator"
import { harnessUsage } from "./usage"
import { normalizePromptInput } from "../../src/core/types"
import type { ProviderDiscoveryResult } from "../providers/provider-discovery"
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
    // 权限档位:turn/start 每回合现读,会话中切档后续回合即生效(live)
    let profile = options.permissionProfile ?? "standard"
    const turnWaiters = new Map<string, (status: string) => void>()
    const finishedTurns = new Map<string, string>()
    // 审批 hold:requestApproval 的 Promise 挂在 waiter 上等渲染端决议;
    // cancel/close/进程退出都必须立即 decline,不等 RPC 回包(cancel 竞态)。
    const approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>()
    const settleApprovals = (decision: ApprovalDecision) => {
      for (const waiter of approvalWaiters.values()) waiter(decision)
      approvalWaiters.clear()
    }
    let approvalSeq = 0
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
          // 审批闭环:emit 请求事件后 hold 住,等 main 转达渲染端决议。
          // approval_resolved 由 main 统一落盘(single event source),driver 只负责兑现。
          const id = `apr-${++approvalSeq}`
          const command = Array.isArray(params.command) ? params.command.join(" ") : undefined
          const title = command ?? String(params.reason ?? method)
          emit({
            type: "approval_request",
            id,
            title,
            // reason 与 title 同源时不重复展示
            ...(params.reason && String(params.reason) !== title
              ? { detail: String(params.reason) }
              : {}),
            options: [
              { id: "allow_once", label: "允许一次" },
              { id: "allow_always", label: "本会话总是允许" },
              { id: "deny", label: "拒绝" },
            ],
          })
          const decision = await new Promise<ApprovalDecision>((resolve) => {
            approvalWaiters.set(id, resolve)
          })
          return {
            decision: decision === "allow_once"
              ? "accept"
              : decision === "allow_always"
                ? "acceptForSession"
                : "decline",
          }
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
      settleApprovals("deny")
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

    // thread 基底策略(src/core/permission 单一真源);网络与逐回合审批改由
    // turn/start 级 sandboxPolicy/approvalPolicy 覆盖(0.149.1 实测支持),
    // M1 的 sandbox_workspace_write.network_access config 退路同步移除。
    const policy = codexThreadPolicy(profile)
    const threadParams: JsonObject = {
      cwd: options.cwd,
      ...(modelId ? { model: modelId } : {}),
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
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
      capabilities: { modelSwitch: "live", effortSwitch: "live", steer: "live", permissionSwitch: "live" },
      async prompt(input) {
        const response = await rpc.request("turn/start", {
          threadId,
          input: userInput(input),
          ...(modelId ? { model: modelId } : {}),
          effort: wireEffort(effort),
          // 逐回合随当前档位下发:切档后续回合即生效
          approvalPolicy: codexThreadPolicy(profile).approvalPolicy,
          sandboxPolicy: codexSandboxPolicy(profile),
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
        // cancel 竞态:hold 中的审批立即 decline,不等 interrupt 后的 RPC 回包
        settleApprovals("deny")
        if (activeTurnId) await rpc.request("turn/interrupt", { threadId, turnId: activeTurnId })
      },
      close: () => {
        settleApprovals("deny")
        rpc.close()
      },
      onExit: (callback) => rpc.onExit(callback),
      async setModel(nextModelId) {
        modelId = nextModelId
      },
      async setEffort(nextEffort) {
        effort = nextEffort
      },
      async setPermissionProfile(next: PermissionProfile) {
        profile = next
      },
      resolveApproval(id: string, decision: ApprovalDecision) {
        // main 已先把 approval_resolved 落盘;此处只兑现 hold 中的 Promise,幂等
        const waiter = approvalWaiters.get(id)
        if (!waiter) return
        approvalWaiters.delete(id)
        waiter(decision)
      },
    }
  },
}
