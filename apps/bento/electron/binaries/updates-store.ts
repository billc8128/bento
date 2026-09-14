/**
 * Harness 运行时更新存储(main 侧叶子模块):userData/providers/harness-updates.json。
 * baked BINARY_MANIFEST 是底线;这里只记用户已手动更新到的版本与最近检查结果,
 * 运行时解析顺序:已更新版本 > baked pin。原子写(tmp+rename,同 custom-providers.ts)。
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { BINARY_MANIFEST, type BinaryArtifact, type ManagedBinaryName } from "./manifest"
import type { UpdatableHarnessId } from "../../src/core/harness-updates"

export type { UpdatableHarnessId } from "../../src/core/harness-updates"

/** 已安装的更新:hermes 只有 version(uvx pin);二进制型带产物坐标。 */
export type HarnessUpdateInstall = {
  version: string
  url?: string
  sha256?: string
}

type InstallKey = UpdatableHarnessId | "codex-code-mode-host"

export type HarnessUpdatesState = {
  installs: Partial<Record<InstallKey, HarnessUpdateInstall>>
  /** 最近一次成功检查到的上游最新版(重启后提示状态不丢)。 */
  latest: Partial<Record<UpdatableHarnessId, string>>
  checkedAt?: string
}

const EMPTY: HarnessUpdatesState = { installs: {}, latest: {} }

export function harnessUpdatesFile(userDataDir: string): string {
  return path.join(userDataDir, "providers", "harness-updates.json")
}

export function readHarnessUpdates(userDataDir: string): HarnessUpdatesState {
  try {
    const parsed = JSON.parse(fs.readFileSync(harnessUpdatesFile(userDataDir), "utf8")) as Partial<HarnessUpdatesState>
    if (!parsed || typeof parsed !== "object") return EMPTY
    return {
      installs: parsed.installs ?? {},
      latest: parsed.latest ?? {},
      ...(typeof parsed.checkedAt === "string" ? { checkedAt: parsed.checkedAt } : {}),
    }
  } catch {
    return EMPTY
  }
}

export function writeHarnessUpdates(userDataDir: string, state: HarnessUpdatesState): void {
  const file = harnessUpdatesFile(userDataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

/** main 启动时注入 userData;未注入(测试/纯逻辑)时更新记录视为不存在。 */
let activeDir: string | null = null
export function setHarnessUpdatesDir(userDataDir: string): void {
  activeDir = userDataDir
}

/** 用户已更新安装的版本(不含 baked 兜底,调用方自行组合)。 */
export function installedUpdateVersion(id: InstallKey): string | undefined {
  return activeDir ? readHarnessUpdates(activeDir).installs[id]?.version : undefined
}

/**
 * 版本比较:剥 tag 前缀(rust-v/v)与 -tob 后缀后按数字元组比较;
 * 相等不算更新。显示层保留原始字符串(含 -tob)。
 */
export function compareBinaryVersions(a: string, b: string): number {
  const tuple = (value: string): number[] => {
    const stripped = value.trim().replace(/^(rust-)?v/i, "").replace(/-tob$/, "")
    const parts = stripped.split(/[.-]/).map((part) => Number(part))
    return parts.every((part) => Number.isFinite(part)) ? parts : []
  }
  const left = tuple(a)
  const right = tuple(b)
  if (left.length === 0 || right.length === 0) return a === b ? 0 : a.localeCompare(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** 有效二进制条目:已更新版本(且确实更新)优先,否则 baked pin。 */
export function effectiveBinaryEntry(
  userDataDir: string,
  name: ManagedBinaryName,
  platformKey = `${process.platform}-${process.arch}`,
): { version: string; artifact: BinaryArtifact } | null {
  const baked = BINARY_MANIFEST[name]
  const artifact = baked.platforms[platformKey]
  if (!artifact) return null
  const install = readHarnessUpdates(userDataDir).installs[name as InstallKey]
  // sha256 可缺(TOFU:上游未提供摘要时下载后自算,见 manager 的校验分支)
  if (install?.version && install.url && compareBinaryVersions(install.version, baked.version) > 0) {
    return { version: install.version, artifact: { ...artifact, url: install.url, sha256: install.sha256 ?? "" } }
  }
  return { version: baked.version, artifact }
}
