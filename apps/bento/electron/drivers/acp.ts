import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import * as acp from "@agentclientprotocol/sdk"

import { managedBinary, managedUvxBinary } from "../binaries/manager"
import { HERMES_AGENT_VERSION, resolveHarnessRuntime } from "../runtime/harness-runtime"
import { resolveRealPath } from "../platform/realpath"
import { harnessUsage } from "./usage"
import { translateAcpUpdate } from "./acp-translator"
import type { ApprovalDecision, HarnessUsage } from "../../src/core/events"
import { triageAcpToolCall, type PermissionProfile } from "../../src/core/permission"
import { normalizePromptInput } from "../../src/core/types"
import type {
  HarnessConnection,
  HarnessDriver,
  DriverId,
  HarnessStartOptions,
} from "./types"

export function acpMcpServers(servers: NonNullable<HarnessStartOptions["mcpServers"]>): acp.McpServer[] {
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }))
}

/** 决议 → ACP 选项:allow_once/allow_always 各自优先同名变体,deny 优先 reject_once。
 *  deny 时连非 allow 选项都没有是协议外的病态情形,仍不落 allow 首项(fail-closed 取末项)。 */
export function pickAcpPermissionOption<T extends { kind: string }>(
  decision: ApprovalDecision,
  options: T[],
): T {
  const wanted = decision === "allow_once"
    ? ["allow_once", "allow_always"]
    : decision === "allow_always"
      ? ["allow_always", "allow_once"]
      : ["reject_once", "reject_always"]
  const hit = wanted
    .map((kind) => options.find((item) => item.kind === kind))
    .find(Boolean)
  if (hit) return hit
  if (decision === "deny") {
    const nonAllow = options.find((item) => !item.kind.startsWith("allow"))
    return nonAllow ?? options[options.length - 1]
  }
  return options[0]
}

type SpawnSpec = {
  cmd: string
  args: string[]
  env?: Record<string, string>
  strip?: string[]
}

/**
 * SDK 1.4 未类型化 session/set_model(Hermes v0.19 已实现);经底层 Connection
 * 集中透传。模型 id 形如 `custom:<alias>:<model>`(spike 实证跨 provider live)。
 */
export async function sendLegacySessionModel(
  conn: acp.ClientSideConnection,
  sessionId: string,
  modelId: string,
): Promise<void> {
  const channel = (conn as unknown as {
    connection?: { sendRequest(method: string, params: object): Promise<unknown> }
  }).connection
  if (!channel?.sendRequest) throw new Error("ACP 连接不支持 session/set_model")
  await channel.sendRequest("session/set_model", { sessionId, modelId })
}

type AcpDriverId = Extract<DriverId, "kimi" | "opencode" | "omp" | "hermes" | "trae">

type AcpOpenResult = {
  child: ChildProcess
  conn: acp.ClientSideConnection
  init: acp.InitializeResponse
}

/** 审批 hold 的共享状态:open(clientImpl 发起)与 connection(结算/取消兑现)两端共用 */
type AcpApprovals = {
  waiters: Map<string, (decision: ApprovalDecision) => void>
  seq: number
}

type AcpOpen = (
  cwd: string,
  emit: Parameters<HarnessDriver["start"]>[1],
  isLoading: () => boolean,
  proxyEnv?: HarnessStartOptions["proxyEnv"],
  usage?: { current: HarnessUsage | undefined },
  permission?: { current: PermissionProfile },
  approvals?: AcpApprovals,
  /** 追加到 spawn args 末尾(kimi 的 --skills-dir 等 adapter 租约参数)。 */
  extraArgs?: string[],
) => Promise<AcpOpenResult>

async function harnessCommand(id: AcpDriverId): Promise<SpawnSpec> {
  const acpArgs = id === "trae" ? ["acp", "serve"] : ["acp"]
  return resolveHarnessRuntime(
    id,
    "managed",
    (cmd) => ({ cmd, args: acpArgs }),
    async () => id === "hermes"
      ? {
          cmd: await managedUvxBinary(),
          args: ["--python", "3.12", "--from", `hermes-agent[acp]==${HERMES_AGENT_VERSION}`, "hermes-acp"],
        }
      : { cmd: await managedBinary(id), args: acpArgs },
  )
}

function cleanEnv(spec: SpawnSpec): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== "CLAUDECODE" &&
        !key.startsWith("CLAUDE_CODE_") &&
        !(spec.strip ?? []).some((prefix) => key.startsWith(prefix)),
    ),
  )
  env.ELECTRON_RUN_AS_NODE = "1"
  return { ...env, ...spec.env }
}

class AcpDriver implements HarnessDriver {
  constructor(readonly id: AcpDriverId) {}

  private async open(
    cwd: string,
    emit: Parameters<HarnessDriver["start"]>[1],
    isLoading: () => boolean,
    proxyEnv?: { env: Record<string, string>; strip?: string[] },
    usage?: { current: HarnessUsage | undefined },
    permission: { current: PermissionProfile } = { current: "standard" },
    approvals: AcpApprovals = { waiters: new Map(), seq: 0 },
    extraArgs?: string[],
  ) {
    // cwd 同样归一(macOS 的 /tmp 就是 symlink),两侧同口径才能比
    const realCwd = resolveRealPath(cwd)
    const spec = await harnessCommand(this.id)
    // provider 会话若有 host 路由 env,先 strip 宿主同名前缀再注入。
    const merged: SpawnSpec = proxyEnv
      ? {
          ...spec,
          env: { ...spec.env, ...proxyEnv.env },
          strip: [...new Set([...(spec.strip ?? []), ...(proxyEnv.strip ?? [])])],
        }
      : spec
    const child = spawn(merged.cmd, [...merged.args, ...(extraArgs ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: cleanEnv(merged),
    })
    const spawnFailure = Promise.withResolvers<never>()
    child.once("error", spawnFailure.reject)
    child.stderr.on("data", (data: Buffer) => {
      console.error(`[${this.id}]`, data.toString().trimEnd())
    })

    const clientImpl: acp.Client = {
      async requestPermission(params) {
        // 档位裁决(src/core/permission 单一真源;工具集近似,非硬边界)。
        // requestPermission 每次调用现读档位,会话中切换后续调用即生效。
        const title = params.toolCall?.title ?? "工具调用"
        // realpath 归一后再判工作区:cwd 内的 symlink 不能借字符串判定逃逸
        const toolCall = params.toolCall
          ? {
              ...params.toolCall,
              locations: params.toolCall.locations?.map((loc) => ({
                ...loc,
                path: resolveRealPath(loc.path),
              })),
            }
          : {}
        const triage = triageAcpToolCall(permission.current, toolCall, realCwd)
        if (triage !== "ask") {
          const option = pickAcpPermissionOption(triage === "allow" ? "allow_once" : "deny", params.options)
          // §3.4:许可批准不是回合级事件,notice 会终结 draft 并让后续
          // tool_call_update 落空;改道 metadata,审批痕迹照常落盘、不渲染。
          emit({
            type: "metadata",
            name: triage === "allow" ? "permission/auto_approved" : "permission/auto_denied",
            data: { title, profile: permission.current },
          })
          return { outcome: { outcome: "selected", optionId: option.optionId } }
        }
        // ask:审批闭环,hold 到渲染端决议(approval_resolved 由 main 统一落盘)
        const id = `apr-${++approvals.seq}`
        emit({
          type: "approval_request",
          id,
          title,
          detail: `${params.toolCall?.kind ?? "other"} 类工具请求权限(当前档位「${permission.current}」不自动放行)`,
          options: [
            { id: "allow_once", label: "允许一次" },
            { id: "allow_always", label: "本会话总是允许" },
            { id: "deny", label: "拒绝" },
          ],
        })
        const decision = await new Promise<ApprovalDecision>((resolve) => {
          approvals.waiters.set(id, resolve)
        })
        const option = pickAcpPermissionOption(decision, params.options)
        return { outcome: { outcome: "selected", optionId: option.optionId } }
      },
      async sessionUpdate(params) {
        // §7 P4:usage_update 是上下文窗口 + 会话累计成本,没有逐回合 token
        // 分解,只透出 cost。
        const update = params.update as { sessionUpdate?: string; cost?: { amount?: unknown } | null }
        if (update?.sessionUpdate === "usage_update" && usage) {
          usage.current = harnessUsage({ cost: update.cost?.amount })
        }
        if (!isLoading()) emit(translateAcpUpdate(params.update))
      },
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const conn = new acp.ClientSideConnection(() => clientImpl, stream)
    let init: acp.InitializeResponse
    try {
      init = await Promise.race([
        conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
        spawnFailure.promise,
      ])
    } catch (error) {
      child.kill()
      throw error
    }
    return { child, conn, init, usage }
  }

  async start(
    options: HarnessStartOptions,
    emit: Parameters<HarnessDriver["start"]>[1],
    deps?: Record<string, unknown>,
  ): Promise<HarnessConnection> {
    let loading = false
    let nativeSessionId = options.nativeSessionId
    let setup: unknown
    const mcpServers = acpMcpServers(options.mcpServers ?? [])
    const usage: { current: HarnessUsage | undefined } = { current: undefined }
    const permission = { current: options.permissionProfile ?? ("standard" as const) }
    const approvals: AcpApprovals = { waiters: new Map(), seq: 0 }
    const injectedOpen = deps?.open as AcpOpen | undefined
    const { child, conn, init } = await (injectedOpen ?? this.open.bind(this))(
      options.cwd,
      emit,
      () => loading,
      options.proxyEnv,
      usage,
      permission,
      approvals,
      options.appArgs,
    )
    if (nativeSessionId && init.agentCapabilities?.sessionCapabilities?.resume) {
      try {
        setup = await conn.resumeSession({ sessionId: nativeSessionId, cwd: options.cwd, mcpServers })
      } catch {
        const restored = await this.loadOrCreate(
          conn, init, options, emit, child, nativeSessionId, (value) => { loading = value },
        )
        nativeSessionId = restored.nativeSessionId
        setup = restored.setup
      }
    } else if (nativeSessionId) {
      const restored = await this.loadOrCreate(
        conn, init, options, emit, child, nativeSessionId, (value) => { loading = value },
      )
      nativeSessionId = restored.nativeSessionId
      setup = restored.setup
    } else {
      const created = await conn.newSession({ cwd: options.cwd, mcpServers })
      nativeSessionId = created.sessionId
      setup = created
    }

    const selection = await this.configureSession(conn, nativeSessionId, setup, options)
    return this.connection(
      child,
      conn,
      nativeSessionId,
      selection,
      permission,
      approvals,
      usage,
      init.agentCapabilities?.promptCapabilities?.image === true,
    )
  }

  private async loadOrCreate(
    conn: acp.ClientSideConnection,
    init: acp.InitializeResponse,
    options: HarnessStartOptions,
    emit: Parameters<HarnessDriver["start"]>[1],
    child: ChildProcess,
    nativeSessionId: string,
    setLoading: (value: boolean) => void,
  ): Promise<{ nativeSessionId: string; setup: unknown }> {
    if (init.agentCapabilities?.loadSession) {
      try {
        setLoading(true)
        const loaded = await conn.loadSession({
          sessionId: nativeSessionId,
          cwd: options.cwd,
          mcpServers: acpMcpServers(options.mcpServers ?? []),
        })
        return { nativeSessionId, setup: loaded }
      } catch {
        // fall through to a fresh native session
      } finally {
        setLoading(false)
      }
    }
    try {
      const created = await conn.newSession({
        cwd: options.cwd,
        mcpServers: acpMcpServers(options.mcpServers ?? []),
      })
      emit({ type: "notice", text: "该 harness 无法恢复原上下文,已开新上下文续接" })
      return { nativeSessionId: created.sessionId, setup: created }
    } catch (error) {
      child.kill()
      throw error
    }
  }

  private async configureSession(
    conn: acp.ClientSideConnection,
    sessionId: string,
    setup: unknown,
    options: HarnessStartOptions,
  ) {
    type ConfigOption = {
      id: string
      type: "select" | "boolean"
      category?: string | null
    }
    const configOptions = (setup as { configOptions?: ConfigOption[] } | undefined)?.configOptions ?? []
    const modelConfig = configOptions.find((item) => item.category === "model")
    const effortConfig = configOptions.find((item) => item.category === "thought_level")

    // Hermes 不暴露 model configOption,但 v0.19 的 session/set_model
    // 支持跨 provider 同进程切换(spike 实证),必须暴露 live 能力。
    const setModel = modelConfig
      ? (modelId: string) =>
          conn.setSessionConfigOption({ sessionId, configId: modelConfig.id, value: modelId })
      : this.id === "hermes"
        ? (modelId: string) => sendLegacySessionModel(conn, sessionId, modelId)
        : undefined
    const setEffort = effortConfig
      ? (effort: NonNullable<HarnessStartOptions["effort"]>) =>
          conn.setSessionConfigOption({
            sessionId,
            configId: effortConfig.id,
            value: effort,
          })
      : undefined

    if (options.modelId && setModel) await setModel(options.modelId)
    if (options.effort && setEffort) await setEffort(options.effort)
    return { setModel, setEffort }
  }

  private connection(
    child: ChildProcess,
    conn: acp.ClientSideConnection,
    nativeSessionId: string,
    selection: {
      setModel?: (modelId: string) => Promise<unknown>
      setEffort?: (effort: NonNullable<HarnessStartOptions["effort"]>) => Promise<unknown>
    },
    permission: { current: PermissionProfile },
    approvals: AcpApprovals,
    usage?: { current: HarnessUsage | undefined },
    supportsImages = false,
  ): HarnessConnection {
    const exitListeners = new Set<(code: number | null) => void>()
    let exitCode: number | null | undefined
    const finish = (code: number | null) => {
      if (exitCode !== undefined) return
      exitCode = code
      for (const listener of exitListeners) listener(code)
    }
    child.on("exit", finish)
    child.on("error", () => finish(null))
    // cancel 竞态与关闭:hold 中的审批立即 decline,不等 agent 回包
    const settleApprovals = () => {
      for (const waiter of approvals.waiters.values()) waiter("deny")
      approvals.waiters.clear()
    }
    return {
      nativeSessionId,
      capabilities: {
        modelSwitch: selection.setModel ? "live" : "none",
        effortSwitch: selection.setEffort ? "live" : "none",
        permissionSwitch: this.id === "trae" ? "none" : "live",
      },
      prompt: async (input) => {
        const request = normalizePromptInput(input)
        const prompt: acp.ContentBlock[] = [{ type: "text", text: request.text }]
        for (const attachment of request.attachments) {
          if (attachment.kind === "image" && supportsImages) {
            prompt.push({
              type: "image",
              data: fs.readFileSync(attachment.path).toString("base64"),
              mimeType: attachment.mimeType,
              uri: pathToFileURL(attachment.path).href,
            })
          } else {
            prompt.push({
              type: "resource_link",
              uri: pathToFileURL(attachment.path).href,
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
            })
          }
        }
        const result = (await conn.prompt({
          sessionId: nativeSessionId,
          prompt,
        })) as { stopReason?: string }
        return { stopReason: result?.stopReason, ...(usage?.current ? { usage: usage.current } : {}) }
      },
      cancel: () => {
        settleApprovals()
        return conn.cancel({ sessionId: nativeSessionId })
      },
      close: () => {
        settleApprovals()
        child.kill()
      },
      onExit(callback) {
        if (exitCode !== undefined) callback(exitCode)
        else exitListeners.add(callback)
        return () => exitListeners.delete(callback)
      },
      ...(selection.setModel ? { setModel: async (modelId: string) => { await selection.setModel!(modelId) } } : {}),
      ...(selection.setEffort ? { setEffort: async (effort) => { await selection.setEffort!(effort) } } : {}),
      ...(this.id === "trae" ? {} : {
        async setPermissionProfile(next: PermissionProfile) {
          permission.current = next
        },
      }),
      resolveApproval(id: string, decision: ApprovalDecision) {
        const waiter = approvals.waiters.get(id)
        if (!waiter) return
        approvals.waiters.delete(id)
        waiter(decision)
      },
    }
  }
}

export function createAcpDriver(id: AcpDriverId): HarnessDriver {
  return new AcpDriver(id)
}
