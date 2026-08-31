/**
 * 会话管理(main 侧):编排 HarnessDriver,并把统一事件追加到唯一 JSONL 日志。
 * Driver 不接触持久化和 Electron IPC。
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { HarnessEvent, LogRecord } from "../src/core/events"
import { isNativeProviderId, NATIVE_MODEL_ID } from "../src/core/provider"
import type { Effort, PromptAttachment, PromptInput, SessionScope } from "../src/core/types"
import { getDriver } from "./drivers/registry"
import type { ProviderRoutingService } from "./provider-routing"
import type { AppSessionLease } from "./app-runtime-host"
import { appStartOptions } from "./app-harness-adapter"
import type {
  BentoModelSelection,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./session-config/types"
import { modeOfSelection } from "./session-config/types"
import type { SessionConfigRegistry } from "./session-config/registry"
import type {
  DriverId,
  HarnessCapabilities,
  HarnessConnection,
  HarnessDriver,
  HarnessId,
} from "./drivers/types"

export type SessionRecord = {
  key: string
  scope: SessionScope
  harnessId: DriverId
  cwd: string
  nativeSessionId: string
  providerId?: string
  modelId?: string
  effort?: Effort
  capabilities?: HarnessCapabilities
  title: string
  createdAt: string
  updatedAt: string
}

type LiveSession = {
  record: SessionRecord
  connection: HarnessConnection
  /** SessionConfigAdapter 签发的配置租约;legacy 路径没有。 */
  configLease?: SessionConfigLease
  appLease?: AppSessionLease
  seq: number
  logStream: fs.WriteStream
  hasUserMessage: boolean
  disposeExit: () => void
  /** cancel() 打标,prompt() 入口清零;catch 据此区分 turn_finished 的 reason */
  cancelRequested: boolean
}

type ProviderSelectionResolver = (record: Pick<SessionRecord,
  "harnessId" | "cwd" | "providerId" | "modelId"
>) => Promise<{ providerId: string; modelId: string } | null>

/**
 * main-only:把 ProviderRegistry/CustomProviderStore 解析成 SessionConfigRequest
 * 的 providers 数组。credential handle 只在 main 侧构造,绝不回 renderer。
 */
export type SessionProviderRuntimeResolver = (request: {
  harnessId: DriverId
  cwd: string
  mode: "native" | "bento"
}) => Promise<SessionConfigRequest["providers"]>

type SessionAppsResolver = (request: {
  sessionKey: string
  harnessId: HarnessId
  cwd: string
}) => Promise<AppSessionLease | null>

function promptInput(value: string | PromptInput): PromptInput {
  const request = typeof value === "string" ? { text: value, attachments: [] } : value
  const text = request.text.trim()
  if (!text && request.attachments.length === 0) throw new Error("消息不能为空")
  const attachments = request.attachments.map((attachment): PromptAttachment => {
    const filePath = path.resolve(attachment.path)
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error(`附件不是文件：${attachment.name}`)
    if (stat.size > 50 * 1024 * 1024) throw new Error(`附件超过 50 MB：${attachment.name}`)
    return {
      name: attachment.name || path.basename(filePath),
      path: filePath,
      mimeType: attachment.mimeType || "application/octet-stream",
      size: stat.size,
      kind: attachment.kind,
    }
  })
  return { text, attachments }
}

export class SessionManager {
  private live = new Map<string, LiveSession>()
  private reviving = new Map<string, Promise<LiveSession>>()
  private readonly dir: string
  private readonly chatRoot: string

  constructor(
    userDataDir: string,
    private readonly onEvent: (key: string, record: LogRecord) => void,
    /** 测试注入 fake driver 用;prod 缺省走全局 registry */
    private readonly resolveDriver: (id: DriverId) => HarnessDriver = getDriver,
    /** Claude/Codex provider 会话的统一路由服务。 */
    private readonly routing: ProviderRoutingService | null = null,
    private readonly resolveProviderSelection: ProviderSelectionResolver | null = null,
    /** session-config registry;缺省 legacy 路径(全部走旧 routing/env 组装)。 */
    private readonly configAdapters: SessionConfigRegistry | null = null,
    private readonly resolveProviderRuntimes: SessionProviderRuntimeResolver | null = null,
    private readonly resolveApps: SessionAppsResolver | null = null,
  ) {
    this.dir = path.join(userDataDir, "sessions")
    this.chatRoot = path.join(userDataDir, "chat-workspaces")
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.chatRoot, { recursive: true, mode: 0o700 })
  }

  private indexPath() {
    return path.join(this.dir, "index.json")
  }

  private jsonlPath(key: string) {
    return path.join(this.dir, `${key}.jsonl`)
  }

  listSessions(): SessionRecord[] {
    try {
      const records = JSON.parse(fs.readFileSync(this.indexPath(), "utf8")) as Array<
        Omit<SessionRecord, "scope"> & { scope?: SessionScope }
      >
      return records.map((record) => ({ ...record, scope: record.scope ?? "project" }))
    } catch {
      return []
    }
  }

  private saveIndex(records: SessionRecord[]) {
    const tmp = `${this.indexPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2))
    fs.renameSync(tmp, this.indexPath())
  }

  private upsertRecord(record: SessionRecord) {
    this.saveIndex([record, ...this.listSessions().filter((item) => item.key !== record.key)])
  }

  readEvents(key: string): LogRecord[] {
    try {
      return fs
        .readFileSync(this.jsonlPath(key), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogRecord)
    } catch {
      return []
    }
  }

  private append(session: LiveSession, event: HarnessEvent) {
    // §3.4 规则 1:流已 end(进程退出/会话关闭)后整条 append 跳过——
    // 不递增 seq、不落盘、不广播。若只广播不落盘,内存消耗的 seq 与 revive
    // 时从磁盘重建的 seq 会撞车,renderer 按 seq 去重会误杀回合首个事件;
    // 而 UI 不需要这条记录:退出路径的 notice 已在 end 前落盘并终结 draft,
    // stopLive 路径(disposeExit 后无 notice)由 renderer 回放终界规则
    // (finalizeTrailing)兜底。
    if (session.logStream.writableEnded) return
    const record: LogRecord = {
      seq: ++session.seq,
      at: new Date().toISOString(),
      kind: "event",
      payload: event,
    }
    session.logStream.write(`${JSON.stringify(record)}\n`)
    if (event.type === "user_message") session.hasUserMessage = true
    session.record.updatedAt = record.at
    this.onEvent(session.record.key, record)
  }

  private async connectSession(record: SessionRecord): Promise<LiveSession> {
    const legacyGlm = record.harnessId === "glm"
    if (legacyGlm) record.harnessId = "claude-code"
    const resolved = this.resolveProviderSelection
      ? await this.resolveProviderSelection(record)
      : record.providerId && record.modelId
        ? { providerId: record.providerId, modelId: record.modelId }
        : null
    if (!resolved) throw new Error("会话没有可用的明确供应商与模型,请重新选择")
    const migrated = legacyGlm || record.providerId !== resolved.providerId || record.modelId !== resolved.modelId
    record.providerId = resolved.providerId
    record.modelId = resolved.modelId
    if (migrated && this.listSessions().some((item) => item.key === record.key)) {
      this.upsertRecord(record)
    }

    const prior = this.readEvents(record.key)
    const pending: HarnessEvent[] = []
    let session: LiveSession | undefined
    const emit = (event: HarnessEvent) => {
      if (session) this.append(session, event)
      else pending.push(event)
    }

    // ---- session-config adapter 路径(native adapters + Kimi bento;其余 legacy)----
    let configLease: SessionConfigLease | undefined
    const selected: BentoModelSelection = { providerId: record.providerId, modelId: record.modelId }
    const adapter = this.adapterFor(record.harnessId, selected)
    if (adapter) {
      const mode = modeOfSelection(selected)
      const providers = await this.resolveProviderRuntimes?.({
        harnessId: record.harnessId,
        cwd: record.cwd,
        mode,
      })
      configLease = await adapter.prepare({
        sessionKey: record.key,
        harnessId: record.harnessId,
        cwd: record.cwd,
        mode,
        selected,
        providers: providers ?? [],
      })
    }

    const nativeConfig = isNativeProviderId(record.providerId)
    // Bento provider 经隔离路由；本机配置模式让 CLI 自己读取原生凭证与模型。
    let proxyEnv: { env: Record<string, string>; strip?: string[] } | undefined
    const routedHarness = record.harnessId === "claude-code" || record.harnessId === "codex"
    if (configLease && (Object.keys(configLease.env).length > 0 || configLease.strip.length > 0)) {
      proxyEnv = { env: configLease.env, strip: configLease.strip }
    } else if (configLease) {
      proxyEnv = undefined // native 租约:无注入,CLI 直读本机配置
    } else if (!nativeConfig && record.harnessId === "pi") {
      if (!this.routing) throw new Error("路由服务不可用,无法启动 Pi 供应商会话")
      proxyEnv = this.routing.piProviderEnv(record.providerId)
    } else if (!nativeConfig && routedHarness) {
      if (!this.routing) throw new Error("路由服务不可用,无法启动供应商会话")
      const route = await this.routing.issueRoute(record.key, record.providerId, record.harnessId)
      if (record.harnessId === "claude-code") {
        const isolated = this.routing.claudeCodeEnv(route)
        proxyEnv = {
          env: { ...isolated.env, CLAUDE_CONFIG_DIR: this.routing.claudeCodeConfigDir(record.providerId) },
          strip: isolated.strip,
        }
      } else if (record.harnessId === "codex") {
        proxyEnv = this.routing.codexHomeEnv(record.key, route, record.providerId)
      }
    } else if (
      !nativeConfig &&
      record.providerId.startsWith("user-") &&
      ["kimi", "opencode", "omp", "hermes"].includes(record.harnessId)
    ) {
      if (!this.routing) throw new Error("路由服务不可用,无法启动供应商会话")
      proxyEnv = this.routing.configuredHarnessEnv(
        record.key,
        record.providerId,
        record.harnessId as "kimi" | "opencode" | "omp" | "hermes",
        record.modelId,
      )
    }

    // adapter 模式下 wire id 用 lease 的 harnessModelId(native=原始 id,Kimi=alias/id)
    const wireModelId = configLease
      ? configLease.selected.harnessModelId
      : record.modelId !== NATIVE_MODEL_ID ? record.modelId : undefined
    let appLease: AppSessionLease | undefined
    try {
      appLease = await this.resolveApps?.({
        sessionKey: record.key,
        harnessId: record.harnessId as HarnessId,
        cwd: record.cwd,
      }) ?? undefined
    } catch {
      // Apps 是附加能力；单个用户 App 启动失败不能阻断核心 Harness 会话。
    }
    let connection: HarnessConnection
    try {
      connection = await this.resolveDriver(record.harnessId).start(
        {
          cwd: record.cwd,
          ...(record.nativeSessionId ? { nativeSessionId: record.nativeSessionId } : {}),
          ...(record.providerId ? { providerId: record.providerId } : {}),
          ...(wireModelId ? { modelId: wireModelId } : {}),
          ...(record.effort ? { effort: record.effort } : {}),
          ...(proxyEnv ? { proxyEnv } : {}),
          ...(appLease ? appStartOptions(record.harnessId as HarnessId, appLease) : {}),
        },
        emit,
      )
    } catch (error) {
      // start 失败:释放活跃资源并删除会话状态——没有进程就没有可恢复的
      // native session,隔离目录与 routes 一并回收,不泄漏。
      await configLease?.dispose()
      await appLease?.dispose()
      await adapter?.removeSessionState?.(record.key)
      throw error
    }

    record.nativeSessionId = connection.nativeSessionId
    record.capabilities = connection.capabilities
    const logPath = this.jsonlPath(record.key)
    session = {
      record,
      connection,
      /** SessionConfigAdapter 签发的配置租约;legacy 路径没有。 */
      configLease,
      appLease,
      seq: prior.at(-1)?.seq ?? 0,
      logStream: fs.createWriteStream(logPath, { fd: fs.openSync(logPath, "a") }),
      hasUserMessage: prior.some(
        (item) =>
          (item.kind === "event" && item.payload.type === "user_message") ||
          item.kind === "user_message",
      ),
      disposeExit: () => {},
      cancelRequested: false,
    }
    for (const event of pending) this.append(session, event)

    const connected = session
    connected.disposeExit = connection.onExit((code) => {
      if (this.live.get(record.key) === connected) {
        this.append(connected, {
          type: "notice",
          text: `harness 进程退出(${code ?? "signal"})`,
        })
        this.live.delete(record.key)
      }
      connected.logStream.end()
      // 进程异常退出同样走租约回收(stopLive 不会再见到它)
      void connected.configLease?.dispose()
      void connected.appLease?.dispose()
    })
    return connected
  }

  /** (harness, mode) 有 adapter 才走 session-config 路径;其余 legacy。 */
  private adapterFor(harnessId: DriverId, selection: BentoModelSelection): SessionConfigAdapter | null {
    if (!this.configAdapters) return null
    const normalized = harnessId === "glm" ? "claude-code" : harnessId
    if (!this.configAdapters.has(normalized, modeOfSelection(selection))) return null
    return this.configAdapters.get(normalized, modeOfSelection(selection))
  }

  private newRecord(opts: {
    scope?: SessionScope
    harnessId: HarnessId
    cwd: string
    title?: string
    providerId: string
    modelId: string
    effort?: Effort
  }): SessionRecord {
    if (!opts.providerId?.trim() || !opts.modelId?.trim()) {
      throw new Error("新会话必须显式指定 providerId 与 modelId")
    }
    const key = randomUUID()
    const scope = opts.scope ?? "project"
    const cwd = scope === "chat"
      ? path.join(this.chatRoot, key)
      : (opts.cwd.trim() || os.homedir()).replace(/^~(?=$|\/)/, os.homedir())
    if (scope === "chat") fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
    else if (!fs.existsSync(cwd)) throw new Error(`目录不存在: ${cwd}`)

    const now = new Date().toISOString()
    return {
      key,
      scope,
      harnessId: opts.harnessId,
      cwd,
      nativeSessionId: "",
      providerId: opts.providerId,
      modelId: opts.modelId,
      ...(opts.effort ? { effort: opts.effort } : {}),
      title: opts.title ?? "新会话",
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Renderer 首发入口:只持久化会话身份，不阻塞等待 Harness 进程。
   * 首次 prompt 经 ensureLive 惰性连接，用户可以立即进入对话并看到消息。
   */
  createPendingSession(opts: {
    scope?: SessionScope
    harnessId: HarnessId
    cwd: string
    title?: string
    providerId: string
    modelId: string
    effort?: Effort
  }) {
    const record = this.newRecord(opts)
    this.upsertRecord(record)
    return { key: record.key, record }
  }

  async createSession(opts: {
    scope?: SessionScope
    harnessId: HarnessId
    cwd: string
    title?: string
    providerId: string
    modelId: string
    effort?: Effort
  }) {
    const record = this.newRecord(opts)
    let session: LiveSession
    try {
      session = await this.connectSession(record)
    } catch (error) {
      this.removeChatWorkspace(record)
      throw error
    }
    this.live.set(record.key, session)
    this.upsertRecord(record)
    this.append(session, { type: "metadata", name: "session_started", data: { record } })
    return { key: record.key, record }
  }

  private async reviveSession(key: string): Promise<LiveSession> {
    const record = this.listSessions().find((item) => item.key === key)
    if (!record) throw new Error(`会话不存在: ${key}`)
    const session = await this.connectSession(record)
    this.live.set(key, session)
    this.upsertRecord(record)
    return session
  }

  private ensureLive(key: string): Promise<LiveSession> {
    const existing = this.live.get(key)
    if (existing) return Promise.resolve(existing)
    let pending = this.reviving.get(key)
    if (!pending) {
      pending = this.reviveSession(key).finally(() => this.reviving.delete(key))
      this.reviving.set(key, pending)
    }
    return pending
  }

  async prompt(key: string, value: string | PromptInput) {
    const session = await this.ensureLive(key)
    const input = promptInput(value)
    // 入口清零:上一次 cancel 若走 happy path(ACP/Codex 的 prompt 正常
    // resolve)标记会残留,不清零会让同会话下一次真实 error 被误标 cancelled。
    session.cancelRequested = false
    this.append(session, {
      type: "user_message",
      text: input.text,
      ...(input.attachments.length ? {
        attachments: input.attachments.map(({ name, kind }) => ({ name, kind })),
      } : {}),
    })
    try {
      const result = await session.connection.prompt(input)
      this.append(session, { type: "turn_finished", reason: result.stopReason, ...(result.usage ? { usage: result.usage } : {}) })
      this.upsertRecord(session.record)
      return result
    } catch (error) {
      // §3.4 规则 2:错误/中断路径同样要有回合终点。Claude 的 interrupt 与
      // 出错走同一条 throw 路径,只能靠 cancelRequested 区分;流若已 end
      // (exitListeners 先于本 catch 触发),append 守卫会整条跳过。
      this.append(session, {
        type: "turn_finished",
        reason: session.cancelRequested ? "cancelled" : "error",
      })
      throw error
    }
  }

  async cancel(key: string) {
    const session = this.live.get(key)
    if (!session) return
    session.cancelRequested = true
    await session.connection.cancel()
  }

  async setModel(key: string, providerId: string, modelId: string) {
    const session = await this.ensureLive(key)
    if (!session.connection.setModel) throw new Error("当前 harness 不支持切换模型")
    const resolved = this.resolveProviderSelection
      ? await this.resolveProviderSelection({
          harnessId: session.record.harnessId,
          cwd: session.record.cwd,
          providerId,
          modelId,
        })
      : { providerId, modelId }
    if (!resolved || resolved.providerId !== providerId || resolved.modelId !== modelId)
      throw new Error("目标供应商或模型当前不可用")
    const previousProviderId = session.record.providerId
    if (isNativeProviderId(providerId) !== isNativeProviderId(previousProviderId)) {
      throw new Error("本机配置与 Bento 模型之间切换需要新会话")
    }

    // ---- adapter lease 路径:native adapters + Kimi bento ----
    if (session.configLease) {
      const adapter = this.adapterFor(session.record.harnessId, { providerId, modelId })
      if (!adapter) throw new Error("会话配置服务不可用,无法切换")
      const result = await adapter.reconfigure(session.configLease, { providerId, modelId })
      if (result.mode === "new-session") throw new Error(result.reason)
      if (result.mode === "restart") {
        // restart 需要安全 resume 语义,当前未实现:明示需要新会话,不假切换。
        throw new Error("切换需要重启会话进程,当前请新建会话")
      }
      const previousSelection = session.configLease.selected
      try {
        await session.connection.setModel(result.selection.harnessModelId)
      } catch (error) {
        // routed adapter 已原子换过 proxy 指向；底层模型切换失败时恢复旧 route。
        await adapter.reconfigure(session.configLease, previousSelection).catch(() => {})
        throw error
      }
      session.configLease.selected = result.selection
      session.record.providerId = providerId
      session.record.modelId = modelId
      this.upsertRecord(session.record)
      return session.record
    }

    // ---- legacy 路径(无租约) ----
    // Phase 0 正确性封口:kimi/opencode/omp/hermes/pi 的 Bento 隔离配置只含启动时
    // 单个 Provider,进程内切 Provider 会造成 UI 与实际路由不一致,必须在调用
    // connection.setModel 前拒绝。native 模式内跨 native provider 由 CLI 原生
    // 切换承载(spike 已证),允许;claude-code/codex 走代理 switchRoute live。
    const routedHarness = session.record.harnessId === "claude-code" || session.record.harnessId === "codex"
    const isolatedHarness = ["kimi", "opencode", "omp", "hermes", "pi"].includes(session.record.harnessId)
    if (isolatedHarness && !routedHarness && providerId !== previousProviderId) {
      throw new Error("切换供应商需要新会话")
    }
    if (routedHarness && providerId !== previousProviderId) {
      if (!this.routing) throw new Error("路由服务不可用,无法切换供应商")
      await this.routing.switchRoute(key, providerId, session.record.harnessId)
    }
    try {
      await session.connection.setModel(modelId)
    } catch (error) {
      if (routedHarness && providerId !== previousProviderId && previousProviderId) {
        await this.routing?.switchRoute(key, previousProviderId, session.record.harnessId)
      }
      throw error
    }
    session.record.providerId = providerId
    session.record.modelId = modelId
    this.upsertRecord(session.record)
    return session.record
  }

  async setEffort(key: string, effort: Effort) {
    const session = await this.ensureLive(key)
    if (!session.connection.setEffort) throw new Error("当前 harness 不支持切换推理强度")
    await session.connection.setEffort(effort)
    session.record.effort = effort
    this.upsertRecord(session.record)
    return session.record
  }

  isLive(key: string) {
    return this.live.has(key)
  }

  renameSession(key: string, title: string): SessionRecord {
    const record = this.listSessions().find((item) => item.key === key)
    if (!record) throw new Error(`会话不存在: ${key}`)
    record.title = title
    const online = this.live.get(key)
    if (online) online.record.title = title
    this.upsertRecord(record)
    return record
  }

  private async stopLive(key: string) {
    const session = this.live.get(key)
    if (!session) return
    this.live.delete(key)
    // 有租约的会话:dispose 只释放活跃资源(routes),保留可恢复的隔离目录;
    // legacy 会话继续走旧 routing 清理。两者互不重复吊销。
    if (session.configLease) {
      session.disposeExit()
      session.connection.close()
      session.logStream.end()
      await session.configLease.dispose()
      await session.appLease?.dispose()
      return
    }
    this.routing?.revokeRoute(key)
    this.routing?.disposeCodexHome(key)
    this.routing?.disposeConfiguredHarnessHome(key)
    session.disposeExit()
    session.connection.close()
    session.logStream.end()
    await session.appLease?.dispose()
  }

  /** 彻底删除会话的 adapter 侧持久状态;按 index 记录定位 adapter(历史会话也适用)。 */
  private async removeAdapterState(key: string) {
    const record = this.listSessions().find((item) => item.key === key)
    if (!record?.providerId || !record.modelId) return
    const adapter = this.adapterFor(record.harnessId, {
      providerId: record.providerId,
      modelId: record.modelId,
    })
    await adapter?.removeSessionState?.(key)
  }

  private removeChatWorkspace(record: SessionRecord | undefined) {
    if (record?.scope !== "chat") return
    const workspace = path.resolve(record.cwd)
    if (path.dirname(workspace) !== path.resolve(this.chatRoot)) return
    fs.rmSync(workspace, { recursive: true, force: true })
  }

  async removeSession(key: string) {
    const record = this.listSessions().find((item) => item.key === key)
    await this.stopLive(key)
    this.routing?.revokeRoute(key) // 历史会话从无 live 直接删除时兜底
    await this.removeAdapterState(key)
    this.removeChatWorkspace(record)
    this.saveIndex(this.listSessions().filter((item) => item.key !== key))
    try {
      fs.rmSync(this.jsonlPath(key))
    } catch {
      // 文件不存在就算了
    }
  }

  async closeSession(key: string) {
    const session = this.live.get(key)
    const empty = session
      ? !session.hasUserMessage
      : !this.readEvents(key).some(
          (item) =>
            (item.kind === "event" && item.payload.type === "user_message") ||
            (item.kind === "user_message"),
        )
    // 普通关闭:仅 dispose(routes),保留隔离目录供 revive 复用;
    // 空会话(无 user_message)关闭即删档,连同 adapter 状态一起清理。
    await this.stopLive(key)
    if (empty) await this.removeSession(key)
  }

  async disposeAll() {
    for (const key of [...this.live.keys()]) await this.closeSession(key)
  }
}
