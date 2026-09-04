/**
 * 真会话 store(renderer 侧,v0.3):经 window.bento 与 main 通信。
 * 消息由 core/replay 的 reducer 从事件日志推导——打开历史会话是回放,
 * 正在流式是追加,同一条代码路径。
 * 纯 web 模式(无 window.bento)下所有查询返回空,UI 自动只剩 mock。
 */

import { useSyncExternalStore } from "react"

import {
  applyRecord,
  createAccumulator,
  finalizeTrailing,
  messagesOf,
  type Accumulator,
} from "@/core/replay"
import type { BinaryProgress, LiveSessionRecord } from "@/types/bento"
import type { HarnessEvent } from "@/core/events"
import { normalizePromptInput, type Effort, type Message, type PromptInput, type SessionScope } from "@/core/types"
import type { PermissionProfile } from "@/core/permission"
import type { ApprovalDecision } from "@/core/events"

type LiveSnapshot = {
  version: number
  initialized: boolean
  sessions: LiveSessionRecord[]
  /** 最新一次受管二进制进度;null = 无进行中的安装 */
  binaryProgress: BinaryProgress | null
}

let snapshot: LiveSnapshot = { version: 0, initialized: false, sessions: [], binaryProgress: null }
const accs = new Map<string, Accumulator>()
const loaded = new Set<string>()
const running = new Set<string>()
/** 未读:协作会话发来的消息,或非焦点会话跑完了回合(结果还没被看过)。聚焦即清。 */
const unreadSessionMessages = new Set<string>()
/** 侧栏"需注意":hold 中的审批请求 id(跨会话),结算即移除。驱动侧栏 attention 态。 */
const pendingApprovals = new Map<string, Set<string>>()
export type QueuedPromptView = {
  id: string
  input: PromptInput
  steerAvailable: boolean
  state: "queued" | "steering"
}
const queuedPrompts = new Map<string, QueuedPromptView>()
let focusedSessionId: string | null = null
const listeners = new Set<() => void>()

function bump(patch?: Partial<Omit<LiveSnapshot, "version">>) {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const l of listeners) l()
}

/* P0 流式合并:记录仍逐条同步 applyRecord(顺序、seq、replay 结果不变),
 * 只有 UI 通知被合并——流式事件每 animation frame 最多 bump 一次。
 * 终点事件(user_message/turn_finished/notice/user_steer 等)走 bumpNow
 * 立即可见,并取消挂起的合并 flush,避免同一帧双 bump。
 * rAF 在窗口隐藏时会被暂停,补 100ms 定时兜底,后台会话状态不僵死。 */
let flushRaf: number | null = null
let flushTimer: number | null = null

function runFlush() {
  // rAF 与定时器先到者 flush 并取消另一个,保证同帧不双 bump
  if (flushRaf !== null) {
    cancelAnimationFrame(flushRaf)
    flushRaf = null
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  bump()
}

/** 流式事件的帧级合并通知:同一帧内多次调用只 bump 一次 */
function scheduleBump() {
  if (flushRaf !== null || flushTimer !== null) return
  flushRaf = requestAnimationFrame(runFlush)
  flushTimer = setTimeout(runFlush, 100)
}

/** 立即通知(终点事件/用户动作):先取消挂起的合并 flush */
function bumpNow(patch?: Partial<Omit<LiveSnapshot, "version">>) {
  if (flushRaf !== null) {
    cancelAnimationFrame(flushRaf)
    flushRaf = null
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  bump(patch)
}

/** 终点事件:用户可见的回合边界与系统通知,必须同步 flush */
function isEndpointRecord(r: { kind: string; payload: unknown }): boolean {
  if (r.kind === "event") {
    const type = (r.payload as HarnessEvent).type
    return (
      type === "user_message" ||
      type === "turn_finished" ||
      type === "notice" ||
      type === "user_steer"
    )
  }
  // v0.3 legacy 落盘形态:同名 kind 即终点
  return r.kind === "user_message" || r.kind === "turn_end" || r.kind === "notice"
}

/** 模块加载即初始化(桌面模式);web 模式静默什么都不做 */
async function init() {
  const bento = window.bento
  if (!bento) {
    snapshot = { ...snapshot, initialized: true }
    return
  }
  try {
    bump({ sessions: await bento.listSessions(), initialized: true })
  } catch {
    bump({ initialized: true })
  }
  bento.onSessionEvent(({ key, record }) => {
    // 先收集 runtime 变化(patch),再统一决定通知方式——每条记录最多一次 bump
    let patch: Partial<Omit<LiveSnapshot, "version">> | undefined
    // Session runtime 以 main 的真实事件推进。这样即使 sessions:changed 恰好在
    // caller working 时刷新,turn_finished 也会把侧栏/Composer 收回 idle。
    if (record.kind === "event") {
      const payload = record.payload as HarnessEvent
      if (payload.type === "user_steer" && queuedPrompts.get(key)?.id === payload.clientMessageId) {
        queuedPrompts.delete(key)
        patch = {}
      }
      if (payload.type === "user_message") {
        if (payload.origin?.kind === "session") {
          running.add(key)
          if (key !== focusedSessionId) unreadSessionMessages.add(key)
        }
        patch = {
          sessions: snapshot.sessions.map((session) =>
            session.key === key
              ? { ...session, live: true, runtime: "working", updatedAt: record.at }
              : session,
          ),
        }
      } else if (payload.type === "turn_finished") {
        running.delete(key)
        // 非焦点会话的回合结束:结果还没被看过,亮未读(协作唤醒的 user_message
        // 已经加过,Set 幂等)
        if (key !== focusedSessionId) unreadSessionMessages.add(key)
        patch = {
          sessions: snapshot.sessions.map((session) =>
            session.key === key
              ? { ...session, live: true, runtime: "idle", updatedAt: record.at }
              : session,
          ),
        }
      } else if (payload.type === "approval_request") {
        const set = pendingApprovals.get(key) ?? new Set()
        set.add(payload.id)
        pendingApprovals.set(key, set)
        patch = {}
      } else if (payload.type === "approval_resolved") {
        if (pendingApprovals.get(key)?.delete(payload.id)) patch = {}
      }
    }

    const acc = accs.get(key)
    const endpoint = isEndpointRecord(record)
    if (acc) {
      // 真实 user_message 到达时,若发送侧已乐观上屏同文消息,原地转正(换 id),
      // 不再走 applyRecord——revive 前 main 会先补一堆启动事件,seq 对不上,
      // 靠 seq 去重会重影。sendPrompt 已设置 running/乐观态,这里只转正。
      if (record.kind === "event" && (record.payload as HarnessEvent).type === "user_message") {
        const event = record.payload as HarnessEvent & { type: "user_message" }
        if (event.clientMessageId && queuedPrompts.get(key)?.id === event.clientMessageId) {
          queuedPrompts.delete(key)
        }
        const text = event.text
        const i = acc.messages.findIndex(
          (m) => m.id.startsWith("opt-") && m.role === "user" && m.text === text,
        )
        if (i >= 0) {
          acc.messages[i] = {
            ...acc.messages[i],
            id: `u${record.seq}`,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          }
          if (record.seq > acc.lastSeq) acc.lastSeq = record.seq
          bumpNow()
          return
        }
      }
      applyRecord(acc, record)
    }

    // patch 变化或终点事件同步可见(会话未加载时侧栏 runtime 也要刷新);
    // 流式内容合并到下一帧。
    if (patch) bumpNow(patch)
    else if (acc) {
      if (endpoint) bumpNow()
      else scheduleBump()
    }
  })
  // 协作创建/重命名/删除:index 变化即重拉,Agent 建的 Session 立刻进侧栏
  bento.onSessionsChanged?.(() => {
    void refreshSessions()
  })
  bento.onBinaryProgress((progress) => {
    // done/error 都终止进度展示;error 文案经 create 返回的 error 另行
    // 可见,这里只负责别把陈旧进度带到下一次创建
    bump({
      binaryProgress:
        progress.phase === "done" || progress.phase === "error" ? null : progress,
    })
  })
}
void init()

export function isLiveKey(sessionId: string): boolean {
  return snapshot.sessions.some((s) => s.key === sessionId)
}

export function liveMeta(sessionId: string): LiveSessionRecord | undefined {
  return snapshot.sessions.find((s) => s.key === sessionId)
}

/** 非 React 上下文用的当前快照(布局初始化等,渲染外取数场景) */
export function liveSessionsSnapshot(): LiveSessionRecord[] {
  return snapshot.sessions
}

export function liveMessages(sessionId: string): Message[] {
  const acc = accs.get(sessionId)
  return acc ? messagesOf(acc) : []
}

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId)
}

export function queuedPrompt(sessionId: string): QueuedPromptView | undefined {
  return queuedPrompts.get(sessionId)
}

export function hasUnreadSessionMessage(sessionId: string): boolean {
  return unreadSessionMessages.has(sessionId)
}

/** 会话是否有 hold 中的审批(侧栏"需注意"态) */
export function hasPendingApproval(sessionId: string): boolean {
  return (pendingApprovals.get(sessionId)?.size ?? 0) > 0
}

/** 审批卡片决议:渲染端按钮 → main 结算(approval_resolved 经事件流回广播更新卡片) */
export async function resolveLiveApproval(
  sessionId: string,
  id: string,
  decision: ApprovalDecision,
) {
  const res = await window.bento?.resolveApproval(sessionId, id, decision)
  if (res && "error" in res) return res.error
}

export function setFocusedSession(sessionId: string | null): void {
  focusedSessionId = sessionId
  if (sessionId && unreadSessionMessages.delete(sessionId)) bump()
}

/** 重拉 session 列表(桌面模式);sessions:changed / 协作 UI 初始化用 */
export async function refreshSessions(): Promise<void> {
  const bento = window.bento
  if (!bento) return
  try {
    bump({ sessions: await bento.listSessions() })
  } catch {
    /* ignore */
  }
}

/** 打开会话:未加载则整段回放事件日志(与实时共用 applyRecord) */
export async function ensureLoaded(sessionId: string) {
  const bento = window.bento
  if (!bento || loaded.has(sessionId)) return
  loaded.add(sessionId)
  const acc = createAccumulator()
  accs.set(sessionId, acc)
  try {
    for (const r of await bento.readEvents(sessionId)) applyRecord(acc, r)
  } catch {
    /* ignore */
  }
  // 回放终界(TRACE_DATA_PLAN §3.3):崩溃/强退的会话尾部回合没有任何终点
  // 事件,trailing draft 永不 finalize,spinner 照转。只在会话确实已死时收尾:
  // renderer 非 running && main 侧非 live 双条件。main 侧活性重拉一次而非用
  // 快照——快照只在 init/create 时刷新,revive 不更新它(第四轮评审事项);
  // 查询失败时视为 live 不收尾:宁可保留 spinner,也不误杀还在跑的回合。
  if (!running.has(sessionId)) {
    const live = await bento
      .listSessions()
      .then((sessions) => sessions.some((s) => s.key === sessionId && s.live))
      .catch(() => true)
    if (!live) finalizeTrailing(acc, new Date().toISOString())
  }
  bump()
}

export async function createLive(opts: {
  scope?: SessionScope
  harnessId: string
  cwd: string
  title: string
  providerId: string
  modelId: string
  effort?: Effort
  permissionProfile?: PermissionProfile
}): Promise<{ key: string } | { error: string }> {
  const bento = window.bento
  if (!bento) return { error: "桌面模式不可用" }
  const res = await bento.createSession(opts)
  if ("error" in res && res.error) return { error: res.error }
  const ok = res as { key: string; record: LiveSessionRecord }
  accs.set(ok.key, createAccumulator())
  loaded.add(ok.key)
  bump({ sessions: [{ ...ok.record, live: true }, ...snapshot.sessions] })
  return { key: ok.key }
}

export async function setLiveModel(sessionId: string, providerId: string, modelId: string) {
  const res = await window.bento?.setModel(sessionId, { providerId, modelId })
  if (!res || "error" in res) return res?.error ?? "桌面模式不可用"
  bump({
    sessions: snapshot.sessions.map((session) =>
      session.key === sessionId ? { ...session, providerId, modelId } : session,
    ),
  })
}

export async function setLiveEffort(sessionId: string, effort: Effort) {
  const res = await window.bento?.setEffort(sessionId, effort)
  if (!res || "error" in res) return res?.error ?? "桌面模式不可用"
  bump({
    sessions: snapshot.sessions.map((session) =>
      session.key === sessionId ? { ...session, effort } : session,
    ),
  })
}

export async function setLivePermissionProfile(sessionId: string, profile: PermissionProfile) {
  const res = await window.bento?.setPermissionProfile(sessionId, profile)
  if (!res || "error" in res) return res?.error ?? "桌面模式不可用"
  bump({
    sessions: snapshot.sessions.map((session) =>
      session.key === sessionId ? { ...session, permissionProfile: profile } : session,
    ),
  })
}

export async function sendPrompt(sessionId: string, value: string | PromptInput) {
  const bento = window.bento
  if (!bento) return
  const input = normalizePromptInput(value)
  // 乐观上屏:用户消息立即入流。main 的 append 广播回来同 seq 的真实记录,
  // 被 applyRecord 的 seq 去重挡掉;若 main 卡住(revive 挂起等),用户至少
  // 能看到自己发出去的内容,而不是只有一条干等的「正在生成」。
  const acc = accs.get(sessionId)
  if (acc) {
    applyRecord(acc, {
      seq: acc.lastSeq + 1,
      at: new Date().toISOString(),
      kind: "event",
      payload: {
        type: "user_message",
        text: input.text,
        ...(input.attachments.length ? {
          attachments: input.attachments.map(({ name, kind }) => ({ name, kind })),
        } : {}),
      },
    })
    // 打上乐观标记,真实记录广播回来时原地转正(见 onSessionEvent)
    const last = acc.messages[acc.messages.length - 1]
    if (last?.role === "user" && last.text === input.text) last.id = `opt-${last.id}`
  }
  running.add(sessionId)
  bump()
  try {
    const res = await bento.prompt(sessionId, input)
    if ("error" in res && res.error) {
      // 错误直接进消息流,别静默
      const acc = accs.get(sessionId)
      if (acc)
        applyRecord(acc, {
          seq: acc.lastSeq + 1,
          at: new Date().toISOString(),
          kind: "notice",
          payload: { text: `请求失败:${res.error}` },
        })
    }
  } finally {
    running.delete(sessionId)
    const sessions = await bento.listSessions().catch(() => null)
    bump(sessions ? { sessions } : undefined)
  }
}

export async function queueLivePrompt(sessionId: string, value: string | PromptInput) {
  const bento = window.bento
  if (!bento || queuedPrompts.has(sessionId)) return
  const input = normalizePromptInput(value)
  const id = crypto.randomUUID()
  queuedPrompts.set(sessionId, { id, input, steerAvailable: false, state: "queued" })
  bump()
  const res = await bento.queuePrompt(sessionId, input, id)
  if ("error" in res) {
    queuedPrompts.delete(sessionId)
    bump()
    return res.error
  }
  const queued = queuedPrompts.get(sessionId)
  if (res.status === "started") queuedPrompts.delete(sessionId)
  else if (queued) queuedPrompts.set(sessionId, { ...queued, steerAvailable: res.steerAvailable })
  bump()
}

export async function steerQueuedPrompt(sessionId: string) {
  const bento = window.bento
  const queued = queuedPrompts.get(sessionId)
  if (!bento || !queued || !queued.steerAvailable) return
  queuedPrompts.set(sessionId, { ...queued, state: "steering" })
  bump()
  const res = await bento.steerQueued(sessionId, queued.id)
  if ("error" in res) {
    queuedPrompts.set(sessionId, { ...queued, state: "queued" })
    bump()
  }
}

export async function cancelQueuedPrompt(sessionId: string) {
  const bento = window.bento
  const queued = queuedPrompts.get(sessionId)
  if (!bento || !queued) return
  queuedPrompts.delete(sessionId)
  bump()
  await bento.cancelQueued(sessionId, queued.id)
}

export async function cancelPrompt(sessionId: string) {
  await window.bento?.cancel(sessionId)
}

export async function renameLive(sessionId: string, title: string) {
  const bento = window.bento
  if (!bento) return
  const res = await bento.renameSession(sessionId, title)
  if ("error" in res && res.error) return
  bump({ sessions: snapshot.sessions.map((s) => (s.key === sessionId ? { ...s, title } : s)) })
}

/** 删档:main 侧清 index/jsonl + 杀进程;renderer 清内存态,布局面板由调用方关 */
export async function removeLive(sessionId: string) {
  const bento = window.bento
  if (!bento) return
  await bento.removeSession(sessionId)
  accs.delete(sessionId)
  loaded.delete(sessionId)
  running.delete(sessionId)
  unreadSessionMessages.delete(sessionId)
  queuedPrompts.delete(sessionId)
  pendingApprovals.delete(sessionId)
  bump({ sessions: snapshot.sessions.filter((s) => s.key !== sessionId) })
}

/** 订阅 store 变化(useLive 的底层;非 React 上下文/测试可用) */
export function subscribeLive(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(subscribeLive, () => snapshot)
}
