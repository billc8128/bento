import { randomUUID } from "node:crypto"
import fs from "node:fs"
import {
  query as createSdkQuery,
  type Options,
  type Query,
  type ModelInfo,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

import { ClaudeAgentTranslator } from "./claude-agent-translator"
import { harnessUsage } from "./usage"
import { resolveRealPath } from "../platform/realpath"
import { triageClaudeTool, type PermissionProfile } from "../../src/core/permission"
import type { ApprovalDecision } from "../../src/core/events"
import { assertHarnessCwd, resolveHarnessRuntime, type HarnessRuntimePreference } from "../runtime/harness-runtime"
import { normalizePromptInput } from "../../src/core/types"
import type { HarnessConnection, HarnessDriver, HarnessStartOptions } from "./types"
import type { ProviderDiscoveryResult } from "../providers/provider-discovery"

export type ClaudeQueryFactory = (params: Parameters<typeof createSdkQuery>[0]) => Query

const CLAUDE_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const
type ClaudeImageMediaType = (typeof CLAUDE_IMAGE_MEDIA_TYPES)[number]

function isClaudeImageMediaType(value: string): value is ClaudeImageMediaType {
  return CLAUDE_IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === value)
}

function claudeExecutable(preference: HarnessRuntimePreference): Promise<string | undefined> {
  return resolveHarnessRuntime(
    "claude-code",
    preference,
    (path) => path,
    async () => undefined,
  )
}

export function parseClaudeModels(models: ModelInfo[]): ProviderDiscoveryResult {
  return {
    models: models.map((model) => {
      const efforts = model.supportedEffortLevels?.map((effort) =>
        effort === "xhigh" ? "max" as const : effort) ?? []
      return {
        id: model.value,
        name: model.displayName,
        description: model.description,
        reasoning: model.supportsEffort === true || model.supportsAdaptiveThinking === true,
        ...(efforts.length > 0 ? { efforts: [...new Set(efforts)] } : {}),
      }
    }),
  }
}

export async function discoverClaudeModels(
  cwd: string,
  proxyEnv?: HarnessStartOptions["proxyEnv"],
  preference: HarnessRuntimePreference = "managed",
  deps: { query?: ClaudeQueryFactory } = {},
): Promise<ProviderDiscoveryResult> {
  assertHarnessCwd(cwd)
  const executable = await claudeExecutable(preference)
  const sdk = (deps.query ?? createSdkQuery)({
    prompt: "",
    options: {
      cwd,
      env: claudeSdkEnv(proxyEnv),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      settingSources: ["project"],
      tools: [],
    },
  })
  try {
    return parseClaudeModels(await sdk.supportedModels())
  } finally {
    sdk.close()
  }
}

export function claudeSdkEnv(proxyEnv?: HarnessStartOptions["proxyEnv"]): NodeJS.ProcessEnv {
  if (!proxyEnv) {
    return {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "bento/0.3.1",
      ELECTRON_RUN_AS_NODE: "1",
    }
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== "CLAUDECODE" &&
        !key.startsWith("CLAUDE_CODE_") &&
        !(proxyEnv.strip ?? []).some((prefix) => key.startsWith(prefix)),
    ),
  )
  return {
    ...env,
    ...proxyEnv.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "bento/0.3.1",
    ELECTRON_RUN_AS_NODE: "1",
  }
}

export const claudeAgentSdkDriver: HarnessDriver = {
  id: "claude-code",
  async start(
    options,
    emit,
    deps: { query?: ClaudeQueryFactory } = {},
  ): Promise<HarnessConnection> {
    if (!options.proxyEnv) {
      throw new Error("Claude Agent SDK 缺少 Bento provider 路由环境")
    }
    const queryFactory = deps.query ?? createSdkQuery
    const localExecutable = await claudeExecutable("managed")
    const nativeSessionId = options.nativeSessionId ?? randomUUID()
    let resume = options.nativeSessionId
    let modelId = options.modelId
    let currentQuery: Query | null = null
    let currentAbort: AbortController | null = null
    let closed = false
    const exitListeners = new Set<(code: number | null) => void>()
    // 权限档位:canUseTool 每次调用现读,会话中切换后续调用即生效(live)。
    // full 档走 bypassPermissions(必须带 allowDangerouslySkipPermissions,否则 SDK 拒启动),
    // 此时 canUseTool 不再被调用。
    let profile = options.permissionProfile ?? "standard"
    // cwd 同样归一(macOS 的 /tmp 就是 symlink),两侧同口径才能比
    const realCwd = resolveRealPath(options.cwd)
    // 审批 hold 与「总是允许」的规则集(按工具名记忆,对齐 claude CLI 语义);
    // 持久规则由 main 从项目级 permissions.json 注入,新增经 metadata 回报。
    const approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>()
    const sessionAllowedTools = new Set<string>(options.allowedTools ?? [])
    let approvalSeq = 0
    const settleApprovals = (decision: ApprovalDecision) => {
      for (const waiter of approvalWaiters.values()) waiter(decision)
      approvalWaiters.clear()
    }

    const sdkOptions = (abortController: AbortController): Options => ({
      cwd: options.cwd,
      env: claudeSdkEnv(options.proxyEnv),
      ...(localExecutable ? { pathToClaudeCodeExecutable: localExecutable } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(resume ? { resume } : { sessionId: nativeSessionId }),
      abortController,
      includePartialMessages: true,
      ...(profile === "full"
        ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
        : {
            permissionMode: "default" as const,
            canUseTool: async (toolName, input, permission) => {
              // §3.4:许可批准不是回合级事件,notice 会终结 draft 并让后续
              // tool_result 落空;改道 metadata,审批痕迹照常落盘、不渲染。
              const allow = { behavior: "allow" as const, toolUseID: permission.toolUseID }
              const deny = (message: string) => ({
                behavior: "deny" as const,
                toolUseID: permission.toolUseID,
                message,
              })
              if (sessionAllowedTools.has(toolName)) {
                emit({ type: "metadata", name: "permission/auto_approved", data: { toolName, profile, rule: "session" } })
                return allow
              }
              // realpath 归一后再判工作区:cwd 内的 symlink 不能借字符串判定逃逸
              const resolvedInput = { ...(input ?? {}) }
              for (const key of ["file_path", "notebook_path"] as const) {
                const value = resolvedInput[key]
                if (typeof value === "string") resolvedInput[key] = resolveRealPath(value)
              }
              const triage = triageClaudeTool(profile, toolName, resolvedInput, realCwd)
              if (triage === "allow") {
                emit({ type: "metadata", name: "permission/auto_approved", data: { toolName, profile } })
                return allow
              }
              if (triage === "deny") {
                emit({ type: "metadata", name: "permission/auto_denied", data: { toolName, profile } })
                return deny(`Bento 权限档位「${profile}」拒绝了该工具调用`)
              }
              // ask:审批闭环,hold 到渲染端决议(approval_resolved 由 main 统一落盘)
              const id = `apr-${++approvalSeq}`
              const command = typeof input?.command === "string" ? input.command : undefined
              const filePath = typeof input?.file_path === "string"
                ? input.file_path
                : typeof input?.notebook_path === "string"
                  ? input.notebook_path
                  : undefined
              emit({
                type: "approval_request",
                id,
                title: command ?? filePath ?? toolName,
                detail: `Claude 请求使用 ${toolName}(当前档位「${profile}」不自动放行)`,
                options: [
                  { id: "allow_once", label: "允许一次" },
                  // claude 的 always 会写入项目级 permissions.json(跨会话生效),
                  // 标签必须如实,不能只说"本会话"(codex/ACP 的 always 才是会话级)
                  { id: "allow_always", label: "总是允许(本项目)" },
                  { id: "deny", label: "拒绝" },
                ],
              })
              const decision = await new Promise<ApprovalDecision>((resolve) => {
                approvalWaiters.set(id, resolve)
              })
              if (decision === "deny") return deny("用户在 Bento 审批中拒绝了该工具调用")
              if (decision === "allow_always") {
                sessionAllowedTools.add(toolName)
                // 回报 main 持久化到项目级规则(driver 红线不写文件)
                emit({ type: "metadata", name: "permission/rule_added", data: { toolName } })
              }
              return allow
            },
          }),
      persistSession: true,
      settingSources: ["project"],
      // Skills 投递:curated 根的 local plugin(根下 .claude-plugin/plugin.json +
      // skills/)。SDK 0.2.112 的 plugins option → CLI --plugin-dir,session 级加载,
      // 不受 settingSources 门控(调研 /tmp/skills-research.md §1,测试同步验证)。
      ...(options.skillsPluginDir
        ? { plugins: [{ type: "local" as const, path: options.skillsPluginDir }] }
        : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
      ...(options.mcpServers?.length ? {
        mcpServers: Object.fromEntries(options.mcpServers.map((server) => [
          "bento-apps",
          { type: "stdio" as const, command: server.command, args: server.args, env: server.env },
        ])),
      } : {}),
      stderr: (data) => console.error("[claude-code]", data.trimEnd()),
    })

    const connection: HarnessConnection = {
      nativeSessionId,
      capabilities: { modelSwitch: "live", effortSwitch: "none", permissionSwitch: "live" },
      async prompt(input) {
        if (closed) throw new Error("Claude Agent SDK 会话已关闭")
        const abortController = new AbortController()
        const request = normalizePromptInput(input)
        const files = request.attachments.filter((attachment) => attachment.kind === "file")
        const text = files.length === 0
          ? request.text
          : `${request.text}\n\n附件文件：\n${files.map((file) => `- ${file.path}`).join("\n")}`
        const content: Exclude<SDKUserMessage["message"]["content"], string> = [{ type: "text", text }]
        for (const attachment of request.attachments) {
          if (attachment.kind !== "image") continue
          if (!isClaudeImageMediaType(attachment.mimeType)) {
            throw new Error(`Claude Code 不支持图片格式：${attachment.mimeType}`)
          }
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType,
              data: fs.readFileSync(attachment.path).toString("base64"),
            },
          })
        }
        async function* prompt(): AsyncGenerator<SDKUserMessage> {
          yield {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
          }
        }
        const sdk = queryFactory({ prompt: prompt(), options: sdkOptions(abortController) })
        currentAbort = abortController
        currentQuery = sdk
        const translator = new ClaudeAgentTranslator()
        let result: SDKResultMessage | undefined
        try {
          for await (const message of sdk as AsyncIterable<SDKMessage>) {
            if (message.session_id) resume = message.session_id
            for (const event of translator.translate(message)) emit(event)
            if (message.type === "result") result = message
          }
        } catch (error) {
          for (const listener of exitListeners) listener(1)
          throw error
        } finally {
          currentAbort = null
          currentQuery = null
        }
        if (!result) throw new Error("Claude Agent SDK 未返回 result")
        if (result.subtype !== "success") {
          const message = result.errors.join("; ") || result.subtype
          emit({ type: "notice", text: message })
          throw new Error(message)
        }
        // §7 P4:result 消息带逐回合 token 与 total_cost_usd
        return {
          stopReason: result.stop_reason ?? "completed",
          usage: harnessUsage({
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            cost: result.total_cost_usd,
          }),
        }
      },
      async cancel() {
        // cancel 竞态:hold 中的审批立即 decline,不等 abort 后的 SDK 回包
        settleApprovals("deny")
        const sdk = currentQuery
        currentAbort?.abort()
        if (!sdk) return
        try {
          await sdk.interrupt()
        } catch {
          sdk.close()
        }
      },
      close() {
        closed = true
        settleApprovals("deny")
        currentAbort?.abort()
        currentQuery?.close()
      },
      onExit(callback) {
        exitListeners.add(callback)
        return () => exitListeners.delete(callback)
      },
      async setModel(nextModelId) {
        modelId = nextModelId
      },
      async setPermissionProfile(next: PermissionProfile) {
        profile = next
      },
      resolveApproval(id: string, decision: ApprovalDecision) {
        const waiter = approvalWaiters.get(id)
        if (!waiter) return
        approvalWaiters.delete(id)
        waiter(decision)
      },
    }
    return connection
  },
}
