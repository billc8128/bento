import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import zlib from "node:zlib"

import { BINARY_MANIFEST, type BinaryArtifact, type ManagedBinaryName } from "./manifest"
import { effectiveBinaryEntry } from "./updates-store"
import type { BinaryProgress } from "./progress"

export type { BinaryProgress } from "./progress"

/** 更新流程安装指定(非 baked)条目的入参形状。 */
export type BinaryEntry = { version: string; artifact: BinaryArtifact }

type EnsureOptions = {
  entry?: BinaryEntry
  /** 更新流程的行内进度回调(独立于全局 binary:progress 通道)。 */
  onProgress?: (fraction: number) => void
  /** true = 不走全局 binary:progress(更新下载有自己的行内 UI)。 */
  silent?: boolean
}

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

  /** rootDir 约定是 userData/binaries;更新记录存在 userData/providers 下。 */
  private get userDataDir(): string {
    return path.dirname(this.rootDir)
  }

  ensure(name: ManagedBinaryName, opts: EnsureOptions = {}): Promise<string> {
    const existing = this.installs.get(name)
    if (existing) return existing
    const install = this.resolveOrInstall(name, opts).finally(() => this.installs.delete(name))
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
    const entry = effectiveBinaryEntry(this.userDataDir, name, this.platformKey)
    if (!entry) return null
    const installDir = path.join(this.rootDir, name, entry.version, this.platformKey)
    const executable = path.join(installDir, entry.artifact.executable)
    const marker = path.join(installDir, "install.json")
    return await this.isInstalled(executable, marker, entry.version, entry.artifact.sha256)
      ? executable
      : null
  }

  private async resolveOrInstall(name: ManagedBinaryName, opts: EnsureOptions) {
    const manifest = BINARY_MANIFEST[name]
    const override = process.env[manifest.overrideEnv]
    if (override) {
      await fs.promises.access(override, fs.constants.X_OK)
      return override
    }

    // 更新流程传指定条目;运行时解析用有效条目(已更新版本 > baked pin)
    const entry = opts.entry ?? effectiveBinaryEntry(this.userDataDir, name, this.platformKey)
    if (!entry) throw new Error(`${name} 暂不支持平台 ${this.platformKey}`)
    const { version, artifact } = entry
    const report = (progress: BinaryProgress) => {
      if (!opts.silent) this.onProgress(progress)
      if (progress.fraction !== undefined) opts.onProgress?.(progress.fraction)
    }
    const installDir = path.join(this.rootDir, name, version, this.platformKey)
    const executable = path.join(installDir, artifact.executable)
    const marker = path.join(installDir, "install.json")
    if (await this.isInstalled(executable, marker, version, artifact.sha256)) {
      return executable
    }

    report({
      name,
      version,
      phase: "downloading",
      text: `正在下载 ${name} ${version}…`,
    })
    let tempDir: string | undefined
    try {
      await fs.promises.mkdir(this.rootDir, { recursive: true })
      tempDir = await fs.promises.mkdtemp(path.join(this.rootDir, `.${name}-`))
      const archive = path.join(
        tempDir,
        artifact.archive === "zip"
          ? "download.zip"
          : artifact.archive === "tar.gz"
            ? "download.tar.gz"
            : artifact.archive === "gz"
              ? "download.gz"
              : "download",
      )
      await this.download(artifact.url, archive, (received, total) => {
        report({
          name,
          version,
          phase: "downloading",
          ...(total ? { fraction: received / total } : {}),
          text: total
            ? `正在下载 ${name} ${version} ${Math.round((received / total) * 100)}%`
            : `正在下载 ${name} ${version}…`,
        })
      })
      report({
        name,
        version,
        phase: "verifying",
        text: `校验 ${name} ${version}…`,
      })
      const digest = await sha256File(archive)
      // sha256 为空 = TOFU(上游未提供摘要):跳过比对,自算值入 marker,
      // 首次下载即信任锚点;后续 isInstalled 按版本 + marker 摘要判定。
      if (artifact.sha256 && digest !== artifact.sha256) {
        throw new Error(`${name} 下载摘要不匹配: expected ${artifact.sha256}, got ${digest}`)
      }

      const extracted = path.join(tempDir, "extracted")
      let source = archive
      if (artifact.archive === "gz") {
        // 单文件 gzip 产物:解压即得到可执行文件本身
        await fs.promises.mkdir(extracted)
        await pipeline(
          fs.createReadStream(archive),
          zlib.createGunzip(),
          fs.createWriteStream(path.join(extracted, artifact.executable)),
        )
        source = path.join(extracted, artifact.executable)
      } else if (artifact.archive !== "binary") {
        await fs.promises.mkdir(extracted)
        if (artifact.archive === "zip") {
          await execFileAsync("unzip", ["-q", archive, "-d", extracted])
        } else {
          await execFileAsync("tar", ["-xzf", archive, "-C", extracted])
        }
        source = path.join(extracted, artifact.archiveEntry)
      }
      await fs.promises.access(source, fs.constants.R_OK)

      // 产物 sha 变化(如换 onefile→onedir)时清掉旧布局,避免文件/目录路径冲突。
      await fs.promises.rm(installDir, { recursive: true, force: true })
      await fs.promises.mkdir(installDir, { recursive: true })
      if (artifact.bundle) {
        // 目录型产物(onedir):整目录复制进 installDir,保持运行时依赖布局。
        // verbatimSymlinks:默认模式会把相对 symlink 改写成指向解包临时目录的
        // 绝对路径,临时目录一清就断链(PyInstaller 的 _internal/Python 实测踩中)。
        await fs.promises.cp(source, path.join(installDir, artifact.archiveEntry), {
          recursive: true,
          verbatimSymlinks: true,
        })
      } else {
        await fs.promises.copyFile(source, executable)
      }
      await fs.promises.chmod(executable, 0o755)
      await fs.promises.writeFile(
        marker,
        JSON.stringify({ version, archiveSha256: artifact.sha256 || digest }, null, 2),
      )
      report({
        name,
        version,
        phase: "done",
        text: `${name} ${version} 就绪`,
      })
      return executable
    } catch (error) {
      // 失败必须上报 error 相位:renderer 据此清掉进度行,否则残留的
      // 「下载 71%」会在下次创建会话时错误重现
      report({
        name,
        version,
        phase: "error",
        text: `${name} ${version} 安装失败:${error instanceof Error ? error.message : String(error)}`,
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
      // sha 为空 = TOFU 安装:只按版本判定(marker 摘要即首次自算值)
      return state.version === version &&
        (!archiveSha256 || state.archiveSha256 === archiveSha256)
    } catch {
      return false
    }
  }

  private async download(
    url: string,
    target: string,
    onBytes?: (received: number, total: number | undefined) => void,
  ) {
    // 断流重试:弱网下 fetch 可能半路 terminated,无重试会直接把会话
    // 打进 PATH 兜底(用户无感地用上更慢的本机二进制)。
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.downloadOnce(url, target, onBytes)
        return
      } catch (error) {
        lastError = error
        await fs.promises.rm(target, { force: true })
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
    throw lastError
  }

  private async downloadOnce(
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
    // 服务器正常关闭但字节数不够时 undici 不报错,截断文件会一路走到
    // sha 校验才炸,报错文案误导;这里提前按 content-length 判。
    if (total !== undefined) {
      const { size } = await fs.promises.stat(target)
      if (size !== total) throw new Error(`下载不完整: ${size}/${total} 字节`)
    }
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

/** 更新流程入口:安装指定(非 baked)条目;进度只回调调用方,
 * 不进全局 binary:progress(那个语义留给「会话需要运行时」的首次安装)。 */
export function installBinaryUpdate(
  name: ManagedBinaryName,
  entry: BinaryEntry,
  onProgress?: (fraction: number) => void,
) {
  if (!manager) throw new Error("BinaryManager 尚未初始化")
  return manager.ensure(name, { entry, onProgress, silent: true })
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
