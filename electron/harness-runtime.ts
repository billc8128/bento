import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import type { HarnessId, HarnessRuntimeStatus } from "../src/core/harness"

const execFileAsync = promisify(execFile)

type RuntimeDefinition = {
  command: string
  overrideEnv: string
  fallback: "managed" | "bundled" | "missing"
  /**
   * managed/bundled 解析器抛错时是否可退回 PATH 本机二进制。
   * codex/kimi/opencode/omp(托管下载)与 pi/hermes(bundled/uvx 解析抛错)可退;
   * claude-code 的 managed 分支返回空不抛错(SDK 内部再用嵌入 CLI),无 PATH 回退。
   */
  pathFallback: boolean
}

export type HarnessRuntimePreference = "local" | "managed"

export function assertHarnessCwd(cwd: string): void {
  try {
    if (fs.statSync(cwd).isDirectory()) return
  } catch {
    // 统一在下方给出面向用户的错误。
  }
  throw new Error(`项目目录不存在或不可访问: ${cwd}`)
}

const DEFINITIONS: Record<HarnessId, RuntimeDefinition> = {
  codex: { command: "codex", overrideEnv: "BENTO_CODEX_PATH", fallback: "managed", pathFallback: true },
  "claude-code": { command: "claude", overrideEnv: "BENTO_CLAUDE_CODE_PATH", fallback: "bundled", pathFallback: false },
  kimi: { command: "kimi", overrideEnv: "BENTO_KIMI_PATH", fallback: "managed", pathFallback: true },
  opencode: { command: "opencode", overrideEnv: "BENTO_OPENCODE_PATH", fallback: "managed", pathFallback: true },
  omp: { command: "omp", overrideEnv: "BENTO_OMP_PATH", fallback: "managed", pathFallback: true },
  pi: { command: "pi", overrideEnv: "BENTO_PI_PATH", fallback: "bundled", pathFallback: true },
  hermes: { command: "hermes", overrideEnv: "BENTO_HERMES_PATH", fallback: "managed", pathFallback: true },
}

function executableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.resolve(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // keep searching
    }
  }
  return null
}

export function overrideHarnessExecutable(harnessId: HarnessId): {
  path: string
  source: "override"
} | null {
  const override = process.env[DEFINITIONS[harnessId].overrideEnv]
  if (!override) return null
  try {
    fs.accessSync(override, fs.constants.X_OK)
    return { path: override, source: "override" }
  } catch {
    return null
  }
}

export function pathHarnessExecutable(harnessId: HarnessId): {
  path: string
  source: "local"
} | null {
  const executable = executableOnPath(DEFINITIONS[harnessId].command)
  return executable ? { path: executable, source: "local" } : null
}

export function localHarnessExecutable(harnessId: HarnessId): {
  path: string
  source: "override" | "local"
} | null {
  return overrideHarnessExecutable(harnessId) ?? pathHarnessExecutable(harnessId)
}

/**
 * 显式覆盖始终最高；其余一律 managed/bundled 优先。
 * 声明了 pathFallback 的 harness 在 managed 解析抛错时才退回 PATH(见 DEFINITIONS)。
 */
export async function resolveHarnessRuntime<T>(
  harnessId: HarnessId,
  preference: HarnessRuntimePreference,
  fromExecutable: (path: string) => T,
  managed: () => Promise<T>,
): Promise<T> {
  const override = overrideHarnessExecutable(harnessId)
  if (override) return fromExecutable(override.path)
  const local = pathHarnessExecutable(harnessId)
  if (preference === "local" && local) return fromExecutable(local.path)
  try {
    return await managed()
  } catch (error) {
    // PATH 兜底只在声明了 pathFallback 的 harness 生效(claude-code 无回退)。
    if (local && DEFINITIONS[harnessId].pathFallback) return fromExecutable(local.path)
    throw error
  }
}

async function executableVersion(executable: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      // 全量测试的 fork 风暴下,新脚本首次 exec 可能超过 1.5s 被误杀
      // (killed: SIGTERM → version undefined);放宽到 5s,同样惠及
      // 冷启动慢的 node CLI。
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })
    return `${stdout}${stderr}`.trim().split(/\r?\n/, 1)[0] || undefined
  } catch {
    return undefined
  }
}

/**
 * 上报**首选执行来源**(override → managed/bundled 的解析优先级),不是"实际执行":
 * managed 后续解析失败仍可能退 PATH。PATH 本机安装只是 localInstall 附注,
 * 会话不使用它(除 managed 解析抛错时的应急兜底,见 DEFINITIONS.pathFallback)。
 */
export async function harnessRuntimeStatus(harnessId: HarnessId): Promise<HarnessRuntimeStatus> {
  const definition = DEFINITIONS[harnessId]
  const override = overrideHarnessExecutable(harnessId)
  if (override) {
    return {
      harnessId,
      source: "override",
      command: override.path,
      version: await executableVersion(override.path),
      usable: true,
      fallbackAvailable: definition.pathFallback && pathHarnessExecutable(harnessId) !== null,
    }
  }
  const local = pathHarnessExecutable(harnessId)
  return {
    harnessId,
    source: definition.fallback,
    usable: definition.fallback !== "missing",
    fallbackAvailable: definition.pathFallback && local !== null,
    ...(local ? { localInstall: { path: local.path, version: await executableVersion(local.path) } } : {}),
  }
}

export function listHarnessRuntimeStatuses(): Promise<HarnessRuntimeStatus[]> {
  return Promise.all((Object.keys(DEFINITIONS) as HarnessId[]).map(harnessRuntimeStatus))
}
