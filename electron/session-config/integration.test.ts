/**
 * SessionManager × session-config adapter 集成测试(fake driver):
 * Bento adapter 接入后的启动/切换/清理全链路。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CustomProviderConfig, ProviderModel } from "../../src/core/provider"
import type { HarnessDriver, HarnessStartOptions } from "../drivers/types"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import { SessionManager } from "../sessions"
import { KimiBentoConfigAdapter } from "./kimi"
import { OpenCodeBentoConfigAdapter } from "./opencode"
import { OmpBentoConfigAdapter } from "./omp"
import { PiBentoConfigAdapter } from "./pi"
import { HermesBentoConfigAdapter } from "./hermes"
import { SessionConfigRegistry } from "./registry"

function memorySecrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

const dirs: string[] = []
const routings: ProviderRoutingService[] = []

afterEach(() => {
  for (const routing of routings.splice(0)) routing.dispose()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 按 harnessId 生成含单个 runtime 的 user config。 */
function userConfig(harnessId: "kimi" | "opencode" | "omp" | "pi" | "hermes", id: string, models: ProviderModel[]): CustomProviderConfig {
  return {
    id,
    name: id,
    auth: { method: "apiKey" },
    runtimes: {
      [harnessId]: {
        baseUrl: `https://${id}.example.com/v1`,
        wireProtocol: "openai-chat",
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.reasoning ? { reasoning: true } : {}),
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        })),
      },
    },
  }
}

/** fake driver(kimi/opencode/omp/pi/hermes 通用):记录 start options 与 setModel 调用;可注入进程 exit。 */
function fakeDriver(id: "kimi" | "opencode" | "omp" | "pi" | "hermes" = "kimi") {
  const starts: HarnessStartOptions[] = []
  const setModelCalls: string[] = []
  let exitListener: ((code: number | null) => void) | undefined
  const driver: HarnessDriver = {
    id,
    async start(options) {
      starts.push(options)
      return {
        nativeSessionId: `native-${starts.length}`,
        capabilities: { modelSwitch: "live", effortSwitch: "live" },
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => {},
        close: () => {},
        onExit: (callback) => {
          exitListener = callback
          return () => { exitListener = undefined }
        },
        setModel: async (modelId) => { setModelCalls.push(modelId) },
      }
    },
  }
  return {
    driver,
    starts,
    setModelCalls,
    /** 模拟 harness 进程异常退出。 */
    triggerExit: (code: number | null = 1) => exitListener?.(code),
  }
}

/** bento 模式 runtime resolver(main 侧逻辑镜像,含 credential handle)。 */
function bentoRuntimes(harnessId: "kimi" | "opencode" | "omp" | "pi" | "hermes", store: CustomProviderStore) {
  return async () => store.list()
    .filter((config) =>
      config.runtimes[harnessId] &&
      store.hasCredentialFor(config, harnessId) &&
      config.runtimes[harnessId]!.models.some((model) => model.enabled !== false))
    .map((config) => {
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


describe("Kimi bento adapter 集成", () => {
  it("start 收到 KIMI_CODE_HOME 与 alias 模型;跨 provider setModel live;close 保留 revive 复用 remove 删除", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-kimi-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("kimi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    store.upsert(userConfig("kimi", "user-beta", [{ id: "m-b1", name: "B1", reasoning: false }]), { "*": "sk-b" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)

    const registry = new SessionConfigRegistry()
    registry.register(new KimiBentoConfigAdapter("kimi", routing, dir))

    const { driver, starts, setModelCalls } = fakeDriver("kimi")
    const manager = new SessionManager(
      dir,
      () => {},
      () => driver,
      routing,
      // resolver:直通 record 选择(默认 null 会被 connectSession 拒绝)
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry,
      bentoRuntimes("kimi", store),
    )
    const { key } = await manager.createSession({
      harnessId: "kimi",
      cwd: dir,
      providerId: "user-alpha",
      modelId: "m-a1",
    })

    // start 恰一次;env 指向隔离 home;modelId 是 alias 形态;无明文 key env
    expect(starts).toHaveLength(1)
    const home = starts[0]!.proxyEnv!.env.KIMI_CODE_HOME!
    expect(home).toContain("kimi-bento-")
    expect(fs.existsSync(path.join(home, "config.toml"))).toBe(true)
    expect(starts[0]!.modelId).toMatch(/^bento-\w+\/m-a1$/)
    expect(starts[0]!.proxyEnv!.env).not.toHaveProperty("KIMI_MODEL_API_KEY")

    // 跨 provider 切换:live 收 alias,driver 不重启
    await manager.prompt(key, "第一轮")
    await manager.setModel(key, "user-beta", "m-b1")
    expect(setModelCalls).toEqual([expect.stringMatching(/^bento-\w+\/m-b1$/)])
    expect(manager.listSessions()[0]).toMatchObject({ providerId: "user-beta", modelId: "m-b1" })
    expect(starts).toHaveLength(1)

    // 普通关闭(有 user_message):只 dispose routes,隔离目录保留
    await manager.closeSession(key)
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
    expect(fs.existsSync(path.join(home, "config.toml"))).toBe(true)

    // revive:lazy 恢复复用同一 KIMI_CODE_HOME
    await manager.prompt(key, "续聊")
    expect(starts).toHaveLength(2)
    expect(starts[1]!.proxyEnv!.env.KIMI_CODE_HOME).toBe(home)

    // 删除会话:目录彻底删除,routes 归零
    await manager.removeSession(key)
    expect(fs.existsSync(home)).toBe(false)
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    expect(routing.sessionsUsing("user-beta")).toBe(0)
  })

  it("进程异常退出后隔离目录保留(revive 可恢复),不误删会话状态", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-kimi-exit-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("kimi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new KimiBentoConfigAdapter("kimi", routing, dir))
    const { driver, starts, triggerExit } = fakeDriver("kimi")
    const manager = new SessionManager(
      dir, () => {}, () => driver, routing,
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry, bentoRuntimes("kimi", store),
    )
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: dir, providerId: "user-alpha", modelId: "m-a1",
    })
    await manager.prompt(key, "hi")
    const home = starts[0]!.proxyEnv!.env.KIMI_CODE_HOME!

    triggerExit(1) // harness 进程异常退出
    expect(manager.isLive(key)).toBe(false)
    expect(fs.existsSync(home)).toBe(true)
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
    // 会话记录仍在,revive 可恢复
    expect(manager.listSessions().some((item) => item.key === key)).toBe(true)
  })

  it("空会话(无 user_message)关闭即删档,连同 adapter 状态", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-kimi-empty-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("kimi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new KimiBentoConfigAdapter("kimi", routing, dir))
    const { driver, starts } = fakeDriver("kimi")
    const manager = new SessionManager(
      dir, () => {}, () => driver, routing,
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry, bentoRuntimes("kimi", store),
    )
    const { key } = await manager.createSession({
      harnessId: "kimi", cwd: dir, providerId: "user-alpha", modelId: "m-a1",
    })
    const home = starts[0]!.proxyEnv!.env.KIMI_CODE_HOME!
    await manager.closeSession(key) // 无 user_message → 删档
    expect(fs.existsSync(home)).toBe(false)
    expect(manager.listSessions()).toHaveLength(0)
  })

  it("start 失败立即回收租约与状态:无目录/route 泄漏", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-kimi-fail-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("kimi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new KimiBentoConfigAdapter("kimi", routing, dir))

    let attemptedHome = ""
    const failingDriver: HarnessDriver = {
      id: "kimi",
      async start(options) {
        attemptedHome = options.proxyEnv?.env.KIMI_CODE_HOME ?? ""
        throw new Error("spawn 失败")
      },
    }
    const manager = new SessionManager(dir, () => {}, () => failingDriver, routing, null, registry, bentoRuntimes("kimi", store))
    await expect(manager.createSession({
      harnessId: "kimi", cwd: dir, providerId: "user-alpha", modelId: "m-a1",
    })).rejects.toThrow(/spawn 失败/)

    expect(fs.existsSync(attemptedHome)).toBe(false)
    expect(routing.sessionsUsing("user-alpha")).toBe(0)
  })

})

describe("Hermes bento adapter 集成", () => {
  function hermesHarness(dir: string, store: CustomProviderStore) {
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new HermesBentoConfigAdapter("hermes", routing, dir))
    const { driver, starts, setModelCalls } = fakeDriver("hermes")
    const manager = new SessionManager(
      dir,
      () => {},
      () => driver,
      routing,
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry,
      bentoRuntimes("hermes", store),
    )
    return { manager, starts, setModelCalls }
  }

  it("start 收到完整 config.yaml；跨 provider 通过 custom:alias:model live 切换", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-hermes-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("hermes", "user-alpha", [
      { id: "m-a1", name: "A1", reasoning: false },
      { id: "m-a2", name: "A2", reasoning: true },
    ]), { "*": "sk-a" })
    store.upsert(userConfig("hermes", "user-beta", [
      { id: "m-b1", name: "B1", reasoning: false },
    ]), { "*": "sk-b" })
    const { manager, starts, setModelCalls } = hermesHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "hermes", cwd: dir, providerId: "user-alpha", modelId: "m-a1",
    })
    expect(starts).toHaveLength(1)
    const home = starts[0]!.proxyEnv!.env.HERMES_HOME!
    const config = fs.readFileSync(path.join(home, "config.yaml"), "utf8")
    expect((config.match(/"m-a1"|"m-a2"|"m-b1"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(config).not.toContain("sk-a")
    expect(starts[0]!.modelId).toMatch(/^custom:bento-[0-9a-z]+:m-a1$/)

    await manager.prompt(key, "第一轮")
    await manager.setModel(key, "user-beta", "m-b1")
    expect(setModelCalls).toEqual([expect.stringMatching(/^custom:bento-[0-9a-z]+:m-b1$/)])
    expect(manager.listSessions()[0]).toMatchObject({ providerId: "user-beta", modelId: "m-b1" })
    expect(starts).toHaveLength(1)
  })

  it("close 保留 Hermes home，revive 复用，remove 清理", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-hermes-close-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("hermes", "user-alpha", [
      { id: "m-a1", name: "A1", reasoning: false },
    ]), { "*": "sk-a" })
    const { manager, starts } = hermesHarness(dir, store)
    const { key } = await manager.createSession({
      harnessId: "hermes", cwd: dir, providerId: "user-alpha", modelId: "m-a1",
    })
    const home = starts[0]!.proxyEnv!.env.HERMES_HOME!

    await manager.prompt(key, "第一轮")
    await manager.closeSession(key)
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(true)
    await manager.prompt(key, "续聊")
    expect(starts[1]!.proxyEnv!.env.HERMES_HOME).toBe(home)
    await manager.removeSession(key)
    expect(fs.existsSync(home)).toBe(false)
  })

  it("Hermes start 失败立即删除隔离目录", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-hermes-fail-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("hermes", "user-alpha", [
      { id: "m-a1", name: "A1", reasoning: false },
    ]), { "*": "sk-a" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new HermesBentoConfigAdapter("hermes", routing, dir))
    const failingDriver: HarnessDriver = {
      id: "hermes",
      async start() { throw new Error("hermes spawn 失败") },
    }
    const manager = new SessionManager(
      dir, () => {}, () => failingDriver, routing, null, registry, bentoRuntimes("hermes", store),
    )

    await expect(manager.createSession({
      harnessId: "hermes", cwd: dir, providerId: "user-alpha", modelId: "m-a1",
    })).rejects.toThrow(/hermes spawn 失败/)
    expect(
      fs.readdirSync(path.join(dir, "providers")).filter((name) => name.startsWith("hermes-bento-")),
    ).toHaveLength(0)
  })
})

describe("OpenCode bento adapter 集成", () => {
  function opencodeHarness(dir: string, store: CustomProviderStore) {
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new OpenCodeBentoConfigAdapter("opencode", routing, dir))
    const { driver, starts, setModelCalls } = fakeDriver("opencode")
    const manager = new SessionManager(
      dir,
      () => {},
      () => driver,
      routing,
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry,
      bentoRuntimes("opencode", store),
    )
    return { manager, starts, setModelCalls }
  }

  it("start 收到 OPENCODE_CONFIG + alias 模型;配置含双 provider 零明文,凭证在 env;跨 provider setModel live 收 alias", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-opencode-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("opencode", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }, { id: "m-a2", name: "A2", reasoning: false }]), { "*": "sk-real-alpha" })
    store.upsert(userConfig("opencode", "user-beta", [{ id: "m-b1", name: "B1", reasoning: false }]), { "*": "sk-real-beta" })
    const { manager, starts, setModelCalls } = opencodeHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "opencode",
      cwd: dir,
      providerId: "user-alpha",
      // picker 对 opencode user provider 发布的是 `bento/<id>` 形状
      modelId: "bento/m-a1",
    })

    expect(starts).toHaveLength(1)
    const configFile = starts[0]!.proxyEnv!.env.OPENCODE_CONFIG!
    expect(configFile).toContain("opencode-bento-")
    const text = fs.readFileSync(configFile, "utf8")
    expect(text).toContain("@ai-sdk/openai-compatible")
    expect(text.match(/"(m-a1|m-a2|m-b1)":/g)).toHaveLength(3)
    // 双 provider 注册表;零明文密钥;env 只有占位符,真实凭证由 loopback proxy 注入
    expect(text.split("@ai-sdk/").length - 1).toBeGreaterThanOrEqual(2)
    expect(text).not.toContain("sk-real-alpha")
    expect(text).not.toContain("sk-real-beta")
    const keyEnvs = Object.entries(starts[0]!.proxyEnv!.env)
      .filter(([name]) => name.startsWith("BENTO_PROVIDER_KEY_"))
    expect(keyEnvs).toHaveLength(2)
    expect(keyEnvs.every(([, value]) => value === "bento-session-route")).toBe(true)
    // wire 模型是 alias/model
    expect(starts[0]!.modelId).toMatch(/^bento-[0-9a-z]+\/m-a1$/)

    // 跨 provider 切换:live 收 alias,SessionRecord 保持 Bento 身份
    await manager.prompt(key, "第一轮")
    await manager.setModel(key, "user-beta", "bento/m-b1")
    expect(setModelCalls).toEqual([expect.stringMatching(/^bento-[0-9a-z]+\/m-b1$/)])
    expect(manager.listSessions()[0]).toMatchObject({ providerId: "user-beta", modelId: "bento/m-b1" })
    expect(starts).toHaveLength(1)
  })

  it("普通 close 保留 opencode 配置目录供离线 resume;revive 复用同一目录;remove/start failure 清理", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-opencode-close-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("opencode", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const { manager, starts } = opencodeHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "opencode", cwd: dir, providerId: "user-alpha", modelId: "bento/m-a1",
    })
    const configFile = starts[0]!.proxyEnv!.env.OPENCODE_CONFIG!
    await manager.prompt(key, "第一轮")
    await manager.closeSession(key)
    expect(fs.existsSync(configFile)).toBe(true)

    await manager.prompt(key, "续聊")
    expect(starts).toHaveLength(2)
    expect(starts[1]!.proxyEnv!.env.OPENCODE_CONFIG).toBe(configFile)

    await manager.removeSession(key)
    expect(fs.existsSync(configFile)).toBe(false)
  })

  it("OpenCode start 失败立即删除隔离目录", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-opencode-fail-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("opencode", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const registry = new SessionConfigRegistry()
    registry.register(new OpenCodeBentoConfigAdapter("opencode", dir))
    const failingDriver: HarnessDriver = {
      id: "opencode",
      async start() { throw new Error("opencode spawn 失败") },
    }
    const manager = new SessionManager(dir, () => {}, () => failingDriver, null, null, registry, bentoRuntimes("opencode", store))

    let attemptedFile = ""
    try {
      await manager.createSession({
        harnessId: "opencode", cwd: dir, providerId: "user-alpha", modelId: "bento/m-a1",
      })
      expect.unreachable("createSession 应失败")
    } catch {
      // 预期失败;从注册表里找同前缀目录确认已清理
      attemptedFile = path.join(dir, "providers")
    }
    expect(fs.readdirSync(attemptedFile).filter((name) => name.startsWith("opencode-bento-"))).toHaveLength(0)
  })
})

describe("OMP bento adapter 集成", () => {
  function ompHarness(dir: string, store: CustomProviderStore) {
    const registry = new SessionConfigRegistry()
    registry.register(new OmpBentoConfigAdapter("omp", new ProviderRoutingService(dir, () => store), dir))
    const { driver, starts, setModelCalls } = fakeDriver("omp")
    const manager = new SessionManager(
      dir,
      () => {},
      () => driver,
      null,
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry,
      bentoRuntimes("omp", store),
    )
    return { manager, starts, setModelCalls }
  }

  it("start 收到 PI_CODING_AGENT_DIR + 根 models.yml 与 alias 模型;跨 provider setModel live 收 alias", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-omp-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("omp", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }, { id: "m-a2", name: "A2", reasoning: false }]), { "*": "sk-real-alpha" })
    store.upsert(userConfig("omp", "user-beta", [{ id: "m-b1", name: "B1", reasoning: false }]), { "*": "sk-real-beta" })
    const { manager, starts, setModelCalls } = ompHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "omp",
      cwd: dir,
      providerId: "user-alpha",
      modelId: "bento/m-a1",
    })

    // spike 约定:PI_CODING_AGENT_DIR 指向隔离目录,模型文件是根目录 models.yml
    expect(starts).toHaveLength(1)
    const agentDir = starts[0]!.proxyEnv!.env.PI_CODING_AGENT_DIR!
    expect(agentDir).toContain("omp-bento-")
    expect(fs.existsSync(path.join(agentDir, "models.yml"))).toBe(true)
    // env 不携带明文 key;注册表双 provider 三模型零明文
    expect(Object.keys(starts[0]!.proxyEnv!.env)).toEqual(["PI_CODING_AGENT_DIR"])
    const yml = fs.readFileSync(path.join(agentDir, "models.yml"), "utf8")
    expect((yml.match(/- \{ id:/g) ?? []).length).toBe(3)
    expect(yml).not.toContain("sk-real-alpha")
    // wire 模型是 alias/model
    expect(starts[0]!.modelId).toMatch(/^bento-[0-9a-z]+\/m-a1$/)

    // 跨 provider 切换:live 收 alias,SessionRecord 保持 Bento 身份,进程不重启
    await manager.prompt(key, "第一轮")
    await manager.setModel(key, "user-beta", "bento/m-b1")
    expect(setModelCalls).toEqual([expect.stringMatching(/^bento-[0-9a-z]+\/m-b1$/)])
    expect(manager.listSessions()[0]).toMatchObject({ providerId: "user-beta", modelId: "bento/m-b1" })
    expect(starts).toHaveLength(1)
  })

  it("普通 close 保留 omp 隔离目录供离线 resume;revive 复用同一目录;remove 清理", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-omp-close-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("omp", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const { manager, starts } = ompHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "omp", cwd: dir, providerId: "user-alpha", modelId: "bento/m-a1",
    })
    const agentDir = starts[0]!.proxyEnv!.env.PI_CODING_AGENT_DIR!

    await manager.prompt(key, "第一轮")
    await manager.closeSession(key)
    expect(fs.existsSync(path.join(agentDir, "models.yml"))).toBe(true)

    await manager.prompt(key, "续聊") // revive
    expect(starts).toHaveLength(2)
    expect(starts[1]!.proxyEnv!.env.PI_CODING_AGENT_DIR).toBe(agentDir)

    await manager.removeSession(key)
    expect(fs.existsSync(agentDir)).toBe(false)
  })

  it("OpenCode/OMP start 失败立即删除隔离目录", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-omp-fail-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("omp", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const registry = new SessionConfigRegistry()
    registry.register(new OmpBentoConfigAdapter("omp", new ProviderRoutingService(dir, () => store), dir))
    const failingDriver: HarnessDriver = {
      id: "omp",
      async start() { throw new Error("omp spawn 失败") },
    }
    const manager = new SessionManager(dir, () => {}, () => failingDriver, null, null, registry, bentoRuntimes("omp", store))

    await expect(manager.createSession({
      harnessId: "omp", cwd: dir, providerId: "user-alpha", modelId: "bento/m-a1",
    })).rejects.toThrow(/omp spawn 失败/)
    expect(
      fs.readdirSync(path.join(dir, "providers")).filter((name) => name.startsWith("omp-bento-")),
    ).toHaveLength(0)
  })
})

describe("Pi bento adapter 集成", () => {
  function piHarness(dir: string, store: CustomProviderStore) {
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new PiBentoConfigAdapter("pi", routing, dir))
    const { driver, starts, setModelCalls } = fakeDriver("pi")
    const manager = new SessionManager(
      dir,
      () => {},
      () => driver,
      routing,
      async (record) => ({ providerId: record.providerId!, modelId: record.modelId! }),
      registry,
      bentoRuntimes("pi", store),
    )
    return { manager, starts, setModelCalls }
  }

  it("start 收到 PI_CODING_AGENT_DIR + 根 models.json 与 alias 模型;跨 provider setModel live 收 alias", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-pi-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("pi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }, { id: "m-a2", name: "A2", reasoning: true, contextWindow: 262144 }]), { "*": "sk-real-alpha" })
    store.upsert(userConfig("pi", "user-beta", [{ id: "m-b1", name: "B1", reasoning: false }]), { "*": "sk-real-beta" })
    const { manager, starts, setModelCalls } = piHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "pi",
      cwd: dir,
      providerId: "user-alpha",
      modelId: "bento/m-a1",
    })

    expect(starts).toHaveLength(1)
    const agentDir = starts[0]!.proxyEnv!.env.PI_CODING_AGENT_DIR!
    expect(agentDir).toContain("pi-bento-")
    const jsonText = fs.readFileSync(path.join(agentDir, "models.json"), "utf8")
    // 双 provider 三模型;reasoning/contextWindow 保留;零明文
    expect((jsonText.match(/"id": "/g) ?? []).length).toBe(3)
    expect(jsonText).toContain('"reasoning": true')
    expect(jsonText).toContain('"contextWindow": 262144')
    expect(jsonText).not.toContain("sk-real")
    expect(Object.keys(starts[0]!.proxyEnv!.env)).toEqual(["PI_CODING_AGENT_DIR"])
    expect(starts[0]!.modelId).toMatch(/^bento-[0-9a-z]+\/m-a1$/)

    // 跨 provider set_model live:收 alias、SessionRecord 保持 Bento 身份、进程不重启
    await manager.prompt(key, "第一轮")
    await manager.setModel(key, "user-beta", "bento/m-b1")
    expect(setModelCalls).toEqual([expect.stringMatching(/^bento-[0-9a-z]+\/m-b1$/)])
    expect(manager.listSessions()[0]).toMatchObject({ providerId: "user-beta", modelId: "bento/m-b1" })
    expect(starts).toHaveLength(1)
  })

  it("普通 close 保留 pi 隔离目录供离线 resume;revive 复用同一目录;remove 清理", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-pi-close-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("pi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const { manager, starts } = piHarness(dir, store)

    const { key } = await manager.createSession({
      harnessId: "pi", cwd: dir, providerId: "user-alpha", modelId: "bento/m-a1",
    })
    const agentDir = starts[0]!.proxyEnv!.env.PI_CODING_AGENT_DIR!

    await manager.prompt(key, "第一轮")
    await manager.closeSession(key)
    expect(fs.existsSync(path.join(agentDir, "models.json"))).toBe(true)

    await manager.prompt(key, "续聊") // revive 复用同一目录
    expect(starts).toHaveLength(2)
    expect(starts[1]!.proxyEnv!.env.PI_CODING_AGENT_DIR).toBe(agentDir)

    await manager.removeSession(key)
    expect(fs.existsSync(agentDir)).toBe(false)
  })

  it("Pi start 失败立即删除隔离目录", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-sm-pi-fail-"))
    dirs.push(dir)
    const store = new CustomProviderStore(dir, memorySecrets())
    store.upsert(userConfig("pi", "user-alpha", [{ id: "m-a1", name: "A1", reasoning: false }]), { "*": "sk-a" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const registry = new SessionConfigRegistry()
    registry.register(new PiBentoConfigAdapter("pi", routing, dir))
    const failingDriver: HarnessDriver = {
      id: "pi",
      async start() { throw new Error("pi spawn 失败") },
    }
    const manager = new SessionManager(dir, () => {}, () => failingDriver, null, null, registry, bentoRuntimes("pi", store))

    await expect(manager.createSession({
      harnessId: "pi", cwd: dir, providerId: "user-alpha", modelId: "bento/m-a1",
    })).rejects.toThrow(/pi spawn 失败/)
    expect(
      fs.readdirSync(path.join(dir, "providers")).filter((name) => name.startsWith("pi-bento-")),
    ).toHaveLength(0)
  })
})
