/**
 * 本机可导入候选的一次性扫描(空态导入入口用)。
 * 只关心「可直接导入」(credentialReusable)的候选来源;OAuth/account 型登录态
 * 留在本机 CLI,不构成导入入口。模块级缓存保证多空态共享一次扫描。
 */

import { useEffect, useState } from "react"

let cached: string[] | null = null
let inflight: Promise<string[]> | null = null

function scanReusableSources(): Promise<string[]> {
  inflight ??= (window.bento?.scanLocalProviders() ?? Promise.resolve([]))
    .then((found) => {
      cached = [...new Set(found.filter((item) => item.credentialReusable).map((item) => item.source))]
      return cached
    })
    .catch(() => {
      cached = []
      return cached
    })
  return inflight
}

/** 返回可导入候选的来源列表;null = 尚未完成扫描。 */
export function useLocalImportSources(): string[] | null {
  const [sources, setSources] = useState<string[] | null>(cached)
  useEffect(() => {
    if (cached) return
    let alive = true
    void scanReusableSources().then((value) => {
      if (alive) setSources(value)
    })
    return () => {
      alive = false
    }
  }, [])
  return sources
}
