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

export const COLLABORATION_APP_ID = "collaboration"

// 内置应用的 name/description 是 i18n 词典 key(命名空间 settings):
// 这里无法拿到渲染端 locale,由 AppsSection 展示时对 source === "builtin" 的应用 t() 查表。
export const COLLABORATION_APP = {
  id: COLLABORATION_APP_ID,
  name: "settings.appCollaborationName",
  description: "settings.appCollaborationDesc",
  source: "builtin",
  enabledByDefault: true,
  transport: "builtin",
  editable: false,
  hasSecrets: false,
} as const

export const BROWSER_APP = {
  id: BROWSER_APP_ID,
  name: "settings.appBrowserName",
  description: "settings.appBrowserDesc",
  source: "builtin",
  enabledByDefault: true,
  transport: "builtin",
  editable: false,
  hasSecrets: false,
} as const
