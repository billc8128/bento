import { loadPreference, resolveLocale, translate } from "@/lib/i18n/core"

/** 非 React 模块:按当前持久化的语言偏好取文案(无 Provider 依赖,测试里也可用) */
function message(key: string): string {
  return translate(resolveLocale(loadPreference()), key)
}

export function normalizeWorkspaceBrowserUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error(message("common.browserUrlRequired"))
  if (/^(?:about|data|file|ftp|javascript|mailto|tel):/i.test(value)) {
    throw new Error(message("common.browserUrlHttpOnly"))
  }
  const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(message("common.browserUrlHttpOnly"))
  }
  return parsed.toString()
}
