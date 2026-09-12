/**
 * 会话隔离配置里的稳定别名与 env key:providerId → bento-<hash36>。
 * 同一 providerId 跨会话/跨 harness 稳定,用于配置内 provider 段名与
 * BENTO_PROVIDER_KEY_<hash> 凭证变量名。
 */

export function stableProviderAlias(providerId: string): string {
  let hash = 0
  for (let index = 0; index < providerId.length; index += 1) {
    hash = (hash * 31 + providerId.charCodeAt(index)) >>> 0
  }
  return `bento-${hash.toString(36)}`
}

/** 凭证 env 变量名:只进子进程 env,配置文件只引用此名字。 */
export function providerKeyEnvName(providerId: string): string {
  return `BENTO_PROVIDER_KEY_${stableProviderAlias(providerId).slice("bento-".length).toUpperCase()}`
}

/**
 * Bento 登记的模型 id(pi/opencode/omp 的 ProviderView 带 `bento/` 前缀):
 * 归一化成上游裸 wire id。
 */
export function normalizeBentoModelId(modelId: string): string {
  return modelId.replace(/^bento\//, "")
}
