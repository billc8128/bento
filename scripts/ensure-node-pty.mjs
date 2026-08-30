import fs from "node:fs"
import path from "node:path"

if (process.platform !== "win32") {
  const helper = path.resolve(
    "node_modules/node-pty/prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  )
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}
