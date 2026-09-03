import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { readFileDataUrl, saveAttachmentBlob } from "./local-files"

let tempDir = ""

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ""
})

describe("local-files", () => {
  it("saveAttachmentBlob 落盘并保留扩展名;无扩展名时按 mime 补", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-local-files-"))
    const bytes = new Uint8Array([1, 2, 3])
    const named = saveAttachmentBlob(tempDir, { name: "shot.png", mimeType: "image/png", data: bytes })
    expect(named.endsWith(".png")).toBe(true)
    expect(fs.readFileSync(named)).toEqual(Buffer.from(bytes))

    const unnamed = saveAttachmentBlob(tempDir, { name: "image", mimeType: "image/jpeg", data: bytes })
    expect(unnamed.endsWith(".jpg")).toBe(true)
  })

  it("readFileDataUrl 只认图片扩展名,file:// 前缀与百分号编码都能解", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bento-local-files-"))
    const png = path.join(tempDir, "logo final.png")
    fs.writeFileSync(png, Buffer.from([0x89, 0x50]))
    const ok = readFileDataUrl(`file://${encodeURI(png)}`)
    expect(ok.dataUrl).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50]).toString("base64")}`)

    fs.writeFileSync(path.join(tempDir, "notes.txt"), "hi")
    expect(readFileDataUrl(path.join(tempDir, "notes.txt")).error).toBeTruthy()
    expect(readFileDataUrl(path.join(tempDir, "missing.png")).error).toBeTruthy()
  })
})
