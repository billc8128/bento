import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WorkspaceFileService } from "./file-service"

describe("WorkspaceFileService", () => {
  let root: string
  const service = new WorkspaceFileService()

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bento-workspace-files-"))
    await fs.mkdir(path.join(root, "src"))
    await fs.mkdir(path.join(root, ".git"))
    await fs.mkdir(path.join(root, "node_modules"))
    await fs.writeFile(path.join(root, "src", "App.tsx"), "export default function App() {}\n")
    await fs.writeFile(path.join(root, "data.csv"), "name,value\nbento,1\n")
    await fs.writeFile(path.join(root, "page.html"), "<h1>Bento</h1>")
    await fs.writeFile(path.join(root, "file.bin"), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(root, "doc.pdf"), Buffer.from("%PDF-1.7"))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("lists directories first and hides generated directories", async () => {
    const entries = await service.list(root, "")
    expect(entries.map((entry) => entry.name)).toEqual([
      "src",
      "data.csv",
      "doc.pdf",
      "file.bin",
      "page.html",
    ])
  })

  it("classifies supported previews", async () => {
    await expect(service.read(root, "data.csv")).resolves.toMatchObject({ kind: "csv" })
    await expect(service.read(root, "page.html")).resolves.toMatchObject({ kind: "html" })
    await expect(service.read(root, "doc.pdf")).resolves.toMatchObject({ kind: "pdf" })
    await expect(service.read(root, "file.bin")).resolves.toMatchObject({ kind: "unsupported" })
  })

  it("rejects paths outside the workspace root", async () => {
    await expect(service.read(root, "../outside.txt")).rejects.toThrow("超出项目目录")
    await expect(service.list(root, path.resolve(root))).rejects.toThrow("必须相对项目目录")
  })
})
