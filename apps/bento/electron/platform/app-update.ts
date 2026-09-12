import type { EventEmitter } from "node:events"
import type { AppUpdateState } from "../../src/core/app-update"

export interface UpdateEngine extends Pick<EventEmitter, "on" | "removeListener"> {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** One user click authorizes download + restart; background checks never install. */
export class AppUpdateController {
  state: AppUpdateState
  private readonly engine: UpdateEngine
  private readonly enabled: boolean
  private readonly publish: (state: AppUpdateState) => void
  private readonly beforeInstall: () => Promise<void>
  private disposed = false
  private checkTimer?: ReturnType<typeof setTimeout>
  private pollTimer?: ReturnType<typeof setInterval>
  private installTimer?: ReturnType<typeof setTimeout>

  constructor(engine: UpdateEngine, enabled: boolean, currentVersion: string,
    publish: (state: AppUpdateState) => void, beforeInstall: () => Promise<void>) {
    this.engine = engine
    this.enabled = enabled
    this.publish = publish
    this.beforeInstall = beforeInstall
    this.state = { status: "idle", currentVersion, percent: 0 }
    engine.autoDownload = false
    engine.autoInstallOnAppQuit = false
    engine.allowPrerelease = false
    engine.allowDowngrade = false
    engine.on("update-available", this.available)
    engine.on("update-not-available", this.latest)
    engine.on("download-progress", this.progress)
    engine.on("update-downloaded", this.downloaded)
    engine.on("error", this.failed)
  }

  private set(next: Partial<AppUpdateState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...next }
    this.publish(this.state)
  }

  private available = (info: { version: string }) => {
    this.set({ status: "available", version: info.version, percent: 0, errorStage: undefined })
  }
  private latest = () => {
    this.set({ status: "idle", version: undefined, percent: 0, errorStage: undefined })
  }
  private progress = (info: { percent: number }) => {
    if (this.state.status !== "downloading" || !Number.isFinite(info.percent)) return
    this.set({ percent: Math.max(0, Math.min(100, info.percent)) })
  }
  private downloaded = () => {
    // A cached/background event without a user-initiated download must not restart Bento.
    if (this.state.status !== "downloading" || this.disposed) return
    this.set({ status: "downloaded", percent: 100 })
    this.installTimer = setTimeout(() => { void this.install() }, 650)
  }
  private failed = () => {
    clearTimeout(this.installTimer)
    const errorStage = this.state.status === "downloaded" || this.state.status === "installing"
      ? "install" : this.state.status === "downloading" ? "download" : this.state.errorStage ?? "check"
    this.set({ status: "error", errorStage })
  }

  start() {
    if (!this.enabled || this.disposed || this.pollTimer) return
    this.checkTimer = setTimeout(() => { void this.check() }, 10_000)
    this.pollTimer = setInterval(() => { void this.check() }, 6 * 60 * 60 * 1000)
    this.checkTimer.unref()
    this.pollTimer.unref()
  }

  async check() {
    if (!this.enabled || this.disposed || ["checking", "downloading", "downloaded", "installing"].includes(this.state.status)) return
    this.set({ status: "checking", errorStage: undefined })
    try { await this.engine.checkForUpdates() } catch { this.failed() }
  }

  async downloadAndInstall() {
    if (!this.enabled || this.disposed || !this.state.version ||
      !(this.state.status === "available" || this.state.status === "error")) return
    this.set({ status: "downloading", percent: 0, errorStage: undefined })
    try { await this.engine.downloadUpdate() } catch { this.failed() }
  }

  private async install() {
    if (this.disposed || this.state.status !== "downloaded") return
    this.set({ status: "installing" })
    try {
      await this.beforeInstall()
      if (!this.disposed) this.engine.quitAndInstall(false, true)
    } catch { this.failed() }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.checkTimer)
    clearInterval(this.pollTimer)
    clearTimeout(this.installTimer)
    this.engine.removeListener("update-available", this.available)
    this.engine.removeListener("update-not-available", this.latest)
    this.engine.removeListener("download-progress", this.progress)
    this.engine.removeListener("update-downloaded", this.downloaded)
    // electron-updater may still finish an in-flight request while Electron is exiting.
    this.engine.removeListener("error", this.failed)
    this.engine.on("error", () => {})
  }
}
