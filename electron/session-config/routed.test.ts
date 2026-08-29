import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import type { CustomProviderConfig } from "../../src/core/provider"
import { CustomProviderStore, type SecretStore } from "../custom-providers"
import { ProviderRoutingService } from "../provider-routing"
import { RoutedBentoConfigAdapter } from "./routed"

const dirs: string[] = []
const servers: http.Server[] = []
const routings: ProviderRoutingService[] = []

afterEach(() => {
  for (const routing of routings.splice(0)) routing.dispose()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function secrets(): SecretStore {
  const values = new Map<string, string>()
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  }
}

async function upstream(hits: string[], label: string): Promise<string> {
  const server = http.createServer((req, res) => {
    hits.push(`${label}:${req.url}:${req.headers.authorization}`)
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("RoutedBentoConfigAdapter", () => {
  it("Codex 复用稳定 loopback URL live 切换 provider，并按会话清理 home", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-routed-"))
    dirs.push(dir)
    const hits: string[] = []
    const baseA = await upstream(hits, "A")
    const baseB = await upstream(hits, "B")
    const store = new CustomProviderStore(dir, secrets())
    const config = (id: string, baseUrl: string): CustomProviderConfig => ({
      id,
      name: id,
      auth: { method: "apiKey" },
      runtimes: {
        codex: {
          baseUrl,
          wireProtocol: "openai-responses",
          models: [{ id: `${id}-model`, name: `${id} model` }],
        },
      },
    })
    store.upsert(config("user-a", baseA), { "*": "key-a" })
    store.upsert(config("user-b", baseB), { "*": "key-b" })
    const routing = new ProviderRoutingService(dir, () => store)
    routings.push(routing)
    const adapter = new RoutedBentoConfigAdapter("codex", routing, dir)
    const providers = store.list().map((item) => ({
      providerId: item.id,
      name: item.name,
      baseUrl: item.runtimes.codex!.baseUrl,
      wireProtocol: item.runtimes.codex!.wireProtocol,
      models: item.runtimes.codex!.models.map((model) => ({
        id: model.id, name: model.name, reasoning: false,
      })),
    }))
    const lease = await adapter.prepare({
      sessionKey: "s1",
      harnessId: "codex",
      cwd: dir,
      mode: "bento",
      selected: { providerId: "user-a", modelId: "user-a-model" },
      providers,
    })
    const configToml = fs.readFileSync(path.join(lease.configDir!, "config.toml"), "utf8")
    const proxyBase = configToml.match(/base_url = "([^"]+)"/)![1]!

    await fetch(`${proxyBase}/responses`, { method: "POST", body: "{}" })
    expect(hits.at(-1)).toContain("A:")
    expect(hits.at(-1)).toContain("Bearer key-a")

    const switched = await adapter.reconfigure(lease, {
      providerId: "user-b", modelId: "user-b-model",
    })
    expect(switched).toMatchObject({ mode: "live" })
    await fetch(`${proxyBase}/responses`, { method: "POST", body: "{}" })
    expect(hits.at(-1)).toContain("B:")
    expect(hits.at(-1)).toContain("Bearer key-b")

    await lease.dispose()
    expect(fs.existsSync(lease.configDir!)).toBe(true)
    await adapter.removeSessionState("s1")
    expect(fs.existsSync(lease.configDir!)).toBe(false)
  })
})
