import fs from "node:fs"
import path from "node:path"

import { BROWSER_APP, BROWSER_APP_ID, type BentoAppId, type BentoAppView } from "../src/core/apps"

type AppsState = { enabled: Partial<Record<BentoAppId, boolean>> }

export class AppsStore {
  private readonly file: string
  private state: AppsState

  constructor(userDataDir: string, private readonly onChanged: () => void = () => {}) {
    this.file = path.join(userDataDir, "apps.json")
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as AppsState
    } catch {
      this.state = { enabled: {} }
    }
  }

  list(): BentoAppView[] {
    return [{
      ...BROWSER_APP,
      harnesses: [...BROWSER_APP.harnesses],
      unsupportedHarnesses: [...BROWSER_APP.unsupportedHarnesses],
      enabled: this.isEnabled(BROWSER_APP_ID),
    }]
  }

  isEnabled(id: BentoAppId): boolean {
    return this.state.enabled[id] ?? BROWSER_APP.enabledByDefault
  }

  setEnabled(id: BentoAppId, enabled: boolean): void {
    this.state.enabled[id] = enabled
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2))
    fs.renameSync(temporary, this.file)
    this.onChanged()
  }
}
