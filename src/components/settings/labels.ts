import type { CustomHarnessId, WireProtocol } from "@/core/provider"
import type { TFn } from "@/lib/i18n"

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
export function describeFetchError(result: FetchFailure, t: TFn): string {
  if (!("ok" in result)) return result.message || t("providers.fetchFailed")
  switch (result.error.kind) {
    case "unauthorized":
      return t("providers.fetchUnauthorized")
    case "not-found":
      return t("providers.fetchNotFound")
    case "network":
      return t("providers.fetchNetwork")
    case "parse":
      return t("providers.fetchParse")
    default:
      return result.error.message || t("providers.fetchFailed")
  }
}
