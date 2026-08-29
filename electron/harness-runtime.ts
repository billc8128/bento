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

export function localHarnessExecutable(harnessId: HarnessId): {
  path: string
  source: "override" | "local"
} | null {
  const definition = DEFINITIONS[harnessId]
  const override = process.env[definition.overrideEnv]
  if (override) {
    try {
      fs.accessSync(override, fs.constants.X_OK)
      return { path: override, source: "override" }
    } catch {
      // 无效覆盖不应遮住用户 PATH 中仍可用的 CLI。
    }
  }
  const executable = executableOnPath(definition.command)
  return executable ? { path: executable, source: "local" } : null
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
