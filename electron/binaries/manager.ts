import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

import { BINARY_MANIFEST, type ManagedBinaryName } from "./manifest"
import type { BinaryProgress } from "./progress"

export type { BinaryProgress } from "./progress"

const execFileAsync = promisify(execFile)

function currentPlatformKey() {
  return `${process.platform}-${process.arch}`
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest("hex")
}

export class BinaryManager {
  private installs = new Map<ManagedBinaryName, Promise<string>>()

  constructor(
    private readonly rootDir: string,
    private readonly platformKey = currentPlatformKey(),
    private readonly onProgress: (progress: BinaryProgress) => void = () => {},
  ) {}

  ensure(name: ManagedBinaryName): Promise<string> {
    const existing = this.installs.get(name)
    if (existing) return existing
    const install = this.resolveOrInstall(name).finally(() => this.installs.delete(name))
    this.installs.set(name, install)
    return install
  }

  async installed(name: ManagedBinaryName): Promise<string | null> {
    const manifest = BINARY_MANIFEST[name]
    const override = process.env[manifest.overrideEnv]
    if (override) {
      try {
        await fs.promises.access(override, fs.constants.X_OK)
        return override
      } catch {
        return null
      }
    }
    const artifact = manifest.platforms[this.platformKey]
    if (!artifact) return null
    const installDir = path.join(this.rootDir, name, manifest.version, this.platformKey)
    const executable = path.join(installDir, artifact.executable)
    const marker = path.join(installDir, "install.json")
    return await this.isInstalled(executable, marker, manifest.version, artifact.sha256)
      ? executable
      : null
  }

  private async resolveOrInstall(name: ManagedBinaryName) {
    const manifest = BINARY_MANIFEST[name]
    const override = process.env[manifest.overrideEnv]
    if (override) {
      await fs.promises.access(override, fs.constants.X_OK)
      return override
    }

    const artifact = manifest.platforms[this.platformKey]
    if (!artifact) throw new Error(`${name} 暂不支持平台 ${this.platformKey}`)
    const installDir = path.join(this.rootDir, name, manifest.version, this.platformKey)
    const executable = path.join(installDir, artifact.executable)
    const marker = path.join(installDir, "install.json")
    if (await this.isInstalled(executable, marker, manifest.version, artifact.sha256)) {
      return executable
    }

    this.onProgress({
      name,
      version: manifest.version,
      phase: "downloading",
      text: `正在下载 ${name} ${manifest.version}…`,
    })
    let tempDir: string | undefined
    try {
      await fs.promises.mkdir(this.rootDir, { recursive: true })
      tempDir = await fs.promises.mkdtemp(path.join(this.rootDir, `.${name}-`))
      const archive = path.join(
        tempDir,
        artifact.archive === "zip" ? "download.zip" : artifact.archive === "tar.gz" ? "download.tar.gz" : "download",
      )
      await this.download(artifact.url, archive, (received, total) => {
        this.onProgress({
          name,
          version: manifest.version,
          phase: "downloading",
          ...(total ? { fraction: received / total } : {}),
          text: total
            ? `正在下载 ${name} ${manifest.version} ${Math.round((received / total) * 100)}%`
            : `正在下载 ${name} ${manifest.version}…`,
        })
      })
      this.onProgress({
        name,
        version: manifest.version,
        phase: "verifying",
        text: `校验 ${name} ${manifest.version}…`,
      })
      const digest = await sha256File(archive)
      if (digest !== artifact.sha256) {
        throw new Error(`${name} 下载摘要不匹配: expected ${artifact.sha256}, got ${digest}`)
      }

      const extracted = path.join(tempDir, "extracted")
      let source = archive
      if (artifact.archive !== "binary") {
        await fs.promises.mkdir(extracted)
        if (artifact.archive === "zip") {
          await execFileAsync("unzip", ["-q", archive, "-d", extracted])
        } else {
          await execFileAsync("tar", ["-xzf", archive, "-C", extracted])
        }
        source = path.join(extracted, artifact.archiveEntry)
      }
      await fs.promises.access(source, fs.constants.R_OK)

      await fs.promises.mkdir(installDir, { recursive: true })
      await fs.promises.copyFile(source, executable)
      await fs.promises.chmod(executable, 0o755)
      await fs.promises.writeFile(
        marker,
        JSON.stringify({ version: manifest.version, archiveSha256: artifact.sha256 }, null, 2),
      )
      this.onProgress({
        name,
        version: manifest.version,
        phase: "done",
        text: `${name} ${manifest.version} 就绪`,
      })
      return executable
    } catch (error) {
      // 失败必须上报 error 相位:renderer 据此清掉进度行,否则残留的
      // 「下载 71%」会在下次创建会话时错误重现
      this.onProgress({
        name,
        version: manifest.version,
        phase: "error",
        text: `${name} ${manifest.version} 安装失败:${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    } finally {
      if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true })
    }
  }

  private async isInstalled(
    executable: string,
    marker: string,
    version: string,
    archiveSha256: string,
  ) {
    try {
      const state = JSON.parse(await fs.promises.readFile(marker, "utf8")) as {
        version?: string
        archiveSha256?: string
      }
      await fs.promises.access(executable, fs.constants.X_OK)
      return state.version === version && state.archiveSha256 === archiveSha256
    } catch {
      return false
    }
  }

  private async download(
    url: string,
    target: string,
    onBytes?: (received: number, total: number | undefined) => void,
  ) {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok || !response.body) {
      throw new Error(`下载失败 ${response.status}: ${url}`)
    }
    const total = Number(response.headers.get("content-length")) || undefined
    const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
    if (onBytes) {
      // 进度按 1MB 粒度合并上报,避免每个 chunk 都走一遍回调
      let received = 0
      let lastReported = 0
      body.on("data", (chunk: Buffer) => {
        received += chunk.length
        if (received - lastReported >= 1_048_576) {
          lastReported = received
          onBytes(received, total)
        }
      })
    }
    await pipeline(body, fs.createWriteStream(target, { flags: "wx" }))
  }
}

let manager: BinaryManager | undefined

export function configureBinaryManager(
  userDataDir: string,
  onProgress?: (progress: BinaryProgress) => void,
) {
  manager = new BinaryManager(path.join(userDataDir, "binaries"), undefined, onProgress)
}

export function managedBinary(name: ManagedBinaryName) {
  if (!manager) throw new Error("BinaryManager 尚未初始化")
  return manager.ensure(name)
}

export function managedBinaryIfInstalled(name: ManagedBinaryName) {
  if (!manager) throw new Error("BinaryManager 尚未初始化")
  return manager.installed(name)
}

export async function placeCodexCodeModeHost(codex: string, host: string): Promise<string> {
  const sibling = path.join(path.dirname(codex), "codex-code-mode-host")
  try {
    await fs.promises.access(sibling, fs.constants.X_OK)
  } catch {
    await fs.promises.copyFile(host, sibling)
    await fs.promises.chmod(sibling, 0o755)
  }
  return sibling
}

export async function managedCodexBinary(): Promise<string> {
  if (!manager) throw new Error("BinaryManager 尚未初始化")
  const codex = await manager.ensure("codex")
  // 显式覆盖视为用户维护的一整套 Codex 安装，不向其目录写 companion。
  if (process.env.BENTO_CODEX_PATH) return codex
  const host = await manager.ensure("codex-code-mode-host")
  await placeCodexCodeModeHost(codex, host)
  return codex
}

export async function managedUvxBinary(): Promise<string> {
  if (!manager) throw new Error("BinaryManager 尚未初始化")
  const [uvx, uv] = await Promise.all([manager.ensure("uvx"), manager.ensure("uv")])
  const sibling = path.join(path.dirname(uvx), "uv")
  try {
    await fs.promises.access(sibling, fs.constants.X_OK)
  } catch {
    await fs.promises.copyFile(uv, sibling)
    await fs.promises.chmod(sibling, 0o755)
  }
  return uvx
}
