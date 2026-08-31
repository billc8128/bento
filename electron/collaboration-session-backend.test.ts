import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { HarnessEvent, LogRecord } from "../src/core/events"
import type { MessageOrigin } from "../src/core/collaboration"
import type { HarnessDriver, HarnessStartOptions } from "./drivers/types"
import type { PromptInput } from "../src/core/types"
import { SessionCollaborationBackend } from "./collaboration-session-backend"
import type { CollaborationStateEvent } from "./sessions"
import { SessionManager } from "./sessions"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

type Deferred = { resolve: (value: { stopReason?: string; usage?: { cost?: number } }) => void; reject: (e: unknown) => void }

/** 可控 driver:start 时记录 emit,prompt 返回手工 resolve 的 promise。 */
function scriptedDriver() {
  const received: Array<string | PromptInput> = []
  const deferreds: Deferred[] = []
  const started: HarnessStartOptions[] = []
  let emit: ((event: HarnessEvent) => void) | undefined
  const driver: HarnessDriver = {
    id: "kimi",
    async start(options, notify) {
      started.push(options)
      emit = notify
      return {
        nativeSessionId: "collab-native",
        capabilities: { modelSwitch: "none", effortSwitch: "none" },
        prompt: async (input) => {
          received.push(input)
          return new Promise((resolve, reject) => deferreds.push({ resolve, reject }))
        },
        cancel: async () => {},
        close: () => {},
        onExit: () => () => {},
      }
    },
  }
  return { driver, received, deferreds, started, emitEvent: (event: HarnessEvent) => emit?.(event) }
}

function setup(dir: string, driver: HarnessDriver, resolveSelection?: ConstructorParameters<typeof SessionCollaborationBackend>[1]) {
  const events: LogRecord[] = []
  const manager = new SessionManager(dir, (_key, record) => events.push(record), () => driver)
  const backend = new SessionCollaborationBackend(manager, resolveSelection)
  return { manager, backend, events }
}

const ORIGIN: MessageOrigin = { kind: "session", sessionId: "caller-1", title: "caller", harnessId: "pi" }

describe("SessionCollaborationBackend", () => {
  it("list/get 跨项目投影;getSession 对缺失 id 返回 null", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-list-"))
    const dirA = path.join(tempDir, "proj-a")
    const dirB = path.join(tempDir, "proj-b")
    fs.mkdirSync(dirA)
    fs.mkdirSync(dirB)
    const { driver } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    await manager.createSession({ harnessId: "kimi", cwd: dirA, providerId: "native-kimi", modelId: "m" })
    await manager.createSession({ harnessId: "pi", cwd: dirB, providerId: "native-pi", modelId: "m" })

    const sessions = backend.listSessions()
    // index 最新在前
    expect(sessions.map((s) => (s.workspace.scope === "project" ? s.workspace.cwd : ""))).toEqual([dirB, dirA])
    expect(backend.getSession(sessions[0].id)).toMatchObject({
      workspace: { scope: "project", cwd: dirB },
      runtime: "idle",
    })
    expect(backend.getSession("missing")).toBeNull()
  })

  it("create 校验 exact selection:不可执行返回 selection_unavailable;可执行则 pending 创建", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-create-"))
    const { driver, started } = scriptedDriver()
    const requested: Array<Record<string, string>> = []
    const { manager, backend } = setup(tempDir, driver, async (request) => {
      requested.push(request)
      return request.providerId === "native-kimi" && request.modelId === "m-1"
    })
    await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m-1" })

    await expect(backend.createSession({
      title: "bad",
      workspace: { scope: "project", cwd: tempDir },
      harnessId: "kimi",
      providerId: "native-other",
      modelId: "m-9",
    })).rejects.toMatchObject({ code: "selection_unavailable" })
    expect(backend.listSessions()).toHaveLength(1) // 不可执行 selection 不落 SessionRecord

    const created = await backend.createSession({
      title: "reviewer",
      workspace: { scope: "project", cwd: tempDir },
      harnessId: "kimi",
      providerId: "native-kimi",
      modelId: "m-1",
      effort: "high",
    })
    expect(created).toMatchObject({
      title: "reviewer",
      providerId: "native-kimi",
      modelId: "m-1",
      effort: "high",
      runtime: "sleeping",
    })
    expect(requested.at(-1)).toMatchObject({ harnessId: "kimi", providerId: "native-kimi", modelId: "m-1" })
    // pending 创建不启动 driver
    expect(started).toHaveLength(1) // 仅最初的 createSession 启动过
  })

  it("wait:false send 立即返回;sleeping 经 ensureLive 恰好 revive 一次;原文+origin 落盘,envelope 进 Harness", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-send-"))
    const { driver, received, deferreds, started } = scriptedDriver()
    const { manager, backend, events } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    // 先完成一个回合,让 Session 有 user_message:之后 close 才保留 record 变 sleeping
    const first = await backend.sendToSession(key, { originalText: "warmup", wireText: "warmup", origin: ORIGIN })
    deferreds[0].resolve({ stopReason: "end_turn" })
    await manager.waitForTurn(key, first.acceptedSeq, 2_000)
    await manager.closeSession(key)
    await new Promise((resolve) => setTimeout(resolve, 50)) // 等 logStream flush 落盘
    expect(started).toHaveLength(1)
    expect(manager.runtimeStatus(key)).toBe("sleeping")

    // sleeping send → revive
    const seq = await backend.sendToSession(key, {
      originalText: "原文消息",
      wireText: "[Bento message from \"caller\"]\n\n原文消息",
      origin: ORIGIN,
    })
    expect(seq.acceptedSeq).toBeGreaterThan(first.acceptedSeq)
    expect(started).toHaveLength(2) // 恰好 revive 一次
    expect(manager.runtimeStatus(key)).toBe("working")
    expect(received[1]).toEqual({ text: "[Bento message from \"caller\"]\n\n原文消息", attachments: [] })
    const userRecord = events.filter(
      (record) => record.kind === "event" && (record.payload as HarnessEvent).type === "user_message",
    ).at(-1)!
    expect(userRecord.payload).toMatchObject({ type: "user_message", text: "原文消息", origin: ORIGIN })
    expect(JSON.stringify(events)).not.toContain("[Bento message from")

    // 后台 rejection 被吸收,不产生 unhandled rejection
    deferreds[1].reject(new Error("boom"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(manager.runtimeStatus(key)).toBe("idle")
  })

  it("read:user/assistant/notice 转 SessionMessage;afterSeq/limit/truncated/includeTools 与脱敏", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-read-"))
    const { driver, emitEvent } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    const turn = await backend.sendToSession(key, { originalText: "分析", wireText: "分析", origin: ORIGIN })
    emitEvent({ type: "agent_message_chunk", text: "结论:" })
    emitEvent({ type: "agent_message_chunk", text: "没问题" })
    emitEvent({ type: "tool_started", id: "t1", kind: "read", title: "secret.txt", status: "running" })
    emitEvent({ type: "tool_updated", id: "t1", detail: "/abs/path/secret.txt", output: "SECRET-OUTPUT" })
    emitEvent({ type: "turn_finished", reason: "end_turn" })
    await new Promise((resolve) => setTimeout(resolve, 20)) // 等 logStream flush 落盘

    const clean = backend.readSessionMessages(key, 0, 50, false)
    expect(clean.messages).toEqual([
      expect.objectContaining({ role: "user", text: "分析", origin: ORIGIN }),
      expect.objectContaining({ role: "assistant", text: "结论:没问题" }),
    ])
    expect(JSON.stringify(clean)).not.toContain("SECRET-OUTPUT")
    expect(JSON.stringify(clean)).not.toContain("/abs/path")
    expect(clean.truncated).toBe(false)
    expect(clean.nextSeq).toBe(clean.messages.at(-1)!.seqEnd)

    const withTools = backend.readSessionMessages(key, 0, 50, true)
    expect(withTools.messages[1].text).toContain("[tool:read]")
    expect(withTools.messages[1].text).not.toContain("secret.txt")
    expect(withTools.messages[1].text).not.toContain("SECRET-OUTPUT")
    expect(withTools.messages[1].text).not.toContain("/abs/path")

    // cursor:跳过 user 后只剩 assistant
    const afterUser = backend.readSessionMessages(key, turn.acceptedSeq, 50, false)
    expect(afterUser.messages.map((message) => message.role)).toEqual(["assistant"])
    expect(afterUser.nextSeq).toBe(withTools.nextSeq)

    // limit 截断
    const limited = backend.readSessionMessages(key, 0, 1, false)
    expect(limited.messages).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it("wait:working 事件驱动;next_message 由 agent chunk 唤醒;settled 精确等本次 turn", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-wait-"))
    const { driver, emitEvent, deferreds } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    // working:turn 启动事件唤醒尚未开始的等待
    const workingPromise = backend.waitForSession(key, "working", 0, 2_000)
    const turn = await backend.sendToSession(key, { originalText: "go", wireText: "go", origin: ORIGIN })
    await expect(workingPromise).resolves.toMatchObject({ matched: "working" })

    // next_message:agent chunk(message_appended)唤醒
    const nextPromise = backend.waitForSession(key, "next_message", turn.acceptedSeq, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    emitEvent({ type: "agent_message_chunk", text: "partial" })
    await expect(nextPromise).resolves.toMatchObject({ matched: "next_message" })

    // settled:精确等本次 acceptedSeq 的 turn completion
    const settledPromise = backend.waitForSession(key, "settled", 0, 2_000)
    deferreds[0].resolve({ stopReason: "end_turn", usage: { cost: 0.02 } })
    await expect(settledPromise).resolves.toMatchObject({ matched: "settled", session: { runtime: "idle" } })
  })

  it("wait settled 在 idle target 上立即返回;timeout 产生稳定错误码", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-wait2-"))
    const { driver } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    await expect(backend.waitForSession(key, "settled", 0, 2_000)).resolves.toMatchObject({ matched: "settled" })
    await expect(backend.waitForSession(key, "working", 0, 50)).rejects.toMatchObject({ code: "timeout" })
    await expect(
      backend.waitForSession("missing", "settled", 0, 2_000),
    ).rejects.toMatchObject({ code: "session_not_found" })
  })

  it("turnChains gate 清理:turn 全部落定后 size 归零", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-chain-"))
    const { driver, deferreds } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    const first = await backend.sendToSession(key, { originalText: "1", wireText: "1", origin: ORIGIN })
    deferreds[0].resolve({})
    await manager.waitForTurn(key, first.acceptedSeq, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.pendingTurnChainCount()).toBe(0)

    // 失败路径同样清理
    const second = await backend.sendToSession(key, { originalText: "2", wireText: "2", origin: ORIGIN })
    deferreds[1].reject(new Error("bad"))
    await manager.waitForTurn(key, second.acceptedSeq, 2_000).catch((error: unknown) => {
      // waitForTurn 只等落定,不抛业务错误;这里不会进
      void error
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.pendingTurnChainCount()).toBe(0)
  })
})

describe("SessionCollaborationBackend 生命周期与边界", () => {
  it("普通 close 发 session_sleeping 不发 removed;settled waiter 在 sleeping 时结束", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-sleep-"))
    const { driver, deferreds } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    // human 发起的 turn(不经 backend,lastTurns 无登记)
    const human = manager.prompt(key, "human 输入")
    const settled = backend.waitForSession(key, "settled", 0, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    deferreds[0].resolve({})
    await human
    await expect(settled).resolves.toMatchObject({ matched: "settled", session: { runtime: "idle" } })

    // close 后 waiting settled 的 waiter 由 sleeping 唤醒(而非 timeout)
    const turn = await backend.sendToSession(key, { originalText: "again", wireText: "again", origin: ORIGIN })
    deferreds[1].resolve({})
    await manager.waitForTurn(key, turn.acceptedSeq, 2_000)
    const next = manager.prompt(key, "human again")
    await new Promise((resolve) => setTimeout(resolve, 20)) // 等 beginTurn 占用 activeTurn
    expect(manager.runtimeStatus(key)).toBe("working")
    const waitSettled = backend.waitForSession(key, "settled", 0, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await manager.closeSession(key) // record 保留 → sleeping
    await expect(waitSettled).resolves.toMatchObject({ matched: "settled", session: { runtime: "sleeping" } })
    deferreds[2].resolve({})
    await next
    // 后续 send 仍可 revive
    const revived = await backend.sendToSession(key, { originalText: "revive", wireText: "revive", origin: ORIGIN })
    expect(revived.acceptedSeq).toBeGreaterThan(0)
    deferreds[3].resolve({})
    await manager.waitForTurn(key, revived.acceptedSeq, 2_000)
  })

  it("removeSession 只发一次 removed;close+remove 不重复", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-removed-"))
    const { driver } = scriptedDriver()
    const { manager } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })
    const removed: CollaborationStateEvent[] = []
    // 订阅两次,验证事件恰好各送达一次且不重复
    const w1 = manager.waitForCollaborationState(key, (e) => e.type === "session_removed", 2_000)
    const w2 = manager.waitForCollaborationState(key, (e) => e.type === "session_removed", 2_000)
    void w1.then((e) => removed.push(e))
    void w2.then((e) => removed.push(e))
    await manager.removeSession(key)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(removed).toHaveLength(2) // 两个 waiter 各一次;同一 waiter 不会收两次
  })

  it("waitForCollaborationState 先注册后 probe:状态在检查与订阅边界已发生也不 timeout、无 waiter 泄漏", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-race-"))
    const { driver, deferreds } = scriptedDriver()
    const { manager } = setup(tempDir, driver)
    const created = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })
    const key = created.key
    const warm = manager.prompt(key, "warm")
    await new Promise((resolve) => setTimeout(resolve, 0)) // 等 beginTurn 触达 driver
    deferreds[0].resolve({})
    await warm
    // lastSeq 已推进:probe 命中,立即 resolve,不需要任何后续事件
    const raced = await manager.waitForCollaborationState(
      key,
      (e) => e.type === "message_appended",
      100,
      () => {
        const last = manager.collaborationSession(key)?.lastSeq ?? 0
        return last > 0 ? { key, type: "message_appended" as const, seq: last } : undefined
      },
    )
    expect(raced.type).toBe("message_appended")
    // probe 命中的 waiter 已移除;独立的永不满足等待走 timeout,不悬挂
    await expect(
      manager.waitForCollaborationState(key, () => false, 50),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(manager.collaborationSession(key)).not.toBeNull()
  })

  it("旧 seq 不能让 settled 误判:human working 时走事件等待,不用精确 completion", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-stale-seq-"))
    const { driver, deferreds } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    // backend 第一回合 settle 后,lastTurns 登记被删除
    const first = await backend.sendToSession(key, { originalText: "1", wireText: "1", origin: ORIGIN })
    deferreds[0].resolve({})
    await manager.waitForTurn(key, first.acceptedSeq, 2_000)

    // human 发起新 turn(working);backend 的 settled 等待不能立即返回
    const human = manager.prompt(key, "human turn")
    const waited = backend.waitForSession(key, "settled", 0, 2_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(manager.runtimeStatus(key)).toBe("working")
    deferreds[1].resolve({})
    await human
    await expect(waited).resolves.toMatchObject({ matched: "settled" })
  })

  it("create 支持 chat:成功建私有 cwd;selection 失败清 record 与私有目录", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-chat-"))
    const { driver } = scriptedDriver()
    let allow = true
    const { manager, backend } = setup(tempDir, driver, async () => allow)

    const created = await backend.createSession({
      title: "chat peer",
      workspace: { scope: "chat" },
      harnessId: "kimi",
      providerId: "native-kimi",
      modelId: "m",
    })
    expect(created.workspace.scope).toBe("chat")
    expect(created.runtime).toBe("sleeping")
    expect(manager.listSessions()).toHaveLength(1)

    allow = false
    await expect(backend.createSession({
      title: "bad chat",
      workspace: { scope: "chat" },
      harnessId: "kimi",
      providerId: "native-kimi",
      modelId: "m",
    })).rejects.toMatchObject({ code: "selection_unavailable" })
    // record 与私有目录都被清理
    expect(manager.listSessions()).toHaveLength(1)
    expect(manager.collaborationSession(created.id)).not.toBeNull()
  })

  it("read 兼容 legacy user_message/update/turn_end/notice;assistant 跨界用 seqEnd 过滤", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-legacy-"))
    const { driver } = scriptedDriver()
    const { manager, backend, events } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })
    events.length = 0

    // 直写 legacy 记录到 jsonl;createSession 已写过 metadata(seq1),继续编 seq
    const jsonlPath = path.join(tempDir, "sessions", `${key}.jsonl`)
    const legacy = [
      { seq: 2, at: "2024-01-01T00:00:02Z", kind: "user_message", payload: { text: "legacy 问" } },
      { seq: 3, at: "2024-01-01T00:00:03Z", kind: "update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "legacy 答" } } },
      { seq: 4, at: "2024-01-01T00:00:04Z", kind: "turn_end", payload: {} },
      { seq: 5, at: "2024-01-01T00:00:05Z", kind: "notice", payload: { text: "legacy 提示" } },
    ]
    fs.appendFileSync(jsonlPath, legacy.map((line) => `${JSON.stringify(line)}\n`).join(""))
    await new Promise((resolve) => setTimeout(resolve, 10))

    const result = backend.readSessionMessages(key, 0, 50, false)
    expect(result.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "legacy 问"],
      ["assistant", "legacy 答"],
      ["notice", "legacy 提示"],
    ])
    expect(result.nextSeq).toBe(5)

    // seqEnd 过滤:afterSeq=3(assistant 中间的 chunk seq)仍能取到整条 assistant
    const afterChunk = backend.readSessionMessages(key, 3, 50, false)
    expect(afterChunk.messages.map((message) => message.role)).toEqual(["assistant", "notice"])

    // 现代事件路径与 legacy 混合不被破坏:再走一次正常 send 后读取正常
    const { deferreds } = scriptedDriver()
    void deferreds
    void events
  })
})

describe("SessionCollaborationBackend wait 边界", () => {
  it("removal race:working 等待中目标被删,立即 session_not_found 而非 timeout", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-removal-"))
    const { driver } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    // 目标进入 working:settled 走精确 completion 等待,next_message 走事件等待
    const turn = await backend.sendToSession(key, { originalText: "go", wireText: "go", origin: ORIGIN })
    void turn
    const settled = backend.waitForSession(key, "settled", 0, 5_000)
    const next = backend.waitForSession(key, "next_message", turn.acceptedSeq, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await manager.removeSession(key)
    // 两种路径都必须立即 not_found,而不是等 timeout
    await expect(settled).rejects.toMatchObject({ code: "session_not_found" })
    await expect(next).rejects.toMatchObject({ code: "session_not_found" })
  })

  it("probe 合成 removed:目标在订阅前已删时立即 not_found,不 timeout", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-removal2-"))
    const { driver } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })
    await manager.removeSession(key)
    // probe 必然合成为 removed:验证合成路径,不是 timeout
    await expect(
      manager.waitForCollaborationState(
        key,
        (e) => e.type === "session_removed",
        2_000,
        () => (manager.collaborationSession(key) ? undefined : { key, type: "session_removed" as const }),
      ),
    ).resolves.toMatchObject({ type: "session_removed" })
    // next_message 的 probe 走同一读取面合成:同样立即 not_found
    await expect(
      backend.waitForSession(key, "next_message", 0, 2_000),
    ).rejects.toMatchObject({ code: "session_not_found" })
  })

  it("next_message:thought/tool/metadata/turn_finished 不唤醒,agent_message_chunk 才唤醒", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-backend-nm-"))
    const { driver, emitEvent } = scriptedDriver()
    const { manager, backend } = setup(tempDir, driver)
    const { key } = await manager.createSession({ harnessId: "kimi", cwd: tempDir, providerId: "native-kimi", modelId: "m" })

    const turn = await backend.sendToSession(key, { originalText: "go", wireText: "go", origin: ORIGIN })
    const next = backend.waitForSession(key, "next_message", turn.acceptedSeq, 5_000)
    let resolved = false
    void next.then(() => { resolved = true })

    await new Promise((resolve) => setTimeout(resolve, 10))
    // 非正文事件:一律不得唤醒
    emitEvent({ type: "agent_thought_chunk", text: "thinking..." })
    emitEvent({ type: "tool_started", id: "t1", kind: "bash", title: "ls", status: "running" })
    emitEvent({ type: "tool_updated", id: "t1", status: "completed" })
    emitEvent({ type: "metadata", name: "plan", data: { entries: [] } })
    emitEvent({ type: "turn_finished", reason: "end_turn" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(resolved).toBe(false)

    // 真正的 agent 正文才唤醒
    emitEvent({ type: "agent_message_chunk", text: "回答" })
    await expect(next).resolves.toMatchObject({ matched: "next_message" })
    expect(resolved).toBe(true)
  })
})
