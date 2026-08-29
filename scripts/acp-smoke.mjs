// ACP 冒烟测试:不经 Electron,直接验证 harness 通道
import { spawn } from "node:child_process"
import { Writable, Readable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

// 用法:node scripts/acp-smoke.mjs <cmd> [args...],例如 kimi acp。
const [cmd, ...args] = process.argv.slice(2)
if (!cmd) throw new Error("请显式提供 ACP 命令,例如: pnpm smoke:acp kimi acp")

console.log("spawning", cmd, args.join(" "))
const child = spawn(cmd, args, {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: process.cwd(),
  // 环境清洗:去掉宿主 Claude Code 会话的标记,避免适配器拒绝嵌套
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_"))),
})
child.on("error", (e) => { console.error("spawn error:", e); process.exit(1) })
child.on("exit", (code, sig) => console.error("child exit:", code, sig))
setTimeout(() => { console.error("TIMEOUT 60s, giving up"); child.kill(); process.exit(2) }, 60000)

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))

const events = []
const clientImpl = {
  async requestPermission(params) {
    console.log("[perm]", params.toolCall?.title)
    const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0]
    return { outcome: { outcome: "selected", optionId: allow.optionId } }
  },
  async sessionUpdate(params) {
    const u = params.update
    events.push(u.sessionUpdate)
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      process.stdout.write(u.content.text)
    else console.log(`\n[${u.sessionUpdate}]`)
  },
}

const conn = new acp.ClientSideConnection(() => clientImpl, stream)

console.log("initializing...")
const t0 = Date.now()
const init = await conn.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
})
console.log("init ok, protocol v" + init.protocolVersion, "agent:", init.agentInfo?.name ?? "?", `${Date.now()-t0}ms`)

const sess = await conn.newSession({ cwd: process.cwd(), mcpServers: [] })
console.log("session:", sess.sessionId, "models:", JSON.stringify(sess.models)?.slice(0,200))

const res = await conn.prompt({
  sessionId: sess.sessionId,
  prompt: [{ type: "text", text: "用一句话回答:1+1 等于几?不要用任何工具。" }],
})
console.log("\nstop:", res.stopReason, "| events:", [...new Set(events)].join(","))
child.kill()
process.exit(0)
