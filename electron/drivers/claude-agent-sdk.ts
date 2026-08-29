import { randomUUID } from "node:crypto"
import {
  query as createSdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk"

import { ClaudeAgentTranslator } from "./claude-agent-translator"
import { harnessUsage } from "./usage"
import { localHarnessExecutable } from "../harness-runtime"
import { isNativeProviderId } from "../../src/core/provider"
import type { HarnessConnection, HarnessDriver, HarnessStartOptions } from "./types"

export type ClaudeQueryFactory = (params: Parameters<typeof createSdkQuery>[0]) => Query

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
    const localExecutable = localHarnessExecutable("claude-code")?.path
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
      stderr: (data) => console.error("[claude-code]", data.trimEnd()),
    })

    const connection: HarnessConnection = {
      nativeSessionId,
      capabilities: { modelSwitch: "live", effortSwitch: "none" },
      async prompt(text) {
        if (closed) throw new Error("Claude Agent SDK 会话已关闭")
        const abortController = new AbortController()
        const sdk = queryFactory({ prompt: text, options: sdkOptions(abortController) })
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
