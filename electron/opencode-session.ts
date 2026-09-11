/**
 * OpenCode Go/Zen 上游协议(issue #3):2026-09-06 起,发往
 * opencode.ai/zen* 的请求必须携带 x-opencode-session 头——一个会话一个
 * 稳定 ID,上游用它做路由亲和与 prompt 缓存,缺失直接报错。
 *
 * 这里只负责「上游是不是 OpenCode」的判定;亲和 ID 的值就是持久化的
 * sessionKey(ProviderRoutingService 路由时注入),模型列表拉取归
 * provider-model-fetch(进程级 ID)。
 */

export const OPENCODE_SESSION_HEADER = "x-opencode-session"

/** 命中 opencode.ai 的 /zen(/go)端点;自定义 provider 指到同一上游也覆盖。 */
export function isOpenCodeUpstream(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.hostname === "opencode.ai" && (url.pathname === "/zen" || url.pathname.startsWith("/zen/"))
  } catch {
    return false
  }
}
