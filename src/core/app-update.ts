/** Public update state: no download URLs, paths, or upstream error details cross IPC. */
export type AppUpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error"
  currentVersion: string
  version?: string
  percent: number
  errorStage?: "check" | "download" | "install"
}
