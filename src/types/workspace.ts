export type WorkspaceBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type WorkspaceFileEntry = {
  name: string
  path: string
  kind: "file" | "directory"
  size: number
  modifiedAt: string
}

export type WorkspaceFileChange = {
  subscriptionId: string
  directory: string
  eventType: "rename" | "change"
  name?: string
}

export type WorkspaceFilePreview =
  | {
      kind: "text" | "csv" | "html"
      path: string
      mime: string
      size: number
      text: string
    }
  | {
      kind: "pdf" | "image"
      path: string
      mime: string
      size: number
      base64: string
    }
  | {
      kind: "unsupported"
      path: string
      mime: string
      size: number
    }

export type WorkspaceBrowserState = {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export type WorkspaceBrowserAxNode = {
  nodeId: number
  role: string
  name: string
  value?: string
  description?: string
  disabled?: boolean
  checked?: boolean | "mixed"
  selected?: boolean
}

export type WorkspaceBrowserSnapshot = {
  url: string
  title: string
  nodes: WorkspaceBrowserAxNode[]
}

export type WorkspaceTerminalCreated = {
  id: string
  cwd: string
  shell: string
}

export type WorkspaceTerminalExit = {
  id: string
  exitCode: number
  signal?: number
}
