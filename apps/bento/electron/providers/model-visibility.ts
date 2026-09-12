import fs from "node:fs"
import path from "node:path"

type VisibilityState = { hidden: string[] }

export class ModelVisibilityStore {
  private readonly file: string
  private hidden: Set<string>

  constructor(userDataDir: string) {
    const dir = path.join(userDataDir, "providers")
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, "model-visibility.json")
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as VisibilityState | Record<string, string[]>
      const ids = Array.isArray((saved as VisibilityState).hidden)
        ? (saved as VisibilityState).hidden
        : Object.values(saved).flat()
      this.hidden = new Set(ids)
    } catch {
      this.hidden = new Set()
    }
  }

  isEnabled(_providerId: string, modelId: string): boolean {
    return !this.hidden.has(modelId)
  }

  set(_providerId: string, updates: Array<{ modelId: string; enabled: boolean }>): void {
    for (const update of updates) {
      if (update.enabled) this.hidden.delete(update.modelId)
      else this.hidden.add(update.modelId)
    }
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ hidden: [...this.hidden] }, null, 2))
    fs.renameSync(temp, this.file)
  }
}
