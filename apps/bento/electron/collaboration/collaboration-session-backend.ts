/**
 * SessionManager → SessionBackend 的真实 adapter(Phase 1b)。
 *
 * 只做投影与转换:不持有状态、不 import CollaborationService;
 * read 从 JSONL 事件生成脱敏 SessionMessage;wait 全部事件驱动,无 polling。
 */

import type {
  CollaborationSession,
  MessageOrigin,
  SessionMessage,
  SessionWaitInput,
} from "../../src/core/collaboration"
import { CollaborationError } from "../../src/core/collaboration"
import type { HarnessEvent } from "../../src/core/events"
import type { Effort } from "../../src/core/types"
import type { SessionBackend } from "./collaboration-service"
import type { CollaborationStateEvent, SessionManager } from "../sessions/sessions"

export type CollaborationSelectionResolver = (request: {
  harnessId: string
  cwd: string
  providerId: string
  modelId: string
}) => Promise<boolean>

const RESUME_SUCCESS_NOTICES = new Set([
  "会话已恢复(resume),上下文延续",
  "会话已恢复(load),上下文延续",
  "会话已恢复(Codex thread/resume),上下文延续",
])

/** stall 检测窗口(herdr 的 5s 惯例):提交后这么久没有任何活动 = 可能没启动。 */
const STALL_TIMEOUT_MS = 5_000

export class SessionCollaborationBackend implements SessionBackend {
  /** sendToSession 记录的最近一次提交,settled wait 用它精确等本次 turn。 */
  private readonly lastTurns = new Map<string, number>()

  constructor(
    private readonly manager: SessionManager,
    private readonly resolveSelection?: CollaborationSelectionResolver,
  ) {}

  getSession(sessionId: string): CollaborationSession | null {
    return this.manager.collaborationSession(sessionId)
  }

  listSessions(): CollaborationSession[] {
    return this.manager.listSessions().flatMap((record) => {
      const session = this.manager.collaborationSession(record.key)
      return session ? [session] : []
    })
  }

  async createSession(spec: {
    title: string
    workspace: CollaborationSession["workspace"]
    harnessId: CollaborationSession["harnessId"]
    providerId: string
    modelId: string
    effort?: Effort
  }): Promise<CollaborationSession> {
    // 第一版只允许 project Workspace(带已存在 cwd)或 chat。
    if (spec.workspace.scope === "chat") {
      // chat:先 createPendingSession 得到真实私有 cwd,再验证 selection;
      // 失败则 removeSession 清掉 record 与私有目录,不留孤儿。
      const { record } = this.manager.createPendingSession({
        scope: "chat",
        harnessId: spec.harnessId,
        cwd: "",
        title: spec.title,
        providerId: spec.providerId,
        modelId: spec.modelId,
        ...(spec.effort ? { effort: spec.effort } : {}),
        // 协作创建的会话固定 full:驱动方本来就是 agent 在替用户干活,
        // 保持 M1 前的全放行为;人类会话被协作 send 时由 per-turn origin 自动裁决。
        permissionProfile: "full",
      })
      const valid = await this.validateSelection({
        harnessId: spec.harnessId,
        cwd: record.cwd,
        providerId: spec.providerId,
        modelId: spec.modelId,
      })
      if (!valid) {
        await this.manager.removeSession(record.key)
        throw new CollaborationError("selection_unavailable")
      }
      return this.manager.collaborationSession(record.key)!
    }
    if (spec.workspace.scope !== "project") {
      throw new CollaborationError("workspace_not_found")
    }
    const valid = await this.validateSelection({
      harnessId: spec.harnessId,
      cwd: spec.workspace.cwd,
      providerId: spec.providerId,
      modelId: spec.modelId,
    })
    if (!valid) throw new CollaborationError("selection_unavailable")
    const { record } = this.manager.createPendingSession({
      scope: "project",
      harnessId: spec.harnessId,
      cwd: spec.workspace.cwd,
      title: spec.title,
      providerId: spec.providerId,
      modelId: spec.modelId,
      ...(spec.effort ? { effort: spec.effort } : {}),
      // 协作创建的会话固定 full:见上 chat 分支同注。
      permissionProfile: "full",
    })
    return this.manager.collaborationSession(record.key)!
  }

  private validateSelection(request: {
    harnessId: string
    cwd: string
    providerId: string
    modelId: string
  }): Promise<boolean> {
    if (!this.resolveSelection) return Promise.resolve(true)
    return this.resolveSelection(request).catch(() => false)
  }

  async sendToSession(
    targetSessionId: string,
    payload: { originalText: string; wireText: string; origin: MessageOrigin },
  ): Promise<{ acceptedSeq: number }> {
    const { acceptedSeq, completion } = await this.manager.startPrompt(
      targetSessionId,
      payload.originalText,
      { wireText: payload.wireText, origin: payload.origin },
    )
    // wait:false 立即返回;后台 rejection 必须由这次 catch 吸收,
    // 调用方自己拿 completion(或 waitForTurn)观察真实结果。
    completion.catch(() => {})
    this.lastTurns.set(targetSessionId, acceptedSeq)
    // turn settled/reject 后删除精确等待的登记,避免旧 seq 被后续 wait 误用。
    void completion
      .catch(() => {})
      .finally(() => {
        if (this.lastTurns.get(targetSessionId) === acceptedSeq) {
          this.lastTurns.delete(targetSessionId)
        }
      })
    return { acceptedSeq }
  }

  /** herdr agent_prompt_stalled 对齐(--wait 语义):提交被接受后 STALL_TIMEOUT_MS
   * 内必须观察到目标产生任何 harness 事件(含 turn_finished),否则说明目标可能
   * 没真正开始处理(死 harness/卡住的 UI),让调用方拿 stalled 错误而不是空等。 */
  async waitForActivity(
    targetSessionId: string,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<void> {
    const state = await this.awaitState(targetSessionId, timeoutMs,
      (event) =>
        event.type === "session_removed" ||
        (event.type === "activity" && (event.seq ?? 0) > afterSeq),
      () => {
        // probe:极快的 turn 可能在注册前就已落盘事件
        const session = this.manager.collaborationSession(targetSessionId)
        if (!session) return { key: targetSessionId, type: "session_removed" }
        return session.lastSeq > afterSeq
          ? { key: targetSessionId, type: "activity", seq: session.lastSeq }
          : undefined
      },
    )
    if (state.type === "session_removed") throw new CollaborationError("session_not_found")
  }

  readSessionMessages(
    targetSessionId: string,
    afterSeq: number,
    limit: number,
    includeTools: boolean,
  ): { messages: SessionMessage[]; nextSeq: number; truncated: boolean } {
    const events = this.manager.readEvents(targetSessionId)
    const all: SessionMessage[] = []
    let draft: { seqStart: number; text: string } | null = null

    const finalizeDraft = (seqEnd: number, at: string) => {
      if (!draft || !draft.text) {
        draft = null
        return
      }
      all.push({
        seqStart: draft.seqStart,
        seqEnd,
        at,
        role: "assistant",
        text: draft.text,
      })
      draft = null
    }

    const pushLegacyChunk = (text: string, seq: number) => {
      if (!text) return
      if (!draft) draft = { seqStart: seq, text: "" }
      draft.text += text
    }

    for (const record of events) {
      // legacy(v0.3)记录:user_message / update(agent_message_chunk) /
      // turn_end / notice;tool_call 一律不进入协作读取面(title 可能是路径)。
      if (record.kind !== "event") {
        const payload = record.payload as {
          text?: string
          sessionUpdate?: string
          content?: { type?: string; text?: string }
        }
        const at = record.at
        if (record.kind === "user_message") {
          finalizeDraft(record.seq - 1, at)
          all.push({ seqStart: record.seq, seqEnd: record.seq, at, role: "user", text: payload.text ?? "" })
        } else if (record.kind === "notice") {
          if (!RESUME_SUCCESS_NOTICES.has(payload.text ?? "")) {
            finalizeDraft(record.seq - 1, at)
            all.push({ seqStart: record.seq, seqEnd: record.seq, at, role: "notice", text: payload.text ?? "" })
          }
        } else if (record.kind === "turn_end") {
          finalizeDraft(record.seq, at)
        } else if (
          record.kind === "update" &&
          payload.sessionUpdate === "agent_message_chunk" &&
          payload.content?.type === "text"
        ) {
          pushLegacyChunk(payload.content.text ?? "", record.seq)
        }
        continue
      }
      const event = record.payload as HarnessEvent
      const at = record.at
      switch (event.type) {
        case "user_message":
          finalizeDraft(record.seq - 1, at)
          all.push({
            seqStart: record.seq,
            seqEnd: record.seq,
            at,
            role: "user",
            text: event.text,
            ...(event.origin ? { origin: event.origin } : {}),
          })
          continue
        case "notice":
          if (RESUME_SUCCESS_NOTICES.has(event.text)) continue
          finalizeDraft(record.seq - 1, at)
          all.push({
            seqStart: record.seq,
            seqEnd: record.seq,
            at,
            role: "notice",
            text: event.text,
          })
          continue
        case "agent_message_chunk":
          if (!draft) draft = { seqStart: record.seq, text: "" }
          draft.text += event.text
          continue
        case "tool_started":
          // 脱敏摘要:只有 kind,不带 title(可能是绝对路径)/detail/output/url。
          if (includeTools) {
            if (!draft) draft = { seqStart: record.seq, text: "" }
            draft.text += `\n[tool:${event.kind}]`
          }
          continue
        case "turn_finished":
          finalizeDraft(record.seq, at)
          continue
        default:
          continue // thought/metadata/tool_updated 等不进入协作读取面
      }
    }

    const after = all.filter((message) => message.seqEnd > afterSeq)
    const messages = after.slice(0, limit)
    return {
      messages,
      nextSeq: messages.at(-1)?.seqEnd ?? afterSeq,
      truncated: after.length > messages.length,
    }
  }

  async waitForSession(
    targetSessionId: string,
    until: NonNullable<SessionWaitInput["until"]>,
    afterSeq: number,
    timeoutMs: number,
  ): Promise<{ session: CollaborationSession; matched: SessionWaitResultLike }> {
    const current = this.requireSession(targetSessionId)

    if (until === "working") {
      if (current.runtime === "working") return { session: current, matched: "working" }
      const event = await this.awaitState(targetSessionId, timeoutMs,
        (state) => state.type === "turn_started" || state.type === "session_removed",
        () => {
          const session = this.manager.collaborationSession(targetSessionId)
          // 目标在订阅前刚好被删:合成 removed,绝不误 timeout。
          if (!session) return { key: targetSessionId, type: "session_removed" }
          return session.runtime === "working"
            ? { key: targetSessionId, type: "turn_started" }
            : undefined
        },
      )
      if (event.type === "session_removed") throw new CollaborationError("session_not_found")
      return { session: this.requireSession(targetSessionId), matched: "working" }
    }

    if (until === "next_message") {
      const event = await this.awaitState(targetSessionId, timeoutMs,
        (state) =>
          state.type === "session_removed" ||
          (state.type === "message_appended" && (state.seq ?? 0) > afterSeq),
        () => {
          // probe 用读取面判定:只有 user/chunk/notice 组成的真实消息才算数;
          // thought/tool/metadata/turn_finished 不会成为消息。
          if (!this.manager.collaborationSession(targetSessionId)) {
            return { key: targetSessionId, type: "session_removed" }
          }
          const found = this.readSessionMessages(targetSessionId, afterSeq, 1, false)
          return found.messages.length > 0
            ? { key: targetSessionId, type: "message_appended", seq: found.messages[0].seqEnd }
            : undefined
        },
      )
      if (event.type === "session_removed") throw new CollaborationError("session_not_found")
      return { session: this.requireSession(targetSessionId), matched: "next_message" }
    }

    // blocked:等目标出现挂起审批/提问(需要人类介入)。approval_changed 在挂起与
    // 结算时都触发,accept 必须复核数量,否则"审批被结算"会误唤醒。
    if (until === "blocked") {
      if (this.manager.pendingApprovalCount(targetSessionId) > 0) {
        return { session: current, matched: "blocked" }
      }
      const event = await this.awaitState(targetSessionId, timeoutMs,
        (state) =>
          state.type === "session_removed" ||
          (state.type === "approval_changed" &&
            this.manager.pendingApprovalCount(targetSessionId) > 0),
        () => {
          if (!this.manager.collaborationSession(targetSessionId)) {
            return { key: targetSessionId, type: "session_removed" }
          }
          return this.manager.pendingApprovalCount(targetSessionId) > 0
            ? { key: targetSessionId, type: "approval_changed" }
            : undefined
        },
      )
      if (event.type === "session_removed") throw new CollaborationError("session_not_found")
      return { session: this.requireSession(targetSessionId), matched: "blocked" }
    }

    // settled:blocked(挂起审批)与 idle/done 一样属于 settled——目标不再自行推进,
    // 调用方应立即被唤醒去处理,而不是等 turn 真正结束(herdr 同语义)。
    // 仅当登记的 seq 与当前 active turn 完全一致才走精确 completion;
    // 否则(turn 是 human 发起/登记已清)退化为 turn_settled 事件,绝不用旧 seq。
    if (current.runtime !== "working") return { session: current, matched: "settled" }
    const registeredSeq = this.lastTurns.get(targetSessionId)
    if (registeredSeq !== undefined && this.manager.activeTurnSeq(targetSessionId) === registeredSeq) {
      // 精确等本次 completion;同时监听 removed/sleeping,目标消失不被 completion 悬挂。
      await Promise.race([
        this.manager.waitForTurn(targetSessionId, registeredSeq, timeoutMs),
        this.manager
          .waitForCollaborationState(
            targetSessionId,
            (state) => state.type === "session_removed" || state.type === "session_sleeping",
            timeoutMs,
          )
          .then((state) => {
            if (state.type === "session_removed") throw new CollaborationError("session_not_found")
          }),
      ])
      return { session: this.requireSession(targetSessionId), matched: "settled" }
    }
    const event = await this.awaitState(targetSessionId, timeoutMs,
      (state) =>
        state.type === "turn_settled" ||
        state.type === "session_sleeping" ||
        state.type === "session_removed",
      () => {
        const session = this.manager.collaborationSession(targetSessionId)
        if (!session) return { key: targetSessionId, type: "session_removed" }
        return session.runtime !== "working"
          ? { key: targetSessionId, type: "turn_settled" }
          : undefined
      },
    )
    if (event.type === "session_removed") throw new CollaborationError("session_not_found")
    // sleeping(harness 下线)同样视为本轮 settled;后续 send 仍可 revive。
    return { session: this.requireSession(targetSessionId), matched: "settled" }
  }

  /** 先注册 waiter,再同步 probe 当前状态:消除检查与订阅边界的事件竞态。 */
  private awaitState(
    key: string,
    timeoutMs: number,
    accept: (event: CollaborationStateEvent) => boolean,
    probe: () => CollaborationStateEvent | undefined,
  ): Promise<CollaborationStateEvent> {
    return this.manager.waitForCollaborationState(key, accept, timeoutMs, probe)
  }

  private requireSession(key: string): CollaborationSession {
    const session = this.manager.collaborationSession(key)
    if (!session) throw new CollaborationError("session_not_found")
    return session
  }
}

type SessionWaitResultLike = "working" | "settled" | "next_message" | "blocked"
