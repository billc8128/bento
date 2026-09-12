/**
 * 渲染层本地文件支持:剪贴板/拖拽来的无路径 Blob 落盘为附件文件;
 * 正文里的本地图片路径读成 data URL 供 <img> 渲染。
 * 两侧都设 25MB 上限,图片按扩展名白名单,不读任意文件内容出进程。
 */
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const MAX_BYTES = 25 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
}

/** 剪贴板粘贴的 File 没有磁盘路径,把字节落进 userData/attachments 供 harness 引用。 */
export function saveAttachmentBlob(
  userDataDir: string,
  input: { name: string; mimeType: string; data: ArrayBuffer | Uint8Array },
): string {
  const buffer = Buffer.from(input.data instanceof ArrayBuffer ? new Uint8Array(input.data) : input.data)
  if (buffer.length === 0) throw new Error("空附件")
  if (buffer.length > MAX_BYTES) throw new Error("附件超过 25MB 上限")
  const ext = path.extname(input.name) || EXT_BY_MIME[input.mimeType] || ".bin"
  const dir = path.join(userDataDir, "attachments")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, `${randomUUID()}${ext}`)
  fs.writeFileSync(target, buffer, { mode: 0o600 })
  return target
}

/** 正文 markdown 里的本地图片路径 → data URL。仅图片扩展名,超上限拒绝。 */
export function readFileDataUrl(target: string): { dataUrl?: string; error?: string } {
  const filePath = target.startsWith("file://") ? decodeURIComponent(target.slice(7)) : target
  const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()]
  if (!mime) return { error: "不支持的文件类型" }
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { error: "不是文件" }
    if (stat.size > MAX_BYTES) return { error: "图片超过 25MB 上限" }
    return { dataUrl: `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}` }
  } catch {
    return { error: "文件不存在或不可读" }
  }
}
