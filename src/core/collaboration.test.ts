import { describe, expect, it } from "vitest"

import { deriveUiAdjacency } from "./collaboration"

describe("deriveUiAdjacency", () => {
  it("优先同一行/列的最近邻，避免把斜向 Session 误判成右侧", () => {
    const adjacency = deriveUiAdjacency([
      { sessionId: "origin", left: 0, top: 0, width: 100, height: 100 },
      { sessionId: "right", left: 300, top: 0, width: 100, height: 100 },
      { sessionId: "diagonal", left: 110, top: 110, width: 100, height: 100 },
    ])

    expect(adjacency).toContainEqual({
      sessionId: "origin",
      neighbors: { right: "right", below: "diagonal" },
    })
    expect(adjacency.find((entry) => entry.sessionId === "right")?.neighbors.left).toBe("origin")
    expect(adjacency.find((entry) => entry.sessionId === "diagonal")?.neighbors.above).toBe("origin")
  })

  it("单 Session 没有邻居，空布局返回空数组", () => {
    expect(deriveUiAdjacency([])).toEqual([])
    expect(deriveUiAdjacency([
      { sessionId: "only", left: 10, top: 10, width: 400, height: 300 },
    ])).toEqual([{ sessionId: "only", neighbors: {} }])
  })
})
