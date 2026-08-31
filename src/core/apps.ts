export const BROWSER_APP_ID = "browser"

export type BentoAppId = string
export type AppSource = "builtin" | "user"

export type UserAppTransport =
  | { type: "stdio"; command: string; args: string[] }
  | { type: "http"; url: string }

export type UserAppInput = {
  id?: string
  name: string
  description?: string
  transport: UserAppTransport
  env?: Record<string, string>
  headers?: Record<string, string>
  clearSecrets?: boolean
}

export type BentoAppView = {
  id: BentoAppId
  name: string
  description: string
  source: AppSource
  enabled: boolean
  enabledByDefault: boolean
  transport: "builtin" | UserAppTransport["type"]
  editable: boolean
  hasSecrets: boolean
  connection?: UserAppTransport
}

export const BROWSER_APP = {
  id: BROWSER_APP_ID,
  name: "浏览器",
  description: "让所有兼容 Harness 操作右侧工作区中的真实浏览器标签页。",
  source: "builtin",
  enabledByDefault: true,
  transport: "builtin",
  editable: false,
  hasSecrets: false,
} as const
