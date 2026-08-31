/** 官方订阅供应商身份卡。公开 OAuth descriptor/模型随应用发布，凭证仍只进 safeStorage。 */

import type { CustomProviderConfig } from "../src/core/provider"

const REASONING_EFFORTS = ["low", "medium", "high"] as const

const OPENAI_OAUTH_RUNTIME = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  requestPath: "/responses",
  wireProtocol: "openai-responses" as const,
  models: [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      reasoning: true,
      reasoningEfforts: [...REASONING_EFFORTS],
      defaultEffort: "medium" as const,
    },
  ],
}

export const BUILTIN_PROVIDER_IDS = ["anthropic", "openai"] as const
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number]

export const BUILTIN_PROVIDERS: Record<BuiltinProviderId, CustomProviderConfig> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    auth: {
      method: "oauth",
      oauth: {
        authorizeUrl: "https://claude.com/cai/oauth/authorize",
        tokenUrl: "https://platform.claude.com/v1/oauth/token",
        clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        scopes: "user:profile user:inference",
        redirectPort: 54545,
        redirectHost: "localhost",
        extraAuthParams: { code: "true" },
      },
    },
    runtimes: {
      "claude-code": {
        baseUrl: "https://api.anthropic.com",
        wireProtocol: "anthropic-messages",
        models: [
          {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            reasoning: true,
            reasoningEfforts: [...REASONING_EFFORTS],
            defaultEffort: "medium",
          },
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            reasoning: true,
            reasoningEfforts: [...REASONING_EFFORTS],
            defaultEffort: "medium",
          },
          { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        ],
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    auth: {
      method: "oauth",
      oauth: {
        authorizeUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
        redirectPort: 1455,
        redirectHost: "localhost",
        redirectPath: "/auth/callback",
        extraAuthParams: {
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
          originator: "codex_cli_rs",
        },
      },
    },
    runtimes: {
      codex: OPENAI_OAUTH_RUNTIME,
      kimi: OPENAI_OAUTH_RUNTIME,
      opencode: OPENAI_OAUTH_RUNTIME,
      omp: OPENAI_OAUTH_RUNTIME,
      pi: OPENAI_OAUTH_RUNTIME,
      hermes: OPENAI_OAUTH_RUNTIME,
    },
  },
}

export const LEGACY_SUBSCRIPTION_PROVIDER_IDS: Record<string, BuiltinProviderId> = {
  "user-claude-subscription": "anthropic",
  "user-codex-subscription": "openai",
}

export function builtinProvider(providerId: string): CustomProviderConfig | undefined {
  return BUILTIN_PROVIDERS[providerId as BuiltinProviderId]
}

export function builtinProvidersForHarness(harnessId: string): CustomProviderConfig[] {
  return BUILTIN_PROVIDER_IDS
    .map((id) => BUILTIN_PROVIDERS[id])
    .filter((provider) => provider.runtimes[harnessId as keyof CustomProviderConfig["runtimes"]])
}
