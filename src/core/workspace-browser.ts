export function normalizeWorkspaceBrowserUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error("请输入 URL")
  if (/^(?:about|data|file|ftp|javascript|mailto|tel):/i.test(value)) {
    throw new Error("浏览器只支持 HTTP(S) URL")
  }
  const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("浏览器只支持 HTTP(S) URL")
  }
  return parsed.toString()
}
