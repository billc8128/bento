import fs from "node:fs/promises"
import path from "node:path"

import type { WorkspaceFileEntry, WorkspaceFilePreview } from "../../src/types/workspace"

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", "release"])
const MAX_TEXT_SIZE = 4 * 1024 * 1024
const MAX_BINARY_SIZE = 25 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/")
}

async function resolveWithinRoot(rootInput: string, relativePath: string): Promise<{ root: string; target: string }> {
  if (!rootInput.trim()) throw new Error("当前会话未绑定项目目录")
  if (path.isAbsolute(relativePath)) throw new Error("文件路径必须相对项目目录")

  const root = await fs.realpath(rootInput)
  const candidate = path.resolve(root, relativePath || ".")
  if (!inside(root, candidate)) throw new Error("文件路径超出项目目录")

  const target = await fs.realpath(candidate)
  if (!inside(root, target)) throw new Error("文件路径超出项目目录")
  return { root, target }
}

export class WorkspaceFileService {
  async resolveDirectory(rootInput: string, relativePath: string): Promise<string> {
    const { target } = await resolveWithinRoot(rootInput, relativePath)
    const stat = await fs.stat(target)
    if (!stat.isDirectory()) throw new Error("只能监听目录")
    return target
  }

  async list(rootInput: string, relativePath: string): Promise<WorkspaceFileEntry[]> {
    const { root, target } = await resolveWithinRoot(rootInput, relativePath)
    const entries = await fs.readdir(target, { withFileTypes: true })
    const visible = entries.filter((entry) =>
      !entry.isSymbolicLink() && (!entry.isDirectory() || !IGNORED_DIRECTORIES.has(entry.name)))

    return Promise.all(visible.map(async (entry) => {
      const absolutePath = path.join(target, entry.name)
      const stat = await fs.stat(absolutePath)
      return {
        name: entry.name,
        path: portablePath(path.relative(root, absolutePath)),
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }
    })).then((items) => items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    }))
  }

  async read(rootInput: string, relativePath: string): Promise<WorkspaceFilePreview> {
    const { target } = await resolveWithinRoot(rootInput, relativePath)
    const stat = await fs.stat(target)
    if (!stat.isFile()) throw new Error("只能预览文件")

    const extension = path.extname(target).toLowerCase()
    const mime = MIME_BY_EXTENSION[extension] ?? "text/plain"
    const kind = mime === "application/pdf"
      ? "pdf"
      : mime.startsWith("image/")
        ? "image"
        : mime === "text/csv"
          ? "csv"
          : mime === "text/html"
            ? "html"
            : "text"

    const limit = kind === "pdf" || kind === "image" ? MAX_BINARY_SIZE : MAX_TEXT_SIZE
    if (stat.size > limit) throw new Error(`文件过大，预览上限为 ${Math.round(limit / 1024 / 1024)} MB`)

    const buffer = await fs.readFile(target)
    if (kind === "pdf" || kind === "image") {
      return { kind, path: relativePath, mime, size: stat.size, base64: buffer.toString("base64") }
    }

    if (kind === "text" && buffer.subarray(0, 8192).includes(0)) {
      return { kind: "unsupported", path: relativePath, mime: "application/octet-stream", size: stat.size }
    }

    return { kind, path: relativePath, mime, size: stat.size, text: buffer.toString("utf8") }
  }
}
