import { describe, expect, it } from "vitest"

import { normalizeWorkspaceBrowserUrl } from "./workspace-browser"

describe("normalizeWorkspaceBrowserUrl", () => {
  it("adds https to hostnames and preserves local http URLs", () => {
    expect(normalizeWorkspaceBrowserUrl("example.com")).toBe("https://example.com/")
    expect(normalizeWorkspaceBrowserUrl("http://localhost:5173/path")).toBe("http://localhost:5173/path")
  })

  it("rejects non-web protocols", () => {
    expect(() => normalizeWorkspaceBrowserUrl("file:///etc/passwd")).toThrow("HTTP(S)")
    expect(() => normalizeWorkspaceBrowserUrl("javascript:alert(1)")).toThrow("HTTP(S)")
    expect(() => normalizeWorkspaceBrowserUrl("data:text/html,test")).toThrow("HTTP(S)")
  })
})
