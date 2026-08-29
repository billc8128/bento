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
import type { Effort, Message, SessionScope } from "@/core/types"

type LiveSnapshot = {
  version: number
  sessions: LiveSessionRecord[]
  /** 最新一次受管二进制进度;null = 无进行中的安装 */
  binaryProgress: BinaryProgress | null
}

let snapshot: LiveSnapshot = { version: 0, sessions: [], binaryProgress: null }
const accs = new Map<string, Accumulator>()
const loaded = new Set<string>()
const running = new Set<string>()
const listeners = new Set<() => void>()

function bump(patch?: Partial<Omit<LiveSnapshot, "version">>) {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const l of listeners) l()
}

/** 模块加载即初始化(桌面模式);web 模式静默什么都不做 */
async function init() {
  const bento = window.bento
  if (!bento) return
  try {
    bump({ sessions: await bento.listSessions() })
  } catch {
    /* ignore */
  }
  bento.onSessionEvent(({ key, record }) => {
    const acc = accs.get(key)
    if (acc) {
      // 真实 user_message 到达时,若发送侧已乐观上屏同文消息,原地转正(换 id),
      // 不再走 applyRecord——revive 前 main 会先补一堆启动事件,seq 对不上,
      // 靠 seq 去重会重影
      if (record.kind === "event" && (record.payload as HarnessEvent).type === "user_message") {
        const text = (record.payload as HarnessEvent & { type: "user_message" }).text
        const i = acc.messages.findIndex(
          (m) => m.id.startsWith("opt-") && m.role === "user" && m.text === text,
        )
        if (i >= 0) {
          acc.messages[i] = { ...acc.messages[i], id: `u${record.seq}` }
          if (record.seq > acc.lastSeq) acc.lastSeq = record.seq
          bump()
          return
        }
      }
      applyRecord(acc, record)
      bump()
    }
    // 未打开的会话只更新 updatedAt 概念,打开时会整段回放
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

export async function sendPrompt(sessionId: string, text: string) {
  const bento = window.bento
  if (!bento) return
  // 乐观上屏:用户消息立即入流。main 的 append 广播回来同 seq 的真实记录,
  // 被 applyRecord 的 seq 去重挡掉;若 main 卡住(revive 挂起等),用户至少
  // 能看到自己发出去的内容,而不是只有一条干等的「正在生成」。
  const acc = accs.get(sessionId)
  if (acc) {
    applyRecord(acc, {
      seq: acc.lastSeq + 1,
      at: new Date().toISOString(),
      kind: "event",
      payload: { type: "user_message", text },
    })
    // 打上乐观标记,真实记录广播回来时原地转正(见 onSessionEvent)
    const last = acc.messages[acc.messages.length - 1]
    if (last?.role === "user" && last.text === text) last.id = `opt-${last.id}`
  }
  running.add(sessionId)
  bump()
  try {
    const res = await bento.prompt(sessionId, text)
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
  bump({ sessions: snapshot.sessions.filter((s) => s.key !== sessionId) })
}

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot,
  )
}
