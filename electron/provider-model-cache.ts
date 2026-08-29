import fs from "node:fs"
import path from "node:path"

type CacheFile = { version: 1; entries: Record<string, unknown> }

export class ProviderModelCache {
  private readonly file: string
  private readonly entries: Record<string, unknown>

  constructor(userDataDir: string) {
    const dir = path.join(userDataDir, "providers")
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, "model-cache.json")
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as CacheFile
      this.entries = saved.version === 1 && saved.entries ? saved.entries : {}
    } catch {
      this.entries = {}
    }
  }

  get<T>(key: string): T | undefined {
    return this.entries[key] as T | undefined
  }

  set(key: string, value: unknown): void {
    this.entries[key] = value
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: this.entries }))
    fs.renameSync(temp, this.file)
  }
}
