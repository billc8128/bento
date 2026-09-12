import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { WorkspaceFileService } from "./file-service"
import { WorkspaceFileWatchManager } from "./file-watch-manager"

describe("WorkspaceFileWatchManager", () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bento-workspace-watch-"))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it("emits changes for a watched workspace directory", async () => {
    const change = new Promise<{ directory: string; name?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watch timeout")), 3000)
      const manager = new WorkspaceFileWatchManager(new WorkspaceFileService(), (_ownerId, event) => {
        if (event.name !== "created.txt") return
        clearTimeout(timeout)
        manager.disposeAll()
        resolve(event)
      })
      void manager.watch(7, root, "").then(() => fs.writeFile(path.join(root, "created.txt"), "ok"))
    })

    await expect(change).resolves.toMatchObject({ directory: "", name: "created.txt" })
  })
})
