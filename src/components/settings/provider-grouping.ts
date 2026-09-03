import { providerFamilyId as coreProviderFamilyId } from "@/core/provider"

export function providerFamilyId(canonicalId: string): string {
  return coreProviderFamilyId(canonicalId)
}
