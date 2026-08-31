import fs from "node:fs"
import path from "node:path"

import {
  BROWSER_APP,
  BROWSER_APP_ID,
  COLLABORATION_APP,
  COLLABORATION_APP_ID,
  type BentoAppId,
  type BentoAppView,
  type UserAppInput,
  type UserAppTransport,
} from "../src/core/apps"

export type AppSecretStore = {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

type StoredUserApp = {
  id: string
  name: string
  description: string
  transport: UserAppTransport
}

type AppsState = {
  enabled: Record<string, boolean>
  userApps: StoredUserApp[]
}

export type RuntimeApp = StoredUserApp & {
  source: "user"
  env: Record<string, string>
  headers: Record<string, string>
}

const USER_APP_ID = /^user-[a-z0-9][a-z0-9_-]{1,62}$/

function slug(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
  return normalized || `app-${Date.now().toString(36)}`
}

function cleanRecord(value: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(value ?? {}).flatMap(([key, entry]) => {
    const name = key.trim()
    return name && entry ? [[name, entry]] : []
  }))
}

function validateTransport(transport: UserAppTransport): void {
  if (transport.type === "stdio") {
    if (!transport.command.trim()) throw new Error("stdio App 必须提供 command")
    return
  }
  const url = new URL(transport.url)
  if (url.username || url.password) throw new Error("URL 不能包含用户名或密码；请改用加密 Header")
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("HTTP App 必须使用 HTTPS；本机 loopback 可使用 HTTP")
  }
}

export class AppsStore {
  private readonly file: string
  private state: AppsState

  constructor(
    userDataDir: string,
    private readonly secrets: AppSecretStore,
    private readonly onChanged: () => void = () => {},
  ) {
    this.file = path.join(userDataDir, "apps.json")
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<AppsState>
      this.state = { enabled: parsed.enabled ?? {}, userApps: parsed.userApps ?? [] }
    } catch {
      this.state = { enabled: {}, userApps: [] }
    }
  }

  list(): BentoAppView[] {
    return [
      { ...BROWSER_APP, enabled: this.isEnabled(BROWSER_APP_ID) },
      { ...COLLABORATION_APP, enabled: this.isEnabled(COLLABORATION_APP_ID) },
      ...this.state.userApps.map((app): BentoAppView => ({
        id: app.id,
        name: app.name,
        description: app.description,
        source: "user",
        enabled: this.isEnabled(app.id),
        enabledByDefault: true,
        transport: app.transport.type,
        editable: true,
        hasSecrets: Boolean(this.secrets.get(this.secretKey(app.id))),
        connection: app.transport,
      })),
    ]
  }

  enabledRuntimeApps(): RuntimeApp[] {
    return this.state.userApps.flatMap((app): RuntimeApp[] => {
      if (!this.isEnabled(app.id)) return []
      let secret: { env?: Record<string, string>; headers?: Record<string, string> } = {}
      try {
        secret = JSON.parse(this.secrets.get(this.secretKey(app.id)) ?? "{}")
      } catch {
        // 损坏的密文只让该 App 无凭证启动，不回落其它 App 的秘密。
      }
      return [{
        ...app,
        source: "user",
        env: cleanRecord(secret.env),
        headers: cleanRecord(secret.headers),
      }]
    })
  }

  isEnabled(id: BentoAppId): boolean {
    return this.state.enabled[id] ?? true
  }

  setEnabled(id: BentoAppId, enabled: boolean): void {
    if (
      id !== BROWSER_APP_ID &&
      id !== COLLABORATION_APP_ID &&
      !this.state.userApps.some((app) => app.id === id)
    ) {
      throw new Error("未知 App")
    }
    this.state.enabled[id] = enabled
    this.save()
  }

  upsert(input: UserAppInput): BentoAppView {
    const id = input.id?.trim() || `user-${slug(input.name)}`
    if (!USER_APP_ID.test(id)) throw new Error("App id 必须以 user- 开头，并只包含小写字母、数字、-、_")
    if (input.id && !this.state.userApps.some((app) => app.id === id)) {
      throw new Error("要编辑的 App 不存在")
    }
    if (!input.id && this.state.userApps.some((app) => app.id === id)) {
      throw new Error(`App ${input.name.trim()} 已存在，请从列表进入编辑`)
    }
    validateTransport(input.transport)
    const stored: StoredUserApp = {
      id,
      name: input.name.trim() || id,
      description: input.description?.trim() || "用户添加的 MCP App",
      transport: input.transport.type === "stdio"
        ? { type: "stdio", command: input.transport.command.trim(), args: input.transport.args }
        : { type: "http", url: new URL(input.transport.url).href },
    }
    this.state.userApps = [stored, ...this.state.userApps.filter((app) => app.id !== id)]
    const env = cleanRecord(input.env)
    const headers = cleanRecord(input.headers)
    if (Object.keys(env).length || Object.keys(headers).length) {
      this.secrets.set(this.secretKey(id), JSON.stringify({ env, headers }))
    } else if (input.clearSecrets) {
      this.secrets.delete(this.secretKey(id))
    }
    this.state.enabled[id] ??= true
    this.save()
    return this.list().find((app) => app.id === id)!
  }

  remove(id: string): void {
    if (!USER_APP_ID.test(id)) throw new Error("内置 App 不能删除")
    this.state.userApps = this.state.userApps.filter((app) => app.id !== id)
    delete this.state.enabled[id]
    this.secrets.delete(this.secretKey(id))
    this.save()
  }

  private secretKey(id: string): string {
    return `app:${id}:connection`
  }

  private save(): void {
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2))
    fs.renameSync(temporary, this.file)
    this.onChanged()
  }
}
