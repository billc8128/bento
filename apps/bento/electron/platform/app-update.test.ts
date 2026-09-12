import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppUpdateController } from "./app-update"

class Engine extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checkForUpdates = vi.fn(async () => { this.emit("update-available", { version: "0.4.3" }) })
  downloadUpdate = vi.fn(async () => {})
  quitAndInstall = vi.fn()
}
const controllers: AppUpdateController[] = []
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers() })
function setup(enabled = true, beforeInstall = vi.fn(async () => {})) {
  const engine = new Engine()
  const publish = vi.fn()
  const controller = new AppUpdateController(engine, enabled, "0.4.2", publish, beforeInstall)
  controllers.push(controller)
  return { engine, publish, controller, beforeInstall }
}

describe("application updates", () => {
  it("checks quietly on startup, never downloads until clicked, and uses stable versions only", async () => {
    vi.useFakeTimers()
    const { engine, controller } = setup()
    controller.start(); controller.start()
    await vi.advanceTimersByTimeAsync(9999)
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(controller.state.status).toBe("available")
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect([engine.autoDownload, engine.autoInstallOnAppQuit, engine.allowPrerelease, engine.allowDowngrade]).toEqual([false, false, false, false])
  })

  it("one click downloads once, reports real progress, flushes work before automatic install", async () => {
    vi.useFakeTimers()
    let finishCleanup!: () => void
    const cleanup = vi.fn(() => new Promise<void>(resolve => { finishCleanup = resolve }))
    const { controller, engine } = setup(true, cleanup)
    await controller.check()
    await controller.downloadAndInstall()
    await controller.downloadAndInstall()
    expect(engine.downloadUpdate).toHaveBeenCalledTimes(1)
    engine.emit("download-progress", { percent: 43.2 })
    expect(controller.state.percent).toBe(43.2)
    engine.emit("download-progress", { percent: Number.NaN })
    expect(controller.state.percent).toBe(43.2)
    engine.emit("update-downloaded")
    expect(controller.state.status).toBe("downloaded")
    await vi.advanceTimersByTimeAsync(650)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    finishCleanup(); await Promise.resolve(); await Promise.resolve()
    expect(engine.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it("ignores downloaded events without explicit user authorization", async () => {
    vi.useFakeTimers()
    const { controller, engine } = setup()
    await controller.check()
    engine.emit("update-downloaded")
    await vi.advanceTimersByTimeAsync(2000)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.state.status).toBe("available")
  })

  it("download failure stays retryable, does not restart, and does not expose error payloads", async () => {
    vi.useFakeTimers()
    const { controller, engine } = setup()
    await controller.check()
    engine.downloadUpdate.mockRejectedValueOnce(new Error("private upstream URL"))
    await controller.downloadAndInstall()
    expect(controller.state).toMatchObject({ status: "error", errorStage: "download" })
    expect(JSON.stringify(controller.state)).not.toContain("private")
    await vi.advanceTimersByTimeAsync(2000)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    await controller.downloadAndInstall()
    expect(controller.state.status).toBe("downloading")
    expect(engine.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it("a late updater error cancels scheduled installation", async () => {
    vi.useFakeTimers()
    const { controller, engine } = setup()
    await controller.check(); await controller.downloadAndInstall()
    engine.emit("update-downloaded"); engine.emit("error", new Error("signature failure"))
    await vi.advanceTimersByTimeAsync(2000)
    expect(controller.state).toMatchObject({ status: "error", errorStage: "install" })
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })

  it("cleanup failure prevents quitting", async () => {
    vi.useFakeTimers()
    const { controller, engine } = setup(true, vi.fn(async () => { throw new Error("flush failed") }))
    await controller.check(); await controller.downloadAndInstall(); engine.emit("update-downloaded")
    await vi.advanceTimersByTimeAsync(650)
    expect(controller.state).toMatchObject({ status: "error", errorStage: "install" })
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })

  it("does not check again during an active download", async () => {
    const { controller, engine } = setup()
    await controller.check(); await controller.downloadAndInstall(); await controller.check()
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("dev/unsupported builds never check, download, or install", async () => {
    vi.useFakeTimers()
    const { controller, engine } = setup(false)
    controller.start(); await controller.check(); await controller.downloadAndInstall()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
  })

  it("dispose clears timers and accepts late errors without installing", async () => {
    vi.useFakeTimers()
    const { controller, engine, publish } = setup()
    controller.start(); await controller.check(); await controller.downloadAndInstall()
    engine.emit("update-downloaded"); controller.dispose(); publish.mockClear()
    engine.emit("error", new Error("network finished after exit"))
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it("no update returns to idle; check failures can recover", async () => {
    const { controller, engine } = setup()
    engine.checkForUpdates.mockRejectedValueOnce(new Error("offline"))
    await controller.check()
    expect(controller.state).toMatchObject({ status: "error", errorStage: "check" })
    expect(controller.state.version).toBeUndefined()
    engine.checkForUpdates.mockImplementationOnce(async () => { engine.emit("update-not-available") })
    await controller.check()
    expect(controller.state.status).toBe("idle")
  })
})
