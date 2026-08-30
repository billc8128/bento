import fs from "node:fs"
import { randomUUID } from "node:crypto"

import type { WorkspaceFileChange } from "../../src/types/workspace"
import { WorkspaceFileService } from "./file-service"

type WatchRecord = {
  ownerId: number
  watcher: fs.FSWatcher
}

type WatchSender = (ownerId: number, change: WorkspaceFileChange) => void

export class WorkspaceFileWatchManager {
  private readonly watches = new Map<string, WatchRecord>()

  constructor(
    private readonly files: WorkspaceFileService,
    private readonly send: WatchSender,
  ) {}

  async watch(ownerId: number, root: string, directory: string): Promise<string> {
    const target = await this.files.resolveDirectory(root, directory)
    const subscriptionId = randomUUID()
    const watcher = fs.watch(target, { persistent: false }, (eventType, name) => {
      this.send(ownerId, {
        subscriptionId,
        directory,
        eventType,
        ...(name ? { name: name.toString() } : {}),
      })
    })
    watcher.on("error", () => this.unwatch(ownerId, subscriptionId))
    this.watches.set(subscriptionId, { ownerId, watcher })
    return subscriptionId
  }

  unwatch(ownerId: number, subscriptionId: string) {
    const record = this.watches.get(subscriptionId)
    if (!record || record.ownerId !== ownerId) return
    this.watches.delete(subscriptionId)
    record.watcher.close()
  }

  disposeOwner(ownerId: number) {
    for (const [id, record] of this.watches) {
      if (record.ownerId === ownerId) this.unwatch(ownerId, id)
    }
  }

  disposeAll() {
    for (const record of this.watches.values()) record.watcher.close()
    this.watches.clear()
  }
}
