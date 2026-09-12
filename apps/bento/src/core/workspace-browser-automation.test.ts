import { describe, expect, it } from "vitest"

import { simplifyWorkspaceAxNodes } from "./workspace-browser-automation"

describe("simplifyWorkspaceAxNodes", () => {
  it("keeps semantic nodes and widget state", () => {
    expect(simplifyWorkspaceAxNodes([
      { ignored: true, backendDOMNodeId: 1, role: { value: "button" }, name: { value: "hidden" } },
      {
        backendDOMNodeId: 2,
        role: { value: "checkbox" },
        name: { value: "Remember me" },
        properties: [{ name: "checked", value: { value: true } }],
      },
      { backendDOMNodeId: 3, role: { value: "generic" } },
    ])).toEqual([{ nodeId: 2, role: "checkbox", name: "Remember me", checked: true }])
  })

  it("limits snapshot size", () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      backendDOMNodeId: index,
      role: { value: "button" },
      name: { value: `Button ${index}` },
    }))
    expect(simplifyWorkspaceAxNodes(nodes, 3)).toHaveLength(3)
  })
})
