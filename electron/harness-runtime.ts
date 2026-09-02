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
  codex: { command: "codex", overrideEnv: "BENTO_CODEX_PATH", fallback: "managed" },
  "claude-code": { command: "claude", overrideEnv: "BENTO_CLAUDE_CODE_PATH", fallback: "bundled" },
  kimi: { command: "kimi", overrideEnv: "BENTO_KIMI_PATH", fallback: "managed" },
  opencode: { command: "opencode", overrideEnv: "BENTO_OPENCODE_PATH", fallback: "managed" },
  omp: { command: "omp", overrideEnv: "BENTO_OMP_PATH", fallback: "managed" },
  pi: { command: "pi", overrideEnv: "BENTO_PI_PATH", fallback: "bundled" },
  hermes: { command: "hermes", overrideEnv: "BENTO_HERMES_PATH", fallback: "managed" },
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
 * 显式覆盖始终最高；native 偏好本机 CLI，Bento 偏好固定 managed/bundled。
 * 首选 managed 安装失败时才退回 PATH，避免 Bento 会话被本机版本漂移影响。
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
    if (local) return fromExecutable(local.path)
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

export async function harnessRuntimeStatus(harnessId: HarnessId): Promise<HarnessRuntimeStatus> {
  const local = localHarnessExecutable(harnessId)
  if (local) {
    return {
      harnessId,
      source: local.source,
      command: local.path,
      version: await executableVersion(local.path),
      usable: true,
      fallbackAvailable: DEFINITIONS[harnessId].fallback !== "missing",
    }
  }
  const fallback = DEFINITIONS[harnessId].fallback
  return {
    harnessId,
    source: fallback,
    usable: fallback !== "missing",
    fallbackAvailable: fallback !== "missing",
  }
}

export function listHarnessRuntimeStatuses(): Promise<HarnessRuntimeStatus[]> {
  return Promise.all((Object.keys(DEFINITIONS) as HarnessId[]).map(harnessRuntimeStatus))
}
