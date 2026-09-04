import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HarnessEvent, LogRecord } from "../src/core/events"
import type { PromptInput } from "../src/core/types"
import type { MessageOrigin } from "../src/core/collaboration"
import type { HarnessDriver, HarnessStartOptions } from "./drivers/types"
import { SessionManager } from "./sessions"
import { SessionConfigRegistry } from "./session-config/registry"
import type { SessionConfigAdapter } from "./session-config/types"
import { selectionKey } from "./session-config/types"
import type { HarnessId } from "../src/core/harness"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

/** 直通 session-config adapter:SessionManager 单测的装配缝隙,不涉各 Harness 配置细节。 */
function passthroughAdapter(harnessId: HarnessId): SessionConfigAdapter {
  return {
    harnessId,
    async prepare(request) {
      const selected = {
        providerId: request.selected.providerId,
        modelId: request.selected.modelId,
        harnessModelId: request.selected.modelId,
      }
      return {
        sessionKey: request.sessionKey,
        harnessId: request.harnessId,
        env: {},
        strip: [],
        selections: new Map([[selectionKey(selected.providerId, selected.modelId), selected]]),
        selected,
        revision: 1,
        dispose: async () => {},
      }
    },
    async reconfigure(_lease, next) {
      return {
        mode: "live",
        selection: { providerId: next.providerId, modelId: next.modelId, harnessModelId: next.modelId },
      }
    },
  }
}

/** SessionManager 构造参数 6/7:直通 adapter registry + 空 runtimes resolver。 */
function sessionConfigFor(...harnessIds: HarnessId[]) {
  const registry = new SessionConfigRegistry()
  for (const id of harnessIds) registry.register(passthroughAdapter(id))
  return [registry, async () => []] as const
}

describe("SessionManager model selection", () => {
  it("同一 App lease 按 Harness 边界附着：Pi extension，其余 stdio relay", async () => {
    for (const harnessId of ["pi", "codex"] as const) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `bento-app-lease-${harnessId}-`))
      let started: HarnessStartOptions | undefined
      let disposed = 0
      const driver: HarnessDriver = {
        id: harnessId,
        async start(options) {
          started = options
          return {
            nativeSessionId: `${harnessId}-native`,
            capabilities: { modelSwitch: "none", effortSwitch: "none" },
            prompt: async () => ({ stopReason: "end_turn" }),
            cancel: async () => {},
            close: () => {},
            onExit: () => () => {},
          }
        },
      }
      const manager = new SessionManager(
        tempDir,
        () => {},
        () => driver,
        null,
        null,
        ...sessionConfigFor("pi", "codex"),
        async ({ sessionKey }) => ({
          sessionKey,
          endpoint: "http://127.0.0.1:3000/mcp/token",
          token: "token",
          stdioRelay: { name: "Bento Apps", command: "/bin/node", args: ["relay.mjs"], env: {} },
          piExtensionPath: "/tmp/bento-pi-mcp.mjs",
          dispose: async () => { disposed += 1 },
        }),
      )
      const { key } = await manager.createSession({
        harnessId,
        cwd: tempDir,
        providerId: `provider-${harnessId}`,
        modelId: "model",
      })
      if (harnessId === "pi") {
        expect(started?.appArgs).toEqual(["--extension", "/tmp/bento-pi-mcp.mjs"])
        expect(started?.appEnv).toMatchObject({ BENTO_MCP_TOKEN: "token" })
        expect(started?.mcpServers).toBeUndefined()
      } else {
        expect(started?.mcpServers?.[0]).toMatchObject({ name: "Bento Apps", command: "/bin/node" })
        expect(started?.appArgs).toBeUndefined()
      }
      await manager.closeSession(key)
      expect(disposed).toBe(1)
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = ""
    }
  })

  it("附件经过 SessionManager 校验后送进 Driver，日志只保存脱敏元数据", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-attachment-"))
    const attachmentPath = path.join(tempDir, "report.csv")
    fs.writeFileSync(attachmentPath, "name,value\na,1\n")
    let received: string | PromptInput | undefined
    const emitted: LogRecord[] = []
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        return {
          nativeSessionId: "attachment-native",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async (input) => {
            received = input
            return { stopReason: "end_turn" }
          },
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(tempDir, (_key, record) => emitted.push(record), () => driver, null, null, ...sessionConfigFor("kimi"))
    const { key } = await manager.createSession({
      harnessId: "kimi",
      cwd: tempDir,
      providerId: "user-kimi",
      modelId: "model",
    })
    await manager.prompt(key, {
      text: "分析附件",
      attachments: [{
        name: "report.csv",
        path: attachmentPath,
        mimeType: "text/csv",
        size: 1,
        kind: "file",
      }],
    })
    expect(received).toMatchObject({
      text: "分析附件",
      attachments: [{ path: attachmentPath, size: fs.statSync(attachmentPath).size }],
    })
    const userEvent = emitted.find(
      (record) => record.kind === "event" && record.payload.type === "user_message",
    )
    expect(userEvent).toMatchObject({
      payload: { attachments: [{ name: "report.csv", kind: "file" }] },
    })
    expect(JSON.stringify(userEvent)).not.toContain(attachmentPath)
    await manager.disposeAll()
  })

  it("旧会话缺少 scope 时迁移为 project", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-scope-migrate-"))
    const sessionsDir = path.join(tempDir, "sessions")
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, "index.json"), JSON.stringify([{
      key: "legacy-project",
      harnessId: "pi",
      cwd: tempDir,
      nativeSessionId: "",
      title: "旧项目会话",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]))

    const manager = new SessionManager(tempDir, () => {})
    expect(manager.listSessions()[0]?.scope).toBe("project")
  })

  it("chat 会话使用独立私有工作目录，删会话时一并清理", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-chat-session-"))
    const manager = new SessionManager(tempDir, () => {}, undefined, null, null, ...sessionConfigFor("pi"))
    const { key, record } = manager.createPendingSession({
      scope: "chat",
      harnessId: "pi",
      cwd: "/ignored-for-chat",
      providerId: "user-pi",
      modelId: "model",
    })

    expect(record.scope).toBe("chat")
    expect(path.dirname(record.cwd)).toBe(path.join(tempDir, "chat-workspaces"))
    expect(path.basename(record.cwd)).toBe(key)
    expect(fs.statSync(record.cwd).isDirectory()).toBe(true)
    expect(fs.statSync(record.cwd).mode & 0o777).toBe(0o700)

    await manager.removeSession(key)
    expect(fs.existsSync(record.cwd)).toBe(false)
  })

  it("chat 同步启动失败时不遗留私有工作目录", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-chat-start-failure-"))
    const driver: HarnessDriver = {
      id: "pi",
      start: async () => { throw new Error("start failed") },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, ...sessionConfigFor("pi"))

    await expect(manager.createSession({
      scope: "chat",
      harnessId: "pi",
      cwd: "",
      providerId: "user-pi",
      modelId: "model",
    })).rejects.toThrow("start failed")
    expect(fs.readdirSync(path.join(tempDir, "chat-workspaces"))).toEqual([])
  })

  it("pending 新会话立即落盘，首条 prompt 才启动 Harness", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-pending-session-"))
    const releaseStart = Promise.withResolvers<void>()
    let starts = 0
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        starts += 1
        await releaseStart.promise
        return {
          nativeSessionId: "pending-native",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, ...sessionConfigFor("kimi"))

    const { key, record } = manager.createPendingSession({
      harnessId: "kimi",
      cwd: tempDir,
      providerId: "moonshot",
      modelId: "kimi-k3",
    })
    expect(starts).toBe(0)
    expect(manager.listSessions()).toContainEqual(record)
    expect(manager.isLive(key)).toBe(false)

    const prompting = manager.prompt(key, "立即显示这条消息")
    await vi.waitFor(() => expect(starts).toBe(1))
    expect(manager.isLive(key)).toBe(false)
    releaseStart.resolve()
    await expect(prompting).resolves.toMatchObject({ stopReason: "end_turn" })
    expect(manager.isLive(key)).toBe(true)
    await vi.waitFor(() => expect(manager.readEvents(key).some(
      (item) => item.kind === "event" && item.payload.type === "user_message",
    )).toBe(true))
    manager.disposeAll()
  })

  it("pending 会话启动失败后保留记录并允许重试", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-pending-retry-"))
    let starts = 0
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        starts += 1
        if (starts === 1) throw new Error("runtime unavailable")
        return {
          nativeSessionId: "retry-native",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, ...sessionConfigFor("kimi"))
    const { key } = manager.createPendingSession({
      harnessId: "kimi",
      cwd: tempDir,
      providerId: "moonshot",
      modelId: "kimi-k3",
    })

    await expect(manager.prompt(key, "第一次")).rejects.toThrow("runtime unavailable")
    expect(manager.listSessions().some((item) => item.key === key)).toBe(true)
    await expect(manager.prompt(key, "重试")).resolves.toMatchObject({ stopReason: "end_turn" })
    expect(starts).toBe(2)
    manager.disposeAll()
  })

  it("create/prompt 事件到达 onEvent 回调且 updatedAt 前进", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-append-"))
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        return {
          nativeSessionId: "append-1",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const received: Array<{ key: string; kind: string; at: string }> = []
    const manager = new SessionManager(tempDir, (key, record) => {
      received.push({ key, kind: record.kind, at: record.at })
    }, () => driver, null, null, ...sessionConfigFor("kimi"))

    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "moonshot", modelId: "kimi-k3",
    })
    // listSessions 返回 SessionRecord 本体;字符串快照保留 create 时刻的 updatedAt
    const created = manager.listSessions().find((item) => item.key === key)
    expect(created).toBeTruthy()
    const updatedAtAtCreate = created!.updatedAt
    await manager.prompt(key, "你好")
    // append 在 create/prompt 内同步完成;推进系统时钟保证 updatedAt 严格前进
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"))
    await manager.prompt(key, "第二轮")
    vi.useRealTimers()

    // 回调收到 create(metadata/session_started)与 prompt(user_message+turn_finished)
    expect(received.every((item) => item.key === key)).toBe(true)
    expect(received.length).toBeGreaterThanOrEqual(3)
    expect(received.some((item) => item.kind === "event")).toBe(true)
    // updatedAt 单调前进且已越过 create 时刻
    const final = manager.listSessions().find((item) => item.key === key)
    expect(final!.updatedAt > updatedAtAtCreate).toBe(true)
    manager.disposeAll()
  })

  it("把 model/effort 传给 driver,持久化并支持 live 切换", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-test-"))
    let started: HarnessStartOptions | undefined
    let currentModel = ""
    let currentEffort = ""
    const fakeDriver: HarnessDriver = {
      id: "kimi",
      async start(options) {
        started = options
        return {
          nativeSessionId: "native-1",
          capabilities: { modelSwitch: "live", effortSwitch: "live" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
          setModel: async (modelId) => { currentModel = modelId },
          setEffort: async (effort) => { currentEffort = effort },
        }
      },
    }

    const manager = new SessionManager(tempDir, () => {}, (id) => {
      if (id !== "kimi") throw new Error(`fake 只认 kimi,收到 ${id}`)
      return fakeDriver
    }, null, null, ...sessionConfigFor("kimi"))
    const { key } = await manager.createSession({
      harnessId: "kimi",
      cwd: tempDir,
      providerId: "moonshot",
      modelId: "kimi-k3",
      effort: "high",
    })
    expect(started).toMatchObject({ providerId: "moonshot", modelId: "kimi-k3", effort: "high" })

    // setModel 走 adapter reconfigure 的 live 路径;effort 由 driver 直切并持久化。
    await manager.setModel(key, "moonshot", "kimi-k2.5")
    await manager.setEffort(key, "max")
    expect({ currentModel, currentEffort }).toEqual({
      currentModel: "kimi-k2.5",
      currentEffort: "max",
    })
    expect(manager.listSessions()[0]).toMatchObject({
      providerId: "moonshot",
      modelId: "kimi-k2.5",
      effort: "max",
    })
    manager.disposeAll()
  })

  it("新会话缺少明确 provider/model 时拒绝", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-selection-"))
    const driver: HarnessDriver = {
      id: "kimi",
      start: async () => { throw new Error("不应启动") },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver)
    await expect(manager.createSession({ harnessId: "kimi", cwd: tempDir } as never))
      .rejects.toThrow(/显式指定 providerId 与 modelId/)
  })

  it("未选择项目时使用用户主目录", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-default-cwd-"))
    let started: HarnessStartOptions | undefined
    const driver: HarnessDriver = {
      id: "kimi",
      async start(options) {
        started = options
        return {
          nativeSessionId: "default-cwd",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, ...sessionConfigFor("kimi"))
    const { record } = await manager.createSession({
      harnessId: "kimi",
      cwd: "",
      providerId: "moonshot",
      modelId: "kimi-k3",
    })

    expect(started?.cwd).toBe(os.homedir())
    expect(record.cwd).toBe(os.homedir())
    manager.disposeAll()
  })

  it("旧会话缺 provider/model 时由 registry resolver 一次性迁移并写回", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-migrate-"))
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        return {
          nativeSessionId: "migrated-native",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => ({ stopReason: "completed" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(
      tempDir,
      () => {},
      () => driver,
      null,
      async () => ({ providerId: "moonshot", modelId: "kimi-k3" }),
      ...sessionConfigFor("kimi"),
    )
    fs.writeFileSync(path.join(tempDir, "sessions", "index.json"), JSON.stringify([{
      key: "legacy",
      harnessId: "kimi",
      cwd: tempDir,
      nativeSessionId: "",
      title: "旧会话",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]))

    await manager.prompt("legacy", "继续")
    expect(manager.listSessions()[0]).toMatchObject({
      providerId: "moonshot",
      modelId: "kimi-k3",
    })
    manager.disposeAll()
  })
})

import { CustomProviderStore, type SecretStore } from "./custom-providers"
import { ProviderRoutingService } from "./provider-routing"
import { KimiBentoConfigAdapter } from "./session-config/kimi"
import { RoutedBentoConfigAdapter } from "./session-config/routed"
import type { SessionProviderRuntime } from "./session-config/types"

function memorySecrets(): SecretStore {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
  }
}

/** main 侧 resolveProviderRuntimes 镜像:store → SessionProviderRuntime[](含 credential handle)。 */
function bentoRuntimes(harnessId: HarnessId, store: CustomProviderStore) {
  return async () => store.list()
    .filter((config) => {
      const runtime = config.runtimes[harnessId]
      return Boolean(runtime) &&
        store.hasCredentialFor(config, harnessId) &&
        runtime!.models.some((model) => model.enabled !== false)
    })
    .map((config): SessionProviderRuntime => {
      const runtime = config.runtimes[harnessId]!
      return {
        providerId: config.id,
        name: config.name,
        baseUrl: runtime.baseUrl,
        wireProtocol: runtime.wireProtocol,
        models: runtime.models
          .filter((model) => model.enabled !== false)
          .map((model) => ({
            id: model.id,
            name: model.name,
            reasoning: model.reasoning === true,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          })),
        credential: { resolve: () => store.readKey(config.id, harnessId) },
      }
    })
}

describe("SessionManager session-config adapter 路由", () => {
  it("claude-code 会话经 Routed adapter 组装 proxyEnv;revive 重签发;删除吊销", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-user-provider-"))
    const store = new CustomProviderStore(tempDir, memorySecrets())
    store.upsert({
      id: "user-relay",
      name: "Relay",
      auth: { method: "apiKey" },
      runtimes: {
        "claude-code": {
          baseUrl: "https://relay.example.com",
          wireProtocol: "anthropic-messages",
          models: [{ id: "m1", name: "M1" }],
        },
      },
    }, { "claude-code": "sk-relay" })
    const routing = new ProviderRoutingService(tempDir, () => store)
    const registry = new SessionConfigRegistry()
    registry.register(new RoutedBentoConfigAdapter("claude-code", routing, tempDir))

    const starts: HarnessStartOptions[] = []
    const fakeDriver: HarnessDriver = {
      id: "claude-code",
      async start(options) {
        starts.push(options)
        return {
          nativeSessionId: `native-${starts.length}`,
          capabilities: { modelSwitch: "live", effortSwitch: "live" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(
      tempDir,
      () => {},
      () => fakeDriver,
      null,
      null,
      registry,
      bentoRuntimes("claude-code", store),
    )

    const { key } = await manager.createSession({
      harnessId: "claude-code",
      cwd: tempDir,
      providerId: "user-relay",
      modelId: "m1",
    })
    // 首次 start:Routed adapter 签发租约(隔离 config dir + 代理地址 + strip)
    expect(starts[0]!.proxyEnv).toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/s\//),
        ANTHROPIC_AUTH_TOKEN: "bento-local-proxy",
        CLAUDE_CONFIG_DIR: expect.stringContaining("claude-code-bento-"),
      },
      strip: ["ANTHROPIC_"],
    })

    // revive 前先留 user_message,否则 closeSession 走空会话删档
    await manager.prompt(key, "第一轮")

    // revive(closeSession 杀进程 → prompt lazy 恢复):token 重签发,旧 token 失效
    await manager.closeSession(key)
    await manager.prompt(key, "续聊")
    expect(starts.length).toBe(2)
    const firstToken = starts[0]!.proxyEnv!.env.ANTHROPIC_BASE_URL
    const revivedToken = starts[1]!.proxyEnv!.env.ANTHROPIC_BASE_URL
    expect(revivedToken).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\//)
    expect(revivedToken).not.toBe(firstToken)

    // 删除会话:token 吊销,占用计数归零
    expect(routing.sessionsUsing("user-relay")).toBe(1)
    await manager.removeSession(key)
    expect(routing.sessionsUsing("user-relay")).toBe(0)
    routing.dispose()
  })

  it("Bento 注册表外的选择在底层 setModel 前被拒绝,不留假切换", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-unsafe-switch-"))
    const store = new CustomProviderStore(tempDir, memorySecrets())
    store.upsert({
      id: "user-relay-a",
      name: "Relay A",
      auth: { method: "apiKey" },
      runtimes: { kimi: { baseUrl: "https://a.example.com/v1", wireProtocol: "openai-chat", models: [{ id: "m1", name: "M1" }] } },
    }, { "*": "sk-a" })
    const routing = new ProviderRoutingService(tempDir, () => store)
    const registry = new SessionConfigRegistry()
    registry.register(new KimiBentoConfigAdapter("kimi", routing, tempDir))
    let setModelCalls = 0
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        return {
          nativeSessionId: "k-native",
          capabilities: { modelSwitch: "live", effortSwitch: "live" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
          setModel: async () => { setModelCalls += 1 },
        }
      },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, registry, bentoRuntimes("kimi", store))
    const { key } = await manager.createSession({
      harnessId: "kimi",
      cwd: tempDir,
      providerId: "user-relay-a",
      modelId: "m1",
    })
    // 注册表外 Provider:adapter 判 new-session;底层 setModel 从未被调,
    // SessionRecord 不变——不存在「UI 已切、请求仍走旧 Provider」的假切换
    await expect(manager.setModel(key, "user-ghost", "m1"))
      .rejects.toThrow(/需要新会话/)
    expect(setModelCalls).toBe(0)
    expect(manager.listSessions()[0]).toMatchObject({ providerId: "user-relay-a", modelId: "m1" })
    await manager.disposeAll()
    routing.dispose()
  })

  it("builtin OpenAI OAuth 会话经 codex Routed adapter 隔离代理,不继承宿主 Codex 登录态", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-builtin-provider-"))
    const store = new CustomProviderStore(tempDir, memorySecrets())
    store.writeOAuthTokens("openai", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60 * 60 * 1_000,
      accountId: "account-1",
    })
    const routing = new ProviderRoutingService(tempDir, () => store)
    const registry = new SessionConfigRegistry()
    registry.register(new RoutedBentoConfigAdapter("codex", routing, tempDir))
    const starts: HarnessStartOptions[] = []
    const driver: HarnessDriver = {
      id: "codex",
      async start(options) {
        starts.push(options)
        return {
          nativeSessionId: "codex-native",
          capabilities: { modelSwitch: "live", effortSwitch: "live" },
          prompt: async () => ({ stopReason: "completed" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    // main 侧 resolveProviderRuntimes 镜像(builtin 部分):OAuth provider 进注册表
    const openaiRuntime = async () => {
      const config = store.getProviderConfig("openai")
      const runtime = config?.runtimes.codex
      if (!config || !runtime) throw new Error("builtin openai codex runtime 缺失")
      return [{
        providerId: config.id,
        name: config.name,
        baseUrl: runtime.baseUrl,
        wireProtocol: runtime.wireProtocol,
        models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: false }],
        credential: { resolve: () => store.readOAuthTokens(config.id)?.accessToken ?? null },
      }]
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, registry, openaiRuntime)
    await manager.createSession({
      harnessId: "codex",
      cwd: tempDir,
      providerId: "openai",
      modelId: "gpt-5.4",
    })
    expect(starts[0]?.proxyEnv?.env).toMatchObject({
      CODEX_HOME: expect.stringContaining("codex-home-"),
      OPENAI_API_KEY: "bento-local-proxy",
    })
    await manager.disposeAll()
    routing.dispose()
  })
})

describe("SessionManager 错误/中断路径(TRACE_DATA_PLAN §3.4 P0-1)", () => {
  function lastTurnFinished(records: LogRecord[]) {
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]
      if (record.kind === "event" && record.payload.type === "turn_finished") {
        return record.payload
      }
    }
    return undefined
  }

  it("流 end 后 catch 补写的 turn_finished 被守卫整条跳过:不落盘、不广播、seq 不变", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-guard-"))
    let fireExit: ((code: number | null) => void) | undefined
    let promptCalls = 0
    const driver: HarnessDriver = {
      id: "kimi",
      async start() {
        return {
          nativeSessionId: "guard-1",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => {
            promptCalls += 1
            if (promptCalls === 1) {
              // 模拟 claude-agent-sdk:for-await 抛错前先同步触发 exitListeners,
              // main 侧 onExit handler 随之 append 退出 notice 并 logStream.end()
              fireExit?.(1)
              throw new Error("boom")
            }
            return { stopReason: "end_turn" }
          },
          cancel: async () => {},
          close: () => {},
          onExit: (callback) => {
            fireExit = callback
            return () => {
              fireExit = undefined
            }
          },
        }
      },
    }
    const received: LogRecord[] = []
    const manager = new SessionManager(tempDir, (_key, record) => received.push(record), () => driver, null, null, ...sessionConfigFor("kimi"))
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "moonshot", modelId: "kimi-k3",
    })
    received.length = 0

    // 守卫缺失时这里会对已 end 的 WriteStream write(ERR_STREAM_WRITE_AFTER_END)
    await expect(manager.prompt(key, "hi")).rejects.toThrow("boom")

    // 不落盘:JSONL 最后一条是退出 notice,没有 turn_finished。
    // write 是异步刷盘,读盘用 vi.waitFor 轮询
    let exitNoticeSeq = -1
    await vi.waitFor(() => {
      const persisted = manager.readEvents(key)
      const last = persisted.at(-1)
      expect(last && last.kind === "event" && last.payload.type === "notice").toBe(true)
      expect(lastTurnFinished(persisted)).toBeUndefined()
      if (last && last.kind === "event") exitNoticeSeq = last.seq
    })
    // 不广播:catch 补写没有到达 onEvent
    expect(
      received.some((r) => r.kind === "event" && r.payload.type === "turn_finished"),
    ).toBe(false)

    // seq 不变:守卫没有消耗 seq,revive 后下一条落盘记录紧接退出 notice。
    // (「只广播不落盘」的旧版守卫会在这里留下 seq 洞,renderer 去重误杀首块)
    await manager.prompt(key, "第二轮")
    await vi.waitFor(() => {
      const after = manager.readEvents(key)
      const userMessage = after.find(
        (r): r is Extract<LogRecord, { kind: "event" }> =>
          r.kind === "event" && r.payload.type === "user_message" &&
          r.payload.text === "第二轮",
      )
      expect(userMessage?.seq).toBe(exitNoticeSeq + 1)
      expect(lastTurnFinished(after)).toMatchObject({ reason: "end_turn" })
    })
    manager.disposeAll()
  })

  it("cancel 路径补落 cancelled,error 路径补落 error,prompt 入口清零防误标", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-session-cancel-"))
    let rejectFirstPrompt: ((error: Error) => void) | undefined
    let promptCalls = 0
    const firstPromptStarted = Promise.withResolvers<void>()
    const driver: HarnessDriver = {
      id: "pi",
      async start() {
        return {
          nativeSessionId: "cancel-1",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: () => {
            promptCalls += 1
            if (promptCalls > 1) return Promise.reject(new Error("real failure"))
            // 第一次挂起,直到 cancel() 触发 reject(模拟 Claude interrupt 走 throw 路径)
            const { promise, reject } = Promise.withResolvers<{ stopReason?: string }>()
            rejectFirstPrompt = reject
            firstPromptStarted.resolve()
            return promise
          },
          cancel: async () => {
            rejectFirstPrompt?.(new Error("aborted"))
          },
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(tempDir, () => {}, () => driver, null, null, ...sessionConfigFor("pi"))
    const { key } = await manager.createSession({
      harnessId: "pi", cwd: tempDir, providerId: "provider-pi", modelId: "pi-default",
    })

    // 真实 UI 只在回合运行中展示取消:等 prompt 真正进入飞行状态再 cancel
    const cancelled = manager.prompt(key, "长任务")
    await firstPromptStarted.promise
    await manager.cancel(key)
    await expect(cancelled).rejects.toThrow("aborted")
    await vi.waitFor(() => {
      expect(lastTurnFinished(manager.readEvents(key))).toMatchObject({ reason: "cancelled" })
    })

    // 入口清零:cancel 之后下一次真实 error 不得误标 cancelled
    const failed = manager.prompt(key, "第二轮")
    await expect(failed).rejects.toThrow("real failure")
    await vi.waitFor(() => {
      expect(lastTurnFinished(manager.readEvents(key))).toMatchObject({ reason: "error" })
    })
    manager.disposeAll()
  })
})

type Deferred = { resolve: (value: { stopReason?: string }) => void; reject: (e: unknown) => void }

function deferredDriver(options: { steer?: boolean } = {}) {
  const received: Array<string | PromptInput> = []
  const steered: Array<string | PromptInput> = []
  const deferreds: Deferred[] = []
  const driver: HarnessDriver = {
    id: "kimi",
    async start() {
      return {
        nativeSessionId: "collab-native",
        capabilities: { modelSwitch: "none", effortSwitch: "none", ...(options.steer ? { steer: "live" as const } : {}) },
        prompt: async (input) => {
          received.push(input)
          return new Promise((resolve, reject) => deferreds.push({ resolve, reject }))
        },
        cancel: async () => {},
        ...(options.steer ? { steer: async (input: string | PromptInput) => { steered.push(input) } } : {}),
        close: () => {},
        onExit: () => () => {},
      }
    },
  }
  return { driver, received, steered, deferreds }
}

function collabManager(dir: string, driver: HarnessDriver) {
  const emitted: LogRecord[] = []
  const manager = new SessionManager(dir, (_key, record) => emitted.push(record), () => driver, null, null, ...sessionConfigFor("kimi"))
  return { manager, emitted }
}

describe("SessionManager 协作切片(active turn / origin / wait)", () => {
  it("运行中只保留一条后续消息，本轮结束后自动启动", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-queued-prompt-"))
    const { driver, received, deferreds } = deferredDriver()
    const { manager } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    const first = await manager.startPrompt(key, "第一条")
    await expect(manager.queuePrompt(key, "下一条", "client-next")).resolves.toEqual({
      status: "queued", steerAvailable: false,
    })
    await expect(manager.queuePrompt(key, "第三条", "client-third")).rejects.toThrow("已有一条")
    deferreds[0].resolve({ stopReason: "end_turn" })
    await first.completion
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[1]).toEqual({ text: "下一条", attachments: [] })
    deferreds[1].resolve({ stopReason: "end_turn" })
  })

  it("支持 steer 的 Harness 可把待发送消息立即加入当前回合", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-steer-prompt-"))
    const { driver, steered, deferreds } = deferredDriver({ steer: true })
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    const first = await manager.startPrompt(key, "第一条")
    await expect(manager.queuePrompt(key, "改变方向", "client-steer")).resolves.toEqual({
      status: "queued", steerAvailable: true,
    })
    await manager.steerQueuedPrompt(key, "client-steer")
    expect(steered).toEqual([{ text: "改变方向", attachments: [] }])
    expect(emitted.some((record) =>
      record.kind === "event" && record.payload.type === "user_steer" && record.payload.text === "改变方向"))
      .toBe(true)
    deferreds[0].resolve({ stopReason: "end_turn" })
    await first.completion
  })

  it("startPrompt 落原文+origin,connection 只收 wireText;现有 prompt 行为不变", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-turn-"))
    const { driver, received, deferreds } = deferredDriver()
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi",
      cwd: tempDir,
      providerId: "user-kimi",
      modelId: "model",
    })

    const origin: MessageOrigin = { kind: "session", sessionId: "caller-1", title: "caller", harnessId: "pi" }
    const { acceptedSeq, completion } = await manager.startPrompt(key, "原文消息", {
      wireText: "[Bento message from \"caller\"]\n\n原文消息",
      origin,
    })
    expect(received).toEqual([{ text: "[Bento message from \"caller\"]\n\n原文消息", attachments: [] }])
    // JSONL 存原文+origin,envelope 不落盘
    const userRecord = emitted.find(
      (record) => record.kind === "event" && (record.payload as HarnessEvent).type === "user_message",
    )
    expect(userRecord).toMatchObject({
      seq: acceptedSeq,
      payload: {
        type: "user_message",
        text: "原文消息",
        origin,
      },
    })
    expect(JSON.stringify(userRecord)).not.toContain("[Bento message from")

    expect(manager.runtimeStatus(key)).toBe("working")
    deferreds[0].resolve({ stopReason: "end_turn" })
    await expect(completion).resolves.toMatchObject({ stopReason: "end_turn" })
    expect(manager.runtimeStatus(key)).toBe("idle")

    // 现有 prompt API:无 origin 时事件不带 origin 字段,等待 completion
    const plainPromise = manager.prompt(key, "人类输入")
    await new Promise((resolve) => setTimeout(resolve, 0))
    deferreds[1].resolve({ stopReason: "end_turn" })
    const plain = await plainPromise
    expect(plain).toMatchObject({ stopReason: "end_turn" })
    const lastUser = [...emitted].reverse().find(
      (record) => record.kind === "event" && (record.payload as HarnessEvent).type === "user_message",
    )!
    expect(lastUser.payload).toEqual({ type: "user_message", text: "人类输入" })
  })

  it("busy guard:并发第二笔 session_busy;上一回合落定后可再提交", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-busy-"))
    const { driver, deferreds } = deferredDriver()
    const { manager } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })

    const first = await manager.startPrompt(key, "第一笔")
    await expect(manager.startPrompt(key, "第二笔")).rejects.toMatchObject({
      name: "CollaborationError",
      code: "session_busy",
    })
    deferreds[0].resolve({ stopReason: "end_turn" })
    await first.completion
    const second = await manager.startPrompt(key, "第二笔")
    deferreds[1].resolve({ stopReason: "end_turn" })
    await second.completion
  })

  it("wait=false 早返回;后台 rejection 被 completion 承接,waitForTurn 超时不 cancel", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-wait-"))
    const { driver, deferreds } = deferredDriver()
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })

    const { acceptedSeq, completion } = await manager.startPrompt(key, "后台任务")
    // startPrompt 已返回,turn 仍在跑
    expect(deferreds).toHaveLength(1)
    const settled = manager.waitForTurn(key, acceptedSeq, 20)
    await expect(settled).rejects.toMatchObject({ code: "timeout" })
    expect(deferreds).toHaveLength(1) // 超时不 cancel 目标
    deferreds[0].reject(new Error("harness boom"))
    await expect(completion).rejects.toThrow("harness boom")
    // 错误路径仍有 turn_finished 回合终点
    expect(emitted.some(
      (record) => record.kind === "event" && (record.payload as HarnessEvent).type === "turn_finished",
    )).toBe(true)
    expect(manager.runtimeStatus(key)).toBe("idle")
    // 落定后 waitForTurn 立即 resolve
    await expect(manager.waitForTurn(key, acceptedSeq, 100)).resolves.toBeUndefined()
  })

  it("runtime 投影与 collaborationSession:close 后 sleeping,跨投影保留 scope/cwd", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-proj-"))
    const { driver, deferreds } = deferredDriver()
    const { manager } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model", title: "peer",
    })
    expect(manager.collaborationSession(key)).toMatchObject({
      id: key,
      title: "peer",
      workspace: { scope: "project", cwd: tempDir },
      harnessId: "kimi",
      providerId: "user-kimi",
      runtime: "idle",
    })
    const turn = await manager.startPrompt(key, "hi")
    expect(manager.runtimeStatus(key)).toBe("working")
    deferreds[0].resolve({})
    await turn.completion
    await manager.closeSession(key)
    expect(manager.runtimeStatus(key)).toBe("sleeping")
    expect(manager.collaborationSession(key)).toMatchObject({ runtime: "sleeping", id: key })
    expect(manager.collaborationSession("missing")).toBeNull()
  })
})

describe("SessionManager waitForTurn 精确匹配", () => {
  it("等待 B 的 acceptedSeq 时,A 的完成不能提前唤醒", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-precise-"))
    const { driver, deferreds } = deferredDriver()
    const { manager } = collabManager(tempDir, driver)
    const createdA = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model", title: "A",
    })
    const createdB = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model", title: "B",
    })
    const turnA = await manager.startPrompt(createdA.key, "A 的回合")
    const turnB = await manager.startPrompt(createdB.key, "B 的回合")

    let resolved = false
    const waitB = manager.waitForTurn(createdB.key, turnB.acceptedSeq, 2_000)
      .then(() => { resolved = true })

    // A 先完成:B 的等待绝不能被唤醒
    deferreds[0].resolve({ stopReason: "end_turn" })
    await turnA.completion
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(resolved).toBe(false)

    deferreds[1].resolve({ stopReason: "end_turn", usage: { cost: 0.01 } })
    await waitB
    expect(resolved).toBe(true)
    // TurnResult 保留 usage
    await expect(turnB.completion).resolves.toMatchObject({ usage: { cost: 0.01 } })
  })

  it("旧 acceptedSeq 在新 turn 运行中立即视为已 settled,不等待新 turn", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-collab-stale-"))
    const { driver, deferreds } = deferredDriver()
    const { manager } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })

    const first = await manager.startPrompt(key, "第一回合")
    deferreds[0].resolve({ stopReason: "end_turn" })
    await first.completion

    const second = await manager.startPrompt(key, "第二回合")
    expect(deferreds[1]).toBeDefined()

    const started = Date.now()
    await manager.waitForTurn(key, first.acceptedSeq, 5_000)
    expect(Date.now() - started).toBeLessThan(100)
    // 新 turn 仍未被打扰
    expect(manager.runtimeStatus(key)).toBe("working")
    deferreds[1].resolve({})
    await second.completion
  })
})

describe("SessionManager 审批编排", () => {
  type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  /** 带审批能力的 mock driver:emit 捕获、resolveApproval/cancel  spy、prompt 手动结算 */
  function approvalDriver() {
    let emitEvent: (event: HarnessEvent) => void = () => {}
    const deferreds: Deferred[] = []
    const resolved: Array<{ id: string; decision: string }> = []
    const cancelCalls: number[] = []
    const driver: HarnessDriver = {
      id: "kimi",
      async start(_options, emit) {
        emitEvent = emit
        return {
          nativeSessionId: "approval-native",
          capabilities: { modelSwitch: "none", effortSwitch: "none", permissionSwitch: "live" },
          prompt: async () => new Promise((resolve, reject) => deferreds.push({ resolve, reject })),
          cancel: async () => { cancelCalls.push(1) },
          close: () => {},
          onExit: () => () => {},
          resolveApproval: (id: string, decision: "allow_once" | "allow_always" | "deny") => {
            resolved.push({ id, decision })
          },
        }
      },
    }
    return { driver, deferreds, resolved, cancelCalls, emit: (e: HarnessEvent) => emitEvent(e) }
  }
  const REQUEST = {
    type: "approval_request" as const,
    id: "apr-1",
    title: "rm -rf /tmp/x",
    options: [{ id: "allow_once" as const, label: "允许一次" }],
  }
  const resolvedEvents = (emitted: LogRecord[]) =>
    emitted.filter((r) => r.kind === "event" && (r.payload as HarnessEvent).type === "approval_resolved")
      .map((r) => r.payload as Extract<HarnessEvent, { type: "approval_resolved" }>)

  it("用户决议:落盘 approval_resolved(source=user)并兑现 driver hold", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apr-user-"))
    const { driver, deferreds, resolved, emit } = approvalDriver()
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    const turn = await manager.startPrompt(key, "干活")
    emit(REQUEST)
    manager.resolveApproval(key, "apr-1", "allow_once")
    expect(resolvedEvents(emitted)).toEqual([
      { type: "approval_resolved", id: "apr-1", decision: "allow_once", source: "user" },
    ])
    expect(resolved).toEqual([{ id: "apr-1", decision: "allow_once" }])
    // 重复决议/未知 id 报错,不重复落盘
    expect(() => manager.resolveApproval(key, "apr-1", "deny")).toThrow("已结算")
    deferreds[0].resolve({ stopReason: "end_turn" })
    await turn.completion
  })

  it("cancel 竞态:pending 先按 cancel 结算落盘,再调 connection.cancel", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apr-cancel-"))
    const { driver, deferreds, resolved, cancelCalls, emit } = approvalDriver()
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    const turn = await manager.startPrompt(key, "干活")
    emit(REQUEST)
    await manager.cancel(key)
    expect(resolvedEvents(emitted)).toEqual([
      { type: "approval_resolved", id: "apr-1", decision: "deny", source: "cancel" },
    ])
    expect(resolved).toEqual([{ id: "apr-1", decision: "deny" }])
    expect(cancelCalls).toHaveLength(1)
    deferreds[0].resolve({ stopReason: "cancelled" })
    await turn.completion
  })

  it("会话关闭:pending 按 session-close 结算落盘,回放不留悬挂卡", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apr-close-"))
    const { driver, deferreds, resolved, emit } = approvalDriver()
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    const turn = await manager.startPrompt(key, "干活")
    emit(REQUEST)
    await manager.closeSession(key)
    deferreds[0].resolve({ stopReason: "process_exit" })
    await turn.completion.catch(() => {})
    expect(resolvedEvents(emitted)).toEqual([
      { type: "approval_resolved", id: "apr-1", decision: "deny", source: "session-close" },
    ])
    expect(resolved).toEqual([{ id: "apr-1", decision: "deny" }])
    // logStream.end 不 await finish,磁盘断言等 flush 落稳
    await vi.waitFor(() => {
      expect(resolvedEvents(manager.readEvents(key))).toEqual([
        { type: "approval_resolved", id: "apr-1", decision: "deny", source: "session-close" },
      ])
    })
  })

  it("协作 origin 回合:审批请求立即按 deny 自动裁决(unattended),不排队", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-apr-unattended-"))
    const { driver, deferreds, resolved, emit } = approvalDriver()
    const { manager, emitted } = collabManager(tempDir, driver)
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    const origin: MessageOrigin = { kind: "session", sessionId: "other", title: "别的会话", harnessId: "kimi" }
    const turn = await manager.startPrompt(key, "协作任务", { origin })
    emit(REQUEST)
    // 无需用户动作:append 时即刻自动结算
    expect(resolvedEvents(emitted)).toEqual([
      { type: "approval_resolved", id: "apr-1", decision: "deny", source: "unattended-auto" },
    ])
    expect(resolved).toEqual([{ id: "apr-1", decision: "deny" }])
    deferreds[0].resolve({ stopReason: "end_turn" })
    await turn.completion
  })
})

describe("SessionManager 权限规则注入与回报", () => {
  it("持久规则注入 start 选项,rule_added 回报写回项目文件", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-rule-inject-"))
    // 预置项目级规则:claude-code 的 Bash 总是允许
    fs.mkdirSync(path.join(tempDir, ".bento"), { recursive: true })
    fs.writeFileSync(path.join(tempDir, ".bento", "permissions.json"), JSON.stringify({
      version: 1,
      rules: [{ harnessId: "kimi", rule: "Bash", createdAt: "2026-01-01T00:00:00.000Z" }],
    }))
    let started: HarnessStartOptions | undefined
    let emitEvent: (event: HarnessEvent) => void = () => {}
    const driver: HarnessDriver = {
      id: "kimi",
      async start(options, emit) {
        started = options
        emitEvent = emit
        return {
          nativeSessionId: "rule-native",
          capabilities: { modelSwitch: "none", effortSwitch: "none" },
          prompt: async () => ({ stopReason: "end_turn" }),
          cancel: async () => {},
          close: () => {},
          onExit: () => () => {},
        }
      },
    }
    const manager = new SessionManager(
      tempDir, () => {}, () => driver, null, null, ...sessionConfigFor("kimi"),
    )
    await manager.createSession({
      harnessId: "kimi", cwd: tempDir, providerId: "user-kimi", modelId: "model",
    })
    expect(started?.allowedTools).toEqual(["Bash"])

    // driver 回报新规则 → main 写回项目级 permissions.json
    emitEvent({ type: "metadata", name: "permission/rule_added", data: { toolName: "Edit" } })
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tempDir, ".bento", "permissions.json"), "utf8"),
    ) as { rules: Array<{ harnessId: string; rule: string }> }
    expect(onDisk.rules.map((r) => `${r.harnessId}:${r.rule}`))
      .toEqual(["kimi:Bash", "kimi:Edit"])
  })
})
