import fs from "node:fs"
import path from "node:path"

import type { ProviderRoutingService } from "../provider-routing"
import type {
  BentoModelSelection,
  PreparedModelRef,
  ReconfigureResult,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./types"
import { selectionKey } from "./types"

type RoutedHarnessId = "claude-code" | "codex"

/** Claude Code / Codex 继续用单个稳定 loopback URL，切供应商只原子换路由。 */
export class RoutedBentoConfigAdapter implements SessionConfigAdapter {

  constructor(
    readonly harnessId: RoutedHarnessId,
    private readonly routing: ProviderRoutingService,
    private readonly userDataDir: string,
  ) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    const selections = new Map<string, PreparedModelRef>()
    for (const provider of request.providers) {
      for (const model of provider.models) {
        const ref = {
          providerId: provider.providerId,
          modelId: model.id,
          harnessModelId: model.id,
        }
        selections.set(selectionKey(ref.providerId, ref.modelId), ref)
      }
    }
    const selected = selections.get(selectionKey(request.selected.providerId, request.selected.modelId))
    if (!selected) throw new Error("所选模型不在当前 Bento 注册表中")

    const route = await this.routing.issueRoute(request.sessionKey, selected.providerId, this.harnessId)
    let env: Record<string, string>
    let strip: string[] = []
    let configDir: string
    if (this.harnessId === "claude-code") {
      configDir = path.join(this.userDataDir, "providers", `claude-code-bento-${request.sessionKey}`)
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
      const isolated = this.routing.claudeCodeEnv(route)
      env = { ...isolated.env, CLAUDE_CONFIG_DIR: configDir }
      strip = isolated.strip
    } else {
      env = this.routing.codexHomeEnv(request.sessionKey, route, selected.providerId).env
      configDir = env.CODEX_HOME!
    }

    const sessionKey = request.sessionKey
    const routing = this.routing
    let disposed = false
    return {
      sessionKey,
      harnessId: this.harnessId,
      env,
      strip,
      configDir,
      selections,
      selected,
      revision: 1,
      async dispose() {
        if (disposed) return
        disposed = true
        routing.revokeRoute(sessionKey)
      },
    }
  }

  async reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult> {
    const selection = lease.selections.get(selectionKey(next.providerId, next.modelId))
    if (!selection) {
      return {
        mode: "new-session",
        reason: "该模型不在当前 Bento 注册表中，需要新会话",
      }
    }
    await this.routing.switchRoute(lease.sessionKey, selection.providerId, this.harnessId)
    return { mode: "live", selection }
  }

  async removeSessionState(sessionKey: string): Promise<void> {
    if (this.harnessId === "codex") {
      this.routing.disposeCodexHome(sessionKey)
      return
    }
    await fs.promises.rm(
      path.join(this.userDataDir, "providers", `claude-code-bento-${sessionKey}`),
      { recursive: true, force: true },
    )
  }
}
