/**
 * SessionConfigAdapter registry:按 harnessId 注册。SessionManager 只经
 * registry 取 Adapter,不感知具体 Harness 分支。
 */

import type { HarnessId } from "../../src/core/harness"
import type { SessionConfigAdapter } from "./types"

export class SessionConfigRegistry {
  private readonly adapters = new Map<string, SessionConfigAdapter>()

  register(adapter: SessionConfigAdapter): void {
    if (this.adapters.has(adapter.harnessId)) {
      throw new Error(`session-config adapter 重复注册: ${adapter.harnessId}`)
    }
    this.adapters.set(adapter.harnessId, adapter)
  }

  get(harnessId: HarnessId): SessionConfigAdapter {
    const adapter = this.adapters.get(harnessId)
    if (!adapter) throw new Error(`没有 session-config adapter: ${harnessId}`)
    return adapter
  }

  has(harnessId: HarnessId): boolean {
    return this.adapters.has(harnessId)
  }
}
