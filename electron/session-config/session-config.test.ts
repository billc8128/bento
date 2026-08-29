import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { HarnessId } from "../../src/core/harness"
import { NativeConfigAdapter } from "./native"
import { SessionConfigRegistry } from "./registry"
import {
  modeOfSelection,
  parseSelectionKey,
  selectionKey,
  type SessionConfigAdapter,
  type SessionConfigLease,
  type SessionConfigRequest,
} from "./types"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

function nativeCatalog() {
  return [
    {
      providerId: "native-kimi",
      name: "Kimi",
      baseUrl: "",
      wireProtocol: "openai-chat" as const,
      models: [
        { id: "kimi-code/k3-256k", name: "K3-256k", reasoning: true },
        { id: "kimi-code/k3", name: "K3", reasoning: true },
      ],
    },
    {
      providerId: "native-kimi/volcengine-agent-plan",
      name: "火山方舟 Agent Plan",
      baseUrl: "",
      wireProtocol: "openai-chat" as const,
      models: [{ id: "agent-plan/kimi-k3", name: "Kimi K3", reasoning: true }],
    },
  ]
}

function nativeRequest(overrides: Partial<SessionConfigRequest> = {}): SessionConfigRequest {
  return {
    sessionKey: "sess-1",
    harnessId: "kimi" as HarnessId,
    cwd: os.tmpdir(),
    mode: "native",
    selected: { providerId: "native-kimi", modelId: "kimi-code/k3-256k" },
    providers: nativeCatalog(),
    ...overrides,
  }
}

describe("selectionKey 编解码", () => {
  it("编码后可无损解析,且不会被 `/` 前缀混淆", () => {
    const key = selectionKey("native-kimi/moonshot", "kimi-code/k3")
    expect(parseSelectionKey(key)).toEqual({
      providerId: "native-kimi/moonshot",
      modelId: "kimi-code/k3",
    })
  })

  it("拒绝损坏与非字符串成员", () => {
    expect(parseSelectionKey("not-json")).toBeNull()
    expect(parseSelectionKey('["only-one"]')).toBeNull()
    expect(parseSelectionKey('[1, 2]')).toBeNull()
    expect(parseSelectionKey('["", "m"]')).toBeNull()
  })

  it("modeOfSelection 按 provider 前缀判定模式", () => {
    expect(modeOfSelection({ providerId: "native-kimi", modelId: "m" })).toBe("native")
    expect(modeOfSelection({ providerId: "user-kimi-code", modelId: "m" })).toBe("bento")
    expect(modeOfSelection({ providerId: "anthropic", modelId: "m" })).toBe("bento")
  })
})

describe("NativeConfigAdapter", () => {
  it("prepare 不注入 env、不建临时目录,登记启动选择", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-native-lease-"))
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    const lease = await adapter.prepare(nativeRequest({ sessionKey: "s1", cwd: tempDir }))
    expect(lease.mode).toBe("native")
    expect(lease.env).toEqual({})
    expect(lease.strip).toEqual([])
    expect(lease.configDir).toBeUndefined()
    expect(lease.selected.harnessModelId).toBe("kimi-code/k3-256k")
  })

  it("bento Provider 的选择在 native 租约上返回 new-session", async () => {
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    const lease = await adapter.prepare(nativeRequest())
    const crossMode = await adapter.reconfigure(lease, {
      providerId: "user-kimi-code",
      modelId: "kimi-for-coding",
    })
    expect(crossMode.mode).toBe("new-session")
  })

  it("selected 不在本机目录时启动期直接失败,不静默降级", async () => {
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    await expect(
      adapter.prepare(nativeRequest({ selected: { providerId: "native-kimi", modelId: "ghost-model" } })),
    ).rejects.toThrow(/不在本机目录中/)
  })

  it("目录内跨 native Provider 切换返回 live(spike 已证 CLI 原生实时生效)", async () => {
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    const lease = await adapter.prepare(nativeRequest())
    const cross = await adapter.reconfigure(lease, {
      providerId: "native-kimi/volcengine-agent-plan",
      modelId: "agent-plan/kimi-k3",
    })
    expect(cross).toEqual({
      mode: "live",
      selection: {
        providerId: "native-kimi/volcengine-agent-plan",
        modelId: "agent-plan/kimi-k3",
        harnessModelId: "agent-plan/kimi-k3",
      },
    })
  })

  it("同 Provider 切模型返回 live;跨 Provider / 未登记模型返回 new-session", async () => {
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    const lease = await adapter.prepare(nativeRequest())
    const sameProvider = await adapter.reconfigure(lease, {
      providerId: "native-kimi",
      modelId: "kimi-code/k3",
    })
    expect(sameProvider).toEqual({
      mode: "live",
      selection: { providerId: "native-kimi", modelId: "kimi-code/k3", harnessModelId: "kimi-code/k3" },
    })
    const crossProvider = await adapter.reconfigure(lease, {
      providerId: "native-kimi/volcengine-agent-plan",
      modelId: "agent-plan/kimi-k3",
    })
    expect(crossProvider.mode).toBe("live")
    const unknown = await adapter.reconfigure(lease, {
      providerId: "native-kimi",
      modelId: "never-discovered",
    })
    expect(unknown.mode).toBe("new-session")
  })

  it("拒绝 bento 模式请求", async () => {
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    await expect(
      adapter.prepare(nativeRequest({ mode: "bento", providers: [], selected: { providerId: "user-x", modelId: "m" } })),
    ).rejects.toThrow(/只处理 native 模式/)
  })
})

describe("SessionConfigRegistry", () => {
  it("按 (harnessId, mode) 注册;native 与 bento 对同一 harness 共存", () => {
    const registry = new SessionConfigRegistry()
    const native = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    const bento: SessionConfigAdapter = {
      harnessId: "kimi" as HarnessId,
      mode: "bento",
      prepare: async () => {
        throw new Error("stub")
      },
      reconfigure: async () => {
        throw new Error("stub")
      },
    }
    registry.register(native)
    registry.register(bento)
    expect(registry.get("kimi" as HarnessId, "native")).toBe(native)
    expect(registry.get("kimi" as HarnessId, "bento")).toBe(bento)
    expect(registry.has("kimi" as HarnessId, "native")).toBe(true)
    expect(registry.has("pi" as HarnessId, "native")).toBe(false)
  })

  it("同 (harnessId, mode) 重复注册报错;未注册组合取用报错", () => {
    const registry = new SessionConfigRegistry()
    registry.register(new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"]))
    expect(() => registry.register(new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])))
      .toThrow(/重复注册: kimi\/native/)
    expect(() => registry.get("kimi" as HarnessId, "bento")).toThrow(/没有 session-config adapter: kimi\/bento/)
    expect(() => registry.get("pi" as HarnessId, "native")).toThrow(/没有 session-config adapter: pi\/native/)
  })
})

describe("SessionConfigLease dispose 契约", () => {
  it("租约 dispose 可作为统一清理路径被 await", async () => {
    const adapter = new NativeConfigAdapter("kimi" as NativeConfigAdapter["harnessId"])
    const lease: SessionConfigLease = await adapter.prepare(nativeRequest())
    await expect(lease.dispose()).resolves.toBeUndefined()
  })
})
