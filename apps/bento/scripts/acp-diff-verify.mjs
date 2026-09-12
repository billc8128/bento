// ACP diff 真实性验证(TRACE_DATA_PLAN §8):协议允许 type:"diff" content ≠
// adapter 真发。让 kimi 真实编辑一个文件,抓 tool_call / tool_call_update 的
// content 全文,确认 diff 项是否实际到达。
import { spawn } from "node:child_process"
import { Writable, Readable } from "node:stream"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as acp from "@agentclientprotocol/sdk"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bento-acp-diff-"))
fs.writeFileSync(
  path.join(scratch, "hello.txt"),
  "alpha\nbeta\ngamma\ndelta\nepsilon\n",
)
console.log("scratch:", scratch)

const child = spawn("kimi", ["acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: scratch,
  env: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")),
  ),
})
child.on("error", (e) => { console.error("spawn error:", e); process.exit(1) })
setTimeout(() => { console.error("TIMEOUT 120s"); child.kill(); process.exit(2) }, 120000)

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))

let diffHits = 0
const clientImpl = {
  async requestPermission(params) {
    console.log("[perm]", params.toolCall?.title)
    const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0]
    return { outcome: { outcome: "selected", optionId: allow.optionId } }
  },
  async sessionUpdate(params) {
    const u = params.update
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      process.stdout.write(u.content.text)
      return
    }
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const content = Array.isArray(u.content) ? u.content : u.content ? [u.content] : []
      const types = content.map((c) => c?.type)
      console.log(`\n[${u.sessionUpdate}] kind=${u.kind ?? "?"} title=${JSON.stringify(u.title)} contentTypes=${JSON.stringify(types)}`)
      for (const c of content) {
        if (c?.type === "diff") {
          diffHits += 1
          console.log("  ★ DIFF path=", c.path, "oldText=", c.oldText === null ? "null" : `${String(c.oldText).length}ch`, "newText=", `${String(c.newText ?? "").length}ch`)
        }
      }
      return
    }
    console.log(`\n[${u.sessionUpdate}]`)
  },
}

const conn = new acp.ClientSideConnection(() => clientImpl, stream)
const init = await conn.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
})
console.log("init ok, agent:", init.agentInfo?.name ?? "?")

const sess = await conn.newSession({ cwd: scratch, mcpServers: [] })
console.log("session:", sess.sessionId)

const res = await conn.prompt({
  sessionId: sess.sessionId,
  prompt: [
    {
      type: "text",
      text: "把 hello.txt 里的 beta 改成 BETA,再在文件末尾加一行 zeta。直接改文件,不要解释。",
    },
  ],
})
console.log("\nstop:", res.stopReason, "| diff content 命中次数:", diffHits)
console.log("结果文件:\n" + fs.readFileSync(path.join(scratch, "hello.txt"), "utf8"))
child.kill()
process.exit(0)
