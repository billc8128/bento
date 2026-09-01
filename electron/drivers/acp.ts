import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import * as acp from "@agentclientprotocol/sdk"

import { managedBinary, managedUvxBinary } from "../binaries/manager"
import { localHarnessExecutable } from "../harness-runtime"
import { harnessUsage } from "./usage"
import { translateAcpUpdate } from "./acp-translator"
import type { HarnessUsage } from "../../src/core/events"
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

type AcpDriverId = Extract<DriverId, "kimi" | "opencode" | "omp" | "hermes">

type AcpOpenResult = {
  child: ChildProcess
  conn: acp.ClientSideConnection
  init: acp.InitializeResponse
}

type AcpOpen = (
  cwd: string,
  emit: Parameters<HarnessDriver["start"]>[1],
  isLoading: () => boolean,
  proxyEnv?: HarnessStartOptions["proxyEnv"],
  usage?: { current: HarnessUsage | undefined },
) => Promise<AcpOpenResult>

async function harnessCommand(id: AcpDriverId): Promise<SpawnSpec> {
  const local = localHarnessExecutable(id)
  if (local) {
    return {
      cmd: local.path,
      args: ["acp"],
    }
  }
  switch (id) {
    case "kimi":
      return { cmd: await managedBinary("kimi"), args: ["acp"] }
    case "opencode":
      return { cmd: await managedBinary("opencode"), args: ["acp"] }
    case "omp":
      return { cmd: await managedBinary("omp"), args: ["acp"] }
    case "hermes":
      return {
        cmd: await managedUvxBinary(),
        args: ["--python", "3.12", "--from", "hermes-agent[acp]==0.19.0", "hermes-acp"],
      }
  }
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
  ) {
    const spec = await harnessCommand(this.id)
    // provider 会话若有 host 路由 env,先 strip 宿主同名前缀再注入。
    const merged: SpawnSpec = proxyEnv
      ? {
          ...spec,
          env: { ...spec.env, ...proxyEnv.env },
          strip: [...new Set([...(spec.strip ?? []), ...(proxyEnv.strip ?? [])])],
        }
      : spec
    const child = spawn(merged.cmd, merged.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: cleanEnv(merged),
    })
    child.stderr.on("data", (data: Buffer) => {
      console.error(`[${this.id}]`, data.toString().trimEnd())
    })

    const clientImpl: acp.Client = {
      async requestPermission(params) {
        const allow = params.options.find((item) => item.kind === "allow_once") ?? params.options[0]
        // §3.4:许可批准不是回合级事件,notice 会终结 draft 并让后续
        // tool_call_update 落空;改道 metadata,审批痕迹照常落盘、不渲染。
        emit({
          type: "metadata",
          name: "permission/auto_approved",
          data: { title: params.toolCall?.title ?? "工具调用" },
        })
        return { outcome: { outcome: "selected", optionId: allow.optionId } }
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
      init = await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
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
    const injectedOpen = deps?.open as AcpOpen | undefined
    const { child, conn, init } = await (injectedOpen ?? this.open.bind(this))(
      options.cwd,
      emit,
      () => loading,
      options.proxyEnv,
      usage,
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
            value: this.id === "omp" ? (effort === "off" ? "off" : "auto") : effort,
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
    usage?: { current: HarnessUsage | undefined },
    supportsImages = false,
  ): HarnessConnection {
    const exitListeners = new Set<(code: number | null) => void>()
    let exitCode: number | null | undefined
    child.on("exit", (code) => {
      exitCode = code
      for (const listener of exitListeners) listener(code)
    })
    return {
      nativeSessionId,
      capabilities: {
        modelSwitch: selection.setModel ? "live" : "none",
        effortSwitch: selection.setEffort ? "live" : "none",
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
      cancel: () => conn.cancel({ sessionId: nativeSessionId }),
      close: () => child.kill(),
      onExit(callback) {
        if (exitCode !== undefined) callback(exitCode)
        else exitListeners.add(callback)
        return () => exitListeners.delete(callback)
      },
      ...(selection.setModel ? { setModel: async (modelId: string) => { await selection.setModel!(modelId) } } : {}),
      ...(selection.setEffort ? { setEffort: async (effort) => { await selection.setEffort!(effort) } } : {}),
    }
  }
}

export function createAcpDriver(id: AcpDriverId): HarnessDriver {
  return new AcpDriver(id)
}
