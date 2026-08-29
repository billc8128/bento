import type { CustomHarnessId, WireProtocol } from "@/core/provider"

export const PROTOCOL_LABELS: Record<WireProtocol, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-chat": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
}

/** 每个 harness 在桥接层真实支持的 wire 协议;codex 走 responses 原生或 chat 桥接。 */
export const HARNESS_PROTOCOLS: Record<CustomHarnessId, WireProtocol[]> = {
  "claude-code": ["anthropic-messages", "openai-chat"],
  codex: ["openai-responses", "openai-chat"],
  pi: ["openai-chat", "openai-responses", "anthropic-messages"],
  kimi: ["openai-chat", "openai-responses", "anthropic-messages"],
  opencode: ["openai-chat", "openai-responses", "anthropic-messages"],
  omp: ["openai-chat", "openai-responses", "anthropic-messages"],
  hermes: ["openai-chat", "openai-responses", "anthropic-messages"],
}

export const CUSTOM_HARNESSES: CustomHarnessId[] = [
  "claude-code", "codex", "pi", "kimi", "opencode", "omp", "hermes",
]

type FetchFailure =
  | { ok: false; error: { kind: string; message: string } }
  | { error: string; message: string }

/** fetchProviderModels / discoverPresetModels 的失败 → 用户可读文案。 */
export function describeFetchError(result: FetchFailure): string {
  if (!("ok" in result)) return result.message || "拉取失败"
  switch (result.error.kind) {
    case "unauthorized":
      return "鉴权失败，请检查 API Key"
    case "not-found":
      return "模型列表地址不存在，请在高级设置里检查"
    case "network":
      return "网络错误，无法连接该地址"
    case "parse":
      return "返回内容无法解析为模型列表"
    default:
      return result.error.message || "拉取失败"
  }
}
