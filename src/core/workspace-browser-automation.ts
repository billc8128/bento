import type { WorkspaceBrowserAxNode } from "@/types/workspace"

type CdpAxValue = { value?: unknown }
type CdpAxProperty = { name?: string; value?: CdpAxValue }
type CdpAxNode = {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: CdpAxValue
  name?: CdpAxValue
  value?: CdpAxValue
  description?: CdpAxValue
  properties?: CdpAxProperty[]
}

const MEANINGFUL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "image",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "StaticText",
  "switch",
  "tab",
  "textbox",
])

function stringValue(value?: CdpAxValue): string {
  return value?.value === undefined ? "" : String(value.value)
}

function property(node: CdpAxNode, name: string): unknown {
  return node.properties?.find((item) => item.name === name)?.value?.value
}

export function simplifyWorkspaceAxNodes(nodes: CdpAxNode[], limit = 500): WorkspaceBrowserAxNode[] {
  const result: WorkspaceBrowserAxNode[] = []
  for (const node of nodes) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue
    const role = stringValue(node.role)
    const name = stringValue(node.name)
    const value = stringValue(node.value)
    if (!MEANINGFUL_ROLES.has(role) && !name && !value) continue

    const disabled = property(node, "disabled")
    const checked = property(node, "checked")
    const selected = property(node, "selected")
    result.push({
      nodeId: node.backendDOMNodeId,
      role,
      name,
      ...(value ? { value } : {}),
      ...(stringValue(node.description) ? { description: stringValue(node.description) } : {}),
      ...(typeof disabled === "boolean" ? { disabled } : {}),
      ...(typeof checked === "boolean" || checked === "mixed" ? { checked } : {}),
      ...(typeof selected === "boolean" ? { selected } : {}),
    })
    if (result.length >= limit) break
  }
  return result
}
