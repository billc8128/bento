/**
 * Harness 运行时更新服务(main 侧):上游检查 + 手动更新编排。
 * - 检查:app ready + 每 24h;失败静默;结果落盘(重启后提示状态不丢)
 * - 更新:仅托管 harness;codex 与 code-mode-host 成组;hermes 无本地二进制,
 *   更新 = 换 pin(uvx 下次会话自拉新版)
 * - 下载只允许 baked manifest 已钉的官方域名;sha 优先取上游官方摘要
 *   (GitHub digest / trae CDN manifest),缺失则下载后自算(TOFU,见 manager)
 */

import { BINARY_MANIFEST, type BinaryArtifact } from "../binaries/manifest"
import { installBinaryUpdate } from "../binaries/manager"
import {
  compareBinaryVersions,
  readHarnessUpdates,
  setHarnessUpdatesDir,
  writeHarnessUpdates,
} from "../binaries/updates-store"
import { HERMES_AGENT_VERSION } from "./harness-runtime"
import type {
  HarnessUpdateState,
  HarnessUpdateStatus,
  UpdatableHarnessId,
} from "../../src/core/harness-updates"

export type { HarnessUpdateState, HarnessUpdateStatus } from "../../src/core/harness-updates"
export type { UpdatableHarnessId } from "../binaries/updates-store"

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
export const UPDATABLE: UpdatableHarnessId[] = ["codex", "kimi", "opencode", "omp", "trae", "hermes"]

/** 下载域白名单:从 baked manifest 已钉的官方 URL 域推导。 */
const ALLOWED_DOWNLOAD_HOSTS = new Set(
  Object.values(BINARY_MANIFEST)
    .flatMap((entry) => Object.values(entry.platforms))
    .filter((artifact): artifact is BinaryArtifact => Boolean(artifact))
    .map((artifact) => new URL(artifact.url).hostname),
)

type UpdatableBinary = Exclude<UpdatableHarnessId | "codex-code-mode-host", "hermes">
type UpstreamArtifact = { binary: UpdatableBinary; url: string; sha256?: string }
type UpstreamRelease = { version: string; artifacts: UpstreamArtifact[] }

type GithubAssetWant = { binary: UpdatableBinary; name?: string; pattern?: RegExp }

/** GitHub releases/latest:tag 剥前缀取版本;资产按精确名或模式匹配;
 * sha 优先取 digest 字段("sha256:<hex>"),缺失留空(TOFU)。 */
async function fetchGithubLatest(
  repo: string,
  wants: GithubAssetWant[],
  fetchImpl: typeof fetch,
): Promise<UpstreamRelease | null> {
  let response: Response
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  const payload = await response.json().catch(() => null) as {
    tag_name?: string
    assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>
  } | null
  if (typeof payload?.tag_name !== "string") return null
  const version = payload.tag_name.replace(/^(rust-)?v/i, "")
  const artifacts: UpstreamArtifact[] = []
  for (const want of wants) {
    const asset = payload.assets?.find((item) =>
      want.name ? item.name === want.name : Boolean(item.name && want.pattern?.test(item.name)),
    )
    if (!asset?.browser_download_url) return null
    const sha256 = typeof asset.digest === "string" && asset.digest.startsWith("sha256:")
      ? asset.digest.slice("sha256:".length)
      : undefined
    artifacts.push({ binary: want.binary, url: asset.browser_download_url, ...(sha256 ? { sha256 } : {}) })
  }
  return { version, artifacts }
}

/** trae ToB CDN:官方 install 脚本同款顺序 latest.json → fallback.json。 */
async function fetchTraeLatest(fetchImpl: typeof fetch): Promise<UpstreamRelease | null> {
  for (const suffix of ["v2/latest.json", "v2/fallback.json"]) {
    try {
      const response = await fetchImpl(`https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/${suffix}`)
      if (!response.ok) continue
      const payload = await response.json().catch(() => null) as {
        version?: string
        artifacts?: Array<{ platform?: string; url?: string; sha256?: string }>
      } | null
      const artifact = payload?.artifacts?.find((item) => item.platform === "macos-aarch64")
      if (typeof payload?.version === "string" && artifact?.url && typeof artifact.sha256 === "string") {
        return { version: payload.version, artifacts: [{ binary: "trae", url: artifact.url, sha256: artifact.sha256 }] }
      }
    } catch {
      // 试 fallback
    }
  }
  return null
}

/** hermes:PyPI JSON API(uvx 拉 PyPI,pin 在 acp 驱动)。 */
async function fetchPypiLatest(packageName: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`https://pypi.org/pypi/${packageName}/json`)
    if (!response.ok) return null
    const payload = await response.json().catch(() => null) as { info?: { version?: string } } | null
    return typeof payload?.info?.version === "string" ? payload.info.version : null
  } catch {
    return null
  }
}

export class HarnessUpdatesService {
  private readonly runtime = new Map<UpdatableHarnessId, { state: "downloading" | "updated" | "failed"; percent?: number }>()
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<void> | null = null

  constructor(
    private readonly userDataDir: string,
    private readonly onChanged: () => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // 显示层(preferredRuntimeVersion)与 acp 的 hermes pin 都从这读更新记录
    setHarnessUpdatesDir(userDataDir)
  }

  status(): HarnessUpdateStatus[] {
    const state = readHarnessUpdates(this.userDataDir)
    return UPDATABLE.map((harnessId) => {
      const current = this.currentVersion(harnessId, state)
      const latest = state.latest[harnessId]
      const live = this.runtime.get(harnessId)
      const newer = latest !== undefined && compareBinaryVersions(latest, current) > 0
      let phase: HarnessUpdateState = "current"
      if (live?.state === "downloading" || live?.state === "failed") phase = live.state
      else if (newer) phase = "available"
      else if (live?.state === "updated") phase = "updated"
      return {
        harnessId,
        current,
        ...(latest !== undefined ? { latest } : {}),
        state: phase,
        ...(live?.percent !== undefined ? { percent: live.percent } : {}),
      }
    })
  }

  /** 手动/定时检查:单飞;单个上游失败只保留旧 latest(静默)。 */
  check(): Promise<void> {
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** 手动更新:下载安装(或 hermes 换 pin)→ 记录 installs → updated/failed。 */
  async update(harnessId: UpdatableHarnessId): Promise<void> {
    if (this.runtime.get(harnessId)?.state === "downloading") return
    const found = await this.fetchLatest(harnessId)
    if (!found) {
      this.runtime.set(harnessId, { state: "failed" })
      this.onChanged()
      return
    }
    const state = readHarnessUpdates(this.userDataDir)
    if (compareBinaryVersions(found.version, this.currentVersion(harnessId, state)) <= 0) {
      this.onChanged()
      return
    }
    this.runtime.set(harnessId, { state: "downloading", percent: 0 })
    this.onChanged()
    try {
      for (const artifact of found.artifacts) {
        // 只允许 baked manifest 已钉的官方域名
        if (!ALLOWED_DOWNLOAD_HOSTS.has(new URL(artifact.url).hostname)) {
          throw new Error(`非白名单下载域: ${artifact.url}`)
        }
        const baked = BINARY_MANIFEST[artifact.binary].platforms["darwin-arm64"]
        if (!baked) throw new Error(`${artifact.binary} 无 darwin-arm64 产物定义`)
        await installBinaryUpdate(artifact.binary, {
          version: found.version,
          artifact: { ...baked, url: artifact.url, sha256: artifact.sha256 ?? "" },
        }, (fraction) => {
          this.runtime.set(harnessId, { state: "downloading", percent: Math.round(fraction * 100) })
          this.onChanged()
        })
      }
      const next = readHarnessUpdates(this.userDataDir)
      if (harnessId === "hermes") {
        next.installs.hermes = { version: found.version }
      } else {
        for (const artifact of found.artifacts) {
          next.installs[artifact.binary] = {
            version: found.version,
            url: artifact.url,
            ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
          }
        }
      }
      writeHarnessUpdates(this.userDataDir, next)
      this.runtime.set(harnessId, { state: "updated" })
      this.onChanged()
    } catch {
      this.runtime.set(harnessId, { state: "failed" })
      this.onChanged()
    }
  }

  /** app ready + 每 24h;到点即查(上次检查超 24h),失败静默。 */
  schedule(): void {
    const due = (() => {
      const { checkedAt } = readHarnessUpdates(this.userDataDir)
      return !checkedAt || Number.isNaN(Date.parse(checkedAt)) ||
        Date.now() - Date.parse(checkedAt) > CHECK_INTERVAL_MS
    })()
    if (due) void this.check().catch(() => {})
    this.timer = setInterval(() => void this.check().catch(() => {}), CHECK_INTERVAL_MS)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async runCheck(): Promise<void> {
    const state = readHarnessUpdates(this.userDataDir)
    const latest = { ...state.latest }
    await Promise.all(UPDATABLE.map(async (harnessId) => {
      const found = await this.fetchLatest(harnessId)
      if (found) latest[harnessId] = found.version
    }))
    writeHarnessUpdates(this.userDataDir, { ...state, latest, checkedAt: new Date().toISOString() })
    this.onChanged()
  }

  private async fetchLatest(harnessId: UpdatableHarnessId): Promise<UpstreamRelease | null> {
    switch (harnessId) {
      case "codex":
        return fetchGithubLatest("openai/codex", [
          { binary: "codex", name: "codex-aarch64-apple-darwin.tar.gz" },
          { binary: "codex-code-mode-host", name: "codex-code-mode-host-aarch64-apple-darwin.tar.gz" },
        ], this.fetchImpl)
      case "kimi":
        return fetchGithubLatest("MoonshotAI/kimi-cli", [
          { binary: "kimi", pattern: /^kimi-.*-aarch64-apple-darwin-onedir\.tar\.gz$/ },
        ], this.fetchImpl)
      case "opencode":
        return fetchGithubLatest("anomalyco/opencode", [
          { binary: "opencode", name: "opencode-darwin-arm64.zip" },
        ], this.fetchImpl)
      case "omp":
        return fetchGithubLatest("can1357/oh-my-pi", [
          { binary: "omp", name: "omp-darwin-arm64" },
        ], this.fetchImpl)
      case "trae":
        return fetchTraeLatest(this.fetchImpl)
      case "hermes": {
        const version = await fetchPypiLatest("hermes-agent", this.fetchImpl)
        return version ? { version, artifacts: [] } : null
      }
    }
  }

  private currentVersion(harnessId: UpdatableHarnessId, state: ReturnType<typeof readHarnessUpdates>): string {
    if (harnessId === "hermes") return state.installs.hermes?.version ?? HERMES_AGENT_VERSION
    return state.installs[harnessId]?.version ?? BINARY_MANIFEST[harnessId].version
  }
}

export { fetchGithubLatest, fetchPypiLatest, fetchTraeLatest }
