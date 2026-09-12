export function browserRevealPanelWidth(viewportWidth: number, sidebarWidth: number): number {
  return Math.max(320, Math.min(460, viewportWidth - sidebarWidth - 480))
}

export function sidePanelsFit(
  viewportWidth: number,
  sidebarWidth: number,
  mainMinWidth: number,
  workspaceWidth: number,
): boolean {
  return viewportWidth >= sidebarWidth + mainMinWidth + workspaceWidth
}
