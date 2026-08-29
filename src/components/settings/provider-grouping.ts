import { providerFamilyId as coreProviderFamilyId, type ProviderView } from "@/core/provider"
import { canonicalProviderId } from "@/data/provider-sources"

export function providerFamilyId(canonicalId: string): string {
  return coreProviderFamilyId(canonicalId)
}

export function nativeCanonicalId(view: ProviderView): string | null {
  if (view.canonicalId) return view.canonicalId
  const harnessId = view.harnessIds[0]!
  if (view.id === `native-${harnessId}`) {
    if (harnessId === "codex") return "openai-codex"
    if (harnessId === "claude-code") return "anthropic-api"
    return null
  }
  const rest = view.id.slice(view.id.indexOf("/") + 1)
  const prefix = `runtime-${harnessId}-`
  const sourceId = rest.startsWith(prefix) ? rest.slice(prefix.length) : rest
  if (harnessId === "kimi" && sourceId === "moonshot") return "kimi-code"
  return canonicalProviderId(sourceId) ?? sourceId
}
