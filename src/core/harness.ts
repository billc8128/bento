/**
 * Harness 适配层(L1)。
 *
 * renderer 侧的产品目录。真实协议能力由 main 侧 HarnessDriver 决定;
 * 这里声明创建会话前即可确定的选择能力,用于避免展示不会生效的控件。
 * 本目录不允许 import 任何 UI。
 */

import type { Effort } from "./types"

export type HarnessId = "claude-code" | "kimi" | "codex" | "opencode" | "pi" | "omp" | "hermes" | "trae"
export const DEFAULT_HARNESS_ID: HarnessId = "pi"

export type Harness = {
  id: HarnessId
  name: string
  /** 侧栏与输入框里用作角标的短代号 */
  short: string
  /** Harness 只描述执行引擎；供应商、模型与鉴权属于 Provider 目录。 */
  effortSelection: boolean
  /** 当前 Harness 在协议层真实接受的推理档位。 */
  efforts: Effort[]
  defaultEffort: Effort
  /** 是否已有可启动的 driver */
  live: boolean
  /** 权限档位切换能力:创建会话前即可确定(driver 侧硬编码),用于门控权限控件 */
  permissionSwitch: "none" | "live"
}

export type HarnessRuntimeStatus = {
  harnessId: HarnessId
  /** 首选执行来源(override → managed/bundled 解析优先级);非"实际执行"。 */
  source: "override" | "local" | "managed" | "bundled" | "missing"
  command?: string
  version?: string
  usable: boolean
  /** managed/bundled 解析抛错时是否可退 PATH 本机二进制。 */
  fallbackAvailable: boolean
  /** 附注:检测到本机 PATH 安装但未使用(仅信息展示)。 */
  localInstall?: { path: string; version?: string }
}

/** 选择器里的规范排序(pi 在最前,是开箱即用的默认) */
export const HARNESS_ORDER: HarnessId[] = ["pi", "codex", "claude-code", "kimi", "opencode", "omp", "hermes", "trae"]

export const HARNESSES: Harness[] = [
  {
    id: "codex",
    permissionSwitch: "live",
    name: "Codex",
    short: "CDX",
    live: true,
    effortSelection: true,
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
  },
  {
    id: "claude-code",
    permissionSwitch: "live",
    name: "Claude Code",
    short: "CC",
    live: true,
    effortSelection: false,
    efforts: [],
    defaultEffort: "medium",
  },
  {
    id: "kimi",
    permissionSwitch: "live",
    name: "Kimi Code",
    short: "KM",
    live: true,
    effortSelection: false,
    efforts: [],
    defaultEffort: "medium",
  },
  {
    id: "opencode",
    permissionSwitch: "live",
    name: "OpenCode",
    short: "OC",
    live: true,
    effortSelection: false,
    efforts: [],
    defaultEffort: "medium",
  },
  {
    id: "pi",
    permissionSwitch: "none",
    name: "Pi",
    short: "π",
    live: true,
    effortSelection: true,
    efforts: ["off", "low", "medium", "high", "max"],
    defaultEffort: "medium",
  },
  {
    id: "omp",
    permissionSwitch: "live",
    name: "OMP",
    short: "OMP",
    live: true,
    effortSelection: true,
    efforts: ["off", "auto", "low", "high", "max"],
    defaultEffort: "auto",
  },
  {
    id: "hermes",
    permissionSwitch: "live",
    name: "Hermes",
    short: "H",
    live: true,
    effortSelection: false,
    efforts: [],
    defaultEffort: "medium",
  },
  {
    id: "trae",
    permissionSwitch: "live",
    name: "Trae Code",
    short: "TR",
    live: true,
    effortSelection: false,
    efforts: [],
    defaultEffort: "medium",
  },
]

export function getHarness(id: HarnessId | string): Harness {
  const harness = HARNESSES.find((item) => item.id === id)
  if (harness) return harness
  // v0.3 旧会话兼容：GLM Coding Plan 实际是 Claude Code 的 provider 路由。
  if (id === "glm") {
    return { ...HARNESSES.find((item) => item.id === "claude-code")!, name: "Claude Code · GLM" }
  }
  return HARNESSES[0]
}
