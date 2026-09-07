/** Electron 主进程:窗口 + 会话管理 IPC。壳选型依据见 ARCHITECTURE.md §1。 */

import fixPath from "fix-path"
import fs from "node:fs"
import os from "node:os"
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, screen, shell, webContents, type OpenDialogOptions } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { getDriver } from "./drivers/registry"
import { SessionManager } from "./sessions"
import { listPermissionRulesByProject, removePermissionRule } from "./permission-rules"
import type { Effort, SessionScope } from "../src/core/types"
import type { ApprovalDecision } from "../src/core/events"
import type { PermissionProfile } from "../src/core/permission"
import type { PromptInput } from "../src/core/types"
import type { BentoAppId, UserAppInput } from "../src/core/apps"
import { configureBinaryManager } from "./binaries/manager"
import { createProject } from "./projects"
import { readFileDataUrl, saveAttachmentBlob } from "./local-files"
import type { CustomProviderConfig } from "../src/core/provider"
import { providerConfigFromPreset, providerPresetView } from "../src/core/provider-preset"
import { getProviderPreset, PROVIDER_PRESETS } from "../src/data/provider-presets"
import { CustomProviderStore, type SecretStore } from "./custom-providers"
import { ProviderRegistry } from "./providers"
import { ProviderDiscoveryService } from "./provider-discovery"
import { ProviderRoutingService } from "./provider-routing"
import { builtinProvidersForHarness } from "./builtin-providers"
import { runOAuthLogin } from "./oauth-runner"
import { LocalProviderScanner } from "./provider-import"
import type { LocalProviderCandidate } from "../src/core/provider-preset"
import { listHarnessRuntimeStatuses, warmHarnessRuntimeVersions } from "./harness-runtime"
import { ModelVisibilityStore } from "./model-visibility"
import { ProviderModelCache } from "./provider-model-cache"
import { KimiBentoConfigAdapter } from "./session-config/kimi"
import { OpenCodeBentoConfigAdapter } from "./session-config/opencode"
import { OmpBentoConfigAdapter } from "./session-config/omp"
import { PiBentoConfigAdapter } from "./session-config/pi"
import { HermesBentoConfigAdapter } from "./session-config/hermes"
import { RoutedBentoConfigAdapter } from "./session-config/routed"
import { SessionConfigRegistry } from "./session-config/registry"
import type { SessionProviderRuntime } from "./session-config/types"
import type { HarnessId } from "../src/core/harness"
import { TerminalManager } from "./workspace/terminal-manager"
import { WorkspaceFileService } from "./workspace/file-service"
import { WorkspaceBrowserManager } from "./workspace/browser-manager"
import { WorkspaceFileWatchManager } from "./workspace/file-watch-manager"
import type { WorkspaceBounds } from "../src/types/workspace"
import { AppsStore } from "./apps"
import { AppRuntimeHost } from "./app-runtime-host"
import { CollaborationService } from "./collaboration-service"
import { UiCommandBridge } from "./ui-command-bridge"
import { SessionCollaborationBackend } from "./collaboration-session-backend"
import { AgentSelectionCatalog } from "./collaboration-catalog"

// GUI app 不继承 login shell 的 PATH,打包后 spawn kimi/opencode 会 ENOENT。
// fix-path 用 login shell 修 PATH;常见 bin 目录再兜一层(存在才加)
// dev 下顺手开 CDP:vite-plugin-electron 只起一个窗口,验证脚本经 9876 驱动它,
// 不必再单开一个带调试端口的实例(Dock 双窗口的来源)
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9876")
}
if (app.isPackaged) {
  fixPath()
  const extraDirs = [".local/bin", ".kimi-code/bin", ".opencode/bin", ".cargo/bin"].map((p) =>
    path.join(os.homedir(), p),
  )
  for (const dir of extraDirs) {
    if (fs.existsSync(dir) && !process.env.PATH!.split(":").includes(dir)) {
      process.env.PATH = `${dir}:${process.env.PATH}`
    }
  }
}

/** 隔离实例(录素材/并行测试):BENTO_USER_DATA 指向独立数据目录,必须在各 store 初始化前 set。 */
if (process.env.BENTO_USER_DATA) {
  app.setPath("userData", process.env.BENTO_USER_DATA)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let sessions: SessionManager
let providers: ProviderRegistry
let routing: ProviderRoutingService | null = null
let terminals: TerminalManager
let workspaceBrowsers: WorkspaceBrowserManager
let appRuntime: AppRuntimeHost
/** 协作服务:SessionManager 建好后初始化;AppRuntimeHost 经 getter 惰性取用。 */
let collaborationService: CollaborationService | null = null
let uiBridge: UiCommandBridge | null = null
const workspaceFiles = new WorkspaceFileService()
let workspaceFileWatches: WorkspaceFileWatchManager
const safeSecrets: SecretStore = {
  get: (key) => {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const buffer = safeStorage.decryptString(
        Buffer.from(secretVault.getItem(key) ?? "", "base64"),
      )
      return buffer || null
    } catch {
      return null
    }
  },
  set: (key, value) => {
    secretVault.setItem(
      key,
      safeStorage.encryptString(value).toString("base64"),
    )
  },
  delete: (key) => secretVault.removeItem(key),
}

/** safeStorage 密文落 userData/providers/secrets.json(密文不含明文 key,可落盘)。 */
function configureSecretLocalStorage(userDataDir: string) {
  const file = path.join(userDataDir, "providers", "secrets.json")
  const state = { items: {} as Record<string, string> }
  try {
    Object.assign(state.items, JSON.parse(fs.readFileSync(file, "utf8")).items ?? {})
  } catch {
    // 首次启动无文件
  }
  return {
    getItem: (key: string) => state.items[key] ?? null,
    setItem: (key: string, value: string) => {
      state.items[key] = value
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state))
      fs.renameSync(tmp, file)
    },
    removeItem: (key: string) => {
      delete state.items[key]
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state))
      fs.renameSync(tmp, file)
    },
  }
}

const secretVault = configureSecretLocalStorage(app.getPath("userData"))
const apps = new AppsStore(app.getPath("userData"), safeSecrets, () => {
  win?.webContents.send("apps:changed")
})
const customProviders = new CustomProviderStore(
  app.getPath("userData"),
  safeSecrets,
  () => {
    providers.setUserProviders(customProviders.list())
    win?.webContents.send("providers:changed")
  },
)
const providerModelCache = new ProviderModelCache(app.getPath("userData"))
const localProviderScanner = new LocalProviderScanner(os.homedir())
/** discovery 的目录噪声过滤:harness → 本机扫描来源。 */
const HARNESS_SCANNER_SOURCE: Partial<Record<HarnessId, LocalProviderCandidate["source"]>> = {
  pi: "Pi",
  opencode: "OpenCode",
  omp: "OMP",
  hermes: "Hermes",
  kimi: "Kimi Code",
}
const providerDiscovery = new ProviderDiscoveryService(undefined, providerModelCache, (harnessId) => {
  const source = HARNESS_SCANNER_SOURCE[harnessId]
  return source ? localProviderScanner.configuredKeys(source) : []
}, (harnessId, providerId) => {
  const source = HARNESS_SCANNER_SOURCE[harnessId]
  return source ? localProviderScanner.isOAuthConfigured(source, providerId) : false
})
const modelVisibility = new ModelVisibilityStore(app.getPath("userData"))
providers = new ProviderRegistry(
  providerDiscovery,
  (config, harnessId) => customProviders.hasCredentialFor(config, harnessId),
  (providerId, harnessId, cwd) => routing?.discoverProviderModels(providerId, harnessId, cwd) ??
    Promise.resolve(null),
  (providerId, modelId) => modelVisibility.isEnabled(providerId, modelId),
  providerModelCache,
)
customProviders.migrateBuiltinSubscriptions()
providers.setUserProviders(customProviders.list()) // 启动即同步,重启后首次拉取就能看到 user providers

/** 窗口尺寸/位置记忆:默认取可视区 85%(封顶 1360×880,13 寸屏不再占满),
 * 用户拖过就记住;拔掉外接屏后位置失效则只恢复尺寸、位置交给系统居中。 */
type WindowState = { width: number; height: number; x?: number; y?: number }

function windowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json")
}

function loadWindowState(): WindowState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStatePath(), "utf8")) as Record<string, unknown>
    if (typeof raw.width !== "number" || typeof raw.height !== "number") return null
    const state: WindowState = { width: Math.round(raw.width), height: Math.round(raw.height) }
    if (typeof raw.x === "number" && typeof raw.y === "number") {
      const onScreen = screen.getAllDisplays().some((display) => {
        const area = display.workArea
        return (
          (raw.x as number) >= area.x - 8 &&
          (raw.y as number) >= area.y - 8 &&
          (raw.x as number) < area.x + area.width &&
          (raw.y as number) < area.y + area.height
        )
      })
      if (onScreen) {
        state.x = Math.round(raw.x)
        state.y = Math.round(raw.y)
      }
    }
    return state
  } catch {
    return null
  }
}

function createWindow() {
  const saved = loadWindowState()
  const workArea = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: saved?.width ?? Math.min(1360, Math.round(workArea.width * 0.85)),
    height: saved?.height ?? Math.min(880, Math.round(workArea.height * 0.85)),
    ...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 680,
    minHeight: 600,
    title: "Bento",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
    },
  })

  // resize/move 去抖 500ms 落盘;最大化/全屏下的 bounds 不是用户调的,不记
  let saveTimer: NodeJS.Timeout | null = null
  const saveState = () => {
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
    try {
      fs.writeFileSync(windowStatePath(), JSON.stringify(win.getBounds()))
    } catch {
      /* ignore */
    }
  }
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 500)
  }
  win.on("resize", scheduleSave)
  win.on("move", scheduleSave)
  win.on("close", saveState)
  const ownerId = win.webContents.id
  win.webContents.on("destroyed", () => {
    terminals.disposeOwner(ownerId)
    workspaceBrowsers.disposeOwner(ownerId)
    workspaceFileWatches.disposeOwner(ownerId)
  })
  win.on("closed", () => {
    win = null
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"))
  }
}

app.whenReady().then(async () => {
  // 闲时预热 harness 版本探测(claude 内嵌 CLI 要 spawn 一次),设置页首开即读缓存
  warmHarnessRuntimeVersions()
  const sendWorkspaceEvent = (ownerId: number, channel: string, payload: unknown) => {
    const contents = webContents.fromId(ownerId)
    if (contents && !contents.isDestroyed()) contents.send(channel, payload)
  }
  terminals = new TerminalManager(sendWorkspaceEvent)
  workspaceBrowsers = new WorkspaceBrowserManager((ownerId, state) => {
    sendWorkspaceEvent(ownerId, "workspace-browser:state", state)
  })
  appRuntime = new AppRuntimeHost(
    app.getPath("userData"),
    apps,
    workspaceBrowsers,
    () => {
      if (!win || win.isDestroyed()) return null
      return { ownerId: win.webContents.id, window: win }
    },
    path.join(app.getAppPath(), "electron/mcp-http-relay.mjs"),
    path.join(app.getAppPath(), "electron/pi-mcp-extension.mjs"),
    (id) => {
      if (win && !win.isDestroyed()) win.webContents.send("workspace-browser:reveal", id)
    },
    // SessionManager/appRuntime 互相引用,这里用 getter 打破初始化循环;
    // 协作 App 关闭时 lease 不签发,getter 也不会被调用。
    () => collaborationService,
  )
  await appRuntime.start()
  workspaceFileWatches = new WorkspaceFileWatchManager(workspaceFiles, (ownerId, change) => {
    sendWorkspaceEvent(ownerId, "workspace-files:changed", change)
  })

  configureBinaryManager(app.getPath("userData"), (progress) => {
    // 受管二进制下载进度走独立频道:不进会话事件流(connectSession 的
    // pending 缓冲会把连接前事件延迟到完成才显示,进度会完全不可见)
    if (win && !win.isDestroyed()) win.webContents.send("binary:progress", progress)
  })
  const activeRouting = new ProviderRoutingService(app.getPath("userData"), () => customProviders)
  routing = activeRouting

  // session-config adapters:全部 Harness 的 Bento adapter(单键注册)。
  const configAdapters = new SessionConfigRegistry()
  configAdapters.register(new KimiBentoConfigAdapter("kimi", activeRouting, app.getPath("userData")))
  /** main-only:按 harness 解析 SessionConfigRequest.providers(Bento 完整注册表)。 */
  const resolveProviderRuntimes = async (request: {
    harnessId: HarnessId | "glm"
    cwd: string
  }): Promise<SessionProviderRuntime[]> => {
    const harnessId = request.harnessId === "glm" ? "claude-code" : request.harnessId
    // Bento 完整注册表：所有含目标 runtime、凭证可用、enabled 模型非空的配置。
    // 内置 OAuth Provider 与 user Provider 一起进入目标 Harness 的完整注册表。
    // credential handle 闭包只在 main 解析 safeStorage,绝不回 renderer。
    const BENTO_FULL_REGISTRY_HARNESSES = [
      "claude-code", "codex", "kimi", "opencode", "omp", "pi", "hermes",
    ] as const
    if (!BENTO_FULL_REGISTRY_HARNESSES.includes(harnessId as typeof BENTO_FULL_REGISTRY_HARNESSES[number])) return []
    const configs = [...builtinProvidersForHarness(harnessId), ...customProviders.list()]
    const catalog = await providers.list({ harnessId, cwd: request.cwd, discover: true })
    const configuredViews = new Map(
      catalog
        .filter((provider) => provider.source === "builtin" || provider.source === "user")
        .map((provider) => [provider.id, provider]),
    )
    return configs
      .filter((config) => {
        const models = configuredViews.get(config.id)?.models[harnessId] ?? []
        return config.runtimes[harnessId] &&
          customProviders.hasCredentialFor(config, harnessId) && models.length > 0
      })
      .map((config) => {
        const runtime = config.runtimes[harnessId]!
        return {
          providerId: config.id,
          name: config.name,
          baseUrl: runtime.baseUrl,
          wireProtocol: runtime.wireProtocol,
          ...(runtime.requestPath ? { requestPath: runtime.requestPath } : {}),
          ...(runtime.auth?.inference?.fixedHeaders ? { headers: runtime.auth.inference.fixedHeaders } : {}),
          models: configuredViews.get(config.id)?.models[harnessId] ?? [],
          credential: {
            resolve: () => customProviders.readKey(config.id, harnessId),
          },
        }
      })
  }


  configAdapters.register(new OpenCodeBentoConfigAdapter("opencode", activeRouting, app.getPath("userData")))
  configAdapters.register(new OmpBentoConfigAdapter("omp", activeRouting, app.getPath("userData")))
  configAdapters.register(new PiBentoConfigAdapter("pi", activeRouting, app.getPath("userData")))
  configAdapters.register(new HermesBentoConfigAdapter("hermes", activeRouting, app.getPath("userData")))
  configAdapters.register(new RoutedBentoConfigAdapter("claude-code", activeRouting, app.getPath("userData")))
  configAdapters.register(new RoutedBentoConfigAdapter("codex", activeRouting, app.getPath("userData")))

  sessions = new SessionManager(
    app.getPath("userData"),
    (key, record) => {
      // 退出时序:窗口销毁后可能仍有迟到事件(如 usage_update),别打在死对象上
      if (win && !win.isDestroyed()) win.webContents.send("session:event", { key, record })
    },
    getDriver,
    activeRouting,
    (record) => providers.resolveSelection({
      harnessId: record.harnessId === "glm" ? "claude-code" : record.harnessId,
      cwd: record.cwd,
      ...(record.providerId ? { providerId: record.providerId } : {}),
      ...(record.modelId ? { modelId: record.modelId } : {}),
    }),
    configAdapters,
    resolveProviderRuntimes,
    ({ sessionKey, cwd }) => appRuntime.prepare(sessionKey, cwd),
    () => {
      if (win && !win.isDestroyed()) win.webContents.send("sessions:changed")
    },
  )

  // UI 桥:协作命令发主窗口;presence 由 renderer 上报(Phase 2)。
  uiBridge = new UiCommandBridge((command) => {
    if (!win || win.isDestroyed()) return false
    win.webContents.send("collaboration:ui-command", command)
    return true
  })

  // Phase 1d:协作服务接线。selection 校验要求 exact providerId/modelId。
  const collaborationBackend = new SessionCollaborationBackend(sessions, async (request) => {
    const resolved = await providers.resolveSelection({
      harnessId: request.harnessId === "glm" ? "claude-code" : (request.harnessId as Parameters<typeof providers.resolveSelection>[0]["harnessId"]),
      cwd: request.cwd,
      providerId: request.providerId,
      modelId: request.modelId,
    })
    return Boolean(resolved) &&
      resolved!.providerId === request.providerId &&
      resolved!.modelId === request.modelId
  })
  const collaborationCatalog = new AgentSelectionCatalog(
    providers,
    listHarnessRuntimeStatuses,
    (sessionId) => sessions.listSessions().find((record) => record.key === sessionId)?.cwd ?? null,
  )
  collaborationService = new CollaborationService(collaborationBackend, {
    ui: uiBridge!,
    uiAvailable: () => Boolean(win && !win.isDestroyed()),
    catalog: collaborationCatalog,
  })

  // IPC:renderer 经 preload 调这些;错误统一转成 { error } 而不是抛穿
  ipcMain.handle("session:create", async (_e, opts: {
    scope?: SessionScope
    harnessId: HarnessId
    cwd: string
    title?: string
    providerId: string
    modelId: string
    effort?: Effort
    permissionProfile?: PermissionProfile
  }) => {
    try {
      const { key, record } = sessions.createPendingSession(opts)
      return { key, record }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("harness-runtime:list", () => listHarnessRuntimeStatuses())
  // 液态玻璃主题:整窗接 NSVisualEffectView。两个配套动作:
  // 1. vibrancy 要透出桌面,窗口背景必须切成全透明(默认白底会盖住材质)
  // 2. 材质明暗默认跟随系统外观,但玻璃的明暗是 app 内自选——用 themeSource
  //    强制材质与所选一致,否则深主题的白字会落在系统亮材质上
  ipcMain.on("theme:vibrancy", (event, payload: unknown) => {
    if (process.platform !== "darwin") return
    const w = BrowserWindow.fromWebContents(event.sender)
    if (!w) return
    const { on, dark } = (payload ?? {}) as { on?: boolean; dark?: boolean }
    if (on === true) {
      nativeTheme.themeSource = dark ? "dark" : "light"
      w.setBackgroundColor("#00000000")
      w.setVibrancy("fullscreen-ui")
    } else {
      w.setVibrancy(null)
      w.setBackgroundColor("#ffffff")
      nativeTheme.themeSource = "system"
    }
  })
  // 本地资料的默认显示名:macOS 系统用户名(无账户系统,纯装饰)
  ipcMain.handle("system:username", () => {
    try {
      return os.userInfo().username
    } catch {
      return null
    }
  })
  ipcMain.handle("session:prompt", async (_e, key: string, input: PromptInput) => {
    try {
      const res = await sessions.prompt(key, input)
      return { stopReason: res.stopReason }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:queue-prompt", async (
    _e,
    key: string,
    input: PromptInput,
    clientMessageId: string,
  ) => {
    try {
      return await sessions.queuePrompt(key, input, clientMessageId)
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:steer-queued", async (_e, key: string, clientMessageId: string) => {
    try {
      await sessions.steerQueuedPrompt(key, clientMessageId)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:cancel-queued", (_e, key: string, clientMessageId: string) => {
    sessions.cancelQueuedPrompt(key, clientMessageId)
    return { ok: true }
  })
  ipcMain.handle("session:cancel", (_e, key: string) => sessions.cancel(key))
  ipcMain.handle("apps:list", () => apps.list())
  ipcMain.handle("apps:set-enabled", (_event, id: BentoAppId, enabled: boolean) => {
    try {
      apps.setEnabled(id, enabled)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("apps:upsert", (_event, input: UserAppInput) => {
    try {
      return { app: apps.upsert(input) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("apps:remove", (_event, id: string) => {
    try {
      apps.remove(id)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:set-model", async (
    _e,
    key: string,
    selection: { providerId: string; modelId: string },
  ) => {
    try {
      return { record: await sessions.setModel(key, selection.providerId, selection.modelId) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:set-effort", async (_e, key: string, effort: Effort) => {
    try {
      return { record: await sessions.setEffort(key, effort) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:set-permission-profile", async (_e, key: string, profile: PermissionProfile) => {
    try {
      return { record: await sessions.setPermissionProfile(key, profile) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:resolve-approval", async (_e, key: string, id: string, decision: ApprovalDecision) => {
    try {
      sessions.resolveApproval(key, id, decision)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("permission-rules:list", () =>
    listPermissionRulesByProject(sessions.listSessions().map((record) => record.cwd)),
  )
  ipcMain.handle("permission-rules:remove", (_e, cwd: string, harnessId: string, rule: string) => ({
    ok: removePermissionRule(cwd, harnessId, rule),
  }))
  ipcMain.handle("session:close", async (_e, key: string) => sessions.closeSession(key))
  ipcMain.handle("session:list", () =>
    sessions.listSessions().map((r) => ({
      ...r,
      live: sessions.isLive(r.key),
      runtime: sessions.runtimeStatus(r.key),
    })),
  )
  ipcMain.on("collaboration:ui-state", (_e, presence: unknown) => {
    uiBridge?.report(presence)
    // 焦点同步给 SessionManager:done(未读)投影的唯一"已看"来源;
    // 非法 payload 由 bridge 忽略,这里同样只做宽松提取。
    const focused = (presence as { focusedSessionId?: unknown } | null)?.focusedSessionId
    sessions.noteUiFocus(typeof focused === "string" ? focused : null)
  })
  ipcMain.handle("session:rename", (_e, key: string, title: string) => {
    try {
      return { record: sessions.renameSession(key, title) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("session:remove", async (_e, key: string) => sessions.removeSession(key))
  ipcMain.handle("session:events", (_e, key: string) => sessions.readEvents(key))
  ipcMain.handle("provider:list", (_e, options: {
    harnessId: HarnessId
    cwd?: string
    discover?: boolean
    refresh?: boolean
  }) => providers.list(options))

  ipcMain.handle("provider:model-visibility", (
    _e,
    payload: { providerId: string; updates: Array<{ modelId: string; enabled: boolean }> },
  ) => {
    if (!payload.providerId.trim()) return { error: "供应商标识不能为空" }
    modelVisibility.set(payload.providerId, payload.updates)
    return { ok: true }
  })

  ipcMain.handle("provider-preset:list", () => PROVIDER_PRESETS.map(providerPresetView))

  ipcMain.handle("provider-import:scan", () => localProviderScanner.scan())

  ipcMain.handle("provider-import:inspect", async (_e, candidateId: string) => {
    const candidate = localProviderScanner.candidate(candidateId)
    if (!candidate) return { error: "candidate-expired", message: "检测结果已失效，请重新扫描" }
    if (!candidate.credentialReusable) return { error: "reauth-required", message: "该登录状态不能安全复制，需要重新鉴权" }
    const preset = getProviderPreset(candidate.presetId)
    const apiKey = localProviderScanner.credential(candidateId)
    if (!preset || !apiKey) return { error: "credential-missing", message: "没有可复用凭证" }
    const localModels = localProviderScanner.localModels(candidateId) ?? []
    // 有 key 且预设带列表端点时自动拉远端全量,与来源自带清单合并:
    // 来源模型排前并默认勾选,远端多出来的排后、默认不勾(本地无清单时全部勾)。
    // 远端失败且本地无清单时如实报错;有本地清单则静默回退。
    if (preset.modelDiscovery.method === "http") {
      const auth = preset.auth.method === "apiKey"
        ? preset.auth.discovery ?? preset.auth.inference
        : undefined
      const discovered = await providerDiscovery.discoverHttpModels({
        modelsUrl: preset.modelDiscovery.url,
        apiKey,
        auth,
        parser: preset.modelDiscovery.parser,
      })
      if (discovered.ok) {
        const localIds = new Set(localModels.map((model) => model.id))
        const remoteOnly = discovered.models.filter((model) => !localIds.has(model.id))
        return {
          ok: true,
          models: [
            ...localModels,
            ...remoteOnly.map((model) => ({ ...model, enabled: localModels.length === 0 })),
          ],
        }
      }
      if (localModels.length === 0) return discovered
    }
    if (localModels.length > 0) return { ok: true, models: localModels }
    if (preset.modelDiscovery.method === "manual")
      return { error: "manual-required", message: "该供应商没有可验证的模型列表，请手动添加模型 ID" }
    return { error: "adapter-required", message: "该供应商需要专用发现适配器" }
  })

  ipcMain.handle("provider-import:save", (
    _e,
    payload: { candidateId: string; models: unknown[] },
  ) => {
    try {
      const candidate = localProviderScanner.candidate(payload.candidateId)
      const apiKey = localProviderScanner.credential(payload.candidateId)
      const preset = candidate ? getProviderPreset(candidate.presetId) : undefined
      if (!candidate || !preset || !apiKey || !candidate.credentialReusable)
        return { error: "检测结果已失效或凭证不可复用" }
      const config = providerConfigFromPreset(
        preset,
        payload.models as Parameters<typeof providerConfigFromPreset>[1],
      )
      return { config: customProviders.upsert(config, { "*": apiKey }) }
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) }
    }
  })

  ipcMain.handle("provider-preset:discover", async (
    _e,
    payload: { presetId: string; providerId?: string; apiKey?: string },
  ) => {
    const preset = getProviderPreset(payload.presetId)
    if (!preset) return { error: "unknown-preset", message: "供应商预设不存在" }
    if (!preset.directConnect) return { error: "adapter-required", message: "该供应商需要专用接入流程" }
    const storedKey = payload.providerId
      ? customProviders.readKey(payload.providerId, "pi") ?? customProviders.readKey(payload.providerId, "claude-code") ?? customProviders.readKey(payload.providerId, "codex")
      : null
    const apiKey = payload.apiKey?.trim() || storedKey || undefined
    if (preset.auth.method === "apiKey" && !apiKey)
      return { error: "no-key", message: "请输入 API Key" }
    if (preset.modelDiscovery.method === "manual")
      return { error: "manual-required", message: "该供应商没有可验证的模型列表，请手动添加模型 ID" }
    if (preset.modelDiscovery.method === "adapter")
      return { error: "adapter-required", message: "该供应商需要专用模型发现适配器" }
    const auth = preset.auth.method === "apiKey"
      ? preset.auth.discovery ?? preset.auth.inference
      : undefined
    return providerDiscovery.discoverHttpModels({
      modelsUrl: preset.modelDiscovery.url,
      apiKey,
      auth,
      parser: preset.modelDiscovery.parser,
    })
  })

  ipcMain.handle("provider-preset:save", (
    _e,
    payload: { presetId: string; providerId?: string; name?: string; apiKey?: string; models: unknown[] },
  ) => {
    try {
      const preset = getProviderPreset(payload.presetId)
      if (!preset) return { error: "供应商预设不存在" }
      if (!preset.directConnect) return { error: "该供应商需要专用接入流程" }
      const storedKey = payload.providerId
        ? customProviders.readKey(payload.providerId, "pi") ?? customProviders.readKey(payload.providerId, "claude-code") ?? customProviders.readKey(payload.providerId, "codex")
        : null
      if (preset.auth.method === "apiKey" && !payload.apiKey?.trim() && !storedKey) return { error: "请输入 API Key" }
      const config = providerConfigFromPreset(
        preset,
        payload.models as Parameters<typeof providerConfigFromPreset>[1],
        payload.name?.trim() || preset.name,
      )
      return {
        config: customProviders.upsert(
          config,
          preset.auth.method === "apiKey" && payload.apiKey?.trim()
            ? { "*": payload.apiKey.trim() }
            : undefined,
        ),
      }
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) }
    }
  })

  // ---- 用户自定义供应商 CRUD + 列模型拉取 ----
  // key 与 hasKey 只在这两个通道出入;renderer 永远拿不到明文 key
  ipcMain.handle("custom-provider:list", () => customProviders.listView())

  ipcMain.handle("provider:oauth-login", async (_e, providerId: string) => {
    try {
      const config = customProviders.getProviderConfig(providerId)
      if (!config) return { error: "供应商不存在" }
      if (config.auth.method !== "oauth") return { error: "该供应商未配置 OAuth" }
      const result = await runOAuthLogin(config.auth.oauth)
      if ("error" in result) return { error: result.error.message }
      customProviders.setOAuthTokens(providerId, result)
      return { ok: true }
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) }
    }
  })

  ipcMain.handle("provider:oauth-logout", (_e, providerId: string) => {
    const config = customProviders.getProviderConfig(providerId)
    if (!config || config.auth.method !== "oauth") return { error: "该供应商未配置 OAuth" }
    activeRouting.revokeProvider(providerId)
    customProviders.clearOAuthTokens(providerId)
    return { ok: true }
  })

  ipcMain.handle("custom-provider:upsert", async (
    _e,
    payload: { config: unknown; keys?: Record<string, string> },
  ) => {
    try {
      const config = payload.config as CustomProviderConfig
      return { config: customProviders.upsert(config, payload.keys) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle("custom-provider:remove", (_e, providerId: string) => {
    try {
      activeRouting.revokeProvider(providerId)
      customProviders.remove(providerId)
      return {}
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })

  /** 拉模型:优先用表单里现填的 key(未保存也能测),回落已存密钥。 */
  ipcMain.handle("custom-provider:fetch-models", async (
    _e,
    payload: {
      providerId?: string
      modelsUrl: string
      apiKey?: string
      agent?: string
      auth?: { header: string; prefix?: string; fixedHeaders?: Record<string, string> }
      parser?: "openai-list" | "anthropic-list" | "fireworks-list" | "ollama-tags"
    },
  ) => {
    const config = payload.providerId ? customProviders.getProviderConfig(payload.providerId) : undefined
    const runtime = config && payload.agent
      ? config.runtimes[payload.agent as keyof CustomProviderConfig["runtimes"]]
      : undefined
    const key =
      payload.apiKey?.trim() ||
      (payload.providerId && payload.agent
        ? customProviders.readKey(payload.providerId, payload.agent)
        : null)
    if (!key && config?.auth.method !== "none") return { error: "no-key", message: "没有可用的 API key" }
    const auth = payload.auth ?? runtime?.auth?.discovery ?? runtime?.auth?.inference ??
      (config?.auth.method === "none"
        ? undefined
        : runtime?.wireProtocol === "anthropic-messages"
          ? { header: "x-api-key", fixedHeaders: { "anthropic-version": "2023-06-01" } }
          : { header: "Authorization", prefix: "Bearer " })
    return providerDiscovery.discoverHttpModels({
      modelsUrl: payload.modelsUrl,
      apiKey: key ?? undefined,
      auth,
      parser: payload.parser ?? runtime?.discoveryParser,
    })
  })

  /** 删除确认文案用:该 provider 还有多少活跃会话占着路由。 */
  ipcMain.handle("custom-provider:sessions-using", (_e, providerId: string) =>
    activeRouting.sessionsUsing(providerId))

  ipcMain.handle("project:choose-directory", async () => {
    const options: OpenDialogOptions = {
      title: "选择项目文件夹",
      buttonLabel: "选择",
      properties: ["openDirectory", "createDirectory"],
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? {} : { path: result.filePaths[0] }
  })
  ipcMain.handle("project:create", (_e, opts: { sourceDir: string; name: string }) => {
    try {
      return { path: createProject(opts.sourceDir, opts.name) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle("attachment:save-blob", (_e, input: { name: string; mimeType: string; data: ArrayBuffer }) => {
    try {
      return { path: saveAttachmentBlob(app.getPath("userData"), input) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("shell:open-path", (_e, target: string) => shell.openPath(target))
  ipcMain.handle("file:read-data-url", (_e, target: string) => readFileDataUrl(target))

  ipcMain.handle("workspace-terminal:create", (event, input: { cwd: string; cols: number; rows: number }) => {
    try {
      return { terminal: terminals.create(event.sender.id, input) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.on("workspace-terminal:write", (event, id: string, data: string) => {
    try {
      terminals.write(event.sender.id, id, data)
    } catch {
      // 标签可能已在输入事件到达前关闭
    }
  })
  ipcMain.on("workspace-terminal:resize", (event, id: string, cols: number, rows: number) => {
    try {
      terminals.resize(event.sender.id, id, cols, rows)
    } catch {
      // 标签可能已在 resize 到达前关闭
    }
  })
  ipcMain.handle("workspace-terminal:kill", (event, id: string) => {
    try {
      terminals.kill(event.sender.id, id)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle("workspace-files:list", async (_event, root: string, relativePath: string) => {
    try {
      return { entries: await workspaceFiles.list(root, relativePath) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-files:read", async (_event, root: string, relativePath: string) => {
    try {
      return { preview: await workspaceFiles.read(root, relativePath) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-files:watch", async (event, root: string, directory: string) => {
    try {
      return { subscriptionId: await workspaceFileWatches.watch(event.sender.id, root, directory) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.on("workspace-files:unwatch", (event, subscriptionId: string) => {
    workspaceFileWatches.unwatch(event.sender.id, subscriptionId)
  })

  ipcMain.handle("workspace-browser:create", (event, preferredId?: string) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner) throw new Error("主窗口不可用")
      return { state: workspaceBrowsers.create(event.sender.id, owner, preferredId) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:list", (event) => workspaceBrowsers.list(event.sender.id))
  ipcMain.handle("workspace-browser:navigate", async (event, id: string, url: string) => {
    try {
      await workspaceBrowsers.navigate(event.sender.id, id, url)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.on("workspace-browser:bounds", (event, id: string, bounds: WorkspaceBounds | null) => {
    try {
      workspaceBrowsers.setBounds(event.sender.id, id, bounds)
    } catch {
      // 标签可能已在 ResizeObserver 回调到达前关闭
    }
  })
  ipcMain.on("workspace-browser:back", (event, id: string) => {
    try { workspaceBrowsers.back(event.sender.id, id) } catch { /* closed tab */ }
  })
  ipcMain.on("workspace-browser:forward", (event, id: string) => {
    try { workspaceBrowsers.forward(event.sender.id, id) } catch { /* closed tab */ }
  })
  ipcMain.on("workspace-browser:reload", (event, id: string) => {
    try { workspaceBrowsers.reload(event.sender.id, id) } catch { /* closed tab */ }
  })
  ipcMain.handle("workspace-browser:open-external", async (event, id: string) => {
    try {
      await workspaceBrowsers.openExternal(event.sender.id, id)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:snapshot", async (event, id: string) => {
    try {
      return { snapshot: await workspaceBrowsers.snapshot(event.sender.id, id) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:click", async (event, id: string, nodeId: number) => {
    try {
      await workspaceBrowsers.click(event.sender.id, id, nodeId)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:fill", async (event, id: string, nodeId: number, text: string) => {
    try {
      await workspaceBrowsers.fill(event.sender.id, id, nodeId, text)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:scroll", async (event, id: string, deltaY: number) => {
    try {
      await workspaceBrowsers.scroll(event.sender.id, id, deltaY)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:screenshot", async (event, id: string) => {
    try {
      return { base64: await workspaceBrowsers.screenshot(event.sender.id, id) }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })
  ipcMain.handle("workspace-browser:destroy", (event, id: string) => {
    try {
      workspaceBrowsers.destroy(event.sender.id, id)
      return { ok: true }
    } catch (err) {
      return { error: String(err instanceof Error ? err.message : err) }
    }
  })


  createWindow()

  // 冒烟自测:BENTO_SMOKE=1 时起一个会话跑一轮,验证 main 侧栈,然后退出。
  // BENTO_SMOKE_RESUME=1 追加离线续聊阶段:杀进程后再 prompt,应走 lazy 恢复链
  if (process.env.BENTO_SMOKE === "1") {
    try {
      const harness = (process.env.BENTO_SMOKE_HARNESS as HarnessId) ?? "codex"
      const providerId = process.env.BENTO_SMOKE_PROVIDER
      const modelId = process.env.BENTO_SMOKE_MODEL
      if (!providerId || !modelId) {
        throw new Error("BENTO_SMOKE_PROVIDER/BENTO_SMOKE_MODEL 必须显式指定")
      }
      const { key } = await sessions.createSession({
        harnessId: harness,
        cwd: process.env.BENTO_SMOKE_CWD ?? app.getPath("temp"),
        title: "smoke",
        providerId,
        modelId,
      })
      if (!key) throw new Error("createSession 无 key")
      await sessions.prompt(key, "记住暗号 bento-42,只回复 ok,不要用任何工具。")

      if (process.env.BENTO_SMOKE_RESUME === "1") {
        await sessions.closeSession(key) // 已有 user_message,历史保留,只杀进程
        if (sessions.isLive(key)) throw new Error("closeSession 后仍在线")
        await sessions.prompt(key, "暗号是什么?只回复暗号本身。")
        // 模型回复按 chunk 落多条统一事件,拼完整流再查暗号
        const reply = sessions
          .readEvents(key)
          .map((e) => {
            if (e.kind === "event") {
              const event = e.payload as { type?: string; text?: string }
              return event.type === "agent_message_chunk" ? (event.text ?? "") : ""
            }
            const u = e.payload as { sessionUpdate?: string; content?: { text?: string } }
            return u?.sessionUpdate === "agent_message_chunk" ? (u.content?.text ?? "") : ""
          })
          .join("")
        console.log("[smoke] 离线续聊回复:", reply.trim().slice(0, 40))
        console.log(
          "[smoke] 离线续聊:",
          reply.includes("bento-42") ? "上下文延续 ✅" : "上下文未延续 ⚠️(降级路径也算过)",
        )
      }

      const events = sessions.readEvents(key)
      console.log(
        "[smoke] harness:", harness,
        "| 落盘事件:", events.length,
        "| 种类:", [...new Set(events.map((e) => e.kind))].join(","),
      )
      console.log("[smoke] OK")
    } catch (err) {
      console.error("[smoke] FAILED:", err)
      process.exitCode = 1
    } finally {
      await sessions.disposeAll()
      app.quit()
    }
  }
}).catch((error) => {
  console.error("[main] 初始化失败:", error)
  app.quit()
})

app.on("window-all-closed", () => {
  void sessions?.disposeAll()
  terminals?.disposeAll()
  workspaceBrowsers?.disposeAll()
  workspaceFileWatches?.disposeAll()
  if (process.platform !== "darwin") {
    void appRuntime?.close()
    app.quit()
  }
})

app.on("before-quit", () => void appRuntime?.close())

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
