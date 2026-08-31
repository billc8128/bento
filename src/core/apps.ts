export const BROWSER_APP_ID = "browser" as const

export type BentoAppId = typeof BROWSER_APP_ID

export type BentoAppView = {
  id: BentoAppId
  name: string
  description: string
  enabled: boolean
  enabledByDefault: boolean
  harnesses: string[]
  unsupportedHarnesses: string[]
}

export const BROWSER_APP = {
  id: BROWSER_APP_ID,
  name: "浏览器",
  description: "让 Agent 操作右侧工作区中的真实浏览器标签页。",
  enabledByDefault: true,
  harnesses: ["Claude Code", "Codex", "Kimi", "OpenCode", "OMP", "Hermes"],
  unsupportedHarnesses: ["Pi"],
} as const
