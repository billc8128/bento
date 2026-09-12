import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import * as pty from "node-pty"

import type { WorkspaceTerminalCreated, WorkspaceTerminalExit } from "../../src/types/workspace"

type TerminalRecord = {
  ownerId: number
  process: pty.IPty
}

type TerminalSender = (
  ownerId: number,
  channel: "workspace-terminal:data" | "workspace-terminal:exit",
  payload: { id: string; data: string } | WorkspaceTerminalExit,
) => void

function terminalEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function resolveCwd(requested: string): string {
  const cwd = requested.trim() || os.homedir()
  return fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : os.homedir()
}

function resolveShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe"
  return process.env.SHELL || "/bin/zsh"
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>()

  constructor(private readonly send: TerminalSender) {}

  create(ownerId: number, input: { cwd: string; cols: number; rows: number }): WorkspaceTerminalCreated {
    const id = randomUUID()
    const cwd = resolveCwd(input.cwd)
    const shell = resolveShell()
    const child = pty.spawn(shell, process.platform === "win32" ? [] : ["-l"], {
      name: "xterm-256color",
      cols: Math.max(2, Math.floor(input.cols)),
      rows: Math.max(1, Math.floor(input.rows)),
      cwd,
      env: {
        ...terminalEnvironment(),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    })

    this.terminals.set(id, { ownerId, process: child })
    child.onData((data) => this.send(ownerId, "workspace-terminal:data", { id, data }))
    child.onExit(({ exitCode, signal }) => {
      this.terminals.delete(id)
      this.send(ownerId, "workspace-terminal:exit", {
        id,
        exitCode,
        ...(signal === undefined ? {} : { signal }),
      })
    })

    return { id, cwd, shell: path.basename(shell) }
  }

  write(ownerId: number, id: string, data: string) {
    this.owned(ownerId, id).process.write(data)
  }

  resize(ownerId: number, id: string, cols: number, rows: number) {
    this.owned(ownerId, id).process.resize(
      Math.max(2, Math.floor(cols)),
      Math.max(1, Math.floor(rows)),
    )
  }

  kill(ownerId: number, id: string) {
    const record = this.owned(ownerId, id)
    this.terminals.delete(id)
    record.process.kill()
  }

  disposeOwner(ownerId: number) {
    for (const [id, record] of this.terminals) {
      if (record.ownerId !== ownerId) continue
      this.terminals.delete(id)
      record.process.kill()
    }
  }

  disposeAll() {
    for (const record of this.terminals.values()) record.process.kill()
    this.terminals.clear()
  }

  private owned(ownerId: number, id: string): TerminalRecord {
    const record = this.terminals.get(id)
    if (!record || record.ownerId !== ownerId) throw new Error("终端不存在")
    return record
  }
}
