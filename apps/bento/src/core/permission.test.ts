import { describe, expect, it } from "vitest"

import {
  classifyClaudeTool,
  codexSandboxPolicy,
  codexThreadPolicy,
  isPathInside,
  triageAcpToolCall,
  triageClaudeTool,
} from "./permission"

describe("isPathInside", () => {
  it("工作区内、边界、越界", () => {
    expect(isPathInside("/repo", "/repo/a.ts")).toBe(true)
    expect(isPathInside("/repo", "/repo")).toBe(true)
    expect(isPathInside("/repo", "/repo2/a.ts")).toBe(false)
    expect(isPathInside("/repo", "/tmp/a.ts")).toBe(false)
    expect(isPathInside("/repo/", "/repo/a.ts")).toBe(true)
  })
  it("相对路径按越界处理", () => {
    expect(isPathInside("/repo", "a.ts")).toBe(false)
  })
})

describe("classifyClaudeTool", () => {
  const cwd = "/repo"
  it("read / write-inside / write-outside / network / execute / other", () => {
    expect(classifyClaudeTool("Read", {}, cwd)).toBe("read")
    expect(classifyClaudeTool("Edit", { file_path: "/repo/a.ts" }, cwd)).toBe("write-inside")
    expect(classifyClaudeTool("NotebookEdit", { notebook_path: "/repo/n.ipynb" }, cwd)).toBe("write-inside")
    expect(classifyClaudeTool("Edit", { file_path: "/etc/hosts" }, cwd)).toBe("write-outside")
    expect(classifyClaudeTool("Write", {}, cwd)).toBe("write-outside") // 缺路径不可判定
    expect(classifyClaudeTool("WebFetch", {}, cwd)).toBe("network")
    expect(classifyClaudeTool("Bash", {}, cwd)).toBe("execute")
    expect(classifyClaudeTool("mcp__bento-apps__x", {}, cwd)).toBe("other")
  })
})

describe("triageClaudeTool", () => {
  const cwd = "/repo"
  it("受限:只读 + 工作区内写,其余全拒(不问)", () => {
    expect(triageClaudeTool("restricted", "Read", {}, cwd)).toBe("allow")
    expect(triageClaudeTool("restricted", "Edit", { file_path: "/repo/a.ts" }, cwd)).toBe("allow")
    expect(triageClaudeTool("restricted", "Edit", { file_path: "/etc/hosts" }, cwd)).toBe("deny")
    expect(triageClaudeTool("restricted", "WebFetch", {}, cwd)).toBe("deny")
    expect(triageClaudeTool("restricted", "Bash", {}, cwd)).toBe("deny")
    expect(triageClaudeTool("restricted", "mcp__bento-apps__x", {}, cwd)).toBe("deny")
  })
  it("标准:网络与 MCP 放行,execute 与越界写走审批", () => {
    expect(triageClaudeTool("standard", "WebFetch", {}, cwd)).toBe("allow")
    expect(triageClaudeTool("standard", "mcp__bento-apps__x", {}, cwd)).toBe("allow")
    expect(triageClaudeTool("standard", "Bash", {}, cwd)).toBe("ask")
    expect(triageClaudeTool("standard", "Edit", { file_path: "/etc/hosts" }, cwd)).toBe("ask")
  })
  it("放行:全放", () => {
    expect(triageClaudeTool("full", "Bash", {}, cwd)).toBe("allow")
    expect(triageClaudeTool("full", "Edit", { file_path: "/etc/hosts" }, cwd)).toBe("allow")
  })
})

describe("triageAcpToolCall", () => {
  const cwd = "/repo"
  it("受限:read/search/think + 工作区内 edit,其余拒(不问)", () => {
    expect(triageAcpToolCall("restricted", { kind: "read" }, cwd)).toBe("allow")
    expect(triageAcpToolCall("restricted", { kind: "search" }, cwd)).toBe("allow")
    expect(triageAcpToolCall("restricted", { kind: "edit", locations: [{ path: "/repo/a.ts" }] }, cwd)).toBe("allow")
    expect(triageAcpToolCall("restricted", { kind: "edit", locations: [{ path: "/etc/hosts" }] }, cwd)).toBe("deny")
    expect(triageAcpToolCall("restricted", { kind: "edit" }, cwd)).toBe("deny")
    expect(triageAcpToolCall("restricted", { kind: "execute" }, cwd)).toBe("deny")
    expect(triageAcpToolCall("restricted", { kind: "fetch" }, cwd)).toBe("deny")
    expect(triageAcpToolCall("restricted", {}, cwd)).toBe("deny")
  })
  it("标准:加 fetch,execute/越界 edit/未知 kind 走审批", () => {
    expect(triageAcpToolCall("standard", { kind: "fetch" }, cwd)).toBe("allow")
    expect(triageAcpToolCall("standard", { kind: "execute" }, cwd)).toBe("ask")
    expect(triageAcpToolCall("standard", { kind: "edit", locations: [{ path: "/etc/hosts" }] }, cwd)).toBe("ask")
    expect(triageAcpToolCall("standard", {}, cwd)).toBe("ask")
  })
  it("放行:全放", () => {
    expect(triageAcpToolCall("full", { kind: "execute" }, cwd)).toBe("allow")
  })
})

describe("codexThreadPolicy", () => {
  it("三档映射:标准档起 on-request 走审批", () => {
    expect(codexThreadPolicy("restricted")).toEqual({
      sandbox: "workspace-write", approvalPolicy: "never",
    })
    expect(codexThreadPolicy("standard")).toEqual({
      sandbox: "workspace-write", approvalPolicy: "on-request",
    })
    expect(codexThreadPolicy("full")).toEqual({
      sandbox: "danger-full-access", approvalPolicy: "never",
    })
  })
})

describe("codexSandboxPolicy(turn 级覆盖)", () => {
  it("三档映射", () => {
    expect(codexSandboxPolicy("restricted")).toEqual({ type: "workspaceWrite", networkAccess: false })
    expect(codexSandboxPolicy("standard")).toEqual({ type: "workspaceWrite", networkAccess: true })
    expect(codexSandboxPolicy("full")).toEqual({ type: "dangerFullAccess" })
  })
})
