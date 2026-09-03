/**
 * 会话管理(main 侧):编排 HarnessDriver,并把统一事件追加到唯一 JSONL 日志。
 * Driver 不接触持久化和 Electron IPC。
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { HarnessEvent, HarnessUsage, LogRecord } from "../src/core/events"
import type { CollaborationSession, MessageOrigin, SessionRuntimeStatus } from "../src/core/collaboration"
import { CollaborationError } from "../src/core/collaboration"
import type { Effort, PromptAttachment, PromptInput, SessionScope } from "../src/core/types"
import { getDriver } from "./drivers/registry"
import { assertHarnessCwd } from "./harness-runtime"
import type { ProviderRoutingService } from "./provider-routing"
import type { AppSessionLease } from "./app-runtime-host"
import { appStartOptions } from "./app-harness-adapter"
import type {
  BentoModelSelection,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./session-config/types"
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
  /** SessionConfigAdapter 签发的配置租约(所有会话必有)。 */
  configLease: SessionConfigLease
  appLease?: AppSessionLease
  seq: number
  logStream: fs.WriteStream
  hasUserMessage: boolean
  disposeExit: () => void
  /** cancel() 打标,prompt() 入口清零;catch 据此区分 turn_finished 的 reason */
  cancelRequested: boolean
  /** 当前运行中的根 Prompt;null = idle。startPrompt 原子占用。 */
  activeTurn: ActiveTurn | null
  /** 人类在运行中提交的一条可见后续消息；本轮结束后自动启动。 */
  queuedPrompt: QueuedPrompt | null
}

/** 一次根 Prompt 的运行态:acceptedSeq 关联提交,completion 携带回合结果。 */
type ActiveTurn = {
  acceptedSeq: number
  completion: Promise<TurnResult>
}

type QueuedPrompt = {
  clientMessageId: string
  input: PromptInput
}

type TurnResult = {
  stopReason?: string
  usage?: HarnessUsage
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

/** 协作层状态事件(main 内);waitForCollaborationState 的通知源。 */
export type CollaborationStateEvent = {
  key: string
  type: "turn_started" | "turn_settled" | "message_appended" | "session_sleeping" | "session_removed"
  seq?: number
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
    /** session-config registry;缺省时 adapterFor 抛错(装配错误)。 */
    private readonly configAdapters: SessionConfigRegistry | null = null,
    private readonly resolveProviderRuntimes: SessionProviderRuntimeResolver | null = null,
    private readonly resolveApps: SessionAppsResolver | null = null,
    /** index 变化(create/rename/remove)后通知;main 转发 sessions:changed。 */
    private readonly onSessionsChanged?: () => void,
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

  private append(session: LiveSession, event: HarnessEvent): number {
    // §3.4 规则 1:流已 end(进程退出/会话关闭)后整条 append 跳过——
    // 不递增 seq、不落盘、不广播。若只广播不落盘,内存消耗的 seq 与 revive
    // 时从磁盘重建的 seq 会撞车,renderer 按 seq 去重会误杀回合首个事件;
    // 而 UI 不需要这条记录:退出路径的 notice 已在 end 前落盘并终结 draft,
    // stopLive 路径(disposeExit 后无 notice)由 renderer 回放终界规则
    // (finalizeTrailing)兜底。
    if (session.logStream.writableEnded) return -1
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
    // 只有真正"可读消息"才通知 message_appended;thought/tool/metadata/
    // turn_finished 不算,避免 next_message 被非正文事件误唤醒。
    if (
      event.type === "user_message" ||
      event.type === "agent_message_chunk" ||
      event.type === "notice"
    ) {
      this.notifyCollaboration({
        key: session.record.key,
        type: "message_appended",
        seq: record.seq,
      })
    }
    return record.seq
  }

  private async connectSession(record: SessionRecord): Promise<LiveSession> {
    assertHarnessCwd(record.cwd)
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

    // ---- session-config adapter 路径:全部 Harness 必须有 Bento adapter ----
    const selected: BentoModelSelection = { providerId: record.providerId, modelId: record.modelId }
    const adapter = this.adapterFor(record.harnessId)
    const providers = await this.resolveProviderRuntimes?.({
      harnessId: record.harnessId,
      cwd: record.cwd,
    })
    const configLease = await adapter.prepare({
      sessionKey: record.key,
      harnessId: record.harnessId as HarnessId,
      cwd: record.cwd,
      selected,
      providers: providers ?? [],
    })
    // 租约 env 为空 = 该 Harness 只需隔离目录不需要 env 注入(routed 形态总会有 env)。
    const proxyEnv = Object.keys(configLease.env).length > 0 || configLease.strip.length > 0
      ? { env: configLease.env, strip: configLease.strip }
      : undefined

    // wire id 用 lease 的 harnessModelId(Kimi=alias/id 等)。
    const wireModelId = configLease.selected.harnessModelId
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
      /** SessionConfigAdapter 签发的配置租约。 */
      configLease,
      appLease,
      seq: prior.at(-1)?.seq ?? 0,
      logStream: fs.createWriteStream(logPath, { fd: fs.openSync(logPath, "a") }),
      hasUserMessage: prior.some(
        (item) =>
          (item.kind === "event" && (item.payload as HarnessEvent).type === "user_message") ||
          item.kind === "user_message",
      ),
      disposeExit: () => {},
      cancelRequested: false,
      activeTurn: null,
      queuedPrompt: null,
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

  /** harness 必须有 Bento adapter;缺失是装配错误,直接抛出不静默降级。 */
  private adapterFor(harnessId: DriverId): SessionConfigAdapter {
    if (!this.configAdapters) throw new Error("会话配置服务不可用")
    const normalized = harnessId === "glm" ? "claude-code" : harnessId
    if (!this.configAdapters.has(normalized)) {
      throw new Error(`harness ${normalized} 缺少 Bento session-config adapter`)
    }
    return this.configAdapters.get(normalized)
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
    this.onSessionsChanged?.()
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
    this.onSessionsChanged?.()
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
    const { completion } = await this.startPrompt(key, value)
    return completion
  }

  /** 协作 send 入口:原子占用目标 Session 的 active turn,落原文+origin,
   * 只把 wireText(envelope)送进 Harness。不等待回合完成;调用方按需
   * await completion 或用 waitForTurn(acceptedSeq) 等 settled。 */
  async startPrompt(
    key: string,
    value: string | PromptInput,
    opts: { wireText?: string; origin?: MessageOrigin; clientMessageId?: string } = {},
  ): Promise<{ acceptedSeq: number; completion: Promise<TurnResult> }> {
    // 每 key 串行化 guard 检查与 activeTurn 占用,保证并发 send 原子地一胜一败。
    const previous = this.turnChains.get(key) ?? Promise.resolve()
    const chained = previous.catch(() => {}).then(() => this.beginTurn(key, value, opts))
    // map 里存 gate(catch 链),cleanup 比较同一个 gate 才能真正删掉。
    const gate = chained.catch(() => {})
    this.turnChains.set(key, gate)
    void gate.then(() => {
      if (this.turnChains.get(key) === gate) this.turnChains.delete(key)
    })
    return chained
  }

  private async beginTurn(
    key: string,
    value: string | PromptInput,
    opts: { wireText?: string; origin?: MessageOrigin; clientMessageId?: string },
  ): Promise<{ acceptedSeq: number; completion: Promise<TurnResult> }> {
    const session = await this.ensureLive(key)
    if (session.activeTurn) throw new CollaborationError("session_busy")
    const input = promptInput(value)
    // 入口清零:上一次 cancel 若走 happy path(ACP/Codex 的 prompt 正常
    // resolve)标记会残留,不清零会让同会话下一次真实 error 被误标 cancelled。
    session.cancelRequested = false
    const acceptedSeq = this.append(session, {
      type: "user_message",
      text: input.text,
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
      ...(input.attachments.length ? {
        attachments: input.attachments.map(({ name, kind }) => ({ name, kind })),
      } : {}),
    })
    // JSONL/UI 落原文;Harness 只收到 wireText(envelope),envelope 不落盘。
    const wire: PromptInput = {
      text: opts.wireText ?? input.text,
      attachments: input.attachments,
    }
    const completion = session.connection.prompt(wire)
      .then((result) => {
        this.append(session, { type: "turn_finished", reason: result.stopReason, ...(result.usage ? { usage: result.usage } : {}) })
        this.upsertRecord(session.record)
        return result
      })
      .catch((error: unknown) => {
        // §3.4 规则 2:错误/中断路径同样要有回合终点。Claude 的 interrupt 与
        // 出错走同一条 throw 路径,只能靠 cancelRequested 区分;流若已 end
        // (exitListeners 先于本 catch 触发),append 守卫会整条跳过。
        this.append(session, {
          type: "turn_finished",
          reason: session.cancelRequested ? "cancelled" : "error",
        })
        throw error
      })
      .finally(() => {
        if (session.activeTurn?.acceptedSeq === acceptedSeq) session.activeTurn = null
        this.notifyCollaboration({ key, type: "turn_settled", seq: acceptedSeq })
        const queued = session.queuedPrompt
        if (queued) {
          session.queuedPrompt = null
          void this.startPrompt(key, queued.input, { clientMessageId: queued.clientMessageId })
            .then(({ completion }) => completion.catch(() => {}))
            .catch((error) => {
              this.append(session, {
                type: "notice",
                text: `待发送消息启动失败:${error instanceof Error ? error.message : String(error)}`,
              })
            })
        }
      })
    session.activeTurn = { acceptedSeq, completion }
    this.notifyCollaboration({ key, type: "turn_started", seq: acceptedSeq })
    return { acceptedSeq, completion }
  }

  async queuePrompt(
    key: string,
    value: string | PromptInput,
    clientMessageId: string,
  ): Promise<{ status: "queued" | "started"; steerAvailable: boolean }> {
    const session = await this.ensureLive(key)
    const input = promptInput(value)
    if (!session.activeTurn) {
      const { completion } = await this.startPrompt(key, input, { clientMessageId })
      completion.catch(() => {})
      return { status: "started", steerAvailable: false }
    }
    if (session.queuedPrompt) throw new Error("已有一条待发送消息")
    session.queuedPrompt = { clientMessageId, input }
    return {
      status: "queued",
      steerAvailable: session.connection.capabilities.steer === "live" && Boolean(session.connection.steer),
    }
  }

  async steerQueuedPrompt(key: string, clientMessageId: string): Promise<void> {
    const session = this.live.get(key)
    const queued = session?.queuedPrompt
    if (!session?.activeTurn || !queued || queued.clientMessageId !== clientMessageId) {
      throw new Error("待发送消息不存在")
    }
    if (session.connection.capabilities.steer !== "live" || !session.connection.steer) {
      throw new Error("当前 Harness 不支持即时引导")
    }
    await session.connection.steer(queued.input)
    session.queuedPrompt = null
    this.append(session, {
      type: "user_steer",
      text: queued.input.text,
      clientMessageId,
    })
  }

  cancelQueuedPrompt(key: string, clientMessageId: string): void {
    const session = this.live.get(key)
    if (session?.queuedPrompt?.clientMessageId === clientMessageId) session.queuedPrompt = null
  }

  /** 精确等待:只等同一 Session 且 acceptedSeq 匹配的 active turn;seq 不匹配
   * 或无 active turn 说明目标 turn 已 settled,立即返回。其它 Session 的完成
   * 绝不能唤醒本等待。超时只终止等待,不 cancel 目标。 */
  async waitForTurn(key: string, acceptedSeq: number, timeoutMs = 30_000): Promise<void> {
    const turn = this.live.get(key)?.activeTurn
    if (!turn || turn.acceptedSeq !== acceptedSeq) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new CollaborationError("timeout"))
      }, timeoutMs)
      turn.completion.then(finish, finish)
    })
  }

  private turnChains = new Map<string, Promise<unknown>>()

  /** test-only:未清理的 turn chain gate 数量,验证链 cleanup。 */
  pendingTurnChainCount(): number {
    return this.turnChains.size
  }

  // ---- 协作状态订阅(事件驱动,无 polling) ----

  async waitForCollaborationState(
    key: string,
    accept: (event: CollaborationStateEvent) => boolean,
    timeoutMs: number,
    /** 注册完成后同步执行的当前状态探测;消除"检查与订阅"之间的竞态。 */
    probe?: () => CollaborationStateEvent | undefined,
  ): Promise<CollaborationStateEvent> {
    return new Promise((resolve, reject) => {
      const waiter = {
        key,
        accept,
        resolve: (event: CollaborationStateEvent) => {
          const index = this.collaborationWaiters.indexOf(waiter)
          if (index >= 0) this.collaborationWaiters.splice(index, 1)
          clearTimeout(timer)
          resolve(event)
        },
      }
      const timer = setTimeout(() => {
        const index = this.collaborationWaiters.indexOf(waiter)
        if (index >= 0) this.collaborationWaiters.splice(index, 1)
        reject(new CollaborationError("timeout"))
      }, timeoutMs)
      this.collaborationWaiters.push(waiter)
      // 先注册,后 probe:probe 命中即同步完成;之后的 notify 走 waiter。
      const probed = probe?.()
      if (probed && accept(probed)) waiter.resolve(probed)
    })
  }

  private collaborationWaiters: Array<{
    key: string
    accept: (event: CollaborationStateEvent) => boolean
    resolve: (event: CollaborationStateEvent) => void
  }> = []

  private notifyCollaboration(event: CollaborationStateEvent) {
    // 换出遍历:waiter.resolve 会从 collaborationWaiters splice 自身,
    // 直接迭代原数组会跳元素;期间新注册的 waiter 保留在新数组里。
    const waiters = this.collaborationWaiters
    this.collaborationWaiters = []
    const keep: typeof waiters = []
    for (const waiter of waiters) {
      if (waiter.key === event.key && waiter.accept(event)) waiter.resolve(event)
      else keep.push(waiter)
    }
    this.collaborationWaiters = [...keep, ...this.collaborationWaiters]
  }

  /** 当前 active turn 的 acceptedSeq;无运行中 turn 返回 null。 */
  activeTurnSeq(key: string): number | null {
    return this.live.get(key)?.activeTurn?.acceptedSeq ?? null
  }

  /** 协作 runtime 投影:sleeping/idle/working。 */
  runtimeStatus(key: string): SessionRuntimeStatus {
    const session = this.live.get(key)
    if (!session) return "sleeping"
    return session.activeTurn ? "working" : "idle"
  }

  /** CollaborationSession 投影;不存在返回 null。 */
  collaborationSession(key: string): CollaborationSession | null {
    const record = this.listSessions().find((item) => item.key === key)
    if (!record) return null
    const live = this.live.get(key)
    return {
      id: record.key,
      title: record.title,
      workspace: record.scope === "chat"
        ? { scope: "chat" }
        : { scope: "project", cwd: record.cwd },
      // legacy glm 会话恢复时已迁移为 claude-code;投影不得产出非法 HarnessId。
      harnessId: (record.harnessId === "glm" ? "claude-code" : record.harnessId) as CollaborationSession["harnessId"],
      providerId: record.providerId ?? "",
      modelId: record.modelId ?? "",
      ...(record.effort ? { effort: record.effort } : {}),
      runtime: this.runtimeStatus(key),
      updatedAt: record.updatedAt,
      lastSeq: live?.seq ?? this.readEvents(key).at(-1)?.seq ?? 0,
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
    const adapter = this.adapterFor(session.record.harnessId)
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
    this.onSessionsChanged?.()
    return record
  }

  private async stopLive(key: string) {
    const session = this.live.get(key)
    if (!session) return
    this.live.delete(key)
    // dispose 只释放活跃资源(routes),保留可恢复的隔离目录。
    session.disposeExit()
    session.connection.close()
    session.logStream.end()
    await session.configLease.dispose()
    await session.appLease?.dispose()
  }

  /** 彻底删除会话的 adapter 侧持久状态;按 index 记录定位 adapter(历史会话也适用)。 */
  private async removeAdapterState(key: string) {
    const record = this.listSessions().find((item) => item.key === key)
    if (!record?.providerId || !record.modelId) return
    const normalized = record.harnessId === "glm" ? "claude-code" : record.harnessId
    if (!this.configAdapters?.has(normalized)) return
    await this.configAdapters.get(normalized).removeSessionState?.(key)
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
    this.onSessionsChanged?.()
    this.notifyCollaboration({ key, type: "session_removed" })
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
            (item.kind === "event" && (item.payload as HarnessEvent).type === "user_message") ||
            (item.kind === "user_message"),
        )
    // 普通关闭:仅 dispose(routes),保留隔离目录供 revive 复用;
    // 空会话(无 user_message)关闭即删档,连同 adapter 状态一起清理。
    await this.stopLive(key)
    if (empty) {
      // 空会话直接删档,removed 由 removeSession 统一发出,不重复。
      await this.removeSession(key)
    } else {
      // 普通 close:record 保留,只是 Harness 下线。
      this.notifyCollaboration({ key, type: "session_sleeping" })
    }
  }

  async disposeAll() {
    for (const key of [...this.live.keys()]) await this.closeSession(key)
  }
}
