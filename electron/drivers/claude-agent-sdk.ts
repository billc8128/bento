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
import { assertHarnessCwd, resolveHarnessRuntime, type HarnessRuntimePreference } from "../harness-runtime"
import { isNativeProviderId } from "../../src/core/provider"
import { normalizePromptInput } from "../../src/core/types"
import type { HarnessConnection, HarnessDriver, HarnessStartOptions } from "./types"
import type { ProviderDiscoveryResult } from "../provider-discovery"

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
  preference: HarnessRuntimePreference = "local",
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
    if (!options.proxyEnv && !isNativeProviderId(options.providerId)) {
      throw new Error("Claude Agent SDK 缺少 Bento provider 路由环境")
    }
    const queryFactory = deps.query ?? createSdkQuery
    const localExecutable = await claudeExecutable(
      options.runtimePreference ?? (options.proxyEnv ? "managed" : "local"),
    )
    const nativeSessionId = options.nativeSessionId ?? randomUUID()
    let resume = options.nativeSessionId
    let modelId = options.modelId
    let currentQuery: Query | null = null
    let currentAbort: AbortController | null = null
    let closed = false
    const exitListeners = new Set<(code: number | null) => void>()

    const sdkOptions = (abortController: AbortController): Options => ({
      cwd: options.cwd,
      env: claudeSdkEnv(options.proxyEnv),
      ...(localExecutable ? { pathToClaudeCodeExecutable: localExecutable } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(resume ? { resume } : { sessionId: nativeSessionId }),
      abortController,
      includePartialMessages: true,
      permissionMode: "default",
      canUseTool: async (toolName, _input, permission) => {
        // §3.4:许可批准不是回合级事件,notice 会终结 draft 并让后续
        // tool_result 落空;改道 metadata,审批痕迹照常落盘、不渲染。
        emit({ type: "metadata", name: "permission/auto_approved", data: { toolName } })
        return { behavior: "allow", toolUseID: permission.toolUseID }
      },
      persistSession: true,
      settingSources: ["project"],
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
      capabilities: { modelSwitch: "live", effortSwitch: "none" },
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
    }
    return connection
  },
}
