const RECENT_KEY = "bento.recentCwds"

export function loadRecentCwds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]
    return Array.isArray(raw) ? raw.filter(Boolean).slice(0, 8) : []
  } catch {
    return []
  }
}

export function saveRecentCwd(cwd: string) {
  try {
    const next = [cwd, ...loadRecentCwds().filter((item) => item !== cwd)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用时只是不记最近目录
  }
}
