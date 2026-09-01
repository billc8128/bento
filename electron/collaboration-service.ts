/**
 * CollaborationService(Electron main):协作工具的编排层。
 *
 * 只做调用者绑定、目标校验、跨项目 list、配置继承 create、消息收发/读取/等待的
 * 编排;所有持久化与 Harness 细节通过注入的 SessionBackend 提供,方便测试。
 */

import type {
  CollaborationSession,
  CollaborationHarnessOption,
  CollaborationModelOption,
  CollaborationSelection,
  HarnessListResult,
  MessageOrigin,
  ModelListInput,
  ModelListResult,
  RuntimeSnapshotResult,
  SessionCreateInput,
  SessionCreateResult,
  SessionCreatePromptOutcome,
  SessionListInput,
  SessionListResult,
  SessionMessage,
  SessionReadInput,
  SessionReadResult,
  SessionSendInput,
  SessionSendResult,
  SessionWaitInput,
  SessionWaitResult,
  UiPlacement,
  UiNeighborInput,
  UiNeighborResult,
  UiPresence,
  UiShowOptions,
  WorkspaceRef,
} from "../src/core/collaboration"
import {
  CollaborationError,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  buildEnvelope,
  filterSessions,
  sameWorkspace,
  summarizeWorkspaces,
} from "../src/core/collaboration"
import type { Effort } from "../src/core/types"
import { getHarness, HARNESSES, type HarnessId } from "../src/core/harness"
import type { UiCommandBridge } from "./ui-command-bridge"

export type SessionBackend = {
  /** 按持久化 key 解析 Session;不存在或已删除返回 null。 */
  getSession(sessionId: string): CollaborationSession | null
  /** 当前 runtime 内全部 Session,跨项目,含 sleeping。 */
  listSessions(): CollaborationSession[]
  /** 持久化新 SessionRecord。 */
  createSession(spec: {
    title: string
    workspace: WorkspaceRef
    harnessId: HarnessId
    providerId: string
    modelId: string
    effort?: Effort
  }): Promise<CollaborationSession>
  /** 向目标提交一条带 origin 的 Prompt;目标 working 或不可恢复时抛错。
   * JSONL/UI 落 originalText+origin,只有 Harness 收到 wireText(envelope)。 */
  sendToSession(
    targetSessionId: string,
    payload: { originalText: string; wireText: string; origin: MessageOrigin },
  ): Promise<{ acceptedSeq: number }>
  /** 读取目标 JSONL 中 afterSeq 之后的脱敏消息;truncated 表示被 limit 截断。 */
  readSessionMessages(
    targetSessionId: string,
    afterSeq: number,
    limit: number,
    includeTools: boolean,
  ): { messages: SessionMessage[]; nextSeq: number; truncated: boolean }
  /** 等待目标 Session 状态;删除/恢复失败立即抛错,超时抛 timeout。 */
  waitForSession(
    targetSessionId: string,
    until: NonNullable<SessionWaitInput["until"]>,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<{ session: CollaborationSession; matched: SessionWaitResult["matched"] }>
}

export type CollaborationCatalog = {
  listHarnesses(): Promise<CollaborationHarnessOption[]>
  listModels(input: {
    callerSessionId: string
    harnessId: HarnessId
    cwd?: string
  }): Promise<CollaborationModelOption[]>
  resolveSelection(input: {
    callerSessionId: string
    harnessId: HarnessId
    cwd?: string
    providerId?: string
    modelId?: string
  }): Promise<CollaborationSelection | null>
}

const DEFAULT_TIMEOUT_MS = 30_000

export class CollaborationService {
  constructor(
    private readonly backend: SessionBackend,
    private readonly options: {
      revision?: () => number
      uiAvailable?: () => boolean
      /** UI 桥;缺省时 snapshot.ui 视为不可用,create 不再发 show 命令。 */
      ui?: UiCommandBridge
      /** ProviderRegistry 的只读 Agent 投影；用于跨 Harness 默认选择与目录查询。 */
      catalog?: CollaborationCatalog
    } = {},
  ) {}

  snapshot(callerSessionId: string): RuntimeSnapshotResult {
    const caller = this.requireCaller(callerSessionId)
    const sessions = this.backend.listSessions()
    return {
      selfSessionId: caller.id,
      workspaces: summarizeWorkspaces(sessions),
      sessions,
      ui: this.uiState(callerSessionId),
      revision: this.options.revision?.() ?? 0,
    }
  }

  list(
    callerSessionId: string,
    input: SessionListInput,
  ): SessionListResult {
    const caller = this.requireCaller(callerSessionId)
    return {
      selfSessionId: caller.id,
      sessions: filterSessions(this.backend.listSessions(), input ?? {}),
    }
  }

  async create(
    callerSessionId: string,
    input: SessionCreateInput,
  ): Promise<SessionCreateResult> {
    const caller = this.requireCaller(callerSessionId)

    // 继承调用者配置;显式覆盖优先。第一版只允许继承 caller cwd 或已有 Workspace。
    let workspace: WorkspaceRef
    if (input.scope === "project") {
      // chat caller 显式选 project 但没给 cwd:不存在可继承的 project workspace。
      if (!input.cwd) throw new CollaborationError("workspace_not_found")
      const exists = this.backend
        .listSessions()
        .some((s) => s.workspace.scope === "project" && s.workspace.cwd === input.cwd)
      if (!exists) throw new CollaborationError("workspace_not_found")
      workspace = { scope: "project", cwd: input.cwd }
    } else if (input.scope === "chat") {
      workspace = { scope: "chat" }
    } else {
      workspace = caller.workspace
    }

    const harnessId = input.harnessId ?? caller.harnessId
    if (!HARNESSES.some((harness) => harness.id === harnessId)) {
      throw new CollaborationError("invalid_input", `未知 Harness: ${harnessId}`)
    }
    const selection = await this.resolveCreateSelection(caller, workspace, harnessId, input)
    const session = await this.backend.createSession({
      title: input.title?.trim() || "collaborator",
      workspace,
      harnessId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      effort: input.effort ?? selection.defaultEffort,
    })

    // 默认 show:true/placement:auto/focus:false。record 已持久化才发 show;
    // prompt 成败不撤 Panel;UI 不可用只降级,不影响创建结果。
    let ui: SessionCreateResult["ui"] = "unavailable"
    if (input.show === false) {
      ui = "hidden"
    } else if (this.options.ui) {
      try {
        this.options.ui.show(session.id, {
          anchorSessionId: caller.id,
          placement: input.placement ?? "auto",
          focus: input.focus ?? false,
        })
        ui = "queued"
      } catch {
        // ui_unavailable(窄屏/无窗口):Session 已建,按 §11.3 降级,不吞创建结果
      }
    }

    if (!input.prompt) {
      return { session, prompt: "not_requested", ui }
    }

    // 首 Prompt;失败保留 Session,返回 session_created_prompt_failed。
    try {
      const { acceptedSeq } = await this.sendToSession(callerSessionId, {
        targetSessionId: session.id,
        text: input.prompt,
      })
      const prompt: SessionCreatePromptOutcome = "accepted"
      if (input.wait) {
        const reply = await this.awaitReply(session.id, input.timeoutMs, acceptedSeq)
        return { session, prompt: "settled", ui, reply }
      }
      return { session, prompt, ui }
    } catch (error) {
      const code =
        error instanceof CollaborationError && error.code === "session_busy"
          ? "session_busy"
          : "session_created_prompt_failed"
      return {
        session,
        prompt: "failed",
        ui,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  async send(
    callerSessionId: string,
    input: SessionSendInput,
  ): Promise<SessionSendResult> {
    const { acceptedSeq } = await this.sendToSession(callerSessionId, input)
    if (input.wait) {
      const reply = await this.awaitReply(input.targetSessionId, input.timeoutMs, acceptedSeq)
      return { targetSessionId: input.targetSessionId, status: "settled", acceptedSeq, reply }
    }
    return { targetSessionId: input.targetSessionId, status: "accepted", acceptedSeq }
  }

  async harnessList(callerSessionId: string): Promise<HarnessListResult> {
    this.requireCaller(callerSessionId)
    if (!this.options.catalog) throw new CollaborationError("selection_unavailable")
    return { harnesses: await this.options.catalog.listHarnesses() }
  }

  async modelList(callerSessionId: string, input: ModelListInput): Promise<ModelListResult> {
    const caller = this.requireCaller(callerSessionId)
    if (!HARNESSES.some((harness) => harness.id === input.harnessId)) {
      throw new CollaborationError("invalid_input", `未知 Harness: ${input.harnessId}`)
    }
    if (input.cwd) {
      const exists = this.backend.listSessions().some((session) =>
        session.workspace.scope === "project" && session.workspace.cwd === input.cwd)
      if (!exists) throw new CollaborationError("workspace_not_found")
    }
    if (!this.options.catalog) throw new CollaborationError("selection_unavailable")
    const models = await this.options.catalog.listModels({
      callerSessionId: caller.id,
      harnessId: input.harnessId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    })
    return { harnessId: input.harnessId, models }
  }

  read(callerSessionId: string, input: SessionReadInput): SessionReadResult {
    this.requireCaller(callerSessionId)
    this.requireTarget(input.targetSessionId)
    const limit = clampLimit(input.limit)
    const afterSeq = Math.max(0, input.afterSeq ?? 0)
    const includeTools = input.includeTools ?? false
    const { messages, nextSeq, truncated } = this.backend.readSessionMessages(
      input.targetSessionId,
      afterSeq,
      limit,
      includeTools,
    )
    return { sessionId: input.targetSessionId, messages, nextSeq, truncated }
  }

  async wait(
    callerSessionId: string,
    input: SessionWaitInput,
  ): Promise<SessionWaitResult> {
    this.requireCaller(callerSessionId)
    const target = this.requireTarget(input.targetSessionId)
    const until = input.until ?? "settled"
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const { session, matched } = await this.backend.waitForSession(
      input.targetSessionId,
      until,
      input.afterSeq ?? 0,
      timeoutMs,
    )
    return { session: session ?? target, matched, lastSeq: (session ?? target).lastSeq }
  }

  // ---------- UI 工具(Phase 2) ----------

  uiState(callerSessionId: string): { available: boolean } & UiPresence {
    this.requireCaller(callerSessionId)
    const presence = this.options.ui
      ? this.options.ui.currentPresence()
      : { visibleSessionIds: [], focusedSessionId: null, layoutMode: "managed" as const, adjacency: [] }
    return {
      available: this.options.ui ? (this.options.uiAvailable?.() ?? true) : false,
      ...presence,
    }
  }

  uiShow(
    callerSessionId: string,
    input: { sessionId: string; placement?: UiPlacement; focus?: boolean },
  ): { queued: true } {
    this.requireCaller(callerSessionId)
    this.requireTarget(input.sessionId)
    const options: UiShowOptions = {
      anchorSessionId: callerSessionId,
      ...(input.placement ? { placement: input.placement } : {}),
      ...(input.focus !== undefined ? { focus: input.focus } : {}),
    }
    this.options.ui?.show(input.sessionId, options)
    return { queued: true }
  }

  uiHide(callerSessionId: string, input: { sessionId: string }): { queued: true } {
    this.requireCaller(callerSessionId)
    this.requireTarget(input.sessionId)
    this.options.ui?.hide(input.sessionId)
    return { queued: true }
  }

  uiFocus(callerSessionId: string, input: { sessionId: string }): { queued: true } {
    this.requireCaller(callerSessionId)
    this.requireTarget(input.sessionId)
    this.options.ui?.focus(input.sessionId)
    return { queued: true }
  }

  /**
   * 把“右侧/上方”等 UI 指代解析为稳定 Session。这里只读取 renderer 上报的
   * 瞬时邻接关系，不把 Dockview panel/group 提升为协作领域对象。
   */
  uiNeighbor(callerSessionId: string, input: UiNeighborInput): UiNeighborResult {
    this.requireCaller(callerSessionId)
    if (!this.options.ui) throw new CollaborationError("ui_unavailable")
    const fromSessionId = input.fromSessionId ?? callerSessionId
    this.requireTarget(fromSessionId)
    const presence = this.options.ui.currentPresence()
    const from = presence.adjacency.find((entry) => entry.sessionId === fromSessionId)
    if (!from) throw new CollaborationError("ui_session_not_visible")
    const targetSessionId = from.neighbors[input.direction]
    return {
      fromSessionId,
      direction: input.direction,
      session: targetSessionId ? this.requireTarget(targetSessionId) : null,
    }
  }

  // ---------- 内部 ----------

  private requireCaller(callerSessionId: string): CollaborationSession {
    const caller = this.backend.getSession(callerSessionId)
    if (!caller) throw new CollaborationError("caller_not_found")
    return caller
  }

  private requireTarget(targetSessionId: string): CollaborationSession {
    const target = this.backend.getSession(targetSessionId)
    if (!target) throw new CollaborationError("session_not_found")
    return target
  }

  private async resolveCreateSelection(
    caller: CollaborationSession,
    workspace: WorkspaceRef,
    harnessId: HarnessId,
    input: SessionCreateInput,
  ): Promise<CollaborationSelection> {
    const harness = getHarness(harnessId)
    const sameHarness = harnessId === caller.harnessId
    const explicitSelection = input.providerId !== undefined || input.modelId !== undefined

    // 最常见路径不触发目录发现：同 Harness 且未覆盖选择时完整继承 caller。
    if (sameHarness && !explicitSelection) {
      return {
        providerId: caller.providerId,
        modelId: caller.modelId,
        defaultEffort: caller.effort ?? harness.defaultEffort,
      }
    }

    let providerId = input.providerId
    let modelId = input.modelId
    let inheritedPrevious = false
    if (!sameHarness && !explicitSelection) {
      const all = this.backend.listSessions().filter((session) => session.harnessId === harnessId)
      const local = all.filter((session) => sameWorkspace(session.workspace, workspace))
      const previous = (local.length > 0 ? local : all)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      if (previous) {
        providerId = previous.providerId
        modelId = previous.modelId
        inheritedPrevious = true
      }
    }

    const cwd = workspace.scope === "project" ? workspace.cwd : undefined
    if (this.options.catalog) {
      let resolved = await this.options.catalog.resolveSelection({
        callerSessionId: caller.id,
        harnessId,
        ...(cwd ? { cwd } : {}),
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
      })
      // 最近使用项已经失效时允许回落目标 Harness 的当前默认；显式选择永不回落。
      if (!resolved && inheritedPrevious) {
        resolved = await this.options.catalog.resolveSelection({
          callerSessionId: caller.id,
          harnessId,
          ...(cwd ? { cwd } : {}),
        })
      }
      if (!resolved) throw new CollaborationError("selection_unavailable")
      return resolved
    }

    // 测试/无目录的降级只接受完整结构化选择，禁止猜 Provider 或 Model。
    if (!providerId || !modelId) throw new CollaborationError("selection_unavailable")
    return { providerId, modelId, defaultEffort: harness.defaultEffort }
  }

  private async sendToSession(
    callerSessionId: string,
    input: SessionSendInput,
  ): Promise<{ acceptedSeq: number }> {
    if (typeof input.text !== "string" || input.text.trim().length === 0) {
      throw new CollaborationError("invalid_input", "禁止空消息")
    }
    if (input.targetSessionId === callerSessionId) {
      throw new CollaborationError("self_target")
    }
    const caller = this.requireCaller(callerSessionId)
    const target = this.requireTarget(input.targetSessionId)
    // 目标正在运行:直接拒绝,不隐式排队,也不落到 backend。
    if (target.runtime === "working") throw new CollaborationError("session_busy")
    const origin: MessageOrigin = {
      kind: "session",
      sessionId: caller.id,
      title: caller.title,
      harnessId: caller.harnessId,
    }
    try {
      return await this.backend.sendToSession(target.id, {
        originalText: input.text,
        wireText: buildEnvelope(origin, input.text),
        origin,
      })
    } catch (error) {
      if (error instanceof CollaborationError) throw error
      throw new CollaborationError("session_unavailable")
    }
  }

  private async awaitReply(
    targetSessionId: string,
    timeoutMs: number | undefined,
    afterSeq: number,
  ): Promise<SessionMessage | undefined> {
    await this.backend.waitForSession(
      targetSessionId,
      "settled",
      afterSeq,
      timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    // 从 afterSeq 开始读;没有新 assistant 消息也算 settled,reply 缺省。
    const { messages } = this.backend.readSessionMessages(
      targetSessionId,
      afterSeq,
      DEFAULT_READ_LIMIT,
      false,
    )
    let reply: SessionMessage | undefined
    for (const message of messages) {
      if (message.role === "assistant" && message.seqEnd > afterSeq) {
        reply = message
      }
    }
    return reply
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_READ_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), MAX_READ_LIMIT)
}
