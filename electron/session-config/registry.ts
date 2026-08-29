/**
 * SessionConfigAdapter registry:按 (harnessId, mode) 注册,native 与 bento
 * Adapter 对同一 Harness 共存。SessionManager 只经 registry 取 Adapter,
 * 不感知具体 Harness 分支。
 */

import type { HarnessId } from "../../src/core/harness"
import type { SessionConfigAdapter, SessionConfigMode } from "./types"

export class SessionConfigRegistry {
  private readonly adapters = new Map<string, SessionConfigAdapter>()

  register(adapter: SessionConfigAdapter): void {
    const key = `${adapter.harnessId}\0${adapter.mode}`
    if (this.adapters.has(key)) {
      throw new Error(`session-config adapter 重复注册: ${adapter.harnessId}/${adapter.mode}`)
    }
    this.adapters.set(key, adapter)
  }

  get(harnessId: HarnessId, mode: SessionConfigMode): SessionConfigAdapter {
    const adapter = this.adapters.get(`${harnessId}\0${mode}`)
    if (!adapter) throw new Error(`没有 session-config adapter: ${harnessId}/${mode}`)
    return adapter
  }

  has(harnessId: HarnessId, mode: SessionConfigMode): boolean {
    return this.adapters.has(`${harnessId}\0${mode}`)
  }
}
