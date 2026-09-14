/** Harness 运行时更新的共享类型(main/renderer 两端,零依赖)。 */

/** 可更新的托管 harness(claude-code/pi 随 Bento 发版,不在此列)。 */
export type UpdatableHarnessId = "codex" | "kimi" | "opencode" | "omp" | "trae" | "hermes"

export type HarnessUpdateState = "current" | "available" | "downloading" | "updated" | "failed"

export type HarnessUpdateStatus = {
  harnessId: UpdatableHarnessId
  current: string
  latest?: string
  state: HarnessUpdateState
  percent?: number
}
