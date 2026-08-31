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

export const COLLABORATION_APP = {
  id: COLLABORATION_APP_ID,
  name: "协作",
  description: [
    "让 Agent 发现并协作同一 Bento runtime 内的全部会话：",
    "可读取 Bento 会话列表与脱敏消息历史；",
    "可跨项目向其它会话发送消息并等待回复；",
    "可按调用者配置创建新的 Agent 会话；",
    "caller 身份由 lease 绑定，Agent 不能伪造来源。",
  ].join(""),
  source: "builtin",
  enabledByDefault: true,
  transport: "builtin",
  editable: false,
  hasSecrets: false,
} as const

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
