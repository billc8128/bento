import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

if (process.platform !== "win32") {
  const helper = path.resolve(
    path.dirname(require.resolve("node-pty/package.json")),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  )
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
}
